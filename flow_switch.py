import torch

class JosiaFlowSwitch:
    # 输出：输出① ② ③ ④ ⑤
    RETURN_TYPES = ("*", "*", "*", "*", "*")
    RETURN_NAMES = ("输出①", "输出②", "输出③", "输出④", "输出⑤")
    
    FUNCTION = "run"
    CATEGORY = "Josia 专用节点/流量控制"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 开关显示：通道① / 通道② ... 文案完整
                "通道①": ("BOOLEAN", {"default": True, "label_on": " 开✅数据透传", "label_off": "通道① 关❌流量截断"}),
                "通道②": ("BOOLEAN", {"default": True, "label_on": " 开✅数据透传", "label_off": "通道② 关❌流量截断"}),
                "通道③ ": ("BOOLEAN", {"default": True, "label_on": "开✅数据透传", "label_off": "通道③ 关❌流量截断"}),
                "通道④": ("BOOLEAN", {"default": True, "label_on": " 开✅数据透传", "label_off": "通道④ 关❌流量截断"}),
                "通道⑤": ("BOOLEAN", {"default": True, "label_on": " 开✅数据透传", "label_off": "通道⑤ 关❌流量截断"}),
            },
            "optional": {
                # 输入：输入① ② ③ ④ ⑤ —— 你要的样子！
                "输入①": ("*",),
                "输入②": ("*",),
                "输入③": ("*",),
                "输入④": ("*",),
                "输入⑤": ("*",),
            }
        }

    # 最安全写法：**kwargs 永远不报错
    def run(self, 通道1, 通道2, 通道3, 通道4, 通道5, **kwargs):
        i1 = kwargs.get("输入①", None)
        i2 = kwargs.get("输入②", None)
        i3 = kwargs.get("输入③", None)
        i4 = kwargs.get("输入④", None)
        i5 = kwargs.get("输入⑤", None)

        o1 = i1 if 通道1 else None
        o2 = i2 if 通道2 else None
        o3 = i3 if 通道3 else None
        o4 = i4 if 通道4 else None
        o5 = i5 if 通道5 else None

        return (o1, o2, o3, o4, o5)

NODE_CLASS_MAPPINGS = {
    "JosiaFlowSwitch": JosiaFlowSwitch
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaFlowSwitch": "Josia流量阀门"
}