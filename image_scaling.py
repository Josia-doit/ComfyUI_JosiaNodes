"""
Josia 图像缩放节点
功能：
1. 单一「选择比例」下拉：默认关；含 1:1 / 2:3 / 3:2 / 3:4 / 4:3 / 9:16 / 16:9 / 21:9 等比例
   - 选定比例且下方未开启任何缩放模式 → 按接入图片分辨率适配新比例，多余部分中心裁切
   - 下方开启缩放模式（像素/边长/手动）→ 缩放模式优先生效，比例仅作提示
2. 多维度缩放控制：边长缩放/像素缩放/手动宽高缩放
3. 渐进式缩放（低分辨率优化）、分辨率上限限制、锁定倍数对齐
4. 多裁剪方式、多缩放算法（BOX/BICUBIC等）
5. 支持图像/遮罩输入输出，批量处理，输出宽度和高度数值
6. 允许空挂（不接图像）→ 输出空白图片；不接输出图片时可作为分辨率选择器提供宽高
本地文件名：image_scaling.py
节点英文标识：JosiaImageScaling
节点中文显示名：Josia图像缩放
依赖：torch、numpy、PIL.Image、math、gc
"""
import torch
import numpy as np
from PIL import Image
import math
import gc

# 导入常量配置（外部化参数，便于维护）
from node_properties import (
    NODE_CATEGORY, RATIO_OPTIONS, RATIO_ASPECT, LOCK_MULTIPLE_CHOICES,
    CROP_METHODS, RESAMPLE_FILTERS, DEFAULT_PARAMS, NODE_DISPLAY_NAME_SCALING,
    IMAGE_SCALING_DESCRIPTION
)

_NODE = "JosiaImageScaling"

