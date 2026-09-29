/* ============================================================================
 * JosiaNodes · Josia加载Latent   前端 UI（批量调度器 · Node 1.0 优先）
 * 同名节点＝JosiaLoadLatent（load_latent.py）。
 *
 * 面板布局（从上到下）：
 *   行1（置顶）：Latent缩放开关 · 缩放比例（窄·两位小数） · 对齐倍数（宽）
 *               ↳ 开关关闭时后两个仅「灰化」，不再隐藏
 *   行2：📁 选择文件（多文件） · 🗑 清空列表 · 🔄 重置进度
 *   信息窗（节点最下方，随内容撑高）：
 *     ┌─ 上方区：当前 Latent 文件详情（多列网格，点列表项即切换）
 *     ├─ 分割线
 *     ├─ 状态区：任务池 / 已完成 / 解码中 / 失败 计数
 *     ├─ 分割线
 *     └─ 文件列表区：可点选，含分辨率 + 体积 + 状态徽标
 *
 * 尺寸铁律（哥哥实测踩坑后定死）：
 *   · grow() 用**解析式**算目标高（固定行高常量 + 信息窗内容高 scrollHeight），绝不量
 *     root.offsetHeight —— 那个值会被 DOM 容器钳到「节点当前高度」，量出偏小
 *     ⇒ setSize 越改越矮，点一下缩一行、最后只剩端口。
 *   · 高度完全归信息窗管：节点高＝内容需要的总高，每次 grow 双向校正（可增可减）；
 *     用户拖拽只改宽度（onResize 把高度拔回 _targetH），宽度有 MIN_W 下限
 *     （＝三列信息完整不折叠），信息窗永远不出现滚动条。
 *
 * 互斥：Latent 输入端口连线 ⇒ 文件相关按钮全部灰化（透传模式，忽略任务池）。
 * ========================================================================== */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const EXT_NAME = "JosiaNodes.JosiaLoadLatent";
const STYLE_ID = "josia-load-latent-test-style";
// 🔴 全局执行收尾钩子只挂一次（所有本节点实例共用）：进度回写发生在**媒体保存节点**
//    执行时，加载节点自己回传的 ui 快照会比它早一步（停在「解码中」）——
//    整个工作流跑完 / 被打断后再统一补刷一次面板，done 徽标立刻跟上。
let _execHooked = false;
const ROW_H = 22;
const PAD = 6;
const ROW_GAP = 6;
const PLACEHOLDER = "🎞️ 请选择 .latent 文件…";
// 🔴 最小宽度＝信息窗三列 key-val（文件名/文件类型/数据类型 · 分辨率/文件大小/VAE）
//    完整显示不折叠的实测宽度；宽度可手动调大，绝不允许低于它。高度不归用户管（只跟随信息窗）。
//    不折叠的实测宽度；宽度可手动调大，绝不允许低于它。高度不归用户管（只跟随信息窗）。
const DEF_W = 640;
const DEF_H = 260;
const MIN_W = 640;
const MIN_H = 120;

