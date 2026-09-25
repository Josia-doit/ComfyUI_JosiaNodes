/**
 * JosiaNodes · 模型子文件夹着色（全局功能）
 *
 * 作用范围：ComfyUI 内**所有** combo（模型 / 文件选择）下拉。只要候选项里存在
 *          带子文件夹的路径，就会：
 *            1) 在子文件夹前加一个 📂 前缀（**只改显示名，不动实际值**）；
 *            2) 给每个子文件夹分配一个**稳定**颜色，下拉列表里把「📂 + 子文件夹」
 *               与文件名分成两段，只给前一段上色。
 *
 * 开关：设置 → ⚡️JosiaNodes → 模型列表 → 「模型子文件夹着色」，默认开启。
 *
 * ── 实现要点（全部依据前端源码取证，comfyui_frontend 1.51.10）─────────────
 *
 * ① 显示钩子用官方的 `widget.options.getOptionLabel`。已核对它是**纯显示层**，
 *    不会污染 value：
 *      · ComboWidget._displayValue  → 用它渲染折叠态文字（canvas fillText）
 *      · ComboWidget.onClick        → 有它时走 `menu.addItem(label, value, …)`，
 *        **label 与 value 分离**；而 ContextMenu 里 `element.value = value`、
 *        点击回调 `options.callback.call(this, value, …)` 传的都是**原始值**，
 *        所以选中的仍是真实模型路径。（源码：ContextMenu.addItem L280 / L320-343）
 *      · WidgetSelectDefault.getOptionLabel → 2.0 Vue 下拉的 label
 *    ⇒ 只影响显示，对执行零风险。
 *
 * ② 着色：因为上面三处拿到的都是**纯字符串**（1.0 折叠态是 canvas 绘制，无法局部
 *    着色），所以只在两处 DOM 环境里后处理：
 *      · 1.0 下拉菜单：`div.litemenu-entry`（菜单挂在 document.body 上）
 *      · 2.0 Vue：`[data-testid="widget-select-default-trigger|overlay"]`
 *    两处都用同一个「拆文本节点」函数：把 `📂 子文件夹` 拆成一个带色 span，
 *    把 `💻 父级/`（JosiaCheckpointPlus 父级前缀）拆成浅灰 span 弱化显示，
 *    剩下的 `/文件名` 留在原文本节点里。
 *
 * ③ 为什么不用「patch LiteGraph.ContextMenu.prototype」：ComboWidget 引用的是
 *    **模块作用域**里的 ContextMenu，并不保证等于 `window.LiteGraph.ContextMenu`，
 *    打补丁可能静默失效。改成对 document.body 做 MutationObserver，与实现类无关。
 *
 * ④ 为什么「拆文本节点 + 复用前一个兄弟节点」而不是整体 innerHTML 替换：
 *    Vue 的 `{{ option.label }}` 是单文本子节点（PatchFlags.TEXT），更新时会对
 *    **同一个文本节点**写 nodeValue。若我们把它的父节点 innerHTML 整个换掉，
 *    Vue 之后仍在写那个已脱离文档的旧文本节点 ⇒ 标签会**卡在旧值**。
 *    保留文本节点、只在其前面插一个带色 span，则：
 *      · Vue 改写 nodeValue → characterData 事件 → 我们再拆一次（并复用已有 span）
 *      · 不会被卡住，也不会重复插入。
 *
 * ⑤ 1.0 节点折叠态是 canvas 单色绘制，无法只给文件夹段上色 ⇒ 按约定保留统一的
 *    📂 前缀、不着色。
 *
 * ── 「下拉已选项高亮」（独立开关，作用于**所有** combo，不要求有子文件夹）───────
 *
 * ⑥ 怎么知道"哪一项是当前值"：
 *    · 2.0 Vue：reka-ui 的 ListboxItem 会输出 `role="option"` +
 *      `data-state="checked"|"unchecked"`（`ListboxItem.js:67/75`），官方自己就用
 *      `data-[state=checked]:bg-primary-background/20` 做淡高亮 ⇒ 直接读属性即可，
 *      零猜测。
 *    · 1.0 canvas 菜单：ContextMenu.addItem **完全不写选中态**（源码已核对：
 *      className 只有 `litemenu-entry submenu` + 可选 `disabled/separator/has_submenu`）。
 *      但 `element.dataset.value = String(value)` 保留着**原始值**，而当前值只有
 *      ComboWidget 自己知道。`LGraphCanvas.processWidgetClick` 是
 *      `pointer.onClick = () => widgetInstance.onClick({e,node,canvas})` ——
 *      **实例属性调用**，因此给 widget 实例包一层 onClick 是最贴合的注入点：
 *      原方法同步建完菜单并挂到 body 之后再回来标记，时序天然正确。
 *    · 兜底：onClick 包不上（legacy `widget.mouse` 分支）时只是**不生效**，不报错。
 *
 * ⑦ 高亮底色 = 该行 📂 段的颜色（直接读 splitTextNode 写好的 span，零重复计算）；
 *    无 📂（根目录模型 / 无子文件夹的 combo）→ 用 HL_ACCENT。为让白字可读，
 *    底色统一压暗 30%。只写 inline style，不动 DOM 结构、不动 class（Vue 只管
 *    class，不会打架）；每次处理都重设一遍，所以 colorize 把标题色写回也不会
 *    把白字冲掉。
 */

