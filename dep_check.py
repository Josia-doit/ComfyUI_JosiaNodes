"""
Josia 依赖安装器 · 后端只读探测路由（方案 A+）
不自动装包（Comfy Registry 禁止运行时 subprocess 装包），只提供只读检测，
供设置面板禁用已装项、避免重复安装。
另提供 /josia_dep/version 只读版本号（读 pyproject.toml，唯一事实源），
供设置页顶部品牌横幅显示。
路由前缀统一 josia_（对外契约，勿随文件名改）。
"""
import importlib.util
import os
import sys

from server import PromptServer
from aiohttp import web

routes = PromptServer.instance.routes

# key → (pip 包名, 候选 import 模块名列表, 应当向 Pillow 注册哪些保存格式)
# 🔴 pip 包名必须是 PyPI 上真实存在的名字 —— 曾把 JPEG XL 写成 pillow-jxl（不存在），
#    用户复制命令后在终端直接报 "No matching distribution found"（按照字面父项目名称去
#    逐个在 PyPI 上核对后再写。插件的**发布名不一定等于 import 名**（例如下面第一条）。
#    · pillow-avif-plugin  → import pillow_avif → 注册 AVIF
#    · pillow-heif         → import pillow_heif → 注册 HEIF
#    · pillow-jxl-plugin   → import pillow_jxl  → 注册 JXL
# import 名可能随版本变化，故每个依赖给多个候选，任一可用即视为已装。
DEP_PACKAGES = {
    "avif": ("pillow-avif-plugin", ["pillow_avif"], ("AVIF",)),
    "heif": ("pillow-heif", ["pillow_heif"], ("HEIF",)),
    "jxl": ("pillow-jxl-plugin", ["pillow_jxl"], ("JXL",)),
    "pyav": ("av", ["av"], ()),          # 视频容器 / 音频格式后端，不走 Pillow 保存器
}


try:
    import pillow_plugins as _pillow_plugins
except Exception:                      # 极端情况缺失时退化为 import 级判定
    _pillow_plugins = None


def _pil_status(key, refresh=False):
    """走 Pillow 保存器的三项（avif/heif/jxl）—— 判定口径与媒体保存的下拉同源。

    🔴 必须在 pillow_plugins 里完成「注册」这一步再校验 Image.SAVE：
       新版 pillow-heif 不 import 即注册，漏了这一步就会报
       「装了但没生效」，而实际上只是没调 register_heif_opener()。
    """
    if _pillow_plugins is not None:
        return _pillow_plugins.available(key, refresh), _pillow_plugins.status(key, refresh)
    try:                               # 兜底：只做 import 级判定
        pkg, mods, _fmts = DEP_PACKAGES[key]
        del pkg
        importlib.import_module(mods[0])
        return True, "ok"
    except Exception:
        return False, "missing"


def _probe_av(refresh=False):
    """PyAV：视频容器 / 音频格式后端，不走 Pillow 保存器，单独做 import 级判定。"""
    if refresh:
        importlib.invalidate_caches()
    for n in DEP_PACKAGES["pyav"][1]:
        try:
            if importlib.util.find_spec(n) is None:
                continue
        except Exception:
            continue
        try:
            importlib.import_module(n)
            return True, "ok"
        except Exception:
            continue
    return False, "missing"


_CHECK_CACHE = None


@routes.get("/josia_dep/check")
async def josia_dep_check(request):
    """只读检测：各依赖是否可用 + ComfyUI 专用 Python 的绝对路径。

    · 默认返回缓存结果（进程内只检测一次），避免反复开关设置页重复探测。
    · 带 `?force=1` 时作废缓存重新探测 —— 给设置面板的「重新检测」按钮用：
      用户在终端里刚装完依赖，还没重启 ComfyUI，点一下就能立刻确认是否装上。
      🔴 必须先 importlib.invalidate_caches()：新装的包不在 Python 的目录缓存里，
        不清缓存的话 import / find_spec 都探不到它，按钮会一直报「未装」。
    · python 路径供前端生成「带绝对路径解释器 + 镜像源」的安装命令，
      保证在任意目录执行都装入 ComfyUI 环境而非系统 Python。
    """
    global _CHECK_CACHE
    force = str(request.rel_url.query.get("force", "")).lower() in ("1", "true", "yes")
    if force or _CHECK_CACHE is None:
        if force:
            importlib.invalidate_caches()
        detail = {}
        result = {}
        for key, (_pkg, mods, fmts) in DEP_PACKAGES.items():
            if fmts:                                   # Pillow 图像格式插件
                ok, st = _pil_status(key, force)
            else:                                      # PyAV 后端
                ok, st = _probe_av(force)
            del mods
            result[key] = ok
            detail[key] = st
        result["python"] = sys.executable
        result["detail"] = detail
        _CHECK_CACHE = result
    return web.json_response(_CHECK_CACHE)


_VERSION_CACHE = None


def _read_version():
    """包版本号：唯一事实源为 pyproject.toml（发版只改一处）。"""
    global _VERSION_CACHE
    if _VERSION_CACHE is not None:
        return _VERSION_CACHE
    v = ""
    try:
        import tomllib

        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pyproject.toml")
        with open(p, "rb") as f:
            v = tomllib.load(f).get("project", {}).get("version", "") or ""
    except Exception:
        try:
            from importlib.metadata import version as _meta_version

            v = _meta_version("comfyui-josianodes")
        except Exception:
            v = ""
    _VERSION_CACHE = v
    return v


@routes.get("/josia_dep/version")
async def josia_dep_version(request):
    return web.json_response({"version": _read_version()})
