"""
Josia 文本列表节点 v2.1.0
功能：将多行字符串按分隔符分割为字符串列表，支持空行过滤、空白修剪、去重、正则过滤
本地文件名：text_list.py
节点英文标识：JosiaTextList
节点中文显示名：Josia 文本列表
依赖：无（纯Python标准库）
"""
import re


class JosiaTextList:
    """将多行字符串按分隔符分割为字符串列表"""

    CATEGORY = "Josia"
    FUNCTION = "split_string"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt_list",)
    OUTPUT_IS_LIST = (True,)
    OUTPUT_NODE = True

    DESCRIPTION = """📝 Josia 文本列表
将多行字符串按分隔符分割为字符串列表，每行作为一个独立的字符串输出。

【使用方法】
  连接上游文本节点 → 自动按分隔符分割 → 输出为列表

【适用场景】
  • 提示词批量处理：将多行提示词逐行拆分为独立条目
  • 路径列表拆分：将多行路径字符串拆分为路径列表
  • 配置项拆分：将多行配置文本逐行拆分

【可选设置】
  过滤空行 — 开启后自动去除空行
  修剪空白 — 开启后去除每行首尾空格、制表符等空白字符
  分隔符 — 自定义分割字符（支持 \\n \\t 逗号 分号等）
  去重过滤 — 自动去除重复行
  正则过滤 — 输入正则表达式只保留匹配的行
  显示模式 — 列表模式（每行一个框）/ 完整文本（合并显示）"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "forceInput": True,
                    "display_name": "输入文本",
                    "tooltip": "多行字符串，按分隔符分割为列表。每行作为一个独立字符串输出。",
                }),
            },
            "optional": {
                "filter_empty": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ 过滤空行",
                    "label_off": "❎ 保留空行",
                    "display_name": "过滤空行",
                    "tooltip": "开启后自动去除分割结果中的空行",
                }),
                "trim_whitespace": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ 修剪空白",
                    "label_off": "❎ 保留空白",
                    "display_name": "修剪空白",
                    "tooltip": "开启后去除每行首尾的空格、制表符等空白字符",
                }),
                "delimiter": ("STRING", {
                    "default": "\\n",
                    "display_name": "分隔符",
                    "tooltip": "自定义分隔符，支持 \\n(换行) \\t(制表) 逗号(,) 分号(;) 等",
                }),
                "dedup": ("BOOLEAN", {
                    "default": False,
                    "label_on": "✅ 去除重复",
                    "label_off": "❎ 保留重复",
                    "display_name": "去重过滤",
                    "tooltip": "开启后自动去除重复行",
                }),
                "regex_filter": ("STRING", {
                    "default": "",
                    "display_name": "正则过滤",
                    "tooltip": "留空则不过滤。自定义规则(可组合用|分隔)：\n/汉字/　　　　　　[\\u4e00-\\u9fa5]+　　　　　匹配含中文的行\n/汉字开头/　　　　^[\\u4e00-\\u9fa5]　　　　　匹配以汉字开头的行\n/纯汉字/　　　　　^[\\u4e00-\\u9fa5]+$　　　匹配纯中文行(无英文数字)\n/英文/　　　　　　[a-zA-Z]+　　　　　　　　　匹配含英文的行\n/数字/　　　　　　\\d+　　　　　　　　　　　匹配含数字的行\n/空行/　　　　　　^\\s*$　　　　　　　　　　 匹配空行或纯空白行\n/空格/　　　　　　\\s+　　　　　　　　　　　 匹配含空格的行\n/序号行/　　　　　^\\s*\\[(?\\d+)\\]?　　　　　  匹配带序号的行如[1]或1.\n/标签行/　　　　　^\\s*\\[　　　　　　　　　　匹配以[开头的标签行\n/?文本/　　　　　 任意文本字面匹配　　　　　匹配包含该文本的行(例：/天空/)\n/?文本开头/　　　 ^字面文本　　　　　　　　 匹配以该文本开头的行(例：/天空开头/)",
                }),
                "display_mode": ("BOOLEAN", {
                    "default": False,
                    "label_on": "📝 完整文本",
                    "label_off": "📋 列表模式",
                    "display_name": "显示模式",
                    "tooltip": "列表模式：每行一个文本框；完整文本：所有内容合并为一段",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def split_string(self, text, filter_empty=True, trim_whitespace=True,
                     delimiter="\\n", dedup=False, regex_filter="",
                     display_mode=False,
                     unique_id=None, extra_pnginfo=None):
        actual_delim = delimiter.replace("\\n", "\n").replace("\\t", "\t")

        if not text:
            lines = [""]
        else:
            lines = text.split(actual_delim)

        if trim_whitespace:
            lines = [line.strip() for line in lines]

        if filter_empty:
            lines = [line for line in lines if line]

        if dedup:
            seen = set()
            deduped = []
            for line in lines:
                if line not in seen:
                    seen.add(line)
                    deduped.append(line)
            lines = deduped

        if regex_filter:
            FIXED_RULES = {
                "/汉字/": "[\\u4e00-\\u9fa5]+",
                "/汉字开头/": "^[\\u4e00-\\u9fa5]",
                "/纯汉字/": "^[\\u4e00-\\u9fa5]+$",
                "/英文/": "[a-zA-Z]+",
                "/数字/": "\\d+",
                "/空行/": "^\\s*$",
                "/空格/": "\\s+",
                "/序号行/": "^\\s*\\[(?\\d+)\\]?",
                "/标签行/": "^\\s*\\[",
            }
            for key, val in FIXED_RULES.items():
                regex_filter = regex_filter.replace(key, val)
            regex_filter = re.sub(r'/([^/]+)/开头/', lambda m: '^' + re.escape(m.group(1)), regex_filter)
            regex_filter = re.sub(r'/([^/]+)/', lambda m: re.escape(m.group(1)), regex_filter)
            try:
                pattern = re.compile(regex_filter)
                lines = [line for line in lines if pattern.search(line)]
            except re.error:
                pass

        if not lines:
            lines = [""]

        if display_mode:
            ui_text = "\n".join(lines)
        else:
            ui_text = lines

        if unique_id is not None and extra_pnginfo is not None:
            if isinstance(extra_pnginfo, list) and isinstance(extra_pnginfo[0], dict) and "workflow" in extra_pnginfo[0]:
                workflow = extra_pnginfo[0]["workflow"]
                node = next((x for x in workflow["nodes"] if str(x["id"]) == str(unique_id)), None)
                if node:
                    node["widgets_values"] = [ui_text]

        return {"ui": {"text": [ui_text], "is_list_mode": [not display_mode]}, "result": (lines,)}


# ==================== 模块级注册 ====================
NODE_CLASS_MAPPINGS = {
    "JosiaTextList": JosiaTextList
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaTextList": "Josia 文本列表"
}
