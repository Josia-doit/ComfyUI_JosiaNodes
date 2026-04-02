"""
Josia文本编码节点 - 最终优化版
开关逻辑完全反转，语义更清晰，纯原生核心逻辑
新增：Latent输出端口 + 空Latent开关（适配Flux2 Klein等模型）
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

                # 控件区（顺序严格对应界面显示顺序）
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
                # ========== 已挪动位置：主图Latent模式开关 ==========
                "主图Latent模式": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅主图潜空间Latent",
                    "label_off": "❌仅主图尺寸Latent"
                }),
                "正向提示词": ("STRING", {
                    "multiline": True,
                    "dynamicPrompts": True,
                    "default": ""
                }),
                # 负向提示词生效开关（反转逻辑）
                "负向提示词生效开关": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅负向提示词正常生效",
                    "label_off": "❌负向提示词条件归零"
                }),
                "负向提示词": ("STRING", {
                    "multiline": True,
                    "dynamicPrompts": True,
                    "default": ""
                }),
            }
        }

    # ========== 已修改：输出端名称去掉「主图」二字 ==========
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "负向条件", "Latent")
    FUNCTION = "encode"
    CATEGORY = "Josia 专用节点/图像编码"
    DESCRIPTION = "Josia文本编码节点，支持5图参考融合、负向条件归零、Latent输出（含空Latent模式）"

    def encode(self, clip, vae, 图像1, **kwargs):
        # 1. 基础文本编码（和原生CLIP完全一致）
        clip_encode = CLIPTextEncode()
        # 提取参数
        enable_ref = kwargs.get("图像参考开关", True)
        strength = kwargs.get("图像参考强度", 1.0)
        pos_prompt = kwargs.get("正向提示词", "")
        neg_enabled = kwargs.get("负向提示词生效开关", True)
        neg_prompt = kwargs.get("负向提示词", "")
        latent_real_mode = kwargs.get("主图Latent模式", True)

        # 正负向条件编码
        positive = clip_encode.encode(clip, pos_prompt)[0]
        # 负向条件归零逻辑：开关关闭（False）= 归零清空
        negative = [[[], {}]] if not neg_enabled else clip_encode.encode(clip, neg_prompt)[0]

        # 2. 图像参考融合逻辑（原有逻辑完全不变）
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

        # 3. Latent生成核心逻辑（原有功能完全不变）
        vae_encode = VAEEncode()
        if latent_real_mode:
            # 模式1：真实像素Latent（原生VAE编码）
            main_latent = vae_encode.encode(vae, 图像1)[0]
        else:
            # 模式2：仅尺寸空Latent（适配Flux2 Klein）
            img_batch, img_h, img_w, img_c = 图像1.shape
            latent_h = img_h // 8
            latent_w = img_w // 8
            empty_latent_tensor = torch.zeros((1, 4, latent_h, latent_w), device=图像1.device, dtype=torch.float32)
            main_latent = {"samples": empty_latent_tensor}

        return (positive, negative, main_latent)

# 节点注册
NODE_CLASS_MAPPINGS = {
    "JosiaEncoder": JosiaEncoder
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaEncoder": "Josia文本编码"
}
