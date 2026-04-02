"""
Josia Group Controller - 核心文件
Python 端节点定义，所有交互逻辑由前端 JS 实现。
"""

from .node_properties import DESCRIPTION_M, DESCRIPTION_S


class JosiaGrpCtrlM:
    """
    多组控制：自动识别工作流中所有编组，提供逐组跳过/启用控制开关，支持批量操作。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES  = ()
    FUNCTION      = "run"
    OUTPUT_NODE   = True
    CATEGORY      = "group_control"
    DESCRIPTION   = DESCRIPTION_M

    def run(self):
        return {}


class JosiaGrpCtrlS:
    """
    单组控制：通过下拉框选择目标编组，用单个开关控制该编组的跳过/启用状态。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES  = ()
    FUNCTION      = "run"
    OUTPUT_NODE   = True
    CATEGORY      = "group_control"
    DESCRIPTION   = DESCRIPTION_S

    def run(self):
        return {}