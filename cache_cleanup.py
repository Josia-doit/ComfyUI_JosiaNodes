"""
Josia缓存清理节点
功能：轻量释放显存/内存缓存，不卸载模型，适配各类显存规格
特点：单端口任意输入透传、Windows系统优化、安全不删进程
"""
import ctypes
from ctypes import wintypes
import platform
import gc
import time
from server import PromptServer
import comfy.model_management

# 导入节点配置
from .node_properties import (
    NODE_CLASS_NAME,
    NODE_DISPLAY_NAME_CACHE,
    NODE_CATEGORY,
    DEFAULT_SETTINGS,
    PARAM_DESCRIPTIONS
)

# 参考节点的AnyType定义（ComfyUI标准写法）
class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False
    def __eq__(self, __value: object) -> bool:
        return True

any = AnyType("*")

class JosiaCacheCleanup:
    VERSION = "1.0.0"
    CATEGORY = NODE_CATEGORY
    FUNCTION = "execute_clean"
    DESCRIPTION = "清理ComfyUI显存/内存缓存，透传任意输入数据"

    # 单端口输入（名称：任意，类型：any）
    INPUT_TYPES = lambda: {
        "required": {
            "清理显存缓存": ("BOOLEAN", {
                "default": DEFAULT_SETTINGS["clean_vram"],
                "label_on": "开启",
                "label_off": "关闭",
                "description": PARAM_DESCRIPTIONS["clean_vram"]
            }),
            "清理文件缓存": ("BOOLEAN", {
                "default": DEFAULT_SETTINGS["clean_file"],
                "label_on": "开启",
                "label_off": "关闭",
                "description": PARAM_DESCRIPTIONS["clean_file"]
            }),
            "清理进程内存": ("BOOLEAN", {
                "default": DEFAULT_SETTINGS["clean_process"],
                "label_on": "开启",
                "label_off": "关闭",
                "description": PARAM_DESCRIPTIONS["clean_process"]
            }),
        },
        "optional": {
            "任意": (any, {}),  # 输入端口名：任意
        },
        "hidden": {
            "unique_id": "UNIQUE_ID",
            "extra_pnginfo": "EXTRA_PNGINFO",
        }
    }

    # 单端口输出（名称：输出，类型：any）
    RETURN_TYPES = (any,)
    RETURN_NAMES = ("输出",)
    OUTPUT_NODE = True

    def execute_clean(self, 清理显存缓存, 清理文件缓存, 清理进程内存, 任意=None, **kwargs):
        start_ts = time.time()
        clean_result = 0
        sys_platform = platform.system()

        # 系统兼容性校验
        if sys_platform != "Windows":
            print(f"[{NODE_DISPLAY_NAME_CACHE}] ⚠️ 非Windows系统，仅执行显存清理")
            清理文件缓存 = False
            清理进程内存 = False

        # 显存缓存清理
        if 清理显存缓存:
            try:
                gc.collect()
                comfy.model_management.soft_empty_cache()
                PromptServer.instance.prompt_queue.set_flag("free_memory", True)
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ✅ 显存缓存清理完成（模型已保留）")
                clean_result = 1 if clean_result == 0 else 2
            except Exception as e:
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ❌ 显存清理失败: {str(e)}")

        # 系统文件缓存清理（Windows专属）
        if 清理文件缓存 and sys_platform == "Windows":
            try:
                ctypes.windll.kernel32.SetSystemFileCacheSize(-1, -1, 0)
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ✅ 系统文件缓存清理完成")
                clean_result = 1 if clean_result == 0 else 2
            except Exception as e:
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ⚠️ 文件缓存清理失败: {str(e)}")

        # 进程内存清理（Windows专属）
        if 清理进程内存 and sys_platform == "Windows":
            try:
                class PROCESSENTRY32(ctypes.Structure):
                    _fields_ = [
                        ("dwSize", wintypes.DWORD),
                        ("cntUsage", wintypes.DWORD),
                        ("th32ProcessID", wintypes.DWORD),
                        ("th32DefaultHeapID", wintypes.LPVOID),
                        ("th32ModuleID", wintypes.DWORD),
                        ("cntThreads", wintypes.DWORD),
                        ("th32ParentProcessID", wintypes.DWORD),
                        ("pcPriClassBase", wintypes.LONG),
                        ("dwFlags", wintypes.DWORD),
                        ("szExeFile", wintypes.CHAR * 260),
                    ]
                
                h_snapshot = ctypes.windll.kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
                if h_snapshot != -1:
                    pe = PROCESSENTRY32()
                    pe.dwSize = ctypes.sizeof(pe)
                    if ctypes.windll.kernel32.Process32First(h_snapshot, ctypes.byref(pe)):
                        while True:
                            proc_name = pe.szExeFile.decode("gbk", errors="ignore").lower()
                            if proc_name not in DEFAULT_SETTINGS["system_procs"]:
                                try:
                                    h_proc = ctypes.windll.kernel32.OpenProcess(0x001F0FFF, False, pe.th32ProcessID)
                                    if h_proc:
                                        ctypes.windll.psapi.EmptyWorkingSet(h_proc)
                                        ctypes.windll.kernel32.CloseHandle(h_proc)
                                except:
                                    pass
                            if not ctypes.windll.kernel32.Process32Next(h_snapshot, ctypes.byref(pe)):
                                break
                    ctypes.windll.kernel32.CloseHandle(h_snapshot)
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ✅ 非系统进程内存清理完成")
                clean_result = 1 if clean_result == 0 else 2
            except Exception as e:
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ⚠️ 进程内存清理失败: {str(e)}")

        cost_time = int((time.time() - start_ts) * 1000)
        print(f"[{NODE_DISPLAY_NAME_CACHE}] 📊 清理完成 | 状态: {clean_result} | 耗时: {cost_time}ms")

        # 透传输入数据（原样返回）
        return (任意,)

# 节点映射（保持英文名和中文名不变）
NODE_CLASS_MAPPINGS = {
    "JosiaCacheCleanup": JosiaCacheCleanup
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaCacheCleanup": "Josia缓存清理"
}