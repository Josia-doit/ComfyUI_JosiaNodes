"""
Josia 流量阀门节点
功能：多通道数据透传/截断控制，支持5个任意类型数据通道的开关控制
本地文件名：flow_valve.py
节点英文标识：JosiaFlowValve
节点中文显示名：Josia流量阀门
"""

class JosiaFlowValve:  # 类名与__init__.py注册的JosiaFlowValve严格一致
    """🔀 Josia 流量阀门
5 路独立通道开关，控制任意类型数据的透传与截断。

• 通道开 ✅：数据原样透传到下游
• 通道关 ❌：输出 None，截断数据流

支持任意数据类型，全 5 路独立控制。"""

    DESCRIPTION = """🔀 Josia 流量阀门
5 路独立通道开关，控制任意类型数据的透传与截断。

• 通道开 ✅：数据原样透传到下游
• 通道关 ❌：输出 None，截断数据流

支持任意数据类型，全 5 路独立控制。"""

    # 输出类型：支持任意类型数据（*），5个输出通道
    RETURN_TYPES = ("*", "*", "*", "*", "*")
    RETURN_NAMES = ("输出1", "输出2", "输出3", "输出4", "输出5")

    FUNCTION = "run"  # 核心执行函数名
    CATEGORY = "Josia"  # 节点分类（ComfyUI左侧菜单路径）

    @classmethod
    def INPUT_TYPES(cls):
        """定义节点输入参数（ComfyUI核心要求）"""
        return {
            "required": {
                # 通道开关（必选参数）：布尔值，带直观的开关标签
                "通道1": ("BOOLEAN", {
                    "default": True, 
                    "label": "通道1",
                    "label_on": "开✅数据透传",
                    "label_off": "关❌流量截断"
                }),
                "通道2": ("BOOLEAN", {
                    "default": True, 
                    "label": "通道2",
                    "label_on": "开✅数据透传",
                    "label_off": "关❌流量截断"
                }),
                "通道3": ("BOOLEAN", {
                    "default": True, 
                    "label": "通道3",
                    "label_on": "开✅数据透传",
                    "label_off": "关❌流量截断"
                }),
                "通道4": ("BOOLEAN", {
                    "default": True, 
                    "label": "通道4",
                    "label_on": "开✅数据透传",
                    "label_off": "关❌流量截断"
                }),
                "通道5": ("BOOLEAN", {
                    "default": True, 
                    "label": "通道5",
                    "label_on": "开✅数据透传",
                    "label_off": "关❌流量截断"
                }),
            },
            "optional": {
                # 数据输入（可选参数）：支持任意类型数据
                "输入1": ("*", {"label": "输入1"}),
                "输入2": ("*", {"label": "输入2"}),
                "输入3": ("*", {"label": "输入3"}),
                "输入4": ("*", {"label": "输入4"}),
                "输入5": ("*", {"label": "输入5"}),
            }
        }

    def run(self, 通道1, 通道2, 通道3, 通道4, 通道5, 输入1=None, 输入2=None, 输入3=None, 输入4=None, 输入5=None):
        """
        核心执行逻辑：根据通道开关状态透传/截断数据
        :param 通道1-5: 布尔值，True=透传，False=截断
        :param 输入1-5: 任意类型数据，可选输入
        :return: 5个输出值（开=原数据，关=None）
        """
        out1 = 输入1 if 通道1 else None
        out2 = 输入2 if 通道2 else None
        out3 = 输入3 if 通道3 else None
        out4 = 输入4 if 通道4 else None
        out5 = 输入5 if 通道5 else None

        return (out1, out2, out3, out4, out5)

# ==================== ComfyUI 节点映射（必须与__init__.py注册名一致） ====================
NODE_CLASS_MAPPINGS = {
    "JosiaFlowValve": JosiaFlowValve  # 英文标识：与__init__.py中的node_alias完全匹配
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaFlowValve": "Josia流量阀门"  # 中文显示名：与__init__.py中的display_name完全匹配
}
