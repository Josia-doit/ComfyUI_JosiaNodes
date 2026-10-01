"""
Josia 图像编码节点
========================================================================
定位：替代原生「加载图像」节点 —— 一颗节点顶掉「加载图像 + 调整图像大小 + VAE编码」。

核心特性：
1. 图像来源（二选一，端口优先）
   · 「选择图像」下拉：原生上传按钮 + 原生图片预览（image_upload 机制，与加载图像一致），
     文件落在 input 目录，后端按文件名加载（复用原生 LoadImage.load_image：含 alpha 转遮罩）。
   · 「图像」输入端口：接上游图像，直接透传（端口接线时上传下拉自动灰化）。
   · 遮罩：优先用「遮罩」端口；没接端口且上传图带 alpha 通道时，用原生逻辑转出遮罩。

2. 端口与条件编码
   · 输入端口：图像 / 遮罩 / VAE；输出端口：图像 / 遮罩 / Latent
   · 接入的图像可以「透传」也可以「编码成 Latent」：
       仅当 Latent 输出端口真的被连到下游时才调用 VAE 编码；
       只连了图像端口 ⇒ 完全不碰 VAE（省显存、省时间）。
       判定依据：后端通过 hidden 输入拿到 UNIQUE_ID + 整张图（PROMPT），
       扫描所有节点的 inputs 看有没有指向本节点 Latent 输出槽的连线。

3. 图像缩放（参考原生「调整图像/掩码大小」，但不完全复刻）
   · 缩放类型下拉（面板最上方）：关 / 按系数缩放 / 按长边缩放 / 按短边缩放 / 按像素缩放
   · 缩放类型下方是**唯一一条会变形的参数行**（同一位置切换，参考「调整图像/掩码大小」）：
       关           → 不显示缩放参数，对齐倍数一并灰化
       按系数缩放   → 缩放系数（默认 1.0；系数为 1 时不缩放，只按对齐倍数贴合）
       按长边缩放   → 长边尺寸（INT，让 max(w,h) 落到该值）
       按短边缩放   → 短边尺寸（INT，让 min(w,h) 落到该值）
       按像素缩放   → 百万像素（FLOAT，总像素 = 该值×1e6，比例不变）
   · 缩放方法在内部锁定为速度最快的 BOX（图像）/ NEAREST（遮罩），不暴露给用户。
   · 对齐倍数：2 / 4 / 8 / 16 / 32 / 64，默认 16（= 既能整除 VAE 步长又最通用）。
       对齐语义沿用 Josia图像缩放：只裁切 / 只缩小，绝不放大。

4. VAE 选项（联动逻辑口径与 Josia媒体保存 完全一致）
   · 默认「请选择VAE模型」占位符。
   · 工作流里出现「Josia模型加载」节点时，前端才把「使用Josia模型加载VAE」加进下拉
     并自动切到它，直接复用已载入的 VAE（无需连线）；该节点被删除 ⇒ 下拉里移掉这一项，
     并把已选中它的实例**回落到「请选择VAE模型」** —— 即「不常驻」。
   · 也支持手动从 models/vae 里挑一个。
   · 优先级：VAE 端口接线 > 共享注册表（Josia模型加载）> 手动文件名。
   · 🔴 后端候选必须常驻该项（validate_inputs 校验），见 _vae_choices 注释。

文件名：image_encode.py
节点英文标识：JosiaImageEncode
节点中文显示名：Josia图像编码
依赖：torch、numpy、PIL.Image、math、gc、os、hashlib、folder_paths、model_registry、原生 LoadImage
"""
import torch
import numpy as np
from PIL import Image
import math
import gc
import os
import hashlib
import folder_paths

from node_properties import NODE_CATEGORY

# 🔴 跨节点共享 VAE 注册表（Josia模型加载 节点 publish 后才有值）
try:
    import model_registry as _model_registry
except Exception:
    _model_registry = None

# 原生加载图像：上传文件直接走它的 load_image（alpha 转遮罩、动图支持全套现成）
try:
    from nodes import LoadImage as _NativeLoadImage
except Exception:
    _NativeLoadImage = None

