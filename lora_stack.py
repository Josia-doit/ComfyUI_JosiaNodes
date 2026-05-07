"""
Josia LoRA Stack - LoRA堆叠节点核心文件
功能：
1. 支持1-10组LoRA的顺序堆叠应用；
2. 总控开关控制所有LoRA是否生效；
3. CPU内存/显存加载模式切换；
4. 每组LoRA独立启用/禁用、模型强度与CLIP强度控制；
5. 所有交互逻辑由前端 lora_stack.js 实现，Python端负责LoRA加载与执行。
本地文件名：lora_stack.py
节点英文标识：JosiaLoraStack
节点中文显示名：JosiaLoRA堆叠
"""
import os
import folder_paths
import comfy.utils
import comfy.sd
import comfy.model_management

# 导入节点描述常量（与其他Josia节点保持相同规范）
from node_properties import LORA_STACK_DESCRIPTION

# 最大LoRA组数
MAX_LORA_GROUPS = 10


class JosiaLoraStack:
    """🎛️ Josia LoRA 堆叠
    支持 1-10 组 LoRA 的顺序堆叠应用，精准控制模型/CLIP强度。
    
    • 总控开关：关闭时 model/CLIP 原样透传，开启时应用LoRA
    • 内存加载：将LoRA加载到内存而非显存，适合显存紧张场景
    • 独立控制：每组LoRA可独立启用/禁用、调节模型及CLIP强度
    • 动态数量：通过增减控制活跃LoRA组数，隐藏组保留设置"""

    DESCRIPTION = LORA_STACK_DESCRIPTION

    CATEGORY = "Josia"
    FUNCTION = "apply_loras"
    
    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("模型", "CLIP")

    @classmethod
    def INPUT_TYPES(cls):
        """定义节点输入参数"""
        # 获取可用LoRA列表
        try:
            lora_list = folder_paths.get_filename_list("loras")
            lora_list = ["None"] + list(lora_list)
        except Exception:
            lora_list = ["None"]

        required = {
            # 核心输入
            "model": ("MODEL", {"display_name": "模型"}),
            
            # 总控与内存开关
            "total_switch": ("BOOLEAN", {
                "default": True,
                "label": "总控开关",
                "label_on": "开启",
                "label_off": "关闭",
                "display_name": "总控开关",
            }),
            "cpu_offload": ("BOOLEAN", {
                "default": False,
                "label": "加载模式",
                "label_on": "内存加载",
                "label_off": "显存加载",
                "display_name": "加载模式",
            }),
            
            # LoRA数量
            "lora_count": ("INT", {
                "default": 1,
                "min": 1,
                "max": MAX_LORA_GROUPS,
                "step": 1,
            }),
        }

        # 动态生成 MAX_LORA_GROUPS 组 LoRA 参数
        for i in range(1, MAX_LORA_GROUPS + 1):
            required[f"lora_name_{i}"] = (lora_list, {
                "default": "None",
                "display_name": f"LoRA {i}",
            })
            required[f"lora_switch_{i}"] = ("BOOLEAN", {
                "default": True,
                "label_on": "开",
                "label_off": "关",
                "display_name": f"LoRA{i}开关",
            })
            required[f"strength_model_{i}"] = ("FLOAT", {
                "default": 0.8,
                "min": -10.0,
                "max": 10.0,
                "step": 0.01,
            })
            required[f"strength_clip_{i}"] = ("FLOAT", {
                "default": 0.0,
                "min": -10.0,
                "max": 10.0,
                "step": 0.01,
            })

        return {
            "required": required,
            "optional": {
                "clip": ("CLIP", {"display_name": "CLIP"}),
            }
        }

    def apply_loras(self, model, total_switch, cpu_offload, lora_count, clip=None, **kwargs):
        """
        核心执行逻辑：按顺序堆叠应用LoRA
        :param model: 输入模型
        :param total_switch: 总控开关（True=应用LoRA, False=透传）
        :param cpu_offload: CPU内存加载模式
        :param lora_count: 活跃LoRA组数
        :param clip: 可选CLIP输入
        :param kwargs: 各LoRA组参数（lora_name_i, lora_switch_i, strength_model_i, strength_clip_i）
        :return: (处理后的模型, 处理后的CLIP)
        """
        # 总控关闭：原样透传
        if not total_switch:
            return (model, clip)

        current_model = model
        current_clip = clip

        # 按顺序应用每组LoRA
        for i in range(1, min(lora_count, MAX_LORA_GROUPS) + 1):
            lora_name = kwargs.get(f"lora_name_{i}", "None")
            lora_switch = kwargs.get(f"lora_switch_{i}", True)

            # 跳过未选择或已禁用的LoRA
            if lora_name == "None" or not lora_switch:
                continue

            strength_model = kwargs.get(f"strength_model_{i}", 1.0)
            strength_clip = kwargs.get(f"strength_clip_{i}", 1.0)

            try:
                # 加载LoRA文件
                lora_path = folder_paths.get_full_path("loras", lora_name)
                if lora_path is None or not os.path.exists(lora_path):
                    print(f"[JosiaLoraStack] ⚠️ LoRA文件不存在: {lora_name}")
                    continue

                lora_data = comfy.utils.load_torch_file(lora_path)

                # CPU内存加载模式
                if cpu_offload:
                    # 将LoRA权重加载到CPU
                    for key in lora_data:
                        if hasattr(lora_data[key], 'to'):
                            lora_data[key] = lora_data[key].to('cpu')

                # 应用LoRA到模型和CLIP
                current_model, current_clip = comfy.sd.load_lora_for_models(
                    current_model, current_clip, lora_data,
                    strength_model, strength_clip
                )
                
                # 清理临时加载的LoRA数据
                del lora_data
                
                if cpu_offload:
                    comfy.model_management.soft_empty_cache()

            except Exception as e:
                print(f"[JosiaLoraStack] ❌ LoRA {lora_name} 应用失败: {str(e)}")
                continue

        return (current_model, current_clip)


# ==================== ComfyUI 节点映射（与__init__.py注册名严格一致） ====================
NODE_CLASS_MAPPINGS = {
    "JosiaLoraStack": JosiaLoraStack
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaLoraStack": "JosiaLoRA堆叠"
}