import { app } from "/scripts/app.js";

const SETTING_ID = "JosiaNodes.ModelFolderColors";
const HL_SETTING_ID = "JosiaNodes.ComboSelectedHighlight";
const MARK = "📂 ";
/** JosiaCheckpointPlus 父级类别前缀（checkpoint_plus.js 注入）：整段浅灰弱化，不占 12 色环 */
const PARENT_MARK = "💻 ";
const DIR_GRAY = "#8a8a8a";

// ─────────────────────────── 颜色引擎 ───────────────────────────
// 12 色环：色相等距展开，饱和度/亮度统一压到深浅主题都能读的区间
const PALETTE = [
  "#E5484D", // 红
  "#E8730C", // 橙
  "#D9A400", // 琥珀
  "#8FBF00", // 黄绿
  "#46A758", // 绿
  "#12A594", // 青绿
  "#00A2C7", // 青
  "#3E82F7", // 蓝
  "#6E56CF", // 靛
  "#AB4ABA", // 紫
  "#E93D82", // 品红
  "#B5714B", // 棕
];
const N = PALETTE.length;
// 与 N(12) 互质的步长 —— 保证「撞色顺延」时能遍历整个色环
const STEPS = [1, 5, 7, 11];

/** FNV-1a 32 位哈希：雪崩效应好，krea1 / krea2 只差一个字符也会落到不同色位 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 取子文件夹键（完整子路径、小写归一）；文件在根目录时返回 null */
function subfolderKey(value) {
  if (value == null) return null;
  const s = String(value).replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  if (i <= 0) return null;
  return s.slice(0, i).toLowerCase();
}

/**
 * 给一组子文件夹算颜色：
 *   1) 主色 = 名字哈希 % 12  —— 稳定：同名永远同色，重启/换机都不变
 *   2) 同框去重：按字典序依次落位，撞了才沿色环顺延（步长也由哈希推出）
 * 只有真撞色的文件夹才偏移，没撞的永远保持主色 ⇒ 不打乱用户的颜色记忆。
 */
function buildColorMap(keys) {
  const sorted = Array.from(keys).sort();
  const taken = new Set();
  const map = new Map();
  for (const k of sorted) {
    const h = fnv1a(k);
    const step = STEPS[Math.floor(h / N) % STEPS.length];
    let slot = h % N;
    for (let i = 0; i < N && taken.has(slot); i++) slot = (slot + step) % N;
    taken.add(slot);
    map.set(k, PALETTE[slot]);
  }
  return map;
}

/** 兜底色：不依赖任何同框集合，纯按名字定色 */
function primaryColor(key) {
  return PALETTE[fnv1a(key) % N];
}

// ─────────────────────────── widget 装饰 ───────────────────────────
let _enabled = true;
let _hlEnabled = true;
/** 已装饰 widget 的色表登记处 —— 下拉列表与折叠态共用，保证两处颜色一致 */
const MAPS = [];

// ─────────────────────── 已选项高亮（所有 combo 通用） ───────────────────────
const HL_ACCENT = "#3E82F7"; // 无子文件夹可依据时的强调色
const HL_DARKEN = 0.3; // 底色压暗比例：保证白字对比度
const HL_FG = "#ffffff";
const HL_ROW_SEL = 'span[data-josia-mfc="1"]';

