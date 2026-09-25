"""
Josia CheckpointPlus — 高级智能一体化模型加载节点 v2.9.14
自动识别 AIO / 独立 UNET / GGUF 模型，一体化加载 MODEL + CLIP + 双 VAE（VAE1 / VAE2）；
内置 CLIP 类型全量下拉、模型尺寸实时检测、UNET 保活，AIO 模式自动复用内置组件。
"""
import os
import re
import gc
import json
import struct
import torch
import folder_paths
import comfy.sd
import comfy.utils
import comfy.model_management

from node_properties import CHECKPOINT_PLUS_DESCRIPTION

try:
    # 跨节点模型共享注册表（本包内模块）。缺失/异常时仅降级为「不共享」，不影响加载。
    from model_registry import publish as _publish_vae
except Exception:          # pragma: no cover
    _publish_vae = None

# ========================== 常量 ==========================

CATEGORY = "⚡️JosiaNodes"

PLACEHOLDER_MODEL     = "🖼️ 请选择模型…"
PLACEHOLDER_CLIP      = "🧠 请选择模型…"
PLACEHOLDER_VAE       = "🎨 请选择模型…"
PLACEHOLDER_CLIP_TYPE = "🏷️ 请选择类型…"
PLACEHOLDER_VAE2      = "🎵 请选择模型…"

# ── CLIP 类型选项（对齐官方 CLIPLoader / DualCLIPLoader 下拉，并修正失效项） ──
# 说明：
#  • 原列表顺序保持不变（避免破坏已保存工作流的 combo 索引对齐）。
#  • `ace` 修正原 `ACE_Clip`（.upper()→ACE_CLIP 无法命中枚举 ACE，会静默回退 SD）；
#    `pixeldit` 修正原 `pixeledit`（.upper()→PIXELEDIT 无法命中枚举 PIXELDIT，同样回退 SD）。
#  • 末尾追加官方已支持但原列表缺失的新模型 CLIP 类型（v2.9.8）：
#    cosmos / hidream / boogu / krea2（来自官方 CLIPLoader 列表），
#    hunyuan_video / hunyuan_video_15 / kandinsky5 / kandinsky5_image / newbie
#    （来自官方 DualCLIPLoader 列表与 CLIPType 枚举，一体化单 CLIP 加载同样适用）。
#  • v2.9.9 继续补全官方 CLIPLoader 最新列表：joyimage（Qwen3-VL 8B）/ mage / minimax
#    （MINIMAX H3 的 Qwen3-VL-32B 多模态 CLIP）；枚举成员 JOYIMAGE/MAGE/MINIMAX 已确认存在。
#  • `_clip_type_to_enum` 用 `getattr(comfy.sd.CLIPType, type_str.upper(), STABLE_DIFFUSION)`，
#    与官方 CLIPLoader.load_clip 逻辑一致，故下拉项能精确命中枚举即稳定可用。
CLIP_TYPE_OPTIONS = [
    PLACEHOLDER_CLIP_TYPE,
    "sdxl",              # 便利：一体化节点接单 CLIP 文件（官方 DualCLIPLoader 提供）
    "stable_diffusion",
    "lumina2",
    "qwen_image",
    "flux",              # 便利：接单 CLIP 文件（FLUX 枚举）
    "flux2",
    "sd3",
    "stable_cascade",
    "mochi",
    "wan",
    "hunyuan_image",
    "pixart",
    "LTXV",              # 保留原大小写（.upper() 已能命中枚举 LTXV）
    "chroma",
    "ace",               # 修正：原 "ACE_Clip" 拼写错，会静默回退 stable_diffusion
    "pixeldit",          # 修正：原 "pixeledit" 拼写错，会静默回退 stable_diffusion
    "ideogram4",
    "longcat_image",
    "lens",
    "ovis",
    "omnigen2",
    "cogvideox",
    "stable_audio",
    # ── 新增：对齐官方 CLIPLoader / DualCLIPLoader 的最新 CLIP 类型 ──
    "cosmos",
    "hidream",
    "boogu",
    "krea2",
    "hunyuan_video",
    "hunyuan_video_15",
    "kandinsky5",
    "kandinsky5_image",
    "newbie",
    # ── v2.9.9 新增：对齐官方最新 CLIPLoader 列表（MINIMAX H3 等最新开源模型）──
    "joyimage",         # Qwen3-VL 8B 编辑类 CLIP（CLIPType.JOYIMAGE）
    "mage",             # CLIPType.MAGE
    "minimax",          # MINIMAX H3：Qwen3-VL-32B 多模态 CLIP（CLIPType.MINIMAX）
]

def _clip_type_to_enum(type_str: str):
    """运行时将 CLIP 类型字符串转为 comfy.sd.CLIPType 枚举值。

    与 ComfyUI 原生 CLIPLoader 保持一致：对类型名做 .upper() 后取枚举
    （枚举成员名为大写，如 FLUX2 / LUMINA2 / QWEN_IMAGE / STABLE_DIFFUSION），
    因此下拉框里的小写选项（flux2 / lumina2 / qwen_image …）也能正确命中。
    旧版 ComfyUI 不支持的类型会回退到 STABLE_DIFFUSION。
    注意：早期缺少 .upper() 会导致所有小写类型都 AttributeError 回退，
    表现为“不支持 flux2 / lumina2”等，且实际始终按 stable_diffusion 加载。
    """
    if type_str == PLACEHOLDER_CLIP_TYPE or type_str == "已自动识别（内置）":
        return None
    CT = comfy.sd.CLIPType
    member = getattr(CT, type_str.upper(), None)
    if member is None:
        print(f"[JosiaCheckpointPlus] ⚠️ 当前ComfyUI不支持CLIP类型 '{type_str}'，回退为 stable_diffusion")
        return CT.STABLE_DIFFUSION
    return member

