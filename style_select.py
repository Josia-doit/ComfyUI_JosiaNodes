# -*- coding: utf-8 -*-
"""
Josia 风格选择节点【集合 Krea2 风格选择器】
本地文件名：style_select.py
节点英文标识：JosiaStyleSelect
节点中文显示名：Josia风格选择

功能：
- 平替文生图工作流的 CLIP 文本编码器：输入 CLIP，输出正向条件(CONDITIONING)。
- 集合 Krea2 风格库：内置预览图 + 中英双语风格名，可选风格叠加（默认上限 3）。
- 主题(Theme)下拉：第一项「请选择主题…」，第二项起为插件 Style/ 目录下已安装的主题文件夹
  （当前仅 Krea2；后期扩展其他风格 = 在 Style/ 下并列新增文件夹即可）。
- 提示词格式：风格提示词出现在用户提示词之前（复刻 clio 的 Style:{style}. Subject:{prompt} 模板）。

依赖：comfy（clip.tokenize / encode_from_tokens_scheduled）、server.PromptServer、aiohttp。
"""
import os
import re
import json
import traceback

_DIR = os.path.dirname(os.path.abspath(__file__))
STYLE_ROOT = os.path.join(_DIR, "Style")
THEME_NONE = "请选择主题…"

# 默认提示词格式（风格提示词在前，用户提示词在后）
DEFAULT_FORMAT = "Style: {style}. Subject: {prompt}"

# 提示词格式下拉选项：只保留用户真正会用到的核心格式
#   {name}=风格名（中文名，多个用逗号连接）  {style}=风格长提示词段落
#   {section}=分类名                        {prompt}=用户提示词
FORMAT_OPTIONS = [
    {"value": "Style: {style}. Subject: {prompt}",
     "label": "风格提示词在前 + 用户提示词（推荐）"},
    {"value": "{prompt}",
     "label": "仅用户提示词（等同原生 CLIP）"},
    {"value": "Style: {name}. Subject: {prompt}",
     "label": "风格名 + 用户提示词（简洁）"},
    {"value": "{name}, {prompt}",
     "label": "风格名, 用户提示词（纯逗号）"},
]
FORMAT_VALUES = [o["value"] for o in FORMAT_OPTIONS]
FORMAT_LABELS = {o["value"]: o["label"] for o in FORMAT_OPTIONS}

# 通配符说明（前端提示文本用）
WILDCARD_HELP = [
    ("{style}", "风格提示词（完整的风格描述段落）"),
    ("{name}", "风格名（中文名，多个风格用逗号连接）"),
    ("{section}", "风格分类名（如「动漫」「摄影」）"),
    ("{prompt}", "你输入的用户提示词"),
]

# 风格库缓存：theme -> {"list": [...], "by_name": {...}}
_STYLE_CACHE = {}
# 缩略图归一化索引缓存：theme -> {归一化名: 真实文件名}
_THUMB_INDEX = {}
# 主题白名单缓存：{"mtime": Style/ 目录修改时间, "dirs": {normcase(名字): 真实名字}}
# 用目录 mtime 失效，新增 / 删除主题文件夹后自动重扫。
_THEME_CACHE = {"mtime": None, "dirs": {}}


def _norm_key(s):
    """归一化文件名/风格名：全角转半角、去除非字母数字字符、转小写。
    用于匹配「原风格名」与「已被清洗的磁盘文件名」（去掉 . : ' ! / & – 等）。"""
    import unicodedata
    s = unicodedata.normalize("NFKC", s or "")
    return re.sub(r"[^0-9a-z\u00c0-\u024f\u4e00-\u9fff]", "", s.lower())


