"""
JosiaMultiImageLoader — 多图加载节点 v7.6
批量加载多张图片，支持路径列表、上传、拖拽、粘贴。
支持串联：可选 images 输入端口，上游图像插入本节点图像之前合并输出。
动态输出：根据载入图像数量自动激活对应数量的独立图像端口 + images_out 汇总输出。

v7.5 改进（列表模式改用 ComfyUI 原生 list 展开，彻底删除序号递增机制）:
- ★ 列表模式不再用「序号递增」（v7.0~v7.4 的 widget 值驱动 / IS_CHANGED / set_index 消息 /
      前端 onExecuted 回声 / 归零友好报错 全部废弃）。
- ★ 利用 ComfyUI 原生机制：images_out 返回 [t1, t2, ..., tN]（list），
      OUTPUT_IS_LIST=True 让下游（如 llama.cpp 反推）自动逐张执行 N 次 ——
      这就是「像提示词列表那样按数量自动跑多次」在图像上的等价实现。
- ★ 一次排队 = 全部图像自动打完标，无需手动批次按钮、无需序号、无需下游单独循环。
- ★ 批次模式（输出合并 batch）保持原行为，llama.cpp 一次性反推全部（用分隔符合并输出）。

【上游兼容性】
  ✅ 批次上游（如另一个多图加载的批次模式）：拆分为多张，与本地合并为组合池
  ✅ 单图上游（如 LoadImage 节点）：作为1张上游加入组合池
  ✅ 列表模式上游：组合池整体作为 list 展开（逐张输出全部）

v7.1: control_after_generate 种子递增尝试（已废弃）
v7.0: 输出序号控制 + 原生开关 + 自动递增
v6.9: 输出模式开关 + 端口改名 images_out
v6.8: 真正的 N 步渐进缩放 + Emoji统一
v6.7: 标准上传 API + Emoji更换
v6.4: BOOLEAN 原生开关
v6.0: 每图独立等比缩放 + 图库自适应 optimizeGrid
"""
import os
import math
import torch
import numpy as np
import shutil
from PIL import Image, ImageFile, ImageOps, ImageSequence
import folder_paths
import comfy.utils
from server import PromptServer
from aiohttp import web

from node_properties import (
    NODE_CATEGORY, NODE_DISPLAY_NAME_MULTI_IMAGE,
    MULTI_IMAGE_INTERPOLATIONS, MULTI_IMAGE_MULTIPLE_OF_OPTIONS,
    MULTI_IMAGE_DEFAULT_PARAMS,
    MULTI_IMAGE_PARAM_DESCRIPTIONS, MULTI_IMAGE_LOADER_DESCRIPTION,
)

# ─── 插值映射 ───────────────────────────────────────────────
INTERP_MAP = {
    "lanczos": Image.Resampling.LANCZOS,
    "nearest": Image.Resampling.NEAREST,
    "bilinear": Image.Resampling.BILINEAR,
    "bicubic": Image.Resampling.BICUBIC,
    "area": Image.Resampling.BOX,
    "nearest-exact": Image.Resampling.NEAREST,
}

# ─── 辅助函数（参考原生 node_helpers.pillow） ──────────────
def safe_pil_open(path):
    """安全打开图像文件，处理截断图像（参考原生 LoadImage 的 pillow 包装器）"""
    try:
        return Image.open(path)
    except (OSError, Image.DecompressionBombError, ValueError):
        prev = ImageFile.LOAD_TRUNCATED_IMAGES
        ImageFile.LOAD_TRUNCATED_IMAGES = True
        try:
            return Image.open(path)
        finally:
            ImageFile.LOAD_TRUNCATED_IMAGES = prev


def pil2tensor(img):
    """PIL Image → ComfyUI tensor (BHWC, 0-1 range) — 与原生 LoadImage 一致"""
    img = ImageOps.exif_transpose(img)  # EXIF 方向修正（原生也做）
    img = img.convert("RGB")             # 统一转 RGB（原生也做）
    img_np = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(img_np).unsqueeze(0)  # (1, H, W, 3)