# ========================== GGUF扩展名注册 ==========================

def _register_gguf_extensions():
    try:
        if hasattr(folder_paths, "supported_pt_extensions"):
            if isinstance(folder_paths.supported_pt_extensions, set):
                folder_paths.supported_pt_extensions.add(".gguf")
            elif isinstance(folder_paths.supported_pt_extensions, (list, tuple)):
                exts = list(folder_paths.supported_pt_extensions)
                if ".gguf" not in exts:
                    exts.append(".gguf")
                    folder_paths.supported_pt_extensions = type(
                        folder_paths.supported_pt_extensions)(exts)
    except Exception as e:
        print(f"[JosiaCheckpointPlus] ⚠️ GGUF扩展名注册失败（不影响其他功能）：{e}")

_register_gguf_extensions()

# ========================== 辅助函数 ==========================

def _is_gguf_path(path: str) -> bool:
    return isinstance(path, str) and path.lower().endswith(".gguf")


def _get_gguf_class(class_name: str):
    """从 ComfyUI 全局节点注册表获取 ComfyUI-GGUF 插件已注册的加载器类。

    为什么这样集成：
      ComfyUI-GGUF 插件将其文件平铺在 custom_nodes/ComfyUI-GGUF/ 下，
      内部并没有可供直接 import 的 comfyui_gguf 子包，因此
      `from comfyui_gguf.xxx import ...` 这类写法会失败（这也正是之前各种修改
      都无法加载 GGUF 的根因）。
      但只要该插件已安装并启用，它注册到 ComfyUI 的 UnetLoaderGGUF /
      CLIPLoaderGGUF 节点类就存在于全局 nodes.NODE_CLASS_MAPPINGS 中。
      直接复用这些「经过插件自身验证」的加载逻辑，既稳又无需关心其内部包结构。
    """
    try:
        import nodes as _comfy_nodes
        return getattr(_comfy_nodes, "NODE_CLASS_MAPPINGS", {}).get(class_name)
    except Exception:
        return None


# ── 父级类别（ComfyUI 模型类别目录）显示顺序：checkpoints < diffusion_models < unet_gguf ──
_CAT_ORDER = {"checkpoints": 0, "diffusion_models": 1, "unet_gguf": 2}

def _list_with_cat(folder_key):
    """取某类别目录的文件列表，并打上类别标签（如 "checkpoints"）。失败时返回空。"""
    try:
        return [(n, folder_key) for n in folder_paths.get_filename_list(folder_key)]
    except Exception:
        return []

def _list_unet_gguf_walk_with_cat():
    """兜底：直接遍历 diffusion_models / unet_gguf 文件夹（兼容插件未注册 / 自定义路径）。"""
    out = []
    for fk in ("diffusion_models", "unet_gguf"):
        folders = []
        try:
            folders += list(folder_paths.get_folder_paths(fk))
        except Exception:
            pass
        for folder in folders:
            if not os.path.isdir(folder):
                continue
            for root, _, files in os.walk(folder):
                for f in files:
                    if f.lower().endswith(".gguf"):
                        rel = os.path.relpath(os.path.join(root, f), folder).replace("\\", "/")
                        out.append((rel, fk))
    return out

def _get_combined_model_list_with_cat():
    """合并 checkpoints + diffusion_models + unet_gguf，给每个模型打上父级类别，
    并按三级键排序（类别 → 子文件夹优先于根目录 → 子文件夹/文件名）。

    同时刷新模块级 `_MODEL_CAT_MAP`（供前端显示 📁 父级前缀用）。
    排序键保证：同一类别连续成块；同类内子文件夹连续；根目录模型落在各自类别段末尾，
    不再散落到别的类别模型中间。
    """
    raw = (
        _list_with_cat("checkpoints")
        + _list_with_cat("diffusion_models")
        + _list_with_cat("unet_gguf")
        + _list_unet_gguf_walk_with_cat()
    )
    # 绝对路径精确去重：保留首个命中的类别（优先级 checkpoints→diffusion_models→unet_gguf）
    seen = {}
    for name, cat in raw:
        if not name:
            continue
        abs_p = _resolve_full_path(name)
        key = abs_p if abs_p else ("rel:" + name)
        if key not in seen:
            seen[key] = (name, cat)
    # 三级排序键：(类别序, 是否有子文件夹[无则排末尾], 子文件夹, 文件名小写)
    def sort_key(item):
        name, cat = item
        has_sub = "/" in name
        sub = name.rsplit("/", 1)[0].lower() if has_sub else ""
        return (_CAT_ORDER.get(cat, 999), 0 if has_sub else 1, sub, name.lower())
    result = list(seen.values())
    result.sort(key=sort_key)
    # 刷新类别映射表（前端靠它显示 📁 父级前缀；不命中时回退不带前缀）
    global _MODEL_CAT_MAP
    _MODEL_CAT_MAP = {name: cat for name, cat in result}
    return result

_MODEL_CAT_MAP = {}


def _resolve_full_path(rel_name: str):
    """尝试用多个可能的 folder 类别把相对路径解析为绝对路径，用于精确去重。
    解析失败（类别不匹配/插件差异）时返回 None，调用方回退到相对字符串去重。"""
    for cat in ("clip", "clip_gguf", "diffusion_models", "unet_gguf", "checkpoints"):
        try:
            p = folder_paths.get_full_path(cat, rel_name)
            if p and os.path.exists(p):
                return os.path.normcase(os.path.normpath(p))
        except Exception:
            continue
    return None


