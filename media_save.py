"""
Josia 媒体保存（全能落地节点）
本地文件名：media_save.py
节点英文标识：JosiaMediaSave
中文显示名：Josia媒体保存
=================================================================
设计目标：把 ComfyUI 原生所有「落地」节点的能力汇聚到一个节点里，
         成为所有 AIGC 产物的最终出口。

原生对应关系（参数名/默认值/落盘行为逐条对齐，便于跟随上游同步）：
  · nodes.SaveImage          → 图像 = IMAGE 直存；filename_prefix 默认 "JosiaMedia"；
                               compress_level 默认 4；文件名 <名字>_<4位序号>.<扩展名>
                               （前缀里可写 %0001% / %003% 自定义序号位数，写了就不再自动补下划线）；
                               %batch_num% 占位；PNG 写 prompt / extra_pnginfo
  · nodes.PreviewImage       → 「临时预览」开关：写 temp 目录、前缀加 _temp_ + 5 随机字母、compress_level=1
  · nodes_images.SaveAnimatedPNG  → 视频容器 APNG（fps + compress_level）
  · nodes_images.SaveAnimatedWEBP → 视频容器 动图WebP（fps + lossless + quality + method 4/0/6）
  · nodes_video.SaveWEBM     → 视频容器 WebM（vp9 / av1，fps，crf）
  · nodes_video.SaveVideo    → 视频输入直接转存（mp4 / mkv / webm，h264 / av1）
  · nodes_audio.SaveAudio    → 音频格式 FLAC
  · nodes_audio.SaveAudioMP3 → 音频格式 MP3
  · nodes_audio.SaveAudioOpus→ 音频格式 Opus（采样率须落在 8k/12k/16k/24k/48k）
  · nodes.SaveLatent         → 「保存潜空间」开关：.latent（comfy.utils.save_torch_file）
  · nodes.VAEDecode          → 「解码方式 = 直接解码」
  · nodes.VAEDecodeTiled     → 「解码方式 = 分块解码」（参数语义逐字复刻）

新增（原生没有的）：
  · 图像多格式：PNG / JPEG / WebP / AVIF / HEIF / JPEG XL / TIFF / BMP / TGA /
    PPM / ICO / DDS / PCX / PBM / JPEG 2000；**支持写入工作流元数据的格式名
    前加 ⭐**（下拉里一眼可辨）
  · 压缩参数分级：无损开关、质量、PNG 压缩级别、色度采样、WebP method、
    AVIF speed、位深
  · 图像批次 → 视频（MP4 / MKV / WebM / GIF / APNG / 动图WebP）
  · 解码前 / 保存后的可逆显存清理（**绝不卸载已加载模型**，保证热启动不降速）
  · IMAGE 透传下游 + 落盘路径输出

铁律遵守：
  · 绝不动已加载模型的缓存（不调 free_memory / unload_all_models / free_memory），
    只回收无引用张量与 CUDA 缓存分配器里的空闲块。
  · 缺失依赖（AVIF / HEIF / JXL 需插件）不崩：格式选项自动隐藏，运行期遇到
    不可用格式则明确告警并降级 PNG。
"""
import gc
import json
import os
import random
import re
import sys
import time
from datetime import datetime
from fractions import Fraction

import numpy as np
import torch
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import folder_paths
import comfy.sd
import comfy.utils
import comfy.model_management
from comfy.cli_args import args

try:
    # 跨节点模型共享注册表 —— 读取「Josia模型加载」节点已载入的 VAE / VAE2，
    # 实现用户要的「无线连接」。模块缺失时降级为「不共享」，不影响其它功能。
    import model_registry as _model_registry
except Exception:          # pragma: no cover
    _model_registry = None

try:
    # Windows 原生「选择文件夹」对话框（ctypes 调 shell32，进程内，零外部进程）。
    # 模块缺失 / 非 Windows 时降级为前端内置文件夹浏览器。
    import native_picker as _native_picker
except Exception:          # pragma: no cover
    _native_picker = None

try:                       # PyAV 随 ComfyUI 一起安装（nodes_video 依赖它）
    import av
except Exception:          # pragma: no cover - 环境缺 PyAV 时降级
    av = None

NODE_DISPLAY_NAME_MEDIA_SAVE = "Josia媒体保存"

# ⭐ = 该格式支持写入工作流元数据（PNG 用私有 chunk；其余用 EXIF UserComment）
STAR = "⭐ "

# 这些格式**只有**无损模式（没有有损分支），「质量」对它无意义 ⇒ 节点内部一律按 100 处理，
# 前端对它们把「质量」控件灰化并固定显示 100（用户报的「PNG 调节质量没变化还误导人」）。
ALWAYS_LOSSLESS = {"PNG", "TIFF", "BMP", "TGA", "PPM", "PBM", "ICO", "DDS", "PCX"}

# ------------------------------------------------------------------
# 图像格式目录
# key         : 下拉里的显示名（可含 ⭐ 前缀）
# (PIL格式名, 扩展名, 可写元数据, 支持无损, 需要插件)
# ------------------------------------------------------------------
IMAGE_FORMATS = {
    "PNG":       ("PNG",      "png",  True,  True,  False),
    "JPEG":      ("JPEG",     "jpg",  True,  False, False),
    "WebP":      ("WEBP",     "webp", True,  True,  False),
    "AVIF":      ("AVIF",     "avif", True,  True,  True),
    "HEIF":      ("HEIF",     "heif", True,  True,  True),
    "JPEG XL":   ("JXL",      "jxl",  True,  True,  True),
    "TIFF":      ("TIFF",     "tif",  True,  True,  False),
    "JPEG 2000": ("JPEG2000", "jp2",  True,  True,  False),
    "BMP":       ("BMP",      "bmp",  False, True,  False),
    "TGA":       ("TGA",      "tga",  False, True,  False),
    "PPM":       ("PPM",      "ppm",  False, True,  False),
    "ICO":       ("ICO",      "ico",  False, True,  False),
    "DDS":       ("DDS",      "dds",  False, True,  False),
    "PCX":       ("PCX",      "pcx",  False, True,  False),
    # PBM 没有独立的保存器：Pillow 用 PPM 保存器按图像 mode 决定写 P4(PBM)，
    # 因此这里声明为 PPM，并在保存前把图转成 mode "1"（见 _SAVE_MODE）。
    "PBM":       ("PPM",      "pbm",  False, True,  False),
}

# 保存前需要的像素模式转换（None = 不改）
_SAVE_MODE = {
    "PBM": "1",
}

# 「不保存」三兄弟：图像 / 视频 / 音频各一个，既是「该路不落盘」的开关，
# 也是**必须落盘 .latent** 的触发器 —— 本节点一旦接入工作流就必须留下产物，
# 不允许「什么都不存」（那样工作流跑完没有任何文件，等于空转）。
# 🔴 恒排在各自下拉的**最后一项**（以后新增格式一律插在它前面）。
NONE_IMAGE = "不保存图像"
NONE_VIDEO = "不保存视频"
NONE_AUDIO = "不保存音频"

# 视频容器：显示名 -> (扩展名, 实现, 说明)
#   实现 "av"   = PyAV（与原生 SaveWEBM / SaveVideo 同路）
#   实现 "pillow" = Pillow（GIF / APNG / 动图WebP）
VIDEO_CONTAINERS = {
    "MP4":      ("mp4",  "av",     "H.264 / H.265 / AV1"),
    "MKV":      ("mkv",  "av",     "H.264 / H.265 / AV1"),
    "WebM":     ("webm", "av",     "VP9 / AV1"),
    "GIF":      ("gif",  "pillow", "无元数据 · 256 色"),
    "APNG":     ("png",  "pillow", "动图 PNG · 支持元数据"),
    "动图WebP": ("webp", "pillow", "动图 WebP · 支持元数据"),
}
VIDEO_CONTAINERS[NONE_VIDEO] = (None, None, "")   # 恒在最后（见 NONE_* 说明）

# 原生 SaveWEBM 的编码器映射（原样复刻）+ 新增 h264/h265 走 SaveVideo 同款
VIDEO_ENCODERS = {
    "h264": "libx264",
    "h265": "libx265",
    "av1":  "libsvtav1",
    "vp9":  "libvpx-vp9",
}
# 各容器的可选编码（容器放不下的编码自动换默认）
CONTAINER_CODECS = {
    "MP4":  ("h264", "h265", "av1"),
    "MKV":  ("h264", "h265", "av1", "vp9"),
    "WebM": ("vp9", "av1"),
}

# 🔴 下拉里只有「不保存X」这一个「不落盘」选项，不再有「关」：
#    「关」与「不保存X」语义完全重合，却绕开了「必须落盘 .latent」的强制规则
#    （选「关」时三路都能为空 ⇒ 工作流跑完一个文件都没有，正是要堵的漏洞）。
#    这里保留 tuple 让**老工作流里存的「关」仍被解析成「不落盘」**（不会报错），
#    它由前端在加载时自动升级成「不保存X」。
OFF_VIDEO = ("关", NONE_VIDEO)
OFF_AUDIO = ("关", NONE_AUDIO)

# 「需要把 Latent 解码成帧」的容器集合：只有选了它们（或选了真实图像格式）才必须解码。
# 供「不保存XX」的**免解码直通**判定使用（见 save_media）。
VIDEO_OUTPUT_CONTAINERS = ("MP4", "MKV", "WebM", "GIF", "APNG", "动图WebP")

AUDIO_FORMATS = {
    "FLAC": ("flac", "flac"),
    "WAV":  ("wav",  "wav"),
    "MP3":  ("mp3",  "mp3"),
    "Opus": ("opus", "opus"),
}
AUDIO_FORMATS[NONE_AUDIO] = (None, None)          # 恒在最后（见 NONE_* 说明）

# 能写入工作流元数据的容器（判定依据＝保存实现里**真的会写**）：
#   视频 —— MP4 / MKV / WebM 走 PyAV 容器级 metadata；APNG / 动图WebP 走 PNG 私有块 / EXIF；
#           GIF 是 256 色调色板格式、没有元数据容器，故不打星。
#   音频 —— 三者都走 PyAV 容器级 metadata（FLAC / Opus 落 Vorbis Comment，MP3 落 ID3）。
# 注意：这两个集合**只用于「下拉加星 + 元数据开关显隐」**，不参与参数取值，
#       所以不会影响已保存的工作流。
VIDEO_META_OK = {"MP4", "MKV", "WebM", "APNG", "动图WebP"}
AUDIO_META_OK = {"FLAC", "MP3", "Opus"}

# 原生 AudioSaveHelper 的 opus 采样率白名单与质量档位
OPUS_RATES = [8000, 12000, 16000, 24000, 48000]
Q_OPUS = {"64k": 64000, "96k": 96000, "128k": 128000, "192k": 192000, "320k": 320000}
Q_MP3 = {"64k": 64000, "96k": 96000, "128k": 128000, "192k": 192000, "320k": 320000}

WATERMARK = "[Josia媒体保存]"

# 默认文件名前缀：`JosiaMedia\Media_%001%`
#   · `JosiaMedia\` ＝ output 下的子目录（不用点「选择目录」也能自动分层）
#   · `Media_`      ＝ 文件名主干（媒体通用：图片 / 视频 / 音频都适用，不再用 Pic_）
#   · `%001%`       ＝ 3 位序号占位（写在哪就替换在哪 ⇒ Media_001 / Media_002 …）
# 🔴 必须与前端 media_save.js 的 DEFAULT_PREFIX 逐字一致。
DEFAULT_PREFIX = "JosiaMedia\\Media_%001%"

# ------------------------------------------------------------------
# VAE 来源：接线 > 跨节点共享（Josia模型加载）> models/vae 目录
# ------------------------------------------------------------------
USE_JOSIA_VAE = "使用Josia模型加载VAE"     # VAE1 检测到 Josia 模型加载节点时自动选中的项
VAE1_PLACEHOLDER = "🎨 请选择模型…"        # VAE1 的默认占位符（未检测到 Josia 模型加载节点时）
PLACEHOLDER_VAE2 = "🎵 请选择模型…"        # VAE2 的默认项（占位符与模型加载节点保持一致）


def _vae_choices():
    """VAE1 下拉候选：占位符 + Josia 共享项 + models/vae 下的全部模型。"""
    try:
        names = list(folder_paths.get_filename_list("vae") or [])
    except Exception:
        names = []
    return [VAE1_PLACEHOLDER, USE_JOSIA_VAE] + sorted(names, key=str.lower)


