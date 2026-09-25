"""
Josia 文本编码节点【稳定版】
功能：支持多图参考的CLIP/VAE编码，包含图生图/文生图切换、参考Latent条件、负向提示词开关等功能
本地文件名：encoder.py
节点英文标识：JosiaEncoder
节点中文显示名：Josia文本编码
依赖：torch、math、comfy.utils、node_helpers、comfy.model_management

说明：参考 Latent 方法内部固定为 index_timestep_zero（Flux/Krea2 必需，且为
      Qwen-Image-Edit-2511 的原生默认 ref method，适配单图编辑强参考、避免像素偏移），
      不暴露 UI。
      编码模式（视觉塔开关 vision_tower_mode）：
        · 开启（默认）= Qwen 视觉塔模式：沿用硬编码 Qwen 图生图模板 + 视觉 token，
          适用于 Qwen-Image-Edit 系列（自带视觉塔，可在条件里混合图像信息）。
        · 关闭 = 标准文本模式：纯 clip.tokenize 文本编码、不注入视觉 token，
          适用于 FLUX.2 Kontext / Klein / Krea2 原生等无视觉塔模型——这类模型
          仅靠 reference_latents 接收多参考图，强行塞视觉 token 会污染文本条件。
      参考 Latent（reference_latents）注入与编码模式解耦：两种模式都按 reference_latent_mode
      注入，便于 Klein 类在「采样器 Latent 留空」时仍靠 reference_latents 提供图像。
"""
import torch
import math
import comfy.utils
import node_helpers
import comfy.model_management

# Flux Kontext 多参考 Latent 使用的 method（内部固定，不暴露 UI）。
# 四个原生选项 offset / index / uxo/uno / index_timestep_zero 中，仅
# index_timestep_zero 在主流多参考工作流中最稳妥常用；其余选项易出错，暂不暴露给用户。
REFERENCE_LATENTS_METHOD = "index_timestep_zero"

# 图生图模板（千问原生逻辑，与原生 TextEncodeQwenImageEditPlus 逐字一致）
QWEN_IMAGE_EDIT_TEMPLATE = "<|im_start|>system\nDescribe the key features of the input image (color, shape, size, texture, objects, background), then explain how the user's text instruction should alter or modify the image. Generate a new image that meets the user's requirements while maintaining consistency with the original input where appropriate.<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n"