def _list_theme_dirs():
    """Style/ 下真实子目录的 {normcase(名字): 真实名字} 映射，即主题白名单。

    ⚠️ 安全边界：theme 是**不可信输入**，两个来源都能注入——
      ① URL 动态段（/josia_style/{theme}/...）：aiohttp 匹配路径时保留 %2F 编码，
        匹配后才解码，于是 `..%2F..` 能把路径分隔符塞进单段；
      ② 工作流 JSON 里的 widget 取值。
    而 os.path.join(base, "C:\\x") 之类遇绝对路径会**丢弃前缀**，靠字符串 startswith
    兜不住。所以主题名必须先"只允许 Style/ 下真实存在的目录名"这一层白名单过滤。
    """
    try:
        mtime = os.path.getmtime(STYLE_ROOT)
    except OSError:
        mtime = None
    if _THEME_CACHE["mtime"] == mtime and _THEME_CACHE["dirs"]:
        return _THEME_CACHE["dirs"]
    dirs = {}
    try:
        with os.scandir(STYLE_ROOT) as it:
            for entry in it:
                try:
                    if entry.is_dir():
                        dirs[os.path.normcase(entry.name)] = entry.name
                except OSError:
                    continue
    except OSError:
        pass
    _THEME_CACHE["mtime"] = mtime
    _THEME_CACHE["dirs"] = dirs
    return dirs


def _resolve_theme(theme):
    """把 theme 校验并解析为 Style/ 下的绝对目录路径；非法一律返回 None。

    非法 = 非字符串 / 空 / 含路径分隔符或 `:`（盘符、NTFS 数据流）/ 绝对路径 /
           不是 Style/ 下真实存在的目录名（结构上已挡掉 `.` `..` 与 symlink 名）。
    """
    if not isinstance(theme, str) or not theme:
        return None
    if theme in (".", "..") or any(ch in theme for ch in ("/", "\\", ":", "\x00")):
        return None
    if os.path.isabs(theme) or os.path.splitdrive(theme)[0]:
        return None
    name = _list_theme_dirs().get(os.path.normcase(theme))
    if not name:
        return None
    return os.path.join(STYLE_ROOT, name)


def _is_within(path, root):
    """path 是否位于 root 之内（含相等）。两个参数须已 realpath（缩略图路由里各做一次）。"""
    p, r = os.path.normcase(path), os.path.normcase(root)
    return p == r or p.startswith(r + os.sep)


def _thumb_index(theme):
    """某主题的「归一化名 -> 真实文件名」索引（懒加载缓存）。主题非法时返回空索引。"""
    theme_dir = _resolve_theme(theme)
    if theme_dir is None:
        return {}
    key = os.path.basename(theme_dir)
    if key in _THUMB_INDEX:
        return _THUMB_INDEX[key]
    idx = {}
    thumb_dir = os.path.join(theme_dir, "thumbs")
    if os.path.isdir(thumb_dir):
        for f in os.listdir(thumb_dir):
            idx.setdefault(_norm_key(os.path.splitext(f)[0]), f)
    _THUMB_INDEX[key] = idx
    return idx


def _list_themes():
    """扫描 Style/ 目录，返回 [{id, label}]，仅包含含 styles.json 的文件夹。"""
    themes = []
    if os.path.isdir(STYLE_ROOT):
        for name in sorted(os.listdir(STYLE_ROOT)):
            style_dir = os.path.join(STYLE_ROOT, name)
            if os.path.isdir(style_dir) and os.path.isfile(os.path.join(style_dir, "styles.json")):
                themes.append({"id": name, "label": name.title()})
    return themes


