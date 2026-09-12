"""
Josia 图像对比节点
功能：支持两张图像的预览与对比，继承PreviewImage类实现图像保存/预览
本地文件名：image_comparer.py（全小写）
节点英文标识：JosiaImageComparer
节点中文显示名：Josia图像对比
依赖：nodes.PreviewImage、node_properties.IMAGE_COMPARER_DESCRIPTION
"""
import torch
import comfy.utils
from nodes import PreviewImage

# 从 node_properties.py 导入 DESCRIPTION，保持代码简洁
from node_properties import IMAGE_COMPARER_DESCRIPTION


class JosiaImageComparer(PreviewImage):  # 类名改为JosiaImageComparer（匹配__init__.py注册名）
    NAME = "Josia图像对比"
    CATEGORY = "⚡️JosiaNodes"
    FUNCTION = "compare_images"

    # IMAGE 输出：将图像A与图像B左右无缝拼接成一张图输出
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("拼接图像",)

    # 使用外部导入的描述信息，避免硬编码
    DESCRIPTION = IMAGE_COMPARER_DESCRIPTION

    @classmethod
    def INPUT_TYPES(cls):
        """定义节点输入参数（ComfyUI核心要求）"""
        return {
            "required": {},
            "optional": {
                "图像A": ("IMAGE",),
                "图像B": ("IMAGE",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO"
            },
        }

    @staticmethod
    def _align_channels(img_a, img_b):
        """
        将两张图对齐到相同的通道数，使它们能沿宽度拼接。
        IMAGE 张量格式 [B,H,W,C]，值域 0-1。ComfyUI 新版 LoadImage 默认输出 3 通道(RGB)，
        而部分来源(旧图/VaeDecode/带透明通道的图)可能是 4 通道(RGBA)；通道数不一致时
        torch.cat 会报「Sizes of tensors must match except in dimension 2」。
        - 取两者通道数的较大值 target_c 作为目标。
        - 通道较少的一张补齐到 target_c：
            * 1->3 / 1->4：灰度复制到各通道（4 通道时再令 alpha=1.0）
            * 3->4：附加不透明 alpha（alpha=1.0）
            * 其它：缺失通道用 1.0 填充
        - 通道较多的一张保持不变。
        """
        ca = img_a.shape[-1]
        cb = img_b.shape[-1]
        if ca == cb:
            return img_a, img_b
        target_c = max(ca, cb)

        def _to_target(img, c):
            if c == target_c:
                return img
            device, dtype = img.device, img.dtype
            if c == 1:
                # 灰度复制到 target_c 个通道（RGB/RGBA 下均为灰度）
                img = img.repeat(1, 1, 1, target_c)
                if target_c == 4:
                    img[..., 3] = 1.0
                return img
            if c == 3 and target_c == 4:
                # RGB 补不透明 alpha，变成 RGBA
                alpha = torch.ones(*img.shape[:-1], 1, device=device, dtype=dtype)
                return torch.cat([img, alpha], dim=-1)
            # 兜底：用 1.0 补足缺失通道
            pad = torch.ones(*img.shape[:-1], target_c - c, device=device, dtype=dtype)
            return torch.cat([img, pad], dim=-1)

        print(f"[JosiaImageComparer] 通道数不一致(A={ca}, B={cb})，已自动对齐为 {target_c} 通道", flush=True)
        return _to_target(img_a, ca), _to_target(img_b, cb)

    @staticmethod
    def _resize_to(b, target_h, target_w):
        """把 [B,H,W,C] 图像等比缩放到 (target_h, target_w)。
        优先用 ComfyUI 原生 common_upscale（质量好），若当前版本对该签名/通道数不支持
        则回退到 PyTorch 原生 F.interpolate（对任意通道数稳定可用），保证“导出拼接图像”
        在任何 ComfyUI 版本下都不会因缩放报错。
        """
        b4 = b.movedim(-1, 1)  # [B,H,W,C] -> [B,C,H,W]
        try:
            out = comfy.utils.common_upscale(b4, target_w, target_h, "lanczos", "disabled")
        except Exception:
            out = torch.nn.functional.interpolate(
                b4, size=(target_h, target_w), mode="bilinear", align_corners=False
            )
        return out.movedim(1, -1)  # 还原 [B,H,W,C]

    @staticmethod
    def _normalize_channels(img):
        """确保输出通道数为 1/3/4 之一，避免下游保存/导出遇到非标准通道数报错。"""
        c = img.shape[-1]
        if c in (1, 3, 4):
            return img
        if c > 4:                      # 多余通道：裁剪到前 4 通道 (RGBA)
            return img[..., :4]
        if c == 2:                    # 2 通道（灰度+alpha 等）：取首通道复制为 RGB
            return img[..., 0:1].repeat(1, 1, 1, 3)
        # 其它异常通道数（如 5/6）：复制首通道补成 RGB
        return img[..., 0:1].repeat(1, 1, 1, 3)

    @staticmethod
    def _concat_horizontal(img_a, img_b):
        """
        将两张 IMAGE 张量沿宽度方向左右无缝拼接。
        - IMAGE 张量格式为 [B, H, W, C]，值域 0-1 float。
        - 若两图高度不一致，则把 B 缩放到与 A 相同高度（保持宽高比）后再拼接，避免错位。
        - 若两图 batch 数不同，取较小者对齐。
        - 若两图通道数不一致(RGBA vs RGB 等)，自动对齐到相同通道数，避免 torch.cat 报错。
        - 末尾再做通道数归一化（1/3/4），保证导出/保存路径永不因异常通道数崩溃。
        """
        # 对齐 batch 数量
        n = min(img_a.shape[0], img_b.shape[0])
        a = img_a[:n]
        b = img_b[:n]

        # 对齐通道数（RGBA / RGB 等不一致时统一，否则拼接报错）
        a, b = JosiaImageComparer._align_channels(a, b)

        h_a = a.shape[1]
        h_b = b.shape[1]
        if h_b != h_a:
            # 把 B 缩放到高度 h_a，宽度按原始宽高比等比缩放
            target_h = h_a
            target_w = max(1, round(b.shape[2] * target_h / h_b))
            b = JosiaImageComparer._resize_to(b, target_h, target_w)

        # 沿宽度维度（dim=2）拼接
        out = torch.cat([a, b], dim=2)
        # 通道兜底：确保输出为 1/3/4 通道，兼容所有 ComfyUI 版本的保存/导出
        out = JosiaImageComparer._normalize_channels(out)
        return out.contiguous()

    def compare_images(self, 图像A=None, 图像B=None,
                       filename_prefix="Josia.compare.",
                       prompt=None, extra_pnginfo=None):
        """
        核心对比逻辑：保存并预览两张输入图像，并输出 A、B 左右拼接后的图像。
        :param 图像A: 对比图像A
        :param 图像B: 对比图像B
        :param filename_prefix: 保存文件名前缀
        :param prompt: 隐藏参数（ComfyUI提示词）
        :param extra_pnginfo: 隐藏参数（PNG附加信息）
        :return: (拼接图像, UI预览结果)
        """
        result = {"ui": {"a_images": [], "b_images": []}}
        has_a = 图像A is not None and len(图像A) > 0
        has_b = 图像B is not None and len(图像B) > 0

        # 后台诊断日志：直接在 ComfyUI 运行窗口可见，无需打开 F12
        print(f"[JosiaImageComparer] 执行：图像A={'有(%d张)' % len(图像A) if has_a else '无'} | "
              f"图像B={'有(%d张)' % len(图像B) if has_b else '无'}", flush=True)

        if has_a:
            result["ui"]["a_images"] = self.save_images(
                图像A, f"{filename_prefix}a_", prompt, extra_pnginfo
            )["ui"]["images"]
        if has_b:
            result["ui"]["b_images"] = self.save_images(
                图像B, f"{filename_prefix}b_", prompt, extra_pnginfo
            )["ui"]["images"]

        # 输出：A、B 都在则左右无缝拼接；只有一张则原样输出；都没有则输出 None
        if has_a and has_b:
            out_image = self._concat_horizontal(图像A, 图像B)
        elif has_a:
            out_image = 图像A
        elif has_b:
            out_image = 图像B
        else:
            out_image = None

        if out_image is not None:
            print(f"[JosiaImageComparer] 拼接输出图像形状：{tuple(out_image.shape)} "
                  f"（batch, 高, 宽, 通道）", flush=True)
        else:
            print(f"[JosiaImageComparer] 无输出图像（A/B 均未接入）", flush=True)
        print(f"[JosiaImageComparer] 返回 UI：a_images={len(result['ui']['a_images'])}张, "
              f"b_images={len(result['ui']['b_images'])}张", flush=True)
        # 注意：ui 字典里的键就是前端 onExecuted 会收到的对象本身。
        # 原生 ComfyUI ImageCompare 也是把 a_images / b_images 放在 ui 根下，
        # 不要多包一层 "output"，否则前端找不到这两个字段。
        return {
            "result": (out_image,),
            "ui": {
                "a_images": result["ui"]["a_images"],
                "b_images": result["ui"]["b_images"],
            }
        }


# ==================== ComfyUI 节点映射（与__init__.py注册名严格一致） ====================
NODE_CLASS_MAPPINGS = {
    "JosiaImageComparer": JosiaImageComparer  # 英文标识改为JosiaImageComparer
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaImageComparer": "Josia图像对比"  # 中文显示名保持不变
}
