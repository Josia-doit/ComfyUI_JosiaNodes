/**
 * JosiaTextSave 前端扩展 v1.22
 * 功能：内置文件夹浏览器（选择输出目录）、打开输出目录、复制输出路径、图像输入联动
 * 本地文件名：text_save.js
 * 匹配后端节点标识：JosiaTextSave
 *
 * 关于 Comfy Registry 安全扫描（2026-09-03 结论）：
 *   扫描器是「AI + 静态分析」黑盒，除官方明文禁令外还会标记一切像 RCE 的模式，
 *   以及「后端暴露目录操作接口」这类像任意文件读写的模式。
 *   实测：移除外部进程后 1.6.7 从 Banned 降级为 Flagged（人工复核），仍未被放行。
 *   项目决定功能优先，以 GitHub 直接分发为主渠道，不再为通过扫描而删减功能。
 *   故本文件保留「打开输出目录」（后端 os.startfile，标准库、非子进程）。
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const RECENT_KEY = "josia.text_save.recent_dirs";
const RECENT_MAX = 6;
const PLACEHOLDER = "\uD83D\uDCC1 请选择输出目录\u2026";   // 📁 请选择输出目录…

// ==================== 样式（一次性注入） ====================
const FB_STYLE_ID = "josia-folder-browser-style";

function injectStyles() {
    if (document.getElementById(FB_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = FB_STYLE_ID;
    style.textContent = `
.josia-fb-mask{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;
  justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(2px);}
.josia-fb-panel{width:min(620px,92vw);height:min(480px,86vh);display:flex;flex-direction:column;
  background:var(--comfy-menu-bg,#202020);color:var(--input-text,#ddd);border:1px solid #444;
  border-radius:6px;box-shadow:0 12px 40px rgba(0,0,0,.6);font-family:inherit;font-size:13px;}
.josia-fb-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;
  border-bottom:1px solid #3a3a3a;font-size:14px;font-weight:700;}
.josia-fb-x{background:transparent;border:none;color:#aaa;font-size:18px;line-height:1;
  cursor:pointer;padding:0 4px;}
.josia-fb-x:hover{color:#fff;}
.josia-fb-shortcuts{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px;border-bottom:1px solid #333;}
.josia-fb-chip{background:#2f2f2f;border:1px solid #454545;border-radius:4px;color:#cfcfcf;
  padding:3px 9px;font-size:12px;cursor:pointer;white-space:nowrap;}
.josia-fb-chip:hover{background:#3d3d3d;color:#fff;}
.josia-fb-bar{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid #333;}
.josia-fb-btn{background:#2f2f2f;border:1px solid #454545;border-radius:4px;color:#ddd;
  height:26px;padding:0 10px;font-size:12px;cursor:pointer;white-space:nowrap;}
.josia-fb-btn:hover:not(:disabled){background:#3d3d3d;color:#fff;}
.josia-fb-btn:disabled{opacity:.4;cursor:not-allowed;}
.josia-fb-path{flex:1;min-width:0;height:26px;background:#1a1a1a;color:#ddd;border:1px solid #454545;
  border-radius:4px;padding:0 8px;font-size:12px;font-family:monospace;outline:none;}
.josia-fb-path:focus{border-color:#6a8cff;}
.josia-fb-list{flex:1;overflow:auto;padding:4px 0;margin:0;}
.josia-fb-item{display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;
  user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.josia-fb-item:hover{background:#2c2c2c;}
.josia-fb-item.sel{background:#2b4d8a;color:#fff;}
.josia-fb-item .nm{overflow:hidden;text-overflow:ellipsis;}
.josia-fb-empty{padding:18px 12px;color:#888;text-align:center;font-size:12px;}
.josia-fb-newrow{display:flex;gap:6px;padding:6px 12px;}
.josia-fb-newrow input{flex:1;height:24px;background:#1a1a1a;color:#ddd;border:1px solid #6a8cff;
  border-radius:4px;padding:0 8px;font-size:12px;outline:none;}
.josia-fb-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:10px 12px;border-top:1px solid #3a3a3a;}
.josia-fb-current{flex:1;min-width:0;color:#9fd0a0;font-size:12px;font-family:monospace;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.josia-fb-ok{background:#2b6cb0;border-color:#3b82c4;color:#fff;font-weight:600;}
.josia-fb-ok:hover{background:#3182ce;}
`;
    document.head.appendChild(style);
}

// ==================== 最近使用目录 ====================
function getRecentDirs() {
    try {
        const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
        return Array.isArray(raw) ? raw.filter(p => typeof p === "string") : [];
    } catch (e) {
        return [];
    }
}

function pushRecentDir(path) {
    if (!path) return;
    const list = getRecentDirs().filter(p => p !== path);
    list.unshift(path);
    try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
    } catch (e) { /* 隐私模式下 localStorage 可能不可写，静默降级 */ }
}

