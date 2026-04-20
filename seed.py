"""
Josia 随机种子节点
功能：支持多种种子生成模式（随机/递增/递减/固定），自动回填种子到工作流/Prompt
本地文件名：seed.py
节点英文标识：JosiaSeed
节点中文显示名：Josia随机种子
依赖：random、datetime
"""
import random
from datetime import datetime

# 初始化随机状态（隔离节点随机与全局随机）
initial_random_state = random.getstate()
random.seed(datetime.now().timestamp())
josia_seed_random_state = random.getstate()
random.setstate(initial_random_state)

def new_random_seed():
    """
    生成新的随机种子（隔离全局随机状态）
    :return: 1~1125899906842624 范围内的随机整数
    """
    global josia_seed_random_state
    prev_random_state = random.getstate()
    random.setstate(josia_seed_random_state)
    seed = random.randint(1, 1125899906842624)
    josia_seed_random_state = random.getstate()
    random.setstate(prev_random_state)
    return seed

def log_node_info(name, msg):
    """节点日志输出函数"""
    print(f"[Josia随机种子] {msg}")

class JosiaSeed:
    NAME = "JosiaSeed"  # 节点右上角显示的英文名
    CATEGORY = "Josia"  # 节点分类（ComfyUI左侧菜单路径）
    DESCRIPTION = """Josia随机种子节点
功能说明：
1. seed = -1：每次生成自动随机
2. seed = -2：基于上一次种子自动+1
3. seed = -3：基于上一次种子自动-1
4. 🎲 每次随机：设置seed为-1，每次队列都换新种子
5. 🎲 新固定随机：生成一个新的固定种子
6. ♻️ 使用上一次种子：回填上一次成功生成的种子
"""

    @classmethod
    def INPUT_TYPES(cls):
        """定义节点输入参数（ComfyUI核心要求）"""
        return {
            "required": {
                "seed": ("INT", {
                    "default": -1,
                    "min": -1125899906842624,
                    "max": 1125899906842624,
                    "tooltip": "种子值：-1=每次随机，-2=递增，-3=递减，其他=固定种子"
                }),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    # 输出类型与名称定义
    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("SEED",)
    FUNCTION = "main"  # 核心执行函数名

    @classmethod
    def IS_CHANGED(cls, seed, **kwargs):
        """
        ComfyUI生命周期函数：判断节点是否需要重新执行
        :param seed: 输入种子值
        :return: 新种子值（触发重新执行）或原种子值（不触发）
        """
        if seed in (-1, -2, -3):
            return new_random_seed()
        return seed

    def main(self, seed=0, prompt=None, extra_pnginfo=None, unique_id=None):
        """
        核心种子生成逻辑
        :param seed: 输入种子值
        :param prompt: 隐藏参数（ComfyUI提示词）
        :param extra_pnginfo: 隐藏参数（PNG附加信息，包含工作流）
        :param unique_id: 隐藏参数（节点唯一ID）
        :return: 最终生成的种子值
        """
        if seed in (-1, -2, -3):
            original_seed = seed
            seed = new_random_seed()
            log_node_info(self.NAME, f"生成随机种子: {seed}")

            # 尝试更新工作流中的种子值（回填）
            try:
                if unique_id and extra_pnginfo:
                    for node in extra_pnginfo["workflow"]["nodes"]:
                        if str(node["id"]) == str(unique_id):
                            if "widgets_values" in node:
                                for i, v in enumerate(node["widgets_values"]):
                                    if v == original_seed:
                                        node["widgets_values"][i] = seed
                            break
            except Exception as e:
                log_node_info(self.NAME, f"更新工作流种子失败: {e}")

            # 尝试更新Prompt中的种子值（回填）
            try:
                if unique_id and prompt:
                    p = prompt.get(str(unique_id))
                    if p and "inputs" in p:
                        p["inputs"]["seed"] = seed
            except Exception as e:
                log_node_info(self.NAME, f"更新Prompt种子失败: {e}")

        # 通过 ui 机制向前端回传实际使用的种子值（用于"使用上一次种子"功能）
        return {"ui": {"seed": [seed]}, "result": (seed,)}

# ==================== ComfyUI 节点映射（与__init__.py注册名严格一致） ====================
NODE_CLASS_MAPPINGS = {
    "JosiaSeed": JosiaSeed  # 英文标识：与__init__.py中的node_alias完全匹配
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaSeed": "Josia随机种子"  # 中文显示名：与__init__.py中的display_name完全匹配
}
