import random
from datetime import datetime

initial_random_state = random.getstate()
random.seed(datetime.now().timestamp())
josia_seed_random_state = random.getstate()
random.setstate(initial_random_state)

def new_random_seed():
    global josia_seed_random_state
    prev_random_state = random.getstate()
    random.setstate(josia_seed_random_state)
    seed = random.randint(1, 1125899906842624)
    josia_seed_random_state = random.getstate()
    random.setstate(prev_random_state)
    return seed

def log_node_info(name, msg):
    print(f"[Josia随机种子] {msg}")

class JosiaSeed:
    NAME = "JosiaSeed"  # 右上角节点英文名
    CATEGORY = "Josia"
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

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("SEED",)
    FUNCTION = "main"

    @classmethod
    def IS_CHANGED(cls, seed, **kwargs):
        if seed in (-1, -2, -3):
            return new_random_seed()
        return seed

    def main(self, seed=0, prompt=None, extra_pnginfo=None, unique_id=None):
        if seed in (-1, -2, -3):
            original_seed = seed
            seed = new_random_seed()
            log_node_info(self.NAME, f"生成随机种子: {seed}")

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

            try:
                if unique_id and prompt:
                    p = prompt.get(str(unique_id))
                    if p and "inputs" in p:
                        p["inputs"]["seed"] = seed
            except Exception as e:
                log_node_info(self.NAME, f"更新Prompt种子失败: {e}")

        return (seed,)

# 节点映射（保持英文名和中文名不变）
NODE_CLASS_MAPPINGS = {
    "JosiaSeed": JosiaSeed  # 右上角英文名
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaSeed": "Josia随机种子"  # 左上角中文名
}