/** #RRGGBB 各通道乘 (1-f)。非法输入原样返回，绝不抛错。 */
function darkenHex(hex, f) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.round(v * (1 - f))
  );
  return "#" + ch.map((v) => v.toString(16).padStart(2, "0")).join("");
}

function rowSpan(entry) {
  try {
    return entry.querySelector ? entry.querySelector(HL_ROW_SEL) : null;
  } catch (e) {
    return null;
  }
}

/** 这一行当前的 📂 颜色（由 splitTextNode 写入）；没有 📂 或已关闭着色时返回 null */
function rowBaseColor(entry) {
  const sp = rowSpan(entry);
  const c = sp?.style?.color;
  return c ? c : null;
}

function clearRowHighlight(entry) {
  if (!entry?.dataset || entry.dataset.josiaHl !== "1") return;
  const sp = rowSpan(entry);
  if (sp && entry.dataset.josiaHlPrev) sp.style.color = entry.dataset.josiaHlPrev;
  delete entry.dataset.josiaHlPrev;
  entry.style.backgroundColor = "";
  entry.style.color = "";
  delete entry.dataset.josiaHl;
}

/** 幂等：重复调用只刷新样式，`josiaHlPrev` 只在第一次记录，撤销时能还原标题色 */
function applyRowHighlight(entry, hex) {
  if (!entry?.dataset) return;
  const sp = rowSpan(entry);
  if (sp) {
    if (entry.dataset.josiaHl !== "1") {
      entry.dataset.josiaHlPrev = sp.style.color || "";
    }
    sp.style.color = HL_FG; // colorize 每次会把标题色写回来，这里必须每次重置
  }
  entry.style.backgroundColor = hex;
  entry.style.color = HL_FG;
  entry.dataset.josiaHl = "1";
}

/**
 * 处理一个下拉容器：把「当前值那一行」涂成彩色底 + 白字。
 * 1.0 菜单的当前值记在容器 `dataset.josiaCur`（见 installMenuHook）；
 * 2.0 Vue 直接问 reka 的 `data-state="checked"`。
 */
function highlightContainer(el) {
  if (!el || !el.isConnected) return;
  let isVue = false;
  try {
    isVue = !!(el.matches && el.matches(SEL_VUE_OVERLAY));
  } catch (e) {}
  let entries;
  try {
    entries = el.querySelectorAll(isVue ? SEL_STATE_ITEM : SEL_MENU);
  } catch (e) {
    return;
  }
  if (!entries || !entries.length) return;

  const cur = el.dataset ? el.dataset.josiaCur : undefined;
  for (const entry of entries) {
    let selected = false;
    if (isVue) {
      selected = entry.getAttribute?.("data-state") === "checked";
    } else {
      const v = entry.dataset ? entry.dataset.value : undefined;
      selected = cur !== undefined && v !== undefined && v === cur;
    }
    if (selected) {
      const base = rowBaseColor(entry) || HL_ACCENT;
      applyRowHighlight(entry, darkenHex(base, HL_DARKEN));
    } else {
      clearRowHighlight(entry);
    }
  }
}

/** 1.0：包装 widget 实例的 onClick —— 原方法同步建完菜单后立刻标记当前值 */
function installMenuHook(w) {
  if (!w || w.type !== "combo" || w._josiaHlWrapped) return false;
  const orig = w.onClick;
  if (typeof orig !== "function") return false; // legacy widget.mouse 分支 → 放弃，不报错
  const wrapped = function (evt) {
    const r = orig.apply(this, arguments);
    try {
      if (_hlEnabled) markOpenMenu(this.value);
    } catch (e) {}
    return r;
  };
  w._josiaHlOrigClick = orig;
  w._josiaHlWrapped = wrapped;
  w.onClick = wrapped;
  return true;
}

function removeMenuHook(w) {
  if (!w || !w._josiaHlWrapped) return false;
  if (typeof w._josiaHlOrigClick === "function") w.onClick = w._josiaHlOrigClick;
  delete w._josiaHlOrigClick;
  delete w._josiaHlWrapped;
  return true;
}

/** 取最上层的 1.0 菜单（刚由 onClick 挂到 body），记下当前值并立即上高亮 */
function markOpenMenu(value) {
  const menus = document.querySelectorAll(SEL_MENU_ROOT);
  const menu = menus[menus.length - 1];
  if (!menu || !menu.dataset) return;
  menu.dataset.josiaCur = String(value ?? "");
  if (_enabled) colorizeContainer(menu); // 保证这一行已有 📂 色可继承（rAF 通常还没跑到）
  highlightContainer(menu);
}

