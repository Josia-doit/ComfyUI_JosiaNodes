"""
Josia 随机种子节点 v7.2.2
功能：支持多种种子模式（随机/固定/递增/递减），自动回填种子到工作流/Prompt
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
    """生成新的随机种子（隔离全局随机状态）"""
    global josia_seed_random_state
    prev_random_state = random.getstate()
    random.setstate(josia_seed_random_state)
    seed = random.randint(1, 1125899906842624)
    josia_seed_random_state = random.getstate()
    random.setstate(prev_random_state)
    return seed

class JosiaSeed:
    NAME = "JosiaSeed"
    CATEGORY = "Josia"
    DESCRIPTION = """Josia随机种子节点 v7.2.2
功能说明：
1. seed = -1：每次生成新随机种子
2. seed = -2：基于上一次种子+1（递增，需先有历史种子）
3. seed = -3：基于上一次种子-1（递减，需先有历史种子）
4. 其他值：固定种子，原样输出
5. 🎲 每次随机 / 🎲 固定随机 / ⬆️递增 / ⬇️递减 / ♻️使用上次种子
"""

    def __init__(self):
        """v7.2: 仅追踪上次种子值"""
        self._last_seed = None

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": ("INT", {
                    "default": -1,
                    "min": -1125899906842624,
                    "max": 1125899906842624,
                    "tooltip": "种子值：-1=每次随机，-2=递增(+1)，-3=递减(-1)，其他=固定",
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
        """
        v7.2.2 核心逻辑（简化版）：
        -1 → 每次随机
        -2 → _last_seed + 1（有历史种子时），否则返回0
        -3 → _last_seed - 1（有历史种子时），否则返回0
        其他 → 固定种子，同时记录为 _last_seed 供后续递增/递减使用
        """
        if seed in (-1, -2, -3):
            original_seed = seed

            if original_seed == -1:
                # ── 每次随机 ──
                actual_seed = new_random_seed()

            elif original_seed == -2:
                # ── 递增：上次+1，无历史种子则返回0 ──
                if self._last_seed is not None:
                    actual_seed = self._last_seed + 1
                else:
                    print(f"[Josia随机种子] ⚠️ 递增模式：尚无历史种子，返回0")
                    actual_seed = 0

            elif original_seed == -3:
                # ── 递减：上次-1，无历史种子则返回0 ──
                if self._last_seed is not None:
                    actual_seed = self._last_seed - 1
                else:
                    print(f"[Josia随机种子] ⚠️ 递减模式：尚无历史种子，返回0")
                    actual_seed = 0

            self._last_seed = actual_seed

            # 回填工作流/Prompt 种子值
            try:
                if unique_id and extra_pnginfo:
                    for node in extra_pnginfo["workflow"]["nodes"]:
                        if str(node["id"]) == str(unique_id):
                            if "widgets_values" in node:
                                for i, v in enumerate(node["widgets_values"]):
                                    if v == original_seed:
                                        node["widgets_values"][i] = actual_seed
                            break
            except Exception as e:
                print(f"[Josia随机种子] 更新工作流种子失败: {e}")

            try:
                if unique_id and prompt:
                    p = prompt.get(str(unique_id))
                    if p and "inputs" in p:
                        p["inputs"]["seed"] = actual_seed
            except Exception as e:
                print(f"[Josia随机种子] 更新Prompt种子失败: {e}")

            return {"ui": {"seed": [actual_seed]}, "result": (actual_seed,)}

        else:
            # 固定种子 — 记录作为后续递增/递减的基数
            self._last_seed = seed
            return {"ui": {"seed": [seed]}, "result": (seed,)}

# ==================== 节点映射 ====================
NODE_CLASS_MAPPINGS = {
    "JosiaSeed": JosiaSeed,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "JosiaSeed": "Josia随机种子",
}
