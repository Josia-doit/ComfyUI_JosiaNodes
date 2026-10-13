"""
Josia LoRA 堆叠 · 触发词配置后端 v1.0
功能：
1. 用户配置目录 <节点包>/user_config/lora_trigger/ 的创建与读写；
2. 每个 LoRA 文件名唯一绑定一套配置：触发词文本（json）+ 预览缩略图（webp）；
3. 预览图统一压缩：长边 800 等比缩放、WebP 质量 50（Pillow，ComfyUI 内置）；
4. HTTP 路由 /josia_lora_trigger/* 供前端查询 / 保存 / 删除 / 手动添加。

本地文件名：lora_trigger.py
路由前缀：/josia_lora_trigger（与文件名一致，改名时路由也要同步改，第三方写死路由的页面会 404）

安全设计：
  · key 由 LoRA 文件名经 URL 编码生成（urllib.parse.quote），天然免疫路径穿越；
  · 所有路由对 key 做白名单字符校验（字母数字 . _ % -），不满足直接 400；
  · 只操作 user_config/lora_trigger/ 目录内的文件，不暴露任何任意路径读写。
"""
import os
import re
import io
import json
import time
import base64
import subprocess
import urllib.parse

# ComfyUI 运行时才有 folder_paths / server；脱离 ComfyUI 单独导入（测试）时降级
try:
    import folder_paths  # noqa: F401  （仅确认运行环境，不直接使用）
except Exception:
    folder_paths = None

try:
    from PIL import Image
except Exception:
    Image = None

# ==================== 目录与常量 ====================
# 用户配置根目录：节点包内 user_config/（未来其他节点需要记录配置也放这里，按功能分子目录）
NODE_PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
USER_CONFIG_DIR = os.path.join(NODE_PACKAGE_DIR, "user_config")
# 本功能的配置子目录
TRIGGER_DIR = os.path.join(USER_CONFIG_DIR, "lora_trigger")

# 预览图压缩规格（哥哥定稿：长边 800、webp 质量 50）
THUMB_MAX_EDGE = 800
THUMB_QUALITY = 50
# WebP method 预设（对齐 media_save.py：quality>=60 用 4，否则 0）
THUMB_METHOD = 4 if THUMB_QUALITY >= 60 else 0

# key 白名单：quote 后只可能出现这些字符；上限 200 防超长文件名
_KEY_RE = re.compile(r"^[A-Za-z0-9._%-]{1,200}$")
# 触发词文本长度上限（防止异常大 payload）
MAX_TEXT_LEN = 4000
# LoRA 原名长度上限
MAX_NAME_LEN = 200


def _migrate_backslash_keys():
    """一次性把历史遗留的 %5C（反斜线）key 文件收敛到 %2F（正斜线），避免重复配置。
    若该 LoRA 的 %2F 文件已存在，则保留较新（mtime 大）的一份、删除较旧文件，不丢较新数据。"""
    try:
        names = os.listdir(TRIGGER_DIR)
    except Exception:
        return
    for fn in names:
        if "%5C" not in fn:
            continue
        src = os.path.join(TRIGGER_DIR, fn)
        dst = os.path.join(TRIGGER_DIR, fn.replace("%5C", "%2F"))
        if not os.path.isfile(src):
            continue
        try:
            if not os.path.exists(dst):
                os.replace(src, dst)
            elif os.path.getmtime(src) > os.path.getmtime(dst):
                os.replace(src, dst)
            else:
                os.remove(src)
        except Exception as e:
            print(f"[JosiaLoraTrigger] ⚠️ 迁移旧 key 失败 {fn}: {e}")


def ensure_dirs():
    """确保用户配置目录存在（幂等）。后端加载与各路由入口都会调用。"""
    try:
        os.makedirs(TRIGGER_DIR, exist_ok=True)
        _migrate_backslash_keys()
        return True
    except Exception as e:
        print(f"[JosiaLoraTrigger] ⚠️ 创建配置目录失败：{e}")
        return False


def norm_lora(name):
    """归一化 LoRA 名：反斜线统一为正斜线。
    节点面板（Windows 上取到的内部名可能带 \\）与后端 /loras 接口（已归一为 /）
    分隔符不一致，会导致同一 LoRA 生成 %2F 与 %5C 两个不同的配置文件，
    节点因此只读得到自己那一份。统一为 / 即可对齐（与 ComfyUI get_filename_list 一致）。"""
    s = (name or "").strip()[:MAX_NAME_LEN]
    s = s.replace("\\", "/")
    return s