/** 关闭开关时的全量还原 */
function clearAllHighlights() {
  try {
    for (const el of document.querySelectorAll(`${SEL_MENU_ROOT}, ${SEL_VUE_OVERLAY}`)) {
      let list;
      try {
        list = el.querySelectorAll(`${SEL_MENU}, ${SEL_STATE_ITEM}`);
      } catch (e) {
        continue;
      }
      for (const entry of list) clearRowHighlight(entry);
    }
  } catch (e) {}
}

function readSetting(id) {
  try {
    if (app.ui?.settings?.getSettingValue) return app.ui.settings.getSettingValue(id);
    if (app.extensionManager?.settings?.getSettingValue) {
      return app.extensionManager.settings.getSettingValue(id);
    }
    if (app.settings?.getSettingValue) return app.settings.getSettingValue(id);
    if (app.settings?.get) return app.settings.get(id);
  } catch (e) {}
  return undefined;
}

/** 解析 combo 的候选值：数组 / 对象 / 函数（KJNodes 那种 duck-typed 写法）都支持 */
function readValues(w) {
  try {
    const v = w?.options?.values;
    if (typeof v === "function") {
      const r = v(w, w?.node);
      return Array.isArray(r) ? r : null;
    }
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return Object.keys(v);
    return null;
  } catch (e) {
    return null;
  }
}

function decorateWidget(w) {
  if (!w || w.type !== "combo") return false;
  installMenuHook(w); // 高亮：所有 combo 都要，和「有没有子文件夹」无关
  const values = readValues(w);
  if (!values || !values.length) return false;

  const keys = new Set();
  for (const v of values) {
    const k = subfolderKey(v);
    if (k) keys.add(k);
  }
  if (!keys.size) return false; // 没有子文件夹 → 这个下拉不处理

  const map = buildColorMap(keys);
  w._josiaMfcMap = map;
  if (MAPS.indexOf(map) < 0) MAPS.push(map);

  // 链式保留原有 getOptionLabel（例如云端资源映射），只在其结果上加 📂
  if (!w._josiaMfcWrapped) {
    const prev = w.options.getOptionLabel;
    w._josiaMfcPrev = prev;
    w._josiaMfcWrapped = function (value) {
      let base;
      try {
        base = typeof prev === "function" ? prev(value) : value;
      } catch (e) {
        base = value;
      }
      base = base == null ? "" : String(base);
      if (!_enabled) return base;
      const key = subfolderKey(value);
      if (!key) return base;
      const norm = base.replace(/\\/g, "/");
      const idx = norm.toLowerCase().indexOf(key);
      if (idx < 0) return base; // 显示名与实际路径无关（云端等）→ 不硬塞
      return base.slice(0, idx) + MARK + base.slice(idx);
    };
    w.options.getOptionLabel = w._josiaMfcWrapped;
  }
  return true;
}

function undecorateWidget(w) {
  if (!w) return false;
  // 只有「高亮」开关也关着才卸钩子，否则关着色会把高亮一起带走
  if (!_hlEnabled) removeMenuHook(w);
  if (!w._josiaMfcWrapped) return false;
  try {
    if (w._josiaMfcPrev === undefined) delete w.options.getOptionLabel;
    else w.options.getOptionLabel = w._josiaMfcPrev;
  } catch (e) {}
  const map = w._josiaMfcMap;
  const i = MAPS.indexOf(map);
  if (i >= 0) MAPS.splice(i, 1);
  delete w._josiaMfcWrapped;
  delete w._josiaMfcPrev;
  delete w._josiaMfcMap;
  return true;
}

function eachNode(fn) {
  const nodes = app.graph?._nodes;
  if (!Array.isArray(nodes)) return;
  for (const n of nodes) {
    if (!n?.widgets) continue;
    let touched = false;
    for (const w of n.widgets) {
      if (fn(w) === true) touched = true;
    }
    if (touched) {
      try {
        n.setDirtyCanvas(true, false);
      } catch (e) {}
    }
  }
}

function applyAll() {
  eachNode((w) => decorateWidget(w));
}
function revertAll() {
  eachNode((w) => undecorateWidget(w));
}

