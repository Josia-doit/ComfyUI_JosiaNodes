"""
Josia 文本编码节点
功能：支持多图参考的CLIP/VAE编码，包含图生图/文生图切换、Latent分辨率1:1对齐、负向提示词开关等功能
本地文件名：Encoder.py
节点英文标识：JosiaEncoder
节点中文显示名：Josia文本编码
依赖：torch、math、comfy.utils、node_helpers
"""
import torch
import math
import comfy.utils
import node_helpers

class JosiaEncoder:  # 类名与__init__.py注册的JosiaEncoder严格一致
    @classmethod
    def INPUT_TYPES(cls):
        """定义节点输入参数（ComfyUI核心要求）"""
        return {
            "required": {
                "clip": ("CLIP", {"display_name": "CLIP"}),
                "vae": ("VAE", {"display_name": "VAE"}),
                "image_reference_switch": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ 图生图模式",
                    "label_off": "❌ 文生图模式",
                    "display_name": "图像参考模式"
                }),
                "main_latent_mode": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ 主图潜空间Latent",
                    "label_off": "❌ 仅主图尺寸Latent",
                    "display_name": "主图Latent模式"
                }),
                "reference_latent_mode": ("BOOLEAN", {
                    "default": False,
                    "label_on": "✅ 输出参考Latent格式",
                    "label_off": "❌ 输出标准Latent格式",
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
                "image1": ("IMAGE", {"display_name": "图像1"}),
                "image2": ("IMAGE", {"display_name": "图像2"}),
                "image3": ("IMAGE", {"display_name": "图像3"}),
                "image4": ("IMAGE", {"display_name": "图像4"}),
                "image5": ("IMAGE", {"display_name": "图像5"}),
            }
        }

    # 输出类型与名称定义
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "负向条件", "Latent")
    FUNCTION = "encode"  # 核心执行函数名
    CATEGORY = "JosiaNodes"  # 节点分类（ComfyUI左侧菜单路径）

    def encode(self, clip, vae, image_reference_switch, main_latent_mode, reference_latent_mode,
               positive_prompt, negative_switch, negative_prompt, 
               image1=None, image2=None, image3=None, image4=None, image5=None):
        """
        核心编码逻辑：多图参考的CLIP/VAE编码，支持Latent分辨率1:1对齐
        :param clip: CLIP模型实例
        :param vae: VAE模型实例
        :param image_reference_switch: 是否开启图生图模式
        :param main_latent_mode: 是否使用主图潜空间Latent
        :param reference_latent_mode: 是否输出参考Latent格式
        :param positive_prompt: 正向提示词
        :param negative_switch: 负向提示词是否生效
        :param negative_prompt: 负向提示词
        :param image1-image5: 可选参考图像（最多5张）
        :return: (正向条件, 负向条件, Latent输出)
        """

        # ==============================================
        # 【基础初始化】
        # ==============================================
        ref_latents = []          # 参考Latent列表
        main_ref_latent = None    # 主参考Latent
        images = [image1, image2, image3, image4, image5]  # 参考图像列表
        images_vl = []            # 视觉编码用图像列表
        image_prompt = ""         # 图像提示词拼接字符串

        # Llama模板（千问模型原生逻辑）
        llama_template = "<|im_start|>system\nDescribe the key features of the input image (color, shape, size, texture, objects, background), then explain how the user's text instruction should alter or modify the image. Generate a new image that meets the user's requirements while maintaining consistency with the original input where appropriate.<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n"

        if image_reference_switch:
            for i, image in enumerate(images):
                if image is not None:
                    samples = image.movedim(-1, 1)
                    # CLIP视觉编码（千问原生逻辑，不影响分辨率）
                    total_vl = int(384 * 384)
                    scale_by_vl = math.sqrt(total_vl / (samples.shape[3] * samples.shape[2]))
                    width_vl = round(samples.shape[3] * scale_by_vl)
                    height_vl = round(samples.shape[2] * scale_by_vl)
                    s_vl = comfy.utils.common_upscale(samples, width_vl, height_vl, "area", "disabled")
                    images_vl.append(s_vl.movedim(1, -1))

                    # 🔥 核心修复：分辨率1:1对齐逻辑
                    if i == 0 and vae is not None:
                        if reference_latent_mode:
                            # 开启参考Latent模式：严格使用原图分辨率（8的倍数强制对齐原图）
                            orig_width = image1.shape[2]
                            orig_height = image1.shape[1]
                            width_vae = orig_width - (orig_width % 8) if orig_width % 8 != 0 else orig_width
                            height_vae = orig_height - (orig_height % 8) if orig_height % 8 != 0 else orig_height
                        else:
                            # 关闭参考Latent模式：保留千问原生缩放逻辑（有像素偏移）
                            total_vae = int(1024 * 1024)
                            scale_by_vae = math.sqrt(total_vae / (samples.shape[3] * samples.shape[2]))
                            width_vae = round(samples.shape[3] * scale_by_vae / 8.0) * 8
                            height_vae = round(samples.shape[2] * scale_by_vae / 8.0) * 8
                        
                        s_vae = comfy.utils.common_upscale(samples, width_vae, height_vae, "area", "disabled")
                        main_vae_latent = vae.encode(s_vae.movedim(1, -1)[:, :, :, :3])
                        
                        ref_latents.append(main_vae_latent)       
                        main_ref_latent = main_vae_latent.clone() 

                    image_prompt += "Picture {}: <|vision_start|><|image_pad|><|vision_end|>".format(i + 1)

        # ==============================================
        # 【正向条件编码（保留原生参考Latent逻辑）】
        # ==============================================
        tokens = clip.tokenize(image_prompt + positive_prompt, images=images_vl, llama_template=llama_template)
        positive_conditioning = clip.encode_from_tokens_scheduled(tokens)

        if reference_latent_mode and main_ref_latent is not None:
            # 清空原有参考数据
            positive_conditioning = node_helpers.conditioning_set_values(positive_conditioning, {
                "reference_latents": [],
                "image_strength": 0.0
            }, append=False)
            # 注入原生参考Latent完整条件
            positive_conditioning = node_helpers.conditioning_set_values(positive_conditioning, {
                "reference_latents": [main_ref_latent],
                "image_strength": 1.0,          
                "ref_image": image1,            
                "ref_mode": "reference_only",   
                "force_refresh": True           
            }, append=True)
        elif len(ref_latents) > 0:
            # 关闭参考模式：保留千问多图参考
            positive_conditioning = node_helpers.conditioning_set_values(positive_conditioning, {
                "reference_latents": ref_latents
            }, append=True)

        # ==============================================
        # 【负向条件编码（无修改）】
        # ==============================================
        if negative_switch:
            neg_tokens = clip.tokenize(negative_prompt, images=images_vl, llama_template=llama_template)
            negative_conditioning = clip.encode_from_tokens_scheduled(neg_tokens)
        else:
            empty_tokens = clip.tokenize("", images=images_vl, llama_template=llama_template)
            negative_conditioning = clip.encode_from_tokens_scheduled(empty_tokens)

        # ==============================================
        # 【Latent生成：分辨率1:1对齐】
        # ==============================================
        if image1 is not None and image_reference_switch:
            if main_latent_mode:
                if reference_latent_mode:
                    # 参考模式：使用原图分辨率的Latent
                    latent = main_ref_latent
                else:
                    # 普通模式：千问原生Latent（有偏移）
                    latent = vae.encode(image1[:, :, :, :3])
            else:
                # 仅尺寸空Latent：按原图分辨率计算
                bs = image1.shape[0]
                orig_h = image1.shape[1] // 8
                orig_w = image1.shape[2] // 8
                latent = torch.zeros([bs, 4, orig_h, orig_w], dtype=torch.float32, device=image1.device)
        else:
            # 无图/文生图：默认512x512
            latent = torch.zeros([1, 4, 64, 64], dtype=torch.float32)

        # 🔥 分辨率对齐：Latent输出严格标记原图分辨率
        if reference_latent_mode and main_ref_latent is not None:
            # 参考模式：输出分辨率=原图分辨率（8的倍数对齐）
            orig_width = image1.shape[2]
            orig_height = image1.shape[1]
            output_width = orig_width - (orig_width % 8) if orig_width % 8 != 0 else orig_width
            output_height = orig_height - (orig_height % 8) if orig_height % 8 != 0 else orig_height
            
            latent_output = {
                "samples": main_ref_latent,       
                "ref_latent": main_ref_latent,    
                "ref_image": image1,             
                "shape": main_ref_latent.shape,
                "batch_size": main_ref_latent.shape[0],
                "height": output_height,          
                "width": output_width,            
                "ref_latent_mode": True,          
                "force_next_add_noise": True,     
                "denoise": 1.0,                   
                "image_strength": 1.0             
            }
        else:
            # 普通模式：保留千问原生分辨率（有偏移）
            latent_output = {
                "samples": latent,
                "shape": latent.shape,
                "batch_size": latent.shape[0],
                "height": latent.shape[2] * 8,
                "width": latent.shape[3] * 8
            }

        return (positive_conditioning, negative_conditioning, latent_output)

# ==================== ComfyUI 节点映射（必须与__init__.py注册名一致） ====================
NODE_CLASS_MAPPINGS = {
    "JosiaEncoder": JosiaEncoder  # 英文标识：与__init__.py中的node_alias完全匹配
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaEncoder": "Josia文本编码"  # 中文显示名：与__init__.py中的display_name完全匹配
}
