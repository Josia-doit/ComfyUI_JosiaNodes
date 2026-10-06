/**
 * Josia 包通用「文件夹选择器」浮层 —— 媒体保存 / 文本保存 共用同一份实现 + 同一套样式。
 * 本地文件名：folder_browser.js（不带 josia 前缀，符合本包命名规范）。
 *
 * 后端契约（两个节点各自注册同一组路由、返回同名字段，换前缀即可互换）：
 *   POST {base}/list_dirs   {path}          → {ok, path, parent, dirs:[{name,path}], shortcuts:[{name,path}]}
 *   POST {base}/create_dir  {parent, name}  → {ok, path}
 * 目录数据全部来自后端 os.scandir（零外部进程）；浮层由本文件渲染。
 *
 * 🔴 这里只做「选目录」，打开系统文件管理器走各自节点的 {base}/open_folder。
 */
import { api } from "../../../scripts/api.js";

/* ============================ 尺寸常量 / 样式 ============================ */
const ROW_H = 22;            // 控件行高（本包 22px 按钮规范）
const STYLE_ID = "josia-folder-browser-style";
const CSS = `
.jms-mask{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.5);
  display:flex;align-items:center;justify-content:center;}
.jms-panel{box-sizing:border-box;width:min(560px,86vw);max-height:74vh;display:flex;
  flex-direction:column;gap:8px;padding:12px;border-radius:8px;
  background:var(--base-background,#171718);color:var(--base-foreground,#fff);
  border:1px solid var(--border-default,#494a50);box-shadow:0 12px 40px rgba(0,0,0,.55);font-size:12px;}
.jms-panel-head{display:flex;align-items:center;justify-content:space-between;font-weight:600;}
.jms-panel-bar{display:flex;gap:6px;align-items:center;}
.jms-panel-bar input{flex:1 1 auto;min-width:80px;height:${ROW_H}px;box-sizing:border-box;padding:0 6px;
  border-radius:4px;border:1px solid var(--border-default,#494a50);
  background:rgba(128,128,128,.14);color:inherit;font-size:11px;}
.jms-panel-list{flex:1 1 auto;min-height:180px;max-height:44vh;overflow:auto;border-radius:6px;
  border:1px solid var(--border-default,#494a50);padding:3px;}
.jms-dir{padding:5px 8px;border-radius:4px;cursor:pointer;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;}
.jms-dir:hover{background:var(--secondary-background,#262729);}
.jms-chips{display:flex;flex-wrap:wrap;gap:6px;}
.jms-chip{padding:3px 9px;border-radius:999px;cursor:pointer;font-size:11px;
  border:1px solid var(--border-default,#494a50);background:rgba(128,128,128,.12);}
.jms-chip:hover{background:var(--secondary-background,#262729);}
.jms-panel-foot{display:flex;align-items:center;gap:8px;justify-content:space-between;}
.jms-panel-foot .cur{opacity:.72;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* 浮层内按钮沿用媒体保存面板那套 22px 胶囊控件 */
.jms-btn{border-radius:999px;cursor:pointer;white-space:nowrap;padding:0 10px;display:inline-flex;align-items:center;}
.jms-btn:hover{background:var(--secondary-background,rgba(128,128,128,.24));}
.jms-btn:disabled{opacity:.4;cursor:default;}
`;

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

/* ================================ 浮层 ================================ */
/**
 * @param {object}   opts
 * @param {string}   opts.base          后端路由前缀，如 "/josia_media_save" / "/josia_text_save"
 * @param {string}   [opts.initialPath] 初始定位目录（为空＝列驱动器 + 快捷入口）
 * @param {string}   [opts.title]       标题栏文案
 * @param {Array}    [opts.extraChips]  追加的快捷入口 [{name, path}]（只在顶层视图显示）
 * @param {Function} opts.onConfirm     选中目录后回调，参数为绝对路径
 */