// ─────────────────────────── DOM 着色（1.0 菜单 + 2.0 Vue） ───────────────────────────
const SEL_MENU_ROOT = "div.litecontextmenu";
const SEL_MENU = "div.litemenu-entry";
/** 2.0 下拉项：reka-ui ListboxItem → role=option + data-state=checked|unchecked */
const SEL_STATE_ITEM = '[role="option"][data-state]';
const SEL_VUE_OVERLAY = '[data-testid="widget-select-default-overlay"]';
const SEL_VUE_TRIGGER = '[data-testid="widget-select-default-trigger"]';
const SEL_SCAN = `${SEL_MENU}, ${SEL_VUE_OVERLAY}, ${SEL_VUE_TRIGGER}`;

/**
 * 从下拉项文本里切出着色分段。兼容三种形态：
 *   ① 「📂 子文件夹/文件名」                    → pre="" gray="" head="📂 子文件夹" rest="/文件名"
 *   ② 「💻 父级/📂 子文件夹/文件名」            → pre="" gray="💻 父级/" head="📂 子文件夹" rest="/文件名"
 *   ③ 「💻 父级/文件名」（着色关/根目录模型）    → pre="" gray="💻 父级/" head="" rest="文件名"
 * 📂 / 💻 允许出现在文本任意位置（前面有其他前缀时切进 pre，保持原色）。
 */
function parseLabel(text) {
  if (typeof text !== "string") return null;
  const subIdx = text.indexOf(MARK);
  const dirIdx = text.indexOf(PARENT_MARK);
  if (subIdx < 0 && dirIdx < 0) return null;

  let pre = "";
  let gray = "";
  let head = "";
  let key = null;
  let rest = "";

  if (dirIdx >= 0 && (subIdx < 0 || dirIdx < subIdx)) {
    pre = dirIdx > 0 ? text.slice(0, dirIdx) : "";
    if (subIdx >= 0) {
      gray = text.slice(dirIdx, subIdx);
      const body = text.slice(subIdx + MARK.length).replace(/\\/g, "/");
      const i = body.lastIndexOf("/");
      if (i <= 0) return null;
      head = MARK + body.slice(0, i);
      key = body.slice(0, i).toLowerCase();
      rest = body.slice(i);
    } else {
      // 没有 📂（着色关闭或根目录模型）：灰段只覆盖「💻 父级/」，文件名保持原色
      const rel = text.slice(dirIdx + PARENT_MARK.length);
      const slash = rel.indexOf("/");
      if (slash < 0) return null;
      gray = PARENT_MARK + rel.slice(0, slash + 1);
      rest = rel.slice(slash + 1);
    }
  } else {
    pre = subIdx > 0 ? text.slice(0, subIdx) : "";
    const body = text.slice(subIdx + MARK.length).replace(/\\/g, "/");
    const i = body.lastIndexOf("/");
    if (i <= 0) return null;
    head = MARK + body.slice(0, i);
    key = body.slice(0, i).toLowerCase();
    rest = body.slice(i);
  }

  return { pre, gray, head, key, rest };
}

/**
 * 就地拆一个文本节点为最多三段（均在文本节点前，顺序固定）：
 *   [pre 纯文本段（极少见）][dir 浅灰「💻 父级/」段][sub 彩色「📂 子文件夹」段][文本「/文件名」]
 * 复用已存在的 span（按 data-josia-mfc 角色识别），可被反复调用而不重复插入，
 * Vue 改写文本节点 nodeValue 后再拆一次即可收敛。
 */
function splitTextNode(tn, info, hex) {
  if (!info) return false;
  const map = { pre: null, dir: null, sub: null };
  let cur = tn.previousSibling;
  while (cur && cur.nodeType === 1 && cur.dataset && cur.dataset.josiaMfc) {
    map[cur.dataset.josiaMfc] = cur;
    cur = cur.previousSibling;
  }
  const parent = tn.parentNode;

  // ③ 彩色 📂 子文件夹段 —— 已选项高亮靠 selector [data-josia-mfc="1"] 取它的颜色
  let sub = map.sub;
  if (info.head) {
    if (!sub) {
      sub = document.createElement("span");
      sub.dataset.josiaMfc = "1";
      parent.insertBefore(sub, tn);
    }
    if (sub.textContent !== info.head) sub.textContent = info.head;
    sub.style.color = hex; // 用 textContent/style 写入，天然免疫 HTML 注入
  } else if (sub) {
    sub.remove();
    sub = null;
  }

  // ② 浅灰父级目录段（弱化存在感，只提示层级作用）
  let dir = map.dir;
  if (info.gray) {
    if (!dir) {
      dir = document.createElement("span");
      dir.dataset.josiaMfc = "dir";
      parent.insertBefore(dir, sub || tn);
    }
    if (dir.textContent !== info.gray) dir.textContent = info.gray;
    dir.style.color = DIR_GRAY;
  } else if (dir) {
    dir.remove();
    dir = null;
  }

  // ① 更前面的纯文本前缀（保持原色）
  let pre = map.pre;
  if (info.pre) {
    if (!pre) {
      pre = document.createElement("span");
      pre.dataset.josiaMfc = "pre";
      parent.insertBefore(pre, dir || sub || tn);
    }
    if (pre.textContent !== info.pre) pre.textContent = info.pre;
  } else if (pre) {
    pre.remove();
  }

  // 写 nodeValue 会再触发一次 characterData；此时已不带标记，会自然收敛
  if (tn.nodeValue !== info.rest) tn.nodeValue = info.rest;
  return true;
}

