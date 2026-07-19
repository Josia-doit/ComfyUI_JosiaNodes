"""
Josia 缓存清理节点 v2（重新设计）
=================================
设计初衷（与用户确认）：
  • 保持已加载的模型 / CLIP / VAE 常驻（绝不卸载），
    让重复运行工作流时无需重新加载，出图更快；
  • 只清理「无用」的显存 / 内存：上一次出图残留的显存碎片、
    已无引用的中间张量（latent / 图像）；
  • 不做任何「卸载模型」的动作（那有原生机制与其他节点负责）。

为什么不用旧实现：
  • 旧版用 PromptServer.set_flag("free_memory", True)
    → 会触发 ComfyUI 卸载当前未使用的模型，与「保持模型缓存」初衷相反；
  • 旧版清空 Windows 系统文件缓存 / 对所有进程执行 EmptyWorkingSet
    → 与 ComfyUI 显存无关，反而拖慢模型重读、且有稳定性风险。
  以上全部移除。

新做法（跨平台、安全）：
  • comfy.model_management.soft_empty_cache()
    = torch.cuda.empty_cache()，只释放 CUDA 缓存分配器中「已预留但空闲」的显存块。
    被 ModelPatcher 引用、仍在 current_loaded_models 中的已加载模型不会被释放。
  • gc.collect()：回收 Python 层已无引用的中间张量，降低内存占用。
依赖：gc、time、server.PromptServer、comfy.model_management
"""
import gc
import time
from server import PromptServer
import comfy.model_management

NODE_DISPLAY_NAME_CACHE = "Josia缓存清理"

# 参考节点的AnyType定义（ComfyUI标准写法：匹配任意输入类型）
class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False
    def __eq__(self, __value: object) -> bool:
        return True

any = AnyType("*")  # 定义任意类型常量

class JosiaCacheCleanup:
    """🧹 Josia 缓存清理
    保持已加载模型，仅清理无用显存/内存碎片，让重复出图更快。

    • 清理无用缓存（保留模型）：gc.collect + soft_empty_cache，
      释放上一次出图残留的显存碎片与无引用中间张量，已加载模型不动。
    • 深度回收：额外 torch.cuda.empty_cache + 二次 gc，
      释放更彻底（代价：下次分配有少量开销），默认关。

    特点：单端口任意输入透传，不影响工作流数据流转。"""

    DESCRIPTION = """🧹 Josia 缓存清理（保持模型 · 只清无用缓存）
    仅释放「无用」的显存/内存，绝不卸载已加载的模型，重复运行工作流更快。

    • 清理无用缓存（保留模型）：释放上一次出图残留的显存碎片与无引用中间张量；
      模型/CLIP/VAE 保持常驻，下次出图无需重新加载。
    • 深度回收：在上面的基础上额外强制释放 CUDA 缓存（更彻底，
      但下次分配有少量开销），仅在显存仍明显偏高时开启。

    特点：单端口任意输入透传，不影响工作流数据流转。"""

    CATEGORY = "Josia"
    FUNCTION = "execute_clean"  # 核心执行函数名

    # 定义节点输入参数（ComfyUI核心要求）
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "清理无用缓存": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ 保留模型·清理碎片",
                    "label_off": "❎ 不动",
                    "display_name": "清理无用缓存",
                    "tooltip": (
                        "释放上一次出图残留的显存碎片与无引用中间张量；\n"
                        "已加载的模型/CLIP/VAE 保持常驻（不卸载），\n"
                        "重复运行工作流时无需重新加载，速度更快。\n"
                        "跨平台安全：无 GPU 时自动跳过显存清理，仅做内存回收。"
                    ),
                }),
                "深度回收": ("BOOLEAN", {
                    "default": False,
                    "label_on": "✅ 强制释放CUDA缓存",
                    "label_off": "❎ 轻量模式",
                    "display_name": "深度回收",
                    "tooltip": (
                        "在「清理无用缓存」基础上，额外 torch.cuda.empty_cache() \n"
                        "+ 二次 gc，释放更彻底；\n"
                        "代价：下次张量分配有少量重新分配开销，\n"
                        "仅在显存仍明显偏高时开启，平时保持关闭。"
                    ),
                }),
            },
            "optional": {
                "任意": (any, {}),  # 任意类型输入端口（透传数据用）
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",  # 节点唯一ID（隐藏参数）
                "extra_pnginfo": "EXTRA_PNGINFO",  # PNG附加信息（隐藏参数）
            }
        }

    # 定义节点输出参数
    RETURN_TYPES = (any,)  # 任意类型输出（透传输入数据）
    RETURN_NAMES = ("输出",)  # 输出端口名称
    OUTPUT_NODE = True  # 标记为输出节点

    def execute_clean(self, 清理无用缓存, 深度回收, 任意=None, **kwargs):
        """
        核心缓存清理逻辑（v2：仅清无用缓存，绝不卸载模型）
        :param 清理无用缓存: 是否释放无用显存碎片 + 回收无引用中间张量（保留模型）
        :param 深度回收: 是否额外强制释放 CUDA 缓存（更彻底，有少量重分配代价）
        :param 任意: 透传的输入数据（原样返回）
        :param kwargs: 隐藏参数（unique_id/extra_pnginfo）
        :return: 透传的输入数据
        """
        start_ts = time.time()
        did_something = False

        # 1. 轻量清理：释放无用显存碎片 + 回收内存（保留已加载模型）
        if 清理无用缓存:
            try:
                gc.collect()
                # 只释放 CUDA 缓存分配器中空闲的显存块；
                # 被 ModelPatcher 引用、仍在 current_loaded_models 的模型不会被释放。
                comfy.model_management.soft_empty_cache()
                did_something = True
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ✅ 已清理无用显存/内存（模型保持常驻）")
            except Exception as e:
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ❌ 清理失败: {str(e)}")

        # 2. 深度回收：在上面的基础上额外强制释放 CUDA 缓存（更彻底）
        if 深度回收:
            try:
                gc.collect()
                # 强制释放 CUDA 缓存分配器中所有空闲块（不卸载被引用的模型）
                try:
                    import torch
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                except Exception:
                    pass
                gc.collect()
                did_something = True
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ✅ 已深度回收 CUDA 缓存")
            except Exception as e:
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ❌ 深度回收失败: {str(e)}")

        # 输出统计
        cost_time = int((time.time() - start_ts) * 1000)
        if not did_something:
            print(f"[{NODE_DISPLAY_NAME_CACHE}] ℹ️ 两个开关均关闭，未执行任何清理")
        else:
            print(f"[{NODE_DISPLAY_NAME_CACHE}] 📊 清理完成 | 耗时: {cost_time}ms")

        # 透传输入数据（原样返回，不影响工作流）
        return (任意,)

# ==================== ComfyUI 节点映射（与__init__.py注册名严格一致） ====================
NODE_CLASS_MAPPINGS = {
    "JosiaCacheCleanup": JosiaCacheCleanup  # 英文标识：与__init__.py中的node_alias完全匹配
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaCacheCleanup": "Josia缓存清理"  # 中文显示名：与__init__.py中的display_name完全匹配
}
