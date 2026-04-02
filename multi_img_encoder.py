"""
Josia文本编码节点 - 最终定稿版
开关逻辑完全反转，语义更清晰，纯原生核心逻辑
"""
from nodes import CLIPTextEncode, VAEEncode
import torch

class JosiaEncoder:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                # 核心输入口
                "clip": ("CLIP",),
                "vae": ("VAE",),
                # 固定5个图像参考输入口
                "图像1": ("IMAGE",),
                "图像2": ("IMAGE", {"optional": True}),
                "图像3": ("IMAGE", {"optional": True}),
                "图像4": ("IMAGE", {"optional": True}),
                "图像5": ("IMAGE", {"optional": True}),

                # 控件区
                "图像参考开关": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅图生图模式",
                    "label_off": "❌文生图模式"
                }),
                "图像参考强度": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01
                }),
                "正向提示词": ("STRING", {
                    "multiline": True,
                    "dynamicPrompts": True,
                    "default": ""
                }),
                # ========== 完全匹配你的需求：开关逻辑反转+语义清晰 ==========
                "负向提示词生效开关": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅负向提示词正常生效",   # 开（勾选）= 正常生效
                    "label_off": "❌负向提示词条件归零"  # 关（不勾选）= 条件归零
                }),
                "负向提示词": ("STRING", {
                    "multiline": True,
                    "dynamicPrompts": True,
                    "default": ""
                }),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("正向条件", "负向条件")
    FUNCTION = "encode"
    CATEGORY = "Josia 专用节点/图像编码"
    DESCRIPTION = "Josia文本编码节点，支持5图参考融合、负向条件归零"

    def encode(self, clip, vae, 图像1, **kwargs):
        # 1. 基础文本编码（和原生CLIP完全一致）
        clip_encode = CLIPTextEncode()
        # 提取参数
        enable_ref = kwargs.get("图像参考开关", True)
        strength = kwargs.get("图像参考强度", 1.0)
        pos_prompt = kwargs.get("正向提示词", "")
        # ========== 开关逻辑反转：关（False）= 归零 ==========
        neg_enabled = kwargs.get("负向提示词生效开关", True)
        neg_prompt = kwargs.get("负向提示词", "")

        # 正负向条件编码
        positive = clip_encode.encode(clip, pos_prompt)[0]
        # 负向条件归零逻辑：开关关闭（False）= 归零清空
        negative = [[[], {}]] if not neg_enabled else clip_encode.encode(clip, neg_prompt)[0]

        # 2. 图像参考融合逻辑
        if enable_ref:
            vae_encode = VAEEncode()
            valid_images = []
            # 遍历所有有效图像
            all_images = [图像1] + [kwargs.get(f"图像{i}", None) for i in range(2, 6)]
            for img in all_images:
                if img is not None:
                    latent = vae_encode.encode(vae, img)[0]
                    valid_images.append(latent)
            
            # 多图平均融合
            if len(valid_images) > 0:
                merged_latent = torch.mean(torch.cat(valid_images, dim=0), dim=0, keepdim=True)
                # 注入参考特征
                for cond in positive:
                    if len(cond) >= 2 and isinstance(cond[1], dict):
                        cond[1]["image_latent"] = merged_latent
                        cond[1]["reference_strength"] = strength

        return (positive, negative)

# 节点注册
NODE_CLASS_MAPPINGS = {
    "JosiaEncoder": JosiaEncoder
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaEncoder": "Josia文本编码"
}