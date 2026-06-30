"""
Josia 文本列表节点 v1.0.0
功能：将多行字符串按行分割为字符串列表，支持空行过滤和空白修剪
本地文件名：text_list.py
节点英文标识：JosiaTextList
节点中文显示名：Josia 文本列表
依赖：无（纯Python标准库）
"""


class JosiaTextList:
    """将多行字符串按行分割为字符串列表"""

    CATEGORY = "Josia"
    FUNCTION = "split_string"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt_list",)
    OUTPUT_IS_LIST = (True,)
    OUTPUT_NODE = False

    DESCRIPTION = """📝 Josia 文本列表
将多行字符串按行分割为字符串列表，每行作为一个独立的字符串输出。

【使用方法】
  连接上游文本节点 → 自动按换行符分割 → 输出为列表

【适用场景】
  • 提示词批量处理：将多行提示词逐行拆分为独立条目
  • 路径列表拆分：将多行路径字符串拆分为路径列表
  • 配置项拆分：将多行配置文本逐行拆分

【可选设置】
  过滤空行 — 开启后自动去除空行
  修剪空白 — 开启后去除每行首尾空格、制表符等空白字符"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "forceInput": True,
                    "display_name": "输入文本",
                    "tooltip": "多行字符串，按换行符分割为列表。每行作为一个独立字符串输出。",
                }),
            },
            "optional": {
                "filter_empty": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ 过滤空行",
                    "label_off": "❌ 保留空行",
                    "display_name": "过滤空行",
                    "tooltip": "开启后自动去除分割结果中的空行（分割后为空字符串的行）",
                }),
                "trim_whitespace": ("BOOLEAN", {
                    "default": True,
                    "label_on": "✅ 修剪空白",
                    "label_off": "❌ 保留空白",
                    "display_name": "修剪空白",
                    "tooltip": "开启后去除每行首尾的空格、制表符、换行符等空白字符",
                }),
            },
        }

    def split_string(self, text, filter_empty=True, trim_whitespace=True):
        if not text:
            return ([""],)

        lines = text.split("\n")

        if trim_whitespace:
            lines = [line.strip() for line in lines]

        if filter_empty:
            lines = [line for line in lines if line]

        if not lines:
            return ([""],)

        return (lines,)


# ==================== 模块级注册 ====================
NODE_CLASS_MAPPINGS = {
    "JosiaTextList": JosiaTextList
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaTextList": "Josia 文本列表"
}