class JosiaEncoder:
    CATEGORY = "⚡️JosiaNodes"
    DESCRIPTION = """🖊️ Josia 文本编码
支持文生图与图生图一体化 CLIP/VAE 编码，最多融合 10 张参考图。

• 图像接口：默认仅显示「图像1」，接入后自动展开「图像2」…依次最多 10 张
• 视觉塔编码模式：开启=Qwen视觉塔（默认，适用 Qwen-Image-Edit）；关闭=标准文本（适用 FLUX.2 Kontext / Klein / Krea2 原生等无视觉塔模型）
• 图像参考模式：开启时参考图像生成Latent，关闭时输出空Latent
• 负向提示词开关：关闭时自动将负向条件归零
• 参考 Latent 模式：开启时注入参考Latent条件，关闭时仅使用文本条件

输出：正向条件 / 负向条件 / Latent"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {"display_name": "CLIP"}),
                "vision_tower_mode": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ Qwen视觉塔",
                    "label_off": "❎ 标准文本(Flux/Krea2/Klein)",
                    "display_name": "视觉塔编码模式"
                }),
                "image_reference_switch": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ 图生图模式",
                    "label_off": "❎ 文生图模式",
                    "display_name": "图像参考模式"
                }),
                "reference_latent_mode": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ 参考Latent条件",
                    "label_off": "❎ 标准VAE编码",
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
                    "label_off": "❎ 负向提示词条件归零",
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
                # 图像接口：name 必须是后端 kwarg 键 image1..image10（执行层按名取参），不可改成中文。
                # 中文展示走 renderer 的 localized_name：后端这里声明的 display_name 会在
                # 「节点重建」时被官方建节点代码换算成 localized_name（两者都是显示层，不影响执行）。
                # 前端运行期动态 addInput 不走这条换算链路，须自行传 {localized_name:"图像N"}。
                "image1": ("IMAGE", {"display_name": "图像1"}),
                "image2": ("IMAGE", {"display_name": "图像2"}),
                "image3": ("IMAGE", {"display_name": "图像3"}),
                "image4": ("IMAGE", {"display_name": "图像4"}),
                "image5": ("IMAGE", {"display_name": "图像5"}),
                "image6": ("IMAGE", {"display_name": "图像6"}),
                "image7": ("IMAGE", {"display_name": "图像7"}),
                "image8": ("IMAGE", {"display_name": "图像8"}),
                "image9": ("IMAGE", {"display_name": "图像9"}),
                "image10": ("IMAGE", {"display_name": "图像10"}),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "负向条件", "Latent")
    FUNCTION = "encode"

    def encode(self, clip, vision_tower_mode, image_reference_switch, reference_latent_mode,
               positive_prompt, negative_switch, negative_prompt, vae=None,
               image1=None, image2=None, image3=None, image4=None, image5=None,
               image6=None, image7=None, image8=None, image9=None, image10=None):
        """
        核心编码逻辑

        四种情况：
        1. 无图像输入 → 1024x1024空Latent，纯文本条件
        2. 有图像 + 开关1关闭 → 原图尺寸空Latent，纯文本条件
        3. 有图像 + 开关1开 + 开关2关 → VAE编码Latent，纯文本条件（图生图）
        4. 有图像 + 开关1开 + 开关2开 → VAE编码Latent，参考Latent条件（参考图生图）
        """

        images = [image1, image2, image3, image4, image5, image6, image7, image8, image9, image10]
        use_image = any(img is not None for img in images)

        # ==============================================
        # 【视觉编码（可选，受视觉塔开关约束）】
        # 仅当 视觉塔模式开启 + 图生图开关开启 + 确实接图 三者同时满足，才构建千问
        # 视觉 token；其余情况（标准文本模式 / 文生图 / 无图）一律纯文本，
        # 不传 llama_template / images —— 否则模板文本或残留视觉 token 会被编进条件，
        # 导致无视觉塔模型（Flux/Krea2/Klein）生成乱码或图像理解失败。
        # ==============================================
        build_vision = bool(vision_tower_mode and image_reference_switch and use_image)
        images_vl = []
        image_prompt = ""
        if build_vision:
            llama_template = QWEN_IMAGE_EDIT_TEMPLATE
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
        # 【参考 Latent 列表（与编码模式解耦）】
        # 所有已接图像统一 VAE 编码成 reference_latents，仅受 reference_latent_mode、
        # 是否接图、是否接 VAE 约束 —— 与「视觉塔开关」「图生图开关」均无关。
        #   · Klein 类（无视觉塔）即便把「采样器 Latent」留空（文生图模式），
        #     也能仅靠 reference_latents 把图像喂给模型（参考生成）；
        #   · Qwen 类多图参考走同一份列表，视觉 token 与 reference_latents 并存不冲突。
        # ==============================================
        ref_latents = None
        if use_image and reference_latent_mode and vae is not None:
            ref_latents = []
            for img in images:
                if img is not None:
                    ref_latents.append(vae.encode(img[:, :, :, :3]))

        # ==============================================
        # 【采样器 Latent（图生图开关控制）】
        #   无图 / 文生图 → 空 Latent（文生图按原图尺寸；无图固定 1024）；
        #   图生图       → image1 单图 VAE 编码（复刻原生 VAEEncode）。
        # 图生图时 image1 既作采样器 Latent 又作 reference_latents[0]，这是
        # FLUX Kontext / Qwen 编辑的标准「源图即噪声起点且作参考」形态。
        # ==============================================
        if not use_image:
            latent = torch.zeros([1, 4, 128, 128],
                                device=comfy.model_management.intermediate_device(),
                                dtype=comfy.model_management.intermediate_dtype())
            latent_output = {"samples": latent, "downscale_ratio_spacial": 8}
        elif not image_reference_switch:
            pixel_width = image1.shape[2]
            pixel_height = image1.shape[1]
            batch_size = image1.shape[0]
            width = (pixel_width // 8) * 8
            height = (pixel_height // 8) * 8
            latent = torch.zeros([batch_size, 4, height // 8, width // 8],
                                device=comfy.model_management.intermediate_device(),
                                dtype=comfy.model_management.intermediate_dtype())
            latent_output = {"samples": latent, "downscale_ratio_spacial": 8}
        else:
            if vae is not None:
                latent_output = {"samples": vae.encode(image1[:, :, :, :3])}
            else:
                pixel_width = image1.shape[2]
                pixel_height = image1.shape[1]
                batch_size = image1.shape[0]
                width = (pixel_width // 8) * 8
                height = (pixel_height // 8) * 8
                latent = torch.zeros([batch_size, 4, height // 8, width // 8],
                                    device=comfy.model_management.intermediate_device(),
                                    dtype=comfy.model_management.intermediate_dtype())
                latent_output = {"samples": latent, "downscale_ratio_spacial": 8}

        # ==============================================
        # 【正向条件编码】
        #   build_vision=True  → 千问 llama_template + 视觉 token（Qwen 视觉塔模式）；
        #   build_vision=False → 纯 clip.tokenize(提示词)（标准文本模式）。
        # ==============================================
        if build_vision:
            tokens = clip.tokenize(image_prompt + positive_prompt, images=images_vl, llama_template=llama_template)
        else:
            tokens = clip.tokenize(positive_prompt)
        positive_conditioning = clip.encode_from_tokens_scheduled(tokens)

        # ==============================================
        # 【参考 Latent 条件注入（与视觉塔模式解耦）】
        # 只要开了 reference_latent_mode 且确实编码出 ref_latents 就注入，两种编码
        # 模式通用：Qwen 多图参考 / Klein 仅靠 reference_latents 提供图像。
        # reference_latents_method 内部固定 index_timestep_zero（不暴露 UI）。
        # ==============================================
        if reference_latent_mode and ref_latents is not None:
            positive_conditioning = node_helpers.conditioning_set_values(positive_conditioning, {
                "reference_latents": ref_latents
            }, append=True)
            positive_conditioning = node_helpers.conditioning_set_values(positive_conditioning, {
                "reference_latents_method": REFERENCE_LATENTS_METHOD
            })

        # ==============================================
        # 【负向条件编码】
        #   负向开关开启：负向=负向提示词（是否带视觉 token 由 build_vision 决定）；
        #   负向开关关闭：负向归零（空文本，视觉 token 跟随 build_vision）。
        #   参考 Latent 注入（仅负向开启时）与正向一致。
        # ==============================================
        if negative_switch:
            if build_vision:
                neg_tokens = clip.tokenize(negative_prompt, images=images_vl, llama_template=llama_template)
            else:
                neg_tokens = clip.tokenize(negative_prompt)
            negative_conditioning = clip.encode_from_tokens_scheduled(neg_tokens)
            if reference_latent_mode and ref_latents is not None:
                negative_conditioning = node_helpers.conditioning_set_values(negative_conditioning, {
                    "reference_latents": ref_latents
                }, append=True)
                negative_conditioning = node_helpers.conditioning_set_values(negative_conditioning, {
                    "reference_latents_method": REFERENCE_LATENTS_METHOD
                })
        else:
            if build_vision:
                empty_tokens = clip.tokenize("", images=images_vl, llama_template=llama_template)
            else:
                empty_tokens = clip.tokenize("")
            negative_conditioning = clip.encode_from_tokens_scheduled(empty_tokens)

        return (positive_conditioning, negative_conditioning, latent_output)


# ==================== ComfyUI 节点映射 ====================
NODE_CLASS_MAPPINGS = {
    "JosiaEncoder": JosiaEncoder
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaEncoder": "Josia文本编码"
}
