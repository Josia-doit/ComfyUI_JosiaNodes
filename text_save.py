"""
Josia文本保存节点 v1.7.1
功能：将文本内容保存到文件，支持通配符解析、文件夹选择、图像文件名复用
本地文件名：text_save.py
节点英文标识：JosiaTextSave
节点中文显示名：Josia文本保存
依赖：无（纯Python标准库）
"""

import os
import re
import time
from datetime import datetime

try:  # ComfyUI 运行时环境
    import folder_paths
except Exception:  # 脱离 ComfyUI 单独导入时降级
    folder_paths = None


# ==================== 通配符解析 ====================
def sanitize_filename(name):
    return re.sub(r'[\\/:*?"<>|]', '_', name)


def resolve_wildcards(template, counter_value=None):
    if not template:
        return template

    now = datetime.now()
    wildcard_pattern = re.compile(r'%([^%]+)%')
    matches = list(wildcard_pattern.finditer(template))
    result = template
    offset = 0

    for match in matches:
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
        elif content.isdigit():
            digits = len(content)
            replacement = str(counter_value).zfill(digits) if counter_value is not None else match.group(0)
        else:
            replacement = match.group(0)

        result = result[:start] + replacement + result[end:]
        offset += len(replacement) - len(match.group(0))

    return result


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


def find_highest_existing_number(directory, base_name, ext, digits=3):
    if not os.path.isdir(directory):
        return 0
    max_num = 0
    for f in os.listdir(directory):
        if not f.endswith(f".{ext}"):
            continue
        name_part = f[:-len(ext)-1]
        if base_name:
            m = re.match(r'^' + re.escape(base_name) + r'_(\d{' + str(digits) + r'})$', name_part)
            if m:
                max_num = max(max_num, int(m.group(1)))
                continue
        m = re.match(r'^(\d{' + str(digits) + r'})$', name_part)
        if m:
            max_num = max(max_num, int(m.group(1)))
    return max_num


# 说明（重要 · 发布安全红线）：
#   本文件【不得】启动任何外部进程，也【不得】使用动态执行 / 动态导入手段。
#   ComfyUI 官方注册表（Comfy Registry）的自动安全扫描是「AI + 静态分析」黑盒，
#   除了官方明文禁止的几类写法之外，还会额外封禁一切看起来像 RCE 的代码模式
#   （含通过脚本宿主弹出系统对话框）。一旦命中，版本会被置为
#   NodeVersionStatusBanned，注册表 latest_version 指针随即回落到旧版本
#   （本包 1.5.5~1.6.4 即因此全军覆没）。
#   ⚠️ 连注释里也不要出现那些敏感单词的字面量 —— 文本型扫描规则可能误伤。
#
#   因此，文件夹选择的正确实现方式：
#     • 后端只用 os.scandir / os.path / os.mkdir —— 纯 Python 标准库文件 I/O，
#       与 ComfyUI 核心 folder_paths 扫描模型目录用的是同一套 API，无扫描风险；
#     • 前端用内置浮层渲染目录树，不依赖系统对话框、不依赖浏览器私有 API；
#     • 原「打开输出目录」（会启动系统文件管理器）在 1.6.7 中暂时改为「复制路径」，
#       使本版本成为彻底的「零外部进程」版本，用于验证封禁根因；
#       待确认 1.6.7 通过扫描后，再评估是否加回。


# ==================== 目录浏览辅助（纯 os 标准库） ====================
def _list_drives():
    """列出可用根目录。Windows 返回可用盘符，其它系统返回文件系统根。"""
    entries = []
    if os.name == "nt":
        for code in range(65, 91):  # A-Z
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
    """常用目录快捷入口（ComfyUI output/input/temp、桌面、用户目录）。"""
    out = []
    labels = {"output": "ComfyUI 输出目录", "input": "ComfyUI 输入目录", "temp": "ComfyUI 临时目录"}
    if folder_paths is not None:
        for key, label in labels.items():
            try:
                d = folder_paths.get_directory_by_type(key)
            except Exception:
                continue
            if d and os.path.isdir(d):
                out.append({"name": label, "path": os.path.abspath(d)})
    for label, d in (("桌面", os.path.join(os.path.expanduser("~"), "Desktop")),
                     ("用户目录", os.path.expanduser("~"))):
        if d and os.path.isdir(d):
            out.append({"name": label, "path": os.path.abspath(d)})
    return out


def _parent_of(path):
    """上级目录；已到根时返回空串（前端据此回到驱动器/快捷方式视图）。"""
    p = path.rstrip("\\/")
    parent = os.path.dirname(p)
    if not parent or parent == p:
        return ""
    return parent


def _list_subdirs(path):
    try:
        with os.scandir(path) as it:
            entries = [{"name": e.name, "path": e.path}
                       for e in it if _is_dir_entry(e)]
    except (PermissionError, OSError) as e:
        return None, str(e)
    entries.sort(key=lambda x: (x["name"] or "").lower())
    return entries, None


