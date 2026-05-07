"""
Josia 图像对比节点
功能：支持两张图像的预览与对比，继承PreviewImage类实现图像保存/预览
本地文件名：image_comparer.py（全小写）
节点英文标识：JosiaImageComparer
节点中文显示名：Josia图像对比
依赖：nodes.PreviewImage、node_properties.IMAGE_COMPARER_DESCRIPTION
"""
from nodes import PreviewImage

# 从 node_properties.py 导入 DESCRIPTION，保持代码简洁
from node_properties import IMAGE_COMPARER_DESCRIPTION


class JosiaImageComparer(PreviewImage):  # 类名改为JosiaImageComparer（匹配__init__.py注册名）
    NAME = "Josia图像对比"
    CATEGORY = "Josia"
    FUNCTION = "compare_images"
    
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

    def compare_images(self, 图像A=None, 图像B=None,
                       filename_prefix="Josia.compare.",
                       prompt=None, extra_pnginfo=None):
        """
        核心对比逻辑：保存并预览两张输入图像
        :param 图像A: 对比图像A
        :param 图像B: 对比图像B
        :param filename_prefix: 保存文件名前缀
        :param prompt: 隐藏参数（ComfyUI提示词）
        :param extra_pnginfo: 隐藏参数（PNG附加信息）
        :return: 包含两张图像预览信息的UI结果
        """
        result = {"ui": {"a_images": [], "b_images": []}}
        if 图像A is not None and len(图像A) > 0:
            result["ui"]["a_images"] = self.save_images(
                图像A, f"{filename_prefix}a_", prompt, extra_pnginfo
            )["ui"]["images"]
        if 图像B is not None and len(图像B) > 0:
            result["ui"]["b_images"] = self.save_images(
                图像B, f"{filename_prefix}b_", prompt, extra_pnginfo
            )["ui"]["images"]
        return result


# ==================== ComfyUI 节点映射（与__init__.py注册名严格一致） ====================
NODE_CLASS_MAPPINGS = {
    "JosiaImageComparer": JosiaImageComparer  # 英文标识改为JosiaImageComparer
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaImageComparer": "Josia图像对比"  # 中文显示名保持不变
}
