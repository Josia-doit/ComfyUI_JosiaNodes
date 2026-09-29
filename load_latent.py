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
  · GET  /josia_load_latent/batch     → 本节点任务池进度快照
  · POST /josia_load_latent/clear     → 清空本节点任务池（文件仍留磁盘）
  · POST /josia_load_latent/reset     → 本节点进度归零（保留任务池）
  · POST /josia_load_latent/remove    → 从本节点任务池移除单个文件（文件仍留磁盘）
  · POST /josia_load_latent/clear_done → 清除本节点已完成条目（未完成的保留）
⚠️ batch / clear / reset / remove / clear_done / upload 都带 `?nid=<分桶钥匙>`：批量清单按它分桶，
   多个加载Latent节点的任务池与进度互不共用。钥匙由前端生成、持久化在「Latent文件」widget 里
   （切工作流 / 保存重开 / node.id 重编号都不漂移），老会话取不到时后端退回 unique_id。
"""
import os
import sys
import json

import torch
import folder_paths
import comfy.utils
import comfy.nested_tensor as _comfy_nested  # 🔴 AV 混合潜空间重组必须用 ComfyUI 自己的类（见 _rebuild_av）

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

# 🔁 批量进度清单：调度器与工人共享同一份 manifest，但**按节点 ID 分桶**——
#    多个加载Latent节点的任务池 / 进度互不共用（哥哥要求）。__init__ 已把包目录塞进 sys.path。
try:
    from batch_shared import node_data, set_status, reset_manifest, enqueue, clear_queue, update_file, remove_file, clear_done, migrate_bucket
except Exception:
    try:
        from .batch_shared import node_data, set_status, reset_manifest, enqueue, clear_queue, update_file, remove_file, clear_done, migrate_bucket
    except Exception:
        node_data = None
        set_status = None
        reset_manifest = None
        enqueue = None
        clear_queue = None
        update_file = None
        remove_file = None
        clear_done = None
        migrate_bucket = None

PLACEHOLDER = "🎞️ 请选择 .latent 文件…"
LATENT_SUBDIR = "josia_latent"      # 上传的 .latent 落在 input/josia_latent/ 下
ALIGN_CHOICES = ["1", "2", "4", "8", "16", "32", "64", "128"]
# 🔁 批量联动的「夹带标记」键：批量模式下把（节点ID + 源文件名）塞进输出的 Latent 字典，
#    下游「Josia媒体保存」取出来回写进度并消费掉。纯后台联动，不占任何端口
#    （哥哥要求：媒体保存复杂度已高，UI 一个不加；「文件名」输出端口已删）。
BATCH_MARKER_KEY = "_josia_batch"


def _bucket_key(unique_id, kw):
    """任务池分桶钥匙（稳定版）。

    🔴 旧版直接用 hidden unique_id（＝node.id）分桶，实测 node.id 会随切换工作流 /
    前端重编号而漂移，同一逻辑节点的任务池被撕成多个孤儿桶（面板显示「任务池 0」的
    根因）。新版由前端生成一把 UUID 持久化在隐藏「Latent文件」widget 里
    （值形如 {"key":"...","sel":"..."}，widget 值随 prompt 一并提交——本工作流能通过
    必填项校验即是凭证），执行时从这里取；取不到（老工作流 / 异常）退回 unique_id。
    """
    raw = kw.get("Latent文件")
    if isinstance(raw, str) and raw[:1] == "{":
        try:
            o = json.loads(raw)
            k = str((o or {}).get("key") or "").strip()
            if k:
                return k
        except Exception:
            pass
    return str(unique_id) if unique_id else "default"


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


def _alloc_upload_name(root, name):
    """上传重名时的顺延命名：`Media_001.latent` → `Media_001 (2).latent`。

    🔴 本包红线：保存/上传绝不覆盖已有文件。旧版直接把上传内容写到同名路径，用户一次
    选了两个**同名但内容不同**的 .latent（不同目录下的同名文件很常见）⇒ 后一个盖掉前一个，
    任务池按名字去重后只剩一条，表现为「选了 2 个文件只载入 1 个，继续添加也加不上」。
    """
    if not os.path.exists(os.path.join(root, name)):
        return name                     # 原名可用就用原名（误调也不会白白改名）
    stem, ext = os.path.splitext(name)
    i = 1
    while True:
        i += 1
        cand = f"{stem} ({i}){ext}"
        if not os.path.exists(os.path.join(root, cand)):
            return cand


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


def _read_latent_meta(path):
    """读 safetensors 头部的 `__metadata__`（「Josia媒体保存」落盘时写入的 `josia_vae1/2`）。

    🔴 为什么不复用 `_read_latent_file`：safetensors 的头部元数据是**头区 JSON 里的
    `__metadata__` 字段**，`safetensors.torch.load_file` 只返回张量字典、把元数据丢掉。
    文件格式固定（前 8 字节＝头区长度 LE u64，紧跟头区 JSON），直接读头即可，
    不必把整份权重读进内存。任何异常都返回空字典——它只用来做信息窗的锦上添花。
    """
    try:
        with open(path, "rb") as f:
            n = int.from_bytes(f.read(8), "little")
            if not (0 < n < 50_000_000):
                return {}
            head = json.loads(f.read(n).decode("utf-8"))
        return (head or {}).get("__metadata__") or {}
    except Exception:
        return {}


def _rebuild_av(sd):
    """把「按路拆开保存」的**音视频混合**潜空间重组成 ComfyUI 的 NestedTensor。

    🔴 safetensors 拒收 NestedTensor（实测 torch 2.13 报 “You are trying to save a
       sparse tensors …”），所以「Josia媒体保存」落盘时把联合 AV 潜空间拆成
       `latent_av_part_0..N` 存储。这里必须**原样拼回 ComfyUI 自己的
       `comfy.nested_tensor.NestedTensor`** —— 它只是个包了 `.tensors` 列表的壳，
       下游（VAEDecode / 音频解码 / nodes_minimax_h3 等）全程靠 `.is_nested` /
       `.unbind()` / `.tensors` 这套接口。

       🔴 不能用 `torch.nested.nested_tensor(..., layout="jagged")` 替代：真实 AV 潜空间
       是「视频 5D + 音频 3D（维度数都不同）」，torch 原生构造会直接抛
       `RuntimeError: all tensors must have the same dim`，被 except 吞掉后静默退回第一路
       ⇒ 音频路丢失（正好复现了本想修的 bug）。已实测必须用 ComfyUI 这个类。
    """
    if not isinstance(sd, dict) or sd.get("josia_av_nested") is None:
        return None
    try:
        count = int(sd["josia_av_count"].item())
    except Exception:
        return None
    parts = [sd.get(f"latent_av_part_{i}") for i in range(count)]
    if count < 1 or any(p is None for p in parts):
        return None
    try:
        return _comfy_nested.NestedTensor(parts)
    except Exception as e:
        print(f"[Josia加载Latent] ⚠️ 音视频混合潜空间重组失败：{e}")
        return None


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


def _latent_dims(path):
    """读一次 .latent，取**显示用**的像素宽高 / 帧数（潜空间尺寸 ×8）。失败返回 None，绝不抛。

    供上传入队时缓存进 manifest：文件列表的「分辨率」列直接取用，
    不必每次刷新快照都重读全部文件（几百 KB～几 MB 的 I/O 能省则省）。
    """
    try:
        sd = _read_latent_file(path)
        t = _rebuild_av(sd)
        if t is None:
            t = _extract_tensor(sd)
        if getattr(t, "is_nested", False):
            shapes = [tuple(p.shape) for p in t.unbind()]
            vid = next((s for s in shapes if len(s) == 5), None)
            if not vid:
                return None
            out = {"w": int(vid[-1]) * 8, "h": int(vid[-2]) * 8, "frames": int(vid[2])}
            aud = next((s for s in shapes if len(s) == 3), None)
            if aud:
                out["audio_frames"] = int(aud[2])
            return out
        if not torch.is_tensor(t):
            return None
        sh = tuple(t.shape)
        if len(sh) == 4:          # [B,C,H,W] 图像潜空间（sh[0] 是 batch，不是帧 ⇒ 恒 1）
            return {"w": int(sh[-1]) * 8, "h": int(sh[-2]) * 8, "frames": 1}
        if len(sh) == 5:          # [B,C,T,H,W] 视频潜空间
            return {"w": int(sh[-1]) * 8, "h": int(sh[-2]) * 8, "frames": int(sh[2])}
    except Exception:
        pass
    return None


# ==================================================================
# 节点
# ==================================================================
class JosiaLoadLatent:
    """🎞️ Josia 加载 Latent test —— 批量调度器：每次执行从任务池挑一个未完成 .latent 推出去。"""

    CATEGORY = NODE_CATEGORY
    FUNCTION = "batch_load"
    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("Latent",)
    OUTPUT_TOOLTIPS = ("读回（并按需放大）的潜空间。批量模式下内部携带进度回写标记，"
                       "由下游「Josia媒体保存」在后台自动消费，无需任何连线。",)

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
                # 🔴 缩放三项置顶（哥哥要求）：开关 + 两个参数排在最上方。
                "Latent缩放": ("BOOLEAN", {
                    "default": False,
                    "label_on": "✅ 缩放", "label_off": "❎ 不缩放",
                    "tooltip": "开启后按下方「缩放比例 / 对齐倍数」放大潜空间；关闭则原样加载"
                               "（下方两个参数自动灰化，不再隐藏）。",
                }),
                "缩放比例": ("FLOAT", {
                    "default": 2.0, "min": 0.1, "max": 8.0, "step": 0.05,
                    "tooltip": "空间尺寸（宽高）的放大倍数，默认 2.0；1.0 = 不改变。关闭「Latent缩放」时显示两位小数但不可调。",
                }),
                "对齐倍数": (ALIGN_CHOICES, {
                    "default": "16",
                    "tooltip": "把放大后的宽高**向上**对齐到该倍数的整数倍（VAE / patch 通常需要 8 或 16 的倍数，默认 16）。"
                               "只向上补、绝不因对齐把潜空间缩小。1 = 不对齐。",
                }),
                "Latent文件": ("STRING", {
                    "default": PLACEHOLDER,
                    "multiline": False,
                    "tooltip": "（占位，批量模式由「📁 选择文件」管理任务池）。",
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
            # 🔴 hidden：unique_id＝本节点实例 ID。分桶钥匙优先用「Latent文件」widget 里的
            #    稳定 UUID（见 _bucket_key），unique_id 只作取不到时的兜底。
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    # 🔴🔴 调度器语义：批量循环靠「队列 batch count」一轮一轮驱动。若本节点被 ComfyUI
    #    的执行缓存命中（输入没变 ⇒ 直接复用上一轮输出），任务池永远停在第一个文件，
    #    下游拿到的还是**同一个 Latent 字典对象**（标记已被 pop 掉 ⇒ 进度回写也丢失）。
    #    实测：22:58 那轮日志里本节点整行消失、媒体保存拿 vram 完全相同的 Latent 重复解码。
    #    让缓存键永不匹配（nan != nan 恒成立）⇒ 每轮都真正执行，按任务池推进下一个文件。
    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def batch_load(self, Latent=None, unique_id=None, **kw):
        # 🔴 分桶钥匙：优先用前端持久化的稳定 UUID（node.id 会漂移，见 _bucket_key 注释）。
        #    🔴 这里绝不做旧桶搬家：node.id 按序复用，执行期搬家会把历史孤儿桶的文件
        #       搬进全新节点的池（「重建几次后冒幽灵文件」的根因之一）。搬家只由前端
        #       在「从工作流恢复且 widget 无钥匙」时经 /batch?legacy= 触发一次。
        nid = _bucket_key(unique_id, kw)

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
            # ---- 路径 A：接了 Latent 端口 ⇒ 忽略任务池，直接以它为源（透传 / 放大）----
            if isinstance(Latent, dict):
                latent = dict(Latent)
            else:
                latent = {"samples": Latent}
            samples = latent.get("samples")
            if samples is None:
                raise ValueError("Josia加载Latent：接入的「Latent」端口里没有 samples，无法透传。")
            if torch.is_tensor(samples):
                latent["samples"] = samples.to(torch.float32)
            if _as_bool(kw.get("Latent缩放")):
                latent = _scale_latent(latent, ratio, mult)
            return (latent,)

        # ---- 路径 B：批量调度模式 ----
        # 🔴 任务池＝本节点桶里的 manifest.queue（用户在「📁 选择文件」里显式载入的列表）；
        #    进度真相＝manifest.files（见 batch_shared）。
        #    每次执行：跳过 done ⇒ 取第一个待处理 ⇒ 标记 processing ⇒ 推出它的 LATENT。
        #    任务池空 / 全部完成 ⇒ 返回 (None, "")：下游媒体保存节点「Latent 为 None」会静默跳过，
        #    于是队列 batch count 设大一点也不会刷一堆红，天然实现「跑完自动停」。
        bucket = node_data(nid) if node_data else {"queue": [], "files": {}}
        files = list(bucket.get("queue") or [])
        fents = bucket.get("files") or {}
        statuses = {}
        for f in files:
            st = (fents.get(f) or {}).get("status", "pending")
            statuses[f] = st if st in ("done", "processing", "failed") else "pending"

        pending = [f for f in files if statuses[f] != "done"]

        if not pending:
            # 空池 vs 全部完成要区分开：空池才提示去载入，全完成就报喜。
            msg = ("等待载入文件…" if not files
                   else "✅ 全部完成")
            info = _batch_ui(nid, files, statuses, None, msg)
            return {"result": (None,), "ui": {"josia_batch_info": info}}

        # 🔴 processing 也当待处理：上一次被打断、没落盘的残留，重跑时继续解。
        name = pending[0]
        path = _resolve_path(name)
        if not path:
            # 文件已从磁盘消失（被外部删了）⇒ 标 failed 并跳过，继续下一个，不阻塞整批。
            if set_status:
                set_status(nid, name, "failed", error="文件已从磁盘消失")
            info = _batch_ui(nid, files, statuses, None, f"⚠️ 跳过缺失文件：{name}")
            return {"result": (None,), "ui": {"josia_batch_info": info}}

        # 标记 processing ⇒ 下一轮信息窗显示「解码中」；真正落盘由媒体保存节点写回 done。
        if set_status:
            set_status(nid, name, "processing")
        statuses[name] = "processing"

        try:
            sd = _read_latent_file(path)
        except Exception as e:
            if set_status:
                set_status(nid, name, "failed", error=str(e))
            raise ValueError(f"Josia加载Latent：读取「{name}」失败：{e}")

        # 🔴 先试恢复「音视频混合」形态（这类文件里没有 latent_tensor 键）。
        samples = _rebuild_av(sd)
        if samples is None:
            samples = _extract_tensor(sd)
        if samples is None:
            if set_status:
                set_status(nid, name, "failed", error="没有可用的 latent 张量")
            raise ValueError(f"Josia加载Latent：「{name}」里没有可用的 latent 张量。")
        if torch.is_tensor(samples):
            samples = samples.to(torch.float32)
        latent = {"samples": samples}

        # 「Latent缩放」开关同样生效（批量解码也支持直接放大）。
        if _as_bool(kw.get("Latent缩放")):
            latent = _scale_latent(latent, ratio, mult)

        info = _batch_ui(nid, files, statuses, name, f"解码中：{name}")
        # 🔴 回传整列表 + 状态：前端 onExecuted 据此自动刷新信息窗进度。
        #    批量联动标记随 Latent 字典带出去（BATCH_MARKER_KEY）：媒体保存节点在后台
        #    取出并回写「本节点桶」的进度，然后消费掉标记——不占端口、不进保存的文件。
        latent[BATCH_MARKER_KEY] = {"nid": nid, "name": name}
        return {"result": (latent,), "ui": {"josia_batch_info": info}}


# ==================================================================
# 批量进度 UI 构造
# ==================================================================
def _batch_ui(nid, files, statuses, current, msg):
    """构造信息窗用的进度结构：整文件列表 + 各状态计数 + 当前项 + 提示。

    每个文件带 size（字节）与缓存好的 w/h/frames（上传入队时读一次形状存进清单，
    这里直接取用，不再重读文件）。"""
    bucket = node_data(nid) if node_data else {"files": {}}
    ents = bucket.get("files") or {}
    done = sum(1 for f in files if statuses.get(f) == "done")
    processing = sum(1 for f in files if statuses.get(f) == "processing")
    failed = sum(1 for f in files if statuses.get(f) == "failed")
    flist = []
    for f in files:
        size = 0
        try:
            p = _resolve_path(f)
            if p:
                size = os.path.getsize(p)
        except Exception:
            size = 0
        ent = ents.get(f) or {}
        item = {"name": f, "status": statuses.get(f, "pending"), "size": size}
        if ent.get("w") and ent.get("h"):
            item["w"] = int(ent["w"])
            item["h"] = int(ent["h"])
        if ent.get("frames") is not None:
            item["frames"] = ent["frames"]
        flist.append(item)
    return {
        "files": flist,
        "total": len(files),
        "done": done,
        "processing": processing,
        "failed": failed,
        "current": current or "",
        "msg": msg or "",
    }


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
            root = _latent_root()
            dest = os.path.join(root, name)
            # 🔴 绝不覆盖已有文件（本包红线）：同名不同内容 ⇒ 自动顺延「xxx (2).latent」，
            #    两个同名但内容不同的 .latent 都能进任务池；同名同大小视为同一个文件
            #    （幂等：重复选择同一文件不会把任务池灌成重复项）。
            renamed = False
            try:
                clash = os.path.getsize(dest) != len(data)
            except OSError:
                clash = False
            if clash:
                name = _alloc_upload_name(root, name)
                dest = os.path.join(root, name)
                renamed = True
            if not os.path.exists(dest):
                with open(dest, "wb") as f:
                    f.write(data)
            # 🔁 上传即入队：把文件追加进**发起请求的节点**的任务池（去重，按 nid 分桶）。
            nid = request.query.get("nid") or "default"
            q = enqueue(nid, [name]) if enqueue else [name]
            # 🔁 顺手读一次形状，把像素宽高 / 帧数缓存进清单 —— 文件列表的「分辨率」列用。
            if update_file:
                dims = _latent_dims(dest)
                if dims:
                    update_file(nid, name, **dims)
            return web.json_response({"ok": True, "name": name, "queue": q, "renamed": renamed})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/josia_load_latent/info")
    async def _info(request):
        name = request.query.get("file") or ""
        path = _resolve_path(name)
        if not path:
            return web.json_response({"ok": False, "error": "not_found"}, status=404)
        info = {"ok": True, "name": _safe_name(name), "size": os.path.getsize(path)}
        # 这个 .latent 若由「Josia媒体保存」落盘，头部元数据里记着当时用的 VAE 文件名
        # ⇒ 信息窗显示出来，下次解码照着选即可（老文件没这条元数据则该项留空）。
        _meta = _read_latent_meta(path)
        if _meta.get("josia_vae1"):
            info["vae"] = _meta["josia_vae1"]
        if _meta.get("josia_vae2"):
            info["vae2"] = _meta["josia_vae2"]
        try:
            sd = _read_latent_file(path)
            t = _rebuild_av(sd)
            if t is None:
                t = _extract_tensor(sd)
            # 🔁 详情：形状 + 派生提示（像素尺寸 / 帧数 / 音频路），尽可能详细，供信息窗上方区展示。
            if getattr(t, "is_nested", False):
                parts = list(t.unbind())
                info["kind"] = "音视频混合潜空间"
                shapes = [tuple(p.shape) for p in parts]
                info["shape"] = " ＋ ".join(str(s) for s in shapes)
                info["parts"] = [len(shapes), sum(1 for s in shapes if len(s) == 5)]  # [总路数, 视频路数]
                # 视频路（5D）取空间与时间维度
                vid = next((s for s in shapes if len(s) == 5), None)
                if vid:
                    # 🔴 帧数语义（2026-09-29 哥哥质询后定）：vid[2] 是**潜空间时间帧 T**
                    #    （VAE 时间压缩后的长度），不是播放帧数。
                    #    🔴 不提供「≈播放帧数」估算（2026-09-29 第十八轮）：播放帧数取决于
                    #       具体 VAE 的时间压缩率与分块/重叠设计 —— Wan 系是 (T−1)×4+1，
                    #       MiniMax H3 是分块补帧+重叠（124 帧实encode 出 T=37，估算 145
                    #       对不上）⇒ 从 shape 无法可靠推出，显示出来就是误导。
                    info["frames"] = int(vid[2])
                    info["pixel_h"] = int(vid[-2]) * 8
                    info["pixel_w"] = int(vid[-1]) * 8
                # 音频路（3D）段时间长度，随视频段一起展示
                aud = next((s for s in shapes if len(s) == 3), None)
                if aud:
                    info["audio_frames"] = int(aud[2])
                info["has_audio"] = any(len(s) == 3 for s in shapes)
            elif torch.is_tensor(t):
                sh = tuple(t.shape)
                info["shape"] = str(sh)
                info["dtype"] = str(t.dtype)
                info["dim"] = len(sh)
                if len(sh) == 4:      # [B,C,H,W] 图像潜空间（sh[0] 是 batch ⇒ 帧数恒 1）
                    info["kind"] = "图像潜空间"
                    info["frames"] = 1
                    info["pixel_h"] = int(sh[-2]) * 8
                    info["pixel_w"] = int(sh[-1]) * 8
                elif len(sh) == 5:    # [B,C,T,H,W] 视频潜空间
                    # 🔴 frames＝潜空间时间帧 T（VAE 时间压缩后），非播放帧数；
                    #    不提供「≈播放帧数」估算（理由见上方 NestedTensor 分支注释）。
                    info["kind"] = "视频潜空间"
                    info["frames"] = int(sh[2])
                    info["pixel_h"] = int(sh[-2]) * 8
                    info["pixel_w"] = int(sh[-1]) * 8
                else:
                    info["kind"] = "张量潜空间"
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

    @PromptServer.instance.routes.get("/josia_load_latent/batch")
    async def _batch(request):
        """当前批量进度快照（按稳定钥匙分桶）：任务池列表 + 各状态计数，供前端初始渲染 / 接线后刷新。

        ?legacy=<旧 node.id>：旧版按 node.id 分桶的存量任务池在此一次性搬家
        （前端每次刷新都会带上当前 node.id，搬完旧桶即删，幂等）。
        """
        try:
            nid = request.query.get("nid") or "default"
            legacy = request.query.get("legacy") or ""
            if migrate_bucket and legacy:
                migrate_bucket(legacy, nid)
            bucket = node_data(nid) if node_data else {"queue": [], "files": {}}
            files = list(bucket.get("queue") or [])
            fents = bucket.get("files") or {}
            statuses = {}
            for f in files:
                st = (fents.get(f) or {}).get("status", "pending")
                statuses[f] = st if st in ("done", "processing", "failed") else "pending"
            # 「快照」这个词容易让哥哥困惑 ⇒ 待机中（未在解码、只是拉一次当前状态）。
            return web.json_response({"ok": True, "info": _batch_ui(nid, files, statuses, None, "待机中")})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/josia_load_latent/clear")
    async def _clear(request):
        """清空**该节点**的任务池与进度（🗑 清空列表按钮）。文件仍在磁盘，只是从队列移除。"""
        try:
            nid = request.query.get("nid") or "default"
            if clear_queue:
                clear_queue(nid)
            return web.json_response({"ok": True})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/josia_load_latent/reset")
    async def _reset(request):
        """重置**该节点**的进度（🔄 重置进度按钮）：保留任务池，把每个文件状态归零。"""
        try:
            nid = request.query.get("nid") or "default"
            if reset_manifest:
                reset_manifest(nid)
            return web.json_response({"ok": True})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/josia_load_latent/remove")
    async def _remove(request):
        """从**该节点**的任务池移除单个文件（列表行尾「✕」）。磁盘文件保留。"""
        try:
            nid = request.query.get("nid") or "default"
            name = request.query.get("name") or ""
            if remove_file:
                remove_file(nid, name)
            return web.json_response({"ok": True})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/josia_load_latent/clear_done")
    async def _clear_done(request):
        """清除**该节点**已完成的条目（🧹 清已完成按钮）：done 移除，未完成保留。"""
        try:
            nid = request.query.get("nid") or "default"
            if clear_done:
                clear_done(nid)
            return web.json_response({"ok": True})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)


try:
    _register_routes()
except Exception as _e:      # pragma: no cover
    print(f"[Josia加载Latent] 路由注册失败：{_e}")


NODE_CLASS_MAPPINGS = {"JosiaLoadLatent": JosiaLoadLatent}
NODE_DISPLAY_NAME_MAPPINGS = {"JosiaLoadLatent": "Josia加载Latent"}