/** 标签 → 颜色缓存：由「下拉列表」（多个文件夹同框）写入，供「已选值」复用，
 *  这样已选文字的颜色必定与它在列表里的那一行一致。 */
const LABEL_CACHE = new Map();

/**
 * 处理一个容器：遍历它内部的文本节点，逐个拆分上色。
 *
 * 颜色来源优先级：
 *   ① 容器里只有一个文件夹（已选值）→ 查 LABEL_CACHE，与列表那一行对齐；
 *   ② 选一张「覆盖本容器 key 最多」的色表 —— 保证同一个下拉里的颜色来自同一张表，
 *      因而不会出现重复色；
 *   ③ 都没有 → 纯名字主色兜底。
 */
function colorizeContainer(el) {
  if (!el || !el.isConnected) return;

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const entries = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.dataset?.josiaMfc) continue; // 我们自己插入的拆分段 → 跳过
    const info = parseLabel(node.nodeValue);
    if (info) entries.push({ tn: node, info });
  }
  if (!entries.length) return;

  const keys = new Set();
  for (const e of entries) if (e.info.key) keys.add(e.info.key);
  const multi = keys.size > 1; // 多个文件夹同框 ⇒ 这是一份真正的下拉列表
  let best = null;
  let bestScore = -1;
  for (const m of MAPS) {
    let s = 0;
    for (const k of keys) if (m.has(k)) s++;
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }

  for (const { tn, info } of entries) {
    let hex = null;
    if (info.head) {
      const full = info.head + info.rest;
      if (!multi) {
        hex = LABEL_CACHE.get(full); // ① 用户真的展开过列表 → 直接沿用那一行的颜色
        if (!hex) {
          // ② 没缓存（例如刚打开工作流、还没点开下拉）→ 找任一含该 key 的色表，
          //    优先最近登记的（更可能是当前节点自己的那张表），避免退化成裸哈希色。
          for (let i = MAPS.length - 1; i >= 0; i--) {
            const c = MAPS[i].get(info.key);
            if (c) {
              hex = c;
              break;
            }
          }
        }
      }
      if (!hex && best) hex = best.get(info.key); // ③ 同框多行 → 用覆盖键最多的表，天然去重
      if (!hex) hex = primaryColor(info.key); // ④ 兜底
      if (multi) {
        if (LABEL_CACHE.size > 4096) LABEL_CACHE.clear();
        LABEL_CACHE.set(full, hex);
      }
    }
    try {
      splitTextNode(tn, info, hex);
    } catch (e) {}
  }
}

let _scheduled = false;
function scheduleColorize() {
  if (_scheduled) return;
  _scheduled = true;
  requestAnimationFrame(() => {
    _scheduled = false;
    try {
      for (const el of document.querySelectorAll(SEL_SCAN)) {
        if (_enabled) colorizeContainer(el); // 先上 📂 色，高亮才有底色可继承
        if (_hlEnabled) highlightContainer(el); // 再按选中态涂底/反白
      }
    } catch (e) {}
  });
}

/** 这个新增/变更的节点值不值得管 —— 尽量廉价，避免给全局 UI 添负担 */
function isInteresting(n) {
  if (!n) return false;
  if (n.nodeType === 3) {
    const v = n.nodeValue;
    return (
      typeof v === "string" &&
      (v.indexOf(MARK) >= 0 || v.indexOf(PARENT_MARK) >= 0)
    );
  }
  if (n.nodeType !== 1) return false;
  if (n.matches?.(SEL_SCAN)) return true;
  if (n.querySelector?.(SEL_SCAN)) return true;
  // reka-ui 的分批挂载：item 可能晚于 overlay 单独插入，此时要顺着祖先找回 overlay
  return !!(n.closest && n.closest(SEL_VUE_OVERLAY));
}