def _vae2_choices():
    """VAE2（音频 VAE）下拉候选：占位符 + Josia 共享项 + models/vae 下的全部模型。

    🔴 与 VAE1 保持同一套候选：也提供「使用Josia模型加载VAE」。
    用户明确要求「VAE2 也要跟随 VAE1 一起自动切换」—— 以前只有 VAE1 会自动切，
    VAE2 因为没有这一项，永远停在占位符上（表现：VAE2 不联动）。
    """
    try:
        names = list(folder_paths.get_filename_list("vae") or [])
    except Exception:
        names = []
    return [PLACEHOLDER_VAE2, USE_JOSIA_VAE] + sorted(names, key=str.lower)


def _load_vae_by_name(name):
    """按文件名加载 VAE（口径与模型加载节点一致：先 models/vae，再 models/checkpoints）。"""
    if not name or name in (USE_JOSIA_VAE, VAE1_PLACEHOLDER, PLACEHOLDER_VAE2):
        return None
    path = None
    for folder in ("vae", "checkpoints"):
        try:
            p = folder_paths.get_full_path(folder, name)
        except Exception:
            p = None
        if p and os.path.isfile(p):
            path = p
            break
    if path is None:
        print(f"{WATERMARK} ⚠️ 找不到 VAE 模型文件：{name}")
        return None
    try:
        sd, meta = comfy.utils.load_torch_file(path, return_metadata=True)
        vae = comfy.sd.VAE(sd=sd, metadata=meta)
        vae.throw_exception_if_invalid()
        print(f"{WATERMARK} ✅ 已加载 VAE：{name}")
        return vae
    except Exception as e:
        print(f"{WATERMARK} ⚠️ 加载 VAE 失败（{name}）：{e}")
        return None


def _resolve_vae(wired, choice, which="vae1"):
    """决定用哪个 VAE。优先级：端口接线 > Josia 共享注册表 / models/vae。

    wired : 该端口接进来的 VAE（可为 None）
    choice: VAE1 / VAE2 下拉的当前值
    which : "vae1" | "vae2"，用于取共享注册表
    """
    if wired is not None:
        return wired                        # 接线最优先（前端会把下拉灰化提示）
    if choice in (VAE1_PLACEHOLDER, PLACEHOLDER_VAE2):
        return None                         # 占位符 = 未选择，不解码
    if choice == USE_JOSIA_VAE:
        # 🔴 VAE1 / VAE2 都走这一支（VAE2 取注册表里的音频 VAE），否则 VAE2 永远联动不上。
        key = "vae2" if which == "vae2" else "vae1"
        v = _model_registry.get_vae(key) if _model_registry is not None else None
        if v is not None:
            return v
        # 🔴 VAE2（音频 VAE）**缺失是正常的**（单 VAE 模型本来就没有音频路）⇒ 静默返回 None，
        #    别每次运行都刷一条警告；VAE1 缺失则是真问题，明确提示。
        if key == "vae1":
            print(f"{WATERMARK} ⚠️ VAE1 选了「{USE_JOSIA_VAE}」，但「Josia模型加载」还没有载入过 VAE —— "
                  f"请先运行一次模型加载节点，或在本节点给「Video_VAE」端口接线。")
        return None
    return _load_vae_by_name(choice)


# ------------------------------------------------------------------
# 文件名通配符（与 text_save.py 同一套规则 —— 用户要求「复刻不重新设计」）
# ------------------------------------------------------------------
def _sanitize_name(name):
    return re.sub(r'[\\/:*?"<>|]', '_', name)


def _format_date_time(fmt, now):
    fmt = fmt.replace("yyyy", now.strftime("%Y"))
    fmt = fmt.replace("yy", now.strftime("%y"))
    fmt = fmt.replace("MM", now.strftime("%m"))
    fmt = fmt.replace("M", str(now.month))
    fmt = fmt.replace("dd", now.strftime("%d"))
    fmt = fmt.replace("d", str(now.day))
    fmt = fmt.replace("hh", now.strftime("%H"))
    fmt = fmt.replace("h", str(now.hour))
    fmt = fmt.replace("mm", now.strftime("%M"))
    fmt = fmt.replace("m", str(now.minute))
    fmt = fmt.replace("ss", now.strftime("%S"))
    fmt = fmt.replace("s", str(now.second))
    return fmt


def _format_time_only(fmt, now):
    fmt = fmt.replace("hh", now.strftime("%H"))
    fmt = fmt.replace("h", str(now.hour))
    fmt = fmt.replace("mm", now.strftime("%M"))
    fmt = fmt.replace("m", str(now.minute))
    fmt = fmt.replace("ss", now.strftime("%S"))
    fmt = fmt.replace("s", str(now.second))
    return fmt


def _resolve_wildcards(template):
    """解析 %date% / %time% / %date:yyyyMMdd% / %time:hhmm% 等占位符。

    与 text_save.resolve_wildcards 同一套规则；`%003%` 这类序号占位由原生
    get_save_image_path 的 counter 机制负责，本函数原样保留、不重复实现。
    """
    if not template:
        return template
    now = datetime.now()
    pattern = re.compile(r'%([^%]+)%')
    result = template
    offset = 0
    for match in pattern.finditer(template):
        content = match.group(1)
        start = match.start() + offset
        end = match.end() + offset
        if content == "date":
            replacement = now.strftime("%Y-%m-%d")
        elif content == "time":
            replacement = now.strftime("%H:%M:%S")
        elif content.startswith("date:"):
            replacement = _format_date_time(content[5:], now)
        elif content.startswith("time:"):
            replacement = _format_time_only(content[5:], now)
        else:
            replacement = match.group(0)     # 纯数字序号 / 未知占位：原样保留
        result = result[:start] + replacement + result[end:]
        offset += len(replacement) - len(match.group(0))
    return result


def _split_abs_prefix(prefix):
    """拆出「用户手填的绝对路径前缀」。

    返回 (绝对目录 or None, 剩余的前缀)。
      · `D:\\out\\ComfyUI`   → ("D:\\out", "ComfyUI")
      · `D:\\out\\`           → ("D:\\out", "")      ← 以分隔符结尾视为纯目录
      · `images/ComfyUI`     → (None, 原样)          ← 相对路径，走原生 output 行为
    用户点了「选择目录」按钮后前缀里就会带上绝对路径。
    """
    if not prefix:
        return None, prefix
    p = prefix.replace("/", os.sep)
    is_abs = bool(re.match(r'^[A-Za-z]:[\\/]', p)) or p.startswith("\\\\") or p.startswith(os.sep)
    if not is_abs:
        return None, prefix
    if p.endswith(("\\", "/")):
        return p.rstrip("\\/") + os.sep, ""
    folder, name = os.path.split(p)
    return folder, name


def _next_counter(folder, name):
    """绝对路径模式下的起始序号：扫描同名文件，取最大序号 + 1（不覆盖已有产物）。

    兼容两种历史命名，否则旧产物会被当成不存在、序号从头再来 ⇒ 直接覆盖：
      · 旧：`<名>_<5位序号>_.<扩展>`（原生风格，尾部带下划线）
      · 新：`<名>_<4位序号>.<扩展>`（本节点现行，序号后无下划线）
    前缀里若写了 `%0001%` 这类数字通配符，序号出现在**通配符原来的位置**，按位置建正则。
    """
    if not os.path.isdir(folder):
        return 1
    m0 = _COUNTER_WILD_RE.search(name or "")
    if m0:
        pat = re.compile(re.escape((name or "")[:m0.start()]) + r"(\d+)"
                         + re.escape((name or "")[m0.end():]))
    else:
        pat = re.compile(re.escape(name or "") + r"_(\d+)")
    best = 0
    try:
        for f in os.listdir(folder):
            m = pat.match(os.path.splitext(f)[0])
            if m:
                best = max(best, int(m.group(1)))
    except (OSError, ValueError):
        return 1
    return best + 1


def _split_av_latent(latent):
    """把 LATENT 拆成 (视频 latent, 音频 latent)；某一路没有时为 None。

    已核 ComfyUI 源码（2026-09）确认的两条形态：
      · **联合 AV 潜空间** ⇒ `latent["samples"]` 是 NestedTensor（`is_nested=True`），
        `unbind()` 得 `[视频, 音频]`；官方视频解码取 `unbind()[0]`
        （`nodes.py` VAEDecode / VAEDecodeTiled），音频解码取 `unbind()[-1]`
        （`comfy_extras/nodes_audio.py` 的 `vae_decode_audio`）。
      · **纯音频潜空间** ⇒ `latent["samples"]["type"] == "audio"`。
    🔴 不存在 `latent["audio_latent"]` —— 那个键只出现在 conditioning 的 keyframe/ref 里。
    """
    if latent is None:
        return None, None
    samples = latent.get("samples") if isinstance(latent, dict) else None

    if getattr(samples, "is_nested", False):
        parts = list(samples.unbind())
        if len(parts) >= 2:
            vid = dict(latent)
            aud = dict(latent)
            vid["samples"] = parts[0]
            aud["samples"] = parts[-1]
            # noise_mask 只对视频路有意义，解码用不到，去掉避免形状不匹配
            vid.pop("noise_mask", None)
            aud.pop("noise_mask", None)
            return vid, aud
        if parts:
            vid = dict(latent)
            vid["samples"] = parts[0]
            return vid, None
        return None, None

    if isinstance(samples, dict) and samples.get("type") == "audio":
        return None, latent

    return latent, None


def _latent_kind(latent):
    """给前端信息窗用：潜空间的形态（图像 / 仅视频 / 音视频混合 / 纯音频 / 未知）。"""
    if latent is None:
        return ""
    samples = latent.get("samples") if isinstance(latent, dict) else None
    if samples is None:
        return "未知"
    if getattr(samples, "is_nested", False):
        try:
            return "音视频混合" if len(list(samples.unbind())) >= 2 else "仅视频"
        except Exception:
            return "音视频混合"
    if isinstance(samples, dict) and samples.get("type") == "audio":
        return "纯音频"
    try:
        if samples.dim() == 5:
            return "仅视频"
    except Exception:
        pass
    return "图像"


def _latent_routes(latent):
    """轻量判定潜空间里有没有「视频路 / 音频路」→ (有视频, 有音频)。

    🔴 只读形态、**不搬数据**：用来决定「要不要加载 VAE」——不做这一步的话，
       「不保存XX」时仍会把 VAE 从磁盘读进显存，省不掉最贵的一笔开销。
    """
    if latent is None:
        return (False, False)
    samples = latent.get("samples") if isinstance(latent, dict) else None
    if samples is None:
        return (False, False)
    if getattr(samples, "is_nested", False):          # 联合 AV：[视频, 音频]
        try:
            return (True, len(list(samples.unbind())) >= 2)
        except Exception:
            return (True, True)
    if isinstance(samples, dict) and samples.get("type") == "audio":
        return (False, True)
    return (True, False)                              # 图像 / 视频稠密张量


# ==================================================================
# 文件名组装（文本保存节点那套「数字通配符」）
# ==================================================================
# 🔴 命名规则（用户明确要求）：
#   · 用户在前缀里写了 %0001% / %003% 这类**纯数字通配符** ⇒ 它就是要放序号的位置，
#     按它的位数补零，前后分隔符（如下划线）由用户自己在前缀里写。
#   · 用户没写 ⇒ 默认在名字后面补「_ + 4 位序号」，例如 JosiaMedia → JosiaMedia_0004。
#   · **序号后面绝不再补下划线**：用户没法控制下划线之后再写内容，
#     以前所有文件名都以 "_" 结尾（JosiaMedia_00004_.png），非常不正常。
#   · （ComfyUI 原生会把前缀当成 "前缀 + _ + 序号 + _"，那个尾部下划线是它自带的。）
_COUNTER_WILD_RE = re.compile(r"%([0-9]+)%")
DEFAULT_COUNTER_WIDTH = 4


def _compose_stem(name, counter):
    """组装「不含扩展名」的文件名主干。

    序号**原地**替换通配符（通配符在中间也照样替换，不是追加到末尾）：
      `x%0001%_end` + 12 ⇒ `x0012_end`
      `shot%0001%`  + 7  ⇒ `shot0007`
    没写通配符时才退化成「名字 + _ + 4 位序号」：`JosiaMedia` + 4 ⇒ `JosiaMedia_0004`
    """
    name = name or ""
    num = str(int(counter))
    m = _COUNTER_WILD_RE.search(name)
    if not m:
        return "%s_%s" % (name, num.zfill(DEFAULT_COUNTER_WIDTH))
    width = max(1, min(12, len(m.group(1))))
    return name[:m.start()] + num.zfill(width) + name[m.end():]


