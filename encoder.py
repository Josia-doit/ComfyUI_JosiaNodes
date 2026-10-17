"""
Josia 文本编码节点【稳定版】
功能：支持多图参考的CLIP/VAE编码，包含图生图/文生图切换、参考Latent条件、负向提示词开关等功能
本地文件名：encoder.py
节点英文标识：JosiaEncoder
节点中文显示名：Josia文本编码
依赖：torch、math、comfy.utils、node_helpers、comfy.model_management

说明：参考 Latent 注入不指定 method，与官方 ReferenceLatent 一致——每个模型
      走自己的原生默认参考方式（Klein/Flux2=index、Qwen-Image-Edit-2511=
      index_timestep_zero、Kontext=offset），互不干扰。
      编码模式（视觉塔开关 vision_tower_mode）：
        · 开启（默认）= Qwen 视觉塔模式：沿用硬编码 Qwen 图生图模板 + 视觉 token，
          适用于 Qwen-Image-Edit 系列（自带视觉塔，可在条件里混合图像信息）。
        · 关闭 = 标准文本模式：纯 clip.tokenize 文本编码、不注入视觉 token，
          适用于 FLUX.2 Kontext / Klein / Krea2 原生等无视觉塔模型——这类模型
          仅靠 reference_latents 接收多参考图，强行塞视觉 token 会污染文本条件。
      参考 Latent（reference_latents）注入与「图像参考模式」解耦：仅受「接了图 +
      reference_latent_mode 开启 + 接了 VAE」三条件约束。Klein / FLUX.2 等无视觉塔模型
      即便把「图像参考模式」设为文生图（采样器 Latent 留空），也照样靠 reference_latents
      把源图喂给模型 —— 这正是官方 Klein 编辑的标准用法（EmptyLatent + ReferenceLatent 链）。
      负向开关关闭时，负向条件严格归零：纯空文本 token，不带 images / llama_template，
      也不注入参考 Latent —— 与接了什么图、开了哪些开关、负向提示词写了什么都无关。
"""
import torch
import math
import comfy.utils
import node_helpers
import comfy.model_management

# 图生图模板（千问原生逻辑，与原生 TextEncodeQwenImageEditPlus 逐字一致）
QWEN_IMAGE_EDIT_TEMPLATE = "<|im_start|>system\nDescribe the key features of the input image (color, shape, size, texture, objects, background), then explain how the user's text instruction should alter or modify the image. Generate a new image that meets the user's requirements while maintaining consistency with the original input where appropriate.<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n"


class JosiaEncoder:
    CATEGORY = "⚡️JosiaNodes"
    DESCRIPTION = """🖊️ Josia 文本编码
支持文生图与图生图一体化 CLIP/VAE 编码，最多融合 10 张参考图。

• 图像接口：默认仅显示「图像1」，接入后自动展开「图像2」…依次最多 10 张
• 视觉塔编码模式：开启=Qwen视觉塔（默认，适用 Qwen-Image-Edit）；关闭=标准文本（适用 FLUX.2 Kontext / Klein / Krea2 原生等无视觉塔模型）
• 图像参考模式：开启=图生图模式（参考图同时作为采样器 Latent 起点）；关闭=文生图模式（采样器 Latent 留空）。视觉塔开启时视觉 token 与本开关无关、两种模式都注入（Qwen-Edit 系列必需）；开启「参考 Latent 模式」并接图+VAE 时参考图同样两种模式都注入——文生图 + 参考Latent 是 Klein 等无视觉塔模型的标准用法
• 参考 Latent 模式：开启时注入参考Latent条件，关闭时仅使用文本条件
• 负向提示词开关：关闭时自动将负向条件归零（纯空文本，不带任何图像信息）

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
        2. 有图像 + 文生图模式 → 原图尺寸空Latent；视觉塔开启时视觉token照常注入（与图像参考模式解耦），
           开参考Latent模式时参考图仍经 reference_latents 注入
        3. 有图像 + 图生图模式 + 参考Latent模式关闭 → VAE编码Latent，视觉token照常注入
        4. 有图像 + 图生图模式 + 参考Latent模式开启 → VAE编码Latent，带参考Latent条件
        """

        images = [image1, image2, image3, image4, image5, image6, image7, image8, image9, image10]
        use_image = any(img is not None for img in images)

        # ==============================================
        # 【视觉编码（可选，受视觉塔开关约束）】
        # 仅当 视觉塔模式开启 + 确实接图 时构建千问视觉 token，与「图像参考模式」
        # （图生图/文生图）解耦 —— 官方 TextEncodeQwenImageEditPlus 无论采样器
        # Latent 是源图编码还是空 Latent，都会注入视觉 token；Qwen-Edit 系列的
        # 训练分布中条件永远带视觉 token，缺了它参考Latent也会失效。
        # 视觉塔关闭（标准文本模式）/ 无图时一律纯文本，不传 llama_template / images
        # —— 否则模板文本或残留视觉 token 会污染无视觉塔模型（Flux/Klein）的条件。
        # ==============================================
        build_vision = bool(vision_tower_mode and use_image)
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
        # 【参考 Latent 列表（与「图像参考模式」解耦）】
        # 所有已接图像统一 VAE 编码成 reference_latents，仅受三条件约束：是否接图、
        # 是否接 VAE、以及 reference_latent_mode 是否开启 —— 与「图像参考模式」
        # （图生图/文生图）无关。这样 Klein 类无视觉塔模型即便把采样器 Latent 留空
        # （文生图模式），也能只靠 reference_latents 把源图喂给模型（参考生成）；
        # Qwen 类多图参考走同一份列表，视觉 token 与 reference_latents 并存不冲突。
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
        # 【参考 Latent 条件注入】
        # ref_latents 为 None 时（未接图 / 未接 VAE / 参考Latent模式关闭）整段跳过，
        # 正向条件保持纯文本；与图像参考模式（图生图/文生图）无关。
        # 不写 reference_latents_method：与官方 ReferenceLatent 一致，让每个模型
        # 走自己的原生默认（Klein/Flux2=index、Qwen-2511=index_timestep_zero、
        # Kontext=offset），显式写死会覆盖模型原生方式并导致参考失效。
        # ==============================================
        if reference_latent_mode and ref_latents is not None:
            positive_conditioning = node_helpers.conditioning_set_values(positive_conditioning, {
                "reference_latents": ref_latents
            }, append=True)

        # ==============================================
        # 【负向条件编码】
        #   负向开关开启：负向=负向提示词，视觉 token 由 build_vision 决定，
        #                 参考 Latent 注入与正向一致。
        #   负向开关关闭：负向严格归零 —— 与开了什么开关、接了什么图、负向提示词
        #                 写了什么都无关，纯空文本 token，不留任何图像痕迹。
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
        else:
            # 归零就是归零：严格等价于「什么都没接」的原生 CLIP 文本编码器 —— 纯空文本
            # token，不带 images / llama_template。不因 build_vision、接了什么图、
            # 开了哪些开关而带出任何残留视觉信息，参考 Latent 也不注入。
            negative_conditioning = clip.encode_from_tokens_scheduled(clip.tokenize(""))

        return (positive_conditioning, negative_conditioning, latent_output)


# ==================== ComfyUI 节点映射 ====================
NODE_CLASS_MAPPINGS = {
    "JosiaEncoder": JosiaEncoder
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaEncoder": "Josia文本编码"
}
