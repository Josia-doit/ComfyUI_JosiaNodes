"""
Josia 缓存清理节点
功能：轻量释放显存/内存缓存，不卸载模型，适配各类显存规格
特点：
1. 单端口任意输入透传，不影响工作流数据流转
2. Windows系统专属优化（文件缓存/进程内存清理）
3. 安全不删除系统进程，仅清理非系统进程内存
4. 跨平台兼容（非Windows仅执行显存清理）
本地文件名：cache_cleanup.py
节点英文标识：JosiaCacheCleanup
节点中文显示名：Josia缓存清理
依赖：ctypes、platform、gc、time、server.PromptServer、comfy.model_management
"""
import ctypes
from ctypes import wintypes
import platform
import gc
import time
from server import PromptServer
import comfy.model_management

# 导入节点配置（外部化配置，保持代码简洁）
from node_properties import (
    NODE_CLASS_NAME,
    NODE_DISPLAY_NAME_CACHE,
    NODE_CATEGORY,
    DEFAULT_SETTINGS,
    PARAM_DESCRIPTIONS
)

# 参考节点的AnyType定义（ComfyUI标准写法：匹配任意输入类型）
class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False
    def __eq__(self, __value: object) -> bool:
        return True

any = AnyType("*")  # 定义任意类型常量

class JosiaCacheCleanup:
    VERSION = "1.0.0"
    CATEGORY = NODE_CATEGORY  # 节点分类（与其他Josia节点统一）
    FUNCTION = "execute_clean"  # 核心执行函数名
    DESCRIPTION = "清理ComfyUI显存/内存缓存，透传任意输入数据"

    # 定义节点输入参数（ComfyUI核心要求）
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

    def execute_clean(self, 清理显存缓存, 清理文件缓存, 清理进程内存, 任意=None, **kwargs):
        """
        核心缓存清理逻辑
        :param 清理显存缓存: 是否清理ComfyUI显存缓存（保留模型）
        :param 清理文件缓存: 是否清理Windows系统文件缓存（仅Windows生效）
        :param 清理进程内存: 是否清理Windows非系统进程内存（仅Windows生效）
        :param 任意: 透传的输入数据（原样返回）
        :param kwargs: 隐藏参数（unique_id/extra_pnginfo）
        :return: 透传的输入数据
        """
        start_ts = time.time()  # 记录清理开始时间
        clean_result = 0  # 清理状态：0=未执行，1=部分完成，2=全部完成
        sys_platform = platform.system()  # 获取当前系统类型

        # 系统兼容性校验：非Windows仅执行显存清理
        if sys_platform != "Windows":
            print(f"[{NODE_DISPLAY_NAME_CACHE}] ⚠️ 非Windows系统，仅执行显存清理")
            清理文件缓存 = False
            清理进程内存 = False

        # 1. 显存缓存清理（跨平台）
        if 清理显存缓存:
            try:
                gc.collect()  # 垃圾回收Python内存
                comfy.model_management.soft_empty_cache()  # 轻量清理显存（不卸载模型）
                PromptServer.instance.prompt_queue.set_flag("free_memory", True)  # 通知ComfyUI释放内存
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ✅ 显存缓存清理完成（模型已保留）")
                clean_result = 1 if clean_result == 0 else 2
            except Exception as e:
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ❌ 显存清理失败: {str(e)}")

        # 2. 系统文件缓存清理（Windows专属）
        if 清理文件缓存 and sys_platform == "Windows":
            try:
                ctypes.windll.kernel32.SetSystemFileCacheSize(-1, -1, 0)  # 清理系统文件缓存
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ✅ 系统文件缓存清理完成")
                clean_result = 1 if clean_result == 0 else 2
            except Exception as e:
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ⚠️ 文件缓存清理失败: {str(e)}")

        # 3. 非系统进程内存清理（Windows专属）
        if 清理进程内存 and sys_platform == "Windows":
            try:
                # 定义进程信息结构体（Windows API）
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
                
                # 遍历所有进程，清理非系统进程内存
                h_snapshot = ctypes.windll.kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
                if h_snapshot != -1:
                    pe = PROCESSENTRY32()
                    pe.dwSize = ctypes.sizeof(pe)
                    if ctypes.windll.kernel32.Process32First(h_snapshot, ctypes.byref(pe)):
                        while True:
                            # 解码进程名（兼容中文）
                            proc_name = pe.szExeFile.decode("gbk", errors="ignore").lower()
                            # 仅清理非系统进程
                            if proc_name not in DEFAULT_SETTINGS["system_procs"]:
                                try:
                                    # 打开进程并清理工作集
                                    h_proc = ctypes.windll.kernel32.OpenProcess(0x001F0FFF, False, pe.th32ProcessID)
                                    if h_proc:
                                        ctypes.windll.psapi.EmptyWorkingSet(h_proc)
                                        ctypes.windll.kernel32.CloseHandle(h_proc)
                                except:
                                    pass
                            # 遍历下一个进程
                            if not ctypes.windll.kernel32.Process32Next(h_snapshot, ctypes.byref(pe)):
                                break
                    ctypes.windll.kernel32.CloseHandle(h_snapshot)
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ✅ 非系统进程内存清理完成")
                clean_result = 1 if clean_result == 0 else 2
            except Exception as e:
                print(f"[{NODE_DISPLAY_NAME_CACHE}] ⚠️ 进程内存清理失败: {str(e)}")

        # 输出清理统计信息
        cost_time = int((time.time() - start_ts) * 1000)  # 计算耗时（毫秒）
        print(f"[{NODE_DISPLAY_NAME_CACHE}] 📊 清理完成 | 状态: {clean_result} | 耗时: {cost_time}ms")

        # 透传输入数据（原样返回，不影响工作流）
        return (任意,)

# ==================== ComfyUI 节点映射（与__init__.py注册名严格一致） ====================
NODE_CLASS_MAPPINGS = {
    "JosiaCacheCleanup": JosiaCacheCleanup  # 英文标识：与__init__.py中的node_alias完全匹配
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaCacheCleanup": "Josia缓存清理"  # 中文显示名：与__init__.py中的display_name完全匹配
}