def safe_key(lora_name):
    """LoRA 文件名 → 配置 key（URL 编码，唯一且免疫路径穿越）。"""
    name = norm_lora(lora_name)
    if not name:
        return ""
    # quote 默认不编码字母数字与 _.-~ ，其余全部 %XX；'/' 变 %2F
    return urllib.parse.quote(name, safe="")


def key_of(requested):
    """校验并归一化前端传来的 key；不合法返回 None。"""
    if not isinstance(requested, str):
        return None
    k = requested.strip()
    if not _KEY_RE.match(k):
        return None
    return k


def _paths(key):
    """key → (json 路径, webp 路径)。调用方必须保证 key 已通过 key_of 校验。"""
    return (
        os.path.join(TRIGGER_DIR, key + ".json"),
        os.path.join(TRIGGER_DIR, key + ".webp"),
    )


def load_cfg(key):
    """读取单个 LoRA 的配置；不存在返回空壳。"""
    json_path, webp_path = _paths(key)
    cfg = {"key": key, "lora": "", "text": "", "has_image": False, "updated": 0}
    try:
        if os.path.isfile(json_path):
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                cfg["lora"] = norm_lora(data.get("lora", ""))
                cfg["text"] = str(data.get("text", ""))[:MAX_TEXT_LEN]
                cfg["updated"] = int(data.get("updated", 0) or 0)
    except Exception as e:
        print(f"[JosiaLoraTrigger] ⚠️ 读取配置失败 {key}: {e}")
    cfg["has_image"] = os.path.isfile(webp_path)
    # 文件真实 mtime 兜底（json 损坏 / 缺字段时保证时间有序）
    try:
        if os.path.isfile(json_path):
            cfg["updated"] = max(cfg["updated"], int(os.path.getmtime(json_path)))
    except Exception:
        pass
    return cfg


def save_cfg(key, lora_name=None, text=None):
    """写入 / 更新 json（保留未提供的字段）。返回最新配置。"""
    ensure_dirs()
    json_path, _ = _paths(key)
    cur = load_cfg(key)
    if lora_name is not None:
        cur["lora"] = norm_lora(lora_name)
    if text is not None:
        cur["text"] = str(text)[:MAX_TEXT_LEN]
    cur["key"] = key
    cur["updated"] = int(time.time())
    tmp = json_path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(
                {"lora": cur["lora"], "text": cur["text"], "updated": cur["updated"]},
                f, ensure_ascii=False,
            )
        os.replace(tmp, json_path)  # 原子替换，避免写一半损坏
    except Exception as e:
        print(f"[JosiaLoraTrigger] ❌ 保存配置失败 {key}: {e}")
        raise
    return cur


def delete_cfg(key):
    """删除单条配置（json + webp 一起删）。"""
    json_path, webp_path = _paths(key)
    removed = []
    for p in (json_path, webp_path):
        try:
            if os.path.isfile(p):
                os.remove(p)
                removed.append(os.path.basename(p))
        except Exception as e:
            print(f"[JosiaLoraTrigger] ⚠️ 删除失败 {p}: {e}")
    return removed


def list_configs():
    """扫描配置目录，返回全部配置列表（按更新时间倒序）。"""
    ensure_dirs()
    out = []
    try:
        names = os.listdir(TRIGGER_DIR)
    except Exception:
        return out
    for fn in names:
        if not fn.endswith(".json"):
            continue
        key = fn[:-5]
        if not key_of(key):
            continue
        cfg = load_cfg(key)
        if cfg["lora"] or cfg["text"] or cfg["has_image"]:
            out.append(cfg)
    out.sort(key=lambda c: c.get("updated", 0), reverse=True)
    return out


def compress_image_bytes(data, dst_path):
    """
    把任意图像字节压缩为 WebP：长边 THUMB_MAX_EDGE 等比缩放、质量 THUMB_QUALITY。
    返回 (width, height)。失败抛异常由调用方转 400。
    """
    if Image is None:
        raise RuntimeError("Pillow 不可用（ComfyUI 运行环境必然内置，请检查环境）")
    with Image.open(io.BytesIO(data)) as im:
        im.load()
        # 统一转 RGB：webp 不支持 CMYK / 带透明通道按需处理
        if im.mode in ("RGBA", "LA", "PA"):
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        elif im.mode != "RGB":
            im = im.convert("RGB")
        w, h = im.size
        longest = max(w, h)
        if longest > THUMB_MAX_EDGE:
            scale = THUMB_MAX_EDGE / float(longest)
            nw = max(1, round(w * scale))
            nh = max(1, round(h * scale))
            im = im.resize((nw, nh), Image.LANCZOS)
            w, h = nw, nh
        tmp = dst_path + ".tmp"
        im.save(tmp, "WEBP", quality=THUMB_QUALITY, method=THUMB_METHOD)
        os.replace(tmp, dst_path)
        return (w, h)