# ===================== 常量 =====================
VAE_PLACEHOLDER = "请选择VAE模型"           # VAE 下拉默认占位符（无 Josia模型加载 节点时回落到它）
USE_JOSIA_VAE = "使用Josia模型加载VAE"       # 检测到 Josia 模型加载节点时自动选中项
SCALE_TYPES = ["关", "按系数缩放", "按长边缩放", "按短边缩放", "按像素缩放"]
ALIGN_MULTIPLES = ["2", "4", "8", "16", "32", "64"]

# ===================== 「通道切换」开关 =====================
# 本节点恒定「外加一路单通道遮罩」输出，所以通道数按「图像三/四通道 + 遮罩一路」理解（即 3+1）。
CHANNEL_MODES = ["自动", "RGB", "RGBA"]
CHANNEL_MODE_DEFAULT = "自动"
# 预览只认 RGB 通道，PNG 里"透明区的 RGB 恰好是 0"会被直接渲染成黑块（最典型的"透明背景变黑"）。
# 这里把 alpha 低到基本全透明的像素，RGB 刷成该亮度值，让预览呈现为白底而不是黑底。
# 半透明像素不动照旧，避免污染真实颜色。
TRANSPARENT_ALPHA_MAX = 4        # alpha < 4/255 即视为「完全透明」
TRANSPARENT_FILL_VALUE = 255     # 该像素的 RGB 填成白色
CHANNEL_TOOLTIP = (
    "决定「图像」端口输出几通道（本节点恒定另出一路「遮罩」单通道，也就是 3+1 里的那 +1）：\n"
    "• 自动 ＝ 上游给几通道就透传几通道：三通道进 ⇒ 三通道出，四通道进 ⇒ 四通道出。最省心。\n"
    "• RGB ＝ 强制三通道（RGB）。第四通道（透明度）不跟图像走，改成从「遮罩」端口出来，"
    "遮罩越亮＝越透明（与原生加载图像一致的口径）。\n"
    "• RGBA ＝ 强制四通道（RGB + A）：第四通道按下面顺序取透明度 —— ①「遮罩」端口接线了就用它合并"
    "（alpha ＝ 1 − 遮罩，遮罩亮＝透明，等于把原生「合并图像Alpha」内置进来）；"
    "② 没接线就用上传图自带的透明度；③ 都没有或上游是三通道就补成全不透明。"
    "「遮罩」输出端口照旧会给出一路（遮罩亮＝越透明）。\n"
    "说明：上游是灰度等其它通道数时一律按三通道处理；三种模式下喂给 VAE 编码的都只有前三通道。\n"
    "透明度说明：完全透明的像素在预览里一律按白色呈现（预览只画 RGB，PNG 里透明区的 RGB 常是 0，"
    "直接透出去会被渲染成黑块）；半透明像素的颜色照旧，真正的透明信息在第四通道或「遮罩」端口。"
)
# Latent 在 RETURN_TYPES 中的下标（图像=0 / 遮罩=1 / Latent=2）；用于判定该输出是否连接
LATENT_OUTPUT_SLOT = 2
MASK_OUTPUT_SLOT = 1


# ===================== 下拉候选 =====================
def _input_image_choices():
    """「选择图像」下拉候选：空项 + input 目录下的全部图像文件（口径与原生加载图像一致）。"""
    try:
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir)
                 if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["image"])
        return [""] + sorted(files, key=str.lower)
    except Exception:
        return [""]


def _vae_choices():
    """VAE 下拉候选：占位符 + Josia 共享项 + models/vae 下的全部模型。

    🔴「使用Josia模型加载VAE」必须**常驻在后端候选里**（哪怕当下没加载节点）：
       ComfyUI `execution.validate_inputs` 会把提交上来的 combo 值和本列表比对，
       不在列表里 ⇒ `value_not_in_list`，节点直接跑不起来（execution.py 的 combos 分支）。
       「不要常驻」是**前端展示层**的事——见 web/js/image_encode.js 的动态增删。
       这里砍掉它 ⇒ 用户一旦选到共享 VAE 就再也提交不了，属于必踩的血坑。
    """
    names = list(folder_paths.get_filename_list("vae") or [])
    return [VAE_PLACEHOLDER, USE_JOSIA_VAE] + sorted(names, key=str.lower)


