/**
 * JosiaTextSave 前端扩展 v1.23
 * 功能：Windows 原生「选择文件夹」对话框（选择输出目录，不可用时退回内置浏览器）、
 *      打开输出目录、图像输入联动
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
// 🔴 内置文件夹浏览器浮层与「Josia媒体保存」共用同一份实现 + 同一套样式：
//    web/js/folder_browser.js（仅在原生对话框不可用时作为兜底）。
import { openFolderBrowser } from "./folder_browser.js";

const RECENT_KEY = "josia.text_save.recent_dirs";
const RECENT_MAX = 6;
const PLACEHOLDER = "\uD83D\uDCC1 请选择输出目录\u2026";   // 📁 请选择输出目录…

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

// ==================== 打开系统文件管理器 ====================
async function openFolderInShell(path) {
    const res = await api.fetchApi("/josia_text_save/open_folder", {
        method: "POST",
        body: JSON.stringify({ path: path || "" }),
    });
    return await res.json();
}

// 取路径里的「目录部分」（原生对话框的初始目录；相对路径也照样传）
function dirOf(p) {
    const s = String(p || "").replace(/[\\/]+$/, "");
    const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i > 0 ? s.slice(0, i) : "";
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

            // ── 选择输出目录按钮 ──
            // 与「Josia媒体保存」一致：优先弹 **Windows 原生「选择文件夹」对话框**
            // （后端 native_picker 用 ctypes 直调 shell32，进程内完成、零外部进程）；
            // 非 Windows / 调用失败 ⇒ 自动退回内置文件夹浏览器
            // （web/js/folder_browser.js，与媒体保存同一套实现与样式）。
            const applyPicked = (p) => {
                const w = getPathWidget();
                if (!w) return;
                w.value = p;
                pushRecentDir(p);
                if (w.inputEl) w.inputEl.value = p;
                node.setDirtyCanvas(true, true);
            };
            // true ＝ 原生对话框已接管（选中或用户取消），false ＝ 需要弹内置兜底浏览器
            const pickViaNative = async () => {
                try {
                    const resp = await api.fetchApi("/josia_text_save/pick_dir", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ title: "选择输出目录", initial: dirOf(currentPath()) }),
                    });
                    const data = await resp.json().catch(() => ({}));
                    if (resp.ok && data?.ok && data.path) { applyPicked(data.path); return true; }
                    if (data?.error === "cancelled") return true;
                } catch { /* 接口异常 ⇒ 落到下面的内置兜底 */ }
                return false;
            };

            const folderBtn = node.addWidget("button", "选择输出目录", "", async () => {
                if (await pickViaNative()) return;
                openFolderBrowser({
                    base: "/josia_text_save",
                    initialPath: currentPath(),
                    title: "选择输出目录",
                    extraChips: getRecentDirs().map((p) => ({ name: "\u23F3 " + p, path: p })),
                    onConfirm: applyPicked,
                });
            }, { tooltip: "打开系统「选择文件夹」窗口；不可用时改用内置文件夹浏览器" });
            // 关键：按钮不参与序列化（保存/加载两端都跳过 serialize===false），
            // 这样无论放在节点顶部还是底部，都不会挤动下面字段的 widgets_values 对齐顺序
            folderBtn.serialize = false;

            // ── 打开输出目录按钮 ──
            // 后端用 os.startfile（Python 标准库，非子进程）唤起系统文件管理器。
            // 非 Windows 平台后端返回 not_supported，此处提示直接看「选择输出目录」选出的路径。
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
                        toast("info", "当前平台不支持直接打开", "当前输出目录：" + p);
                    } else {
                        toast("warn", "打开失败", data?.error || "目录不存在或不可访问");
                    }
                } catch (e) {
                    toast("error", "打开失败", String(e));
                }
            }, { tooltip: "在系统文件管理器中打开当前输出目录" });
            openBtn.serialize = false;

            // ── 重新排布 widget 顺序（同步执行，避免异步时机导致保存/加载错位）──
            // 目标顺序：文本内容 → [选择输出目录按钮] → 输出路径 → 文件名 → 保存格式
            //           → [打开输出目录按钮]
            // 两个按钮均 serialize=false，保存/加载两端对称跳过，插入到中部也不会挤动其它字段对齐
            const w = node.widgets;
            const _remove = (x) => { const i = w.indexOf(x); if (i !== -1) w.splice(i, 1); };
            _remove(folderBtn);
            _remove(openBtn);

            const _idx = (name) => w.findIndex(x => x.name === name);
            const iText = _idx("text");
            if (iText !== -1) w.splice(iText + 1, 0, folderBtn);   // 选择输出目录按钮紧跟文本内容
            const iExt = _idx("file_extension");
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