def _alloc_stem(folder, name, counter, ext):
    """从 counter 起找**第一个不冲突**的序号，返回 (主干, 实际使用的序号)。

    🔴🔴 为什么必须自己找一遍（这是「同名被直接替换」的根因）：
      原生 `folder_paths.get_save_image_path()` 的 counter 只认「<prefix>_<数字>」
      这种写法 —— 它的 `map_filename()` 要求 `prefix[:-1] == 文件名主干` 且
      `prefix[-1] == "_"`。而本节点支持 `%001%` 这类**序号占位通配符**，且是
      **原地替换**（`Pic_%001%` + 1 ⇒ `Pic_001`，根本不追加 `_0001`），
      于是原生扫描**永远匹配不到** ⇒ counter 恒为 1 ⇒ 每次运行都把上一个文件覆盖掉
      （图像列表模式下一次排队执行 N 次 ⇒ N 次全写同一个名字 ⇒ 只剩最后一张）。
      实测（temp 目录，连跑 3 次）：
        无通配符  JosiaMedia        → 0001 / 0002 / 0003   ✅
        有通配符  …\\Pic_%001%      → 001  / 001  / 001    ❌（覆盖）
    这里用「目标文件是否已存在」做最终裁决，对通配符 / 非通配符 / 绝对路径
    三种模式一律成立：**绝不覆盖已有文件，只允许往后递增**。
    """
    try:
        existing = set(os.listdir(folder))
    except OSError:
        existing = set()
    c = max(1, int(counter or 1))
    stem = _compose_stem(name, c)
    guard = 0
    while (stem + "." + ext) in existing and guard < 1000000:
        c += 1
        stem = _compose_stem(name, c)
        guard += 1
    return stem, c


def _resample_frames(frames_t, src_fps, dst_fps):
    """把形状 [N,H,W,C] 的张量按输出帧率重采样（最近邻：复制/抽帧，**不插帧**）。

    输出帧数 = max(1, round(N * dst_fps / src_fps))，每张输出帧取自
    `round(j * (N-1) / (N_out-1))` 号源帧。轻量化实现，零模型、瞬时完成。
      · 单图（N=1）任意 dst_fps ⇒ 把这一帧复制 N_out 份（如 1fps×24 = 24 帧 = 1 秒静帧视频）；
      · 视频 24fps → 16fps ⇒ 抽帧；→ 30fps ⇒ 复制前帧。
    返回 (重采样后张量, 输出帧数)。
    """
    import torch as _torch  # 局部导入，避免在无 torch 环境（极少）下污染顶层
    n = frames_t.shape[0]
    if n <= 1 or dst_fps <= 0 or src_fps <= 0 or abs(dst_fps - src_fps) < 1e-9:
        return frames_t, n
    n_out = max(1, int(round(n * dst_fps / src_fps)))
    if n_out == n:
        return frames_t, n
    idx = [round(j * (n - 1) / max(1, n_out - 1)) for j in range(n_out)]
    try:
        out = frames_t[idx]
    except Exception:
        out = _torch.stack([frames_t[i] for i in idx])
    return out, n_out


# ==================================================================
# 依赖探测：决定哪些格式出现在下拉里
# ==================================================================
# 可选格式插件（AVIF / HEIF / JPEG XL）必须向 Pillow 注册保存器后才会出现在下拉里；
# Image.init() 只扫描 PIL 内置插件、不加载第三方 —— 故在此统一注册。
# 🔴 注册与探测一律走 pillow_plugins：那里会补调新版 pillow-heif 必需的
#    register_heif_opener()，且与设置面板的依赖检测是同一口径（不会两边对不上）。
try:
    import pillow_plugins as _pillow_plugins
    _pillow_plugins.ensure_registered()
except Exception:                       # 模块异常时退化为「只有内置格式」，不影响节点加载
    _pillow_plugins = None


def _available_image_formats():
    """返回 [(显示名, PIL格式名, 扩展名, 可写元数据, 支持无损)]，只含当前环境真的能保存的格式。"""
    save_table = (_pillow_plugins.save_table() if _pillow_plugins is not None
                  else (getattr(Image, "SAVE", {}) or {}))
    out = []
    for label, (fmt, ext, meta, lossless, _needs_plugin) in IMAGE_FORMATS.items():
        if fmt not in save_table:              # Pillow 没注册该保存器 → 隐藏该选项
            continue
        name = (STAR + label) if meta else label
        out.append((name, fmt, ext, meta, lossless))
    return out


IMAGE_FORMAT_CHOICES = [c[0] for c in _available_image_formats()]
# 显示名 -> 规格
IMAGE_FORMAT_MAP = {c[0]: {"fmt": c[1], "ext": c[2], "meta": c[3], "lossless": c[4],
                           "label": c[0].replace(STAR, "").strip()}
                    for c in _available_image_formats()}
IMAGE_FORMAT_ALIASES = {}      # 去掉 ⭐ 的裸名 -> 显示名（兼容老工作流/别的写法）
for _label in IMAGE_FORMAT_MAP:
    IMAGE_FORMAT_ALIASES[_label.replace(STAR, "").strip().lower()] = _label

# 「不保存图像」：不走 Pillow 保存器（fmt=None），故不参与上面的可用性筛选，
# 单独追加且恒在最后（见 NONE_* 说明）。
IMAGE_FORMAT_CHOICES.append(NONE_IMAGE)
IMAGE_FORMAT_MAP[NONE_IMAGE] = {"fmt": None, "ext": None, "meta": False,
                                "lossless": False, "label": NONE_IMAGE}
IMAGE_FORMAT_ALIASES[NONE_IMAGE.lower()] = NONE_IMAGE


def _normalize_format(value):
    """把下拉值归一化成规格 dict。不可用/不认识 → None（调用方负责降级）。"""
    if not value:
        return None
    if value in IMAGE_FORMAT_MAP:
        return IMAGE_FORMAT_MAP[value]
    key = str(value).replace(STAR, "").strip().lower()
    hit = IMAGE_FORMAT_ALIASES.get(key)
    if hit:
        return IMAGE_FORMAT_MAP[hit]
    # 退一步：按 PIL 格式名/扩展名匹配
    for _label, spec in IMAGE_FORMAT_MAP.items():
        if key in (spec["fmt"].lower(), spec["ext"].lower()):
            return spec
    return None


# ==================================================================
# 显存 / 缓存清理（核心红线：绝不卸载已加载的模型）
# ==================================================================
LAST_CLEAN_INFO = {"when": 0.0, "level": "", "freed_mb": 0.0, "cost_ms": 0}


def _vram_snapshot():
    """(free, total) 字节；无 CUDA 时返回 None。"""
    try:
        if not torch.cuda.is_available():
            return None
        free, total = torch.cuda.mem_get_info()
        return float(free), float(total)
    except Exception:
        return None


def clear_cache(level):
    """可逆地释放「无用」显存与内存，**绝不卸载模型**。

    已核实的官方源码事实（comfy/model_management.py）：
      · soft_empty_cache(force=False)  —— force 参数**完全未被使用**；CUDA 分支执行
        synchronize + empty_cache + ipc_collect，且**完全不碰 current_loaded_models**，
        因此不会卸载任何模型。MPS / XPU / NPU / MLU 分支同理。
      · cleanup_models_gc() —— 仅在检测到某个已加载模型 is_dead()（循环引用泄漏）时才
        做 gc + soft_empty_cache，属官方泄漏回收路径，同样不动活模型。
      · cleanup_models()    —— 只弹出 real_model() is None 的已死条目。
      · free_memory() / unload_all_models() —— **会真的卸载模型**（free_memory(1e30)），
        本节点**刻意不调用**：卸载后下次出图要重新加载，热启动就慢了。

    两档：
      轻度：gc.collect() + soft_empty_cache()
            → 回收 Python 层无引用张量；释放 CUDA 缓存分配器里「已预留但空闲」的块。
      深度：在轻度之上追加官方泄漏回收 cleanup_models_gc() + cleanup_models() + 二次 gc，
            专治反复运行后显存缓慢爬升（模型代码里有循环引用导致张量无法回收）。
            不重复调 soft_empty_cache —— 官方那条路径内部需要时自己会调。
    """
    t0 = time.time()
    before = _vram_snapshot()
    did = False

    if level and level != "关":
        try:
            gc.collect()
            comfy.model_management.soft_empty_cache()
            did = True
        except Exception as e:
            print(f"{WATERMARK} ❌ 轻量清理失败：{e}")

    if level == "深度":
        try:
            # 官方泄漏回收路径：只在发现「已死」模型时才真正动手，活的模型不受影响
            mm = comfy.model_management
            if hasattr(mm, "cleanup_models_gc"):
                mm.cleanup_models_gc()
            if hasattr(mm, "cleanup_models"):
                mm.cleanup_models()
            gc.collect()
            did = True
        except Exception as e:
            print(f"{WATERMARK} ❌ 深度回收失败：{e}")

    after = _vram_snapshot()
    freed = 0.0
    if before and after:
        freed = max(0.0, (after[0] - before[0]) / (1024.0 * 1024.0))
    cost = int((time.time() - t0) * 1000)

    if did:
        print(f"{WATERMARK} 🧹 缓存清理[{level}] 完成：释放约 {freed:.0f} MB，"
              f"耗时 {cost} ms（模型保持常驻，未卸载）")
    else:
        print(f"{WATERMARK} ℹ️ 缓存清理关闭，未执行")

    LAST_CLEAN_INFO.update(when=time.time(), level=level or "关", freed_mb=freed, cost_ms=cost)
    return did


# ==================================================================
# 元数据
# ==================================================================
def _png_metadata(prompt, extra_pnginfo, write_meta):
    """原生 SaveImage 行为：prompt / extra_pnginfo 各写一条 PNG 文本块。"""
    if not write_meta or args.disable_metadata:
        return None
    m = PngInfo()
    written = 0
    if prompt is not None:
        m.add_text("prompt", json.dumps(prompt))
        written += 1
    if extra_pnginfo is not None:
        for x in extra_pnginfo:
            m.add_text(x, json.dumps(extra_pnginfo[x]))
            written += 1
    # 一个文本块都没写时不返回空对象。
    # ⚠️ 不能用 m.text 判空：部分 Pillow 版本的 PngInfo 没有 .text 属性（只存 .chunks），
    #    曾经因此把所有 PNG 元数据静默丢掉 —— 图片拖回 ComfyUI 就无法还原工作流。
    return m if written else None


def _exif_bytes(prompt, extra_pnginfo, write_meta):
    """非 PNG 格式的元数据载体：EXIF UserComment（0x9286，EXIF 规范要求 UNICODE 前缀）。"""
    if not write_meta or args.disable_metadata:
        return None
    payload = {}
    if prompt is not None:
        payload["prompt"] = prompt
    if extra_pnginfo is not None:
        for x in extra_pnginfo:
            payload[x] = extra_pnginfo[x]
    if not payload:
        return None
    try:
        ex = Image.Exif()
        ex[0x9286] = b"UNICODE\x00" + json.dumps(payload, ensure_ascii=False).encode("utf-8")
        return ex.tobytes()
    except Exception as e:
        print(f"{WATERMARK} ⚠️ EXIF 元数据构造失败（继续保存，不带元数据）：{e}")
        return None


# ==================================================================
# 张量 → PIL
# ==================================================================
def _tensor_to_pil(image, keep_alpha=True):
    arr = np.clip(255.0 * image.cpu().numpy(), 0, 255).astype(np.uint8)
    img = Image.fromarray(arr)
    if not keep_alpha and img.mode in ("RGBA", "LA"):
        img = img.convert("RGB")
    return img


def _prepare_image(img, spec):
    """按格式要求转换像素模式（目前只有 PBM 需要转成 1 位位图）。"""
    mode = _SAVE_MODE.get(spec.get("label") if isinstance(spec, dict) else None)
    if mode and img.mode != mode:
        return img.convert(mode)
    return img


def _atomic_save_img(img, path, save_kwargs):
    """原子写入：先写 .tmp 再改名，避免半截图（中断/崩溃时不留坏文件）。"""
    tmp = path + ".tmp"
    try:
        img.save(tmp, **save_kwargs)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except Exception:
                pass
        raise


# 工具：张量落盘前的清洗
def _to_save_tensor(t):
    """洗成 safetensors 能写的样子：**CPU + 连续**。

    safetensors 直接拒收（1）非连续张量（2）显存里的张量，而两条都可能在
    「免解码直通」路径上命中（采样完的 latent 常常还在显存里）。提前在这里统一处理，
    避免在写盘那一刻才炸；已是 CPU 且连续时原样返回，不产生额外拷贝。
    """
    try:
        t = t.detach()
    except Exception:
        pass
    try:
        if getattr(t, "device", None) is not None and getattr(t.device, "type", "cpu") != "cpu":
            t = t.to("cpu")
    except Exception:
        pass
    try:
        if not t.is_contiguous():
            t = t.contiguous()
    except Exception:
        pass
    return t