class JosiaImageScaling:
    """📐 Josia 图像缩放
多功能图像缩放裁切节点，支持「选择比例」与 3 种自定义缩放模式。

• 🔁 选择比例：单一下拉（默认关），含 1:1 / 2:3 / 3:2 / 3:4 / 4:3 / 9:16 / 16:9 / 21:9 等
       未开启任何缩放模式时，按接入图片分辨率适配新比例，多余部分中心裁切
• 🖼️ 像素缩放：按百万像素目标自动计算尺寸（最高优先级）
• ✏️ 手动宽高：直接指定宽高，支持一键切换宽高
• 📏 边长缩放：按最长边 / 最短边缩放至指定像素

⚙️ 高级特性：锁定倍数 / 多种裁剪方式 / 5 种缩放算法 / 分辨率保护
❗ 不设置任何尺寸时，图像原封不动透传；无图像输入时输出空白图片，
   不接输出图片时可作为分辨率选择器提供宽高数值用于文生图"""

    DESCRIPTION = IMAGE_SCALING_DESCRIPTION
    CATEGORY = NODE_CATEGORY
    FUNCTION = "process_image"  # 核心执行函数名
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT")  # 输出类型
    RETURN_NAMES = ("图像", "遮罩", "宽度", "高度")  # 输出端口名称

    @classmethod
    def INPUT_TYPES(cls):
        """定义节点界面参数（选择比例 + 多维度缩放控制）"""
        return {
            "required": {
                # 1. 选择比例（单一下拉，默认关）
                "选择比例": (RATIO_OPTIONS, {"default": "关"}),

                # 2. 基础控制参数
                "锁定倍数": (LOCK_MULTIPLE_CHOICES, {"default": DEFAULT_PARAMS["lock_multiple"]}),
                "裁剪方式": (CROP_METHODS, {"default": CROP_METHODS[0]}),
                "缩放算法": (list(RESAMPLE_FILTERS.keys()), {"default": DEFAULT_PARAMS["default_resample_algo"]}),

                # 3. 边长缩放（带开关符号 📏）
                "📏 启用边长缩放": ("BOOLEAN", {"default": False, "label_on": "true", "label_off": "false"}),
                "缩放至边": (["最长边", "最短边"], {"default": "最长边"}),
                "缩放长度": ("INT", {
                    "default": DEFAULT_PARAMS["scale_length"],
                    "min": DEFAULT_PARAMS["min_scale_length"],
                    "max": DEFAULT_PARAMS["max_scale_length"],
                    "step": 1
                }),

                # 4. 像素缩放（带开关符号 🖼️）
                "🖼️ 启用像素缩放": ("BOOLEAN", {"default": False, "label_on": "true", "label_off": "false"}),
                "像素数量（百万）": ("FLOAT", {
                    "default": DEFAULT_PARAMS["pixel_million"],
                    "min": DEFAULT_PARAMS["min_pixel_million"],
                    "max": DEFAULT_PARAMS["max_pixel_million"],
                    "step": 0.01
                }),
                "分辨率步数": ("INT", {
                    "default": DEFAULT_PARAMS["resolution_steps"],
                    "min": DEFAULT_PARAMS["min_steps"],
                    "max": DEFAULT_PARAMS["max_steps"],
                    "step": 1
                }),

                # 5. 手动宽高（带开关符号 ✏️/🔄）
                "✏️ 启用手动宽高": ("BOOLEAN", {"default": False, "label_on": "true", "label_off": "false"}),
                "🔄 切换宽高": ("BOOLEAN", {
                    "default": DEFAULT_PARAMS["swap_wh"],
                    "label_on": "开启（宽↔高）",
                    "label_off": "关闭（原尺寸）"
                }),
                "宽度": ("INT", {
                    "default": DEFAULT_PARAMS["manual_width"],
                    "min": DEFAULT_PARAMS["min_manual_size"],
                    "max": DEFAULT_PARAMS["max_manual_size"],
                    "step": 1
                }),
                "高度": ("INT", {
                    "default": DEFAULT_PARAMS["manual_height"],
                    "min": DEFAULT_PARAMS["min_manual_size"],
                    "max": DEFAULT_PARAMS["max_manual_size"],
                    "step": 1
                }),
            },
            "optional": {
                "图像": ("IMAGE",),    # 可选图像输入（允许空挂）
                "遮罩": ("MASK",),      # 可选遮罩输入
            }
        }

    def _check_resolution_limit(self, width, height):
        """
        分辨率上限检查：超过最大像素数时自动缩放
        :param width: 目标宽度
        :param height: 目标高度
        :return: 调整后的宽高（符合最大像素限制）
        """
        total_pixels = width * height
        max_pixels = DEFAULT_PARAMS["max_total_pixels"]
        if total_pixels > max_pixels:
            scale_ratio = math.sqrt(max_pixels / total_pixels)
            new_w = int(width * scale_ratio)
            new_h = int(height * scale_ratio)
            lock_mult = int(DEFAULT_PARAMS["lock_multiple"]) if DEFAULT_PARAMS["lock_multiple"] != "关" else 8
            new_w = (new_w // lock_mult) * lock_mult
            new_h = (new_h // lock_mult) * lock_mult
            print(f"⚠️ 分辨率超限，自动缩放到{new_w}×{new_h}")
            return new_w, new_h
        return width, height

    def process_image(self, 图像=None, 遮罩=None, **kwargs):
        """
        核心图像缩放处理函数
        :param 图像: 输入图像张量（可选）
        :param 遮罩: 输入遮罩张量（可选）
        :param kwargs: 节点界面参数
        :return: (处理后图像, 处理后遮罩, 最终宽度, 最终高度)
        """
        # 1. 提取界面参数
        ratio_choice = kwargs.get("选择比例", "关")

        lock_multiple_str = kwargs.get("锁定倍数", DEFAULT_PARAMS["lock_multiple"])
        lock_multiple = 1 if lock_multiple_str == "关" else int(lock_multiple_str)

        crop_method = kwargs.get("裁剪方式", CROP_METHODS[0])
        resample_algo = kwargs.get("缩放算法", DEFAULT_PARAMS["default_resample_algo"])

        # 带符号的开关参数
        enable_side_scale = kwargs.get("📏 启用边长缩放", False)
        side_to_scale = kwargs.get("缩放至边", "最长边")
        side_length = kwargs.get("缩放长度", DEFAULT_PARAMS["scale_length"])

        enable_pixel_scale = kwargs.get("🖼️ 启用像素缩放", False)
        pixel_million = kwargs.get("像素数量（百万）", DEFAULT_PARAMS["pixel_million"])
        resolution_steps = kwargs.get("分辨率步数", DEFAULT_PARAMS["resolution_steps"])

        enable_manual_size = kwargs.get("✏️ 启用手动宽高", False)
        swap_wh = kwargs.get("🔄 切换宽高", DEFAULT_PARAMS["swap_wh"])
        manual_width = kwargs.get("宽度", DEFAULT_PARAMS["manual_width"])
        manual_height = kwargs.get("高度", DEFAULT_PARAMS["manual_height"])

        # 2. 切换宽高处理
        if swap_wh:
            manual_width, manual_height = manual_height, manual_width

        # 3. 获取原始尺寸（仅来自图像输入，无图像时使用默认值）
        if 图像 is not None:
            orig_h, orig_w = 图像.shape[1], 图像.shape[2]
        else:
            orig_w = DEFAULT_PARAMS["default_base_width"]
            orig_h = DEFAULT_PARAMS["default_base_height"]

        # 4. 参数优先级控制（像素缩放 > 手动宽高 > 边长缩放 > 选择比例）
        #    任一下方缩放模式开启时，比例仅作提示、不参与尺寸计算
        ratio_enabled = (ratio_choice != "关")
        any_scale_mode = enable_pixel_scale or enable_manual_size or enable_side_scale
        if any_scale_mode:
            ratio_enabled = False

        # 5. 计算目标尺寸
        target_w, target_h = self._calculate_target_size(
            orig_w, orig_h, ratio_choice, ratio_enabled,
            enable_side_scale, side_to_scale, side_length,
            enable_pixel_scale, pixel_million, lock_multiple,
            enable_manual_size, manual_width, manual_height
        )

        # 6. 应用锁定倍数和分辨率限制
        final_w = (target_w // lock_multiple) * lock_multiple if lock_multiple > 1 else target_w
        final_h = (target_h // lock_multiple) * lock_multiple if lock_multiple > 1 else target_h
        final_w, final_h = max(32, final_w), max(32, final_h)  # 最小尺寸限制
        final_w, final_h = self._check_resolution_limit(final_w, final_h)

        # 比例模式（未开启缩放模式）下强制使用中心裁切（用户要求：多余部分中心裁切）
        effective_crop = "中心裁剪" if (ratio_enabled and not any_scale_mode) else crop_method

        # 7. 处理图像（批量处理）；无图像时输出空白图片
        if 图像 is not None:
            batch_size = 图像.shape[0]
            processed_images = []
            processed_masks = []

            for batch_idx in range(batch_size):
                # 张量转PIL图像
                img_tensor = 图像[batch_idx].cpu().numpy()
                img_pil = Image.fromarray((img_tensor * 255).astype(np.uint8))
                mask_pil = None
                if 遮罩 is not None and batch_idx < 遮罩.shape[0]:
                    mask_tensor = 遮罩[batch_idx].cpu().numpy()
                    mask_pil = Image.fromarray((mask_tensor * 255).astype(np.uint8), mode="L")

                # 选择缩放方式（渐进式/单步）
                resample = RESAMPLE_FILTERS.get(resample_algo, Image.Resampling.BOX)
                if enable_manual_size:
                    img_pil, mask_pil = self._apply_crop_or_stretch(img_pil, mask_pil, final_w, final_h, effective_crop, resample)
                else:
                    if resolution_steps > 1 and (final_w * final_h) < 2_000_000:
                        img_pil, mask_pil = self._progressive_scale(img_pil, mask_pil, final_w, final_h, resolution_steps, resample_algo, effective_crop)
                    else:
                        img_pil, mask_pil = self._single_scale(img_pil, mask_pil, final_w, final_h, resample_algo, effective_crop)

                # PIL转张量
                img_array = np.array(img_pil).astype(np.float32) / 255.0
                processed_images.append(torch.from_numpy(img_array))
                if mask_pil is not None:
                    mask_array = np.array(mask_pil).astype(np.float32) / 255.0
                    processed_masks.append(torch.from_numpy(mask_array))

                # 释放临时内存
                del img_tensor, img_pil, mask_pil
                gc.collect()

            # 拼接批量结果
            img_result = torch.stack(processed_images)
            mask_result = torch.stack(processed_masks) if processed_masks else torch.zeros((img_result.shape[0], final_h, final_w), dtype=torch.float32)
            del processed_images, processed_masks
            gc.collect()
        else:
            # 允许空挂：无输入图像时输出一张目标尺寸的空白图片（黑底）
            img_result = torch.zeros((1, final_h, final_w, 3), dtype=torch.float32)
            mask_result = torch.zeros((1, final_h, final_w), dtype=torch.float32)

        # 8. 最终内存释放
        gc.collect()

        return (img_result, mask_result, final_w, final_h)

    def _calculate_target_size(self, orig_w, orig_h, ratio_choice, ratio_enabled,
                              enable_side, side_type, side_len, enable_pixel, pixel_mill, lock_mult,
                              enable_manual, manual_w, manual_h):
        """
        计算目标尺寸（根据不同缩放模式）
        优先级：像素缩放 > 手动宽高 > 边长缩放 > 选择比例（按接入图分辨率适配新比例）> 原图透传
        :return: (目标宽度, 目标高度)
        """
        # 像素缩放模式
        if enable_pixel:
            total_pixels = pixel_mill * 1_000_000
            # 使用原始图像的宽高比计算目标尺寸
            aspect_ratio = orig_w / orig_h if orig_h > 0 else 1.0
            # 根据总像素和宽高比计算目标宽高
            # 总像素 = w * h, 宽高比 = w / h
            # 因此: w * (w / aspect_ratio) = total_pixels
            # w^2 = total_pixels * aspect_ratio
            target_w = math.sqrt(total_pixels * aspect_ratio)
            target_h = target_w / aspect_ratio
            target_w, target_h = int(round(target_w)), int(round(target_h))
            if lock_mult > 1:
                target_w = (target_w // lock_mult) * lock_mult
                target_h = (target_h // lock_mult) * lock_mult
            return (max(32, target_w), max(32, target_h))

        # 手动宽高模式
        if enable_manual:
            target_w = manual_w
            target_h = manual_h
            if lock_mult > 1:
                target_w = (target_w // lock_mult) * lock_mult
                target_h = (target_h // lock_mult) * lock_mult
            return (max(32, target_w), max(32, target_h))

        # 边长缩放模式
        if enable_side:
            # 根据选择的最长边或最短边进行缩放
            if orig_w > 0 and orig_h > 0:
                orig_max = max(orig_w, orig_h)
                orig_min = min(orig_w, orig_h)
                # 计算缩放比例：目标边长 / 原始对应边长
                if side_type == "最长边":
                    scale = side_len / orig_max
                else:  # 最短边
                    scale = side_len / orig_min
                # 应用等比例缩放
                target_w = int(orig_w * scale)
                target_h = int(orig_h * scale)
            else:
                # 无有效原始尺寸时，使用目标边长作为正方形
                target_w = target_h = side_len
            
            if lock_mult > 1:
                target_w = (target_w // lock_mult) * lock_mult
                target_h = (target_h // lock_mult) * lock_mult
            return (max(32, target_w), max(32, target_h))

        # 选择比例模式：按接入图片分辨率（像素面积）适配新比例，多余部分由调用方中心裁切
        if ratio_enabled and ratio_choice in RATIO_ASPECT:
            aspect = RATIO_ASPECT[ratio_choice]
            area = max(1, orig_w) * max(1, orig_h)
            # area = w * h，w = aspect * h  ⇒  h = sqrt(area / aspect)，w = h * aspect
            target_h = int(round(math.sqrt(area / aspect)))
            target_w = int(round(target_h * aspect))
            if lock_mult > 1:
                target_w = (target_w // lock_mult) * lock_mult
                target_h = (target_h // lock_mult) * lock_mult
            return (max(32, target_w), max(32, target_h))

        # 默认返回原始尺寸（无任何尺寸设置时，原封不动透传）
        # 不对齐锁定倍数，保持原图尺寸完全一致
        return (max(32, orig_w), max(32, orig_h))

    def _progressive_scale(self, img_pil, mask_pil, target_w, target_h, steps, algo, crop_method):
        """
        渐进式缩放（低分辨率优化）
        :return: (缩放后图像, 缩放后遮罩)
        """
        orig_w, orig_h = img_pil.size
        current_img, current_mask = img_pil, mask_pil
        resample = RESAMPLE_FILTERS.get(algo, Image.Resampling.BOX)

        for step in range(1, steps + 1):
            ratio = step / steps
            step_w = int(orig_w + (target_w - orig_w) * ratio)
            step_h = int(orig_h + (target_h - orig_h) * ratio)
            if step == steps:
                step_w, step_h = target_w, target_h

            current_img, current_mask = self._apply_crop_or_stretch(
                current_img, current_mask, step_w, step_h,
                "拉伸缩放" if step < steps else crop_method, resample
            )
            gc.collect()
            
        return current_img, current_mask

    def _single_scale(self, img_pil, mask_pil, target_w, target_h, algo, crop_method):
        """
        单步缩放（常规模式）
        :return: (缩放后图像, 缩放后遮罩)
        """
        resample = RESAMPLE_FILTERS.get(algo, Image.Resampling.BOX)
        return self._apply_crop_or_stretch(img_pil, mask_pil, target_w, target_h, crop_method, resample)

    def _apply_crop_or_stretch(self, img, mask, target_w, target_h, method, resample):
        """
        裁切/拉伸缩放核心逻辑
        :param method: 裁剪方式（拉伸缩放/居中/左/右/上/下）
        :return: (处理后图像, 处理后遮罩)
        """
        orig_w, orig_h = img.size
        orig_aspect = orig_w / orig_h
        target_aspect = target_w / target_h

        temp_img = None
        temp_mask = None

        # 拉伸缩放（不保持比例）
        if method == "拉伸缩放":
            new_img = img.resize((target_w, target_h), resample)
            new_mask = mask.resize((target_w, target_h), resample) if mask is not None else None

        # 宽高比大于目标：水平裁剪
        elif orig_aspect > target_aspect:
            temp_h = target_h
            temp_w = int(temp_h * orig_aspect)
            temp_img = img.resize((temp_w, temp_h), resample)
            temp_mask = mask.resize((temp_w, temp_h), resample) if mask is not None else None

            # 确定裁剪左边界
            if method == "对齐左边":
                left = 0
            elif method == "对齐右边":
                left = temp_w - target_w
            else:  # 居中
                left = (temp_w - target_w) // 2

            new_img = temp_img.crop((left, 0, left + target_w, target_h))
            new_mask = temp_mask.crop((left, 0, left + target_w, target_h)) if temp_mask is not None else None

        # 宽高比小于目标：垂直裁剪
        elif orig_aspect < target_aspect:
            temp_w = target_w
            temp_h = int(temp_w / orig_aspect)
            temp_img = img.resize((temp_w, temp_h), resample)
            temp_mask = mask.resize((temp_w, temp_h), resample) if mask is not None else None

            # 确定裁剪上边界
            if method == "对齐上边":
                top = 0
            elif method == "对齐下边":
                top = temp_h - target_h
            else:  # 居中
                top = (temp_h - target_h) // 2

            new_img = temp_img.crop((0, top, target_w, top + target_h))
            new_mask = temp_mask.crop((0, top, target_w, top + target_h)) if temp_mask is not None else None

        # 宽高比一致：直接缩放
        else:
            new_img = img.resize((target_w, target_h), resample)
            new_mask = mask.resize((target_w, target_h), resample) if mask is not None else None

        # 释放临时变量
        if temp_img is not None:
            del temp_img
        if temp_mask is not None:
            del temp_mask
        del img, mask
        gc.collect()
        
        return new_img, new_mask

# ==================== ComfyUI 节点映射（与__init__.py注册名严格一致） ====================
NODE_CLASS_MAPPINGS = {
    "JosiaImageScaling": JosiaImageScaling  # 英文标识：与__init__.py中的node_alias完全匹配
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaImageScaling": "Josia图像缩放"  # 中文显示名：与__init__.py中的display_name完全匹配
}