def _is_dir_entry(entry):
    try:
        return entry.is_dir(follow_symlinks=False)
    except OSError:
        return False


# ==================== API 路由 ====================
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.post("/josia_text_save/list_dirs")
    async def list_dirs(request):
        """列出指定目录下的子目录。path 为空时返回驱动器列表与快捷入口。"""
        body = await request.json()
        path = (body.get("path") or "").strip()

        if not path:
            return web.json_response({
                "ok": True, "path": "", "parent": "",
                "dirs": _list_drives(), "shortcuts": _shortcuts(),
            })

        if not os.path.isdir(path):
            return web.json_response({"ok": False, "error": "目录不存在或不可访问"})

        entries, err = _list_subdirs(path)
        if err:
            return web.json_response({"ok": False, "error": f"无法读取目录：{err}"})

        return web.json_response({
            "ok": True,
            "path": path,
            "parent": _parent_of(path),
            "dirs": entries,
            "shortcuts": [],
        })

    @PromptServer.instance.routes.post("/josia_text_save/create_dir")
    async def create_dir(request):
        """在指定父目录下新建一层文件夹（名称不含路径分隔符，杜绝越权写入）。"""
        body = await request.json()
        parent = (body.get("parent") or "").strip()
        name = (body.get("name") or "").strip()

        if not parent or not name:
            return web.json_response({"ok": False, "error": "参数不完整"})
        if any(c in name for c in '\\/:*?"<>|'):
            return web.json_response({"ok": False, "error": "文件夹名称包含非法字符"})
        if not os.path.isdir(parent):
            return web.json_response({"ok": False, "error": "父目录不存在"})

        target = os.path.join(parent, name)
        try:
            os.mkdir(target)
        except FileExistsError:
            return web.json_response({"ok": False, "error": "该文件夹已存在"})
        except OSError as e:
            return web.json_response({"ok": False, "error": str(e)})

        return web.json_response({"ok": True, "path": target})

except Exception:
    pass


# ==================== 节点注册 ====================
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


