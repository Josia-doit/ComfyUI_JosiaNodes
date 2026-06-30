"""
Josia 文本保存节点 v1.6.0
功能：将文本内容保存到文件，支持通配符解析、文件夹选择、图像文件名复用
本地文件名：text_save.py
节点英文标识：JosiaTextSave
节点中文显示名：Josia 文本保存
依赖：无（纯Python标准库）
"""

import os
import re
import time
import subprocess
from datetime import datetime


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


def open_folder_dialog():
    """使用 PowerShell 打开 Windows 原生文件夹选择对话框"""
    ps_script = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "$f = New-Object System.Windows.Forms.FolderBrowserDialog; "
        "$f.Description = '选择输出文件夹'; "
        "$f.ShowNewFolderButton = $true; "
        "if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath } else { '' }"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True, text=True, timeout=60,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        )
        path = result.stdout.strip()
        return path
    except Exception as e:
        print(f"[JosiaTextSave] 文件夹选择失败: {e}")
        return ""


# ==================== API 路由 ====================
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.post("/josia_text_save/pick_folder")
    async def pick_folder(request):
        loop = __import__('asyncio').get_event_loop()
        path = await loop.run_in_executor(None, open_folder_dialog)
        return web.json_response({"path": path})

    @PromptServer.instance.routes.post("/josia_text_save/open_folder")
    async def open_folder(request):
        body = await request.json()
        folder = body.get("path", "")
        if folder and os.path.isdir(folder):
            try:
                subprocess.Popen(["explorer", folder])
                return web.json_response({"ok": True})
            except Exception:
                pass
        return web.json_response({"ok": False})

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
  2. 点击「选择文件夹」按钮或手动输入路径
  3. 输入文件名（支持通配符）
  4. 选择文件格式（txt 或 csv）

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
                    "tooltip": "文件保存的文件夹路径。文件夹不存在时自动创建。",
                }),
                "file_name": ("STRING", {
                    "default": "%001%",
                    "display_name": "文件名",
                    "tooltip": "保存的文件名，不含扩展名。支持通配符：%date%日期、%time%时间、%003%序号。",
                }),
                "file_extension": (["txt", "csv"], {
                    "default": "txt",
                    "display_name": "文件格式",
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

        # 命名模式1：接入图像
        if image is not None:
            original_name = self._trace_image_filename(prompt, unique_id)
            if original_name:
                base_name = sanitize_filename(os.path.splitext(original_name)[0])
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
NODE_DISPLAY_NAME_MAPPINGS["JosiaTextSave"] = "Josia 文本保存"
