"""
Josia ComfyUI 自定义节点集 - 总注册文件
规范：
1. 本地文件名：全小写（如encoder.py、image_comparer.py）
2. 代码内类名/注册名：带Josia（如JosiaEncoder、JosiaImageComparer）
3. 中文显示名：带Josia（如Josia文本编码、Josia图像对比）
包含节点：文本编码、流量阀门、缓存清理、随机种子、图像对比、图像缩放、分组控制
"""
import os
import importlib.util
import sys

# ==================== 核心配置 ====================
NODE_PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, NODE_PACKAGE_DIR)  # 【关键修复】解决相对导入失败
WEB_DIRECTORY = os.path.join(NODE_PACKAGE_DIR, "web/js")

# ==================== 全局节点映射初始化 ====================
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# ==================== 节点注册通用函数 ====================
def register_node(module_name, node_alias, display_name):
    try:
        module_file = os.path.join(NODE_PACKAGE_DIR, f"{module_name}.py")
        spec = importlib.util.spec_from_file_location(module_name, module_file)
        if spec is None or spec.loader is None:
            raise FileNotFoundError(f"模块 {module_name} 加载失败")
        
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        
        if hasattr(module, "NODE_CLASS_MAPPINGS"):
            if node_alias in module.NODE_CLASS_MAPPINGS:
                NODE_CLASS_MAPPINGS[node_alias] = module.NODE_CLASS_MAPPINGS[node_alias]
                NODE_DISPLAY_NAME_MAPPINGS[node_alias] = display_name
                print(f"[JosiaNodes] ✅ {display_name} 加载成功")
            else:
                available_nodes = list(module.NODE_CLASS_MAPPINGS.keys())
                print(f"[JosiaNodes] ⚠️ {display_name} 未找到别名 {node_alias}，可用：{available_nodes}")
        else:
            print(f"[JosiaNodes] ⚠️ {display_name} 无 NODE_CLASS_MAPPINGS")
    except FileNotFoundError:
        print(f"[JosiaNodes] ❌ {display_name} 未找到文件 {module_file}")
    except Exception as e:
        print(f"[JosiaNodes] ❌ {display_name} 加载异常：{str(e)}")

# ==================== 批量注册所有节点 ====================
register_node("encoder", "JosiaEncoder", "Josia文本编码")
register_node("flow_valve", "JosiaFlowValve", "Josia流量阀门")
register_node("cache_cleanup", "JosiaCacheCleanup", "Josia缓存清理")
register_node("seed", "JosiaSeed", "Josia随机种子")
register_node("image_comparer", "JosiaImageComparer", "Josia图像对比")
register_node("image_scaling", "JosiaImageScaling", "Josia图像缩放")
register_node("group_controller", "JosiaGroupControllerM", "Josia多组控制")
register_node("group_controller", "JosiaGroupControllerS", "Josia单组控制")

# ==================== 兼容旧版导入 ====================
__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "NODE_PACKAGE_DIR"
]

# ==================== 最终验证输出 ====================
print(f"\n[JosiaNodes] 📋 最终注册节点总数：{len(NODE_CLASS_MAPPINGS)}")
if NODE_CLASS_MAPPINGS:
    for node_alias, node_class in NODE_CLASS_MAPPINGS.items():
        display_name = NODE_DISPLAY_NAME_MAPPINGS.get(node_alias, "未设置显示名")
        print(f"             ✅ {node_alias} → {display_name}")
else:
    print("[JosiaNodes] ⚠️ 无任何节点成功注册")