// ==================== 后端目录服务 ====================
async function fetchDirs(path) {
    const res = await api.fetchApi("/josia_text_save/list_dirs", {
        method: "POST",
        body: JSON.stringify({ path: path || "" }),
    });
    return await res.json();
}

async function createDir(parent, name) {
    const res = await api.fetchApi("/josia_text_save/create_dir", {
        method: "POST",
        body: JSON.stringify({ parent, name }),
    });
    return await res.json();
}

async function openFolderInShell(path) {
    const res = await api.fetchApi("/josia_text_save/open_folder", {
        method: "POST",
        body: JSON.stringify({ path: path || "" }),
    });
    return await res.json();
}

// ==================== 文件夹浏览器浮层 ====================
function openFolderBrowser(initialPath, onConfirm) {
    injectStyles();

    let curPath = initialPath || "";
    let selected = initialPath || "";

    const mask = document.createElement("div");
    mask.className = "josia-fb-mask";

    const panel = document.createElement("div");
    panel.className = "josia-fb-panel";

    // ── 标题栏 ──
    const head = document.createElement("div");
    head.className = "josia-fb-head";
    const title = document.createElement("span");
    title.textContent = "\uD83D\uDCC1 选择输出文件夹";
    const closeX = document.createElement("button");
    closeX.className = "josia-fb-x";
    closeX.textContent = "\u00d7";
    closeX.title = "关闭 (Esc)";
    head.append(title, closeX);

    // ── 快捷入口 ──
    const shortcuts = document.createElement("div");
    shortcuts.className = "josia-fb-shortcuts";

    // ── 工具栏 ──
    const bar = document.createElement("div");
    bar.className = "josia-fb-bar";
    const upBtn = document.createElement("button");
    upBtn.className = "josia-fb-btn";
    upBtn.textContent = "\u2b06 上级";
    upBtn.title = "返回上一级目录";
    const pathInput = document.createElement("input");
    pathInput.className = "josia-fb-path";
    pathInput.spellcheck = false;
    pathInput.placeholder = "在此输入完整路径后回车跳转";
    const refreshBtn = document.createElement("button");
    refreshBtn.className = "josia-fb-btn";
    refreshBtn.textContent = "\uD83D\uDD04";
    refreshBtn.title = "刷新";
    const newBtn = document.createElement("button");
    newBtn.className = "josia-fb-btn";
    newBtn.textContent = "\uD83D\uDCC2 新建";
    newBtn.title = "在当前目录下新建文件夹";
    bar.append(upBtn, pathInput, refreshBtn, newBtn);

    // ── 目录列表 ──
    const listEl = document.createElement("div");
    listEl.className = "josia-fb-list";

    // ── 底栏 ──
    const foot = document.createElement("div");
    foot.className = "josia-fb-foot";
    const curLabel = document.createElement("span");
    curLabel.className = "josia-fb-current";
    const footBtns = document.createElement("div");
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "josia-fb-btn";
    cancelBtn.textContent = "取消";
    const okBtn = document.createElement("button");
    okBtn.className = "josia-fb-btn josia-fb-ok";
    okBtn.textContent = "选择此文件夹";
    footBtns.append(cancelBtn, okBtn);
    foot.append(curLabel, footBtns);

    panel.append(head, shortcuts, bar, listEl, foot);
    mask.appendChild(panel);
    document.body.appendChild(mask);

    // ── 渲染逻辑 ──
    function setSelected(p) {
        selected = p;
        curLabel.textContent = p || "（未选择）";
        curLabel.style.color = p ? "#9fd0a0" : "#888";
    }

    function buildShortcuts(items, recents) {
        shortcuts.textContent = "";
        const all = (items || []).concat(
            (recents || []).map(p => ({ name: "\u23F3 " + p, path: p }))
        );
        if (!all.length) {
            shortcuts.style.display = "none";
            return;
        }
        shortcuts.style.display = "flex";
        all.forEach(item => {
            const chip = document.createElement("button");
            chip.className = "josia-fb-chip";
            chip.textContent = item.name;
            chip.title = item.path;
            chip.onclick = () => { curPath = item.path; setSelected(item.path); load(); };
            shortcuts.appendChild(chip);
        });
    }

    async function load() {
        listEl.textContent = "";
        pathInput.value = curPath || "";
        upBtn.disabled = !curPath;

        const loading = document.createElement("div");
        loading.className = "josia-fb-empty";
        loading.textContent = "读取中\u2026";
        listEl.appendChild(loading);

        let data;
        try {
            data = await fetchDirs(curPath);
        } catch (e) {
            listEl.textContent = "";
            const err = document.createElement("div");
            err.className = "josia-fb-empty";
            err.textContent = "读取失败：" + e;
            listEl.appendChild(err);
            return;
        }

        if (!data || !data.ok) {
            listEl.textContent = "";
            const err = document.createElement("div");
            err.className = "josia-fb-empty";
            err.textContent = (data && data.error) ? data.error : "目录不可访问";
            listEl.appendChild(err);
            upBtn.disabled = !curPath;
            return;
        }

        buildShortcuts(data.shortcuts, data.path ? [] : getRecentDirs());

        listEl.textContent = "";
        const dirs = data.dirs || [];
        if (!dirs.length) {
            const empty = document.createElement("div");
            empty.className = "josia-fb-empty";
            empty.textContent = curPath ? "（此目录下没有子文件夹）" : "（未找到可用磁盘）";
            listEl.appendChild(empty);
            return;
        }

        dirs.forEach(d => {
            const row = document.createElement("div");
            row.className = "josia-fb-item" + (d.path === selected ? " sel" : "");
            const icon = document.createElement("span");
            icon.textContent = "\uD83D\uDCC1";
            const nm = document.createElement("span");
            nm.className = "nm";
            nm.textContent = d.name;          // 用 textContent，避免目录名被当作 HTML 解析
            nm.title = d.path;
            row.append(icon, nm);

            row.onclick = () => {
                listEl.querySelectorAll(".josia-fb-item.sel")
                    .forEach(el => el.classList.remove("sel"));
                row.classList.add("sel");
                setSelected(d.path);
            };
            row.ondblclick = () => { curPath = d.path; setSelected(d.path); load(); };
            listEl.appendChild(row);
        });
    }

    // ── 新建文件夹（内联输入行，不用 window.prompt）──
    function startCreate() {
        if (!curPath) return;
        if (listEl.querySelector(".josia-fb-newrow")) return;

        const row = document.createElement("div");
        row.className = "josia-fb-newrow";
        const input = document.createElement("input");
        input.placeholder = "输入新文件夹名称，回车确认 / Esc 取消";
        const ok = document.createElement("button");
        ok.className = "josia-fb-btn josia-fb-ok";
        ok.textContent = "创建";
        const cancel = document.createElement("button");
        cancel.className = "josia-fb-btn";
        cancel.textContent = "取消";
        row.append(input, ok, cancel);
        listEl.insertBefore(row, listEl.firstChild);
        input.focus();

        const cleanup = () => { row.remove(); };
        const submit = async () => {
            const name = (input.value || "").trim();
            if (!name) { cleanup(); return; }
            const r = await createDir(curPath, name);
            cleanup();
            if (r && r.ok) {
                curPath = r.path;
                setSelected(r.path);
            } else {
                alert((r && r.error) || "创建失败");
            }
            load();
        };

        input.onkeydown = (e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
            else if (e.key === "Escape") { e.preventDefault(); cleanup(); }
        };
        ok.onclick = submit;
        cancel.onclick = cleanup;
    }

    // ── 事件绑定 ──
    function close() {
        document.removeEventListener("keydown", onKey);
        mask.remove();
    }
    function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); close(); }
    }

    closeX.onclick = close;
    cancelBtn.onclick = close;
    mask.onclick = (e) => { if (e.target === mask) close(); };
    document.addEventListener("keydown", onKey);

    upBtn.onclick = async () => {
        if (!curPath) return;
        const r = await fetchDirs(curPath);
        const parent = (r && r.ok) ? (r.parent || "") : "";
        curPath = parent;
        setSelected(parent);
        load();
    };
    refreshBtn.onclick = load;
    newBtn.onclick = startCreate;
    pathInput.onkeydown = async (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const p = (pathInput.value || "").trim();
        curPath = p;
        setSelected(p);
        load();
    };
    okBtn.onclick = () => {
        if (!selected) return;
        pushRecentDir(selected);
        onConfirm(selected);
        close();
    };

    setSelected(initialPath || "");
    load();
}

