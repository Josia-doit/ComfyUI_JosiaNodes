/* ============================================================================
 * JosiaNodes · Josia加载Latent   前端 UI（Node 1.0 优先）
 * 同名节点＝JosiaLoadLatent（load_latent.py）。
 * 面板：📁 选择文件 · 文件下拉 · 📂 打开 ｜ 信息窗（元数据多格 + 底部状态行）｜ Latent缩放 · 缩放比例 · 对齐倍数
 * 组件自包含（不依赖 media_save.js），仅用与媒体保存一致的视觉 token。
 * ========================================================================== */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const EXT_NAME = "JosiaNodes.JosiaLoadLatent";
const STYLE_ID = "josia-load-latent-style";
const ROW_H = 22;
const PAD = 6;
const ROW_GAP = 6;
const PLACEHOLDER = "🎞️ 请选择 .latent 文件…";
const DEF_W = 560;
const DEF_H = 210;
const MIN_PANEL_H = 96;

const CSS = `
.jlc-root{box-sizing:border-box;width:100%;padding:${PAD}px;display:flex;flex-direction:column;
  gap:${ROW_GAP}px;font-size:11px;line-height:1.25;color:inherit;
  /* 🔴 面板高度跟随节点：内容装不下时「面板内部滚动」，绝不溢出到节点外。
     不能写 height:100%（会让面板被拉伸、内容居中/留白异常）；max-height + overflow-y 即可。
     节点高度只由用户拖拽决定（applyLayout 不改 node.size）。 */
  max-height:100%;overflow-y:auto;overflow-x:hidden;
  /* 🔴🔴 同「Josia媒体保存」：面板整体 pointer-events:none，把空白处的指针事件让给下层
     canvas ⇒ 按住面板空白也能像原生节点一样移动节点；交互控件在下面逐条抢回 auto。
     （信息窗是纯交互区，不参与拖动。） */
  pointer-events:none;
  /* 🔴 禁止鼠标拖出文本选区：以前在面板空白处拖动会选中选项文字、触发浏览器「搜索选中内容」。
     输入框单独放开（见下一条），输入框内的文本照常可选中/编辑。 */
  user-select:none;-webkit-user-select:none;}
/* 只有这些控件接收指针事件，其余一律穿透到画布（＝按住即移动节点） */
.jlc-root input,.jlc-root textarea,.jlc-root button,
.jlc-root .jlc-btn,.jlc-root .jlc-numwrap,.jlc-root .jlc-drop,
.jlc-root .jlc-dot,.jlc-root .jlc-info{pointer-events:auto;}
/* 🔴 灰化的控件（接线优先等）必须继续不可点：特异性更高，压过上面的 auto */
.jlc-root .jlc-drop.disabled{pointer-events:none;}
/* 🔴🔴 同「Josia媒体保存」：官方给 DOM widget 外层「div.dom-widget」写的是**行内**
   pointer-events:auto（DomWidget.vue），它罩在面板外会把空白处事件全吃掉 ⇒ 面板空白拖不动。
   行内样式只能被 !important 压过；用 :has(> .jlc-root) 只指向装着我们面板的那一层。 */
div.dom-widget:has(> .jlc-root){pointer-events:none !important;}
/* 输入框内文本照常可选中/编辑 */
.jlc-root input,.jlc-root textarea{user-select:text;-webkit-user-select:text;}
/* 🔴 行永不被压缩：面板高度不足时靠 root 自己滚动，行的高度必须是自然高度。 */
.jlc-root>*{flex:0 0 auto;}
.jlc-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;}
/* 🔴 信息窗＝虚拟多格容器：一行排多格（列数随节点宽度自适应），不再一行一条信息 */
/* 🔴 信息窗＝「文件元数据多格」+「状态行」两层：
   上面的格子是**显示信息**（文件/类型/形状/精度…）；最底部状态行只有 setStatus() 会写它，
   「打开目录 / 上传 / 报错」这类操作日志只落状态行，绝不覆盖上面的显示信息（上一版的 bug）。 */
.jlc-info{box-sizing:border-box;min-height:30px;padding:5px 7px;border-radius:6px;border:1px solid #333;
  background:#000;color:#e6e6e6;font-size:10px;line-height:1.5;}
.jlc-inf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
  gap:2px 10px;align-content:start;}
.jlc-inf-grid.plain{display:block;white-space:pre-wrap;word-break:break-all;}
.jlc-inf{display:flex;align-items:baseline;gap:4px;min-width:0;white-space:nowrap;}
.jlc-inf-ico{flex:0 0 auto;font-size:10px;}
.jlc-inf-k{flex:0 0 auto;opacity:.5;}
.jlc-inf-v{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;font-weight:500;}
.jlc-inf-status{margin-top:3px;padding-top:3px;border-top:1px solid rgba(128,128,128,.25);
  opacity:.85;white-space:pre-wrap;word-break:break-all;}
.jlc-inf-status.err{color:#ffb4b4;opacity:1;}
.jlc-drop,.jlc-numwrap,.jlc-dot,.jlc-btn{height:${ROW_H}px;box-sizing:border-box;border-radius:999px;
  border:1px solid var(--border-default,rgba(128,128,128,.5));
  background:var(--base-background,rgba(20,20,22,.92));color:var(--base-foreground,inherit);font-size:11px;}
.jlc-drop,.jlc-numwrap,.jlc-dot{display:inline-flex;align-items:center;}
.jlc-btn{cursor:pointer;white-space:nowrap;padding:0 10px;display:inline-flex;align-items:center;}
.jlc-btn:hover{background:var(--secondary-background,rgba(128,128,128,.24));}
.jlc-btn:disabled{opacity:.4;cursor:default;}
/* 🔴 宽度按内容自适应（不再写死像素宽，避免选项文字被挤成省略号）：
   flex:0 0 auto + width:auto ⇒ 基准宽度取 max-content，整块胶囊完整显示；
   一行放不下时由 .jlc-row 的 flex-wrap 换行，而不是把文字压成「…」。 */
.jlc-drop{padding:0 4px 0 7px;gap:5px;cursor:pointer;min-width:84px;position:relative;flex:0 0 auto;
  white-space:nowrap;}
.jlc-drop.disabled{opacity:.45;pointer-events:none;}
.jlc-drop-lab{flex:0 0 auto;opacity:.55;font-size:10px;white-space:nowrap;}
.jlc-drop-btn{flex:0 0 auto;border:none;background:none;color:inherit;text-align:left;font:inherit;
  outline:none;white-space:nowrap;cursor:pointer;padding:0;}
/* 🔴 箭头属于点击热区：让用户点右边的 ▾ 也能开菜单
   （此前 pointer-events:none ⇒ 只有文字能点，非常割裂） */
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
  width:46px;padding:0 2px;outline:none;-moz-appearance:textfield;appearance:textfield;}
.jlc-numwrap input::-webkit-outer-spin-button,
.jlc-numwrap input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;display:none;}
.jlc-num-step{flex:0 0 auto;width:15px;border:none;background:transparent;color:inherit;cursor:pointer;
  font-size:9px;opacity:.6;padding:0;}
.jlc-dot{gap:6px;padding:0 11px;cursor:pointer;flex:0 0 auto;width:110px;justify-content:center;overflow:hidden;}
.jlc-dot-txt{opacity:.85;font-size:10px;white-space:nowrap;}
.jlc-dot-mark{width:10px;height:10px;border-radius:50%;border:2px solid var(--primary-background,#3d6ea8);
  box-sizing:border-box;background:transparent;transition:background .12s,border-color .12s;}
.jlc-dot.on .jlc-dot-mark{background:var(--primary-background,#3d6ea8);}
.jlc-dot.on .jlc-dot-txt{opacity:1;font-weight:600;}
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

// 🔴 COMBO 候选读取：永不抛（任何异常都退化成 []），否则一个下拉取不到候选就会
//    拖垮整段面板刷新（信息窗空白 + 所有下拉无值的经典症状来源）。
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
    // 🔴 不写按钮的 title：当前值已经显示在胶囊上了，悬浮提示留给调用点写明这个选项的**功能**
    //    （否则提示只是在重复一个已经看得见的值，毫无信息量）。
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
  // 🔴 挂在**整块胶囊**上而不是只挂按钮：内联灰标签、右侧 ▾ 箭头都成为点击热区。
  //    只挂按钮时，用户本能地去点箭头/边缘反而毫无反应 —— 这就是「▾ 点不动」的根因。
  //    双通道：只挂 pointerdown 在部分环境会被吞 ⇒ 下拉彻底没入口。
  wrap.addEventListener("pointerdown", toggle);
  wrap.addEventListener("click", toggle);

  if (width) wrap.style.width = width + "px";
  wrap.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  try { sync(); } catch (e) { /* 忽略 */ }
  return { el: wrap, sync, btn };
}

/* ============================== 数字输入 ============================== */
function mkNumber(node, widget, { width, label, step = 1, min, max } = {}) {
  const wrap = el("div", "jlc-numwrap");
  if (label) wrap.appendChild(el("span", "jlc-in-lab", label));
  const inp = document.createElement("input");
  inp.type = "number";
  const o = widget?.options || {};
  const mn = (min !== undefined) ? min : o.min;
  const mx = (max !== undefined) ? max : o.max;
  if (mn !== undefined) inp.min = mn;
  if (mx !== undefined) inp.max = mx;
  inp.value = widget?.value ?? "";
  if (width) inp.style.width = width + "px";

  const clamp = (v) => {
    let x = v;
    if (mn !== undefined) x = Math.max(mn, x);
    if (mx !== undefined) x = Math.min(mx, x);
    return x;
  };
  // 🔴 按 step 的小数位数定精度。绝不能写 Math.round(v/step)*step ——
  //    0.05 这类 step 在二进制里不精确，(1+0.05)/0.05*0.05 会算出 1.0500000000000002，
  //    直接写进 input.value 就是「1.1500000000000001」这种显示。
  const _dec = (s) => {
    const t = String(s);
    const i = t.indexOf(".");
    return i < 0 ? 0 : (t.length - i - 1);
  };
  const PREC = Math.max(0, Math.min(6, _dec(step)));
  const FACTOR = Math.pow(10, PREC);
  const round = (x) => Math.round((x + Number.EPSILON) * FACTOR) / FACTOR;
  const writeVal = (x) => {
    const val = round(clamp(x));
    inp.value = String(val);
    setWidgetValue(node, widget, val);
  };
  const commit = () => {
    let v = parseFloat(inp.value);
    if (!isFinite(v)) v = (o.default !== undefined) ? Number(o.default) : (mn ?? 0);
    // 手输值吸附到 step 的整数倍，再按 step 精度取整
    writeVal(Math.round(v / step) * step);
  };
  const stepBy = (dir) => {
    let v = parseFloat(inp.value);
    if (!isFinite(v)) v = Number(widget?.value ?? 0);
    if (!isFinite(v)) v = mn ?? 0;
    // 先把自己取整到 step 精度再 ±step，避免浮点噪声逐次累积
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
    // 🔴 不写开关的 title：开关的「当前状态」已经由文字显示出来了，
    //    悬浮提示留给调用点写明这个开关的**功能**（否则提示只是在重复取值）。
  }
  wrap.addEventListener("click", () => {
    setWidgetValue(node, widget, !widget?.value);
    sync();
    node._jllRefresh?.();
  });
  sync();
  return { el: wrap, sync };
}

function mkBtn(text, title) {
  const b = el("button", "jlc-btn", text);
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

      // ---- 隐藏全部原生 widget ----
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

      /* ======================= 尺寸（Node 1.0 优先）======================= */
      //   · 不设最小尺寸：允许自由收窄 / 压低；
      //   · 新建节点（当前宽 < DEF_W）给到期望默认宽高，已较宽则尊重。
      const MIN_W = 260;     // 拖拽缩小下限（宽）
      const MIN_H = 110;     // 拖拽缩小下限（高）
      node.min_size = [MIN_W, MIN_H];
      // 🔴 节点里「不属于面板」的高度（标题栏 + 少量余量）。1.0 的 NODE_TITLE_HEIGHT = 30。
      const chromeH = () => Math.round((Number(window.LiteGraph?.NODE_TITLE_HEIGHT) || 30) + 2);
      // 🔴🔴 尺寸铁律：computeSize() **绝不能返回「当前尺寸」**，必须返回固定的最小值。
      //    官方拖拽缩放（LGraphCanvas.ts）：
      //      const min = node.computeSize()
      //      if (newBounds.width  < min[0]) newBounds.width  = min[0]
      //      if (newBounds.height < min[1]) newBounds.height = min[1]
      //      node.setSize(newBounds.size)
      //    —— computeSize() 被当作**最小尺寸**用。返回当前尺寸 ⇒ 任何缩小都被钳回当前尺寸
      //    ⇒ 表现「只能放大、不能缩小」。
      node.computeSize = function () { return [MIN_W, MIN_H]; };
      if (!(node.size && node.size[0] >= DEF_W)) {
        const w = (node.size && node.size[0] > 0) ? Math.max(node.size[0], DEF_W) : DEF_W;
        const h = (node.size && node.size[1] > 0) ? Math.max(node.size[1], DEF_H) : DEF_H;
        try { node.size = [w, h]; } catch (e) { /* 忽略 */ }
      }

      /* ======================= 面板骨架 ======================= */
      const root = el("div", "jlc-root");

      let fileList = [];          // 由 /josia_load_latent/list 异步填充

      const row1 = mkRow();
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = ".latent";
      fileInput.style.display = "none";
      root.appendChild(fileInput);

      const btnPick = mkBtn("📁 选择文件", "上传任意位置的 .latent（不限 input 目录）");
      row1.appendChild(btnPick);
      const dropFile = mkDrop(node, W["Latent文件"], {
        label: "文件",
        emptyText: "（暂无已上传的 .latent，点「📁 选择文件」上传）",
        items: () => {
          const cur = String(W["Latent文件"]?.value ?? "");
          const arr = fileList.slice();
          if (cur && cur !== PLACEHOLDER && !arr.includes(cur)) arr.unshift(cur);
          if (!arr.length) return [];
          return arr.map((f) => ({ value: f, label: f }));
        },
      });
      dropFile.el.style.flex = "1 1 140px";
      dropFile.el.style.minWidth = "0";
      dropFile.el.title = "当前选中的 .latent 文件；点它可切换，点左侧「📁 选择文件」上传新文件。";
      row1.appendChild(dropFile.el);
      const btnOpen = mkBtn("📂 打开", "用资源管理器打开 .latent 上传目录");
      row1.appendChild(btnOpen);
      root.appendChild(row1);

      const infoBox = el("div", "jlc-info");
      const infoGrid = el("div", "jlc-inf-grid");   // 显示信息：文件元数据多格（或纯文本提示）
      const lineSt = el("div", "jlc-inf-status");   // 状态行：只由 setStatus 写
      infoBox.appendChild(infoGrid);
      infoBox.appendChild(lineSt);
      // 纯文本提示（尚未选择 / 读取失败）走单栏整行；结构化元数据走「多格」
      function setInfoLine(txt) {
        infoGrid.className = "jlc-inf-grid plain";
        infoGrid.textContent = txt;
      }
      function setInfoCells(cells) {
        infoGrid.className = "jlc-inf-grid";
        infoGrid.innerHTML = "";
        for (const c of cells) {
          const box = el("span", "jlc-inf");
          box.appendChild(el("span", "jlc-inf-ico", c[0]));
          box.appendChild(el("span", "jlc-inf-k", c[1]));
          const val = el("span", "jlc-inf-v", String(c[2] ?? ""));
          val.title = String(c[2] ?? "");   // 单元格可能被省略号截断，title 用来看全
          box.appendChild(val);
          infoGrid.appendChild(box);
        }
      }
      // 🔴 状态行＝工作进度 / 当前操作（打开目录、上传、报错…）。后一条覆盖前一条、永远最新；
      //    上面的显示信息完全不受影响（这正是上一版「点一下打开目录，文件信息就被冲掉」的修法）。
      function setStatus(txt, isErr) {
        lineSt.textContent = String(txt ?? "");
        lineSt.classList.toggle("err", !!isErr);
      }
      root.appendChild(infoBox);

      const row2 = mkRow();
      const dotScale = mkDotSwitch(node, W["Latent缩放"],
        { onText: "Latent缩放", offText: "Latent缩放" });
      dotScale.el.title = "开启后按「缩放比例 / 对齐倍数」放大潜空间；关闭则原样加载。";
      row2.appendChild(dotScale.el);
      const numRatio = mkNumber(node, W["缩放比例"], { label: "缩放比例", step: 0.05, width: 52, min: 0.1, max: 8 });
      numRatio.title = "空间尺寸（宽高）的放大倍数，1.0 = 不改变。";
      row2.appendChild(numRatio);
      // 🔴 必须给 items：否则候选永远为空，菜单只会显示「无可用选项」，根本选不了倍数。
      //    （这就是「对齐倍数下拉显示暂无可选」的根因。）
      const dropAlign = mkDrop(node, W["对齐倍数"], {
        label: "对齐倍数",
        items: () => comboValues(W["对齐倍数"]),
        emptyText: "（无可用倍数选项）",
      });
      dropAlign.el.title = "把放大后的宽高**向上**对齐到该倍数的整数倍（VAE / patch 通常需要 8 或 16 的倍数）。1 = 不对齐。";
      row2.appendChild(dropAlign.el);
      root.appendChild(row2);

      // 🔴 对齐倍数胶囊加宽 20%（哥哥要求）：按**最长选项**量自然宽再 ×1.2 定宽。
      //    只在首次量到后锁定 ⇒ 重复调用不会按 1.2 倍连乘（越量越宽），选值变化也不会抖动。
      let _alignW = 0;
      function widenAlignDrop() {
        if (_alignW) return;
        try {
          const btn = dropAlign.el.querySelector(".jlc-drop-btn");
          if (!btn) return;
          const vals = (comboValues(W["对齐倍数"]) || []).map((v) => String(v));
          const longest = vals.reduce((a, b) => (b.length > a.length ? b : a), "");
          const old = btn.textContent;
          if (longest) btn.textContent = longest;
          dropAlign.el.style.width = "";
          const w = dropAlign.el.offsetWidth;
          if (longest) btn.textContent = old;
          if (w > 0) {
            _alignW = Math.round(w * 1.2);
            dropAlign.el.style.width = _alignW + "px";
          }
        } catch (e) { /* 量宽失败就保持原生自适应，不致命 */ }
      }

      /* ======================= 刷新 ======================= */
      let applying = false;
      let infoText = null;   // 已渲染的信息格子（缓存，避免每次 refresh 都重新读盘）
      let infoFor = "";      // infoText 对应的文件名

      // 某个输入端口是否已接线（判断「Latent 端口透传模式」）
      function hasWired(portName) {
        try {
          const inp = node.inputs?.find((i) => i.name === portName);
          return !!(inp && inp.link != null);
        } catch (e) { return false; }
      }
      // 接了「Latent」端口 ⇒ 不再读文件，改为「透传 / 放大上游 Latent」
      function wiredMode() { return hasWired("Latent"); }

      function refreshInner() {
        const on = !!W["Latent缩放"]?.value;
        numRatio.style.display = on ? "inline-flex" : "none";
        dropAlign.el.style.display = on ? "inline-flex" : "none";
        // 🔴 接线优先：接了 Latent 端口就不读文件 ⇒ 文件按钮 / 下拉灰化
        //    （否则会出现「明明选了文件，却按上游 Latent 出结果」的困惑）
        const wired = wiredMode();
        btnPick.disabled = wired;
        btnPick.style.opacity = wired ? ".4" : "1";
        fileInput.disabled = wired;
        dropFile.el.classList.toggle("disabled", wired);
        dropFile.el.title = wired
          ? "已接入「Latent」输入端口 —— 忽略文件，直接使用上游 Latent（透传/放大）。"
          : "当前选中的 .latent 文件；点它可切换，点左侧「📁 选择文件」上传新文件。";
      }
      function syncAll() {
        try { dropFile.sync(); } catch (e) {}
        try { dropAlign.sync(); } catch (e) {}
        try { dotScale.sync(); } catch (e) {}
      }
      function updateInfo() {
        // 接了「Latent」端口：信息窗显示「上游来源 + 缩放档位」，不再显示文件元数据
        if (wiredMode()) {
          const on = !!W["Latent缩放"]?.value;
          const ratio = W["缩放比例"]?.value ?? 1;
          const mult = W["对齐倍数"]?.value ?? "8";
          setInfoCells([
            ["🔗", "来源", "上游 Latent 端口"],
            ["⚙️", "缩放", on ? ("放大 ×" + ratio + "（对齐 " + mult + "）") : "原样透传"],
          ]);
          infoText = null; infoFor = "";
          return;
        }
        const cur = String(W["Latent文件"]?.value ?? "");
        if (!cur || cur === PLACEHOLDER) {
          setInfoLine("尚未选择 .latent 文件。\n点「📁 选择文件」上传，或从「文件」下拉里选择已上传的 .latent。");
          infoText = null; infoFor = "";
          return;
        }
        if (infoFor === cur && infoText) { setInfoCells(infoText); return; }
        setInfoLine(`文件：${cur}\n（正在读取信息…）`);
      }
      // 🔴🔴 只同步 DOM 样式，绝不改 node.size：曾经按 root 的 scrollHeight 自动撑高，
      //    而 DOM 控件层会把 root 拉伸到「节点高 − 标题栏」，它于是返回**拉伸后**的高度，
      //    再 +2 写回 node.size ⇒ 每次刷新 +2px ⇒ 无限膨胀 / 缩不下去。
      function applyLayout() {
        if (applying) return;
        applying = true;
        try {
          const avail = Math.max(0, Math.round((node.size?.[1] || 0) - chromeH()));
          if (avail > 0) root.style.maxHeight = avail + "px";
        } finally { applying = false; }
        node.setDirtyCanvas?.(true, true);
      }
      function refresh() {
        try { refreshInner(); } catch (e) { console.error("[Josia加载Latent] 显隐异常：", e); }
        try { syncAll(); } catch (e) { console.error("[Josia加载Latent] 同步异常：", e); }
        try { updateInfo(); } catch (e) { console.error("[Josia加载Latent] 信息异常：", e); }
        try { applyLayout(); } catch (e) { console.error("[Josia加载Latent] 布局异常：", e); }
        refreshInfo();
      }
      node._jllRefresh = refresh;

      /* ======================= 文件列表 / 信息 / 上传 ======================= */
      async function loadFiles() {
        try {
          const resp = await api.fetchApi("/josia_load_latent/list");
          const data = await resp.json();
          fileList = Array.isArray(data.files) ? data.files : [];
        } catch (e) { fileList = []; }
        refresh();
      }
      async function refreshInfo() {
        if (wiredMode()) return;              // 接线模式没有文件可读，直接跳过
        const cur = String(W["Latent文件"]?.value ?? "");
        if (!cur || cur === PLACEHOLDER) return;
        if (infoFor === cur && infoText) return;      // 已缓存 → 不再重新读盘
        try {
          const resp = await api.fetchApi(`/josia_load_latent/info?file=${encodeURIComponent(cur)}`);
          const d = await resp.json();
          if (!d.ok) {
            setInfoLine(`文件：${cur}\n读取信息失败：${d.error || "未知错误"}`);
            infoText = null; infoFor = "";
            applyLayout();
            return;
          }
          const kb = d.size ? (d.size / 1024).toFixed(1) + " KB" : "?";
          const cells = [["🎞️", "文件", d.name], ["💾", "大小", kb]];
          if (d.kind) cells.push(["🧬", "类型", d.kind]);
          if (d.shape) cells.push(["▦", "形状", d.shape]);
          if (d.dtype) cells.push(["🎯", "精度", d.dtype]);
          if (d.error) cells.push(["⚠️", "告警", d.error]);
          infoText = cells; infoFor = cur;
          setInfoCells(cells);
        } catch (e) {
          setInfoLine(`文件：${cur}\n读取信息失败：${e}`);
          infoText = null; infoFor = "";
        }
        applyLayout();
      }

      btnPick.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fileInput.click(); });
      fileInput.addEventListener("change", async () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        try {
          const fd = new FormData();
          fd.append("file", f, f.name);
          const resp = await api.fetchApi("/josia_load_latent/upload", { method: "POST", body: fd });
          const d = await resp.json();
          if (!d.ok) { setStatus(`⚠️ 上传失败：${d.error || "未知错误"}`, true); return; }
          fileList = Array.isArray(d.files) ? d.files : fileList;
          setWidgetValue(node, W["Latent文件"], d.name);
          infoText = null; infoFor = "";
          setStatus(`✅ 已上传：${d.name}`);
          refresh();
        } catch (err) {
          setStatus(`⚠️ 上传失败：${err}`, true);
        } finally {
          fileInput.value = "";
        }
      });
      btnOpen.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        try {
          const resp = await api.fetchApi("/josia_load_latent/open_dir", { method: "POST" });
          const d = await resp.json();
          if (!d.ok) setStatus(`⚠️ 打开目录失败：${d.error || "未知错误"}`, true);
          else setStatus(`📂 已打开：${d.path}`);
        } catch (err) {
          setStatus(`⚠️ 打开目录失败：${err}`, true);
        }
      });

      /* ======================= 布局 / 事件 ======================= */
      // 不再在 root 上挂「对高度也动作」的 ResizeObserver —— 那曾是「改高度 → 触发 → 再改高度」
      // 回路的其中一环；applyLayout 只同步 DOM 样式、不改 node.size，没有需要兜底的回流。
      // 🔴 刷新调度走 rAF 合帧：setTimeout(0) 执行时 Vue 可能还没把新尺寸提交进 DOM。
      let _healRaf = 0;
      function scheduleHeal() {
        if (_healRaf) return;
        _healRaf = requestAnimationFrame(() => {
          _healRaf = 0;
          applyLayout();
          node.setDirtyCanvas?.(true, true);
        });
      }
      node.onResize = function () {
        scheduleHeal();
      };

      // 🔴🔴 面板自愈观察器（Round 19 问题 3，同「Josia媒体保存」）：调完尺寸挪动节点后
      //    信息窗缩短且不再自适应、右键刷新才恢复 ＝ 官方按 bodyHeight 每帧重排面板高度，
      //    但「宽度变化引发的行重排」「maxHeight 过期」这两类错位没有任何触发点去纠正。
      //    监听 root 自身的盒子：宽度变了、或内容装不下（溢出）⇒ 重跑 applyLayout 对齐。
      //    回路安全性：我们从不写宽度，maxHeight 只影响高度且写入前由 applyLayout 统一算出；
      //    宽度事件只会来自用户/官方的真实尺寸变化。
      let _lastW = 0;
      try {
        const _ro = new ResizeObserver((entries) => {
          for (const en of entries) {
            const w = Math.round(en.contentRect.width);
            const changed = _lastW > 0 && Math.abs(w - _lastW) >= 1;
            _lastW = w;
            if (changed) { scheduleHeal(); continue; }
            try {
              if (root.scrollHeight > root.clientHeight + 2) scheduleHeal();
            } catch (e2) { /* 忽略 */ }
          }
        });
        _ro.observe(root);
      } catch (e) { /* 旧内核无 ResizeObserver 时忽略 */ }

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
      requestAnimationFrame(() => {
        refresh();
        loadFiles();
        applyLayout();
        widenAlignDrop();
        node.setDirtyCanvas?.(true, true);
      });

      // 🔴 DOM 是异步挂载的：一次量宽不一定量得到（面板还没被塞进外层盒子）⇒ 补几拍。
      //    widenAlignDrop 内部按「量到即锁定」实现，重复调用不会把宽度越乘越大。
      [0, 60, 300].forEach((ms) => setTimeout(() => {
        try { widenAlignDrop(); applyLayout(); } catch (e) { /* 忽略 */ }
      }, ms));

      // 🔴🔴🔴 绝不给 DOM 控件设 computeSize！（「高度无限增长」的直接元凶）
      //    `LGraphNode._arrangeWidgets()`：带 computeSize 的控件被当成**固定高度**
      //    （computedHeight = computeSize()[1] + 4），没有的走 computeLayoutSize 分支、
      //    作为**可伸缩**控件分到「节点剩余空间」，最后 `if (y > bodyHeight) setSize([w, y])` 撑高节点。
      //    此前给本控件加了 computeSize 覆写，且它回报的高度＝「节点可用高度」（由 node.size 推出）
      //    ⇒ computedHeight = node.size[1] − 28 ⇒ y 恒 > bodyHeight ⇒ **每帧撑高一点、无限膨胀**。
      //    正确做法＝本控件不定义 computeSize，走 computeLayoutSize（minHeight=0 / maxHeight 未定义）。
      const domWidget = node.addDOMWidget("load_latent_ui", "load_latent_ui", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 0,      // 不设下限 ⇒ 节点可自由缩小（面板内部滚动）
      });

      /* ================= 按住面板空白 ⇒ 移动节点 ================= */
      // 面板 CSS 已是 pointer-events:none（只有控件抢回 auto）⇒ 空白处的 pointerdown 原生落到
      // 下层 canvas，由官方 CanvasPointer 接管（拖动时 setPointerCapture ⇒ 拖出节点也不断）。
      // 这段是保险：万一某个上级容器仍写着 pointer-events:auto 把空白区吃掉，就捕获并转发给画布。
      const JLL_INTERACTIVE_SEL =
        ".jlc-info,input,textarea,button,select,a," +
        ".jlc-btn,.jlc-numwrap,.jlc-drop,.jlc-dot,.jlc-mask,.jlc-panel,.jlc-overlay";
      function isJllInteractive(t) {
        try { return !!(t && t.closest && t.closest(JLL_INTERACTIVE_SEL)); } catch (e) { return false; }
      }
      function forwardToCanvas(e) {
        const cv = app.canvas?.canvas;
        if (!cv) return;
        try { e.preventDefault(); e.stopPropagation(); } catch (err) { /* 忽略 */ }
        try {
          if (e.type === "wheel") {
            cv.dispatchEvent(new WheelEvent("wheel", {
              clientX: e.clientX, clientY: e.clientY,
              deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
              ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey,
              bubbles: true, cancelable: true,
            }));
          } else {
            cv.dispatchEvent(new PointerEvent(e.type, e));
          }
        } catch (err) { /* 忽略 */ }
      }
      // 🔴 宿主元素**必须在事件发生时再取**（addDOMWidget 之后 root 还不一定被塞进
      //    div.dom-widget —— 那是 Vue 组件 mount 后的 nextTick 才做的），同步取会得到 null
      //    ⇒ 以前这段转发根本没挂上。改成 document 级捕获 + 命中范围限定在「本面板那一层」。
      function jllHost() {
        try { return root.parentElement || root; } catch (e) { return root; }
      }
      const jllInOurBox = (t) => {
        if (!(t instanceof Node)) return false;
        const host = jllHost();
        if (!host || host === document.body || host === document.documentElement) return false;
        try { return host === t || host.contains(t); } catch (e) { return false; }
      };
      document.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 && e.button !== 1) return;
        if (!jllInOurBox(e.target)) return;
        if (isJllInteractive(e.target)) return;
        forwardToCanvas(e);
      }, true);
      document.addEventListener("wheel", (e) => {
        if (!jllInOurBox(e.target)) return;
        if (isJllInteractive(e.target)) return;
        forwardToCanvas(e);
      }, { capture: true, passive: false });
      document.addEventListener("dragstart", (e) => {
        if (!jllInOurBox(e.target)) return;
        if (isJllInteractive(e.target)) return;
        e.preventDefault();
      }, true);

      return r;
    };

    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      const node = this;
      if (node._jllRefresh) requestAnimationFrame(() => { node._jllRefresh(); });
      return r;
    };
  },
});
