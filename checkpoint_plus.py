"""
Josia CheckpointPlus - 高级智能模型加载节点 v2.9.7
v2.9.7 变更：
  - 彻底移除「分时显存优化」功能（定时卸载CLIP/VAE导致出图降速至201s）
    该功能已无存在价值，后续可用独立节点实现显存调度
  - 状态栏"保活"标签扩展为"UNET保活"
v2.9.6 变更：
  - 移除 _SmartCLIP / _SmartVAE 包装器（不再干扰 ComfyUI 原生调度）
  - UNET 锁定改为仅保活模式：不强制占满 VRAM，
    让 ComfyUI 自行决定缓存位置（VRAM 或共享显存）
  - 修复 _detect_category_from_file 对非 safetensors 文件的重复加载
  - 移除无效的 vram_management_mode 字段
  - timed_vram 参数不再影响加载逻辑（ComfyUI 原生调度已最优）
v2.9.5 变更：
  - 移除「模型精度」调节功能（FP8/FP16/FP32等）
  - 理由：在RTX 4060上无正收益（无FP8硬件加速）
  -       已FP8的模型执行冗余转换会导致内存抖动+画质劣化
v2.9.4 修复：
  - AIO模式下CLIP类型不再替换为"已自动识别（内置）"文本
  - 改为保持原值+禁用，避免运行时"Value not in list"报错
  - 统一_origValues命名规范
v2.9.3 修复：
  - 占位文本统一+Emoji图标（🖼️主模型 🧠CLIP 🏷️类型 🎨VAE）
  - AIO模式下禁用控件显示"已使用内置XXX"提示文本
  - GGUF模式不再过滤CLIP列表（允许搭配非GGUF CLIP）
  - GGUF模式CLIP类型可手动选择（对齐原生GGUF加载器行为）
  - 移除GGUF UNET强制搭配GGUF CLIP限制
v2.9.1 修复：
  - CLIP类型下拉框全量显示（不再按枚举过滤，修复只有LTXV可选的问题）
  - 取消自动识别CLIP类型，纯手动选择（简化逻辑，减少BUG）
  - 1:1 复刻原生CLIPLoader类型列表
  - 控件顺序重排：主模型→CLIP模型→CLIP类型→VAE模型→UNET锁→分时优化
  - 关闭OUTPUT_NODE（无下游不执行）
  - 分时显存优化默认关闭，提示"低配电脑启用可防OOM但出图较慢"
  - 智能常驻显存策略：非分时模式不再强制卸载CLIP到系统内存
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

# ========================== 常量 ==========================

CATEGORY = "Josia"

PLACEHOLDER_MODEL     = "🖼️ 请选择模型…"
PLACEHOLDER_CLIP      = "🧠 请选择模型…"
PLACEHOLDER_VAE       = "🎨 请选择模型…"
PLACEHOLDER_CLIP_TYPE = "🏷️ 请选择类型…"

# ── CLIP 类型选项（1:1 复刻原生 CLIPLoader 列表） ──
CLIP_TYPE_OPTIONS = [
    PLACEHOLDER_CLIP_TYPE,
    "sdxl",
    "stable_diffusion",
    "lumina2",
    "qwen_image",
    "flux",
    "flux2",
    "sd3",
    "stable_cascade",
    "mochi",
    "wan",
    "hunyuan_image",
    "pixart",
    "LTXV",
    "chroma",
    "ACE_Clip",
    "pixeledit",
    "ideogram4",
    "longcat_image",
    "lens",
    "ovis",
    "omnigen2",
    "cogvideox",
    "stable_audio",
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


def _get_all_checkpoints() -> list:
    try:
        return folder_paths.get_filename_list("checkpoints")
    except Exception:
        return []


def _get_all_unets() -> list:
    # 常规 diffusion_models 列表（已含 .gguf，因 GGUF 插件把 .gguf 注册进了扩展名）
    base = []
    try:
        base = folder_paths.get_filename_list("diffusion_models")
    except Exception:
        pass

    # GGUF UNET：优先使用 ComfyUI-GGUF 插件注册的 unet_gguf 列表
    # （其文件名可被 GGUF 加载器直接解析，是最可靠的来源）
    gguf_extra = []
    try:
        gguf_extra = list(folder_paths.get_filename_list("unet_gguf"))
    except Exception:
        gguf_extra = []

    # 兜底：直接遍历文件夹（兼容插件未注册 / 自定义路径的极端情况）
    try:
        paths = list(folder_paths.get_folder_paths("diffusion_models"))
    except Exception:
        paths = []
    try:
        paths += list(folder_paths.get_folder_paths("unet_gguf"))
    except Exception:
        pass
    for folder in paths:
        if not os.path.isdir(folder):
            continue
        for root, _, files in os.walk(folder):
            for f in files:
                if f.lower().endswith(".gguf"):
                    rel = os.path.relpath(os.path.join(root, f), folder)
                    rel = rel.replace("\\", "/")
                    if rel not in gguf_extra:
                        gguf_extra.append(rel)

    combined = []
    seen = set()
    for f in base + gguf_extra:
        if f not in seen:
            seen.add(f)
            combined.append(f)
    return combined


def _get_all_clips() -> list:
    # 常规 clip 列表
    base = []
    try:
        base = folder_paths.get_filename_list("clip")
    except Exception:
        pass

    # GGUF CLIP：优先使用 ComfyUI-GGUF 插件注册的 clip_gguf 列表
    gguf_extra = []
    try:
        gguf_extra = list(folder_paths.get_filename_list("clip_gguf"))
    except Exception:
        gguf_extra = []

    # 兜底：直接遍历文件夹（兼容插件未注册的极端情况）
    try:
        paths = list(folder_paths.get_folder_paths("clip"))
    except Exception:
        paths = []
    try:
        paths += list(folder_paths.get_folder_paths("clip_gguf"))
    except Exception:
        pass
    for folder in paths:
        if not os.path.isdir(folder):
            continue
        for root, _, files in os.walk(folder):
            for f in files:
                if f.lower().endswith(".gguf"):
                    rel = os.path.relpath(os.path.join(root, f), folder)
                    rel = rel.replace("\\", "/")
                    if rel not in gguf_extra:
                        gguf_extra.append(rel)

    combined = []
    seen = set()
    for f in base + gguf_extra:
        if f not in seen:
            seen.add(f)
            combined.append(f)
    return combined


def _get_all_vaes() -> list:
    try:
        return folder_paths.get_filename_list("vae")
    except Exception:
        return []


def _get_combined_model_list() -> list:
    """合并 checkpoint + unet 列表"""
    checkpoints = _get_all_checkpoints()
    unets = _get_all_unets()
    combined = []
    seen = set()
    for f in checkpoints + unets:
        if f not in seen:
            seen.add(f)
            combined.append(f)
    return combined if combined else []


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


def detect_model_type_public(model_name: str, clip_name: str = None, vae_name: str = None) -> dict:
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
                result = detect_model_type_public(model_name, clip_name, vae_name)
                return web.json_response(result)
            except Exception as e:
                return web.json_response({
                    "model_type": "unknown",
                    "error": str(e),
                }, status=500)

        print("[JosiaCheckpointPlus] ✅ API端点已注册 → /josia/detect_model_type")

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

    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("MODEL", "CLIP", "VAE")

    @classmethod
    def INPUT_TYPES(cls):
        model_list_raw = _get_combined_model_list()
        model_list = [PLACEHOLDER_MODEL] + model_list_raw if model_list_raw else [PLACEHOLDER_MODEL]
        all_clips = [PLACEHOLDER_CLIP] + _get_all_clips()
        all_vaes  = [PLACEHOLDER_VAE] + _get_all_vaes()

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
                    "display_name": "VAE模型",
                    "default": PLACEHOLDER_VAE,
                    "tooltip": (
                        "• AIO模型：自动禁用，复用模型内置VAE\n"
                        "• 其他模式：可自由选择任意格式VAE，无格式限制\n"
                        "选「请选择模型…」可由下游节点直接接入外部VAE。"
                    ),
                }),
                "lock_unet_vram": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ UNET保活",
                    "label_off": "❎ 允许UNET卸载",
                    "display_name": "UNET保活",
                    "tooltip": (
                        "【开启（推荐）】防止 ComfyUI 意外卸载 UNET 模型\n"
                        "• 不强制占用物理 VRAM，允许 ComfyUI 智能调度\n"
                        "• 修改提示词或下游节点时，UNET 保留在内存中\n"
                        "• 复用工作流时跳过 UNET 重新加载，速度更快\n\n"
                        "【关闭】允许 ComfyUI 在显存压力时正常卸载 UNET"
                    ),
                }),
            },
        }

    def load_model(self, main_model, clip_name, clip_type, vae_name,
                   lock_unet_vram):
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
            model_obj, clip_obj, vae_obj, model_type = self._load_gguf_unet(
                main_model, main_path, clip_name, clip_type, vae_name,
                lock_unet_vram
            )
        else:
            model_category = self._detect_category_from_file(main_path)
            if model_category == "aio":
                model_obj, clip_obj, vae_obj, model_type = self._load_aio_checkpoint(
                    main_model, main_path, lock_unet_vram,
                    clip_type
                )
            else:
                model_obj, clip_obj, vae_obj, model_type = self._load_standalone_unet(
                    main_model, main_path, clip_name, vae_name,
                    lock_unet_vram, clip_type
                )
            gguf_quant = None

        # ═════ 回传识别结果 ═════
        clip_size_mb = None
        vae_size_mb  = None
        if clip_obj is not None and clip_name and clip_name != PLACEHOLDER_CLIP:
            clip_size_mb = _get_file_size_for_folder(clip_name, "clip")
        if vae_obj is not None and vae_name and vae_name != PLACEHOLDER_VAE:
            vae_size_mb = _get_file_size_for_folder(vae_name, "vae")

        ui_state = {
            "model_type": [model_type],
            "main_model": [main_model],
            "lock_unet": [lock_unet_vram],
            "file_size_mb": [file_size_mb],
            "clip_size_mb": [clip_size_mb],
            "vae_size_mb": [vae_size_mb],
            "gguf_quant": [gguf_quant],
            "clip_type": [clip_type],
        }
        return {"ui": ui_state, "result": (model_obj, clip_obj, vae_obj)}

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
                              clip_type="stable_diffusion"):
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

        if lock_unet_vram and model_obj is not None:
            self._pin_unet(model_obj)

        print(
            f"[JosiaCheckpointPlus] ✅ AIO加载完成 | "
            f"UNET锁定={'开' if lock_unet_vram else '关'}"
        )
        return model_obj, clip_obj, vae_obj, "aio"

    # ─────── 加载分支 2：独立普通 UNET ───────

    def _load_standalone_unet(self, model_name, model_path, clip_name, vae_name,
                               lock_unet_vram, clip_type="stable_diffusion"):
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

        if lock_unet_vram and model_obj is not None:
            self._pin_unet(model_obj)

        print(
            f"[JosiaCheckpointPlus] ✅ 独立UNET加载完成 | "
            f"CLIP={clip_name} | VAE={vae_name}"
        )
        return model_obj, clip_obj, vae_obj, "unet"

    # ─────── 加载分支 3：GGUF UNET ───────

    def _load_gguf_unet(self, model_name, model_path, clip_name, clip_type, vae_name,
                         lock_unet_vram):
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

        if lock_unet_vram and model_obj is not None:
            self._pin_unet(model_obj)

        print(
            f"[JosiaCheckpointPlus] ✅ GGUF UNET加载完成 | "
            f"CLIP={clip_name} | VAE={vae_name}"
        )
        return model_obj, clip_obj, vae_obj, "gguf_unet"

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
        if vae_name == PLACEHOLDER_VAE:
            return None
        vae_path = self._resolve_vae_path(vae_name)
        if vae_path is None:
            print(f"[JosiaCheckpointPlus] ⚠️ VAE文件未找到：{vae_name}，输出空VAE。")
            return None
        try:
            vae_sd  = comfy.utils.load_torch_file(vae_path)
            vae_obj = comfy.sd.VAE(sd=vae_sd)
            return vae_obj
        except Exception as e:
            print(f"[JosiaCheckpointPlus] ❌ VAE加载失败：{vae_name} | {str(e)}")
            return None

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
        try:
            path = folder_paths.get_full_path("vae", vae_name)
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