function installObserver() {
  if (!window.MutationObserver || window.__josiaMfcObserver) return;
  const start = () => {
    if (!document.body || window.__josiaMfcObserver) return;
    const obs = new MutationObserver((records) => {
      if (!_enabled && !_hlEnabled) return; // 两个开关都关才彻底歇工
      for (const r of records) {
        if (r.type === "characterData") {
          if (isInteresting(r.target)) return scheduleColorize();
          continue;
        }
        for (const n of r.addedNodes || []) {
          if (isInteresting(n)) return scheduleColorize();
        }
      }
    });
    // characterData：Vue 改写 nodeValue（下拉项/已选文字更新）
    // childList：菜单被挂到 body、Vue 替换元素文本
    obs.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.__josiaMfcObserver = obs;
    scheduleColorize();
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}

/** 关闭开关时把已上色的 DOM 还原（文本并回去、去掉所有拆分段 span） */
function clearDomColors() {
  LABEL_CACHE.clear();
  for (const span of document.querySelectorAll('span[data-josia-mfc]')) {
    const next = span.nextSibling;
    if (next && next.nodeType === 3) {
      next.nodeValue = span.textContent + next.nodeValue;
    } else if (span.parentNode) {
      span.parentNode.insertBefore(document.createTextNode(span.textContent), span);
    }
    span.remove();
  }
}

// ─────────────────────────── 扩展注册 ───────────────────────────
app.registerExtension({
  name: "JosiaNodes.ModelFolderColors",
  settings: [
    {
      id: SETTING_ID,
      name: "模型子文件夹着色",
      type: "boolean",
      defaultValue: true,
      category: ["⚡️JosiaNodes", "模型列表"],
      tooltip:
        "在所有模型/文件下拉里，给子文件夹加 📂 前缀，并按文件夹名分配一个稳定颜色。" +
        "同名文件夹永远同色；同一个下拉内不会出现重复颜色。只影响显示，不改变实际路径。",
      onChange: (v) => {
        _enabled = !!v;
        if (_enabled) {
          applyAll();
          scheduleColorize();
        } else {
          clearDomColors();
          revertAll();
          scheduleColorize(); // 高亮改用强调色兜底，需要重涂一遍
        }
        try {
          app.graph?.setDirtyCanvas(true, true);
        } catch (e) {}
      },
    },
    {
      id: HL_SETTING_ID,
      name: "下拉已选项高亮",
      type: "boolean",
      defaultValue: true,
      category: ["⚡️JosiaNodes", "下拉高亮"],
      tooltip:
        "在所有下拉列表里，把「当前已选中」的那一项涂成彩色底 + 白色文字。" +
        "底色跟随该行的 📂 子文件夹颜色；没有子文件夹时用固定强调色。" +
        "只影响显示，不改变实际取值。",
      onChange: (v) => {
        _hlEnabled = !!v;
        if (_hlEnabled) {
          applyAll(); // 补装 hook（之前关过的话）
          scheduleColorize();
        } else {
          clearAllHighlights();
          eachNode((w) => {
            removeMenuHook(w);
            return false;
          });
        }
      },
    },
  ],

  init() {
    const v = readSetting(SETTING_ID);
    if (v !== undefined && v !== null) _enabled = !!v;
    const hv = readSetting(HL_SETTING_ID);
    if (hv !== undefined && hv !== null) _hlEnabled = !!hv;
    installObserver();
  },

  async setup() {
    installObserver();
    applyAll();
  },

  async beforeRegisterNodeDef(nodeType /*, nodeData */) {
    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      orig?.apply(this, arguments);
      const node = this;
      if (!_enabled && !_hlEnabled) return; // 任一开关开着都要跑（高亮不依赖着色）
      const run = () => {
        if (!node.widgets) return;
        for (const w of node.widgets) decorateWidget(w);
        try {
          node.setDirtyCanvas(true, false);
        } catch (e) {}
      };
      run();
      // 兜底：部分节点的候选项（动态清单）在 onNodeCreated 之后才补齐
      queueMicrotask(run);
    };
  },
});