def _load_theme(theme):
    """加载某主题的风格库（含缓存）。返回 {"list":[...], "by_name":{name:entry}}。

    主题名非法（含路径穿越）时返回空结果——工作流 JSON 里的 theme 也可能是被人改过的。
    """
    theme_dir = _resolve_theme(theme)
    if theme_dir is None:
        return {"list": [], "by_name": {}}
    key = os.path.basename(theme_dir)
    if key in _STYLE_CACHE:
        return _STYLE_CACHE[key]
    style_dir = theme_dir
    styles_path = os.path.join(style_dir, "styles.json")
    result = {"list": [], "by_name": {}}
    try:
        with open(styles_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        # 中文译文词典（name -> 风格提示词中文版），可选；缺失则前端只显示英文
        cn_map = {}
        cn_path = os.path.join(style_dir, "prompt_cn.json")
        if os.path.isfile(cn_path):
            try:
                with open(cn_path, "r", encoding="utf-8") as f:
                    cn_map = json.load(f)
            except Exception:
                cn_map = {}
        for e in data:
            if isinstance(cn_map, dict):
                cn = cn_map.get(e.get("name", ""))
                if cn:
                    e["prompt_cn"] = cn
            result["list"].append(e)
            result["by_name"][e.get("name", "")] = e
    except Exception:
        pass
    _STYLE_CACHE[key] = result
    return result


def _parse_selected(raw):
    """把隐藏 widget 的 JSON 字符串解析为风格名列表。"""
    if not raw:
        return []
    try:
        val = json.loads(raw)
    except Exception:
        return []
    if isinstance(val, list):
        return [str(x) for x in val]
    if isinstance(val, str):
        return [val] if val else []
    return []


class JosiaStyleSelect:
    CATEGORY = "⚡️JosiaNodes"
    DESCRIPTION = """🎨 Josia 风格选择
集合 Krea2 风格库的中文风格选择器，可平替 CLIP 文本编码器。

• 主题：请选择主题… / Krea2（后期可扩展其它主题）
• 风格：网格多选（默认上限 3），叠加生效，风格提示词出现在用户提示词之前
• 提示词格式：可选风格在前/在后/仅风格/仅用户词等

输入 CLIP，输出正向条件（CONDITIONING）。未选主题或风格时等价于原生 CLIP 文本编码器。"""

    @classmethod
    def INPUT_TYPES(cls):
        theme_options = [THEME_NONE] + [t["id"] for t in _list_themes()]
        return {
            "required": {
                "clip": ("CLIP", {
                    "display_name": "CLIP",
                    "tooltip": "接入 CLIP 模型（本节点等同文本编码器，用于生成正向条件）",
                }),
                "prompt": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "placeholder": "用户提示词",
                    "dynamicPrompts": True,
                    "display_name": "用户提示词",
                    "tooltip": "在这里输入你自己的提示词。上方选中的风格会按下方「提示词格式」"
                               "与这段文字拼合，一起送入 CLIP 编码。",
                }),
                "theme": (theme_options, {
                    "default": THEME_NONE,
                    "display_name": "风格主题",
                    "tooltip": "选择风格库主题（对应插件 Style/ 目录下的文件夹）。"
                               "选择后才会加载该主题的风格预览图。",
                }),
                "format": (FORMAT_VALUES, {
                    "default": DEFAULT_FORMAT,
                    "display_name": "提示词格式",
                    "tooltip": "决定「风格提示词 / 风格名 / 分类名」与「你的提示词」如何拼合。"
                               "节点下方下拉里用中文标注每种规则的写法。",
                }),
                # 隐藏控件：前端把选中的风格名列表写成 JSON 写入此处
                "selected_styles": ("STRING", {
                    "default": "[]",
                    "multiline": False,
                    "display_name": "选中风格",
                }),
                # 隐藏控件：多选叠加开关（持久化，跨撤销 / 切换工作流保留）
                "multi_select": ("STRING", {
                    "default": "false",
                    "multiline": False,
                    "display_name": "多选模式",
                }),
            }
        }

    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("条件",)
    FUNCTION = "apply"

    def apply(self, clip, prompt, theme, format, selected_styles, multi_select):
        user_prompt = (prompt or "").strip()
        selected = _parse_selected(selected_styles)

        style_texts = []   # 风格长提示词段落
        name_texts = []    # 风格名（中文名优先）
        sections = []
        if theme != THEME_NONE:
            db = _load_theme(theme)
            seen = set()
            for name in selected:
                entry = db["by_name"].get(name)
                if entry is None:
                    continue
                p = (entry.get("prompt") or "").strip()
                if p:
                    style_texts.append(p)
                nm = (entry.get("name_cn") or entry.get("name") or "").strip()
                if nm:
                    name_texts.append(nm)
                sec = entry.get("section", "")
                if sec and sec not in seen:
                    seen.add(sec)
                    sections.append(sec)

        joined_style = " ".join(style_texts)
        joined_name = ", ".join(name_texts)
        section_str = "/".join(sections)

        if not joined_style:
            # 未选任何风格 → 等价于原生 CLIP 文本编码器
            final_prompt = user_prompt
        else:
            tpl = format if format else DEFAULT_FORMAT
            final_prompt = (tpl
                            .replace("{style}", joined_style)
                            .replace("{name}", joined_name)
                            .replace("{section}", section_str)
                            .replace("{prompt}", user_prompt))
            # 清理：压缩空白；再处理「某字段为空」时残留的悬空标签与分隔符
            final_prompt = re.sub(r"\s+", " ", final_prompt).strip()
            # 1) 末尾只剩标签（用户提示词为空时）：Style: / Subject:
            final_prompt = re.sub(r"\b(Subject|Style)\s*[:：]\s*$", "", final_prompt).strip()
            # 2) ", ." / ", ," 之类的重复分隔符
            final_prompt = re.sub(r"\s*,\s*(?=[,.])", "", final_prompt)
            # 3) 尾部悬空的逗号/分号/冒号（句点保留）
            final_prompt = re.sub(r"[,\s;:：]+$", "", final_prompt)
            # 4) 句点收尾规范化
            final_prompt = re.sub(r"\.\s*$", ".", final_prompt).strip()
            final_prompt = final_prompt.strip(" ,")

        tokens = clip.tokenize(final_prompt)
        conditioning = clip.encode_from_tokens_scheduled(tokens)
        return (conditioning,)