# ===================== VAE 候选 / 解析 =====================
def _load_vae_by_name(name):
    """按文件名加载 VAE（口径与模型加载节点一致：先 models/vae，再 models/checkpoints）。"""
    if not name or name in (USE_JOSIA_VAE, VAE_PLACEHOLDER):
        return None
    for folder in ("vae", "checkpoints"):
        try:
            path = folder_paths.get_full_path(folder, name)
        except Exception:
            path = None
        if not path:
            continue
        try:
            import comfy.utils
            from comfy.sd import VAE
            sd = comfy.utils.load_torch_file(path, safe_load=True)
            vae = VAE(sd=sd)
            vae.throw_exception_if_invalid()
            return vae
        except Exception as e:
            print(f"[Josia图像编码] ⚠️ 加载 VAE 失败（{name}）：{e}")
            return None
    print(f"[Josia图像编码] ⚠️ 找不到 VAE 模型文件：{name}")
    return None


def _resolve_vae(wired, choice):
    """决定用哪个 VAE。优先级：端口接线 > Josia 共享注册表 > models/vae 手动加载。"""
    if wired is not None:
        return wired
    if choice == USE_JOSIA_VAE:
        v = _model_registry.get_vae("vae1") if _model_registry is not None else None
        if v is None:
            print("[Josia图像编码] ⚠️ 选了「使用Josia模型加载VAE」，但「Josia模型加载」"
                  "节点尚未载入 VAE —— 请先运行一次模型加载节点，或改用手动模型 / VAE 端口连线。")
        return v
    if choice in (VAE_PLACEHOLDER,):
        return None
    return _load_vae_by_name(choice)


# ===================== 选择图像加载 =====================
def _read_alpha_channel(path):
    """按文件读回真实的透明度通道（H×W，0~1），读不到就返回 None。

    原生 LoadImage.load_image 只给「三通道图像 + 遮罩」，透明度信息只以遮罩形式出现，
    拿不到逐像素的 alpha 本体；这里单独读一次 RGBA 把 alpha 取回来，
    供「通道切换」决定第四通道与预览底色时使用。
    """
    try:
        with Image.open(path) as im:
            rgba = np.array(im.convert("RGBA"))
        return rgba[..., 3].astype(np.float32) / 255.0
    except Exception:
        return None


def _load_selected_image(name):
    """按「选择图像」下拉里的文件名加载 (IMAGE, MASK, ALPHA)。

    优先复用原生 LoadImage.load_image（alpha 自动转遮罩、动图支持）；
    拿不到原生类时用 PIL 兜底（RGB + alpha 通道转遮罩，语义与原生一致）。
    第三项 ALPHA 是本次加载文件自带的透明度（H×W，0~1），不带透明度时为 None。
    """
    if not name:
        return None, None, None
    path = folder_paths.get_annotated_filepath(name)
    if not path or not os.path.isfile(path):
        raise ValueError(f"[Josia图像编码] 选择图像文件不存在：{name}（请重新上传或换一个文件）")

    up_alpha = _read_alpha_channel(path)

    if _NativeLoadImage is not None:
        img, msk = _NativeLoadImage().load_image(name)
        return img, msk, up_alpha

    # PIL 兜底：与原生 load_image 同语义
    img = Image.open(path)
    img = img.transpose(Image.Transpose.EXIF_TRANSPOSE) if getattr(img, "getexif", lambda: None)() else img
    rgb = np.array(img.convert("RGB")).astype(np.float32) / 255.0
    out_img = torch.from_numpy(rgb)[None,]
    if "A" in img.getbands():
        alpha = np.array(img.getchannel("A")).astype(np.float32) / 255.0
        out_mask = (1.0 - torch.from_numpy(alpha))[None,]
    else:
        out_mask = torch.zeros((1, 64, 64), dtype=torch.float32)
    return out_img, out_mask, up_alpha


