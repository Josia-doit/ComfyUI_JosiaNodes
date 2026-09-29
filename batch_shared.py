"""
🔁 批量解码进度清单（test 节点专用，测过即删）

Load Latent test 当「调度器」：每次执行从**任务池（queue）**里挑一个「未完成」的 .latent 推出去；
Media Save test 当「工人」：解码落盘后把该文件标记为 done（或 failed）。

🔴 按节点实例隔离（哥哥要求：多个加载Latent节点互不共用）：
  清单以「节点 ID（ComfyUI hidden 输入 unique_id）」为键分桶，nodes[nid] 各存各的
  queue / files。A 节点载入的文件、进度绝不会出现在 B 节点的信息窗里。

任务池＝用户在节点里「📁 选择文件」显式载入的 .latent 列表（可多文件、可清空重选）。

健壮性（核心不变量）：
  · 「标记完成」的唯一判据＝Media Save 解码**成功落盘**后写回 done；
    打断时当前文件没落盘 ⇒ 没写 done ⇒ 重跑仍算 pending ⇒ 自动续跑。
  · 同一节点的清单按源文件名索引；串行写（队列 batch count 驱动，单次只一个执行在跑）。
"""
import os
import json
import time

import folder_paths

MANIFEST_NAME = "_batch_manifest.json"
SOURCE_SUBDIR = "josia_latent"      # 与 load_latent.py 的 LATENT_SUBDIR 保持一致


def _manifest_path():
    return os.path.join(folder_paths.get_input_directory(), SOURCE_SUBDIR, MANIFEST_NAME)


def _ensure_dir():
    try:
        os.makedirs(os.path.dirname(_manifest_path()), exist_ok=True)
    except Exception:
        pass


def _norm_nid(nid):
    """节点 ID 规范化：空值退到 "default"（兜底：手工填文件名、老工作流等场景）。"""
    s = str(nid).strip() if nid is not None else ""
    return s or "default"