def _dedupe_and_sort(rel_names: list) -> list:
    """对相对路径列表做：绝对路径精确去重 + 不区分大小写排序（同文件夹相邻）。

    解决两类问题：
      • 重复：同一物理文件在不同来源（clip 列表 / clip_gguf 列表 / 手动遍历）
        可能返回不同相对路径字符串（如 'gguf/qwen.gguf' vs 'qwen.gguf'），
        按字符串去重会漏掉 → 改为按解析后的绝对路径去重。
      • 排序：各来源各自排序后拼接，导致同文件夹模型被拆散 → 改为统一排序。
    """
    seen = {}
    for name in rel_names:
        if not name:
            continue
        abs_p = _resolve_full_path(name)
        key = abs_p if abs_p else ("rel:" + name)
        if key not in seen:
            seen[key] = name
    result = list(seen.values())
    result.sort(key=lambda s: s.lower())
    return result


def _get_all_clips() -> list:
    candidates = []
    # 常规 clip 列表
    try:
        candidates += list(folder_paths.get_filename_list("clip"))
    except Exception:
        pass
    # GGUF CLIP：ComfyUI-GGUF 插件注册的 clip_gguf 列表
    try:
        candidates += list(folder_paths.get_filename_list("clip_gguf"))
    except Exception:
        pass
    # 兜底：直接遍历文件夹（兼容插件未注册的极端情况）
    folders = []
    try:
        folders += list(folder_paths.get_folder_paths("clip"))
    except Exception:
        pass
    try:
        folders += list(folder_paths.get_folder_paths("clip_gguf"))
    except Exception:
        pass
    for folder in folders:
        if not os.path.isdir(folder):
            continue
        for root, _, files in os.walk(folder):
            for f in files:
                if f.lower().endswith(".gguf"):
                    rel = os.path.relpath(os.path.join(root, f), folder).replace("\\", "/")
                    candidates.append(rel)
    return _dedupe_and_sort(candidates)


def _get_all_vaes() -> list:
    try:
        return folder_paths.get_filename_list("vae")
    except Exception:
        return []

def _get_all_vaes_extended() -> list:
    """VAE2 下拉列表：仅 models/vae 文件夹（不再混入 models/checkpoints，避免列出无关模型）。"""
    try:
        return folder_paths.get_filename_list("vae")
    except Exception:
        return []


def _safe_empty_cache():
    try:
        comfy.model_management.soft_empty_cache()
    except Exception:
        pass
    try:
        gc.collect()
    except Exception:
        pass


# ========================== 模型类型检测（公共，前后端共用） ==========================

def _detect_model_category(sd_keys: set) -> str:
    """根据 state_dict keys 判断模型类别。返回: "aio" | "unet_only" """
    has_clip = any(
        k.startswith((
            "cond_stage_model.", "conditioner.", "text_encoders.",
            "text_model.", "transformer.text_model.",
        ))
        for k in sd_keys
    )
    has_vae = any(
        k.startswith((
            "first_stage_model.", "vae.decoder.", "vae.encoder.",
            "decoder.conv_in.", "encoder.conv_in.",
        ))
        for k in sd_keys
    )
    return "aio" if (has_clip or has_vae) else "unet_only"


def _get_safetensors_metadata(model_path: str) -> dict | None:
    """仅读取 safetensors 文件头（前几KB），返回 keys 列表。速度<10ms。"""
    try:
        with open(model_path, "rb") as f:
            header_len_bytes = f.read(8)
            if len(header_len_bytes) < 8:
                return None
            header_len = struct.unpack("<Q", header_len_bytes)[0]
            if header_len > 100 * 1024 * 1024:
                return None
            header_bytes = f.read(header_len)
            header = json.loads(header_bytes.decode("utf-8"))
            keys = [k for k in header.keys() if k != "__metadata__"]
            return {
                "keys": set(keys),
                "key_count": len(keys),
            }
    except Exception:
        return None


def _resolve_model_path(model_name: str) -> str | None:
    for folder_key in ("checkpoints", "diffusion_models", "unet_gguf"):
        try:
            path = folder_paths.get_full_path(folder_key, model_name)
            if path and os.path.exists(path):
                return path
        except Exception:
            pass
    if os.path.isabs(model_name) and os.path.exists(model_name):
        return model_name
    return None


def _get_folder_source(model_name: str) -> str | None:
    for folder_key in ("checkpoints", "diffusion_models", "unet_gguf"):
        try:
            path = folder_paths.get_full_path(folder_key, model_name)
            if path and os.path.exists(path):
                return folder_key
        except Exception:
            pass
    return None


def _get_file_size_for_folder(model_name: str, folder_key: str) -> float | None:
    try:
        path = folder_paths.get_full_path(folder_key, model_name)
        if path and os.path.exists(path):
            return round(os.path.getsize(path) / (1024 * 1024), 1)
    except Exception:
        pass
    if os.path.isabs(model_name) and os.path.exists(model_name):
        try:
            return round(os.path.getsize(model_name) / (1024 * 1024), 1)
        except Exception:
            pass
    return None


def _parse_gguf_quant(filename: str) -> str | None:
    m = re.search(r'[Qq](\d[\w_.]*?)(?:\.gguf)', filename, re.IGNORECASE)
    if m:
        return m.group(0).rstrip('.gguf').upper()
    return None


