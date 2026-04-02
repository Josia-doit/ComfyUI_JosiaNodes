from nodes import PreviewImage

# 从 node_properties.py 导入 DESCRIPTION，保持 Image_Comparer.py 干净
from .node_properties import IMAGE_COMPARER_DESCRIPTION


class JosiaImgCmp(PreviewImage):
    NAME = "Josia图像对比"
    CATEGORY = "Josia"
    FUNCTION = "compare_images"
    
    # 使用从 node_properties 导入的 DESCRIPTION（不再硬编码）
    DESCRIPTION = IMAGE_COMPARER_DESCRIPTION

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "image_a": ("IMAGE",),
                "image_b": ("IMAGE",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO"
            },
        }

    def compare_images(self, image_a=None, image_b=None,
                       filename_prefix="Josia.compare.",
                       prompt=None, extra_pnginfo=None):
        result = {"ui": {"a_images": [], "b_images": []}}
        if image_a is not None and len(image_a) > 0:
            result["ui"]["a_images"] = self.save_images(
                image_a, f"{filename_prefix}a_", prompt, extra_pnginfo
            )["ui"]["images"]
        if image_b is not None and len(image_b) > 0:
            result["ui"]["b_images"] = self.save_images(
                image_b, f"{filename_prefix}b_", prompt, extra_pnginfo
            )["ui"]["images"]
        return result


# 节点映射
NODE_CLASS_MAPPINGS = {
    "JosiaImgCmp": JosiaImgCmp
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaImgCmp": "Josia图像对比"
}