NODE_CLASS_MAPPINGS = {"JosiaStyleSelect": JosiaStyleSelect}
NODE_DISPLAY_NAME_MAPPINGS = {"JosiaStyleSelect": "Josia风格选择"}
WEB_DIRECTORY = "./web/js"


# 用户偏好持久化文件（收藏 + 自定义排序，跨重启保留）
_USER_CONFIG_PATH = os.path.join(_DIR, "Style", "_user_config.json")


def _load_user_config():
    """加载用户配置（收藏列表 + 自定义排序）。文件不存在返回空默认值。"""
    if os.path.isfile(_USER_CONFIG_PATH):
        try:
            with open(_USER_CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"favorites": {}, "order": {}}


def _save_user_config(cfg):
    """原子写入用户配置（先写临时文件再 rename，避免半写损坏）。"""
    try:
        tmp = _USER_CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _USER_CONFIG_PATH)
    except Exception:
        traceback.print_exc()


# ==================== 前端预览 / 画廊 路由 ====================
# 让节点内的预览网格、悬浮窗、以及浏览器图标打开的本地化画廊都能取到数据与图片，
# 全部由 ComfyUI 自身提供，无需额外依赖、无需联网。
try:
    from server import PromptServer
    from aiohttp import web as _web

    @PromptServer.instance.routes.get("/josia_style/themes")
    async def _josia_style_themes(request):
        return _web.json_response({"themes": _list_themes()})

    @PromptServer.instance.routes.get("/josia_style/{theme}/styles")
    async def _josia_style_styles(request):
        # theme 是 URL 动态段 = 不可信输入，必须先过白名单（见 _resolve_theme）
        theme_dir = _resolve_theme(request.match_info["theme"])
        if theme_dir is None or not os.path.isfile(os.path.join(theme_dir, "styles.json")):
            return _web.json_response({"error": "theme_not_found", "list": []}, status=404)
        theme = os.path.basename(theme_dir)
        data = _load_theme(theme)["list"]
        return _web.json_response({"theme": theme, "list": data})

    @PromptServer.instance.routes.get("/josia_style/formats")
    async def _josia_style_formats(request):
        """格式选项（含中文说明与通配符对照），供前端下拉与提示文本使用。"""
        return _web.json_response({
            "default": DEFAULT_FORMAT,
            "options": FORMAT_OPTIONS,
            "wildcards": [{"key": k, "desc": d} for k, d in WILDCARD_HELP],
        })

    @PromptServer.instance.routes.get("/josia_style/{theme}/thumb")
    async def _josia_style_thumb(request):
        # theme 同上不可信；file 只取纯文件名，再对最终路径做 realpath 包含性校验
        theme_dir = _resolve_theme(request.match_info["theme"])
        if theme_dir is None:
            return _web.Response(status=404)
        fname = (request.rel_url.query.get("file", "") or "").replace("\\", "/")
        fname = fname.split("/")[-1]          # 允许传 krea2/thumbs/xxx.jpg，只取文件名
        # 空名 / NUL（realpath 会抛 ValueError，得挡在 500 之前）
        if not fname or "\x00" in fname:
            return _web.Response(status=404)
        stem_key = _norm_key(os.path.splitext(fname)[0])
        # `.` / `..` / 纯符号名（归一化后为空）直接拒绝
        if not stem_key:
            return _web.Response(status=404)
        base = os.path.join(theme_dir, "thumbs")
        base_real = os.path.realpath(base)
        path = None
        # ① 直接按文件名找。含 `:` 的串**不**直接落到文件系统（挡 NTFS 数据流 a.jpg:evil），
        #    交给 ② 的归一化兜底 —— 原名里的 `:` 常是被清洗过的磁盘名留下的，仍可匹配。
        if ":" not in fname and fname not in (".", ".."):
            cand = os.path.realpath(os.path.join(base, fname))
            if _is_within(cand, base_real) and os.path.isfile(cand):
                path = cand
        if path is None:
            # ② 兜底：磁盘文件名可能被清洗过（去掉 . : ' ! / & – 等特殊字符），
            #    按归一化名再匹配一次，避免预览图 404。real 取自 listdir，天然是本目录内真名。
            real = _thumb_index(os.path.basename(theme_dir)).get(stem_key)
            if real:
                cand = os.path.join(base_real, real)
                if _is_within(os.path.realpath(cand), base_real) and os.path.isfile(cand):
                    path = cand
        if path is None:
            return _web.Response(status=404)
        return _web.FileResponse(path)

    # 本地化画廊：浏览器图标目标。
    # 注意：不能用 routes.static —— aiohttp 的 static 对「目录根」默认返回 403
    # （无 show_index 且不自动回退 index.html），改为显式回 index.html。
    # 画廊 index.html 为自包含单文件（CSS/JS 全内联），无需额外托管静态资源。
    def _gallery_index(request):
        theme_dir = _resolve_theme(request.match_info.get("theme", ""))
        if theme_dir is None:
            return _web.Response(status=404, text="theme not found")
        idx = os.path.join(theme_dir, "gallery", "index.html")
        if not os.path.isfile(idx):
            return _web.Response(status=404, text="gallery index.html not found")
        return _web.FileResponse(idx)

    # 同时注册带/不带结尾斜杠两种形式，避免重定向到目录根触发 403
    PromptServer.instance.routes.get("/josia_style/{theme}/gallery")(_gallery_index)
    PromptServer.instance.routes.get("/josia_style/{theme}/gallery/")(_gallery_index)

    # ---- 用户配置持久化（收藏 + 自定义排序）----
    @PromptServer.instance.routes.get("/josia_style/config")
    async def _josia_style_config_get(request):
        return _web.json_response(_load_user_config())

    @PromptServer.instance.routes.post("/josia_style/config")
    async def _josia_style_config_post(request):
        try:
            body = await request.json()
            # 安全校验：只接受已知键
            allowed = {"favorites", "order"}
            cfg = _load_user_config()
            for k in allowed:
                if k in body and isinstance(body[k], dict):
                    cfg[k] = body[k]
            _save_user_config(cfg)
            return _web.json_response({"ok": True})
        except Exception as e:
            return _web.json_response({"error": str(e)}, status=400)

except Exception:
    # 无服务器环境（脚本/测试）导入时不报错，节点仍可独立工作
    traceback.print_exc()
    pass
