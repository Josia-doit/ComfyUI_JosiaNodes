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
    CATEGORY = "Josia"
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
    def _concat_horizontal(img_a, img_b):
        """
        将两张 IMAGE 张量沿宽度方向左右无缝拼接。
        - IMAGE 张量格式为 [B, H, W, C]，值域 0-1 float。
        - 若两图高度不一致，则把 B 缩放到与 A 相同高度（保持宽高比）后再拼接，避免错位。
        - 若两图 batch 数不同，取较小者对齐。
        """
        # 对齐 batch 数量
        n = min(img_a.shape[0], img_b.shape[0])
        a = img_a[:n]
        b = img_b[:n]

        h_a = a.shape[1]
        h_b = b.shape[1]
        if h_b != h_a:
            # 把 B 缩放到高度 h_a，宽度按原始宽高比等比缩放
            target_h = h_a
            target_w = max(1, round(b.shape[2] * target_h / h_b))
            b = b.movedim(-1, 1)  # [B,H,W,C] -> [B,C,H,W]
            b = comfy.utils.common_upscale(b, target_w, target_h, "lanczos", "disabled")
            b = b.movedim(1, -1)  # 还原 [B,H,W,C]

        # 沿宽度维度（dim=2）拼接
        return torch.cat([a, b], dim=2)

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