def detect_model_type_public(model_name: str, clip_name: str = None, vae_name: str = None, vae2_name: str = None) -> dict:
    """
    公共模型类型检测函数。
    返回: { model_type, file_size_mb, clip_size_mb, vae_size_mb, gguf_quant, folder_source }
    """
    result = {
        "model_type": "unknown",
        "file_size_mb": 0.0,
        "clip_size_mb": None,
        "vae_size_mb": None,
        "gguf_quant": None,
        "folder_source": None,
    }

    if clip_name and clip_name not in (PLACEHOLDER_CLIP, ""):
        clip_size = _get_file_size_for_folder(clip_name, "clip")
        if clip_size is not None:
            result["clip_size_mb"] = clip_size

    if vae_name and vae_name not in (PLACEHOLDER_VAE, ""):
        vae_size = _get_file_size_for_folder(vae_name, "vae")
        if vae_size is not None:
            result["vae_size_mb"] = vae_size

    if vae2_name and vae2_name not in (PLACEHOLDER_VAE2, PLACEHOLDER_VAE, ""):
        v2_path = None
        for fk in ("vae", "checkpoints"):
            try:
                p = folder_paths.get_full_path(fk, vae2_name)
                if p and os.path.exists(p):
                    v2_path = p
                    break
            except Exception:
                pass
        if v2_path:
            try:
                result["vae2_size_mb"] = round(os.path.getsize(v2_path) / (1024 * 1024), 1)
            except Exception:
                pass

    if not model_name or model_name == PLACEHOLDER_MODEL:
        result["model_type"] = "unknown"
        return result

    if _is_gguf_path(model_name):
        result["model_type"] = "gguf_unet"
        result["gguf_quant"] = _parse_gguf_quant(os.path.basename(model_name))
        result["folder_source"] = _get_folder_source(model_name)
        path = _resolve_model_path(model_name)
        if path:
            result["file_size_mb"] = round(os.path.getsize(path) / (1024 * 1024), 1)
        return result

    path = _resolve_model_path(model_name)
    if not path:
        result["model_type"] = "not_found"
        return result

    result["file_size_mb"] = round(os.path.getsize(path) / (1024 * 1024), 1)
    result["folder_source"] = _get_folder_source(model_name)

    ext = os.path.splitext(path)[1].lower()
    if ext in (".safetensors",):
        meta = _get_safetensors_metadata(path)
        if meta and "keys" in meta:
            result["model_type"] = _detect_model_category(meta["keys"])
            return result

    if result["folder_source"] == "checkpoints":
        result["model_type"] = "aio"
    else:
        result["model_type"] = "unet_only"

    return result


# ========================== 后端 API 端点 ==========================

def _register_api_routes():
    """注册 /josia/detect_model_type 端点"""
    try:
        from aiohttp import web
        import server as comfy_server

        routes = comfy_server.PromptServer.instance.routes

        @routes.post("/josia/detect_model_type")
        async def handle_detect_model_type(request):
            try:
                data = await request.json()
                model_name = data.get("model_name", "")
                clip_name  = data.get("clip_name", None)
                vae_name   = data.get("vae_name", None)
                vae2_name  = data.get("vae2_name", None)
                result = detect_model_type_public(model_name, clip_name, vae_name, vae2_name)
                return web.json_response(result)
            except Exception as e:
                return web.json_response({
                    "model_type": "unknown",
                    "error": str(e),
                }, status=500)

        print("[JosiaCheckpointPlus] ✅ API端点已注册 → /josia/detect_model_type")

        @routes.get("/josia/model_categories")
        async def handle_model_categories(request):
            """暴露模块级 _MODEL_CAT_MAP（相对路径 → 父级类别），供前端给 main_model 加 📁 前缀。"""
            try:
                return web.json_response(_MODEL_CAT_MAP)
            except Exception:
                return web.json_response({}, status=500)

        print("[JosiaCheckpointPlus] ✅ API端点已注册 → /josia/model_categories")

    except Exception as e:
        print(f"[JosiaCheckpointPlus] ⚠️ API端点注册失败（ComfyUI版本可能过旧）：{e}")

_register_api_routes()

# ========================== 核心节点类 ==========================

