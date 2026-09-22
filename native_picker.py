"""
🪟 Windows 原生文件夹选择器（进程内调用 shell32 / COM，**零外部进程**）

为什么不用 PowerShell 子进程（老 text_save 的做法）：
  Comfy Registry 的静态扫描把 `subprocess` 归入 `python_command_injection_risk`，
  只要命中一次就把该版本标成 Banned/Flagged —— 老写法正是因此被禁（见 text_save.py 文件头）。
  本模块用 ctypes 直接调用 Windows 自带的 `IFileOpenDialog`（就是资源管理器里那个
  「选择文件夹」窗口，左侧有「此电脑」，可以随时退回顶层），全程在当前进程内完成，
  不产生任何子进程，也不引入新的扫描命中的写法。

公共接口：
  · available()                      → 当前平台是否可用（仅 Windows）
  · pick_folder(title, initial_dir)  → 打开原生对话框；返回选中的绝对路径，用户取消返回 ""
  · pick_folder_async(...)           → 异步版（独立 STA 线程里跑，不阻塞事件循环）

🔴 铁律 1：本文件不得出现 subprocess / os.system / os.popen / pty 等外部进程写法。
🔴 铁律 2：调用 `IFileDialog::Show(hwndOwner)` 时 **必须给 owner**（取当前前台窗口）。
   传 None ⇒ 对话框没有属主窗口，Windows 的「前台锁」只让它**在任务栏闪一下**，
   表现就是「窗口在后台打开，要用户自己去任务栏找」。老 WinForms 版本之所以正常，
   是因为 `FolderBrowserDialog.ShowDialog()` 内部会自己取 `GetActiveWindow()` 当 owner。

🔴 铁律 3：对话框要在**每次新建的 STA 线程**里打开。线程池线程可能已被别的库
   CoInitializeEx 成 MTA（`RPC_E_CHANGED_MODE`），MTA 线程上跑 shell 模态对话框
   会出现不激活 / 不置顶等异常行为。
"""
import ctypes
import os
import sys
import threading

_IS_WIN = sys.platform.startswith("win")

# ==================== COM / Shell 常量 ====================
_COINIT_APARTMENTTHREADED = 0x2
_CLSCTX_INPROC_SERVER = 0x1
_S_OK = 0
_S_FALSE = 1
# IFileDialog 选项
_FOS_PICKFOLDERS = 0x00000020
_FOS_FORCEFILESYSTEM = 0x00000040
_FOS_PATHMUSTEXIST = 0x00000800
# SHGetDisplayName 取的路径形态
_SIGDN_FILESYSPATH = 0x80058000
# 经典对话框（BROWSEINFO）选项
_BIF_RETURNONLYFSDIRS = 0x00000001
_BIF_EDITBOX = 0x00000010
_BIF_NEWDIALOGSTYLE = 0x00000040
# 允许任意进程抢前台（AllowSetForegroundWindow 的 ASFW_ANY）
_ASFW_ANY = 0xFFFFFFFF


class _GUID(ctypes.Structure):
    _fields_ = (("Data1", ctypes.c_ulong),
                ("Data2", ctypes.c_ushort),
                ("Data3", ctypes.c_ushort),
                ("Data4", ctypes.c_ubyte * 8))


def _guid(d1, d2, d3, rest):
    return _GUID(d1, d2, d3, (ctypes.c_ubyte * 8)(*rest))


# {DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}
_CLSID_FILE_OPEN_DIALOG = _guid(0xDC1C5A9C, 0xE88A, 0x4DDE,
                                (0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7))
# {D57C7288-D4AD-4768-BE02-9D969532D960}
_IID_IFILE_OPEN_DIALOG = _guid(0xD57C7288, 0xD4AD, 0x4768,
                               (0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60))
# {43826D1E-E718-42EE-BC55-A1E261C37BFE}
_IID_ISHELL_ITEM = _guid(0x43826D1E, 0xE718, 0x42EE,
                         (0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE))


def _vfn(ptr, index, *argtypes):
    """取 COM 接口 ptr 第 index 个虚表函数，返回可调用对象（restype = HRESULT）。"""
    vtbl = ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    proto = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, *argtypes)
    return proto(vtbl[index])


def _release(ptr):
    """IUnknown::Release（虚表第 2 项）。"""
    try:
        _vfn(ptr, 2)(ptr)
    except Exception:
        pass


# ==================== 前置抢前台（解决「窗口在后台打开」） ====================
def _foreground_hwnd():
    """当前系统前台窗口句柄（通常就是浏览器窗口）。拿不到返回 0。"""
    try:
        return int(ctypes.windll.user32.GetForegroundWindow() or 0)
    except Exception:
        return 0