// ==================== 提示 ====================
function toast(severity, summary, detail) {
    try {
        if (app?.extensionManager?.toast?.add) {
            app.extensionManager.toast.add({ severity, summary, detail, life: 4000 });
        }
    } catch (e) { /* toast 不可用时静默降级 */ }
}

// ==================== 扩展注册 ====================
app.registerExtension({
    name: "JosiaNodes.JosiaTextSave",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "JosiaTextSave") return;

        const keywords = ["文本保存", "text save", "save text to file",
            "保存文本", "写入文件", "保存文件", "输出文本", "文件夹", "folder"];
        if (!nodeType.searchKeywords) nodeType.searchKeywords = [];
        if (Array.isArray(nodeType.searchKeywords)) {
            keywords.forEach(k => {
                if (!nodeType.searchKeywords.includes(k)) nodeType.searchKeywords.push(k);
            });
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;

            const getPathWidget = () => node.widgets.find(w => w.name === "output_path");
            const currentPath = () => {
                const w = getPathWidget();
                const v = (w?.value || "").trim();
                return (!v || v === PLACEHOLDER) ? "" : v;
            };

            // ── 选择输出目录按钮（内置文件夹浏览器浮层）──
            // 说明：不使用系统对话框 / 子进程（会触发 Comfy Registry 安全扫描导致版本被封禁）。
            // 目录数据来自后端 os.scandir，浮层由本文件渲染，支持快捷入口/上级/新建/最近使用。
            const folderBtn = node.addWidget("button", "选择输出目录", "", () => {
                openFolderBrowser(currentPath(), (p) => {
                    const w = getPathWidget();
                    if (!w) return;
                    w.value = p;
                    if (w.inputEl) w.inputEl.value = p;
                    node.setDirtyCanvas(true, true);
                });
            }, { tooltip: "打开内置文件夹浏览器，选择文件保存目录" });
            // 关键：按钮不参与序列化（保存/加载两端都跳过 serialize===false），
            // 这样无论放在节点顶部还是底部，都不会挤动下面字段的 widgets_values 对齐顺序
            folderBtn.serialize = false;

            // ── 打开输出目录按钮 ──
            // 后端用 os.startfile（Python 标准库，非子进程）唤起系统文件管理器。
            // 非 Windows 平台后端返回 not_supported，此处引导改用「复制路径」。
            const openBtn = node.addWidget("button", "打开输出目录", "", async () => {
                const p = currentPath();
                if (!p) {
                    toast("warn", "输出路径为空", "请先选择或输入输出目录");
                    return;
                }
                try {
                    const data = await openFolderInShell(p);
                    if (data?.ok) {
                        toast("success", "已打开输出目录", p);
                    } else if (data?.error === "not_supported") {
                        toast("info", "当前平台不支持直接打开", "请改用「复制路径」后在文件管理器中粘贴");
                    } else {
                        toast("warn", "打开失败", data?.error || "目录不存在或不可访问");
                    }
                } catch (e) {
                    toast("error", "打开失败", String(e));
                }
            }, { tooltip: "在系统文件管理器中打开当前输出目录" });
            openBtn.serialize = false;

            // ── 复制路径按钮 ──
            // 与「打开输出目录」并存：非 Windows 平台、或需要把路径贴到别处时使用。
            const copyBtn = node.addWidget("button", "复制路径", "", async () => {
                const p = currentPath();
                if (!p) {
                    toast("warn", "输出路径为空", "请先选择或输入输出目录");
                    return;
                }
                let copied = false;
                try {
                    if (navigator.clipboard?.writeText) {
                        await navigator.clipboard.writeText(p);
                        copied = true;
                    }
                } catch (e) {
                    copied = false;
                }
                if (copied) {
                    toast("success", "路径已复制", p);
                } else {
                    // 降级：选中输入框内容，由用户手动 Ctrl+C（不调用已废弃的剪贴板命令接口）
                    const w = getPathWidget();
                    try {
                        if (w?.inputEl) { w.inputEl.focus(); w.inputEl.select(); }
                        else if (w?.element) { w.element.focus(); }
                    } catch (e) { /* ignore */ }
                    toast("info", "已选中路径", "请按 Ctrl + C 复制");
                }
            }, { tooltip: "复制当前输出路径到剪贴板" });
            copyBtn.serialize = false;

            // ── 重新排布 widget 顺序（同步执行，避免异步时机导致保存/加载错位）──
            // 目标顺序：文本内容 → [选择输出目录按钮] → 输出路径 → 文件名 → 保存格式
            //           → [打开输出目录按钮] → [复制路径按钮]
            // 三个按钮均 serialize=false，保存/加载两端对称跳过，插入到中部也不会挤动其它字段对齐
            const w = node.widgets;
            const _remove = (x) => { const i = w.indexOf(x); if (i !== -1) w.splice(i, 1); };
            _remove(folderBtn);
            _remove(copyBtn);
            _remove(openBtn);

            const _idx = (name) => w.findIndex(x => x.name === name);
            const iText = _idx("text");
            if (iText !== -1) w.splice(iText + 1, 0, folderBtn);   // 选择输出目录按钮紧跟文本内容
            const iExt = _idx("file_extension");
            // 先插后者再插前者，最终顺序才是「打开输出目录 → 复制路径」
            if (iExt !== -1) w.splice(iExt + 1, 0, copyBtn);       // 复制路径按钮排在最后
            if (iExt !== -1) w.splice(iExt + 1, 0, openBtn);       // 打开输出目录按钮紧跟保存格式

            // ── 图像输入联动 ──
            const fileNameW = node.widgets.find(w => w.name === "file_name");

            function syncFileNameEditable() {
                const hasImage = node.inputs && node.inputs.some(
                    inp => inp.name === "image" && inp.link !== null
                );
                if (fileNameW) fileNameW.disabled = hasImage;
                if (fileNameW && fileNameW.inputEl) {
                    fileNameW.inputEl.disabled = hasImage;
                    fileNameW.inputEl.style.opacity = hasImage ? "0.4" : "1";
                }
                node.setDirtyCanvas(true, true);
            }
            syncFileNameEditable();

            const origOnConnectionsChange = node.onConnectionsChange;
            node.onConnectionsChange = function (type, slotIndex, isConnected, linkInfo, slotInfo) {
                if (origOnConnectionsChange) origOnConnectionsChange.apply(this, arguments);
                if (type === 1 && node.inputs && node.inputs[slotIndex]) {
                    if (node.inputs[slotIndex].name === "image") syncFileNameEditable();
                }
            };
        };
    },
});