class JosiaTextSave:
    CATEGORY = "Josia"
    FUNCTION = "save_text"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("file_path",)
    OUTPUT_NODE = True

    DESCRIPTION = """💾 Josia 文本保存
将文本内容保存到文件，支持通配符解析、文件夹选择、图像文件名复用。

【使用方法】
  1. 连接或输入文本内容（支持多行）
  2. 点击「选择输出目录」按钮，在内置文件夹浏览器中挑选目录（也可直接手填/粘贴路径）
  3. 输入文件名（支持通配符）
  4. 选择保存格式（txt 或 csv）
  5. 点击「复制路径」可将当前输出目录复制到剪贴板

【文件夹浏览器】
  内置浮层，支持磁盘列表、ComfyUI 输出/输入目录快捷入口、桌面与用户目录、
  上级导航、路径直接输入跳转、新建文件夹、最近使用记录。
  不使用系统对话框与子进程，符合 Comfy Registry 安全规范。

【通配符规则】（成对 %xxx% 解析）
  %date%           → 2026-06-30
  %time%           → 07:38:41
  %date:yyMMdd%    → 260630
  %003%            → 3位序号从003开始，自动顺延
  %0001%           → 4位序号从0001开始，与3位序号互不干扰

【图像输入】（可选）
  接入图像时，自动复用原图文件名作为基础名称
  文件名输入框灰化锁定，不可编辑
  若同名文件存在则追加 _001 后缀

【两种命名模式互不干扰】
  通配符序号：按位数独立计数，自动顺延
  图像文件名：使用原图名，冲突时加后缀"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "display_name": "文本内容",
                    "tooltip": "要保存的文本内容，支持多行输入。",
                }),
                "output_path": ("STRING", {
                    "default": "\U0001f4c1 请选择输出目录\u2026",
                    "display_name": "输出路径",
                    "tooltip": "文件保存的文件夹路径。可点击上方「选择输出目录」在内置浏览器中挑选，也可直接输入/粘贴；文件夹不存在时自动创建。",
                }),
                "file_name": ("STRING", {
                    "default": "%001%",
                    "display_name": "文件名",
                    "tooltip": "保存的文件名，不含扩展名。支持通配符：%date%日期、%time%时间、%003%序号。",
                }),
                "file_extension": (["txt", "csv"], {
                    "default": "txt",
                    "display_name": "保存格式",
                    "tooltip": "txt = 纯文本；csv = 每行一条CSV记录",
                }),
            },
            "optional": {
                "image": ("IMAGE", {
                    "display_name": "图像",
                    "tooltip": "接入时自动复用原图文件名，文件名输入框灰化锁定。",
                }),
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return time.time()

    def save_text(self, text, output_path, file_name, file_extension, image=None, prompt=None, unique_id=None):
        # 检查输出路径是否为有效路径
        if not output_path or not output_path.strip():
            print("[JosiaTextSave] ❌ 输出路径为空，请先选择或输入输出目录")
            return ("",)

        resolved_path = resolve_wildcards(output_path)

        # 检查路径是否包含非法字符
        if any(c in resolved_path for c in '*?"<>|'):
            print(f"[JosiaTextSave] ❌ 输出路径包含非法字符：{resolved_path}")
            return ("",)

        try:
            os.makedirs(resolved_path, exist_ok=True)
        except Exception as e:
            print(f"[JosiaTextSave] ❌ 无法创建目录 {resolved_path}：{str(e)}")
            return ("",)

        # 命名模式1：接入图像时复用原图文件名
        original_name = None
        if not original_name and image is not None:
            original_name = self._get_image_filename(image) or self._trace_image_filename(prompt, unique_id)
        if original_name:
            base_name = sanitize_filename(os.path.splitext(str(original_name))[0])
            filepath = os.path.join(resolved_path, f"{base_name}.{file_extension}")
            if os.path.exists(filepath):
                idx = 1
                while os.path.exists(filepath):
                    filepath = os.path.join(resolved_path, f"{base_name}_{str(idx).zfill(3)}.{file_extension}")
                    idx += 1
            return self._write_file(text, filepath, file_extension)

        # 命名模式2：通配符
        base_name = file_name
        counter_match = re.search(r'%(\d+)%', base_name)
        if counter_match:
            digits = len(counter_match.group(1))
            start_num = int(counter_match.group(1))
            before_counter = base_name[:counter_match.start()]
            after_counter = base_name[counter_match.end():]
            prefix = sanitize_filename(resolve_wildcards(before_counter))
            max_existing = find_highest_existing_number(resolved_path, prefix, file_extension, digits)
            next_counter = max(start_num, max_existing + 1)
            counter_str = str(next_counter).zfill(digits)
            suffix = sanitize_filename(resolve_wildcards(after_counter))
            if prefix and suffix:
                resolved_name = f"{prefix}_{counter_str}{suffix}"
            elif prefix:
                resolved_name = f"{prefix}_{counter_str}"
            elif suffix:
                resolved_name = f"{counter_str}{suffix}"
            else:
                resolved_name = counter_str
        else:
            resolved_name = sanitize_filename(resolve_wildcards(base_name))
            if not resolved_name.strip():
                max_existing = find_highest_existing_number(resolved_path, "", file_extension, 3)
                resolved_name = str(max(max_existing + 1, 1)).zfill(3)

        filepath = os.path.join(resolved_path, f"{resolved_name}.{file_extension}")

        if not counter_match and os.path.exists(filepath):
            idx = 1
            while os.path.exists(filepath):
                filepath = os.path.join(resolved_path, f"{resolved_name}_{str(idx).zfill(3)}.{file_extension}")
                idx += 1

        return self._write_file(text, filepath, file_extension)

    def _write_file(self, text, filepath, file_extension):
        try:
            if file_extension == "csv":
                lines = [line.strip() for line in text.split("\n")]
                with open(filepath, "w", newline="", encoding="utf-8") as f:
                    for line in lines:
                        f.write(f"{line}\n")
            else:
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(text)
            print(f"[JosiaTextSave] ✅ 文件已保存：{filepath}")
            return (filepath,)
        except Exception as e:
            print(f"[JosiaTextSave] ❌ 保存失败：{str(e)}")
            return ("",)

    def _trace_image_filename(self, prompt, unique_id):
        if not prompt or not isinstance(prompt, dict):
            return None
        try:
            current_node = prompt.get(str(unique_id), {})
            if not current_node:
                return None
            image_input = current_node.get("inputs", {}).get("image")
            if not image_input or not isinstance(image_input, list) or len(image_input) < 2:
                return None
            return self._find_load_image(prompt, str(image_input[0]))
        except Exception:
            return None

    def _get_image_filename(self, image):
        """优先从图像 tensor 的 filename 属性读取（多图加载等节点会打上实际文件名）"""
        if image is None:
            return None
        fn = getattr(image, "filename", None)
        if not fn and hasattr(image, "dim") and callable(getattr(image, "dim", None)) \
                and image.dim() == 4 and image.shape[0] == 1:
            fn = getattr(image[0], "filename", None)
        return fn if fn else None

    def _find_load_image(self, prompt, node_id, visited=None):
        if visited is None:
            visited = set()
        if node_id in visited:
            return None
        visited.add(node_id)
        node = prompt.get(node_id, {})
        if not node:
            return None
        if node.get("class_type") == "LoadImage":
            name = node.get("inputs", {}).get("image", "")
            if name:
                return name
        for key, value in node.get("inputs", {}).items():
            if isinstance(value, list) and len(value) >= 2:
                result = self._find_load_image(prompt, str(value[0]), visited)
                if result:
                    return result
        return None


NODE_CLASS_MAPPINGS["JosiaTextSave"] = JosiaTextSave
NODE_DISPLAY_NAME_MAPPINGS["JosiaTextSave"] = "Josia文本保存"
