"""
Josia Group Controller - 分组控制节点核心文件
功能：
1. JosiaGroupControllerM（多组控制）：自动识别工作流中所有编组，逐组提供跳过/启用开关，支持批量操作；
2. JosiaGroupControllerS（单组控制）：通过下拉框选择目标编组，用单个开关控制该编组的跳过/启用状态；
3. 所有交互逻辑由前端 group_controller.js 实现，Python 端仅定义节点基础结构。
本地文件名：group_controller.py
节点英文标识：JosiaGroupControllerM / JosiaGroupControllerS
节点中文显示名：Josia多组控制 / Josia单组控制
"""

from node_properties import DESCRIPTION_M, DESCRIPTION_S


class JosiaGroupControllerM:
    """
    多组控制节点：
    - 自动识别工作流中所有编组，逐组提供跳过/启用控制开关；
    - 支持"全部跳过"/"全部启用"批量操作；
    - 点击编组名称可导航至该编组位置；
    - 所有交互逻辑由前端 JS 实现，Python 端仅为占位节点。
    """

    DESCRIPTION = """🎛️ Josia 多组控制
批量控制工作流中所有编组的跳过/启用状态。

• 全部跳过 — 批量将所有编组设为跳过
• 全部启用 — 批量恢复所有编组为启用
• 点击编组名称 — 跳转至该编组位置

状态：绿色=已启用，红色=已跳过，橙色=部分跳过"""

    @classmethod
    def INPUT_TYPES(cls):
        """节点输入参数（无实际输入，仅占位）"""
        return {"required": {}}

    RETURN_TYPES = ()          # 无输出
    FUNCTION = "run"           # 核心执行函数（空实现）
    OUTPUT_NODE = True         # 标记为输出节点（无实际输出）
    CATEGORY = "Josia"  # 统一节点分类

    def run(self):
        """核心执行函数（空实现，交互由前端 JS 处理）"""
        return {}


class JosiaGroupControllerS:
    """
    单组控制节点：
    - 通过下拉框选择目标编组；
    - 单个开关控制选中编组的跳过/启用状态；
    - 选中编组信息随工作流序列化保存；
    - 所有交互逻辑由前端 JS 实现，Python 端仅为占位节点。
    """

    DESCRIPTION = """🎚️ Josia 单组控制
精确控制工作流中的单个编组。

• 下拉选择 — 选择要控制的目标编组
• 开关按钮 — 切换编组的跳过/启用状态

选中编组信息随工作流保存，重新打开自动恢复。"""

    @classmethod
    def INPUT_TYPES(cls):
        """节点输入参数（无实际输入，仅占位）"""
        return {"required": {}}

    RETURN_TYPES = ()          # 无输出
    FUNCTION = "run"           # 核心执行函数（空实现）
    OUTPUT_NODE = True         # 标记为输出节点（无实际输出）
    CATEGORY = "Josia"  # 统一节点分类

    def run(self):
        """核心执行函数（空实现，交互由前端 JS 处理）"""
        return {}


# ==================== ComfyUI 节点映射（与__init__.py注册名严格一致） ====================
NODE_CLASS_MAPPINGS = {
    "JosiaGroupControllerM": JosiaGroupControllerM,
    "JosiaGroupControllerS": JosiaGroupControllerS
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaGroupControllerM": "Josia多组控制",
    "JosiaGroupControllerS": "Josia单组控制"
}