# ==================================================================
# 节点
# ==================================================================
class JosiaMediaSave:
    """🗂️ Josia 媒体保存

    一个节点吃下所有产物：图像 / 潜空间（自带 VAE 解码，含分块）/ 图像批次成视频 / 音频，
    全部按原生同名节点的方式落盘，并把图像继续透传给下游。"""

    CATEGORY = "⚡️JosiaNodes"
    FUNCTION = "save_media"
    OUTPUT_NODE = True

    RETURN_TYPES = ("IMAGE", "STRING", "LATENT", "LATENT", "LATENT")
    RETURN_NAMES = ("图像", "路径", "Latent", "Video_Latent", "Audio_Latent")
    OUTPUT_TOOLTIPS = (
        "透传给下游的图像（「图像」或「Latent」解码后的结果）。",
        "本次落盘的主文件路径（相对 ComfyUI 输出目录）。",
        "原样透传输入 Latent（与旧版「潜空间」同名输出等价），便于双采样器等工作流二次利用。",
        "从输入 Latent 拆出的**视频路**潜空间（联合 AV 潜空间 unbind()[0]；非 AV 时为 None）。",
        "从输入 Latent 拆出的**音频路**潜空间（联合 AV 潜空间 unbind()[-1] / 纯音频潜空间；非 AV 时为 None）。",
    )

    DESCRIPTION = """🗂️ Josia 媒体保存（全能落地节点）

把原生 Save Image / Save Animated PNG / Save Animated WEBP / Save WEBM / Save Video /
Save Audio / Save Latent 的能力汇聚到一个节点：

· 图像：接 IMAGE 直接显示+保存，同时继续向下游输出
· Latent：接 LATENT + VAE 自行解码（可选分块解码，专治大图 / 小显存 OOM），并原样透传供下游复用
· 视频：图像批次 + 帧率 → MP4 / MKV / WebM / GIF / APNG / 动图WebP；
        接 VIDEO 输入则按原样转存（mp4 / mkv / webm）
· 音频：AUDIO → FLAC / MP3 / Opus
· Latent：可选把 .latent 一起落地（Video_Latent / Audio_Latent 单独输出音视频潜空间）

格式名前的 ⭐ 表示该格式能写入工作流元数据（PNG 私有块 / EXIF UserComment）。
「清理缓存」只在解码前或保存后回收无引用张量与 CUDA 空闲块，**绝不卸载已加载模型**，
所以重复运行工作流不会变慢。

⚡「不保存X」＝免解码直通：图像 / 视频 / 音频三路都选它时，本节点**不加载 VAE、不解码**，
只把输入的 Latent 原样落盘（毫秒级）。这样大批量、大分辨率的任务可以先一口气把潜空间
全部存下来，等工作流结束后释放全部显存，再单独逐个解码 —— 解码时显存只装一个 VAE，
既不会和主模型抢显存导致 OOM，也不必重复跑采样。三路都选「不保存X」时会自动强制落盘
.latent（本节点接入工作流必须留下产物，绝不空转）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "filename_prefix": ("STRING", {
                    "default": DEFAULT_PREFIX,
                    "tooltip":
                        "文件名前缀，可含子目录与通配符。\n"
                        "• 默认 `JosiaMedia\\Media_%001%` ＝ 写到 output\\JosiaMedia\\ 下，"
                        "文件名 Media_001 / Media_002 …（`%001%` 是 3 位序号占位，写在哪个位置就替换在哪个位置）。\n"
                        "• 想换层就改前缀里的目录部分（如 `JosiaMedia\\视频\\A_%0001%`），"
                        "「📂 打开」会直接定位到那一层。\n"
                        "• 时间占位：%date% / %time% / %date:yyyyMMdd% / %time:hhmm%。\n"
                        "• 不写序号占位时，自动在名字后面补「_ + 4 位序号」。",
                }),
                "图像格式": (IMAGE_FORMAT_CHOICES or ["⭐ PNG"], {
                    "default": "⭐ PNG" if "⭐ PNG" in IMAGE_FORMAT_CHOICES else (IMAGE_FORMAT_CHOICES or ["⭐ PNG"])[0],
                    "tooltip": "⭐ = 支持写入工作流元数据。仅列出当前环境真的能保存的格式。"
                               "三路都选「不保存X」⇒ 免解码直通：连 VAE 都不加载，直接把 Latent 落盘。",
                }),
                "无损": ("BOOLEAN", {
                    "default": True,
                    "label_on": "无损模式", "label_off": "质量模式",
                    "tooltip": "无损模式＝像素逐位一致（体积最大、最慢）；质量模式＝按「质量」编码（体积小得多）。仅对支持无损的格式生效（PNG / WebP / AVIF / HEIF / JPEG XL / TIFF / JPEG 2000）。PNG 恒无损，本开关对它无意义。",
                }),
                "质量": ("INT", {
                    "default": 90, "min": 1, "max": 100, "step": 1,
                    "tooltip": "「质量模式」下的画质（越高越好、文件越大）。「无损模式」忽略此项。",
                }),
                "压缩级别": ("INT", {
                    "default": 4, "min": 0, "max": 9, "step": 1,
                    "tooltip": "PNG / APNG 压缩级别，原生 Save Image 默认 4。",
                }),
                "视频容器": (list(VIDEO_CONTAINERS.keys()), {
                    "default": NONE_VIDEO,
                    "tooltip": "由图像批次合成视频；接 VIDEO 输入时也会按此容器转存。"
                               "选「不保存视频」表示不输出视频：这一路不做任何解码，"
                               "三路都选「不保存X」时连 VAE 都不加载（毫秒级落盘潜空间），"
                               "并保证至少产出 .latent —— 工作流不会空转。",
                }),
                "帧率": ("FLOAT", {
                    "default": 24.0, "min": 0.01, "max": 1000.0, "step": 0.01,
                    "tooltip": "每秒播放多少张图（＝每张图停留 1/帧率 秒）："
                               "1 ⇒ 每张 1 秒，0.2 ⇒ 每张 5 秒，0.1 ⇒ 每张 10 秒 —— 用图片做幻灯片就调小它。"
                               "原生 Save WEBM 默认 24、动图默认 6。",
                }),
                "视频编码": (list(VIDEO_ENCODERS.keys()), {
                    "default": "h264",
                    "tooltip": "容器放不下的编码会自动换成该容器的默认编码。",
                }),
                "视频质量": ("INT", {
                    "default": 23, "min": 0, "max": 63, "step": 1,
                    "tooltip": "CRF：数值越小画质越高、文件越大（原生 Save WEBM 默认 32）。",
                }),
                "输出帧率": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 1000.0, "step": 0.01,
                    "tooltip": "仅视频 / 动图容器生效：实际**输出**的帧率（播放时的帧数）。\n"
                               "• 0（默认）＝跟随「帧率」，不转换。\n"
                               "• 大于 0＝把源帧按输出帧率重采样：输出帧数 = 源帧数 × 输出帧率 ÷ 输入帧率。\n"
                               "  例① 图片以「帧率=1」做 1 张图 → 输出帧率=24 ⇒ 该图被拆成 24 帧、合成 1 秒视频；\n"
                               "  例② MiniMax 视频 24fps → 输出 16 或 30 ⇒ 自动抽帧 / 复制前帧。\n"
                               "（轻量化实现＝复制 / 抽帧，不插帧；真·运动插帧需 RIFE 等重模型，不在本节点范畴。）",
                }),
                "音频格式": (list(AUDIO_FORMATS.keys()), {
                    "default": NONE_AUDIO,
                    "tooltip": "接入音频时按此格式落盘：FLAC（无损）/ MP3 / Opus。"
                               "选「不保存音频」表示不输出音频：音频路不加载 VAE、不解码。"
                               "注意：选它时不会再去加载音频 VAE，也不会提示「缺音频 VAE」。",
                }),
                "音频质量": (list(Q_OPUS.keys()), {
                    "default": "128k",
                    "tooltip": "有损音频码率；FLAC 忽略此项。",
                }),
                "保存潜空间": ("BOOLEAN", {
                    "default": False,
                    "label_on": "✅ 落盘 .latent", "label_off": "❎ 不保存",
                    "tooltip": "额外把潜空间存成 .latent 文件（与原生 Save Latent 同格式）。"
                               "⚡ 这是「先存后解」的关键：可以先批量跑完只存 Latent，"
                               "关掉工作流释放全部显存后，再用「Josia加载Latent」逐个解码成成品"
                               "（解码只需缓存 VAE，成功率与效率都更高）。",
                }),
                "解码方式": (["自动", "直接解码", "分块解码"], {
                    "default": "自动",
                    "tooltip": "自动 = 先直接解码，显存不够（OOM）时自动改用分块解码重试。",
                }),
                "分块尺寸": (["256", "384", "512", "768", "1024", "1536", "2048"], {
                    "default": "512",
                    "tooltip": "分块解码的块大小（像素），原生 VAEDecodeTiled 默认 512。8G 显存建议 512，6G 建议 256~384。",
                }),
                "分块重叠": (["0", "32", "64", "96", "128", "192", "256"], {
                    "default": "64",
                    "tooltip": "相邻分块之间的空间重叠像素，用来消除拼接接缝（原生默认 64）。越大越平滑、越慢。",
                }),
                "时间分块": (["8", "16", "32", "48", "64", "96", "128"], {
                    "default": "64",
                    "tooltip": "仅视频 VAE 生效：一次解码多少帧（原生默认 64）。",
                }),
                "时间重叠": (["4", "8", "12", "16", "24", "32"], {
                    "default": "8",
                    "tooltip": "仅视频 VAE 生效：帧与帧之间的重叠帧数，消除时间方向的闪烁/接缝（原生默认 8）。",
                }),
                "解码精度": (["自动", "fp32", "fp16", "bf16"], {
                    "default": "自动",
                    "tooltip": "强制 VAE 解码精度，专治黑图/雪花。fp32 最稳但最吃显存。",
                }),
                "清理缓存": (["关", "轻度", "深度"], {
                    "default": "关",
                    "tooltip": "只回收无引用张量与 CUDA 空闲块，绝不卸载已加载模型，热启动不降速。",
                }),
                "清理时机": (["解码前", "解码后"], {
                    "default": "解码前",
                    "tooltip": "解码前清理可降低解码峰值显存；解码后清理可为下一次运行腾空间。",
                }),
                "写入元数据": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ 写入", "label_off": "❎ 不写",
                    "tooltip": "把工作流写入文件（PNG 私有块 / 其他格式的 EXIF UserComment）。",
                }),
                "临时预览": ("BOOLEAN", {
                    "default": False,
                    "label_on": "✅ 只写 temp", "label_off": "❎ 写 output",
                    "tooltip": "对齐原生 Preview Image：写临时目录、前缀加 _temp_ 随机串、压缩级别 1。",
                }),
                # ⚠️ 新增参数一律追加在 required 末尾 —— widgets_values 是按顺序序列化的，
                #    插到中间会让已保存工作流的取值整体错位。
                "VAE1": (_vae_choices(), {
                    "default": VAE1_PLACEHOLDER,
                    "tooltip":
                        "解码用的主 VAE。\n"
                        "• 「使用Josia模型加载VAE」= 直接复用「Josia模型加载」节点已载入的 VAE，"
                        "**不需要连线**（出厂默认）。\n"
                        "• 也可手动从 models/vae 里选一个，此时会按所选文件另行加载。\n"
                        "• 一旦给「Video_VAE」端口接了线，本项自动灰化 —— 接线优先。\n"
                        "• 备注：多个模型加载节点共存时，以最近一次加载的为准。",
                }),
                "VAE2": (_vae2_choices(), {
                    "default": PLACEHOLDER_VAE2,
                    "tooltip":
                        "解码**音频路**潜空间用的 VAE（LTX / MiniMax H3 等双 VAE 模型）。\n"
                        "• 默认「🎵 请选择模型…」= 不使用音频 VAE，音频路不会解码。\n"
                        "• 想同时保存音频时，在这里选模型，或在「Audio_VAE」端口连线。\n"
                        "• 与 VAE1 完全独立：VAE1 保持默认也能单独指定音频 VAE。",
                }),
            },
            "optional": {
                "图像": ("IMAGE", {"tooltip": "直接保存的图像（像原生 Save Image），同时继续透传给下游。"}),
                "Latent": ("LATENT", {"tooltip":
                    "潜空间。本节点自带 VAE 解码，无需再接 VAE Decode 节点。\n"
                    "• 双 VAE 视频模型（LTX / MiniMax H3 等）的联合 AV 潜空间会自动分离：\n"
                    "  视频路用 VAE 解码、音频路用「Audio_VAE」解码，不会只解一半。"}),
                "Video_VAE": ("VAE", {"tooltip":
                    "解码「Latent」用的主 VAE（视频路）。\n"
                    "• 接了这里 ⇒ 下方 VAE1 下拉自动灰化，以接线为准。\n"
                    "• 不接也可以：VAE1 选「使用Josia模型加载VAE」即可直接复用模型加载节点载入的 VAE。"}),
                "Audio_VAE": ("VAE", {"tooltip":
                    "解码「Latent」里**音频路**用的 VAE（LTX / MiniMax H3 等双 VAE 模型）。\n"
                    "• 接了这里 ⇒ 下方 VAE2 下拉自动灰化。\n"
                    "• 潜空间里检测到音频路、但这里没接 VAE 时会明确告警，而不是静默丢掉音频。"}),
                "视频": ("VIDEO", {"tooltip": "已有的视频对象，按所选容器原样转存。"}),
                "音频": ("AUDIO", {"tooltip": "要落盘的音频。"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    # 🔴🔴 保存节点语义：ComfyUI 默认对「输入完全相同」的节点命中执行缓存、不再重跑，
    #    表现就是「点了执行却没新产物」。本节点是落地终端，每次执行都应真正落盘，
    #    故让缓存键永远不匹配（nan != nan 恒成立）⇒ 每次都重新执行。
    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    # ------------------------------------------------------------------
    # 解码
    # ------------------------------------------------------------------
    def _apply_precision(self, vae, precision):
        if precision == "自动":
            return vae
        dt = {"fp32": torch.float32, "fp16": torch.float16, "bf16": torch.bfloat16}.get(precision)
        if dt is None or vae is None:
            return vae
        try:
            v = vae.clone()
            model = getattr(v, "first_stage_model", None)
            if model is not None:
                model.to(dt)
            print(f"{WATERMARK} 🎯 已强制 VAE 解码精度：{precision}")
            return v
        except Exception as e:
            print(f"{WATERMARK} ⚠️ 强制精度失败，回退自动：{e}")
            return vae

    def _decode_tiled(self, vae, latent, tile_size, overlap, temporal_size, temporal_overlap):
        """逐字复刻原生 VAEDecodeTiled.decode 的语义。"""
        if tile_size < overlap * 4:
            overlap = tile_size // 4
        if temporal_size < temporal_overlap * 2:
            temporal_overlap = temporal_overlap // 2

        try:
            temporal_compression = vae.temporal_compression_decode()
        except Exception:
            temporal_compression = None
        if temporal_compression is not None:
            temporal_size = max(2, temporal_size // temporal_compression)
            temporal_overlap = max(1, min(temporal_size // 2, temporal_overlap // temporal_compression))
        else:
            temporal_size = None
            temporal_overlap = None

        lat = latent["samples"]
        if getattr(lat, "is_nested", False):
            lat = lat.unbind()[0]

        try:
            compression = vae.spacial_compression_decode()
        except Exception:
            compression = 8

        try:
            images = vae.decode_tiled(
                lat,
                tile_x=tile_size // compression,
                tile_y=tile_size // compression,
                overlap=overlap // compression,
                tile_t=temporal_size,
                overlap_t=temporal_overlap,
            )
        except TypeError:
            # 老版本签名（与更早的原生实现一致）
            images = vae.decode_tiled(
                lat,
                tile_x=tile_size // compression,
                tile_y=tile_size // compression,
                overlap=overlap // compression,
                temporal_size=temporal_size,
                temporal_overlap=temporal_overlap,
            )
        if len(images.shape) == 5:      # Combine batches（原生同样处理）
            images = images.reshape(-1, images.shape[-3], images.shape[-2], images.shape[-1])
        return images

    def _decode_plain(self, vae, latent):
        """逐字复刻原生 VAEDecode.decode 的语义。"""
        lat = latent["samples"]
        if getattr(lat, "is_nested", False):
            lat = lat.unbind()[0]
        images = vae.decode(lat)
        if len(images.shape) == 5:
            images = images.reshape(-1, images.shape[-3], images.shape[-2], images.shape[-1])
        return images

    def _decode_audio(self, vae, latent):
        """逐字复刻原生 vae_decode_audio 的语义（comfy_extras/nodes_audio.py）。

        音频路在联合 AV 潜空间里位于 unbind() 的**最后一路**，
        恰好与视频路取 unbind()[0] 对称。
        """
        lat = latent["samples"]
        if getattr(lat, "is_nested", False):
            lat = lat.unbind()[-1]
        audio = vae.decode(lat).movedim(-1, 1)
        # 与官方一致的幅度归一（不归一的话波形普遍过小）
        std = torch.std(audio, dim=[1, 2], keepdim=True) * 5.0
        std[std < 1.0] = 1.0
        audio /= std
        sr = getattr(vae, "audio_sample_rate_output",
                     getattr(vae, "audio_sample_rate", 44100))
        if "sample_rate" in latent:
            sr = latent["sample_rate"]
        print(f"{WATERMARK} 🎵 已从潜空间解出音频：采样率 {sr}，时长 {audio.shape[-1] / max(1, int(sr)):.2f}s")
        return {"waveform": audio, "sample_rate": sr}

    def _decode(self, vae, latent, mode, tile, overlap, t_size, t_overlap, precision):
        if latent is None:
            return None
        if vae is None:
            raise ValueError("接了「Latent」但没有接「Video_VAE」，无法解码。")
        vae = self._apply_precision(vae, precision)

        if mode == "分块解码":
            return self._decode_tiled(vae, latent, tile, overlap, t_size, t_overlap)

        try:
            return self._decode_plain(vae, latent)
        except torch.cuda.OutOfMemoryError:
            if mode != "自动":
                raise
            print(f"{WATERMARK} ⚠️ 直接解码显存不足，自动改用分块解码重试…")
            clear_cache("深度")
            return self._decode_tiled(vae, latent, tile, overlap, t_size, t_overlap)

    # ------------------------------------------------------------------
    # 保存：图像
    # ------------------------------------------------------------------
    def _image_save_kwargs(self, spec, lossless, quality, compress_level, exif, fmt):
        kw = {}
        if fmt == "PNG":
            kw["compress_level"] = compress_level
            return kw
        if fmt == "JPEG":
            kw["quality"] = quality
            kw["optimize"] = True
            kw["progressive"] = True
            return kw
        if fmt == "WEBP":
            if lossless:
                kw["lossless"] = True
                kw["quality"] = 100
            else:
                kw["quality"] = quality
                kw["method"] = 4 if quality >= 60 else 0     # 对齐原生 method 预设
            return kw
        if fmt == "AVIF":
            kw["quality"] = 100 if lossless else quality
            kw["speed"] = 6
            return kw
        if fmt == "JXL":
            kw["lossless"] = bool(lossless)
            kw["quality"] = quality
            return kw
        if fmt == "TIFF":
            kw["compression"] = "tiff_lzw"
            return kw
        if fmt == "JPEG2000":
            kw["irreversible"] = not lossless
            if not lossless:
                kw["quality_mode"] = "rates"
                kw["quality_layers"] = [max(0.1, (100 - quality) / 100.0 * 8.0)]
            return kw
        return kw

    def _save_still(self, img, spec, folder, name, counter, lossless, quality,
                    compress_level, prompt, extra_pnginfo, write_meta, results):
        fmt, ext, meta_ok, _lossless_ok = spec["fmt"], spec["ext"], spec["meta"], spec["lossless"]
        stem, counter = _alloc_stem(folder, name, counter, ext)   # 🔴 绝不覆盖已有文件
        self._last_counter = counter
        file = stem + "." + ext
        path = os.path.join(folder, file)
        img = _prepare_image(img, spec)

        kwargs = {"format": fmt}
        kwargs.update(self._image_save_kwargs(spec, lossless, quality, compress_level, None, fmt))

        if meta_ok:
            if fmt == "PNG":
                pnginfo = _png_metadata(prompt, extra_pnginfo, write_meta)
                if pnginfo is not None:
                    kwargs["pnginfo"] = pnginfo
            else:
                exif = _exif_bytes(prompt, extra_pnginfo, write_meta)
                if exif:
                    kwargs["exif"] = exif

        # 元数据不被支持 / 构造失败时不阻断保存
        try:
            _atomic_save_img(img, path, kwargs)
        except Exception as e:
            if "exif" in kwargs:
                print(f"{WATERMARK} ⚠️ {fmt} 不接受 EXIF，改存不带元数据：{e}")
                kwargs.pop("exif", None)
                _atomic_save_img(img, path, kwargs)
            else:
                raise

        results["images"].append({"filename": file, "subfolder": _rel_sub(folder), "type": results["type"]})
        return file

    # ------------------------------------------------------------------
    # 保存：动图 / 视频
    # ------------------------------------------------------------------
    def _save_animated_pillow(self, container, images_t, folder, name, counter, fps,
                              lossless, quality, compress_level, prompt, extra_pnginfo,
                              write_meta, results):
        ext = VIDEO_CONTAINERS[container][0]
        stem, counter = _alloc_stem(folder, name, counter, ext)   # 🔴 绝不覆盖已有文件
        self._last_counter = counter
        file = stem + "." + ext
        path = os.path.join(folder, file)
        dur = max(1, int(1000.0 / max(0.01, fps)))
        pil = [_tensor_to_pil(im) for im in images_t]

        if container == "GIF":
            pil = [p.convert("P", palette=Image.ADAPTIVE) for p in pil]
            kw = {"format": "GIF", "save_all": True, "append_images": pil[1:],
                  "duration": dur, "loop": 0, "optimize": False}
        elif container == "APNG":
            kw = {"format": "PNG", "save_all": True, "append_images": pil[1:],
                  "duration": dur, "loop": 0, "compress_level": compress_level}
            md = _png_metadata(prompt, extra_pnginfo, write_meta)
            if md is not None:
                kw["pnginfo"] = md
        else:   # 动图WebP（原生存法：lossless / quality / method）
            kw = {"format": "WEBP", "save_all": True, "append_images": pil[1:],
                  "duration": dur, "loop": 0, "lossless": bool(lossless),
                  "quality": 100 if lossless else quality, "method": 4}
            exif = _exif_bytes(prompt, extra_pnginfo, write_meta)
            if exif:
                kw["exif"] = exif

        try:
            _atomic_save_img(pil[0], path, kw)
        except Exception as e:
            if "exif" in kw:
                print(f"{WATERMARK} ⚠️ 动图 WebP 不接受 EXIF，改存不带元数据：{e}")
                kw.pop("exif", None)
                _atomic_save_img(pil[0], path, kw)
            else:
                raise

        results["images"].append({"filename": file, "subfolder": _rel_sub(folder), "type": results["type"]})
        results["animated"] = True
        return file

    def _save_video_av(self, container, images_t, folder, name, counter, fps, codec, crf,
                       prompt, extra_pnginfo, write_meta, results, video_obj=None):
        if av is None:
            raise RuntimeError("未安装 PyAV（av），无法写出视频。请在设置里安装依赖。")

        ext = VIDEO_CONTAINERS[container][0]
        stem, counter = _alloc_stem(folder, name, counter, ext)   # 🔴 绝不覆盖已有文件
        self._last_counter = counter
        file = stem + "." + ext
        path = os.path.join(folder, file)

        if video_obj is not None:
            # 已经是视频对象：走原生 SaveVideo 的转存路径
            try:
                from comfy_api.latest import Types as _Types
                meta = None
                if write_meta and not args.disable_metadata:
                    meta = {}
                    if prompt is not None:
                        meta["prompt"] = prompt
                    if extra_pnginfo is not None:
                        meta.update(extra_pnginfo)
                    meta = meta or None
                codec_name = "auto" if codec not in CONTAINER_CODECS.get(container, ()) else codec
                video_obj.save_to(
                    path,
                    format=_Types.VideoContainer(container.lower()),
                    codec=_Types.VideoCodec(codec_name),
                    metadata=meta,
                    crf=float(crf),
                )
            except Exception as e:
                print(f"{WATERMARK} ⚠️ 视频转存失败（{e}），改用图像通道重编码")
                video_obj = None

        if video_obj is None:
            use_codec = codec if codec in CONTAINER_CODECS.get(container, ()) else \
                ("vp9" if container == "WebM" else "h264")
            encoder = VIDEO_ENCODERS.get(use_codec, "libx264")
            save_alpha = images_t.shape[-1] == 4 and use_codec == "vp9"

            container_obj = av.open(path, mode="w")
            if write_meta and not args.disable_metadata:
                try:
                    if prompt is not None:
                        container_obj.metadata["prompt"] = json.dumps(prompt)
                    if extra_pnginfo is not None:
                        for x in extra_pnginfo:
                            container_obj.metadata[x] = json.dumps(extra_pnginfo[x])
                except Exception:
                    pass

            stream = container_obj.add_stream(encoder, rate=Fraction(round(fps * 1000), 1000))
            stream.width = images_t.shape[-2]
            stream.height = images_t.shape[-3]
            if use_codec == "vp9":
                stream.pix_fmt = "yuva420p" if save_alpha else "yuv420p"
            else:
                stream.pix_fmt = "yuv420p"
            stream.bit_rate = 0
            stream.options = {"crf": str(int(crf))}
            if use_codec == "av1":
                stream.options["preset"] = "6"

            for frame in images_t:
                if save_alpha:
                    nd = torch.clamp(frame[..., :4] * 255, 0, 255).to(torch.uint8).numpy()
                    vf = av.VideoFrame.from_ndarray(nd, format="rgba")
                else:
                    nd = torch.clamp(frame[..., :3] * 255, 0, 255).to(torch.uint8).numpy()
                    vf = av.VideoFrame.from_ndarray(nd, format="rgb24")
                for packet in stream.encode(vf):
                    container_obj.mux(packet)
            container_obj.mux(stream.encode())
            container_obj.close()

        results["images"].append({"filename": file, "subfolder": _rel_sub(folder), "type": results["type"]})
        results["animated"] = True
        return file

    # ------------------------------------------------------------------
    # 保存：音频 / 潜空间
    # ------------------------------------------------------------------
    def _save_audio(self, audio, container_name, quality, folder, name, counter,
                    prompt, extra_pnginfo, write_meta, results):
        if av is None:
            raise RuntimeError("未安装 PyAV（av），无法写出音频。")
        # 🔴 用 .get 取值：老工作流可能存着已下架的「关」—— DirectWrite 会 KeyError 崩节点。
        fmt = (AUDIO_FORMATS.get(container_name) or (None, None))[0]
        if fmt is None:                       # 「不保存音频」/ 老工作流遗留的「关」
            return None

        meta = {}
        if write_meta and not args.disable_metadata:
            if prompt is not None:
                meta["prompt"] = json.dumps(prompt)
            if extra_pnginfo is not None:
                for x in extra_pnginfo:
                    meta[x] = json.dumps(extra_pnginfo[x])

        waveform_all = audio["waveform"].cpu()
        results_audio = []
        for batch_number, waveform in enumerate(waveform_all):
            # 🔴 绝不覆盖已有文件：从 counter 起找第一个空闲序号
            _astem, counter = _alloc_stem(folder, name.replace('%batch_num%', str(batch_number)),
                                          counter, fmt)
            self._last_counter = counter
            fname = _astem + "." + fmt
            out_path = os.path.join(folder, fname)
            sample_rate = audio["sample_rate"]

            if fmt == "opus":
                if sample_rate > 48000:
                    sample_rate = 48000
                elif sample_rate not in OPUS_RATES:
                    for rate in sorted(OPUS_RATES):
                        if rate > sample_rate:
                            sample_rate = rate
                            break
                    if sample_rate not in OPUS_RATES:
                        sample_rate = 48000
                if sample_rate != audio["sample_rate"]:
                    try:
                        import torchaudio
                        waveform = torchaudio.functional.resample(waveform, audio["sample_rate"], sample_rate)
                    except Exception as e:
                        print(f"{WATERMARK} ⚠️ 无法重采样到 Opus 支持率（{e}），改用 48000 直写")

            layout = "mono" if waveform.shape[0] == 1 else "stereo"
            out = av.open(out_path, mode="w", format=fmt)
            for k, v in meta.items():
                try:
                    out.metadata[k] = v
                except Exception:
                    pass

            if fmt == "opus":
                st = out.add_stream("libopus", rate=sample_rate, layout=layout)
                st.bit_rate = Q_OPUS.get(quality, 128000)
            elif fmt == "mp3":
                st = out.add_stream("libmp3lame", rate=sample_rate, layout=layout)
                st.bit_rate = Q_MP3.get(quality, 128000)
            elif fmt == "wav":
                # 无损 PCM，忽略码率（quality 不生效）
                st = out.add_stream("pcm_s16le", rate=sample_rate, layout=layout)
            else:
                st = out.add_stream("flac", rate=sample_rate, layout=layout)

            if fmt == "wav":
                # WAV 走 16-bit PCM，需要把 float 量化到 int16
                wf = (waveform.clamp(-1.0, 1.0) * 32767.0).round().to(torch.int16)
                frame = av.AudioFrame.from_ndarray(
                    wf.movedim(0, 1).reshape(1, -1).numpy(), format="s16", layout=layout)
            else:
                frame = av.AudioFrame.from_ndarray(
                    waveform.movedim(0, 1).reshape(1, -1).float().numpy(), format="flt", layout=layout)
            frame.sample_rate = sample_rate
            frame.pts = 0
            out.mux(st.encode(frame))
            out.mux(st.encode(None))
            out.close()

            results_audio.append({"filename": fname, "subfolder": _rel_sub(folder), "type": results["type"]})
            counter += 1

        results["audio"].extend(results_audio)
        return results_audio[0]["filename"] if results_audio else None

    def _save_latent(self, latent, folder, name, counter, prompt, extra_pnginfo, results):
        stem, counter = _alloc_stem(folder, name, counter, "latent")   # 🔴 绝不覆盖已有文件
        self._last_counter = counter
        file = stem + ".latent"
        path = os.path.join(folder, file)
        metadata = None
        if not args.disable_metadata:
            metadata = {"prompt": json.dumps(prompt) if prompt is not None else ""}
            if extra_pnginfo is not None:
                for x in extra_pnginfo:
                    metadata[x] = json.dumps(extra_pnginfo[x])
        output = {"latent_format_version_0": torch.tensor([])}
        samples = latent.get("samples") if isinstance(latent, dict) else latent
        if getattr(samples, "is_nested", False):
            # 🔴 联合 AV 潜空间是 NestedTensor，safetensors **拒绝写入**（实测 torch 2.13 报
            #    “You are trying to save a sparse tensors … make it a dense tensor”），
            #    以前直接崩在写盘这一步 —— 而「先批量存 latent、之后单独解码」的主力场景
            #    （视频 / 音视频生成）恰好就是这种潜空间。故按路拆开写，并留下标记键，
            #    由「Josia加载Latent」读回时原样重组成 NestedTensor。
            parts = list(samples.unbind())
            output["josia_av_nested"] = torch.tensor([1])
            output["josia_av_count"] = torch.tensor([len(parts)])
            for i, p in enumerate(parts):
                output[f"latent_av_part_{i}"] = _to_save_tensor(p)
        else:
            output["latent_tensor"] = _to_save_tensor(samples)
        comfy.utils.save_torch_file(output, path, metadata=metadata)
        results["latents"].append({"filename": file, "subfolder": _rel_sub(folder), "type": results["type"]})
        return file

    # ------------------------------------------------------------------
    # 主入口
    # ------------------------------------------------------------------
    def save_media(self, filename_prefix=DEFAULT_PREFIX, **kw):
        ui = {"josia_info": {}}
        in_parts = []
        try:
            # 中文参数名在 Python 里非法，故用 kw 取；同时兼容英文名与缺参
            g = lambda k, d=None: kw.get(k, d)
            self._last_counter = None      # 各保存函数会把「实际落盘用到的序号」写回这里
            已提前保存潜空间 = False        # 解码前是否已先存过潜空间（供后面避免重复落盘）
            提前保存的潜空间路径 = ""       # 解码前若已存盘，记下路径，解码失败时也回传给前端

            图像格式 = g("图像格式", "⭐ PNG")
            无损 = bool(g("无损", False))
            质量 = int(g("质量", 90))
            压缩级别 = int(g("压缩级别", 4))
            视频容器 = g("视频容器", NONE_VIDEO)
            帧率 = float(g("帧率", 24.0))
            输出帧率 = float(g("输出帧率", 0.0))
            视频编码 = g("视频编码", "h264")
            视频质量 = int(g("视频质量", 23))
            音频格式 = g("音频格式", NONE_AUDIO)
            音频质量 = g("音频质量", "128k")
            # 🔴 三路都设成「不保存」⇒ 强制落盘 .latent：本节点接入工作流就必须留下产物，
            #    否则整条工作流跑完没有任何文件，等于空转（前端同样会把开关锁成开启态）。
            保存潜空间 = bool(g("保存潜空间", False)) or (
                图像格式 == NONE_IMAGE
                and 视频容器 in OFF_VIDEO
                and 音频格式 in OFF_AUDIO)
            解码方式 = g("解码方式", "自动")
            分块尺寸 = int(g("分块尺寸", 512))
            分块重叠 = int(g("分块重叠", 64))
            时间分块 = int(g("时间分块", 64))
            时间重叠 = int(g("时间重叠", 8))
            解码精度 = g("解码精度", "自动")
            清理缓存 = g("清理缓存", "关")
            清理时机 = g("清理时机", "解码前")
            写入元数据 = bool(g("写入元数据", True))
            临时预览 = bool(g("临时预览", False))

            图像 = g("图像")
            Latent = g("Latent")
            视频 = g("视频")
            音频 = g("音频")
            prompt = g("prompt")
            extra_pnginfo = g("extra_pnginfo")

            # 🔴 免解码直通判定 —— 决定**要不要碰 VAE**。
            #    用户选「不保存X」的用意是跳过 VAE 解码：大分辨率 / 长视频最容易在解码这一步
            #    OOM，先把整批潜空间秒速落盘，等工作流跑完、模型显存腾出来后，再用
            #    「Josia加载Latent」单独批量解码（批量解码计划见 docs/）。所以这条路必须做到：
            #      ① 不加载 VAE（光把模型读进显存就已是最大一笔开销）② 不调用任何 decode
            #      ③ 不对 Latent 做额外加工，只是原样写盘。
            #    注意「要不要解码」是**按路**判的：视频路 = 出视频文件或静态图，音频路 = 出音频文件。
            有视频路, 有音频路 = _latent_routes(Latent)
            需要视频解码 = (Latent is not None and 有视频路
                       and (图像格式 != NONE_IMAGE or 视频容器 in VIDEO_OUTPUT_CONTAINERS))
            需要音频解码 = (Latent is not None and 有音频路 and 音频格式 not in OFF_AUDIO)

            # VAE 来源解析：接线 > Josia 跨节点共享注册表 / models/vae 目录模型
            # 🔴 两路都不需要解码时**连加载都不做**（下拉里选了模型也不从磁盘读）。
            vae = _resolve_vae(g("Video_VAE"), g("VAE1", VAE1_PLACEHOLDER), "vae1") if 需要视频解码 else None
            vae2 = _resolve_vae(g("Audio_VAE"), g("VAE2", PLACEHOLDER_VAE2), "vae2") if 需要音频解码 else None

            t_start = time.time()

            # ---- 1. 解码前清理 -------------------------------------------------
            if 清理缓存 != "关" and 清理时机 == "解码前":
                clear_cache(清理缓存)

            # ---- 1.5 落盘目录 / 文件名 / 计数器（提前算：供「解码前先存潜空间」使用）---
            # 先解析通配符（%date% / %time% / %date:yyyyMMdd% / %time:hhmm% …），
            # 再判断用户是不是在前缀里手填了绝对路径（选了「选择目录」按钮就会）。
            filename_prefix = _resolve_wildcards(filename_prefix) or DEFAULT_PREFIX
            abs_folder, rel_prefix = _split_abs_prefix(filename_prefix)

            if 临时预览:
                base_dir = folder_paths.get_temp_directory()
                folder_type = "temp"
                rel_prefix = rel_prefix + "_temp_" + "".join(
                    random.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(5))
                if 压缩级别 > 1:
                    压缩级别 = 1                      # 对齐原生 PreviewImage
                if abs_folder:
                    print(f"{WATERMARK} ℹ️ 前缀里写了绝对路径，但「临时预览」优先 —— 仍然只写 temp 目录。")
                    abs_folder = None
            else:
                base_dir = folder_paths.get_output_directory()
                folder_type = "output"

            results = {"images": [], "audio": [], "latents": [], "type": folder_type, "animated": False}
            main_path = ""
            已提前保存潜空间 = False
            提前保存的潜空间路径 = ""

            # 目录 / 文件名 / 计数器（宽高此时尚未解码，用 0；get_save_image_path 实际不依赖宽高）
            if abs_folder:
                # 用户手填了绝对路径 ⇒ 完全脱离 output 目录（不再拼 base_dir）
                full_folder = os.path.abspath(abs_folder)
                name = _sanitize_name(rel_prefix) or _sanitize_name(DEFAULT_PREFIX.split(os.sep)[-1])
                try:
                    os.makedirs(full_folder, exist_ok=True)
                except OSError as e:
                    raise ValueError(f"Josia媒体保存：无法创建输出目录 {full_folder}：{e}") from e
                counter = _next_counter(full_folder, name)
                subfolder = ""
            else:
                # 原生行为：相对 output 目录，子目录由前缀里的目录部分决定
                full_folder, name, counter, subfolder, _prefix = folder_paths.get_save_image_path(
                    rel_prefix, base_dir, 0, 0)

            counter0 = counter      # 本次第一个文件用的序号（前端信息窗展示用）

            # 🔴 解码前先存潜空间（OOM 保护）：
            #    解码是显存大头，OOM 时若还没存潜空间就会彻底报废数据；
            #    先落下 .latent，即使后续解码爆显存，也能用「Josia加载Latent」节点
            #    释放显存、单独解码续上，大幅拉高解码成功率。
            if Latent is not None and 保存潜空间:
                try:
                    f = self._save_latent(Latent, full_folder, name, counter,
                                          prompt, extra_pnginfo, results)
                    已提前保存潜空间 = True
                    提前保存的潜空间路径 = f
                    if not main_path:
                        main_path = f
                    print(f"{WATERMARK} 💾 已**先**保存潜空间（解码前）：{f} —— 即使解码爆显存也能用加载Latent节点续上")
                except Exception as _le:
                    # 潜空间存盘自身失败：不当场中断，继续尝试解码（解码可能仍成功）；记一笔便于排错
                    print(f"{WATERMARK} ⚠️ 解码前保存潜空间失败（{_le}），仍继续解码流程。")

            # ---- 2. 取图像 / 音频（潜空间先分离视频路与音频路）---------------
            images = 图像
            音频_latent = None
            video_lat, audio_lat = _split_av_latent(Latent)

            if Latent is not None:
                if not (需要视频解码 or 需要音频解码):
                    print(f"{WATERMARK} ⚡ 免解码直通：三路均为「不保存X」⇒ "
                          f"不加载 VAE、不解码，把潜空间原样落盘（{(_latent_kind(Latent) or '未知')}）")
                if video_lat is None and audio_lat is not None:
                    print(f"{WATERMARK} ℹ️ 接入的是**纯音频**潜空间，本次只解音频。")
                # 🔴 只有**真的要出这一路的产物**才解码（否则用户选「不保存X」就白省了）
                if video_lat is not None and 需要视频解码:
                    images = self._decode(vae, video_lat, 解码方式, 分块尺寸, 分块重叠,
                                          时间分块, 时间重叠, 解码精度)
                    if 图像 is not None:
                        print(f"{WATERMARK} ℹ️ 同时接了「图像」与「Latent」，以解码结果为准（图像仅作透传来源被忽略）")
                if audio_lat is not None and 需要音频解码:
                    if vae2 is None:
                        print(f"{WATERMARK} ⚠️ 潜空间里检测到**音频路**，但没有可用的音频 VAE —— 音频不会被解码。"
                              f"请在「VAE2」下拉里选一个音频 VAE，或给「Audio_VAE」端口接线。")
                    else:
                        音频_latent = self._decode_audio(vae2, audio_lat)

            if 音频_latent is not None:
                if 音频 is not None:
                    print(f"{WATERMARK} ℹ️ 同时存在「音频」接线与潜空间解出的音频，采用**潜空间解出的**那路。")
                音频 = 音频_latent

            if images is None and 视频 is None and 音频 is None and Latent is None:
                raise ValueError("Josia媒体保存：至少要接入 图像 / Latent / 视频 / 音频 之一。")

            # ---- 4. 图像 / 动图 / 视频 -----------------------------------------
            # 🔴 宽高仅用于信息窗「尺寸」显示；目录 / 文件名 / 计数器已在解码前算好（供先存潜空间）
            if images is not None:
                h, w = int(images[0].shape[0]), int(images[0].shape[1])
            elif 视频 is not None:
                try:
                    w, h = 视频.get_dimensions()
                except Exception:
                    w = h = 0
            else:
                w = h = 0
            实际输出帧率 = None      # 视频/动图实际落盘的播放帧率（输出帧率转换后），供前端信息窗展示

            # 🔴 下一个文件从「上一个文件实际用到的序号 + 1」起步，而不是盲目 +1：
            #    保存函数遇到被占用的序号会自己往后顺延（_alloc_stem），若这里还机械 +1，
            #    顺延出来的号码就会被下一次覆盖掉。
            def bump(c):
                used = getattr(self, "_last_counter", None)
                return (used + 1) if isinstance(used, int) else (c + 1)

            if images is not None or 视频 is not None:
                if images is not None:
                    spec = _normalize_format(图像格式)
                    if spec is None:
                        fallback = "⭐ PNG" if "⭐ PNG" in IMAGE_FORMAT_MAP else IMAGE_FORMAT_CHOICES[0]
                        print(f"{WATERMARK} ⚠️ 图像格式「{图像格式}」当前环境不可用（可能缺依赖），"
                              f"已降级为 {fallback}。可在设置里的「依赖安装」中安装对应插件。")
                        spec = IMAGE_FORMAT_MAP[fallback]

                # 绝对无损格式（PNG 等）：质量无意义，强制 100（与前端灰化显示一致，
                # 也避免「节点显示 100 / 信息窗读 90」之类的错位）。这类格式后端本来就忽略质量参数。
                if 图像格式.replace(STAR, "").strip() in ALWAYS_LOSSLESS:
                    质量 = 100

                animated_containers = ("APNG", "动图WebP", "GIF")
                video_containers = ("MP4", "MKV", "WebM")
                batch_len = int(images.shape[0]) if images is not None else 0
                made_container = False

                # 输出帧率：0 / 留空＝跟随「帧率」；>0＝把源帧按输出帧率重采样（复制/抽帧，不插帧）
                out_fps_user = (输出帧率 if (输出帧率 and 输出帧率 > 0) else None)

                # 图像批次 / 单图 → 动图或真视频（单图也能合成，满足「1 张图 + 视频模式」生成视频）
                if images is not None and 视频容器 in (animated_containers + video_containers) and batch_len >= 1 and not made_container:
                    src_fps = 帧率
                    dst_fps = out_fps_user if out_fps_user else 帧率
                    实际输出帧率 = dst_fps
                    imgs_out = images
                    # 重采样：源帧数 N → N × dst_fps ÷ src_fps（最近邻，复制/抽帧）。
                    # 单图（N=1）：任何 dst_fps 都只是把这一帧复制若干份（如 1fps×24=24 帧=1 秒静帧视频）。
                    if out_fps_user and out_fps_user != src_fps and batch_len > 1:
                        imgs_out, _ = _resample_frames(images, src_fps, out_fps_user)
                    if 视频容器 in animated_containers:
                        main_path = self._save_animated_pillow(
                            视频容器, imgs_out, full_folder, name, counter, dst_fps, 无损, 质量,
                            压缩级别, prompt, extra_pnginfo, 写入元数据, results) or main_path
                    else:
                        main_path = self._save_video_av(
                            视频容器, imgs_out, full_folder, name, counter, dst_fps, 视频编码, 视频质量,
                            prompt, extra_pnginfo, 写入元数据, results) or main_path
                    counter = bump(counter)
                    made_container = True

                # 已有的视频对象 → 按容器转存（含输出帧率转换）
                if 视频 is not None and 视频容器 in video_containers:
                    video_handled = False
                    if out_fps_user and out_fps_user > 0:
                        try:
                            comp = 视频.get_components()
                            vframes = comp.images
                            vrate = float(comp.frame_rate) if comp.frame_rate else 帧率
                            if abs(out_fps_user - vrate) > 1e-6:
                                vframes, _ = _resample_frames(vframes, vrate, out_fps_user)
                                main_path = self._save_video_av(
                                    视频容器, vframes, full_folder, name, counter, out_fps_user,
                                    视频编码, 视频质量, prompt, extra_pnginfo, 写入元数据, results) or main_path
                                counter = bump(counter)
                                实际输出帧率 = out_fps_user
                                video_handled = True
                        except Exception as e:
                            print(f"{WATERMARK} ⚠️ 视频帧率转换失败（{e}），退回原样转存。")
                    if not video_handled:
                        main_path = self._save_video_av(
                            视频容器, images, full_folder, name, counter, 帧率, 视频编码, 视频质量,
                            prompt, extra_pnginfo, 写入元数据, results, video_obj=视频) or main_path
                        实际输出帧率 = 帧率
                    counter = bump(counter)
                    made_container = True

                if images is not None and not made_container and 图像格式 != NONE_IMAGE:
                    # 逐张静态图（原生 SaveImage 行为）
                    for batch_number, image in enumerate(images):
                        keep_alpha = image.shape[-1] == 4 and spec["fmt"] in ("PNG", "WEBP", "AVIF", "TIFF")
                        img = _tensor_to_pil(image, keep_alpha=keep_alpha)
                        name_b = name.replace("%batch_num%", str(batch_number))
                        f = self._save_still(img, spec, full_folder, name_b, counter, 无损, 质量,
                                             压缩级别, prompt, extra_pnginfo, 写入元数据, results)
                        if not main_path:
                            main_path = f
                        counter = bump(counter)
                elif images is not None and made_container:
                    # 刻意不额外导单帧：原生 SaveWEBM / SaveAnimated* 也只出容器文件，
                    # 逐帧再存一份会让磁盘悄悄膨胀。要只要静帧就把「视频容器」设为「不保存视频」。
                    print(f"{WATERMARK} ℹ️ 已把 {batch_len} 帧合成 1 个「{视频容器}」文件，"
                          f"未额外导出单帧图（只需静帧请把「视频容器」设为「{NONE_VIDEO}」）")

            # ---- 5. 音频 ------------------------------------------------------
            if 音频 is not None and 音频格式 not in OFF_AUDIO:
                f = self._save_audio(音频, 音频格式, 音频质量, full_folder, name, counter,
                                     prompt, extra_pnginfo, 写入元数据, results)
                if f and not main_path:
                    main_path = f

            # ---- 6. 潜空间 ----------------------------------------------------
            # 🔴 已在上文「解码前」优先存过（OOM 保护），此处不再重复落盘，避免多写一个 .latent；
            #    仅当「解码前那次存盘自身异常失败」时才在此兜底补存一次。
            if Latent is not None and 保存潜空间 and not 已提前保存潜空间:
                f = self._save_latent(Latent, full_folder, name, counter,
                                      prompt, extra_pnginfo, results)
                if not main_path:
                    main_path = f

            # 🔴 落地校验：本节点一旦接入工作流，就必须留下至少一个产物。
            #    三路都选「不保存X」时靠强制落盘 .latent 兜底（那时必须有 Latent）；
            #    若连 Latent 都没接 ⇒ 跑完一个文件都没有，工作流等于空转 —— 宁可当场报错。
            if not (results["images"] or results["audio"] or results["latents"]):
                raise ValueError(
                    "Josia媒体保存：本次不会产生任何文件 —— 图像 / 视频 / 音频三路都选了「不保存X」，"
                    "又没有接入 Latent（没有潜空间可存）。请接入 Latent，或让其中一路选真实格式。")

            # ---- 7. 保存后清理 -------------------------------------------------
            if 清理缓存 != "关" and 清理时机 == "解码后":
                clear_cache(清理缓存)

            # ---- 8. 组装返回 ---------------------------------------------------
            ui = {}
            # 运行期信息：前端信息窗的「输入 / 输出」两行数据源。
            # 官方前端只认 images/audio/text 等已知键，未知键会被忽略（不会多画控件）。
            in_parts = []
            if 图像 is not None:
                in_parts.append("图像")
            if Latent is not None:
                in_parts.append("Latent（" + (_latent_kind(Latent) or "未知") + "）")
            if 视频 is not None:
                in_parts.append("视频")
            if 音频_latent is not None:
                in_parts.append("潜空间音频")
            elif 音频 is not None:
                in_parts.append("音频")
            try:
                out_ext = os.path.splitext(main_path)[1].lstrip(".").upper() if main_path else ""
            except Exception:
                out_ext = ""
            cost = time.time() - t_start          # 信息窗「其他」行要用，先算（后面 print 复用同一个值）
            try:
                size_txt = ("%d×%d" % (int(w), int(h))) if (w and h) else ""
            except Exception:
                size_txt = ""
            # 本次真实落盘的**全部**文件名（按落盘顺序）—— 前端「输出」行据此显示
            # 「1 张＝名字 / 2 张＝A、B / ≥3 张＝A ~ C」。此前只给首个文件名，多图时与日志对不上。
            saved_names = [d.get("filename") for d in results["images"]]
            saved_names += [d.get("filename") for d in results["audio"]]
            saved_names += [d.get("filename") for d in results["latents"]]
            saved_names = [n for n in saved_names if n]
            ui["josia_info"] = {
                "inputs": in_parts,
                "dir": full_folder,
                "prefix": name,
                "counter": "%05d" % int(counter0),
                "format": out_ext,
                "target": folder_type,
                # 本次真实落盘的：文件名（首个 + 全部）/ 分辨率 / 耗时 / 产物数量（前端信息窗直接显示）
                "filename": os.path.basename(main_path) if main_path else "",
                "filenames": saved_names,
                "size": size_txt,
                "cost": "%.2f" % cost,
                "count": (max(0, len(results["images"]) - (1 if results["animated"] else 0))
                          + (1 if results["animated"] else 0)
                          + len(results["audio"]) + len(results["latents"])),
                # 视频/动图实际落盘的播放帧率（经「输出帧率」转换后）；非视频产物为 None
                "actual_fps": (round(float(实际输出帧率), 3) if 实际输出帧率 is not None else None),
            }
            if results["images"]:
                ui["images"] = results["images"]
            if results["animated"]:
                ui["animated"] = (True,)
            if results["audio"]:
                ui["audio"] = results["audio"]
            if results["latents"]:
                ui["latents"] = results["latents"]

            rel = f"{subfolder}/{main_path}" if (main_path and subfolder) else main_path

            n_img = max(0, len(results["images"]) - (1 if results["animated"] else 0))
            parts = []
            if results["animated"]:
                parts.append("动图/视频 1 个")
            if n_img:
                parts.append(f"图像 {n_img} 张")
            if results["audio"]:
                parts.append(f"音频 {len(results['audio'])} 个")
            if results["latents"]:
                parts.append(f"Latent {len(results['latents'])} 个")
            print(f"{WATERMARK} ✅ 保存完成：{'，'.join(parts) if parts else '无'} "
                  f"| 目录 {folder_type} | 耗时 {cost:.2f}s")

            return {"ui": ui, "result": (images, rel, Latent, video_lat, audio_lat)}


        except ValueError as _ve:
            # 🔴 显式校验错误（如「未接入任何输入」）属于用户配置问题，按 ComfyUI 惯例
            #    原样抛出，让节点在队列里标红报错（信号更强、更直观）；这种「人为漏接」不是
            #    后端执行期崩溃，不必进信息窗。
            raise
        except Exception as _e:
            import traceback as _tb
            _stack = _tb.format_exc()
            ui["josia_info"] = {
                "error": f"{type(_e).__name__}: {_e}",
                "error_detail": _stack,
                "inputs": in_parts,
                # 🔴 解码前若已先存了潜空间，把路径回传前端 —— 解码爆显存时用户能直接拿去
                #    「Josia加载Latent」节点释放显存、单独解码续上，避免数据报废
                "early_latent": 提前保存的潜空间路径 or None,
            }
            print(f"[Josia媒体保存] \u274c 执行出错（详情已写入前端信息窗）：\n{_stack}")
            return {"ui": ui, "result": (None, "", None, None, None)}
def _rel_sub(folder):
    """把绝对目录换算成 ComfyUI 的相对子目录（output/temp 下的一级子路径）。"""
    for base in (folder_paths.get_output_directory(), folder_paths.get_temp_directory()):
        try:
            if os.path.normcase(folder).startswith(os.path.normcase(base)):
                rest = os.path.relpath(folder, base)
                return "" if rest == "." else rest.replace("\\", "/")
        except Exception:
            continue
    return ""


def _list_drives():
    """列出可用根目录：Windows 给盘符，其它系统给文件系统根。"""
    entries = []
    if os.name == "nt":
        for code in range(65, 91):          # A-Z
            root = chr(code) + ":\\"
            try:
                if os.path.isdir(root):
                    entries.append({"name": chr(code) + ":", "path": root})
            except OSError:
                continue
    if not entries:
        root = os.path.abspath(os.sep)
        entries.append({"name": root, "path": root})
    return entries


def _shortcuts():
    """文件夹选择器的快捷入口：ComfyUI 三个目录 + 桌面 + 用户目录。"""
    out = []
    labels = {"output": "输出目录", "input": "输入目录", "temp": "临时目录"}
    for key, label in labels.items():
        try:
            d = folder_paths.get_directory_by_type(key)
        except Exception:
            d = None
        if d and os.path.isdir(d):
            out.append({"name": label, "path": os.path.abspath(d)})
    for label, d in (("桌面", os.path.join(os.path.expanduser("~"), "Desktop")),
                     ("用户目录", os.path.expanduser("~"))):
        if d and os.path.isdir(d):
            out.append({"name": label, "path": os.path.abspath(d)})
    return out


# ==================================================================
# HTTP 路由（打开目录 / 文件夹选择器 / VAE 状态）
# ==================================================================
def _register_routes():
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception as e:      # pragma: no cover
        print(f"[Josia媒体保存] 路由跳过（{e}）")
        return

    @PromptServer.instance.routes.post("/josia_media_save/open_folder")
    async def _open_folder(request):
        """打开目录。body 三种写法：
          {"filename":…, "subfolder":…, "type":"output|temp"}  → 打开某产物所在目录
          {"dir": "D:\\\\out"}                                   → 直接打开指定目录
          {}                                                     → 打开 output 目录
        走 os.startfile（标准库，**非子进程**），与 text_save 的打开方式一致。
        """
        try:
            data = await request.json()
        except Exception:
            data = {}

        out_root = folder_paths.get_output_directory()
        tmp_root = folder_paths.get_temp_directory()

        if data.get("dir"):
            target = os.path.normpath(str(data["dir"]))
        else:
            ftype = data.get("type") or "output"
            base = tmp_root if ftype == "temp" else out_root
            sub = (data.get("subfolder") or "").replace("\\", "/")
            cand = os.path.normpath(os.path.join(base, sub))
            # 路径包含性校验：subfolder 来自前端，不可信
            nc, nb = os.path.normcase(cand), os.path.normcase(base)
            if not (nc == nb or nc.startswith(nb + os.sep)):
                return web.json_response({"ok": False, "error": "invalid_path"}, status=400)
            target = cand
            # 🔴 前缀里写的子目录（`JosiaMedia\Media_%001%` ⇒ output\JosiaMedia）在第一次保存
            #    之前并不存在。此时「📂 打开」要能直接定位到那一层 ⇒ 顺手建出来，
            #    而不是报 not_found 把用户挡在 output 根目录。
            if sub and not os.path.isdir(target):
                try:
                    os.makedirs(target, exist_ok=True)
                except OSError:
                    pass

        if not os.path.isdir(target):
            return web.json_response({"ok": False, "error": "not_found"}, status=404)
        if not sys.platform.startswith("win"):
            # 与 text_save 保持一致：只在 Windows 上用标准库打开；其它平台明确返回
            # 不支持，而不是引入 subprocess（本包规范：零外部进程）。
            return web.json_response({"ok": False, "error": "not_supported"}, status=501)
        try:
            os.startfile(target)                          # noqa: S606
            return web.json_response({"ok": True, "path": target})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/josia_media_save/pick_dir")
    async def _pick_dir(request):
        """打开 **Windows 原生「选择文件夹」对话框**，返回用户选中的绝对路径。

        走 ctypes 直调 shell32 的 IFileOpenDialog（进程内调用，**不产生任何子进程**），
        可随时退回「此电脑」顶层 —— 这正是内置浏览器做不到的地方。
        非 Windows / 调用失败时返回 ok=false，前端自动退回内置文件夹浏览器。
        body（可选）：{"title": "…", "initial": "D:\\\\out"}
        """
        if _native_picker is None or not _native_picker.available():
            return web.json_response({"ok": False, "error": "not_supported"}, status=501)
        try:
            data = await request.json()
        except Exception:
            data = {}
        title = str(data.get("title") or "选择输出目录")
        initial = str(data.get("initial") or "")
        try:
            path = await _native_picker.pick_folder_async(title, initial)
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)
        if not path:
            return web.json_response({"ok": False, "error": "cancelled"})
        return web.json_response({"ok": True, "path": path})

    @PromptServer.instance.routes.post("/josia_media_save/list_dirs")
    async def _list_dirs(request):
        """文件夹选择器：列出目录下的子目录。path 为空时返回驱动器 + 快捷入口。

        响应结构与 text_save 的同名接口保持一致，前端可复用同一套选择器 UI。
        """
        try:
            data = await request.json()
        except Exception:
            data = {}
        raw = str(data.get("path") or "").strip()

        if not raw:
            return web.json_response({"ok": True, "path": "", "parent": "",
                                      "dirs": _list_drives(), "shortcuts": _shortcuts()})

        target = os.path.abspath(os.path.expanduser(raw))
        if not os.path.isdir(target):
            return web.json_response({"ok": False, "error": "not_found"}, status=404)

        dirs = []
        try:
            with os.scandir(target) as it:
                for entry in it:
                    try:
                        if entry.is_dir():
                            dirs.append({"name": entry.name, "path": entry.path})
                    except OSError:
                        continue
        except PermissionError:
            return web.json_response({"ok": False, "error": "permission_denied"}, status=403)
        except OSError as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)
        dirs.sort(key=lambda d: d["name"].lower())

        parent = os.path.dirname(target)
        if parent == target:
            parent = ""      # 已到盘根 ⇒ 让前端回到驱动器列表
        return web.json_response({"ok": True, "path": target, "parent": parent,
                                  "dirs": dirs, "shortcuts": []})

    @PromptServer.instance.routes.post("/josia_media_save/create_dir")
    async def _create_dir(request):
        """文件夹选择器：在 parent 下新建 name 子目录。"""
        try:
            data = await request.json()
        except Exception:
            data = {}
        parent = os.path.abspath(os.path.expanduser(str(data.get("parent") or "").strip()))
        name = str(data.get("name") or "").strip()
        if not parent or not os.path.isdir(parent):
            return web.json_response({"ok": False, "error": "parent_not_found"}, status=404)
        # 名称里出现分隔符 / 非法字符一律拒绝：既防越权，也避免造出畸形目录
        if not name or any(c in name for c in '\\/:*?"<>|'):
            return web.json_response({"ok": False, "error": "invalid_name"}, status=400)
        target = os.path.join(parent, name)
        try:
            os.makedirs(target, exist_ok=False)
            return web.json_response({"ok": True, "path": target})
        except FileExistsError:
            return web.json_response({"ok": False, "error": "exists"}, status=409)
        except OSError as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/josia_media_save/vae_list")
    async def _vae_list(request):
        """VAE 下拉用：跨节点共享注册表的状态 + models/vae 清单。"""
        snap = _model_registry.snapshot() if _model_registry is not None else {
            "vae1": False, "vae2": False, "label1": "", "label2": "", "source": "", "time": 0.0}
        try:
            models = sorted(list(folder_paths.get_filename_list("vae") or []), key=str.lower)
        except Exception:
            models = []
        return web.json_response({"registry": snap, "models": models})

    @PromptServer.instance.routes.get("/josia_media_save/formats")
    async def _formats(request):
        """当前环境可用的格式清单（前端据此纠正老工作流里的不可用值）。"""
        try:
            from aiohttp import web as _web
            return _web.json_response({
                "images": [{"label": k, "format": v["fmt"], "ext": v["ext"], "meta": v["meta"]}
                           for k, v in IMAGE_FORMAT_MAP.items()],
                "videos": [{"label": k, "meta": k in VIDEO_META_OK} for k in VIDEO_CONTAINERS],
                "audios": [{"label": k, "meta": k in AUDIO_META_OK} for k in AUDIO_FORMATS],
                "av": av is not None,
            })
        except Exception as e:
            from aiohttp import web as _web
            return _web.json_response({"error": str(e)}, status=500)


try:
    _register_routes()
except Exception as _e:      # pragma: no cover
    print(f"[Josia媒体保存] 路由注册失败：{_e}")


# ==================== ComfyUI 节点映射 ====================
NODE_CLASS_MAPPINGS = {
    "JosiaMediaSave": JosiaMediaSave,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaMediaSave": NODE_DISPLAY_NAME_MEDIA_SAVE,
}
