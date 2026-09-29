"""
Josia 跨节点模型共享注册表（模块级单例）
========================================================================

【为什么需要它】
ComfyUI **没有**官方的「跨节点共享已加载对象」机制（已核源码确认）：
  · `comfy.model_management.current_loaded_models` 只登记 MODEL，且持有的是
    **弱引用**、还会在显存压力时被弹出 —— 拿它找不到 VAE；
  · `folder_paths` 只有「路径 → 扩展名」「文件名清单」两类缓存，没有对象注册表；
  · `execution.py` 的 `CacheSet` 只是**单次 prompt 内**的节点输出缓存，跨工作流无效。
所以「Josia模型加载」载入的 VAE / VAE2 想被别的节点（如「Josia媒体保存」）
直接引用（也就是用户说的「无线连接」），只能由本包自己维护一张表。

【职责】
· `JosiaCheckpointPlus.load_model()` 在 return 前调用 `publish()` 登记本次载入结果；
· 下游节点用 `get_vae("vae1" | "vae2")` 取对象（取不到返回 None，自行降级）；
· 前端通过 HTTP 路由读 `snapshot()` 渲染下拉框/状态提示（**只给布尔与文字，不给对象**）。

【设计取舍】
· **按「最近一次加载」覆盖，不做多节点分槽**：一个工作流通常只有一个模型加载节点；
  真有多个时，后加载的生效（节点 tooltip 里已向用户说明这一点）。
· **刻意持有强引用**：持有 VAE 对象 = 阻止它被 GC —— 这正是「热启动不降速」想要的。
  只持 VAE（体积小、重载代价高），**不持有 MODEL / CLIP**（那才是显存大头）。
  `clear()` 是唯一的主动释放入口。
· **线程安全**：ComfyUI 的节点执行跑在子线程里，所有读写都用 `RLock` 保护。
"""

from __future__ import annotations

import json
import os
import threading
import time

__all__ = ["VAE1", "VAE2", "publish", "get_vae", "has_vae", "snapshot", "clear",
           "get_labels"]

# 取用时的路别名（与「Josia媒体保存」的 VAE1 / VAE2 两个下拉框一一对应）
VAE1 = "vae1"          # 主 VAE（视频 VAE）
VAE2 = "vae2"          # 音频 VAE

_LOCK = threading.RLock()

_STATE = {
    VAE1: None,
    VAE2: None,
    "label1": "",      # VAE1 来源说明（通常是 VAE 模型文件名）
    "label2": "",      # VAE2 来源说明
    "source": "",      # 来源说明（通常是主模型文件名）
    "time": 0.0,
}


def publish(vae=None, vae2=None, label1="", label2="", source=""):
    """登记一次加载结果。

    🔴 任一 `vae*` 传 None 表示「**本次加载就没有这一路**」（例如换成用模型内置 VAE
    的搭配）⇒ **清空**表里该路的旧对象与旧标签。旧版这里写的是「不覆盖、保留旧值」，
    结果用户换了一套模型搭配后，下游「Josia媒体保存」还在偷偷用**上一次**的 VAE 解码
    （报错让人摸不着头脑），信息窗也显示着上一次的标签 —— 正是用户报的 Round 19 问题 1。
    清空后：下游 `get_vae` 拿到 None → 走「共享 VAE 未就绪」的明确告警路径，
    信息窗也如实显示「待运行」。

    真正的「注册表还没轮空」场景不受影响：模型加载节点没重新执行（被缓存/没跑到）
    时 `publish()` 根本不会被调用，表里仍是上一次的值。
    """
    with _LOCK:
        if vae is None:
            _STATE[VAE1] = None
            _STATE["label1"] = ""
        else:
            _STATE[VAE1] = vae
            _STATE["label1"] = str(label1 or _STATE["label1"] or "")
        if vae2 is None:
            _STATE[VAE2] = None
            _STATE["label2"] = ""
        else:
            _STATE[VAE2] = vae2
            _STATE["label2"] = str(label2 or _STATE["label2"] or "")
        if source:
            _STATE["source"] = str(source)
        _STATE["time"] = time.time()
        _persist_unlocked()