def read_manifest():
    """读**整份**清单；任何异常都退化成空清单（绝不抛，否则会拖垮节点执行）。

    v2 结构：{"version": 2, "nodes": {nid: {"queue": [...], "files": {...}}}}。
    兼容 v1（顶层 queue/files）⇒ 迁移为 nodes["default"]。
    """
    empty = {"version": 2, "nodes": {}}
    try:
        with open(_manifest_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return empty
        if not isinstance(data.get("nodes"), dict):
            # v1 → v2 迁移：旧顶层 queue/files 挪进 default 桶
            legacy = {"queue": data.get("queue") or [], "files": data.get("files") or {}}
            data = {"version": 2, "nodes": {"default": legacy} if (legacy["queue"] or legacy["files"]) else {}}
        for nid, bucket in list(data["nodes"].items()):
            if not isinstance(bucket, dict):
                data["nodes"][nid] = {"queue": [], "files": {}}
                continue
            bucket.setdefault("queue", [])
            bucket.setdefault("files", {})
        return data
    except Exception:
        return empty


def write_manifest(m):
    """原子写：先写 .tmp 再 os.replace，避免半截文件把进度搞坏。"""
    _ensure_dir()
    try:
        tmp = _manifest_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(m, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _manifest_path())
    except Exception:
        pass


def _bucket(m, nid):
    return m["nodes"].setdefault(_norm_nid(nid), {"queue": [], "files": {}})


def node_data(nid):
    """取某个节点的桶（只读视图）：{"queue": [...], "files": {...}}。"""
    m = read_manifest()
    b = m["nodes"].get(_norm_nid(nid)) or {"queue": [], "files": {}}
    return {"queue": list(b.get("queue") or []), "files": dict(b.get("files") or {})}


def enqueue(nid, names):
    """把一批文件名追加进**该节点**的任务池（去重，保持首次出现顺序）。返回更新后的 queue。

    每个新入队文件默认标 pending；已在池里的不动它的状态（可重复载入不丢进度）。
    """
    if not isinstance(names, (list, tuple)):
        names = [names]
    m = read_manifest()
    b = _bucket(m, nid)
    q = list(b["queue"])
    for n in names:
        if not n:
            continue
        n = str(n)
        if n not in q:
            q.append(n)
            b["files"].setdefault(n, {"status": "pending"})
    b["queue"] = q
    write_manifest(m)
    return q


def clear_queue(nid):
    """清空**该节点**的任务池与进度（「🗑 清空列表」调用）。

    只把文件从队列移除、状态归零；磁盘上的 .latent 不删，方便用户重新选择。
    """
    try:
        m = read_manifest()
        m["nodes"].pop(_norm_nid(nid), None)
        write_manifest(m)
    except Exception:
        pass
    return True


def set_status(nid, name, status, **extra):
    """把某个源文件在**该节点**的清单里标记成指定状态（pending/processing/done/failed）。

    返回更新后的 entry；name 为空直接返回 None（不写）。
    """
    if not name:
        return None
    m = read_manifest()
    b = _bucket(m, nid)
    entry = dict(b["files"].get(str(name)) or {})
    entry["status"] = status
    entry["updated"] = time.time()
    for k, v in extra.items():
        if v is not None:
            entry[k] = v
    b["files"][str(name)] = entry
    write_manifest(m)
    return entry


def update_file(nid, name, **fields):
    """往**该节点**的某个文件条目里合并写字段（**不动 status**），用于缓存分辨率 / 帧数等元信息。

    上传入队时读一次 .latent 的形状，把像素宽高 / 帧数存住，信息窗文件列表直接取用，
    不必每次刷新快照都重读全部文件。
    """
    if not name:
        return None
    m = read_manifest()
    b = _bucket(m, nid)
    entry = dict(b["files"].get(str(name)) or {})
    entry.update({k: v for k, v in fields.items() if v is not None})
    b["files"][str(name)] = entry
    write_manifest(m)
    return entry


def reset_manifest(nid):
    """重置**该节点**的进度（**保留任务池**）：把每个文件状态归零，可重新解码同一批文件。

    「🔄 重置进度」按钮调用；与 clear_queue（清空列表）区分开。
    """
    try:
        m = read_manifest()
        b = _bucket(m, nid)
        for n in (b.get("queue") or []):
            b["files"][n] = {"status": "pending"}
        write_manifest(m)
    except Exception:
        pass
    return True


def remove_file(nid, name):
    """把**单个文件**从该节点的任务池移除（列表行尾「✕」按钮）。

    queue 与 files 条目一并清掉；磁盘上的 .latent 不删。文件不在池里时静默成功（幂等）。
    """
    n = str(name or "").strip()
    if not n:
        return True
    try:
        m = read_manifest()
        b = m["nodes"].get(_norm_nid(nid))
        if b is not None:
            b["queue"] = [q for q in (b.get("queue") or []) if str(q) != n]
            b["files"].pop(n, None)
            write_manifest(m)
    except Exception:
        pass
    return True


def migrate_bucket(old_nid, new_nid):
    """把 old_nid 桶整体搬进 new_nid（旧版按 node.id 分桶的一次性搬家）。

    🔴 旧版任务池按 ComfyUI hidden unique_id（＝node.id）分桶，实测 node.id 会随
    切换工作流 / 前端重编号而漂移（同一逻辑节点的池被撕进桶 1 / 11 / 14 / 16）⇒
    新版改用前端持久化在「Latent文件」widget 里的稳定 UUID 当钥匙，这里负责把
    旧钥匙桶搬过来。仅当 old 桶非空且 new 桶不存在/为空时执行，搬完删旧桶；
    幂等，任何异常都静默不动盘。
    """
    o, n = _norm_nid(old_nid), _norm_nid(new_nid)
    if o == n:
        return False
    try:
        m = read_manifest()
        nodes = m["nodes"]
        ob = nodes.get(o)
        if not ob or not (ob.get("queue") or ob.get("files")):
            return False
        nb = nodes.get(n)
        if nb and (nb.get("queue") or nb.get("files")):
            return False
        nodes[n] = ob
        nodes.pop(o, None)
        write_manifest(m)
        return True
    except Exception:
        return False


def clear_done(nid):
    """把该节点里状态为 done 的条目从任务池移除（「🧹 清已完成」按钮）。

    只动 done：pending / processing / failed 一律保留；磁盘文件不删。
    """
    try:
        m = read_manifest()
        b = m["nodes"].get(_norm_nid(nid))
        if b is not None:
            keep = []
            for q in (b.get("queue") or []):
                st = ((b.get("files") or {}).get(str(q)) or {}).get("status", "pending")
                if st == "done":
                    b["files"].pop(str(q), None)
                else:
                    keep.append(q)
            b["queue"] = keep
            write_manifest(m)
    except Exception:
        pass
    return True