def _attach_thread_input():
    """把当前线程的输入队列挂到前台线程上，返回用于解挂的 token（失败返回 None）。

    原因：后台进程创建的模态窗口即使有 owner，也可能被「前台锁」挡住不激活
    （只闪任务栏）。AttachThreadInput 之后，当前线程与前台线程共享输入状态，
    对话框就能正常抢到前台。**必须成对解挂**，否则会造成两线程输入状态粘连。
    """
    try:
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        fg = _foreground_hwnd()
        if not fg:
            return None
        fg_thread = int(user32.GetWindowThreadProcessId(fg, None) or 0)
        cur_thread = int(kernel32.GetCurrentThreadId() or 0)
        if not fg_thread or not cur_thread or fg_thread == cur_thread:
            return None
        if user32.AttachThreadInput(fg_thread, cur_thread, True):
            return (fg_thread, cur_thread)
    except Exception:
        pass
    return None


def _detach_thread_input(token):
    if not token:
        return
    try:
        ctypes.windll.user32.AttachThreadInput(token[0], token[1], False)
    except Exception:
        pass


def _allow_foreground():
    """尽力让本进程具备设置前台窗口的资格（失败无所谓）。"""
    try:
        ctypes.windll.user32.AllowSetForegroundWindow(_ASFW_ANY)
    except Exception:
        pass


# ==================== 现代对话框（IFileOpenDialog） ====================
def _pick_modern(title, initial_dir):
    ole32 = ctypes.windll.ole32
    shell32 = ctypes.windll.shell32

    init = ole32.CoInitializeEx(None, _COINIT_APARTMENTTHREADED)
    need_uninit = init in (_S_OK, _S_FALSE)
    ptr = ctypes.c_void_p()
    owner = _foreground_hwnd()
    attached = _attach_thread_input()
    _allow_foreground()
    try:
        hr = ole32.CoCreateInstance(ctypes.byref(_CLSID_FILE_OPEN_DIALOG), None,
                                    _CLSCTX_INPROC_SERVER,
                                    ctypes.byref(_IID_IFILE_OPEN_DIALOG),
                                    ctypes.byref(ptr))
        if hr != _S_OK or not ptr.value:
            raise OSError("CoCreateInstance(FileOpenDialog) 失败 0x%08X" % (hr & 0xFFFFFFFF))

        # SetOptions(idx 9) / GetOptions(idx 10)：叠加「选文件夹 + 只允许文件系统 + 必须存在」
        opts = ctypes.c_uint(0)
        _vfn(ptr, 10, ctypes.POINTER(ctypes.c_uint))(ptr, ctypes.byref(opts))
        _vfn(ptr, 9, ctypes.c_uint)(
            ptr, opts.value | _FOS_PICKFOLDERS | _FOS_FORCEFILESYSTEM | _FOS_PATHMUSTEXIST)

        if title:
            _vfn(ptr, 17, ctypes.c_wchar_p)(ptr, str(title))

        # SetFolder(idx 12)：起始目录（可选）
        if initial_dir and os.path.isdir(initial_dir):
            item = ctypes.c_void_p()
            hr2 = shell32.SHCreateItemFromParsingName(
                ctypes.c_wchar_p(os.path.abspath(initial_dir)), None,
                ctypes.byref(_IID_ISHELL_ITEM), ctypes.byref(item))
            if hr2 == _S_OK and item.value:
                try:
                    _vfn(ptr, 12, ctypes.c_void_p)(ptr, item)
                finally:
                    _release(item)

        # 🔴 Show(idx 3)：**必须传 owner**（前台窗口）。传 None ⇒ 没属主 ⇒ 只在任务栏闪一下。
        #    用户取消时返回非 0（HRESULT_FROM_WIN32(ERROR_CANCELLED)）。
        if _vfn(ptr, 3, ctypes.c_void_p)(ptr, ctypes.c_void_p(owner)) != _S_OK:
            return ""

        result = ctypes.c_void_p()
        hr = _vfn(ptr, 20, ctypes.POINTER(ctypes.c_void_p))(ptr, ctypes.byref(result))
        if hr != _S_OK or not result.value:
            return ""
        try:
            buf = ctypes.c_wchar_p()
            hr = _vfn(result, 5, ctypes.c_uint, ctypes.POINTER(ctypes.c_wchar_p))(
                result, _SIGDN_FILESYSPATH, ctypes.byref(buf))
            if hr != _S_OK or not buf.value:
                return ""
            path = str(buf.value)
            try:
                ole32.CoTaskMemFree(ctypes.cast(buf, ctypes.c_void_p))
            except Exception:
                pass
            return path
        finally:
            _release(result)
    finally:
        _detach_thread_input(attached)
        _release(ptr)
        if need_uninit:
            try:
                ole32.CoUninitialize()
            except Exception:
                pass


