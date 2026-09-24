"""
Josia · 可选 Pillow 保存插件的统一注册与能力探测

被两处共用，保证判定口径完全一致：
  · media_save.py  —— 决定「图像格式」下拉里到底有哪些格式能用
  · dep_check.py   —— 决定设置面板里该项显示「已装」还是「装了但没生效」

🔴 为什么必须显式注册：pillow-heif ≥ 0.5 起改成 **import 不自动注册**，
   必须调用 pillow_heif.register_heif_opener() 才会往 Pillow 里登记保存器；
   pillow-avif-plugin / pillow-jxl-plugin 仍是 import 即注册。
   只 __import__ 的写法会让 HEIF 常年「装了却没生效」（设置面板与实际下拉对不上）。
   本模块对两种形态都兼容：import 之后统一扫模块里的 register_*_opener 并调用
   （幂等，重复执行无副作用），调完再以 Image.SAVE 为准做能力校验。

🔴 单一事实源：任何“这个格式能不能存”的判断都必须走这里，不要在别处各写一套
   import / find_spec —— 历史教训就是两边口径不一致导致误报。
"""
import importlib
import importlib.util

# (key, import 模块名, 应当向 Pillow 注册哪些保存格式)
PLUGINS = (
    ("avif", "pillow_avif", ("AVIF",)),
    ("heif", "pillow_heif", ("HEIF",)),
    ("jxl", "pillow_jxl", ("JXL",)),
)

PIL_ERROR = None      # PIL 本身不可用时记下异常，便于排查
_STATE = None         # 进程内缓存：{key: {"imported", "formats", "ok"}}


def _image_mod():
    """取 PIL.Image；拿不到则返回 None（无 Pillow 的极端环境）。"""
    global PIL_ERROR
    try:
        from PIL import Image
        return Image
    except Exception as e:          # Pillow 缺失 / 装残
        PIL_ERROR = e
        return None


def _register_openers(mod):
    """调用模块内的 register_*_opener()（新版 pillow-heif 必需）。

    本就 import 即注册的插件（avif / jxl）没有这类函数，会被无害跳过。
    """
    try:
        names = dir(mod)
    except Exception:
        return
    for name in names:
        if name.startswith("register") and name.endswith("opener"):
            fn = getattr(mod, name, None)
            if callable(fn):
                try:
                    fn()
                except Exception:
                    pass


def _scan(refresh=False):
    """探测全部插件 —— 副作用就是「注册」。结果缓存，refresh=True 时重来。"""
    global _STATE
    if _STATE is not None and not refresh:
        return _STATE

    Image = _image_mod()
    if refresh:
        # 🔴 用户在终端里刚装完包、还没重启 ComfyUI：新包不在 Python 的目录缓存里，
        #    不清缓存则 find_spec / import 都探不到，会一直显示「未装」。
        importlib.invalidate_caches()

    states = {}
    for key, mod, fmts in PLUGINS:
        imported = False
        try:
            if importlib.util.find_spec(mod) is not None:
                _register_openers(importlib.import_module(mod))
                imported = True
        except Exception:
            imported = False
        states[key] = {"imported": imported, "formats": tuple(fmts), "ok": False}

    saves = None
    if Image is not None:
        try:
            Image.init()                 # 不 init 的话 Image.SAVE 是空表
        except Exception:
            pass
        saves = set(getattr(Image, "SAVE", None) or {}) or None

    for st in states.values():
        if not st["imported"]:
            continue
        # 取不到表（无 Pillow）时退回「已 import」这一级，不至于因为环境异常误判缺失
        st["ok"] = True if saves is None else all(f in saves for f in st["formats"])

    _STATE = states
    return _STATE


def ensure_registered(refresh=False):
    """注册装了的可选插件，返回 {key: {"imported", "formats", "ok"}}。"""
    return dict(_scan(refresh))


def save_table(refresh=False):
    """当前 Pillow 真正能保存的格式集合（拿不到返回 None）。

    media_save 用它筛下拉 —— 与此处注册动作配套，调用前插件必已被登记。
    """
    Image = _image_mod()
    if Image is None:
        return None
    _scan(refresh)
    try:
        Image.init()
    except Exception:
        pass
    return set(getattr(Image, "SAVE", None) or {}) or None


def status(key, refresh=False):
    """missing（没装） / no_saver（装了但没注册上保存器） / ok（真的能用）。"""
    st = _scan(refresh).get(key)
    if st is None or not st["imported"]:
        return "missing"
    return "ok" if st["ok"] else "no_saver"


def available(key, refresh=False):
    """该 key 对应的格式当前是否真的可保存。"""
    return status(key, refresh) == "ok"