class JosiaImageEncode:
    CATEGORY = NODE_CATEGORY
    DESCRIPTION = """🖼️ Josia 图像编码
一颗节点顶掉「加载图像 + 调整图像大小 + VAE编码」。

• 选择图像（原生按钮 + 预览）或接上游图像端口，端口接线时选择自动灰化
• 输入：图像 / 遮罩 / VAE；输出：图像 / 遮罩 / Latent
• 通道切换「自动 / RGB / RGBA」：自动＝上游几通道就透传几通道；RGB＝强制三通道、透明度改从遮罩端口走；RGBA＝强制四通道带 alpha
• 条件编码：仅当 Latent 输出端口被连到下游时才调用 VAE 编码；只连图像端口 ⇒ 不编码、不碰 VAE
• 缩放类型（最上方）：关 / 按系数 / 按长边 / 按短边 / 按像素 —— 下方唯一缩放参数随类型变形（缩放系数 / 长边尺寸 / 短边尺寸 / 百万像素），方法锁定最快，附对齐倍数 2~64
• VAE：默认「请选择VAE模型」；图内有「Josia模型加载」节点时才出现「使用Josia模型加载VAE」并自动选中（节点删除则回落），也支持手动挑选

「遮罩」优先走端口；上传图带 alpha 通道时自动转出遮罩。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # —— 缩放类型（面板最上方）：决定下方唯一缩放参数行 / 对齐倍数是否可用 ——
                "缩放类型": (SCALE_TYPES, {
                    "default": "按系数缩放",
                    "tooltip": "决定图像怎么缩放，下方唯一缩放参数会随它**变形**（参考「调整图像/掩码大小」）：\n"
                               "• 关 ＝ 完全不缩放、不对齐，下方缩放参数隐藏、对齐倍数灰化\n"
                               "• 按系数缩放 ＝ 下方出现「缩放系数」（默认 1.0：不缩放，只按对齐倍数贴合）\n"
                               "• 按长边缩放 ＝ 下方出现「长边尺寸」：让最长边落到该像素，另一边等比跟随\n"
                               "• 按短边缩放 ＝ 下方出现「短边尺寸」：让最短边落到该像素，另一边等比跟随\n"
                               "• 按像素缩放 ＝ 下方出现「百万像素」：按总像素（百万）缩放，比例不变\n"
                               "缩放方法内部锁定为速度最快的 BOX（图像）/ NEAREST（遮罩），无需手动设置。",
                }),

                # —— 随「缩放类型」变形的唯一参数行（同一位置切换，互不共存）——
                "缩放系数": ("FLOAT", {
                    "default": 1.0, "min": 0.01, "max": 16.0, "step": 0.01,
                    "tooltip": "按系数缩放时的倍率：默认 1.0 ＝ 不缩放、只按对齐倍数贴合；"
                               "0.5＝缩一半，2.0＝放大一倍。（仅「缩放类型=按系数缩放」时显示）",
                }),
                "长边尺寸": ("INT", {
                    "default": 1024, "min": 32, "max": 8192, "step": 1,
                    "tooltip": "按长边缩放时的目标最长边像素值；另一边等比跟随。"
                               "（仅「缩放类型=按长边缩放」时显示）",
                }),
                "短边尺寸": ("INT", {
                    "default": 768, "min": 32, "max": 8192, "step": 1,
                    "tooltip": "按短边缩放时的目标最短边像素值；另一边等比跟随。"
                               "（仅「缩放类型=按短边缩放」时显示）",
                }),
                "百万像素": ("FLOAT", {
                    "default": 1.0, "min": 0.01, "max": 64.0, "step": 0.01,
                    "tooltip": "按像素缩放时的目标总像素（百万）：1.0 ≈ 100 万像素（约 1024×1024），比例不变。"
                               "（仅「缩放类型=按像素缩放」时显示）",
                }),

                # —— 对齐倍数（缩放参数行之下）——
                "对齐倍数": (ALIGN_MULTIPLES, {
                    "default": "16",
                    "tooltip": "把输出宽高对齐到该数字的整数倍（16 适配绝大多数 VAE 潜空间）。\n"
                               "对齐只裁切 / 只缩小，绝不放大。\n"
                               "「缩放类型 = 关」时本项灰化不起作用。",
                }),

                # —— 通道切换（图像级参数，置于对齐倍数之后）——
                "通道切换": (CHANNEL_MODES, {
                    "default": CHANNEL_MODE_DEFAULT,
                    "tooltip": CHANNEL_TOOLTIP,
                }),

                # —— VAE 模型（置于「选择图像」之前，让选择图像置底紧邻上传按钮）——
                "VAE模型": (_vae_choices(), {
                    "default": VAE_PLACEHOLDER,
                    "tooltip": "编码 Latent 用的 VAE。\n"
                               "• 「请选择VAE模型」＝ 不使用（不编码 Latent，除非给 VAE 端口连线）\n"
                               "• 「使用Josia模型加载VAE」＝ 直接复用「Josia模型加载」节点已载入的 VAE（检测到该节点时自动选中）\n"
                               "• 也可手动从 models/vae 里选一个\n"
                               "• 一旦给「VAE」端口接了线，本项自动灰化 —— 接线优先。",
                }),

                # —— 选择图像（置底）：原生上传按钮 + 原生预览（image_upload 机制，按钮紧随其下）——
                "选择图像": (_input_image_choices(), {
                    "default": "",
                    "image_upload": True,  # 🔴 原生上传机制开关：前端据此注入上传按钮 + 图片预览（置于本 combo 下方）
                    "tooltip": "从 input 目录选择图像，或点下方「选择要上传的文件」按钮上传。\n"
                               "选中的图像会直接预览在本节点上（与「加载图像」一致）。\n"
                               "「图像」端口接线时本项自动灰化 —— 端口优先。",
                }),
            },
            "optional": {
                # 🔴 端口名用英文键（避免前端 addInput 的中文名坑），中文走 display_name
                "image": ("IMAGE", {"display_name": "图像"}),
                "mask": ("MASK", {"display_name": "遮罩"}),
                "vae": ("VAE", {"display_name": "VAE"}),
            },
            # 🔴 hidden：拿到本节点 id 与整张工作流图，用于判定 Latent 输出是否被连接
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "LATENT")
    RETURN_NAMES = ("图像", "遮罩", "Latent")
    FUNCTION = "encode"
    OUTPUT_NODE = False

    # ============================================================
    # 对齐倍数：只裁切 / 只缩小，绝不放大（复用 Josia图像缩放 的语义）
    # ============================================================
    @staticmethod
    def _align_to_multiple(width, height, multiple):
        m = int(multiple)
        if m <= 1:
            return width, height
        w_ok = (width % m == 0)
        h_ok = (height % m == 0)
        if w_ok and h_ok:
            return width, height
        if w_ok or h_ok:
            if w_ok:
                return width, max(m, (height // m) * m)
            return max(m, (width // m) * m), height
        short_side, long_side = (width, height) if width <= height else (height, width)
        new_short = (short_side // m) * m
        if new_short < m:
            return width, height
        scale = new_short / short_side
        new_long = max(m, (int(long_side * scale) // m) * m)
        if width <= height:
            return new_short, new_long
        return new_long, new_short

    # ============================================================
    # 根据缩放类型计算目标尺寸（不做对齐，对齐统一在后面执行一次）
    # ============================================================
    @staticmethod
    def _compute_target(orig_w, orig_h, scale_type, factor, longest, shortest, megapixels):
        if scale_type == "按系数缩放":
            return max(1, round(orig_w * factor)), max(1, round(orig_h * factor))
        if scale_type == "按长边缩放":
            if orig_w <= 0 or orig_h <= 0:
                return longest, longest
            s = longest / max(orig_w, orig_h)
            return max(1, round(orig_w * s)), max(1, round(orig_h * s))
        if scale_type == "按短边缩放":
            if orig_w <= 0 or orig_h <= 0:
                return shortest, shortest
            s = shortest / min(orig_w, orig_h)
            return max(1, round(orig_w * s)), max(1, round(orig_h * s))
        if scale_type == "按像素缩放":
            total = megapixels * 1_000_000
            aspect = (orig_w / orig_h) if (orig_h > 0 and orig_w > 0) else 1.0
            tw = math.sqrt(total * aspect)
            th = tw / aspect
            return max(1, round(tw)), max(1, round(th))
        # 关 → 原样透传
        return orig_w, orig_h

    # ============================================================
    # 单张图 / 遮罩缩放：图像用 BOX（最快），遮罩用 NEAREST（不糊边）
    # ============================================================
    @staticmethod
    def _resize(pil_img, pil_mask, final_w, final_h):
        if pil_img.size == (final_w, final_h):
            new_img = pil_img
        else:
            new_img = pil_img.resize((final_w, final_h), Image.Resampling.BOX)
        new_mask = None
        if pil_mask is not None:
            if pil_mask.size == (final_w, final_h):
                new_mask = pil_mask
            else:
                new_mask = pil_mask.resize((final_w, final_h), Image.Resampling.NEAREST)
        return new_img, new_mask

    # ============================================================
    # 判定 Latent 输出是否被连接（扫描整张图的 inputs 看有没有指向本槽的连线）
    # ============================================================
    @staticmethod
    def _output_connected(unique_id, prompt, slot):
        """该输出（按 RETURN_TYPES 下标）有没有被下游连线。没有 prompt 时返回 None（无法判定）。"""
        if not prompt or unique_id is None:
            return None  # 拿不到图 ⇒ 无法判定，交给调用方兜底
        uid = str(unique_id)
        try:
            for node in prompt.values():
                inputs = node.get("inputs", {}) if isinstance(node, dict) else {}
                for v in inputs.values():
                    if isinstance(v, (list, tuple)) and len(v) == 2:
                        if str(v[0]) == uid and int(v[1]) == slot:
                            return True
        except Exception:
            return None
        return False

    def _latent_connected(self, unique_id, prompt):
        return JosiaImageEncode._output_connected(unique_id, prompt, LATENT_OUTPUT_SLOT)

    @classmethod
    def IS_CHANGED(cls, 缩放类型="按系数缩放", 通道切换=CHANNEL_MODE_DEFAULT, 选择图像="", **kwargs):
        """上传文件内容变化时重新执行（口径与原生加载图像一致：文件 sha256）。

        「选择图像」为空（用端口 / 没图）时返回常量，交给上游连线变化驱动。
        文件丢失时返回 NaN，强制每次重跑以便在运行期给出明确报错。
        🔴 缩放类型 / 通道切换 也纳进 key：这两项只改输出形态、不改文件，
        漏掉的话前端判定「输入没变」⇒ 不重跑 ⇒ 改了开关看不出效果。
        """
        key = f"{缩放类型}|{通道切换}"
        if not 选择图像:
            return key
        try:
            path = folder_paths.get_annotated_filepath(选择图像)
            if not path or not os.path.isfile(path):
                return float("nan")
            m = hashlib.sha256()
            with open(path, "rb") as f:
                m.update(f.read())
            return m.digest().hex()
        except Exception:
            return float("nan")

    # ============================================================
    # 主函数
    # ============================================================
    def encode(self, 缩放类型, 缩放系数, 长边尺寸, 短边尺寸, 百万像素, 对齐倍数, 通道切换=CHANNEL_MODE_DEFAULT,
                VAE模型=VAE_PLACEHOLDER, 选择图像="",
                image=None, mask=None, vae=None, unique_id=None, prompt=None):
        # 1) 解析 VAE
        vae_obj = _resolve_vae(vae, VAE模型)

        # 2) 判定是否需要编码 Latent
        detected = self._latent_connected(unique_id, prompt)
        if detected is None:
            # 无法判定时：有 VAE 才编码（保守，避免无谓报错）
            encode_latent = (vae_obj is not None)
        else:
            encode_latent = detected

        if encode_latent and vae_obj is None:
            raise ValueError(
                "[Josia图像编码] Latent 输出已连接，但没有可用的 VAE：请在「VAE模型」里选模型、"
                "或接「Josia模型加载」节点、或直接给「VAE」端口连线。"
            )

        # 2.5) 「遮罩」输出端口有没有被连：连上了就按原生「合并图像Alpha」的口径，
        #      在 RGBA 模式里把遮罩合并成第四通道（遮罩亮＝透明 ⇒ alpha = 1 − 遮罩），
        #      这样一条链里就能完成合并，不必再接一颗原生节点。
        mask_connected = (
            JosiaImageEncode._output_connected(unique_id, prompt, MASK_OUTPUT_SLOT) is True
        )

        # 3) 图像来源：端口 > 上传文件（端口没接时才走上传）
        uploaded_mask = None
        up_alpha = None
        if image is None and 选择图像:
            image, uploaded_mask, up_alpha = _load_selected_image(选择图像)
            if up_alpha is not None:
                up_alpha = up_alpha[None]       # 统一成 (1,H,W)，循环里再按批次下标取
            if mask is None:
                mask = uploaded_mask

        # 4) 原始尺寸（来自图像，其次遮罩，都没有则默认 1024×1024 透传）
        if image is not None:
            orig_h, orig_w = image.shape[1], image.shape[2]
        elif mask is not None:
            orig_h, orig_w = mask.shape[1], mask.shape[2]
        else:
            orig_h, orig_w = 1024, 1024

        # 5) 计算目标尺寸
        #    「关」＝ 完全不缩放、不对齐；其它类型 ＝ 按类型算尺寸后统一对齐一次
        #    按系数缩放且系数为 1 ⇒ _compute_target 原样返回，只走对齐
        if 缩放类型 == "关":
            final_w, final_h = orig_w, orig_h
        else:
            target_w, target_h = self._compute_target(
                orig_w, orig_h, 缩放类型, 缩放系数, 长边尺寸, 短边尺寸, 百万像素
            )
            align_m = int(对齐倍数) if 对齐倍数 not in (None, "关") else 1
            final_w, final_h = self._align_to_multiple(target_w, target_h, align_m)
            final_w, final_h = max(32, final_w), max(32, final_h)

        # 5.5) 通道策略（「通道切换」开关）
        #   自动 ＝ 上游给几通道就透传几通道（三通道出 RGB、四通道出 RGBA）；
        #   RGB  ＝ 强制三通道，第四通道（透明度）不跟图像走、改从「遮罩」端口出来；
        #   RGBA ＝ 强制四通道（上游只有三通道时补一路「全不透明」的 alpha）。
        #   🔴 遮罩一路恒等输出，所以这里的三/四通道只描述「图像」本身，合计是 3+1 / 4+1。
        src_ch = int(image.shape[-1]) if (image is not None and image.ndim == 4) else 3
        if 通道切换 == "RGB":
            out_ch = 3
        elif 通道切换 == "RGBA":
            out_ch = 4
        else:
            out_ch = src_ch if src_ch in (3, 4) else 3

        # 6) 批量处理图像 + 遮罩
        out_images = []
        out_masks = []
        if image is not None:
            batch = image.shape[0]
            for i in range(batch):
                t = image[i].cpu().numpy()
                # 🔴 兜底：灰度 / 单通道等异常维度补齐成 RGB 再往下走（正常 IMAGE 端口只给 3、4 通道）
                #    先补维度（2D ⇒ (H,W,1)），再复制通道；顺序反了会在 RGBA 分支拼 alpha 时炸维度。
                if t.ndim == 2:
                    t = t[:, :, None]
                if t.shape[-1] < 3:
                    t = np.concatenate([t[..., :1], t[..., :1], t[..., :1]], axis=-1)
                rgb = (np.clip(t[..., :3], 0.0, 1.0) * 255).astype(np.uint8)
                # 🔴 透明区填白：预览组件只画 RGB，而 PNG 里「透明区的 RGB 常常恰好是 0」，
                #    原样透出去就会被渲染成黑块（最典型的「透明背景变黑」）。
                #    这里按真实 alpha 把近全透明的像素刷成白，半透明像素保持原色不动。
                #    透明度依然完整保留在第四通道 / 遮罩端口，这里的白只是预览底色的呈现。
                if up_alpha is not None and i < up_alpha.shape[0]:
                    src_alpha = up_alpha[i]                 # 上传文件自带 alpha（原生加载拿不到本体）
                elif t.shape[-1] >= 4:
                    src_alpha = t[..., 3]                   # 上游直接给了四通道
                else:
                    src_alpha = None
                if src_alpha is not None:
                    transparent_px = (
                        np.clip(src_alpha, 0.0, 1.0) * 255.0
                    ) < TRANSPARENT_ALPHA_MAX
                    if transparent_px.any():
                        rgb[transparent_px] = TRANSPARENT_FILL_VALUE
                if out_ch == 4:
                    if mask_connected and mask is not None and i < mask.shape[0]:
                        # 「遮罩」端口接线 ⇒ 内置合并 RGBA：alpha = 1 − 遮罩（遮罩亮＝透明）
                        alpha = (
                            np.clip(1.0 - mask[i].cpu().numpy(), 0.0, 1.0) * 255.0 + 0.5
                        ).astype(np.uint8)[..., None]
                    elif src_alpha is not None:   # 有真实透明度（上传文件自带 / 上游第四通道）⇒ 原样带上
                        alpha = (np.clip(src_alpha, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)[..., None]
                    else:                         # 完全没有透明信息 ⇒ 补一路「全不透明」的 alpha
                        alpha = np.full(rgb.shape[:2] + (1,), 255, dtype=np.uint8)
                    pil_img = Image.fromarray(np.concatenate([rgb, alpha], axis=-1))
                else:
                    pil_img = Image.fromarray(rgb)   # 强制三通道：alpha 不跟图像走
                pil_mask = None
                if mask is not None and i < mask.shape[0]:
                    mt = mask[i].cpu().numpy()
                    pil_mask = Image.fromarray((np.clip(mt, 0.0, 1.0) * 255).astype(np.uint8), mode="L")
                elif t.shape[-1] >= 4:
                    # 没接遮罩端口但图里带 alpha ⇒ 反算成遮罩（1-α，遮罩亮＝透明区，与原生一致）
                    al = 255.0 * (1.0 - np.clip(t[..., 3:4], 0.0, 1.0))
                    pil_mask = Image.fromarray(al.astype(np.uint8)[..., 0], mode="L")
                pil_img, pil_mask = self._resize(pil_img, pil_mask, final_w, final_h)
                img_arr = np.array(pil_img)
                if img_arr.shape[-1] != out_ch:       # 双保险：PIL 吐出来的通道数不对就硬截 / 补齐
                    if img_arr.shape[-1] > out_ch:
                        img_arr = img_arr[..., :out_ch]
                    else:
                        pad_v = 255 if out_ch == 4 else 0
                        pad = np.full(
                            img_arr.shape[:2] + (out_ch - img_arr.shape[-1],), pad_v, dtype=np.uint8
                        )
                        img_arr = np.concatenate([img_arr, pad], axis=-1)
                out_images.append(
                    torch.from_numpy(img_arr.astype(np.float32) / 255.0)
                )
                if pil_mask is not None:
                    out_masks.append(
                        torch.from_numpy(np.array(pil_mask).astype(np.float32) / 255.0)
                    )
                del t, pil_img, pil_mask
                gc.collect()
            img_result = torch.stack(out_images)
            if out_masks:
                mask_result = torch.stack(out_masks)
            else:
                mask_result = torch.ones((batch, final_h, final_w), dtype=torch.float32)
            del out_images, out_masks
        else:
            # 没图（没接端口也没上传）：输出对齐尺寸的全黑图 + 全不透明遮罩（兜底，不报错）
            # 🔴 通道数跟随「通道切换」：RGBA 时补一路全不透明的 alpha，免得下游按三通道解析
            if out_ch == 4:
                img_result = torch.zeros((1, final_h, final_w, 4), dtype=torch.float32)
                img_result[..., 3] = 1.0
            else:
                img_result = torch.zeros((1, final_h, final_w, 3), dtype=torch.float32)
            mask_result = torch.ones((1, final_h, final_w), dtype=torch.float32)

        gc.collect()

        # 7) 条件编码 Latent
        if encode_latent and vae_obj is not None:
            # VAE 编码需要 [B,H,W,3] 浮点张量；只取前 3 通道以防 RGBA
            latent = vae_obj.encode(img_result[:, :, :, :3])
            latent_output = {"samples": latent}
        else:
            # 不编码：返回一个极小的占位 Latent（未连接时由框架丢弃，无害）
            latent_output = {
                "samples": torch.zeros(
                    (1, 4, max(1, final_h // 8), max(1, final_w // 8)),
                    dtype=torch.float32,
                )
            }

        return (img_result, mask_result, latent_output)


# ==================== ComfyUI 节点映射（与 __init__.py 注册名严格一致） ====================
NODE_CLASS_MAPPINGS = {
    "JosiaImageEncode": JosiaImageEncode
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaImageEncode": "Josia图像编码"
}