def get_vae(which=VAE1):
    """取已登记的 VAE 对象；没有则 None。"""
    if which not in (VAE1, VAE2):
        raise KeyError(f"未知的 VAE 路：{which!r}（应为 {VAE1!r} 或 {VAE2!r}）")
    with _LOCK:
        return _STATE[which]


# ------------------------------------------------------------------
# 持久化（2026-09-29 第十八轮）
# ------------------------------------------------------------------
# 🔴 注册表是**进程内存单例**：重启 ComfyUI 后为空；且「Josia模型加载」只有真正
#    执行过才 publish —— 下游只跑「加载Latent → 媒体保存」解码链（模型加载节点不在
#    执行路径上）时，注册表必然是空的，「使用Josia模型加载VAE」联动必失败。
#    修法：publish 时把 **文件名标签** 持久化到磁盘；下游拿不到对象时按登记的
#    文件名重载 VAE（文件名足够定位模型，重载一次的代价可接受）。
def _persist_path():
    """状态文件路径：ComfyUI user 目录优先（随用户数据走），取不到退回包目录。"""
    try:
        import folder_paths
        base = folder_paths.get_user_directory()
        if base:
            return os.path.join(base, "JosiaNodes", "model_registry.json")
    except Exception:
        pass
    return os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "_model_registry_state.json")


def _persist_unlocked():
    """把当前文件名标签写盘（持锁调用）。失败静默 —— 持久化绝不能影响加载。"""
    try:
        path = _persist_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data = {
            "vae1": _STATE["label1"],
            "vae2": _STATE["label2"],
            "source": _STATE["source"],
            "time": _STATE["time"],
        }
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)          # 原子替换，避免写一半被读到
    except Exception:
        pass


def get_labels():
    """取已登记的 VAE **文件名标签**：内存优先，内存没有（刚重启）读磁盘。

    返回 {"vae1": 文件名或"", "vae2": 文件名或"", "source": 主模型文件名或""}。
    绝不抛 —— 调用方（媒体保存的回退加载）只把它当尽力而为的提示。
    """
    with _LOCK:
        out = {"vae1": _STATE["label1"], "vae2": _STATE["label2"],
               "source": _STATE["source"]}
        if out["vae1"] or out["vae2"]:
            return out
    # 内存空（进程刚启动 / 尚未跑过模型加载）⇒ 读磁盘
    try:
        with open(_persist_path(), encoding="utf-8") as f:
            data = json.load(f)
        return {"vae1": str(data.get("vae1") or ""),
                "vae2": str(data.get("vae2") or ""),
                "source": str(data.get("source") or "")}
    except Exception:
        return {"vae1": "", "vae2": "", "source": ""}


def has_vae(which=VAE1):
    return get_vae(which) is not None


def snapshot():
    """可 JSON 化的摘要。**绝不含对象本身**，避免把张量塞进 json_response。"""
    with _LOCK:
        return {
            "vae1": _STATE[VAE1] is not None,
            "vae2": _STATE[VAE2] is not None,
            "label1": _STATE["label1"],
            "label2": _STATE["label2"],
            "source": _STATE["source"],
            "time": _STATE["time"],
        }


def clear(which=None):
    """主动释放。`which=None` 清全部（对象失去引用后由 GC 回收）。"""
    with _LOCK:
        if which is None:
            _STATE[VAE1] = None
            _STATE[VAE2] = None
            _STATE["label1"] = ""
            _STATE["label2"] = ""
            _STATE["source"] = ""
            _STATE["time"] = 0.0
        elif which in (VAE1, VAE2):
            _STATE[which] = None
            _STATE["label1" if which == VAE1 else "label2"] = ""
        else:
            raise KeyError(f"未知的 VAE 路：{which!r}")
