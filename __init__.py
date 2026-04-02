"""
Josia_Nodes 核心注册文件 - 修复相对导入，所有节点恢复正常
"""
import os
import sys
sys.path.append(os.path.dirname(__file__))

# 全局注册映射
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# ====================== 原有正常节点（完全还原你最初的相对导入写法，确保100%正常） ======================
# 种子节点
try:
    from .seed import NODE_CLASS_MAPPINGS as SEED_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as SEED_DISPLAY
    NODE_CLASS_MAPPINGS.update(SEED_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(SEED_DISPLAY)
    print(f"[JosiaNodes] ✅ 种子节点加载成功")
except Exception as e:
    print(f"[JosiaNodes] 种子节点加载失败: {e}")

# 缓存清理节点
try:
    from .cache_cleanup import NODE_CLASS_MAPPINGS as CACHE_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as CACHE_DISPLAY
    NODE_CLASS_MAPPINGS.update(CACHE_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(CACHE_DISPLAY)
    print(f"[JosiaNodes] ✅ 缓存清理节点加载成功")
except Exception as e:
    print(f"[JosiaNodes] 缓存清理节点加载失败: {e}")

# 图像缩放节点
try:
    from .image_scaling import NODE_CLASS_MAPPINGS as SCALE_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as SCALE_DISPLAY
    NODE_CLASS_MAPPINGS.update(SCALE_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(SCALE_DISPLAY)
    print(f"[JosiaNodes] ✅ 图像缩放节点加载成功")
except Exception as e:
    print(f"[JosiaNodes] 图像缩放节点加载失败: {e}")

# 图像对比节点
try:
    from .Image_Comparer import NODE_CLASS_MAPPINGS as IMGCMP_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as IMGCMP_DISPLAY
    NODE_CLASS_MAPPINGS.update(IMGCMP_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(IMGCMP_DISPLAY)
    print(f"[JosiaNodes] ✅ 图像对比节点加载成功")
except Exception as e:
    print(f"[JosiaNodes] 图像对比节点加载失败: {e}")

# 组控制器节点
try:
    from .group_controller import JosiaGrpCtrlM, JosiaGrpCtrlS
    GRP_CTRL_MAPPINGS = {
        "JosiaGrpCtrlM": JosiaGrpCtrlM,
        "JosiaGrpCtrlS": JosiaGrpCtrlS,
    }
    GRP_CTRL_DISPLAY = {
        "JosiaGrpCtrlM": "Josia多组控制",
        "JosiaGrpCtrlS": "Josia单组控制",
    }
    NODE_CLASS_MAPPINGS.update(GRP_CTRL_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(GRP_CTRL_DISPLAY)
    print(f"[JosiaNodes] ✅ 组控制器节点加载成功")
except Exception as e:
    print(f"[JosiaNodes] 组控制器节点加载失败: {e}")

# 流量阀门节点
try:
    from .flow_switch import NODE_CLASS_MAPPINGS as FLOW_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as FLOW_DISPLAY
    NODE_CLASS_MAPPINGS.update(FLOW_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(FLOW_DISPLAY)
    print(f"[JosiaNodes] ✅ 流量阀门节点加载成功")
except Exception as e:
    print(f"[JosiaNodes] 流量阀门节点加载失败: {e}")

# 文本编码节点
try:
    from .multi_img_encoder import NODE_CLASS_MAPPINGS as ENCODER_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as ENCODER_DISPLAY
    NODE_CLASS_MAPPINGS.update(ENCODER_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(ENCODER_DISPLAY)
    print(f"[JosiaNodes] ✅ 文本编码节点加载成功")
except Exception as e:
    print(f"[JosiaNodes] 文本编码节点加载失败: {e}")

# 前端目录配置
WEB_DIRECTORY = "./web/js"

# 最终导出
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

# 最终完成日志
print(f"[JosiaNodes] ✅ 全部节点加载完成，总计注册 {len(NODE_CLASS_MAPPINGS)} 个节点")