const CSS = `
.jlc-root{box-sizing:border-box;width:100%;padding:${PAD}px;display:flex;flex-direction:column;
  gap:${ROW_GAP}px;font-size:11px;line-height:1.25;color:inherit;
  max-height:none;overflow-y:hidden;overflow-x:hidden;
  pointer-events:none;user-select:none;-webkit-user-select:none;}
.jlc-root input,.jlc-root textarea,.jlc-root button,
.jlc-root .jlc-btn,.jlc-root .jlc-numwrap,.jlc-root .jlc-drop,
.jlc-root .jlc-dot,.jlc-root .jlc-info,.jlc-root .jlc-batch{pointer-events:auto;}
.jlc-root .jlc-drop.disabled{pointer-events:none;}
div.dom-widget:has(> .jlc-root){pointer-events:none !important;}
.jlc-root input,.jlc-root textarea{user-select:text;-webkit-user-select:text;}
.jlc-root>*{flex:0 0 auto;}
.jlc-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;}
.jlc-drop,.jlc-numwrap,.jlc-dot,.jlc-btn{height:${ROW_H}px;box-sizing:border-box;border-radius:999px;
  border:1px solid var(--border-default,rgba(128,128,128,.5));
  background:var(--base-background,rgba(20,20,22,.92));color:var(--base-foreground,inherit);font-size:11px;}
.jlc-drop,.jlc-numwrap,.jlc-dot{display:inline-flex;align-items:center;}
.jlc-btn{cursor:pointer;white-space:nowrap;padding:0 10px;display:inline-flex;align-items:center;}
.jlc-btn:hover{background:var(--secondary-background,rgba(128,128,128,.24));}
.jlc-btn:disabled{opacity:.4;cursor:default;}
.jlc-btn.danger{color:#ff9b9b;border-color:rgba(220,80,80,.5);}
.jlc-drop{padding:0 4px 0 7px;gap:5px;cursor:pointer;position:relative;flex:0 0 auto;white-space:nowrap;}
.jlc-drop.disabled{opacity:.45;pointer-events:none;}
.jlc-drop-lab{flex:0 0 auto;opacity:.55;font-size:10px;white-space:nowrap;}
.jlc-drop-btn{flex:0 0 auto;border:none;background:none;color:inherit;text-align:left;font:inherit;
  outline:none;white-space:nowrap;cursor:pointer;padding:0;}
.jlc-caret{margin-left:auto;opacity:.6;font-size:9px;padding-left:3px;flex:0 0 auto;cursor:pointer;}
.jlc-overlay{position:fixed;inset:0;z-index:99998;}
.jlc-menu{position:fixed;z-index:99999;box-sizing:border-box;padding:4px;border-radius:6px;
  background:var(--base-background,#171718);color:var(--base-foreground,#fff);
  border:1px solid var(--border-default,#494a50);box-shadow:0 6px 24px rgba(0,0,0,.5);
  max-height:60vh;overflow:auto;font-size:11px;min-width:120px;}
.jlc-menu-item{padding:5px 10px;border-radius:4px;cursor:pointer;white-space:nowrap;opacity:.92;}
.jlc-menu-item:hover{background:var(--secondary-background,#262729);}
.jlc-menu-item.on{background:var(--primary-background,#3d6ea8);color:#fff;font-weight:600;opacity:1;}
.jlc-in-lab{flex:0 0 auto;opacity:.55;font-size:10px;padding:0 4px 0 7px;white-space:nowrap;}
.jlc-numwrap input{border:none;background:transparent;color:inherit;font:inherit;text-align:right;
  width:42px;padding:0 2px;outline:none;-moz-appearance:textfield;appearance:textfield;}
.jlc-numwrap input::-webkit-outer-spin-button,
.jlc-numwrap input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;display:none;}
.jlc-numwrap.disabled{opacity:.45;pointer-events:none;}
.jlc-num-step{flex:0 0 auto;width:15px;border:none;background:transparent;color:inherit;cursor:pointer;
  font-size:9px;opacity:.6;padding:0;}
.jlc-dot{gap:6px;padding:0 11px;cursor:pointer;flex:0 0 auto;width:104px;justify-content:center;overflow:hidden;}
.jlc-dot-txt{opacity:.85;font-size:10px;white-space:nowrap;}
.jlc-dot-mark{width:10px;height:10px;border-radius:50%;border:2px solid var(--primary-background,#3d6ea8);
  box-sizing:border-box;background:transparent;transition:background .12s,border-color .12s;}
.jlc-dot.on .jlc-dot-mark{background:var(--primary-background,#3d6ea8);}
.jlc-dot.on .jlc-dot-txt{opacity:1;font-weight:600;}
/* 🔴 信息窗＝三区（置于节点最下方，整体随内容撑高）
 * 🔴 绝不出现滚动条：overflow 一律 hidden，高度由 grow() 跟随内容撑到位 ——
 *    节点高度被锁死为「内容需要的高度」，永远不会出现装不下要内滚的局面。 */
.jlc-batch{box-sizing:border-box;min-height:30px;padding:5px 7px;border-radius:6px;border:1px solid #333;
  background:#000;color:#e6e6e6;font-size:10px;line-height:1.5;display:flex;flex-direction:column;gap:5px;
  overflow:hidden;}
.jlc-batch.disabled{opacity:.55;pointer-events:none;}
/* 🔴 上方区：**固定 3 列 × 2 行**（每列＝一对 key-val 同行显示）：
 *    第 1 行 文件名 / 文件类型 / 数据类型，第 2 行 分辨率 / 文件大小 / VAE。
 *    值不换行（nowrap + 溢出省略），配合节点最小宽度保证三列完整不折叠。 */
.jlc-info-top{display:grid;grid-template-columns:auto minmax(0,1fr) auto minmax(0,1fr) auto minmax(0,1fr);
  gap:2px 10px;align-items:baseline;}
.jlc-info-key{opacity:.55;white-space:nowrap;}
.jlc-info-val{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.jlc-info-val.err{color:#ffb4b4;}
.jlc-divider{height:1px;background:rgba(128,128,128,.3);margin:1px 0;flex:0 0 auto;}
.jlc-batch-head{display:flex;align-items:center;gap:8px;font-weight:600;opacity:.95;flex:0 0 auto;flex-wrap:wrap;}
.jlc-batch-head .jlc-batch-count{font-weight:700;color:#fff;}
.jlc-batch-list{display:flex;flex-direction:column;gap:2px;}
.jlc-batch-empty{opacity:.6;padding:4px 2px;white-space:pre-wrap;word-break:break-all;}
.jlc-batch-item{display:flex;align-items:center;gap:7px;min-width:0;cursor:pointer;padding:2px 3px;border-radius:4px;}
.jlc-batch-item:hover{background:rgba(255,255,255,.06);}
.jlc-batch-item.on{background:rgba(61,110,168,.28);}
.jlc-batch-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.jlc-batch-res{flex:0 0 auto;opacity:.6;font-variant-numeric:tabular-nums;white-space:nowrap;}
.jlc-batch-size{flex:0 0 auto;opacity:.6;font-variant-numeric:tabular-nums;white-space:nowrap;}
.jlc-batch.cur .jlc-batch-name::before{content:"▶ ";opacity:.7;}
.jlc-badge{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
  min-width:50px;height:15px;padding:0 6px;border-radius:999px;font-size:9px;font-weight:600;
  border:1px solid transparent;}
.jlc-badge.done{background:rgba(60,180,90,.18);color:#7ee29a;border-color:rgba(60,180,90,.5);}
.jlc-badge.processing{background:rgba(61,110,168,.22);color:#9ec6f0;border-color:rgba(61,110,168,.6);}
.jlc-badge.failed{background:rgba(220,80,80,.18);color:#ff9b9b;border-color:rgba(220,80,80,.55);}
.jlc-badge.pending{background:rgba(140,140,140,.15);color:#bdbdbd;border-color:rgba(140,140,140,.4);}
/* 列表行尾「✕」：单文件移除（磁盘文件保留） */
.jlc-batch-x{flex:0 0 auto;width:16px;height:16px;border:none;border-radius:50%;background:transparent;
  color:inherit;opacity:.4;cursor:pointer;font-size:11px;line-height:1;padding:0;
  display:inline-flex;align-items:center;justify-content:center;}
.jlc-batch-x:hover{opacity:1;background:rgba(220,80,80,.28);color:#ff9b9b;}
.jlc-inf-status{opacity:.85;white-space:pre-wrap;word-break:break-all;flex:0 0 auto;}
.jlc-inf-status.err{color:#ffb4b4;opacity:1;}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ============================== 基础工具 ============================== */
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};
const getWidget = (node, name) => node.widgets?.find((w) => w.name === name);

function comboValues(widget) {
  try {
    let vals = widget?.options?.values;
    if (typeof vals === "function") vals = vals(widget, app?.graph ?? null);
    if (!Array.isArray(vals)) return [];
    return vals.map((v) => String((v && typeof v === "object") ? v.value : v));
  } catch (e) { return []; }
}

function setWidgetValue(node, w, v) {
  if (!w) return;
  try {
    if (typeof w.setValue === "function") w.setValue(v);
    else w.value = v;
  } catch (e) {
    w.value = v;
  }
  try { app.graph?.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
}

function humanSize(b) {
  b = Number(b) || 0;
  if (b < 1024) return b + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1, n = b;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(2) + " " + u[i];
}

/* ============================ 下拉浮层 + 遮罩 ============================ */
let _openLayer = null;
let _openOverlay = null;

function closeMenu() {
  if (_openLayer) { _openLayer.remove(); _openLayer = null; }
  if (_openOverlay) { _openOverlay.remove(); _openOverlay = null; }
}
window.addEventListener("blur", closeMenu);
document.addEventListener("wheel", closeMenu, { passive: true, capture: true });

function mkDrop(node, widget, { width, label, items = null, onChange = null,
                               emptyText = "（无可用选项）" } = {}) {
  const wrap = el("div", "jlc-drop");
  if (label) wrap.appendChild(el("span", "jlc-drop-lab", label));
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "jlc-drop-btn";
  wrap.appendChild(btn);
  wrap.appendChild(el("span", "jlc-caret", "▾"));

  const listItems = () => {
    const raw = items ? items() : [];
    return raw.map((v) => {
      const value = (v && typeof v === "object") ? v.value : v;
      const lb = (v && typeof v === "object") ? v.label : String(v);
      return { value, label: lb };
    });
  };
  const sync = () => {
    const cur = String(widget?.value ?? "");
    const hit = listItems().find((it) => String(it.value) === cur);
    btn.textContent = hit ? hit.label : cur;
  };

  function openMenu() {
    closeMenu();
    const overlay = el("div", "jlc-overlay");
    const layer = el("div", "jlc-menu");
    const cur = String(widget?.value ?? "");
    const itemsNow = listItems();
    if (!itemsNow.length) {
      const empty = el("div", "jlc-menu-item", emptyText);
      empty.style.opacity = ".6";
      empty.style.cursor = "default";
      layer.appendChild(empty);
    }
    for (const it of itemsNow) {
      const sel = String(it.value) === cur;
      const row = el("div", "jlc-menu-item" + (sel ? " on" : ""), it.label);
      row.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setWidgetValue(node, widget, it.value);
        closeMenu();
        sync();
        onChange ? onChange(it.value) : node._jllRefresh?.();
      });
      layer.appendChild(row);
    }
    overlay.appendChild(layer);
    document.body.appendChild(overlay);
    _openLayer = layer;
    _openOverlay = overlay;
    const r = wrap.getBoundingClientRect();
    const mh = layer.offsetHeight;
    const mw = layer.offsetWidth;
    let top = r.bottom + 2;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 2);
    layer.style.top = top + "px";
    layer.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + "px";
    layer.style.minWidth = Math.max(r.width, 120) + "px";
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) closeMenu(); });
  }

  let _owner = null;
  let _openedAt = 0;
  const toggle = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 🔴 灰化状态（关闭缩放）下点不动
    if (wrap.classList.contains("disabled")) return;
    if (_openLayer) {
      if (_owner === wrap && Date.now() - _openedAt < 500) return;
      closeMenu();
      return;
    }
    _owner = wrap;
    _openedAt = Date.now();
    try { openMenu(); } catch (err) {
      try { console.error("[Josia加载Latent] 下拉打开失败：", err); } catch (e2) {}
    }
  };
  wrap.addEventListener("pointerdown", toggle);
  wrap.addEventListener("click", toggle);

  if (width) wrap.style.width = width + "px";
  wrap.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  try { sync(); } catch (e) { /* 忽略 */ }
  return { el: wrap, sync, isDisabled: () => wrap.classList.contains("disabled") };
}

/* ============================== 数字输入 ============================== */
function mkNumber(node, widget, { width, label, step = 1, min, max, decimals = null } = {}) {
  const wrap = el("div", "jlc-numwrap");
  if (label) wrap.appendChild(el("span", "jlc-in-lab", label));
  const inp = document.createElement("input");
  inp.type = "number";
  const o = widget?.options || {};
  const mn = (min !== undefined) ? min : o.min;
  const mx = (max !== undefined) ? max : o.max;
  if (mn !== undefined) inp.min = mn;
  if (mx !== undefined) inp.max = mx;
  const FACTOR = decimals != null ? Math.pow(10, decimals) : 1;
  const round = (x) => Math.round((x + Number.EPSILON) * FACTOR) / FACTOR;
  const fmt = (x) => (decimals != null ? Number(x).toFixed(decimals)
                                 : String(round(Number(x) || 0)));
  inp.value = fmt(widget?.value ?? 0);
  if (width) inp.style.width = width + "px";

  const clamp = (v) => {
    let x = v;
    if (mn !== undefined) x = Math.max(mn, x);
    if (mx !== undefined) x = Math.min(mx, x);
    return x;
  };
  const writeVal = (x) => {
    const val = round(clamp(x));
    inp.value = fmt(val);
    setWidgetValue(node, widget, val);
  };
  const commit = () => {
    let v = parseFloat(inp.value);
    if (!isFinite(v)) v = (o.default !== undefined) ? Number(o.default) : (mn ?? 0);
    writeVal(Math.round(v / step) * step);
  };
  const stepBy = (dir) => {
    let v = parseFloat(inp.value);
    if (!isFinite(v)) v = Number(widget?.value ?? 0);
    if (!isFinite(v)) v = mn ?? 0;
    writeVal(round(v) + dir * step);
    node._jllRefresh?.();
  };
  inp.addEventListener("change", commit);
  inp.addEventListener("blur", commit);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    else if (e.key === "ArrowUp") { e.preventDefault(); stepBy(1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); stepBy(-1); }
  });
  inp.addEventListener("wheel", (e) => { e.preventDefault(); e.stopPropagation(); stepBy(e.deltaY < 0 ? 1 : -1); }, { passive: false });
  const up = el("button", "jlc-num-step", "▲"); up.type = "button";
  const dn = el("button", "jlc-num-step", "▼"); dn.type = "button";
  up.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); stepBy(1); });
  dn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); stepBy(-1); });
  wrap.appendChild(inp);
  wrap.appendChild(up);
  wrap.appendChild(dn);
  wrap._input = inp;
  wrap.setDisabled = (b) => {
    wrap.classList.toggle("disabled", !!b);
    inp.disabled = !!b;
    up.disabled = !!b;
    dn.disabled = !!b;
  };
  return wrap;
}

/* ============================== 圆点开关 ============================== */
function mkDotSwitch(node, widget, { onText, offText }) {
  const wrap = el("div", "jlc-dot");
  const txt = el("span", "jlc-dot-txt");
  const mark = el("span", "jlc-dot-mark");
  wrap.appendChild(txt);
  wrap.appendChild(mark);
  function sync() {
    const on = !!widget?.value;
    wrap.classList.toggle("on", on);
    txt.textContent = on ? onText : offText;
  }
  wrap.addEventListener("click", () => {
    setWidgetValue(node, widget, !widget?.value);
    sync();
    node._jllRefresh?.();
  });
  sync();
  return { el: wrap, sync };
}

function mkBtn(text, title, danger) {
  const b = el("button", "jlc-btn" + (danger ? " danger" : ""), text);
  b.type = "button";
  if (title) b.title = title;
  return b;
}
const mkRow = () => el("div", "jlc-row");

/* ============================ 主 UI 注册 ============================ */
app.registerExtension({
  name: EXT_NAME,
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== "JosiaLoadLatent") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    const onConfigure = nodeType.prototype.onConfigure;

    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      const node = this;
      injectStyle();

      const W = {};
      for (const name of ["Latent文件", "Latent缩放", "缩放比例", "对齐倍数"]) {
        W[name] = getWidget(node, name);
      }

      // ---- 隐藏全部原生 widget（批量模式不靠单文件下拉驱动）----
      for (const name of Object.keys(W)) {
        const w = W[name];
        if (!w) continue;
        w.hidden = true;
        w.options = w.options || {};
        w.options.hidden = true;
        w.options.socketless = true;
        if (w.element) w.element.style.display = "none";
        w.computeSize = () => [0, 0];
      }

      const dropStaleInputs = () => {
        try {
          const stale = [];
          for (let i = 0; i < (node.inputs?.length || 0); i++) {
            const inp = node.inputs[i];
            if (!inp || !inp.widget) continue;
            if (inp.link) continue;
            stale.push(i);
          }
          for (let k = stale.length - 1; k >= 0; k--) node.removeInput(stale[k]);
        } catch (e) { /* 旧前端无此结构时忽略 */ }
      };
      dropStaleInputs();

      /* ======================= 尺寸 ======================= */
      node.min_size = [MIN_W, MIN_H];
      const chromeH = () => Math.round((Number(window.LiteGraph?.NODE_TITLE_HEIGHT) || 30) + 2);
      // 🔴 _targetH＝「UI 需要的节点总高」，由 grow() 解析式算出（高度完全归信息窗管）。
      //    computeSize 与 min_size 都拿它当**最小高度** ⇒ 用户拖拽缩小也缩不进 UI 里
      //    （UI 永不被藏），且高度只会被 grow() 校正，不响应手动拖高拖矮。
      let _targetH = DEF_H;
      node.computeSize = function () { return [MIN_W, Math.max(MIN_H, _targetH)]; };
      if (!(node.size && node.size[0] >= DEF_W)) {
        const w = (node.size && node.size[0] > 0) ? Math.max(node.size[0], DEF_W) : DEF_W;
        const h = (node.size && node.size[1] > 0) ? Math.max(node.size[1], DEF_H) : DEF_H;
        try { node.size = [w, h]; } catch (e) { /* 忽略 */ }
      }

      /* ======================= 面板骨架 ======================= */
      const root = el("div", "jlc-root");

      // 🔴 行1（置顶）：缩放开关 + 缩放比例（窄·两位小数） + 对齐倍数（宽）
      const rowScale = mkRow();
      const dotScale = mkDotSwitch(node, W["Latent缩放"],
        { onText: "Latent缩放", offText: "Latent缩放" });
      dotScale.el.title = "开启后按「缩放比例 / 对齐倍数」放大每个潜空间；关闭则原样加载（下方两项灰化）。";
      rowScale.appendChild(dotScale.el);
      const numRatio = mkNumber(node, W["缩放比例"],
        { label: "缩放比例", step: 0.05, width: 42, min: 0.1, max: 8, decimals: 2 });
      numRatio.title = "空间尺寸（宽高）的放大倍数，1.00 = 不改变。关闭「Latent缩放」时显示两位小数但不可调。";
      rowScale.appendChild(numRatio);
      const dropAlign = mkDrop(node, W["对齐倍数"], {
        label: "对齐倍数",
        width: 116,
        items: () => comboValues(W["对齐倍数"]),
        emptyText: "（无可用倍数选项）",
      });
      dropAlign.el.title = "把放大后的宽高**向上**对齐到该倍数的整数倍（VAE / patch 通常需要 8 或 16 的倍数）。1 = 不对齐。";
      rowScale.appendChild(dropAlign.el);
      root.appendChild(rowScale);

      // 🔴 行2：多文件选择 + 清空列表 + 重置进度
      const rowFiles = mkRow();
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = ".latent";
      fileInput.multiple = true;          // 🔴 多文件选择器
      fileInput.style.display = "none";
      root.appendChild(fileInput);

      const btnPick = mkBtn("📁 选择文件", "上传任意位置的 .latent（可多选）到任务池，不限 input 目录");
      rowFiles.appendChild(btnPick);
      const btnClear = mkBtn("🗑 清空列表", "把任务池里所有载入的 .latent 移除（文件仍留磁盘，可重新选择）", true);
      rowFiles.appendChild(btnClear);
      const btnReset = mkBtn("🔄 重置进度", "保留任务池，把每个文件状态归零，可重新解码同一批");
      rowFiles.appendChild(btnReset);
      const btnCleanDone = mkBtn("🧹 清已完成", "把已完成的文件条目从任务池移除（未完成的保留，磁盘文件不删）");
      rowFiles.appendChild(btnCleanDone);
      root.appendChild(rowFiles);

      // 🔴 信息窗（三区，置于节点最下方，随内容撑高）
      const batchBox = el("div", "jlc-batch");
      // 上方区：当前 Latent 文件详情（多列网格）
      const infoTop = el("div", "jlc-info-top");
      batchBox.appendChild(infoTop);
      const divider1 = el("div", "jlc-divider");
      batchBox.appendChild(divider1);
      // 状态区
      const head = el("div", "jlc-batch-head");
      const headCount = el("span", "jlc-batch-count", "任务池：0 个");
      head.appendChild(headCount);
      const headSub = el("span", "", "");
      head.appendChild(headSub);
      batchBox.appendChild(head);
      const lineSt = el("div", "jlc-inf-status");
      batchBox.appendChild(lineSt);
      const divider2 = el("div", "jlc-divider");
      batchBox.appendChild(divider2);
      // 文件列表区
      const listEl = el("div", "jlc-batch-list");
      batchBox.appendChild(listEl);
      root.appendChild(batchBox);

      function setStatus(txt, isErr) {
        lineSt.textContent = String(txt ?? "");
        lineSt.classList.toggle("err", !!isErr);
      }

      /* ======================= 撑高（解析式 · 高度锁定跟随内容）======================= */
      // 🔴 根因备忘：旧版量 root.offsetHeight —— 这个值会被 DOM 容器钳到「节点当前高度」，
      //    量出偏小 ⇒ setSize 越改越矮（点一下缩一行、最后只剩端口）。现在全部用已知常量算：
      //    行1(22) + 行距(6) + 行2(22) + 行距(6) + 信息窗内容高 + 根内边距(6×2)，加标题栏。
      //    信息窗内容高用 batchBox.scrollHeight（＝内容自然高，不受容器钳制）。
      // 🔴 高度**完全归信息窗管**：每次 grow 双向校正到 _targetH（可增可减），
      //    信息窗永不出现滚动条；用户拖拽只允许改宽度（onResize 把高度拴回 _targetH）。
      let _growing = false;
      // 🔴 batchBox 有上下各 1px 边框，scrollHeight 不含边框 ⇒ 高度恰好差 2px，
      //    信息窗底角被节点边界裁成直角（哥哥截图实测）；再留 2px 取整余量 ⇒ 共补 4px。
      const BATCH_BORDER = 2;
      const H_SLACK = 2;
      function grow() {
        if (_growing) return;
        _growing = true;
        try {
          batchBox.style.maxHeight = "none";
          const natural = batchBox.scrollHeight;
          const panel = ROW_H + ROW_GAP + ROW_H + ROW_GAP + natural + BATCH_BORDER + H_SLACK + PAD * 2;
          _targetH = Math.max(MIN_H, Math.round(panel + chromeH()));
          const w = Math.max(MIN_W, node.size?.[0] || DEF_W);
          // 🔴 双保险：min_size 同步到内容高 —— LiteGraph 拖拽时按 min_size 钳制，
          //    即使某一版前端走了另一条 resizing 分支，高度也缩不进 UI 里。
          node.min_size = [MIN_W, _targetH];
          if ((node.size?.[0] || 0) !== w || (node.size?.[1] || 0) !== _targetH) {
            try { node.setSize([w, _targetH]); } catch (e) {
              try { node.size = [w, _targetH]; } catch (e2) { /* 忽略 */ }
            }
          }
          node.setDirtyCanvas?.(true, true);
        } finally { _growing = false; }
      }

      /* ================== 上方区：当前文件详情（固定 3列×2行）================== */
      // 🔴 按哥哥定死版式：第 1 行 文件名 / 文件类型 / 数据类型，第 2 行 分辨率 /
      //    文件大小 / VAE。key 与 value **同行**（网格 6 列：auto 1fr ×3）；缺的字段补
      //    「—」保持 3×2 不塌。长值省略号截断（不折叠）。
      //    文件类型判据（哥哥定）：有音频路 ⇒ 音频；多帧 ⇒ 视频；其余 ⇒ 图像。
      //    数据类型（后端按张量结构判）：图像潜空间 / 视频潜空间 / 音视频混合潜空间。
      //    🔴 不显示「帧数 / 张量维度 / 形状」（2026-09-29 哥哥要求）：帧数是 VAE 时间
      //       压缩后的潜空间长度，用户既看不懂也算不出实际总帧数；其余是内部张量信息。
      function renderInfo(d) {
        infoTop.innerHTML = "";
        if (!d || d.error === "not_found") {
          const hint = el("div", "jlc-info-val", "连接上游Latent或载入本地Latent文件");
          hint.style.gridColumn = "1 / -1";
          infoTop.appendChild(hint);
          return;
        }
        const cell = (k, v, isErr, tip) => {
          const val = el("div", "jlc-info-val" + (isErr ? " err" : ""),
            (v == null || v === "") ? "—" : String(v));
          if (tip) val.title = tip;
          infoTop.appendChild(el("div", "jlc-info-key", k));
          infoTop.appendChild(val);
        };
        const mediaType = d.has_audio ? "音频" : (d.frames != null && d.frames > 1 ? "视频" : "图像");
        cell("文件名", d.name);
        cell("文件类型", mediaType);
        cell("数据类型", d.kind);
        cell("分辨率", (d.pixel_w && d.pixel_h) ? `${d.pixel_w}×${d.pixel_h}` : null);
        cell("文件大小", d.size != null ? humanSize(d.size) : null);
        // 🔴 这个 .latent 由「Josia媒体保存」落盘时会把当时用的 VAE 文件名写进文件头
        //    ⇒ 载入时读出来显示，下次解码照着选即可。老文件没有这条元数据则显示「—」。
        const vaeTxt = [d.vae, d.vae2].filter(Boolean).join(" ＋ ");
        cell("VAE", vaeTxt || null, false, vaeTxt || null);
        if (d.error) {
          const err = el("div", "jlc-info-val err", String(d.error));
          err.style.gridColumn = "1 / -1";
          infoTop.appendChild(err);
        }
        // 🔴 上方区是异步填充的（selectFile 拉 /info 要读整个 .latent 文件，可能晚于
        //    列表渲染后的那次 grow）⇒ 详情行填进来之后必须再校一次高，否则节点
        //    差出详情区那一两行的高度（哥哥实测：载入 4 个文件后节点装不下）。
        grow();
      }

      /* ======================= 文件列表渲染 ======================= */
      const BADGE_TXT = { done: "已完成", processing: "解码中", failed: "失败", pending: "待处理" };
      function badgeCls(s) { return "jlc-badge " + (BADGE_TXT[s] ? s : "pending"); }
      let _selected = "";

      // 🔴 查看位置持久化：把「当前选中的文件名」序列化进隐藏的「Latent文件」widget，
      //    随工作流一起保存 ⇒ 关闭重开 ComfyUI / 切换工作流再切回来，已选中的高亮不丢。
      //    （任务池本身以磁盘 manifest 为权威源，本处只备份「查看位置」，不影响文件列表本身；
      //      特意**不**把文件列表序列化进节点，避免「右键重建」也跟着复活列表、破坏哥哥定的
      //      「重建＝默认清空」语义。）
      function persistSelected(name) {
        // 🔴 保留 key：widget 值 = {"key": 分桶钥匙, "sel": 查看位置}
        writeStore({ ...readStore(), sel: name || "" });
      }
      function restoreSelected() {
        try {
          const w = W["Latent文件"];
          if (!w || !w.value) return;
          const o = JSON.parse(w.value);
          if (o && typeof o.sel === "string" && o.sel) _selected = o.sel;
        } catch (e) { /* 忽略 */ }
      }

      function renderBatch(info) {
        if (!info) return;
        const total = info.total || 0;
        const done = info.done || 0;
        const proc = info.processing || 0;
        const fail = info.failed || 0;
        headCount.textContent = `任务池：${total} 个`;
        let sub = `已完成 ${done}`;
        if (proc) sub += ` · 解码中 ${proc}`;
        if (fail) sub += ` · 失败 ${fail}`;
        headSub.textContent = sub;
        if (info.current) setStatus(`解码中：${info.current}`);
        else if (info.msg) setStatus(info.msg);
        listEl.innerHTML = "";
        const files = info.files || [];
        if (!files.length) {
          listEl.appendChild(el("div", "jlc-batch-empty", "等待载入文件…"));
        } else {
          for (const f of files) {
            const row = el("div", "jlc-batch-item" + (f.name === info.current ? " cur" : "") + (f.name === _selected ? " on" : ""));
            row.appendChild(el("span", badgeCls(f.status), BADGE_TXT[f.status] || "待处理"));
            const name = el("span", "jlc-batch-name", f.name);
            name.title = f.name;
            row.appendChild(name);
            // 分辨率列（像素，上传时由后端算好缓存进清单）
            if (f.w && f.h) {
              row.appendChild(el("span", "jlc-batch-res", `${f.w}×${f.h}`));
              row.title = `${f.w}×${f.h}`;
            }
            row.appendChild(el("span", "jlc-batch-size", humanSize(f.size)));
            // 🔴 行尾「✕」：单独移除该文件（只出任务池，磁盘文件保留）
            const x = el("button", "jlc-batch-x", "✕");
            x.type = "button";
            x.title = "从任务池移除该文件（磁盘文件保留）";
            x.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              removeFile(f.name);
            });
            row.appendChild(x);
            row.addEventListener("click", () => selectFile(f.name));
            listEl.appendChild(row);
          }
        }
        grow();
      }
      node._jllRenderBatch = renderBatch;

      // 点列表项 ⇒ 拉详情到上方区
      async function selectFile(name) {
        if (!name) return;
        _selected = name;
        // 先高亮，再异步拉取（避免闪烁）
        for (const row of listEl.children) {
          const nm = row.querySelector?.(".jlc-batch-name")?.textContent;
          row.classList.toggle("on", nm === name);
        }
        try {
          const resp = await api.fetchApi("/josia_load_latent/info?file=" + encodeURIComponent(name));
          const d = await resp.json();
          if (d.ok) renderInfo(d);
          persistSelected(name);   // 🔴 查看位置随工作流持久化（关闭重开 / 切工作流不丢高亮）
        } catch (e) { /* 忽略 */ }
      }
      node._jllSelectFile = selectFile;

      // 🔴 行尾「✕」：把单个文件从**本节点**任务池移除（磁盘文件保留，幂等）。
      //    若移除的正是当前查看的文件，顺手清掉高亮并把查看位置持久化值一并置空。
      async function removeFile(name) {
        if (!name) return;
        try {
          const resp = await api.fetchApi(
            "/josia_load_latent/remove?nid=" + encodeURIComponent(nid())
            + "&name=" + encodeURIComponent(name), { method: "POST" });
          const d = await resp.json();
          if (!d.ok) { setStatus(`⚠️ 移除失败：${d.error || "未知错误"}`, true); return; }
          if (_selected === name) { _selected = ""; persistSelected(""); }
          setStatus(`🗑 已移除：${name}`);
          refreshBatch();
        } catch (err) {
          setStatus(`⚠️ 移除失败：${err}`, true);
        }
      }
      node._jllRemoveFile = removeFile;

      /* ======================= 稳定分桶钥匙 ======================= */
      // 🔴 任务池按「分桶钥匙」分桶，绝不直接用 node.id——实测 node.id 会随切换工作流 /
      //    前端重编号而漂移，同一逻辑节点的池被撕成多个孤儿桶（「任务池 0」假象的根因）。
      //    钥匙生成一次后持久化在隐藏「Latent文件」widget 里（值形如 {"key","sel"}，
      //    widget 值随工作流保存 / 随 prompt 提交 ⇒ 切工作流、保存重开、重编号都不漂移）。
      //    后端 _bucket_key 从 widget 值里取同一把钥匙，两端一致。
      function readStore() {
        try {
          const o = JSON.parse(W["Latent文件"]?.value || "{}");
          return (o && typeof o === "object") ? o : {};
        } catch (e) { return {}; }
      }
      function writeStore(o) {
        try {
          const w = W["Latent文件"];
          if (w) w.value = JSON.stringify(o);
        } catch (e) { /* 忽略 */ }
      }
      function nid() {
        const o = readStore();
        if (o.key) return String(o.key);
        const k = "jll-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
        writeStore({ ...o, key: k });
        return k;
      }

      function refreshBatch() {
        try {
          // 🔴 legacy 迁移只在「从保存的工作流恢复、且 widget 里还没有稳定钥匙」时触发一次：
          //    新建 / 右键重建的节点绝不带 legacy —— node.id 是按序复用的，新建节点的 id
          //    极易撞上历史会话遗留的孤儿桶，把别人载入过的文件搬进自己的新池
          //    （重建两三次后冒出「幽灵文件」的根因）。搬家动作一次性，成功后不再带。
          let url = "/josia_load_latent/batch?nid=" + encodeURIComponent(nid());
          if (node._jllLegacy) url += "&legacy=" + encodeURIComponent(String(node._jllLegacy));
          api.fetchApi(url)
            .then((resp) => resp.json())
            .then((d) => {
              if (d.ok && d.info) {
                node._jllLegacy = "";   // 搬家请求已发出，只此一次
                renderBatch(d.info);
                // 默认上方区：当前解码项 > 首个文件 > 已选；空池也给占位提示，
                // 不让上方区空着（哥哥报过「分割线之外都是空白」）。
                const pick = d.info.current || _selected || (d.info.files?.[0]?.name) || "";
                if (pick) selectFile(pick);
                else renderInfo(null);
              }
            })
            .catch(() => { /* 忽略 */ });
        } catch (e) { /* 忽略 */ }
      }

      /* ======================= 刷新（缩放显隐 / 接线优先）======================= */
      function hasWired(portName) {
        try {
          const inp = node.inputs?.find((i) => i.name === portName);
          return !!(inp && inp.link != null);
        } catch (e) { return false; }
      }
      function refreshInner() {
        const on = !!W["Latent缩放"]?.value;
        // 🔴 关闭时「灰化」而非隐藏：缩放比例 + 对齐倍数
        numRatio.setDisabled(!on);
        dropAlign.el.classList.toggle("disabled", !on);
        // 🔴 Latent 端口连线 ⇒ 透传模式，文件相关按钮灰化
        const wired = hasWired("Latent");
        btnPick.disabled = wired;
        btnClear.disabled = wired;
        btnCleanDone.disabled = wired;
        fileInput.disabled = wired;
        batchBox.classList.toggle("disabled", false);  // 列表区仍可见（可点选）
        if (wired) {
          infoTop.innerHTML = "";
          const wmsg = el("div", "jlc-info-val", "已接线上游 Latent · 透传模式（忽略任务池，文件列表仅查看）");
          wmsg.style.gridColumn = "1 / -1";
          infoTop.appendChild(wmsg);
          grow();
        }
      }
      function syncAll() {
        try { dropAlign.sync(); } catch (e) {}
        try { dotScale.sync(); } catch (e) {}
      }
      function refresh() {
        restoreSelected();   // 🔴 重载后恢复「上次查看的文件」高亮（数据来自随工作流保存的序列化）
        try { refreshInner(); } catch (e) { console.error("[Josia加载Latent] 显隐异常：", e); }
        try { syncAll(); } catch (e) { console.error("[Josia加载Latent] 同步异常：", e); }
        if (!hasWired("Latent")) refreshBatch();
        else {
          infoTop.innerHTML = "";
          const wmsg = el("div", "jlc-info-val", "已接线上游 Latent · 透传模式（忽略任务池，文件列表仅查看）");
          wmsg.style.gridColumn = "1 / -1";
          infoTop.appendChild(wmsg);
          grow();
        }
      }
      node._jllRefresh = refresh;

      /* ======================= 上传 / 清空 / 重置 ======================= */
      btnPick.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fileInput.click(); });
      fileInput.addEventListener("change", async () => {
        const fs = fileInput.files ? Array.from(fileInput.files) : [];
        if (!fs.length) return;
        // 🔴 逐个上传并**逐条点名**报结果：一次多选里哪个成功、哪个失败、哪个因重名
        //    被改名，都要在状态行里说清楚（旧版只报总数，用户看到「载入 1 个」无从排查）。
        let okCount = 0, renamedCount = 0;
        const bad = [];
        for (const f of fs) {
          try {
            const fd = new FormData();
            fd.append("file", f, f.name);
            const resp = await api.fetchApi("/josia_load_latent/upload?nid=" + encodeURIComponent(nid()), { method: "POST", body: fd });
            const d = await resp.json();
            if (d.ok) { okCount++; if (d.renamed) renamedCount++; }
            else bad.push(`${f.name}（${d.error === "only_latent" ? "不是 .latent 文件" : (d.error || "未知错误")}）`);
          } catch (err) {
            bad.push(`${f.name}（${err}）`);
          }
        }
        let msg = `✅ 已载入 ${okCount} 个 .latent（已进入任务池）`;
        if (renamedCount) msg += ` · ${renamedCount} 个重名文件已自动改名（绝不覆盖已有文件）`;
        if (bad.length) {
          msg = `⚠️ ${bad.length} 个未载入：${bad.join("；")}` + (okCount ? `（另有 ${okCount} 个已载入）` : "");
        }
        setStatus(msg, bad.length > 0);
        refreshBatch();
        fileInput.value = "";
      });
      btnClear.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        try {
          const resp = await api.fetchApi("/josia_load_latent/clear?nid=" + encodeURIComponent(nid()), { method: "POST" });
          const d = await resp.json();
          if (!d.ok) { setStatus(`⚠️ 清空失败：${d.error || "未知错误"}`, true); return; }
          _selected = "";
          setStatus("🗑 任务池已清空，可重新选择文件。");
          refreshBatch();
        } catch (err) {
          setStatus(`⚠️ 清空失败：${err}`, true);
        }
      });
      btnReset.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        try {
          const resp = await api.fetchApi("/josia_load_latent/reset?nid=" + encodeURIComponent(nid()), { method: "POST" });
          const d = await resp.json();
          if (!d.ok) { setStatus(`⚠️ 重置失败：${d.error || "未知错误"}`, true); return; }
          setStatus("🔄 进度已归零，将从头解码同一批文件。");
          refreshBatch();
        } catch (err) {
          setStatus(`⚠️ 重置失败：${err}`, true);
        }
      });
      btnCleanDone.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        try {
          const resp = await api.fetchApi("/josia_load_latent/clear_done?nid=" + encodeURIComponent(nid()), { method: "POST" });
          const d = await resp.json();
          if (!d.ok) { setStatus(`⚠️ 清除失败：${d.error || "未知错误"}`, true); return; }
          setStatus("🧹 已清除已完成条目，未完成的保留。");
          refreshBatch();
        } catch (err) {
          setStatus(`⚠️ 清除失败：${err}`, true);
        }
      });

      /* ======================= 布局 / 事件 ======================= */
      // 🔴 拖拽规则（哥哥定死）：高度不归用户管——onResize 把高度拴回 _targetH、
      //    宽度钳到 ≥ MIN_W；拖完异步 grow() 重量一次内容（宽度变窄可能影响换行）。
      node.onResize = function () {
        try {
          const w = Math.max(MIN_W, this.size?.[0] || MIN_W);
          if (this.size?.[0] !== w || this.size?.[1] !== _targetH) {
            this.size = [w, _targetH];
          }
        } catch (e) { /* 忽略 */ }
        node.setDirtyCanvas?.(true, true);
        setTimeout(() => { try { grow(); } catch (e) { /* 忽略 */ } }, 0);
      };

      const origConnectionsChange = node.onConnectionsChange;
      node.onConnectionsChange = function () {
        origConnectionsChange?.apply(this, arguments);
        setTimeout(() => { closeMenu(); refresh(); }, 0);
      };

      // 滚轮缩放转发到画布
      root.addEventListener("wheel", (e) => {
        const c = app.canvas;
        if (!c) return;
        e.preventDefault();
        const h = c.onMouseWheel || c.processMouseWheel || c._on_mouse_wheel;
        if (typeof h === "function") { h.call(c, e); return; }
        if (c.canvas) c.canvas.dispatchEvent(new WheelEvent("wheel", {
          deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
          clientX: e.clientX, clientY: e.clientY,
          ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey,
          bubbles: true, cancelable: true,
        }));
      }, { passive: false });

      /* ======================= 初始化 ======================= */
      nid();   // 🔴 建节点即刻领钥匙并持久化（保证第一次执行 / 保存工作流时就带上）
      requestAnimationFrame(() => {
        refresh();
        grow();
        node.setDirtyCanvas?.(true, true);
      });
      [0, 60, 300].forEach((ms) => setTimeout(() => {
        try { grow(); } catch (e) { /* 忽略 */ }
      }, ms));

      const domWidget = node.addDOMWidget("load_latent_ui", "load_latent_ui", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 0,
      });

      return r;
    };

    // 🔴 右键「刷新」语义化：原生 refreshComboInNode 只刷新 COMBO 选项，**完全不碰**
    //    我们自建的 DOM 面板 ⇒ 遇到尺寸 / 显示错位时刷新毫无作用，哥哥才误以为刷新会丢。
    //    这里覆盖成「刷 COMBO ＋ 重绘面板」：重绘会重新拉 manifest、重新跑 grow() 重算高度，
    //    从而修正显示 / 尺寸问题；**不重置**已载入的文件列表与任务池（数据以磁盘 manifest
    //    为唯一源，刷新只是重新读取它，绝不清空）。
    const _origRefreshCombo = nodeType.prototype.refreshComboInNode;
    nodeType.prototype.refreshComboInNode = function (...args) {
      try { _origRefreshCombo?.apply(this, args); } catch (e) { /* 忽略原生异常 */ }
      try { this._jllRefresh?.(); } catch (e) { /* 忽略 */ }
    };

    // 🔴 每次执行结束回传的 ui（josia_batch_info）⇒ 自动刷新进度 + 上方区
    nodeType.prototype.onExecuted = function (message) {
      try {
        const info = message?.josia_batch_info || message?.ui?.josia_batch_info;
        if (info && this._jllRenderBatch) {
          this._jllRenderBatch(info);
          if (info.current) this._jllSelectFile?.(info.current);
        }
      } catch (e) { /* 忽略 */ }
    };

    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      const node = this;
      // 🔴 从工作流恢复时，widget 里若还没有稳定钥匙（老版本保存的工作流），才允许
      //    用当前 node.id 做一次旧桶搬家；新建 / 重建节点没有这一步 ⇒ 绝不会把
      //    历史孤儿桶的文件搬进来（onNodeCreated 先跑、这里后跑，widget 值已是恢复后的）。
      try {
        const w = getWidget(node, "Latent文件");
        const v = w ? String(w.value ?? "") : "";
        let hasKey = false;
        if (v.startsWith("{")) { try { hasKey = !!(JSON.parse(v) || {}).key; } catch (e) { /* 忽略 */ } }
        if (!hasKey) node._jllLegacy = String(node.id ?? "");
      } catch (e) { /* 忽略 */ }
      if (node._jllRefresh) requestAnimationFrame(() => { node._jllRefresh(); });
      return r;
    };

    // 🔴 工作流收尾（成功 / 打断 / 出错）统一补刷全部本节点面板：进度回写由媒体保存
    //    节点在执行期落盘，加载节点的 ui 快照停在「解码中」，跑完补一刷才能看到「已完成」。
    if (!_execHooked) {
      _execHooked = true;
      const refreshAll = () => {
        try {
          const g = app.graph;
          for (const n of (g?._nodes || g?.nodes || [])) {
            if (n && typeof n._jllRefresh === "function") n._jllRefresh();
          }
        } catch (e) { /* 忽略 */ }
      };
      api.addEventListener("execution_success", refreshAll);
      api.addEventListener("execution_interrupted", refreshAll);
      api.addEventListener("execution_error", refreshAll);
      // 🔴 实时进度（媒体保存批量循环每个文件开始/完成时广播）：
      //    所有本节点面板各拉各的桶快照 —— 不匹配的桶数据没变化，刷了也白刷一次请求，
      //    匹配的那个立刻把「解码中 → 已完成」跳出来，解视频不用傻等。
      api.addEventListener("josia_batch_progress", refreshAll);
    }
  },
});
