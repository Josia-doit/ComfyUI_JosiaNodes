"""
🎞️ Josia 加载 Latent —— 读取本地 .latent 文件，可选对潜空间「直接放大」。

与「Josia媒体保存 → 保存Latent」配套：那边存出 .latent，这里读回来并可放大后再送下游。

缩放语义（后端铁律）：
  · 图像 Latent（[B,C,H,W]）/ 视频 Latent（[B,C,T,H,W]）⇒ 只缩放**空间维度 H、W**，
    缩放后再对齐到「对齐倍数」的整数倍（VAE / patch 通常要求 8 或 16 的倍数）。
  · 音视频混合 Latent（NestedTensor，`samples.is_nested=True`）⇒ 尝试**只放大视频路、
    不动音频路**再重新混合；重混合失败则友好报错终止（可关闭缩放原样加载）。
  · 纯音频 Latent（`samples["type"] == "audio"`）⇒ 不支持缩放，友好报错终止。
🔴 不存在 `latent["audio_latent"]`（那只出现在 conditioning 的 keyframe/ref 里）。

HTTP 路由统一 `josia_load_latent_*` 前缀（对外契约，勿随文件名改）：
  · GET  /josia_load_latent/list      → 上传目录里的 .latent 清单
  · POST /josia_load_latent/upload    → 上传任意位置的 .latent（不限 input 目录）
  · GET  /josia_load_latent/info      → 某个 .latent 的大小 / 形状 / 类型
  · POST /josia_load_latent/open_dir  → 用资源管理器打开上传目录
"""
import os
import sys

import torch
import folder_paths
import comfy.utils

try:
    import safetensors.torch as _st_torch
except Exception:      # 极端裁剪环境没有 safetensors 时退化为纯 torch.load 路径
    _st_torch = None

try:
    from .node_properties import NODE_CATEGORY
except Exception:  # 直接以文件方式加载时（__init__ 里 spec_from_file_location）
    try:
        from node_properties import NODE_CATEGORY
    except Exception:
        NODE_CATEGORY = "⚡️JosiaNodes"

PLACEHOLDER = "🎞️ 请选择 .latent 文件…"
LATENT_SUBDIR = "josia_latent"      # 上传的 .latent 落在 input/josia_latent/ 下
ALIGN_CHOICES = ["1", "2", "4", "8", "16", "32", "64", "128"]


# ==================================================================
# 文件定位
# ==================================================================
def _latent_root():
    root = os.path.join(folder_paths.get_input_directory(), LATENT_SUBDIR)
    try:
        os.makedirs(root, exist_ok=True)
    except Exception:
        pass
    return root


def _safe_name(name):
    """只保留纯文件名，禁止任何路径分隔 / 上跳（防目录穿越）。"""
    base = os.path.basename(str(name or "").replace("\\", "/").strip())
    if not base or base in (".", ".."):
        return ""
    if "\x00" in base:
        return ""
    return base


def _list_latent_files():
    root = _latent_root()
    out = []
    try:
        with os.scandir(root) as it:
            for e in it:
                try:
                    if e.is_file() and e.name.lower().endswith(".latent"):
                        out.append(e.name)
                except OSError:
                    continue
    except Exception:
        pass
    out.sort(key=str.lower)
    return out


def _resolve_path(name):
    """把选择的名字解析成绝对路径：先看上传目录，再看 ComfyUI input 根。"""
    n = _safe_name(name)
    if not n:
        return None
    cand = os.path.join(_latent_root(), n)
    if os.path.isfile(cand):
        return cand
    cand2 = os.path.join(folder_paths.get_input_directory(), n)
    if os.path.isfile(cand2):
        return cand2
    return None


# ==================================================================
# 缩放
# ==================================================================
def _as_bool(v):
    """把开关值稳妥地解读成布尔。

    🔴 不能直接 `if v:`：旧工作流 / 某些前端把 BOOLEAN 存成字符串（"false" / "0"），
    `bool("false")` 恒为 True ⇒ 关闭着的开关会被当成开启 ⇒ 潜空间被「错误的缩放」。
    这里显式识别字符串与数字，只认真正的开。
    """
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "on", "yes", "y", "✅", "开启")
    return bool(v)