class JosiaCheckpointPlus:
    """🚀 Josia 模型加载
    高级智能一体化模型加载节点，100% 平替所有原生加载器。"""

    DESCRIPTION = CHECKPOINT_PLUS_DESCRIPTION
    CATEGORY = CATEGORY
    FUNCTION = "load_model"
    # 不再设置OUTPUT_NODE=True —— 无下游连接时不执行，避免无意义加载。

    RETURN_TYPES = ("MODEL", "CLIP", "VAE", "VAE")
    RETURN_NAMES = ("MODEL", "CLIP", "VAE1", "VAE2")

    @classmethod
    def INPUT_TYPES(cls):
        # 合并列表带类别：刷新模块级 _MODEL_CAT_MAP（供前端显示 📁 父级前缀）；
        # main_model 的 value 仍是纯相对路径，老工作流零影响。
        combined_with_cat = _get_combined_model_list_with_cat()
        model_list_raw = [name for name, _cat in combined_with_cat]
        model_list = [PLACEHOLDER_MODEL] + model_list_raw if model_list_raw else [PLACEHOLDER_MODEL]
        all_clips = [PLACEHOLDER_CLIP] + _get_all_clips()
        all_vaes  = [PLACEHOLDER_VAE] + _get_all_vaes()
        all_vaes2 = [PLACEHOLDER_VAE2] + _get_all_vaes_extended()

        return {
            "required": {
                "main_model": (model_list, {
                    "display_name": "主模型",
                    "default": PLACEHOLDER_MODEL,
                    "tooltip": (
                        "支持 ckpt / safetensors / bin / gguf 全格式。\n"
                        "选中后自动识别：AIO三合一 / 独立UNET / GGUF UNET。\n"
                        "识别后自动联动下方CLIP/VAE选框状态。\n"
                        "★ GGUF 模型：本节点直接复用已安装的 ComfyUI-GGUF 插件\n"
                        "  （UnetLoaderGGUF / CLIPLoaderGGUF）进行加载，无需额外配置；\n"
                        "  若提示找不到 GGUF 加载器，请先安装并启用 ComfyUI-GGUF 插件。"
                    ),
                }),
                "clip_name": (all_clips, {
                    "display_name": "CLIP模型",
                    "default": PLACEHOLDER_CLIP,
                    "tooltip": (
                        "• AIO模型：自动禁用，复用模型内置CLIP\n"
                        "• GGUF UNET：可选择任意格式CLIP（GGUF或非GGUF均可）\n"
                        "• 独立UNET：可自由选择任意格式CLIP\n"
                        "选「请选择模型…」可由下游节点直接接入外部CLIP。"
                    ),
                }),
                "clip_type": (CLIP_TYPE_OPTIONS, {
                    "display_name": "CLIP类型",
                    "default": PLACEHOLDER_CLIP_TYPE,
                    "tooltip": (
                        "手动选择CLIP模型的tokenization架构类型。\n"
                        "• AIO模型：自动适配，无需手动选择\n"
                        "• GGUF UNET：可手动选择CLIP类型（含GGUF格式CLIP）\n"
                        "• 独立UNET：须正确选择以匹配CLIP模型架构\n"
                        "未选择类型时运行会使用STABLE_DIFFUSION兜底。"
                    ),
                }),
                "vae_name": (all_vaes, {
                    "display_name": "VAE模型1",
                    "default": PLACEHOLDER_VAE,
                    "tooltip": (
                        "• AIO模型：自动禁用，复用模型内置VAE\n"
                        "• 其他模式：可自由选择任意格式VAE，无格式限制\n"
                        "选「请选择模型…」可由下游节点直接接入外部VAE。"
                    ),
                }),
                "vae2_name": (all_vaes2, {
                    "display_name": "VAE模型2",
                    "default": PLACEHOLDER_VAE2,
                    "tooltip": (
                        "第二 VAE（常用于视频模型的音频 VAE：LTX / MMAudio / SA3 / MINIMAX H3 等）。\n"
                        "• 节点会同时输出 VAE1 与 VAE2 两个端口，下游按需接入。\n"
                        "• AIO 视频模型：内置视频 VAE 走 VAE 端口，音频 VAE 走此处。\n"
                        "• 兼容官方音频 VAE（带 audio_vae./vocoder. 前缀者自动转换）。\n"
                        "• 下拉仅列出 models/vae 中的 VAE 模型。"
                    ),
                }),
                "lock_unet_vram": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ UNET保活",
                    "label_off": "❎ 允许UNET卸载",
                    "display_name": "UNET保活",
                    "tooltip": (
                        "【开启（推荐）】UNET 保活：加载即预热到 GPU，复用工作流零延迟。\n"
                        "• 新版 ComfyUI 本身也会在首次使用后保持 UNET 常驻，本开关主要\n"
                        "  价值是“提前预热 + 多轮复用不重新加载”，不会造成旧版“分时显存\n"
                        "  优化”那种出图降速，属可选增益而非拖累。\n"
                        "• 不强制占满 VRAM，ComfyUI 仍按显存压力智能调度。\n"
                        "• 显存吃紧且工作流内含多个重型模型时，可关闭以释放余量。"
                    ),
                }),
            },
        }

    def load_model(self, main_model, clip_name, clip_type, vae_name,
                   vae2_name, lock_unet_vram):
        """核心执行逻辑"""

        # ═════ 早报错检查：所有文件IO之前完成 ═════

        # 检查主模型
        if main_model == PLACEHOLDER_MODEL or not main_model:
            raise ValueError(
                "[JosiaCheckpointPlus] ❌ 尚未选择主模型。\n"
                "请在「主模型」下拉框中选一个模型文件。"
            )

        # 检查CLIP类型
        is_aio = self._precheck_aio(main_model)
        clip_needs_type = (not is_aio and clip_name != PLACEHOLDER_CLIP and clip_name)
        gguf_clip = clip_needs_type and _is_gguf_path(clip_name)

        if clip_needs_type and not gguf_clip and clip_type == PLACEHOLDER_CLIP_TYPE:
            raise RuntimeError(
                "[JosiaCheckpointPlus] ❌ 未选择CLIP类型\n"
                "请在「CLIP类型」下拉框中手动选择合适的类型。\n"
                "（GGUF格式CLIP无需手动选类型）"
            )

        is_gguf = _is_gguf_path(main_model)

        main_path = _resolve_model_path(main_model)
        if main_path is None:
            raise ValueError(
                f"[JosiaCheckpointPlus] ❌ 主模型文件不存在：{main_model}\n"
                "请检查模型是否放在 models/checkpoints 或 models/diffusion_models 目录。"
            )

        file_size_mb = round(os.path.getsize(main_path) / (1024 * 1024), 1)

        # ═════ 分支加载 ═════
        if is_gguf:
            gguf_quant = _parse_gguf_quant(os.path.basename(main_model))
            model_obj, clip_obj, vae_obj, vae2_obj, model_type = self._load_gguf_unet(
                main_model, main_path, clip_name, clip_type, vae_name,
                vae2_name, lock_unet_vram
            )
        else:
            model_category = self._detect_category_from_file(main_path)
            if model_category == "aio":
                model_obj, clip_obj, vae_obj, vae2_obj, model_type = self._load_aio_checkpoint(
                    main_model, main_path, lock_unet_vram,
                    clip_type, vae2_name
                )
            else:
                model_obj, clip_obj, vae_obj, vae2_obj, model_type = self._load_standalone_unet(
                    main_model, main_path, clip_name, vae_name,
                    vae2_name, lock_unet_vram, clip_type
                )
            gguf_quant = None

        # ═════ 回传识别结果 ═════
        clip_size_mb = None
        vae_size_mb  = None
        if clip_obj is not None and clip_name and clip_name != PLACEHOLDER_CLIP:
            clip_size_mb = _get_file_size_for_folder(clip_name, "clip")
        if vae_obj is not None and vae_name and vae_name != PLACEHOLDER_VAE:
            vae_size_mb = _get_file_size_for_folder(vae_name, "vae")
        vae2_size_mb = None
        if vae2_obj is not None and vae2_name and vae2_name != PLACEHOLDER_VAE2:
            v2_path = self._resolve_vae_path(vae2_name)
            if v2_path:
                vae2_size_mb = round(os.path.getsize(v2_path) / (1024 * 1024), 1)

        ui_state = {
            "model_type": [model_type],
            "main_model": [main_model],
            "lock_unet": [lock_unet_vram],
            "file_size_mb": [file_size_mb],
            "clip_size_mb": [clip_size_mb],
            "vae_size_mb": [vae_size_mb],
            "vae2_size_mb": [vae2_size_mb],
            "gguf_quant": [gguf_quant],
            "clip_type": [clip_type],
        }
        # ── 登记到跨节点共享注册表 ──
        # 让「Josia媒体保存」等下游节点能**不连线**直接引用这里载入的 VAE / VAE2。
        # 登记失败绝不影响加载本身，所以整段吞异常。
        if _publish_vae is not None:
            try:
                _label1 = vae_name if (vae_name and vae_name != PLACEHOLDER_VAE) else main_model
                _label2 = vae2_name if (vae2_name and vae2_name != PLACEHOLDER_VAE2) else ""
                _publish_vae(vae=vae_obj, vae2=vae2_obj,
                             label1=_label1, label2=_label2, source=main_model)
            except Exception as _e:
                print(f"[JosiaCheckpointPlus] ⚠️ 模型共享登记失败（不影响本次加载）：{_e}")

        return {"ui": ui_state, "result": (model_obj, clip_obj, vae_obj, vae2_obj)}

    def _precheck_aio(self, model_name: str) -> bool:
        """快速预判是否为AIO模型（不加载完整文件）"""
        if _is_gguf_path(model_name):
            return False
        path = _resolve_model_path(model_name)
        if not path:
            return False
        ext = os.path.splitext(path)[1].lower()
        if ext in (".safetensors",):
            meta = _get_safetensors_metadata(path)
            if meta and "keys" in meta:
                return _detect_model_category(meta["keys"]) == "aio"
        return False

    # ─────── 加载分支 1：AIO Checkpoint ───────

    def _load_aio_checkpoint(self, model_name, model_path,
                              lock_unet_vram,
                              clip_type="stable_diffusion",
                              vae2_name=PLACEHOLDER_VAE2):
        print(f"[JosiaCheckpointPlus] ✅ 识别为 AIO Checkpoint：{model_name}")
        try:
            out = comfy.sd.load_checkpoint_guess_config(
                model_path,
                output_vae=True,
                output_clip=True,
                embedding_directory=folder_paths.get_folder_paths("embeddings"),
            )
        except Exception as e:
            raise RuntimeError(
                f"[JosiaCheckpointPlus] ❌ AIO模型加载失败：{model_name}\n"
                f"错误详情：{str(e)}"
            ) from e

        model_obj, clip_obj, vae_obj = out[0], out[1], out[2]
        vae2_obj = self._load_vae_optional(vae2_name)

        if lock_unet_vram and model_obj is not None:
            self._pin_unet(model_obj)

        print(
            f"[JosiaCheckpointPlus] ✅ AIO加载完成 | "
            f"VAE2={vae2_name if vae2_name != PLACEHOLDER_VAE2 else '无'} | "
            f"UNET锁定={'开' if lock_unet_vram else '关'}"
        )
        return model_obj, clip_obj, vae_obj, vae2_obj, "aio"

    # ─────── 加载分支 2：独立普通 UNET ───────

    def _load_standalone_unet(self, model_name, model_path, clip_name, vae_name,
                               vae2_name, lock_unet_vram, clip_type="stable_diffusion"):
        print(f"[JosiaCheckpointPlus] ✅ 识别为独立UNET：{model_name}")
        try:
            model_obj = comfy.sd.load_diffusion_model(model_path)
        except Exception:
            try:
                out = comfy.sd.load_checkpoint_guess_config(
                    model_path, output_vae=False, output_clip=False,
                    embedding_directory=folder_paths.get_folder_paths("embeddings"),
                )
                model_obj = out[0]
            except Exception as e:
                raise RuntimeError(
                    f"[JosiaCheckpointPlus] ❌ UNET模型加载失败：{model_name}\n"
                    f"错误详情：{str(e)}"
                ) from e

        clip_obj = self._load_clip_optional(clip_name, clip_type)
        vae_obj  = self._load_vae_optional(vae_name)
        vae2_obj = self._load_vae_optional(vae2_name)

        if lock_unet_vram and model_obj is not None:
            self._pin_unet(model_obj)

        print(
            f"[JosiaCheckpointPlus] ✅ 独立UNET加载完成 | "
            f"CLIP={clip_name} | VAE={vae_name} | VAE2={vae2_name if vae2_name != PLACEHOLDER_VAE2 else '无'}"
        )
        return model_obj, clip_obj, vae_obj, vae2_obj, "unet"

    # ─────── 加载分支 3：GGUF UNET ───────

    def _load_gguf_unet(self, model_name, model_path, clip_name, clip_type, vae_name,
                         vae2_name, lock_unet_vram):
        print(f"[JosiaCheckpointPlus] ✅ 识别为GGUF UNET：{model_name}")

        gguf_cls = _get_gguf_class("UnetLoaderGGUF")
        if gguf_cls is None:
            raise RuntimeError(
                f"[JosiaCheckpointPlus] ❌ 未找到 ComfyUI-GGUF 插件的 UnetLoaderGGUF 节点。\n"
                "本节点的 GGUF UNET 加载依赖 city96 的 ComfyUI-GGUF 插件。\n"
                "请先安装：\n"
                "  git clone https://github.com/city96/ComfyUI-GGUF custom_nodes/ComfyUI-GGUF\n"
                "  pip install gguf\n"
                "并将 GGUF UNET 放入 models/unet 或 models/diffusion_models。"
            )

        try:
            # 直接复用插件自身「经过验证」的加载逻辑（含 GGUFModelPatcher 包装与反量化）
            # 传入下拉框中的文件名（来自 unet_gguf 列表，GGUF 插件据此自行解析完整路径）
            unet_loader = gguf_cls()
            result = unet_loader.load_unet(model_name)
            model_obj = result[0]
        except Exception as e:
            raise RuntimeError(
                f"[JosiaCheckpointPlus] ❌ GGUF UNET 加载失败：{model_name}\n"
                f"错误详情：{str(e)}\n"
                "请确认：1) 已安装并启用 ComfyUI-GGUF 插件；"
                "2) 模型位于 models/unet 或 models/diffusion_models；"
                "3) 该 GGUF 文件对应的架构受支持。"
            ) from e

        if clip_name == PLACEHOLDER_CLIP:
            clip_obj = None
            print("[JosiaCheckpointPlus] ⚠️ GGUF UNET未指定CLIP，下游CLIP输出为空。")
        else:
            clip_obj = self._load_clip_optional(clip_name, clip_type)

        vae_obj = self._load_vae_optional(vae_name)
        vae2_obj = self._load_vae_optional(vae2_name)

        if lock_unet_vram and model_obj is not None:
            self._pin_unet(model_obj)

        print(
            f"[JosiaCheckpointPlus] ✅ GGUF UNET加载完成 | "
            f"CLIP={clip_name} | VAE={vae_name} | VAE2={vae2_name if vae2_name != PLACEHOLDER_VAE2 else '无'}"
        )
        return model_obj, clip_obj, vae_obj, vae2_obj, "gguf_unet"

    def _load_gguf_clip(self, clip_name: str, clip_type: str = None):
        """加载 GGUF 格式的 CLIP（t5 / llama / qwen / gemma3 等文本编码器）。"""
        gguf_cls = _get_gguf_class("CLIPLoaderGGUF")
        if gguf_cls is None:
            raise RuntimeError(
                "[JosiaCheckpointPlus] ❌ 未找到 ComfyUI-GGUF 插件的 CLIPLoaderGGUF 节点。\n"
                "GGUF CLIP 加载依赖 city96 的 ComfyUI-GGUF 插件，请先安装该插件。"
            )
        # GGUF 加载器按 CLIP 类型字符串（其内部 upper 匹配 CLIPType 枚举）选择架构
        if clip_type and clip_type != PLACEHOLDER_CLIP_TYPE:
            type_str = clip_type
        else:
            type_str = "stable_diffusion"
        try:
            clip_loader = gguf_cls()
            result = clip_loader.load_clip(clip_name, type=type_str)
            return result[0]
        except Exception as e:
            raise RuntimeError(
                f"[JosiaCheckpointPlus] ❌ GGUF CLIP 加载失败：{clip_name}\n"
                f"错误详情：{str(e)}\n"
                "请确认：1) 已安装 ComfyUI-GGUF；2) CLIP 类型选择正确；"
                "3) GGUF CLIP 位于 models/clip。"
            ) from e

    # ─────── 辅助：加载 CLIP/VAE ───────

    def _load_clip_optional(self, clip_name: str, clip_type: str = None):
        """加载CLIP，支持指定类型。GGUF 格式 CLIP 走 GGUF 插件加载器。"""
        if clip_name == PLACEHOLDER_CLIP:
            return None
        if _is_gguf_path(clip_name):
            return self._load_gguf_clip(clip_name, clip_type)
        clip_path = self._resolve_clip_path(clip_name)
        if clip_path is None:
            print(f"[JosiaCheckpointPlus] ⚠️ CLIP文件未找到：{clip_name}，输出空CLIP。")
            return None
        try:
            clip_type_enum = _clip_type_to_enum(clip_type) if clip_type and clip_type != PLACEHOLDER_CLIP_TYPE else None
            if clip_type_enum is None and not _is_gguf_path(clip_name):
                clip_type_enum = comfy.sd.CLIPType.STABLE_DIFFUSION
                print(f"[JosiaCheckpointPlus] ⚠️ CLIP类型未指定，使用STABLE_DIFFUSION兜底：{clip_name}")

            load_kwargs = {
                "ckpt_paths": [clip_path],
                "embedding_directory": folder_paths.get_folder_paths("embeddings"),
            }
            if clip_type_enum is not None:
                load_kwargs["clip_type"] = clip_type_enum

            clip_obj = comfy.sd.load_clip(**load_kwargs)
            return clip_obj
        except Exception as e:
            error_msg = str(e)
            if _is_gguf_path(clip_name):
                print(
                    f"[JosiaCheckpointPlus] ❌ GGUF CLIP加载失败：{clip_name}\n"
                    f"错误详情：{error_msg}\n"
                    f"可能原因：\n"
                    f"  1. ComfyUI-GGUF 插件未安装或版本过旧\n"
                    f"  2. PyTorch 2.6+ 改变了 torch.load 默认行为\n"
                    f"  3. GGUF CLIP 文件损坏\n"
                    f"解决方法：更新插件/降级PyTorch/重新下载"
                )
            else:
                print(f"[JosiaCheckpointPlus] ❌ CLIP加载失败：{clip_name} | {error_msg}")
            return None

    def _load_vae_optional(self, vae_name: str):
        if vae_name in (PLACEHOLDER_VAE, PLACEHOLDER_VAE2):
            return None
        vae_path = self._resolve_vae_path(vae_name)
        if vae_path is None:
            print(f"[JosiaCheckpointPlus] ⚠️ VAE文件未找到：{vae_name}，输出空VAE。")
            return None
        try:
            vae_sd, vae_metadata = comfy.utils.load_torch_file(vae_path, return_metadata=True)
            vae_obj = self._build_vae(vae_sd, vae_metadata)
            return vae_obj
        except Exception as e:
            print(f"[JosiaCheckpointPlus] ❌ VAE加载失败：{vae_name} | {str(e)}")
            return None

    def _build_vae(self, vae_sd, vae_metadata=None):
        """构造 VAE，兼容普通图像/视频 VAE 与音频 VAE（LTX / MMAudio / SA3 / MINIMAX 等）。

        官方 comfy.sd.VAE 已能按 state_dict 自动识别绝大多数架构；
        但部分音频 VAE（如 LTX 音频 VAE）权 key 带 audio_vae./vocoder. 前缀，
        直接构造会“No VAE weights detected”。此处对齐官方 LTXVAudioVAELoader，
        先做前缀替换（audio_vae.→autoencoder.，vocoder.→vocoder.）再重试。
        """
        # 1) 直接构造：覆盖标准图像/视频 VAE 及大部分音频 VAE
        try:
            vae = comfy.sd.VAE(sd=vae_sd, metadata=vae_metadata)
            vae.throw_exception_if_invalid()
            return vae
        except Exception:
            pass
        # 2) 音频 VAE：键前缀替换后重试（官方 LTXVAudioVAELoader 同款逻辑）
        try:
            sd2 = comfy.utils.state_dict_prefix_replace(
                vae_sd,
                {"audio_vae.": "autoencoder.", "vocoder.": "vocoder."},
                filter_keys=True,
            )
            if sd2:
                vae = comfy.sd.VAE(sd=sd2, metadata=vae_metadata)
                vae.throw_exception_if_invalid()
                return vae
        except Exception:
            pass
        raise RuntimeError("No VAE weights detected")

    def _resolve_clip_path(self, clip_name: str):
        try:
            path = folder_paths.get_full_path("clip", clip_name)
            if path and os.path.exists(path):
                return path
        except Exception:
            pass
        if os.path.isabs(clip_name) and os.path.exists(clip_name):
            return clip_name
        return None

    def _resolve_vae_path(self, vae_name: str):
        # 同时支持 models/vae 与 models/checkpoints（官方音频 VAE 多置于 checkpoints）
        for folder_key in ("vae", "checkpoints"):
            try:
                path = folder_paths.get_full_path(folder_key, vae_name)
                if path and os.path.exists(path):
                    return path
            except Exception:
                pass
        if os.path.isabs(vae_name) and os.path.exists(vae_name):
            return vae_name
        return None

    def _pin_unet(self, model_obj):
        """UNET 保活：仅防止 ComfyUI 意外卸载，不强制占满 VRAM。
        将 ModelPatcher 重新注册到 ComfyUI 的 current_loaded_models，
        确保它不会被意外 GC 卸载。
        ComfyUI 会根据实际可用 VRAM 智能决定加载策略。"""
        try:
            # model_obj 本身就是 ModelPatcher，直接传入
            comfy.model_management.load_models_gpu(
                [model_obj],
                force_full_load=False
            )
        except Exception:
            pass

    def _detect_category_from_file(self, model_path: str) -> str:
        """快速检测模型是 AIO 还是独立UNET。
        仅读取 safetensors 文件头（<10ms），避免加载完整模型。"""
        try:
            ext = os.path.splitext(model_path)[1].lower()
            if ext in (".safetensors",):
                meta = _get_safetensors_metadata(model_path)
                if meta and "keys" in meta:
                    return _detect_model_category(meta["keys"])
            # 非 safetensors：不做完整加载检测，默认按 AIO 处理
            # load_checkpoint_guess_config 内部会自行判断是否有 CLIP/VAE
            return "aio"
        except Exception as e:
            print(f"[JosiaCheckpointPlus] ⚠️ 模型类别检测失败，默认按AIO处理：{e}")
            return "aio"


# ========================== ComfyUI 节点映射 ==========================

NODE_CLASS_MAPPINGS = {
    "JosiaCheckpointPlus": JosiaCheckpointPlus
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaCheckpointPlus": "Josia模型加载"
}