# ==================== 经典对话框（SHBrowseForFolder，兜底） ====================
class _BROWSEINFOW(ctypes.Structure):
    _fields_ = (("hwndOwner", ctypes.c_void_p),
                ("pidlRoot", ctypes.c_void_p),
                ("pszDisplayName", ctypes.c_wchar_p),
                ("lpszTitle", ctypes.c_wchar_p),
                ("ulFlags", ctypes.c_uint),
                ("lpfn", ctypes.c_void_p),
                ("lParam", ctypes.c_void_p),
                ("iImage", ctypes.c_int))


def _pick_legacy(title, initial_dir):
    ole32 = ctypes.windll.ole32
    shell32 = ctypes.windll.shell32

    init = ole32.CoInitializeEx(None, _COINIT_APARTMENTTHREADED)
    need_uninit = init in (_S_OK, _S_FALSE)
    owner = _foreground_hwnd()
    attached = _attach_thread_input()
    _allow_foreground()
    try:
        shell32.SHBrowseForFolderW.restype = ctypes.c_void_p
        shell32.SHGetPathFromIDListW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p)
        shell32.SHGetPathFromIDListW.restype = ctypes.c_int

        shown = ctypes.create_unicode_buffer(260)
        # 🔴 hwndOwner 同样必须给前台窗口（否则经典对话框也一样跑到后台）
        info = _BROWSEINFOW(ctypes.c_void_p(owner), None, shown,
                            str(title or "选择文件夹"),
                            _BIF_RETURNONLYFSDIRS | _BIF_EDITBOX | _BIF_NEWDIALOGSTYLE,
                            None, None, 0)
        pidl = shell32.SHBrowseForFolderW(ctypes.byref(info))
        if not pidl:
            return ""
        try:
            out = ctypes.create_unicode_buffer(1024)
            if not shell32.SHGetPathFromIDListW(ctypes.c_void_p(pidl), out):
                return ""
            return str(out.value or "")
        finally:
            try:
                ole32.CoTaskMemFree(ctypes.c_void_p(pidl))
            except Exception:
                pass
    finally:
        _detach_thread_input(attached)
        if need_uninit:
            try:
                ole32.CoUninitialize()
            except Exception:
                pass


# ==================== 对外接口 ====================
def available():
    """当前平台是否支持原生文件夹对话框。"""
    return bool(_IS_WIN)


# 同一时刻只允许一个原生对话框（双开会让用户看到两个窗口、且更容易丢焦点）
_busy_lock = threading.Lock()


def pick_folder(title="选择文件夹", initial_dir=""):
    """打开 Windows 原生「选择文件夹」对话框。

    返回：选中的绝对路径；用户取消（或已有对话框在开）返回 ""；平台不支持抛 RuntimeError。
    """
    if not _IS_WIN:
        raise RuntimeError("not_supported")
    if not _busy_lock.acquire(blocking=False):
        return ""
    try:
        try:
            return _pick_modern(title, initial_dir)
        except Exception as e:
            print(f"[JosiaNodes] 原生文件夹对话框不可用（{e}），退回经典对话框。")
            return _pick_legacy(title, initial_dir)
    finally:
        _busy_lock.release()


async def pick_folder_async(title="选择文件夹", initial_dir=""):
    """异步版：在**独立 STA 线程**里打开对话框，期间不阻塞 aiohttp 事件循环。

    🔴 不用 asyncio 默认线程池：池内线程可能已被别的库初始化成 MTA
       （CoInitializeEx 返回 RPC_E_CHANGED_MODE），MTA 线程上跑 shell 模态对话框
       会出现「不激活 / 跑到后台」等问题。每次新起一个线程最稳。
    """
    import asyncio

    loop = asyncio.get_running_loop()
    fut = loop.create_future()

    def _finish(value, err):
        try:
            if fut.done():
                return
            if err is not None:
                fut.set_exception(err)
            else:
                fut.set_result(value)
        except Exception:
            pass

    def _worker():
        try:
            res = pick_folder(title, initial_dir)
        except BaseException as e:            # noqa: BLE001 —— 任何异常都要回传，否则 Future 永远挂着
            loop.call_soon_threadsafe(_finish, None, e)
        else:
            loop.call_soon_threadsafe(_finish, res, None)

    threading.Thread(target=_worker, name="josia-folder-picker", daemon=True).start()
    return await fut