export function openFolderBrowser(opts) {
    injectStyles();

    const base = opts?.base || "/josia_media_save";
    const extraChips = Array.isArray(opts?.extraChips) ? opts.extraChips : [];
    const onConfirm = typeof opts?.onConfirm === "function" ? opts.onConfirm : null;

    const mask = el("div", "jms-mask");
    const panel = el("div", "jms-panel");
    mask.appendChild(panel);
    document.body.appendChild(mask);

    mask.addEventListener("mousedown", (e) => { if (e.target === mask) close(); });

    let curPath = opts?.initialPath || "";
    let selPath = "";

    panel.innerHTML = `
    <div class="jms-panel-head"><span></span>
      <button type="button" class="jms-btn" data-act="close">✕</button></div>
    <div class="jms-chips" data-el="chips"></div>
    <div class="jms-panel-bar">
      <button type="button" class="jms-btn" data-act="up">⏫ 上级</button>
      <input type="text" data-el="path" placeholder="直接输入路径后回车，或留空列出驱动器">
      <button type="button" class="jms-btn" data-act="refresh">🔄</button>
      <button type="button" class="jms-btn" data-act="mkdir">📁 新建</button>
    </div>
    <div class="jms-panel-list" data-el="list"></div>
    <div class="jms-panel-foot">
      <span class="cur" data-el="cur"></span>
      <span style="display:flex;gap:6px;">
        <button type="button" class="jms-btn" data-act="cancel">取消</button>
        <button type="button" class="jms-btn" data-act="ok">选择此文件夹</button>
      </span>
    </div>`;

    panel.querySelector(".jms-panel-head span").textContent =
        opts?.title || "选择输出目录";

    const elQ = (n) => panel.querySelector(`[data-el="${n}"]`);
    const listEl = elQ("list");
    const chipsEl = elQ("chips");
    const pathEl = elQ("path");
    const curEl = elQ("cur");
    const okBtn = panel.querySelector('[data-act="ok"]');
    const upBtn = panel.querySelector('[data-act="up"]');

    function close() {
        document.removeEventListener("keydown", onKey);
        mask.remove();
    }
    function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); close(); }
    }

    function renderChips(shortcuts) {
        chipsEl.innerHTML = "";
        // extraChips（如「最近使用目录」）只在最顶层视图出现，进了子目录就撤掉
        const all = (curPath ? [] : (extraChips || []).concat(shortcuts || []));
        for (const s of all) {
            const c = el("span", "jms-chip", s.name);
            c.title = s.path;
            c.addEventListener("click", () => load(s.path));
            chipsEl.appendChild(c);
        }
    }
    function renderList(dirs, parent) {
        listEl.innerHTML = "";
        if (parent) {
            const up = el("div", "jms-dir", "⏫ ..");
            up.addEventListener("dblclick", () => load(parent));
            up.addEventListener("click", () => { clearTimeout(up._t); up._t = setTimeout(() => load(parent), 260); });
            listEl.appendChild(up);
        }
        for (const d of (dirs || [])) {
            const row = el("div", "jms-dir", "📁 " + d.name);
            row.title = d.path;
            row.addEventListener("dblclick", () => load(d.path));
            row.addEventListener("click", () => { clearTimeout(row._t); row._t = setTimeout(() => load(d.path), 260); });
            listEl.appendChild(row);
        }
        if (!dirs?.length && !parent) {
            const empty = el("div", "jms-dir", "（没有子目录）");
            empty.style.opacity = ".6";
            listEl.appendChild(empty);
        }
    }
    async function load(p) {
        try {
            const resp = await api.fetchApi(base + "/list_dirs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: p || "" }),
            });
            const data = await resp.json();
            if (!data.ok) { curEl.textContent = "读取失败：" + (data.error || resp.status); return; }
            curPath = data.path || "";
            selPath = curPath;
            pathEl.value = curPath;
            curEl.textContent = curPath || "（请选择驱动器）";
            upBtn.disabled = !curPath;
            renderChips(data.shortcuts);
            renderList(data.dirs, data.parent);
            okBtn.disabled = !curPath;
        } catch (e) { curEl.textContent = "读取失败：" + e; }
    }
    async function mkdir() {
        if (!curPath) return;
        const name = window.prompt("新文件夹名称：");
        if (!name) return;
        try {
            const resp = await api.fetchApi(base + "/create_dir", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parent: curPath, name }),
            });
            const data = await resp.json();
            if (!data.ok) { curEl.textContent = "新建失败：" + (data.error || resp.status); return; }
            load(data.path);
        } catch (e) { curEl.textContent = "新建失败：" + e; }
    }
    panel.addEventListener("click", (e) => {
        const act = e.target?.dataset?.act;
        if (!act) return;
        if (act === "close" || act === "cancel") close();
        else if (act === "up") load(curPath ? curPath.replace(/[\\/][^\\/]*$/, "") || curPath.replace(/[\\/]+$/, "") : "");
        else if (act === "refresh") load(curPath);
        else if (act === "mkdir") mkdir();
        else if (act === "ok") { if (curPath) { onConfirm?.(curPath); close(); } }
    });
    pathEl.addEventListener("keydown", (e) => { if (e.key === "Enter") load(pathEl.value.trim()); });
    document.addEventListener("keydown", onKey);
    load(curPath);
}