def parse_data_url(s):
    """解析 data:image/...;base64,.... 返回原始字节；不是 dataURL 返回 None。"""
    if not isinstance(s, str):
        return None
    marker = "base64,"
    idx = s.find(marker)
    if not s.startswith("data:") or idx < 0:
        return None
    try:
        return base64.b64decode(s[idx + len(marker):])
    except Exception:
        return None


def resolve_key(body, lora):
    """
    从请求体解析配置 key：显式传了 key 就严格校验（非法即拒，不静默回退）；
    没传 key 则由 LoRA 名推导。返回 (key, error)。
    """
    raw = body.get("key", "")
    if raw:
        k = key_of(str(raw))
        if not k:
            return None, "bad key"
        return k, None
    if lora:
        k = safe_key(lora)
        if k and key_of(k):
            return k, None
    return None, "bad key"


def _json_ok(payload):
    from aiohttp import web
    return web.json_response(payload)


# ==================== HTTP 路由 ====================
def register_routes():
    """注册 /josia_lora_trigger/* 路由。无 ComfyUI server / 未初始化时静默跳过（测试导入）。"""
    try:
        from server import PromptServer
    except Exception:
        print("[JosiaLoraTrigger] ⚠️ 无 PromptServer，跳过路由注册（脱离 ComfyUI 运行）")
        return False
    # ComfyUI 启动早期 / 脱离 ComfyUI 单独导入时 instance 尚未创建，跳过即可
    if getattr(PromptServer, "instance", None) is None:
        print("[JosiaLoraTrigger] ⚠️ PromptServer 未初始化，跳过路由注册")
        return False

    ensure_dirs()

    @PromptServer.instance.routes.get("/josia_lora_trigger/configs")
    async def get_configs(request):
        """全部 LoRA 触发词配置（管理窗口 + 节点面板共用）。"""
        try:
            return _json_ok({"success": True, "configs": list_configs(),
                             "dir": TRIGGER_DIR})
        except Exception as e:
            return _json_ok({"success": False, "error": str(e)})

    @PromptServer.instance.routes.get("/josia_lora_trigger/image/{key}")
    async def get_image(request):
        """返回某个 LoRA 的预览缩略图（webp）。"""
        from aiohttp import web
        # aiohttp 对 path 段是否解码 %2F 随行为而定，这里双形态兼容：
        # 原样（编码态）可直接匹配；若已被解码成含 / 的原始名，则重新编码
        raw = request.match_info.get("key", "")
        key = key_of(raw) or key_of(safe_key(raw))
        if not key:
            return web.Response(status=400, text="bad key")
        _, webp_path = _paths(key)
        if not os.path.isfile(webp_path):
            return web.Response(status=404, text="no image")
        try:
            with open(webp_path, "rb") as f:
                body = f.read()
        except Exception as e:
            return web.Response(status=500, text=str(e))
        return web.Response(
            body=body, content_type="image/webp",
            headers={"Cache-Control": "no-cache"},  # 替换图后立即见效
        )

    @PromptServer.instance.routes.post("/josia_lora_trigger/save_text")
    async def save_text(request):
        """保存触发词文本。body: {key|lora, text}"""
        try:
            body = await request.json()
        except Exception:
            return _json_ok({"success": False, "error": "bad json"})
        lora = norm_lora(body.get("lora", ""))
        key, kerr = resolve_key(body, lora)
        if not key or not lora:
            return _json_ok({"success": False, "error": kerr or "bad key"})
        text = str(body.get("text", "") or "")[:MAX_TEXT_LEN]
        try:
            cfg = save_cfg(key, lora_name=lora, text=text)
            return _json_ok({"success": True, "config": cfg})
        except Exception as e:
            return _json_ok({"success": False, "error": str(e)})

    @PromptServer.instance.routes.post("/josia_lora_trigger/save_image")
    async def save_image(request):
        """保存预览图（前端传 dataURL，后端统一压缩为 webp 长边800 质量50）。
        body: {key|lora, image: dataURL}"""
        try:
            body = await request.json()
        except Exception:
            return _json_ok({"success": False, "error": "bad json"})
        lora = norm_lora(body.get("lora", ""))
        key, kerr = resolve_key(body, lora)
        if not key or not lora:
            return _json_ok({"success": False, "error": kerr or "bad key"})
        data = parse_data_url(body.get("image", ""))
        if not data:
            return _json_ok({"success": False, "error": "bad image"})
        if len(data) > 20 * 1024 * 1024:
            return _json_ok({"success": False, "error": "image too large"})
        ensure_dirs()
        _, webp_path = _paths(key)
        try:
            w, h = compress_image_bytes(data, webp_path)
        except Exception as e:
            return _json_ok({"success": False, "error": f"compress failed: {e}"})
        try:
            cfg = save_cfg(key, lora_name=lora)  # 确保 json 存在并记录 lora 名
        except Exception as e:
            return _json_ok({"success": False, "error": str(e)})
        cfg["has_image"] = True
        cfg["size"] = [w, h]
        return _json_ok({"success": True, "config": cfg})

    @PromptServer.instance.routes.post("/josia_lora_trigger/delete")
    async def delete_one(request):
        """删除单条配置。body: {key}"""
        try:
            body = await request.json()
        except Exception:
            return _json_ok({"success": False, "error": "bad json"})
        key = key_of(body.get("key", ""))
        if not key:
            return _json_ok({"success": False, "error": "bad key"})
        removed = delete_cfg(key)
        return _json_ok({"success": True, "removed": removed})

    @PromptServer.instance.routes.post("/josia_lora_trigger/add")
    async def add_one(request):
        """管理窗口手动添加一条配置（只写文本，图可后补）。
        body: {lora, text}"""
        try:
            body = await request.json()
        except Exception:
            return _json_ok({"success": False, "error": "bad json"})
        lora = norm_lora(body.get("lora", ""))
        if not lora:
            return _json_ok({"success": False, "error": "empty lora name"})
        key = safe_key(lora)
        if not key_of(key):
            return _json_ok({"success": False, "error": "bad key"})
        text = str(body.get("text", "") or "")[:MAX_TEXT_LEN]
        try:
            cfg = save_cfg(key, lora_name=lora, text=text)
            return _json_ok({"success": True, "config": cfg})
        except Exception as e:
            return _json_ok({"success": False, "error": str(e)})

    @PromptServer.instance.routes.post("/josia_lora_trigger/open_dir")
    async def open_dir(request):
        """在文件管理器中打开本地配置目录（仅本机运行的 ComfyUI 有效）。"""
        ensure_dirs()
        try:
            if os.name == "nt":
                os.startfile(TRIGGER_DIR)          # Windows
            elif sys.platform == "darwin":
                subprocess.run(["open", TRIGGER_DIR], check=False)
            else:
                subprocess.run(["xdg-open", TRIGGER_DIR], check=False)
            return _json_ok({"success": True})
        except Exception as e:
            return _json_ok({"success": False, "error": str(e)})

    @PromptServer.instance.routes.get("/josia_lora_trigger/loras")
    async def list_loras(request):
        """返回 ComfyUI loras 文件夹内的全部 LoRA 文件名（refresh=1 重新扫描，等效主界面 R 键）。

        防御式实现：优先用 ComfyUI 的 folder_paths.get_filename_list；若其不可用或抛异常，
        则直接遍历 loras 目录兜底，避免静默返回空列表导致前端下拉永远为空。
        """
        refresh = str(request.query.get("refresh", "0")).lower() in ("1", "true", "yes")
        names = []
        err = None
        try:
            import folder_paths  # 在函数内导入，避免使用顶层可能为 None 的引用
            if refresh and hasattr(folder_paths, "get_filename_list"):
                try:
                    folder_paths.get_filename_list("loras", refresh=True)
                except Exception:
                    pass
            if hasattr(folder_paths, "get_filename_list"):
                try:
                    names = list(folder_paths.get_filename_list("loras", refresh=refresh))
                except Exception as e:
                    print(f"[JosiaLoraTrigger] ⚠️ get_filename_list 失败，改用目录遍历兜底：{e}")
                    names = []
            # 兜底：直接遍历 loras 目录（含子目录），保证即使在异常分支也能返回真实文件
            if not names and hasattr(folder_paths, "get_folder_paths"):
                base_dirs = folder_paths.get_folder_paths("loras") or []
                exts = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf")
                for base in base_dirs:
                    if not os.path.isdir(base):
                        continue
                    for root, _dirs, files in os.walk(base):
                        for f in files:
                            if f.lower().endswith(exts):
                                rel = os.path.relpath(os.path.join(root, f), base)
                                names.append(rel.replace(os.sep, "/"))
        except Exception as e:
            err = str(e)
            print(f"[JosiaLoraTrigger] ⚠️ 读取 loras 列表失败：{e}")
        if err:
            return _json_ok({"success": False, "error": err, "loras": []})
        # 去重并保持稳定顺序
        seen = set()
        uniq = []
        for n in names:
            if n and n not in seen:
                seen.add(n)
                uniq.append(n)
        return _json_ok({"success": True, "loras": uniq})

    @PromptServer.instance.routes.get("/josia_lora_trigger/export")
    async def export_configs(request):
        """导出全部 LoRA 触发词配置（含预览图 base64）为单个 JSON，便于本地备份。

        返回：{success, version, exported_at, configs:[{key, lora, text, updated, image}]}
        image 为 data:image/webp;base64,... 或 null。
        """
        try:
            configs = list_configs()
            out = []
            for c in configs:
                key = c.get("key", "")
                item = {
                    "key": key,
                    "lora": c.get("lora", ""),
                    "text": c.get("text", ""),
                    "updated": c.get("updated", 0),
                    "image": None,
                }
                _, webp_path = _paths(key)
                if os.path.isfile(webp_path):
                    try:
                        with open(webp_path, "rb") as f:
                            b = f.read()
                        item["image"] = "data:image/webp;base64," + base64.b64encode(b).decode("ascii")
                    except Exception as e:
                        print(f"[JosiaLoraTrigger] ⚠️ 导出图片失败 {key}: {e}")
                out.append(item)
            return _json_ok({
                "success": True,
                "version": 1,
                "exported_at": int(time.time()),
                "configs": out,
            })
        except Exception as e:
            return _json_ok({"success": False, "error": str(e)})

    @PromptServer.instance.routes.post("/josia_lora_trigger/import")
    async def import_configs(request):
        """从导出文件恢复配置：逐条写回 json + webp（合并已有、新增缺失，不删除未包含项）。

        body: {configs:[{key, lora, text, updated, image}]}
        返回：{success, imported, skipped, errors}
        """
        try:
            body = await request.json()
        except Exception:
            return _json_ok({"success": False, "error": "bad json"})
        items = body.get("configs") if isinstance(body, dict) else None
        if not isinstance(items, list):
            return _json_ok({"success": False, "error": "bad configs"})
        ensure_dirs()
        imported, skipped = 0, 0
        errors = []
        for it in items:
            if not isinstance(it, dict):
                skipped += 1
                continue
            key = key_of(str(it.get("key", "")))
            lora = norm_lora(it.get("lora", ""))
            if not key or not lora:
                skipped += 1
                continue
            text = str(it.get("text", "") or "")[:MAX_TEXT_LEN]
            try:
                updated = int(it.get("updated") or 0)
            except Exception:
                updated = 0
            # 写 json（save_cfg 会重置 updated 为当前时间，随后按需保留原时间）
            try:
                save_cfg(key, lora_name=lora, text=text)
            except Exception as e:
                errors.append(f"{lora}: {e}")
                skipped += 1
                continue
            if updated:
                try:
                    json_path, _ = _paths(key)
                    with open(json_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    data["updated"] = updated
                    tmp = json_path + ".tmp"
                    with open(tmp, "w", encoding="utf-8") as f:
                        json.dump(data, f, ensure_ascii=False)
                    os.replace(tmp, json_path)
                except Exception:
                    pass
            # 写图片：dataURL 直接落 webp（导出时已是压缩后的 webp，不再二次压缩）
            img = it.get("image")
            raw = parse_data_url(img) if isinstance(img, str) else None
            if raw:
                if len(raw) > 20 * 1024 * 1024:
                    errors.append(f"{lora}: image too large")
                    skipped += 1
                    continue
                _, webp_path = _paths(key)
                try:
                    tmp = webp_path + ".tmp"
                    with open(tmp, "wb") as f:
                        f.write(raw)
                    os.replace(tmp, webp_path)
                except Exception as e:
                    errors.append(f"{lora}: image write failed: {e}")
            imported += 1
        return _json_ok({
            "success": True,
            "imported": imported,
            "skipped": skipped,
            "errors": errors[:10],
        })

    print("[JosiaLoraTrigger] ✅ 触发词配置路由已注册（/josia_lora_trigger/*）")
    return True


# 模块加载即尝试注册（由 __init__.py import 触发）
register_routes()