def align_size(value, multiple):
    """将尺寸对齐到指定倍数"""
    m = int(multiple)
    if m <= 1:
        return value
    return ((value + m - 1) // m) * m


def ensure_rgb(t):
    """确保 tensor 通道数为 3（处理 RGBA / 灰度上游图像）"""
    c = t.shape[-1]
    if c == 4:
        rgb = t[..., :3]
        alpha = t[..., 3:4]
        return rgb * alpha + (1.0 - alpha) * 0.0
    elif c == 1:
        return t.repeat(1, 1, 1, 3)
    elif c == 3:
        return t
    elif c > 3:
        return t[..., :3]
    else:
        return torch.cat([t, torch.zeros(*t.shape[:-1], 3 - c)], dim=-1)


def compute_target_size(ow, oh, resize_mode, megapixels,
                        edge_direction, edge_value):
    """
    v6.8: 根据缩放设置计算单张图像的目标尺寸（始终等比缩放）。
    每张图独立计算，不强制统一尺寸。参考原生 ImageScaleToTotalPixels。

    注意：resolution_steps 不再用于此处的尺寸取整，
          而是在实际缩放时分 N 步渐进执行（见 resize_tensor_multi_step）。

    resize_mode: True=按像素缩放, False=按边长缩放
    edge_direction: True=按长边缩放, False=按短边缩放
    """
    if resize_mode and megapixels > 0:
        # 按像素缩放（参考原生 ImageScaleToTotalPixels）
        total = megapixels * 1024 * 1024
        scale_by = math.sqrt(total / (ow * oh))
        tw = max(1, round(ow * scale_by))
        th = max(1, round(oh * scale_by))
    elif not resize_mode and edge_value > 0:
        # 按边长缩放
        if not edge_direction:
            # 按短边缩放：短边 = edge_value，长边等比
            if ow <= oh:
                ratio = edge_value / ow
            else:
                ratio = edge_value / oh
        else:
            # 按长边缩放：长边 = edge_value，短边等比
            if ow >= oh:
                ratio = edge_value / ow
            else:
                ratio = edge_value / oh
        tw = max(1, int(ow * ratio))
        th = max(1, int(oh * ratio))
    else:
        # 不缩放 — 原图直出
        return ow, oh

    return max(1, tw), max(1, th)


def resize_tensor_proportional(tensor, target_w, target_h, upscale_method):
    """使用原生 common_upscale 等比缩放单张图像 tensor (1,H,W,C) —— 一步到位"""
    h, w = tensor.shape[1], tensor.shape[2]
    if target_w == w and target_h == h:
        return tensor
    samples = tensor.movedim(-1, 1)  # BHWC → BCHW
    s = comfy.utils.common_upscale(samples, target_w, target_h, upscale_method, "disabled")
    return s.movedim(1, -1)  # BCHW → BHWC


def resize_tensor_multi_step(tensor, target_w, target_h, upscale_method,
                             steps=1, multiple_of=None):
    """
    v6.8: 真正的 N 步渐进缩放。

    steps=1: 一步到位（等同于 resize_tensor_proportional）
    steps>0: 分 N 步从原始尺寸逐步过渡到目标尺寸。
             每一步的中间尺寸按线性插值计算，
             最后一步精确到达目标尺寸并可选地对齐到倍数。

    多步缩放在大比例缩小（如 4000→512）时可减少锯齿和伪影。
    """
    h, w = tensor.shape[1], tensor.shape[2]
    if target_w == w and target_h == h:
        return tensor

    if steps <= 1:
        # 一步到位 + 可选对齐
        m = int(multiple_of) if multiple_of else 0
        if m > 1:
            target_w = (target_w // m) * m
            target_h = (target_h // m) * m
        return resize_tensor_proportional(tensor, max(1, target_w), max(1, target_h), upscale_method)

    result = tensor
    for step in range(steps):
        progress = (step + 1) / steps

        if step < steps - 1:
            # 中间步骤：线性插值尺寸（不取整，保持平滑过渡）
            iw = int(w + (target_w - w) * progress)
            ih = int(h + (target_h - h) * progress)
            iw, ih = max(1, iw), max(1, ih)
        else:
            # 最后一步：精确到达目标 + 可选对齐
            iw, ih = target_w, target_h
            m = int(multiple_of) if multiple_of else 0
            if m > 1:
                iw = (iw // m) * m
                ih = (ih // m) * m
            iw, ih = max(1, iw), max(1, ih)

        result = resize_tensor_proportional(result, iw, ih, upscale_method)

    return result


def assemble_batch_v6(tensors):
    """
    v6.0: 将多个不同尺寸的 tensor 组装为 batch。
    每张图已独立等比缩放，尺寸可能不同。
    batch 需要统一尺寸 → 用黑边 letterbox 到最大画布。
    注意：混合比例时 image_list 必然有黑边（数学限制），建议用单独端口 image_N。
    """
    if len(tensors) == 0:
        return torch.zeros(1, 64, 64, 3)

    shapes = [(t.shape[1], t.shape[2]) for t in tensors]
    if len(set(shapes)) == 1:
        return torch.cat(tensors, dim=0)

    max_h = max(s[0] for s in shapes)
    max_w = max(s[1] for s in shapes)

    aligned = []
    for t in tensors:
        h, w = t.shape[1], t.shape[2]
        if h == max_h and w == max_w:
            aligned.append(t)
        else:
            # letterbox: 等比缩放到画布内，再 pad 黑边居中
            ratio = min(max_w / w, max_h / h)
            nw = max(1, int(w * ratio))
            nh = max(1, int(h * ratio))
            samples = t.movedim(-1, 1)
            scaled = comfy.utils.common_upscale(samples, nw, nh, "lanczos", "disabled")
            pad_left = (max_w - nw) // 2
            pad_right = max_w - nw - pad_left
            pad_top = (max_h - nh) // 2
            pad_bottom = max_h - nh - pad_top
            if pad_left > 0 or pad_right > 0 or pad_top > 0 or pad_bottom > 0:
                scaled = torch.nn.functional.pad(scaled, (pad_left, pad_right, pad_top, pad_bottom), value=0)
            aligned.append(scaled.movedim(1, -1))

    return torch.cat(aligned, dim=0)


# ─── 节点类 ─────────────────────────────────────────────────
class JosiaMultiImageLoader:
    DESCRIPTION = MULTI_IMAGE_LOADER_DESCRIPTION
    CATEGORY = NODE_CATEGORY
    FUNCTION = "load_images"
    OUTPUT_NODE = True

    MAX_OUTPUTS = 50
    RETURN_TYPES = ("IMAGE",) + ("IMAGE",) * MAX_OUTPUTS + ("INT",)
    RETURN_NAMES = ("images_out",) + tuple(f"image_{i}" for i in range(1, MAX_OUTPUTS + 1)) + ("total_count",)
    # ★ v7.6: 第一个端口 images_out 始终为 list 类型（OUTPUT_IS_LIST=True）—
    #   列表模式返回 [t1, t2, ..., tN] 时，ComfyUI 自动展开，下游（如 llama.cpp 反推）逐张执行 N 次；
    #   批次模式返回 [batch_tensor]（list 长度1），下游收到 1 个 batch。
    #   （图片命名由每个 tensor 的 .filename 属性承载，文本保存接入 image 端口即可按图命名，无需额外文件名端口）
    OUTPUT_IS_LIST = (True,) + (False,) * MAX_OUTPUTS + (False,)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_paths": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": MULTI_IMAGE_PARAM_DESCRIPTIONS["image_paths"],
                    "display_name": "图片路径",
                }),
                "enable_resize": ("BOOLEAN", {
                    "default": MULTI_IMAGE_DEFAULT_PARAMS["enable_resize"],
                    "label_on": "✅ 开启缩放",
                    "label_off": "❎ 原图直出",
                    "display_name": "图像缩放",
                    "tooltip": MULTI_IMAGE_PARAM_DESCRIPTIONS["enable_resize"],
                }),
                "resize_mode": ("BOOLEAN", {
                    "default": MULTI_IMAGE_DEFAULT_PARAMS["resize_mode"],
                    "label_on": "🖼️ 按像素缩放",
                    "label_off": "📐 按边长缩放",
                    "display_name": "缩放模式",
                    "tooltip": MULTI_IMAGE_PARAM_DESCRIPTIONS["resize_mode"],
                }),
                "megapixels": ("FLOAT", {
                    "default": MULTI_IMAGE_DEFAULT_PARAMS["megapixels"],
                    "min": 0.0, "max": 16.0, "step": 0.01,
                    "display_name": "百万像素",
                    "tooltip": MULTI_IMAGE_PARAM_DESCRIPTIONS["megapixels"],
                }),
                "resolution_steps": ("INT", {
                    "default": MULTI_IMAGE_DEFAULT_PARAMS["resolution_steps"],
                    "min": 1, "max": 16, "step": 1,
                    "display_name": "缩放步数",
                    "tooltip": MULTI_IMAGE_PARAM_DESCRIPTIONS["resolution_steps"],
                }),
                "edge_direction": ("BOOLEAN", {
                    "default": MULTI_IMAGE_DEFAULT_PARAMS["edge_direction"],
                    "label_on": "➡️ 按长边缩放",
                    "label_off": "⬇️ 按短边缩放",
                    "display_name": "边长方向",
                    "tooltip": MULTI_IMAGE_PARAM_DESCRIPTIONS["edge_direction"],
                }),
                "edge_value": ("INT", {
                    "default": MULTI_IMAGE_DEFAULT_PARAMS["edge_value"],
                    "min": 0, "max": 16384, "step": 1,
                    "display_name": "边长值",
                    "tooltip": MULTI_IMAGE_PARAM_DESCRIPTIONS["edge_value"],
                }),
                "interpolation": (MULTI_IMAGE_INTERPOLATIONS, {
                    "default": MULTI_IMAGE_DEFAULT_PARAMS["interpolation"],
                    "display_name": "缩放算法",
                    "tooltip": MULTI_IMAGE_PARAM_DESCRIPTIONS["interpolation"],
                }),
                "multiple_of": (MULTI_IMAGE_MULTIPLE_OF_OPTIONS, {
                    "default": MULTI_IMAGE_DEFAULT_PARAMS["multiple_of"],
                    "display_name": "对齐倍数",
                    "tooltip": MULTI_IMAGE_PARAM_DESCRIPTIONS["multiple_of"],
                }),
                "output_mode": ("BOOLEAN", {
                    "default": MULTI_IMAGE_DEFAULT_PARAMS["output_mode"],
                    "label_on": "📋 图像列表",
                    "label_off": "📦 图像批次",
                    "display_name": "多图输出模式",
                    "tooltip": MULTI_IMAGE_PARAM_DESCRIPTIONS["output_mode"],
                }),
            },
            "optional": {
                "images": ("IMAGE", {
                    "tooltip": "上游图像列表，将插入本节点图像之前合并输出",
                    "display_name": "image_in",
                }),
            },
        }

    def load_images(self, image_paths, resize_mode, megapixels, resolution_steps,
                    edge_direction, edge_value, interpolation,
                    multiple_of, output_mode, enable_resize=True,
                    images=None):
        """
        v7.5: 每张图独立等比缩放，无黑边无拉伸。
        output_mode: True=图像列表(整列展开), False=图像批次(合并)
        ★ 列表模式不再使用「序号递增」机制（v7.2~v7.4 的 widget/IS_CHANGED/set_index/前端回声/归零报错
          全部废弃）。改为利用 ComfyUI 原生 list 展开：images_out 返回 [t1,t2,...,tN]，
          OUTPUT_IS_LIST=True 让下游（如 llama.cpp 反推）自动逐张执行 N 次，无需手动批次按钮、无需序号。
        total_count: 组合池大小（上游+本地），用于前端显示。
        第一个端口 images_out 始终返回 list（OUTPUT_IS_LIST=True）：
          - 批次模式: [batch_tensor] → 下游收到 1 个 batch（llama.cpp 一次性反推全部，用分隔符输出）
          - 列表模式: [t1, t2, ..., tN] → 下游自动展开，逐张执行 N 次（每张干净字幕，无分隔符）

        【上游兼容性】
          ✅ 批次上游：拆分为多张，与本地合并为组合池
          ✅ 单图上游（LoadImage）：作为1张上游加入池首
          ✅ 列表模式上游：组合池整体作为 list 展开（逐张输出全部）
        """
        paths = self._resolve_paths(image_paths.strip())
        multi_of = int(multiple_of)

        # 加载并处理本地图像（每张独立等比缩放）
        local_tensors = []
        local_paths = []  # ★ v7.4: 同步记录实际成功加载的路径（与 local_tensors 一一对应）
        for path in paths:
            try:
                t = self._load_single_image(path, resize_mode, megapixels, resolution_steps,
                                             edge_direction, edge_value, interpolation, multi_of,
                                             enable_resize=enable_resize)
                if t is not None:
                    local_tensors.append(t)
                    local_paths.append(path)
            except Exception as e:
                print(f"[Josia多图加载] 无法加载 {path}: {e}")

        # 合并上游图像（同样按设置独立等比缩放）
        all_tensors = []
        if images is not None:
            for i in range(images.shape[0]):
                t = ensure_rgb(images[i:i+1])
                t = self._resize_existing_tensor(t, resize_mode, megapixels, resolution_steps,
                                                  edge_direction, edge_value, interpolation, multi_of,
                                                  enable_resize=enable_resize)
                all_tensors.append(t)
        all_tensors.extend(local_tensors)
        current_upstream = 0 if images is None else images.shape[0]

        # ★ v7.4: 携带文件名 —— 给每个输出 tensor 打 filename 属性（取实际加载路径 basename，
        #   顺序精确，已过滤不存在/加载失败的文件）。本地图像 j>=current_upstream 对应 local_paths[local_i]；
        #   上游图像保留其自带 filename（若上游加载器已设置）。
        for j, t in enumerate(all_tensors):
            if j < current_upstream:
                continue  # 上游图像：保留原有 filename（如有）
            local_i = j - current_upstream
            if 0 <= local_i < len(local_paths):
                try:
                    t.filename = os.path.splitext(os.path.basename(local_paths[local_i]))[0]
                except Exception:
                    pass

        total = len(all_tensors)
        empty = torch.zeros(1, 64, 64, 3)

        if total == 0:
            # 无图像：友好报错中断（替代返回空列表，避免下游对空列表 IndexError）
            raise Exception(
                "[Josia多图加载] 未载入任何图像，也没有上游图像输入。\n"
                "请先在图库中添加图像，或连接上游图像输出后再运行。"
            )

        # ═══ 输出 ────────────────────────────────────────
        if not output_mode:
            # ═══ 批次模式（与 v6.9 一致）════
            if enable_resize:
                # 开启缩放：letterbox 对齐到统一画布（原行为）
                batch = assemble_batch_v6(all_tensors)
            else:
                # 关闭缩放（原图直出）：尽量不做任何处理
                #   - 尺寸一致 → 直接拼接（零处理，输出即原图）
                #   - 尺寸不一致 → 批次必须统一尺寸，退化为黑边对齐并提示
                #     （若需完全原图，请改用「图像列表」模式逐张输出）
                shapes = [(t.shape[1], t.shape[2]) for t in all_tensors]
                if len(set(shapes)) == 1:
                    batch = torch.cat(all_tensors, dim=0)
                else:
                    print(
                        "[Josia多图加载] ⚠️ 图像缩放已关闭，但各图尺寸不一致，"
                        "批次模式无法免处理，已用黑边对齐。如需完全原图请使用「图像列表」模式逐张输出。"
                    )
                    batch = assemble_batch_v6(all_tensors)
            first_output = [batch]
            # 批次模式：把首张图文件名挂到 batch 上（供文本保存「图像」端口复用原图名）
            if all_tensors and getattr(all_tensors[0], "filename", None):
                try:
                    batch.filename = all_tensors[0].filename
                except Exception:
                    pass
        else:
            # ═══ 列表模式 v7.5：整列展开（利用 ComfyUI 原生 list 展开）═══
            # images_out 直接返回全部 N 张（list），OUTPUT_IS_LIST=True 让下游自动逐张执行 N 次。
            # 无需序号递增、无需手动批次按钮、无需 IS_CHANGED/消息/前端回声。
            first_output = all_tensors

        # ── 单独输出 image_N ──
        result = [first_output]
        for i in range(JosiaMultiImageLoader.MAX_OUTPUTS):
            if i < total:
                result.append(all_tensors[i])
            else:
                result.append(empty)

        # ★ v7.2: total_count INT 输出
        result.append(total)

        # v7.5: 标准返回（无 ui 回传、无序号状态）。逐张展开由 OUTPUT_IS_LIST 驱动，
        # 一次排队 = 全部图像自动打完标，彻底摆脱手动批次按钮与序号递增机制。
        return tuple(result)

    def _resize_existing_tensor(self, tensor, resize_mode, megapixels, resolution_steps,
                                 edge_direction, edge_value, interpolation, multiple_of,
                                 enable_resize=True):
        """对已存在的 tensor（上游图像）进行独立等比缩放（支持 N 步渐进）"""
        if not enable_resize:
            # 图像缩放关闭：原样透传，不做任何缩放处理
            return tensor
        h, w = tensor.shape[1], tensor.shape[2]
        tw, th = compute_target_size(w, h, resize_mode, megapixels,
                                      edge_direction, edge_value)
        if tw == w and th == h:
            return tensor
        steps = max(1, int(resolution_steps))
        return resize_tensor_multi_step(tensor, tw, th, interpolation, steps, multiple_of)

    def _resolve_paths(self, image_paths):
        """
        解析路径：支持绝对路径和相对 input 目录的路径。
        v5.0: 增强版 — 如果原路径不存在，自动在 input/ 目录按文件名查找。
        """
        input_dir = folder_paths.get_input_directory()
        output_dir = folder_paths.get_output_directory()
        paths = []
        for line in image_paths.split("\n"):
            line = line.strip()
            if not line:
                continue

            # 策略 1: 直接使用绝对路径
            if os.path.isabs(line):
                if os.path.isfile(line):
                    paths.append(line)
                else:
                    # 绝对路径文件不存在 → 尝试在 input/ 按文件名找
                    basename = os.path.basename(line)
                    alt = os.path.join(input_dir, basename)
                    if os.path.isfile(alt):
                        paths.append(alt)
                    else:
                        print(f"[Josia多图加载] 跳过不存在的文件: {line}")
                continue

            # 策略 2: 相对路径 → 补全 input 目录
            full = os.path.join(input_dir, line)
            if os.path.isfile(full):
                paths.append(full)
            elif os.path.basename(line) == line:  # 纯文件名
                # 策略 3: 在 input/ 按纯文件名查找
                alt_input = os.path.join(input_dir, line)
                if os.path.isfile(alt_input):
                    paths.append(alt_input)
                else:
                    print(f"[Josia多图加载] 跳过在 input 中找不到的文件: {line}")
            else:
                print(f"[Josia多图加载] 跳过无效路径: {line}")

        return paths

    def _load_single_image(self, path, resize_mode, megapixels, resolution_steps,
                            edge_direction, edge_value, interpolation, multiple_of,
                            enable_resize=True):
        """
        v7.3: 加载单张图像。
          - enable_resize=True  ：按设置独立等比缩放（原功能，支持 N 步渐进）
          - enable_resize=False ：完全跳过缩放，图像以原始分辨率、
            原始像素（与原生 LoadImage 一致：EXIF 方向修正 + 转 RGB）直接返回
        返回独立尺寸的 tensor (1, H, W, 3)，或 None 表示跳过。
        """
        if not os.path.isfile(path):
            return None

        # 使用安全打开（参考原生 node_helpers.pillow）
        img = safe_pil_open(path)
        if img is None:
            return None

        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")

        ow, oh = img.size
        if ow <= 0 or oh <= 0:
            return None

        # 图像缩放关闭：原图直出（与原生 LoadImage 输出一致，不做任何缩放）
        if not enable_resize:
            return pil2tensor(img)

        # v6.8: 每张图独立计算目标尺寸（始终等比）
        tw, th = compute_target_size(ow, oh, resize_mode, megapixels,
                                      edge_direction, edge_value)

        # 等比缩放（如果尺寸变化）—— 支持 N 步渐进
        if tw != ow or th != oh:
            steps = max(1, int(resolution_steps))
            if steps <= 1:
                # 单步：PIL 直接缩放（更快）
                m = int(multiple_of) if multiple_of else 0
                if m > 1:
                    tw = (tw // m) * m
                    th = (th // m) * m
                interp = INTERP_MAP.get(interpolation, Image.Resampling.LANCZOS)
                img = img.resize((max(1, tw), max(1, th)), interp)
            else:
                # 多步：转 tensor 后分步缩放（质量更好）
                t = pil2tensor(img)
                t = resize_tensor_multi_step(t, tw, th, interpolation, steps, multiple_of)
                # tensor → PIL → tensor 用于统一返回
                arr = (t[0].numpy() * 255).astype(np.uint8)
                img = Image.fromarray(arr, "RGB")

        # 转为 tensor
        return pil2tensor(img)


# ─── API 路由：获取图片信息 ─────────────────────────────────
@PromptServer.instance.routes.post("/josia_multi_image/info")
async def get_image_info(request):
    """返回图片的原始宽高和可访问性（v4.9 使用多策略路径解析）"""
    try:
        data = await request.json()
        raw_path = data.get("path", "")

        resolved, err = _resolve_thumbnail_path(raw_path)
        if resolved is None:
            return web.json_response({"width": 0, "height": 0, "error": err})

        with safe_pil_open(resolved) as img:
            w, h = img.size
        return web.json_response({"width": w, "height": h, "path": resolved})
    except Exception as e:
        return web.json_response({"width": 0, "height": 0, "error": str(e)})


# ─── API 路由：获取 input 目录路径 ──────────────────────────────
@PromptServer.instance.routes.get("/josia_multi_image/input_dir")
async def get_input_dir(request):
    """返回 ComfyUI input 目录的绝对路径（前端用来构建相对路径）"""
    try:
        input_dir = folder_paths.get_input_directory()
        return web.json_response({"input_dir": input_dir})
    except Exception as e:
        return web.json_response({"input_dir": "", "error": str(e)})


# ─── 缩略图"文件不存在"占位图（只创建一次）─────────────────────
_THUMBNAIL_NOT_FOUND_IMAGE = None

def _get_not_found_thumbnail():
    """返回一个 100×100 的「文件不存在」占位图"""
    global _THUMBNAIL_NOT_FOUND_IMAGE
    if _THUMBNAIL_NOT_FOUND_IMAGE is None:
        from io import BytesIO
        img = Image.new("RGB", (100, 100), (40, 40, 44))
        buf = BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        _THUMBNAIL_NOT_FOUND_IMAGE = buf.read()
    return _THUMBNAIL_NOT_FOUND_IMAGE


def _resolve_thumbnail_path(raw_path):
    """
    多策略路径解析（用于缩略图API）。
    按优先级尝试：
      1. 原始路径（绝对/相对直接检查）
      2. 相对于 input 目录
      3. 在 input 目录按纯文件名查找
      4. 在 output 目录按纯文件名查找
    返回 (resolved_path, error_msg) — 成功时 error_msg=None
    """
    if not raw_path:
        return None, "empty path"

    candidates = [raw_path]
    basename = os.path.basename(raw_path)

    # 策略 2: 相对路径 → 补全 input 目录
    input_dir = folder_paths.get_input_directory()
    if not os.path.isabs(raw_path):
        candidates.append(os.path.join(input_dir, raw_path))

    # 策略 3: 按 basename 在 input 目录查找
    if basename != raw_path:
        candidates.append(os.path.join(input_dir, basename))

    # 策略 4: 按 basename 在 output 目录查找
    output_dir = folder_paths.get_output_directory()
    if output_dir != input_dir:
        candidates.append(os.path.join(output_dir, basename))

    for p in candidates:
        if os.path.isfile(p):
            return p, None

    return None, f"file not found: tried {candidates[:3]}"


# ─── API 路由：缩略图（v4.9 增强：多策略路径 + 占位图）───────────
@PromptServer.instance.routes.get("/josia_multi_image/thumbnail")
async def get_thumbnail(request):
    """
    返回标准PNG缩略图（100x100）。
    v4.9: 多策略路径解析 + 文件不存在时返回占位图而非报错。
    """
    try:
        raw_path = request.rel_url.query.get("path", "")
        if not raw_path:
            return web.Response(
                body=_get_not_found_thumbnail(),
                content_type="image/png",
                status=200,  # 200 让 <img> 能正常显示
            )

        resolved, err = _resolve_thumbnail_path(raw_path)
        if resolved is None:
            print(f"[Josia多图加载] 缩略图: {err}")
            return web.Response(
                body=_get_not_found_thumbnail(),
                content_type="image/png",
                status=200,
                headers={"Cache-Control": "no-store"},
            )

        # 安全打开 + EXIF修正 + 转RGB
        img = safe_pil_open(resolved)
        if img is None:
            return web.Response(
                body=_get_not_found_thumbnail(),
                content_type="image/png",
                status=200,
            )
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")

        # 生成缩略图（100x100，保持比例，居中）
        img.thumbnail((100, 100), Image.Resampling.LANCZOS)
        thumb = Image.new("RGB", (100, 100), (28, 28, 30))
        thumb.paste(img, ((100 - img.width) // 2, (100 - img.height) // 2))

        from io import BytesIO
        buf = BytesIO()
        thumb.save(buf, format="PNG")
        buf.seek(0)

        return web.Response(
            body=buf.read(),
            content_type="image/png",
            headers={"Cache-Control": "public, max-age=3600"},
        )
    except Exception as e:
        print(f"[Josia多图加载] 缩略图异常: {e}")
        return web.Response(
            body=_get_not_found_thumbnail(),
            content_type="image/png",
            status=200,
        )


# ─── API 路由：自动拷贝外部图像到 input 目录 ───────────────────
@PromptServer.instance.routes.post("/josia_multi_image/upload")
async def upload_to_input(request):
    """
    将外部图像文件自动拷贝到 ComfyUI input 目录（参考原生 LoadImage 的行为）。

    请求体: { "paths": ["/absolute/path/to/image1.png", ...] }
    返回:   {
        "results": [
            {"original": "...", "input_path": "...", "status": "ok"|..."copied"|"error", "message": "..."},
            ...
        ]
    }

    规则：
      - 文件已在 input/ 中 → 直接返回原路径 (status=ok)
      - 文件在其他位置 → 拷贝到 input/，同名冲突则加序号 (status=copied)
      - 文件不存在 → 返回错误 (status=error)
    """
    try:
        data = await request.json()
        raw_paths = data.get("paths", [])
        if not isinstance(raw_paths, list):
            raw_paths = [raw_paths]

        input_dir = folder_paths.get_input_directory()
        results = []

        for raw_path in raw_paths:
            if not raw_path:
                results.append({"original": "", "input_path": "", "status": "error", "message": "empty path"})
                continue

            # 1. 检查是否已在 input 目录中
            abs_path = os.path.abspath(raw_path) if not os.path.isabs(raw_path) else raw_path

            # 标准化路径（消除 .. 和多余分隔符）
            try:
                abs_path = os.path.normpath(abs_path)
                input_dir_norm = os.path.normpath(input_dir)
            except Exception:
                results.append({"original": raw_path, "input_path": "", "status": "error", "message": "invalid path"})
                continue

            # 判断是否已经在 input 目录下
            if abs_path.lower().startswith(input_dir_norm.lower()):
                # 已在 input 中
                if os.path.isfile(abs_path):
                    results.append({
                        "original": raw_path,
                        "input_path": abs_path,
                        "status": "ok",
                        "message": "already in input",
                    })
                else:
                    results.append({"original": raw_path, "input_path": "", "status": "error",
                                   "message": f"file not found in input: {os.path.basename(abs_path)}"})
                continue

            # 2. 文件不在 input 中，需要拷贝
            if not os.path.isfile(abs_path):
                # 尝试按文件名在 input 中查找（可能之前已拷贝过）
                basename = os.path.basename(abs_path)
                candidate = os.path.join(input_dir, basename)
                if os.path.isfile(candidate):
                    results.append({
                        "original": raw_path,
                        "input_path": candidate,
                        "status": "ok",
                        "message": "found in input by name",
                    })
                else:
                    results.append({"original": raw_path, "input_path": "", "status": "error",
                                   "message": f"source file not found: {raw_path}"})
                continue

            # 3. 执行拷贝 → input 目录
            basename = os.path.basename(abs_path)
            dest_path = os.path.join(input_dir, basename)

            # 处理同名文件：添加 _copy N 后缀
            if os.path.isfile(dest_path):
                name, ext = os.path.splitext(basename)
                counter = 1
                while os.path.isfile(os.path.join(input_dir, f"{name}_copy{counter}{ext}")):
                    counter += 1
                dest_path = os.path.join(input_dir, f"{name}_copy{counter}{ext}")

            try:
                shutil.copy2(abs_path, dest_path)
                results.append({
                    "original": raw_path,
                    "input_path": dest_path,
                    "status": "copied",
                    "message": f"copied to input as {os.path.basename(dest_path)}",
                })
            except PermissionError:
                results.append({"original": raw_path, "input_path": "", "status": "error",
                               "message": "permission denied when copying"})
            except Exception as copy_err:
                results.append({"original": raw_path, "input_path": "", "status": "error",
                               "message": f"copy failed: {str(copy_err)}"})

        return web.json_response({"results": results})
    except Exception as e:
        return web.json_response({"results": [], "error": str(e)}, status=500)


# ─── API 路由：批量上传（前端拖拽/粘贴/选择文件时使用）─────────────
@PromptServer.instance.routes.post("/josia_multi_image/upload_files")
async def upload_files_to_input(request):
    """
    批量上传：接收 multipart 表单中的多个文件，保存到 input 目录。
    前端通过 FormData 上传原始文件数据时使用。

    返回: { "paths": ["/path/to/input/file1.png", ...] }
    """
    try:
        reader = await request.multipart()
        input_dir = folder_paths.get_input_directory()
        saved_paths = []

        async for part in reader:
            if part.name != "files":
                continue

            # 读取文件数据
            data = await part.read()
            original_filename = part.filename or "unnamed.png"

            # 确保文件名安全（防止路径遍历攻击）
            safe_name = os.path.basename(original_filename)
            if not safe_name:
                safe_name = "uploaded_image.png"

            dest_path = os.path.join(input_dir, safe_name)

            # 处理同名冲突
            if os.path.isfile(dest_path):
                name, ext = os.path.splitext(safe_name)
                counter = 1
                while os.path.isfile(os.path.join(input_dir, f"{name}_{counter}{ext}")):
                    counter += 1
                dest_path = os.path.join(input_dir, f"{name}_{counter}{ext}")

            with open(dest_path, "wb") as f:
                f.write(data)

            saved_paths.append(dest_path)

        return web.json_response({"paths": saved_paths})
    except Exception as e:
        return web.json_response({"paths": [], "error": str(e)}, status=500)


# ─── 节点注册 ───────────────────────────────────────────────
NODE_CLASS_MAPPINGS = {"JosiaMultiImageLoader": JosiaMultiImageLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"JosiaMultiImageLoader": NODE_DISPLAY_NAME_MULTI_IMAGE}
