"""
Josia 文本编码节点
功能：支持多图参考的CLIP/VAE编码，包含图生图/文生图切换、参考Latent条件、负向提示词开关等功能
本地文件名：Encoder.py
节点英文标识：JosiaEncoder
节点中文显示名：Josia文本编码
依赖：torch、math、comfy.utils、node_helpers、comfy.model_management
"""
import torch
import math
import comfy.utils
import node_helpers
import comfy.model_management

class JosiaEncoder:
    CATEGORY = "Josia"
    DESCRIPTION = """🖊️ Josia 文本编码
支持文生图与图生图一体化 CLIP/VAE 编码，最多融合 5 张参考图。

• 图像参考模式：开启时参考图像生成Latent，关闭时输出空Latent
• 负向提示词开关：关闭时自动将负向条件归零
• 参考 Latent 模式：开启时注入参考Latent条件，关闭时仅使用文本条件

输出：正向条件 / 负向条件 / Latent"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {"display_name": "CLIP"}),
                "image_reference_switch": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ 图生图模式",
                    "label_off": "❌ 文生图模式",
                    "display_name": "图像参考模式"
                }),
                "reference_latent_mode": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ 参考Latent条件",
                    "label_off": "❌ 标准VAE编码",
                    "display_name": "参考Latent模式"
                }),
                "positive_prompt": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "placeholder": "正向提示词",
                    "dynamicPrompts": True,
                    "display_name": "正向提示词"
                }),
                "negative_switch": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ 负向提示词正常生效",
                    "label_off": "❌ 负向提示词条件归零",
                    "display_name": "负向提示词生效"
                }),
                "negative_prompt": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "placeholder": "负向提示词",
                    "dynamicPrompts": True,
                    "display_name": "负向提示词"
                }),
            },
            "optional": {
                "vae": ("VAE", {"display_name": "VAE"}),
                "image1": ("IMAGE", {"display_name": "图像1"}),
                "image2": ("IMAGE", {"display_name": "图像2"}),
                "image3": ("IMAGE", {"display_name": "图像3"}),
                "image4": ("IMAGE", {"display_name": "图像4"}),
                "image5": ("IMAGE", {"display_name": "图像5"}),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "负向条件", "Latent")
    FUNCTION = "encode"

    def encode(self, clip, image_reference_switch, reference_latent_mode,
               positive_prompt, negative_switch, negative_prompt, vae=None,
               image1=None, image2=None, image3=None, image4=None, image5=None):
        """
        核心编码逻辑
        
        四种情况：
        1. 无图像输入 → 1024x1024空Latent，纯文本条件
        2. 有图像 + 开关1关闭 → 原图尺寸空Latent，纯文本条件
        3. 有图像 + 开关1开 + 开关2关 → VAE编码Latent，纯文本条件（图生图）
        4. 有图像 + 开关1开 + 开关2开 → VAE编码Latent，参考Latent条件（参考图生图）
        """
        
        images = [image1, image2, image3, image4, image5]
        images_vl = []
        image_prompt = ""
        
        # Llama模板（千问模型原生逻辑）
        llama_template = "<|im_start|>system\nDescribe the key features of the input image (color, shape, size, texture, objects, background), then explain how the user's text instruction should alter or modify the image. Generate a new image that meets the user's requirements while maintaining consistency with the original input where appropriate.<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n"

        # ==============================================
        # 【CLIP视觉编码 - 处理所有参考图像】
        # ==============================================
        for i, image in enumerate(images):
            if image is not None:
                samples = image.movedim(-1, 1)
                total_vl = int(384 * 384)
                scale_by_vl = math.sqrt(total_vl / (samples.shape[3] * samples.shape[2]))
                width_vl = round(samples.shape[3] * scale_by_vl)
                height_vl = round(samples.shape[2] * scale_by_vl)
                s_vl = comfy.utils.common_upscale(samples, width_vl, height_vl, "area", "disabled")
                images_vl.append(s_vl.movedim(1, -1))
                image_prompt += "Picture {}: <|vision_start|><|image_pad|><|vision_end|>".format(i + 1)

        # ==============================================
        # 【Latent生成】
        # ==============================================
        
        # 情况1：无图像输入 → 1024x1024空Latent（复刻原生EmptyLatentImage）
        if image1 is None:
            latent = torch.zeros([1, 4, 128, 128], 
                                device=comfy.model_management.intermediate_device(),
                                dtype=comfy.model_management.intermediate_dtype())
            latent_output = {
                "samples": latent,
                "downscale_ratio_spacial": 8,
            }
            vae_encoded_latent = None
        
        # 情况2：有图像但开关1关闭 → 原图尺寸空Latent（复刻原生EmptyLatentImage）
        elif not image_reference_switch:
            pixel_width = image1.shape[2]
            pixel_height = image1.shape[1]
            batch_size = image1.shape[0]
            width = (pixel_width // 8) * 8
            height = (pixel_height // 8) * 8
            
            latent = torch.zeros([batch_size, 4, height // 8, width // 8], 
                                device=comfy.model_management.intermediate_device(),
                                dtype=comfy.model_management.intermediate_dtype())
            latent_output = {
                "samples": latent,
                "downscale_ratio_spacial": 8,
            }
            vae_encoded_latent = None
        
        # 情况3和4：有图像且开关1开启（图生图模式）
        else:
            if vae is not None:
                # VAE编码（复刻原生VAEEncode）
                vae_encoded_latent = vae.encode(image1[:, :, :, :3])
                
                # Latent输出（复刻原生VAEEncode格式）
                latent_output = {"samples": vae_encoded_latent}
            else:
                # VAE未接入，降级为空Latent
                pixel_width = image1.shape[2]
                pixel_height = image1.shape[1]
                batch_size = image1.shape[0]
                width = (pixel_width // 8) * 8
                height = (pixel_height // 8) * 8
                
                latent = torch.zeros([batch_size, 4, height // 8, width // 8], 
                                    device=comfy.model_management.intermediate_device(),
                                    dtype=comfy.model_management.intermediate_dtype())
                latent_output = {
                    "samples": latent,
                    "downscale_ratio_spacial": 8,
                }
                vae_encoded_latent = None

        # ==============================================
        # 【正向条件编码】
        # ==============================================
        tokens = clip.tokenize(image_prompt + positive_prompt, images=images_vl, llama_template=llama_template)
        positive_conditioning = clip.encode_from_tokens_scheduled(tokens)

        # ==============================================
        # 【参考Latent条件 - 仅情况4】
        # ==============================================
        # 只有开关1开启 + 开关2开启 + 有VAE编码结果时，才注入参考Latent条件
        if image_reference_switch and reference_latent_mode and vae_encoded_latent is not None:
            # 情况4：注入参考Latent条件（复刻原生ReferenceLatent节点）
            positive_conditioning = node_helpers.conditioning_set_values(positive_conditioning, {
                "reference_latents": [vae_encoded_latent]
            }, append=True)
        # 情况3：开关1开+开关2关 → 不注入reference_latents，纯文本条件

        # ==============================================
        # 【负向条件编码】
        # ==============================================
        if negative_switch:
            neg_tokens = clip.tokenize(negative_prompt, images=images_vl, llama_template=llama_template)
            negative_conditioning = clip.encode_from_tokens_scheduled(neg_tokens)
        else:
            empty_tokens = clip.tokenize("", images=images_vl, llama_template=llama_template)
            negative_conditioning = clip.encode_from_tokens_scheduled(empty_tokens)

        return (positive_conditioning, negative_conditioning, latent_output)


# ==================== ComfyUI 节点映射 ====================
NODE_CLASS_MAPPINGS = {
    "JosiaEncoder": JosiaEncoder
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaEncoder": "Josia文本编码"
}