def _align(v, mult):
    """向上对齐到 mult 的整数倍。

    🔴 只向上（ceil），绝不因「就近取整」把潜空间**缩小** —— 信息一旦被裁掉不可逆；
    向上补几行的代价极小（VAE 只要求宽高是倍数的整数倍即可）。
    """
    v = int(round(v))
    if not mult or mult <= 1:
        return max(1, v)
    m = int(mult)
    return max(m, ((v + m - 1) // m) * m)


def _scale_tensor_spatial(t, ratio, mult):
    """只缩放张量的空间维度（最后两维 H、W）。
    4D [B,C,H,W] / 5D [B,C,T,H,W] 直接处理；其它维度结构原样返回（不报错）。"""
    if not torch.is_tensor(t) or t.dim() not in (4, 5):
        return t
    dtype = t.dtype
    h, w = int(t.shape[-2]), int(t.shape[-1])
    nh, nw = _align(h * ratio, mult), _align(w * ratio, mult)
    if nh == h and nw == w:
        return t
    x = t.to(torch.float32)
    if x.dim() == 4:
        y = torch.nn.functional.interpolate(x, size=(nh, nw), mode="bilinear", align_corners=False)
    else:
        b, c, tt = int(x.shape[0]), int(x.shape[1]), int(x.shape[2])
        x2 = x.permute(0, 2, 1, 3, 4).reshape(b * tt, c, h, w)
        y2 = torch.nn.functional.interpolate(x2, size=(nh, nw), mode="bilinear", align_corners=False)
        y = y2.reshape(b, tt, c, nh, nw).permute(0, 2, 1, 3, 4)
    return y.to(dtype)


def _scale_latent(latent, ratio, mult):
    samples = latent.get("samples") if isinstance(latent, dict) else None
    if samples is None:
        return latent

    # 音视频混合（NestedTensor）：只放大视频路、不动音频路，再重新混合
    if getattr(samples, "is_nested", False):
        try:
            parts = list(samples.unbind())
            if not parts:
                return latent
            vid = _scale_tensor_spatial(parts[0], ratio, mult)
            rest = list(parts[1:])
            try:
                new = torch.nested.nested_tensor([vid] + rest, layout=torch.jagged)
            except Exception:
                new = torch.nested.nested_tensor([vid] + rest)
            out = dict(latent)
            out["samples"] = new
            return out
        except Exception as e:
            raise ValueError(
                "Josia加载Latent：这是「音视频混合」潜空间，尝试只放大视频路后重新混合失败，已终止。"
                "可关闭「Latent缩放」原样加载该文件。（" + str(e) + "）")

    # 纯音频：不支持缩放
    if isinstance(samples, dict) and samples.get("type") == "audio":
        raise ValueError(
            "Josia加载Latent：这是纯音频潜空间，暂不支持缩放。"
            "请关闭「Latent缩放」原样加载。")

    out = dict(latent)
    out["samples"] = _scale_tensor_spatial(samples, ratio, mult)
    return out


def _read_latent_file(path):
    """读 .latent：按**魔数**识别容器格式，不走 comfy.utils.load_torch_file 的扩展名分派。

    🔴 Round 19 问题 4 根因：本 fork 的 `comfy.utils.save_torch_file` ＝ safetensors 写盘
    （与核心 SaveLatent 逐字一致），而 `load_torch_file` 按**扩展名**分派 —— `.latent`
    不在 safetensors 白名单里 ⇒ 走 `torch.load(weights_only=True)` 去解析 safetensors 字节
    ⇒ 报「Weights only load failed … WeightsUnpickler error: Unsupported operand 184」
    （传给 load_torch_file 的 safe_load=True 在该 fork 里被无视）。
    这里改为：前 8 字节是 safetensors 的头长度（LE u64）、第 9 字节是 `{` ⇒ safetensors
    直读；否则按 torch.save 旧格式兜底（weights_only=True 优先，失败再 False 并告警）。
    """
    try:
        with open(path, "rb") as f:
            head = f.read(9)
        if _st_torch is not None and len(head) >= 9 and head[8:9] == b"{":
            return _st_torch.load_file(path, device="cpu")
    except OSError:
        pass
    except Exception as e:      # 头像 safetensors 但解析失败 → 落到 torch.load 兜底
        print(f"[Josia加载Latent] ⚠️ safetensors 直读失败，改用 torch.load 兜底：{e}")
    try:
        return torch.load(path, map_location="cpu", weights_only=True)
    except Exception:
        # 旧版 torch.save 里带非张量对象的文件（weights_only 安全反序列化器不认）⇒ 最后兜底
        print(f"[Josia加载Latent] ⚠️ weights_only=True 读取失败，改用完整反序列化兜底：{path}")
        return torch.load(path, map_location="cpu", weights_only=False)


def _extract_tensor(sd):
    """从读回的字典里取潜空间张量（优先 latent_tensor，其次首个张量/嵌套张量）。"""
    if not isinstance(sd, dict):
        return None
    t = sd.get("latent_tensor")
    if t is not None:
        return t
    for v in sd.values():
        if torch.is_tensor(v) or getattr(v, "is_nested", False):
            return v
    return None


# ==================================================================
# 节点
# ==================================================================
class JosiaLoadLatent:
    """🎞️ Josia 加载 Latent —— 读取 .latent 文件，可选放大（缩放比例 + 对齐倍数）。"""

    CATEGORY = NODE_CATEGORY
    FUNCTION = "load"
    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("Latent",)
    OUTPUT_TOOLTIPS = ("读回（并按需放大）的潜空间。",)

    DESCRIPTION = """🎞️ Josia 加载 Latent
加载本地 .latent 文件（与「Josia媒体保存 → 保存Latent」同格式）。

• 显示当前选中的 .latent 文件名；「📁 选择文件」可上传任意位置的 .latent（不限 input 目录）
• 下方信息窗显示文件名 / 大小 / 张量形状 / 类型
• 给「Latent」输入端口接线后：**忽略文件**，直接把上游 Latent 当源（文件区自动灰化），
  于是本节点也可以当「Latent 透传 / 放大」节点用，替掉单独的 Latent 缩放节点

⚙️ Latent 缩放：开启后可对潜空间「直接放大」
   · 图像 Latent：按「缩放比例」放大空间尺寸，再对齐到「对齐倍数」的整数倍
   · 视频 / 音视频混合 Latent：只放大视频路、不动音频路，再重新混合
   · 纯音频 Latent：暂不支持缩放（会给出友好报错）
   · 接了「Latent」端口时开关照旧说了算：开＝放大后输出，关＝原样透传"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "Latent文件": ("STRING", {
                    "default": PLACEHOLDER,
                    "multiline": False,
                    "tooltip": "要加载的 .latent 文件名；用「📁 选择文件」上传新文件后自动填入。",
                }),
                "Latent缩放": ("BOOLEAN", {
                    "default": False,
                    "label_on": "✅ 缩放", "label_off": "❎ 不缩放",
                    "tooltip": "开启后按下方「缩放比例 / 对齐倍数」放大潜空间；关闭则原样加载。",
                }),
                "缩放比例": ("FLOAT", {
                    "default": 2.0, "min": 0.1, "max": 8.0, "step": 0.05,
                    "tooltip": "空间尺寸（宽高）的放大倍数，默认 2.0；1.0 = 不改变。",
                }),
                "对齐倍数": (ALIGN_CHOICES, {
                    "default": "16",
                    "tooltip": "把放大后的宽高**向上**对齐到该倍数的整数倍（VAE / patch 通常需要 8 或 16 的倍数，默认 16）。"
                               "只向上补、绝不因对齐把潜空间缩小。1 = 不对齐。",
                }),
            },
            # 🔴 可选输入：接了它就不再读文件，直接把上游 Latent 当源（透传 / 放大都能干）。
            #    放在 optional 里 ⇒ 不接线时输入槽不参与校验，老工作流零影响。
            "optional": {
                "Latent": ("LATENT", {
                    "tooltip": "接入后忽略「Latent文件」，直接对上游 Latent 处理："
                               "「Latent缩放」开＝按缩放比例/对齐倍数放大，关＝原样透传。",
                }),
            },
        }

    def load(self, Latent=None, **kw):
        # 缩放参数（两条路径共用）
        try:
            ratio = float(kw.get("缩放比例") or 1.0)
        except Exception:
            ratio = 1.0
        try:
            mult = int(str(kw.get("对齐倍数") or "1"))
        except Exception:
            mult = 1

        if Latent is not None:
            # ---- 路径 A：接了 Latent 端口 ⇒ 忽略文件，直接以它为源 ----
            if isinstance(Latent, dict):
                latent = dict(Latent)
            else:
                latent = {"samples": Latent}
            samples = latent.get("samples")
            if samples is None:
                raise ValueError("Josia加载Latent：接入的「Latent」端口里没有 samples，无法透传。")
            if torch.is_tensor(samples):
                latent["samples"] = samples.to(torch.float32)
        else:
            # ---- 路径 B：读本地 .latent 文件（原有行为）----
            name = kw.get("Latent文件")
            if not name or name == PLACEHOLDER:
                raise ValueError(
                    "Josia加载Latent：请选择一个 .latent 文件（或点「📁 选择文件」上传），"
                    "或者给「Latent」输入端口接线。")
            path = _resolve_path(name)
            if not path:
                raise ValueError(f"Josia加载Latent：找不到文件「{name}」（已在上传目录与 input 目录里查找）。")

            try:
                sd = _read_latent_file(path)
            except Exception as e:
                raise ValueError(f"Josia加载Latent：读取「{name}」失败：{e}")

            samples = _extract_tensor(sd)
            if samples is None:
                raise ValueError(f"Josia加载Latent：「{name}」里没有可用的 latent 张量。")
            if torch.is_tensor(samples):
                samples = samples.to(torch.float32)
            latent = {"samples": samples}

        # 「Latent缩放」开关对两条路径都生效：
        #   开（真值）＝按「缩放比例 / 对齐倍数」放大后输出；
        #   关＝**原样透传**（一个维度都不动，保持原比例）。
        # 🔴 用 _as_bool 而不是直接判真值：字符串 "false" 也能被误判成开 ⇒ 无端缩放。
        if _as_bool(kw.get("Latent缩放")):
            latent = _scale_latent(latent, ratio, mult)

        return (latent,)


# ==================================================================
# HTTP 路由
# ==================================================================
def _register_routes():
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception as e:      # pragma: no cover
        print(f"[Josia加载Latent] 路由跳过（{e}）")
        return

    @PromptServer.instance.routes.get("/josia_load_latent/list")
    async def _list(request):
        return web.json_response({"ok": True, "files": _list_latent_files()})

    @PromptServer.instance.routes.post("/josia_load_latent/upload")
    async def _upload(request):
        """上传任意位置的 .latent 到 input/josia_latent/（不限 input 目录）。"""
        try:
            post = await request.post()
            field = post.get("file")
            if field is None or not getattr(field, "filename", None):
                return web.json_response({"ok": False, "error": "no_file"}, status=400)
            name = _safe_name(field.filename)
            if not name.lower().endswith(".latent"):
                return web.json_response({"ok": False, "error": "only_latent"}, status=400)
            data = field.file.read()
            dest = os.path.join(_latent_root(), name)
            with open(dest, "wb") as f:
                f.write(data)
            return web.json_response({"ok": True, "name": name, "files": _list_latent_files()})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/josia_load_latent/info")
    async def _info(request):
        name = request.query.get("file") or ""
        path = _resolve_path(name)
        if not path:
            return web.json_response({"ok": False, "error": "not_found"}, status=404)
        info = {"ok": True, "name": _safe_name(name), "size": os.path.getsize(path)}
        try:
            sd = _read_latent_file(path)
            t = _extract_tensor(sd)
            if getattr(t, "is_nested", False):
                parts = list(t.unbind())
                info["kind"] = "音视频混合潜空间"
                info["shape"] = " ＋ ".join(str(tuple(p.shape)) for p in parts)
            elif torch.is_tensor(t):
                info["kind"] = "张量潜空间"
                info["shape"] = str(tuple(t.shape))
                info["dtype"] = str(t.dtype)
            else:
                info["kind"] = "未知"
        except Exception as e:
            info["error"] = str(e)
        return web.json_response(info)

    @PromptServer.instance.routes.post("/josia_load_latent/open_dir")
    async def _open_dir(request):
        if not sys.platform.startswith("win"):
            return web.json_response({"ok": False, "error": "not_supported"}, status=501)
        try:
            os.startfile(_latent_root())      # noqa: S606（标准库，非子进程）
            return web.json_response({"ok": True, "path": _latent_root()})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)


try:
    _register_routes()
except Exception as _e:      # pragma: no cover
    print(f"[Josia加载Latent] 路由注册失败：{_e}")


NODE_CLASS_MAPPINGS = {"JosiaLoadLatent": JosiaLoadLatent}
NODE_DISPLAY_NAME_MAPPINGS = {"JosiaLoadLatent": "Josia加载Latent"}
