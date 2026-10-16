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
 * ── 实现要点（全部依据前端源码取证，comfyui_frontend 1.53.6）─────────────
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
 *    （下拉高亮/筛选则走构造器包装，见 ⑦⑧——`window.LiteGraph.ContextMenu`
 *     就是 ComboWidget 引用的那个命名空间属性，官方核心扩展 contextMenuFilter
 *     同样这么打补丁，已验证可行。）
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
 * ⑥ 下拉菜单着色的兜底：万一某个 widget 没被装饰到（动态候选项后到、克隆竞态
 *    等），菜单条目仍可用 `dataset.value`（addItem 写入的原始值）推导子文件夹
 *    并上色 ⇒ 下拉里的着色不依赖装饰时序。
 *
 * ── 「下拉已选项高亮」（独立开关，作用于**所有** combo，不要求有子文件夹）───────
 *
 * ⑦ 怎么知道"哪一项是当前值"：
 *    · 2.0 Vue：reka-ui 的 ListboxItem 会输出 `role="option"` +
 *      `data-state="checked"|"unchecked"`（`ListboxItem.js:67/75`），官方自己就用
 *      `data-[state=checked]:bg-primary-background/20` 做淡高亮 ⇒ 直接读属性即可，
 *      零猜测。
 *    · 1.0 canvas 菜单：ContextMenu.addItem **完全不写选中态**（源码已核对：
 *      className 只有 `litemenu-entry submenu` + 可选 `disabled/separator/has_submenu`）。
 *      但 `element.dataset.value = String(value)` 保留着**原始值**（L287），
 *      而当前值只有 widget 自己知道。
 *      ⚠️ 早期版本给 widget 实例包 `onClick` 取 `this.value`——在**子图节点**上
 *      必然失效：SubgraphNode.widgets 是 getter，每次访问都新建代理对象
 *      （SubgraphNode.ts L126-142）；且画布点击走
 *      `toConcreteWidget(widget, node, false)` 再造临时实例
 *      （LGraphCanvas.ts L3111-3118），实例钩子随用随丢。着色只因写在
 *      共享 options 对象上才幸存。
 *      ✅ 现机制（全局补丁，与 widget 实例无关）：
 *        · 包 `LGraphCanvas.prototype.processWidgetClick`：画布上每次点 combo
 *          都会经过它（含子图代理），记录**原始 widget 的当前值**；
 *        · 包 `LiteGraph.ContextMenu` 构造器：dark 菜单（仅 combo 用）建好后，
 *          用记录值给根节点写 `dataset.josiaCur`，并立即着色 + 高亮。
 *          加了「该值必须真是本菜单某一条目」的校验，杜绝误伤其它 dark 菜单。
 *        · 实例 `onClick` 包装保留作补充路径（程序内直接调 widget.onClick 的场景）。
 *
 * ⑧ 高亮底色 = 该行 📂 段的颜色（直接读 splitTextNode 写好的 span，零重复计算）；
 *    无 📂（根目录模型 / 无子文件夹的 combo）→ 用 HL_ACCENT。为让白字可读，
 *    底色统一压暗 30%。只写 inline style，不动 DOM 结构、不动 class（Vue 只管
 *    class，不会打架）；每次处理都重设一遍，所以 colorize 把标题色写回也不会
 *    把白字冲掉。
 *
 * ── 「下拉快速筛选」（独立开关，1.0 菜单 + 2.0 Vue 全覆盖）──────────────────
 *
 * ⑨ 1.0 canvas 菜单：官方核心扩展 contextMenuFilter 自带筛选框，但它的出现条件
 *    是 `values.length > 4`——而着色开启后 ComboWidget 走 addItem 空值路径
 *    （ComboWidget.ts L149-172），条件被打破，官方筛选框**消失**。本扩展补上：
 *      · dark 菜单且条目 > 4 ⇒ 在菜单顶部插入筛选输入框（复用官方
 *        `comfy-context-menu-filter` 类，样式与官方完全一致；若官方框因故存在，
 *        先移除它，避免双输入框互相打架）；
 *      · 输入即筛：不匹配的条目 `display:none`，匹配字符包黄底 span；
 *      · 键盘：↑/↓ 在可见条目间移动光标（白色描边，不抢选中高亮的彩底），
 *        Enter 选中光标项，Esc 关闭菜单；底部溢出时自动上移菜单。
 *    ⑩ 2.0 Vue 下拉：官方 Combobox 已内置即时筛选（>4 选项出现搜索框），
 *     本扩展只做增强——钩住搜索框的 input 事件，给可见选项的匹配字符加黄底。
 *     黄底 span 与 📂 色 span 共存：匹配字符深色字、其余不变。
 */

import { app } from "/scripts/app.js";

const SETTING_ID = "JosiaNodes.ModelFolderColors";
const HL_SETTING_ID = "JosiaNodes.ComboSelectedHighlight";
const FILTER_SETTING_ID = "JosiaNodes.ComboQuickFilter";
const MENU_SMART_SETTING_ID = "JosiaNodes.ComboMenuSmart";
const MENU_MAXH_SETTING_ID = "JosiaNodes.ComboMenuMaxHeight";
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
let _filterEnabled = true;
/** 下拉菜单智能定位（限高 + 空间不足自动向上弹出） */
let _menuSmart = true;
/** 下拉菜单最大高度（像素）；0 = 按屏幕高度自动 */
let _menuMaxH = 0;
/** 已装饰 widget 的色表登记处 —— 下拉列表与折叠态共用，保证两处颜色一致 */
const MAPS = [];

// ─────────────────────── 已选项高亮（所有 combo 通用） ───────────────────────
const HL_ACCENT = "#3E82F7"; // 无子文件夹可依据时的强调色
const HL_DARKEN = 0.3; // 底色压暗比例：保证白字对比度
const HL_FG = "#ffffff";
const HL_ROW_SEL = 'span[data-josia-mfc="1"]';

/** 解析 #RRGGBB / #RGB / rgb(r,g,b) / rgba(...) → [r,g,b]；非法返回 null，绝不抛错。
 *  🔴 必须吃 rgb()：`span.style.color` 经 CSSOM 读回是 rgb() 形式，只认 hex 会让
 *  压暗静默失效（底色退化成原色甚至白色）。 */
function parseColor(c) {
  const s = String(c == null ? "" : c).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const h = m[1];
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16)
    ];
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}

/** 颜色各通道乘 (1-f)。非法输入原样返回，绝不抛错。 */
function darkenHex(hex, f) {
  const ch = parseColor(hex);
  if (!ch) return hex;
  const d = ch.map((v) => Math.round(v * (1 - f)));
  return "#" + d.map((v) => v.toString(16).padStart(2, "0")).join("");
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
 * 1.0 菜单的当前值记在容器 `dataset.josiaCur`（见 markOpenMenu / prepareDarkMenu）；
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

/**
 * 1.0：包装 widget 实例的 onClick —— 原方法同步建完菜单后立刻标记当前值。
 * 🔴 幂等标记必须打在**函数对象**上（`__josiaMfcHl`），不能打实例：
 *    子图节点的 widgets 是 getter 代理，每次访问都新建实例（实例标记必然丢），
 *    而 onClick 经代理 setter 写回内部真实 widget —— 按实例判断会每次多包一层。
 */
function installMenuHook(w) {
  if (!w || w.type !== "combo") return false;
  const orig = w.onClick;
  if (typeof orig !== "function") return false; // legacy widget.mouse 分支 → 放弃，不报错
  if (orig.__josiaMfcHl) {
    // 已包过（另一批代理实例先行）——沿用原包装，只补实例字段
    w._josiaHlWrapped = orig;
    w._josiaHlOrigClick = orig.__josiaMfcHlOrig;
    return true;
  }
  const wrapped = function (evt) {
    const r = orig.apply(this, arguments);
    try {
      if (_hlEnabled) markOpenMenu(this.value);
    } catch (e) {}
    return r;
  };
  wrapped.__josiaMfcHl = true;
  wrapped.__josiaMfcHlOrig = orig;
  w._josiaHlOrigClick = orig;
  w._josiaHlWrapped = wrapped;
  w.onClick = wrapped;
  return true;
}

function removeMenuHook(w) {
  if (!w) return false;
  const cur = w.onClick;
  if (!cur || !cur.__josiaMfcHl) {
    delete w._josiaHlOrigClick;
    delete w._josiaHlWrapped;
    return false;
  }
  const orig = cur.__josiaMfcHlOrig;
  try {
    if (typeof orig === "function") w.onClick = orig;
    else delete w.onClick;
  } catch (e) {}
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
  const opts = w.options || (w.options = {});
  // 🔴 幂等状态全部挂 options（共享对象），不挂实例：子图节点的 widgets 是
  //    getter 代理，每次访问新建实例（实例标记必丢），按实例判断会每次多包一层
  //    getOptionLabel —— MARK 越积越多，菜单最终糊成一排 📂；MAPS 也会爆涨。
  if (opts.__josiaMfcWrapped && opts.__josiaMfcMap) {
    w._josiaMfcMap = opts.__josiaMfcMap;
    w._josiaMfcWrapped = true;
    return true; // 已装饰过（值后到场景靠这里放行重装饰）
  }
  const values = readValues(w);
  if (!values || !values.length) return false;

  const keys = new Set();
  for (const v of values) {
    const k = subfolderKey(v);
    if (k) keys.add(k);
  }
  if (!keys.size) return false; // 没有子文件夹 → 这个下拉不处理

  const map = buildColorMap(keys);
  opts.__josiaMfcMap = map;
  w._josiaMfcMap = map;
  if (MAPS.indexOf(map) < 0) MAPS.push(map);

  // 链式保留原有 getOptionLabel（例如云端资源映射），只在其结果上加 📂。
  // 已包过（跨代理实例）就沿用，不重复包；wrapped 上记最原始的前任供卸载还原。
  if (!opts.getOptionLabel || !opts.getOptionLabel.__josiaMfc) {
    const prev = opts.getOptionLabel;
    const wrapped = function (value) {
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
    wrapped.__josiaMfc = true;
    wrapped.__josiaMfcOrig = prev;
    opts.getOptionLabel = wrapped;
  }
  opts.__josiaMfcWrapped = true;
  w._josiaMfcWrapped = true;
  return true;
}

function undecorateWidget(w) {
  if (!w) return false;
  // 只有「高亮」开关也关着才卸钩子，否则关着色会把高亮一起带走
  if (!_hlEnabled) removeMenuHook(w);
  const opts = w.options || {};
  delete w._josiaMfcWrapped;
  if (!opts.__josiaMfcWrapped) {
    delete w._josiaMfcMap;
    return false;
  }
  try {
    const cur = opts.getOptionLabel;
    if (cur && cur.__josiaMfc) {
      const orig = cur.__josiaMfcOrig;
      if (orig === undefined) delete opts.getOptionLabel;
      else opts.getOptionLabel = orig; // 恢复到最原始的前任（可能跨过多层代理）
    }
  } catch (e) {}
  const map = opts.__josiaMfcMap;
  const i = MAPS.indexOf(map);
  if (i >= 0) MAPS.splice(i, 1);
  delete opts.__josiaMfcWrapped;
  delete opts.__josiaMfcMap;
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
const SEL_VUE_SEARCH = '[data-testid="widget-select-default-search-input"]';
const SEL_SCAN = `${SEL_MENU}, ${SEL_VUE_OVERLAY}, ${SEL_VUE_TRIGGER}`;
/** 收尾帧的扫描范围：容器根（菜单根含全部条目 / Vue 浮层 / 折叠态触发器）。
 *  取色要看见同框所有条目才会选出覆盖键最多的色表，必须按根扫。 */
const SEL_SCAN_ROOT = `${SEL_MENU_ROOT}, ${SEL_VUE_OVERLAY}, ${SEL_VUE_TRIGGER}`;
/** 官方核心扩展的筛选输入类名；我们的输入框复用它，样式与官方完全一致 */
const NATIVE_FILTER_CLASS = "comfy-context-menu-filter";
const OUR_FILTER_CLASS = "josia-menu-filter";

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
 * 着色兜底：widget 没被 decorate 到（动态值后到 / 克隆竞态）时，**dark combo 菜单**的
 * 条目仍带 `dataset.value`（addItem 写入的原始值）。显示名与值一致（常规文件下拉）
 * 即可按值推导出同一套分段，视觉与 getOptionLabel 路径完全相同（含 📂 前缀）。
 * 显示名与值无关（云端映射等）返回 null，不硬塞。
 * 🔴 只认 dark 菜单：ContextMenu.addItem 给**所有**菜单项都写 dataset.value
 *    （右键菜单 / 添加节点菜单也有），不限定会把原生菜单一起着色。
 */
function fallbackInfo(entry, text) {
  const v = entry?.dataset?.value;
  if (v == null) return null;
  const s = String(v).replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  if (i <= 0) return null;
  const key = s.slice(0, i).toLowerCase();
  const norm = String(text).replace(/\\/g, "/");
  const idx = norm.toLowerCase().indexOf(key);
  if (idx < 0) return null; // 显示名与路径无关 → 不猜
  return {
    pre: idx > 0 ? norm.slice(0, idx) : "",
    gray: "",
    head: MARK + norm.slice(idx, idx + key.length),
    key,
    rest: norm.slice(idx + key.length),
  };
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
  tn._josiaTn = 1; // 标记：这是 colorize 负责收尾的规范文本节点（匹配高亮要保护它）
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
/**
 * 解析彩色 📂 段的文本 = MARK + 文件夹键。🔴 与 parseLabel 的分工：
 *   parseLabel 要求 mark 之后还有「/文件名」（拆分用）；
 *   而 📂 段自身只是「📂 文件夹」（fallbackInfo 产物不带斜杠），
 *   直接用 parseLabel 会返回 null ⇒ 每帧颜色刷新会漏。
 */
function parseSubSpan(text) {
  const s = String(text == null ? "" : text);
  if (s.indexOf(MARK) !== 0) return null;
  const key = s
    .slice(MARK.length)
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  if (!key) return null;
  return { head: s, key: key.toLowerCase(), rest: "" };
}

function colorizeContainer(el) {
  if (!el || !el.isConnected) return;

  // ① 已拆分的彩色 📂 段：highlight 每帧会把当前值那一行的 span 涂成 HL_FG 白，
  //    若不把文件夹色写回，下一轮 highlight 就会把白色当成文件夹色，底色退化成
  //    纯白（白字白底整行看不见）。🔴 按 span 查而不按文本节点查——筛选时它的
  //    文本被匹配高亮包在 span[data-josia-mh] 里，按文本节点查会漏。
  const refresh = [];
  try {
    for (const sp of el.querySelectorAll('span[data-josia-mfc="1"]')) {
      const info = parseSubSpan(sp.textContent || "");
      if (info && info.head) refresh.push({ sp, info });
    }
  } catch (e) {}

  // ② 未拆分的文本节点 → 拆分上色
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const entries = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.dataset?.josiaMfc) continue; // 我们自己插入的拆分段 → 跳过
    // 匹配高亮的包装/黄 span 内部文本 → 跳过（兜底推导会误读碎片）
    if (node.parentElement?.closest?.('span[data-josia-mh], span.josia-match')) continue;
    // Vue 全量重写规范文本节点时，它前面的匹配高亮包装已是陈旧片段 → 先摘掉
    if (node._josiaTn && node.nodeValue && /📂|💻/.test(node.nodeValue)) {
      let sib = node.previousSibling;
      while (sib && sib.nodeType === 1 && sib.dataset && sib.dataset.josiaMh) {
        const prev = sib.previousSibling;
        sib.remove();
        sib = prev;
      }
    }
    let info = parseLabel(node.nodeValue);
    if (!info) {
      // 兜底：仅 dark（combo）菜单、且条目还没有我们的拆分段结构时，才按
      // dataset.value 推导。🔴 两条限定都必不可少：
      //   · dark——右键/添加节点等原生菜单的条目也有 dataset.value；
      //   · 无既有结构——已装饰条目的 rest 尾段可能含文件夹名子串
      //     （Klein/Klein_9B_… 的尾段就有 klein），不限定会重复插 span 并把
      //     正确大小写的标题冲成小写。
      let entry = null;
      try {
        const root = node.parentElement?.closest?.(SEL_MENU_ROOT);
        if (root && root.classList && root.classList.contains("dark")) {
          const e = node.parentElement.closest(SEL_MENU);
          if (e && !e.querySelector("span[data-josia-mfc]")) entry = e;
        }
      } catch (e) {}
      if (entry) info = fallbackInfo(entry, node.nodeValue);
    }
    if (info) entries.push({ tn: node, info });
  }
  if (!entries.length && !refresh.length) return;

  const keys = new Set();
  for (const e of entries) if (e.info.key) keys.add(e.info.key);
  for (const r of refresh) if (r.info.key) keys.add(r.info.key);
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

  // 颜色来源优先级（拆分与刷新共用）：
  //   ① 容器里只有一个文件夹（已选值）→ 查 LABEL_CACHE，与列表那一行对齐；
  //   ② 选一张「覆盖本容器 key 最多」的色表 —— 保证同一个下拉里的颜色来自同一张表，
  //      因而不会出现重复色；
  //   ③ 都没有 → 纯名字主色兜底。
  const resolveHex = (info) => {
    if (!info.head) return null;
    const full = info.head + info.rest;
    if (!multi) {
      const cached = LABEL_CACHE.get(full); // ① 用户真的展开过列表 → 直接沿用那一行的颜色
      if (cached) return cached;
      // ② 没缓存（例如刚打开工作流、还没点开下拉）→ 找任一含该 key 的色表，
      //    优先最近登记的（更可能是当前节点自己的那张表），避免退化成裸哈希色。
      for (let i = MAPS.length - 1; i >= 0; i--) {
        const c = MAPS[i].get(info.key);
        if (c) return c;
      }
    }
    if (best) {
      const c = best.get(info.key); // ③ 同框多行 → 用覆盖键最多的表，天然去重
      if (c) return c;
    }
    return primaryColor(info.key); // ④ 兜底
  };

  for (const { tn, info } of entries) {
    let hex = null;
    if (info.head) {
      hex = resolveHex(info);
      if (multi) {
        if (LABEL_CACHE.size > 4096) LABEL_CACHE.clear();
        LABEL_CACHE.set(info.head + info.rest, hex);
      }
    }
    try {
      splitTextNode(tn, info, hex);
    } catch (e) {}
  }
  for (const { sp, info } of refresh) {
    const hex = resolveHex(info);
    if (hex) sp.style.color = hex;
  }
}

// ─────────────────────── 快速筛选（1.0 菜单 + 2.0 Vue） ───────────────────────
const MATCH_BG = "#ffd60a"; // 匹配字符黄底
const MATCH_FG = "#1f1f1f"; // 黄底上的深色字，保证对比度
const FILTER_MIN_ITEMS = 4; // 条目 > 4 才出现筛选框（与官方阈值一致）

/**
 * 还原一个容器内所有匹配高亮。
 * 黄 span → 纯文本；包装 span → 文本**并进后面的规范文本节点**后删除包装
 * （规范节点是 Vue 持有的引用，绝不能拆走或 normalize 掉）；最后把我们自己的
 * 拆分段容器内部相邻文本合并回去。幂等：调用后结构回到「colorize 之后的纯净态」。
 */
function clearMatchHighlight(root) {
  if (!root?.querySelectorAll) return;
  // ① 黄 span → 纯文本（原地，父容器不变）
  for (const sp of root.querySelectorAll("span.josia-match")) {
    sp.replaceWith(document.createTextNode(sp.textContent));
  }
  // ② 包装 span → 文本并进后续规范文本节点（Vue 引用保护），删掉包装
  for (const wrap of root.querySelectorAll("span[data-josia-mh]")) {
    let sib = wrap.nextSibling;
    while (sib && sib.nodeType !== 3) sib = sib.nextSibling;
    if (sib && sib._josiaTn) {
      sib.nodeValue = wrap.textContent + sib.nodeValue;
      wrap.remove();
    } else {
      wrap.replaceWith(document.createTextNode(wrap.textContent));
    }
  }
  // ③ 我们自己的拆分段容器（sub/dir/pre）内部合并相邻文本节点
  for (const sp of root.querySelectorAll("span[data-josia-mfc]")) {
    try {
      sp.normalize();
    } catch (e) {}
  }
}

/**
 * 给容器内所有文本节点的匹配字符包黄底 span。
 * 逐文本节点独立匹配（不跨 📂 分段）；规范文本节点（colorize 收尾的那个）只缩
 * 成尾段、片段装进前置包装 span，保证 Vue 重写 / colorize 重入时语义不破。
 */
function applyMatchHighlight(root, query) {
  if (!root || !query) {
    clearMatchHighlight(root);
    return;
  }
  clearMatchHighlight(root); // 先还原到纯净态，再重建（幂等）
  const q = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue) continue;
    targets.push(node);
  }
  for (const tn of targets) {
    const text = tn.nodeValue;
    const lower = text.toLowerCase();
    if (lower.indexOf(q) < 0) continue;
    // 切分为 [文本, 匹配, 文本, 匹配, …]
    const parts = [];
    let i = 0;
    while (i < text.length) {
      const j = lower.indexOf(q, i);
      if (j < 0) {
        parts.push(text.slice(i));
        break;
      }
      if (j > i) parts.push(text.slice(i, j));
      parts.push({ m: text.slice(j, j + q.length) });
      i = j + q.length;
    }
    const makeMatch = (t) => {
      const sp = document.createElement("span");
      sp.className = "josia-match";
      sp.textContent = t;
      sp.style.backgroundColor = MATCH_BG;
      sp.style.color = MATCH_FG;
      return sp;
    };
    if (tn._josiaTn) {
      // 规范节点：尾段留在原节点，其余装进前置包装 span（Vue 仍持有原节点引用）
      const last = parts[parts.length - 1];
      tn.nodeValue = last && typeof last === "string" ? last : "";
      const wrap = document.createElement("span");
      wrap.dataset.josiaMh = "1";
      for (let k = 0; k < parts.length - 1; k++) {
        const p = parts[k];
        wrap.appendChild(
          typeof p === "string" ? document.createTextNode(p) : makeMatch(p.m)
        );
      }
      if (wrap.childNodes.length) tn.parentNode.insertBefore(wrap, tn);
    } else {
      // 普通文本节点（sub/dir/pre span 内部等）：包进包装 span 后就地替换。
      // 🔴 必须带包装：裸文本/裸黄 span 会被 colorize 的兜底推导当候选误读。
      const wrap = document.createElement("span");
      wrap.dataset.josiaMh = "1";
      for (const p of parts) {
        wrap.appendChild(
          typeof p === "string" ? document.createTextNode(p) : makeMatch(p.m)
        );
      }
      tn.parentNode.replaceChild(wrap, tn);
    }
  }
}

/** 菜单距视口边缘的留白 */
const MENU_EDGE = 8;

/**
 * 菜单最大高度：0 = 按屏幕高度自动（2K 屏 800 / 1K 屏 500 / 小屏 340），
 * 与「屏幕分辨率的一定比例」等价；填了具体像素就用填的值。
 */
function menuCapHeight() {
  if (_menuMaxH > 0) return _menuMaxH;
  const h = window.innerHeight || document.documentElement.clientHeight || 900;
  if (h >= 1400) return 800; // 2560×1440 一档
  if (h >= 1000) return 500; // 1920×1080 一档
  return 340; // 小屏兜底
}

/**
 * 1.0 菜单布局：先按「最大高度」限高（覆盖官方 80vh），空间不足时**向上翻**，
 * 锚点是当前 rect.top（官方已按点击位置放好）；上方也放不下才贴底。
 * 节点靠近屏幕底部时，官方行为会把 80vh 的菜单压成一小条，这里改成整条翻上去。
 * 关「智能定位」设置时完全不动，跟随官方。
 */
function repositionMenu(root) {
  if (!root || !root.style || !_menuSmart) return;
  try {
    const cap = menuCapHeight();
    if (cap > 0) root.style.maxHeight = cap + "px";
    const r = root.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    if (r.bottom > vh - MENU_EDGE) {
      // 上翻优先：菜单底边落到锚点上方 6px；上方也塞不下才贴底
      let top = r.top - r.height - 6;
      if (top < MENU_EDGE) top = Math.max(MENU_EDGE, vh - r.height - MENU_EDGE);
      root.style.top = top + "px";
    } else if (r.top < MENU_EDGE) {
      root.style.top = MENU_EDGE + "px";
    }
    const r2 = root.getBoundingClientRect();
    if (r2.right > vw - 4) root.style.left = Math.max(4, vw - r2.width - 4) + "px";
    else if (r2.left < 4) root.style.left = "4px";
  } catch (e) {}
}

/** 关「智能定位」时还原官方限高（位置留待下次开下拉自然复位） */
function resetMenuCap() {
  try {
    for (const root of document.querySelectorAll(SEL_MENU_ROOT)) {
      if (root.style) root.style.maxHeight = "";
    }
  } catch (e) {}
}

/**
 * 给 1.0 dark 菜单装筛选输入框（条目 > FILTER_MIN_ITEMS 才装）。
 * 官方原生筛选框（非着色 combo 会有）先移除——它的方向键逻辑会把选中行涂成
 * 灰底，和我们的彩底选中高亮打架；统一用我们这套（筛选 + 黄匹配 + 键盘）。
 */
function installMenuFilter(ctx, root) {
  if (root.querySelector("input")) return;
  const items = [...root.querySelectorAll(SEL_MENU)];
  if (items.length <= FILTER_MIN_ITEMS) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = `${NATIVE_FILTER_CLASS} ${OUR_FILTER_CLASS}`;
  input.placeholder = "筛选…";
  input.spellcheck = false;
  input.setAttribute("data-josia-mfc-filter", "1");
  root.prepend(input);

  let visible = items.slice();
  let cursor = -1;

  const applyCursor = () => {
    for (const it of items) it.style.outline = "";
    if (cursor >= 0 && items[cursor]) {
      items[cursor].style.outline = "1px solid rgba(255,255,255,.9)";
      items[cursor].style.outlineOffset = "-1px";
      try {
        items[cursor].scrollIntoView({ block: "nearest" });
      } catch (e) {}
    }
  };
  const stepCursor = (dir) => {
    if (!visible.length) {
      cursor = -1;
      applyCursor();
      return;
    }
    let i = cursor < 0 ? (dir > 0 ? items.length - 1 : 0) : cursor;
    for (let k = 0; k < items.length; k++) {
      i = (i + dir + items.length) % items.length;
      if (visible.indexOf(items[i]) >= 0) {
        cursor = i;
        break;
      }
    }
    applyCursor();
  };

  // 初始光标落在「当前值」那一行（筛选后也优先可见的当前值）
  const cur = root.dataset.josiaCur;
  if (cur !== undefined) {
    const i = items.findIndex((e) => e.dataset.value === cur);
    if (i >= 0) cursor = i;
  }
  if (cursor < 0 && visible.length) cursor = items.indexOf(visible[0]);

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    visible = [];
    for (const it of items) {
      const show = !q || (it.textContent || "").toLowerCase().indexOf(q) >= 0;
      it.style.display = show ? "" : "none";
      if (show) visible.push(it);
    }
    cursor = visible.length ? items.indexOf(visible[0]) : -1;
    applyCursor();
    applyMatchHighlight(root, q);
    repositionMenu(root);
  });

  input.addEventListener("keydown", (ev) => {
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        stepCursor(1);
        break;
      case "ArrowUp":
        ev.preventDefault();
        stepCursor(-1);
        break;
      case "Enter":
        ev.preventDefault();
        if (cursor >= 0 && items[cursor]) items[cursor].click();
        break;
      case "Escape":
        ev.preventDefault();
        try {
          ctx.close();
        } catch (e) {}
        break;
      default:
        break;
    }
  });

  requestAnimationFrame(() => {
    try {
      input.focus({ preventScroll: true });
    } catch (e) {}
    repositionMenu(root);
  });
}

/** 关闭筛选开关：摘掉已开菜单里的筛选框，还原条目显示与匹配高亮 */
function clearAllFilters() {
  try {
    for (const root of document.querySelectorAll(SEL_MENU_ROOT)) {
      const input = root.querySelector(`input.${OUR_FILTER_CLASS}`);
      if (input) input.remove();
      for (const it of root.querySelectorAll(SEL_MENU)) {
        it.style.display = "";
        it.style.outline = "";
      }
      clearMatchHighlight(root);
    }
    for (const ov of document.querySelectorAll(SEL_VUE_OVERLAY)) {
      clearMatchHighlight(ov);
    }
  } catch (e) {}
}

// ─────────────────── 全局补丁：让高亮/筛选适配所有场景 ───────────────────
/**
 * 子图节点（以及一切「widget 对象会换」的场景）上，实例钩子随用随丢：
 *   · SubgraphNode.widgets 是 getter，每次访问新建代理（SubgraphNode.ts L126-142）
 *   · 画布点击 toConcreteWidget 再造临时实例（LGraphCanvas.ts L3111-3118）
 * 所以改成两条与 widget 实例无关的全局通道：
 *   ① 包 LGraphCanvas.prototype.processWidgetClick —— 画布上每次点 combo 都经过
 *      它（代理也带 .value / .type），记录原始当前值；
 *   ② 包 LiteGraph.ContextMenu 构造器 —— dark 菜单（仅 combo 用 className:'dark'）
 *      建好后，用记录值写 dataset.josiaCur 并即时着色 + 高亮 + 装筛选框。
 *      与官方核心扩展 contextMenuFilter 同一打法（它也是这么包的）。
 */
let _lastComboValue; // 最近一次画布 combo 点击的当前值
let _lastComboAt = 0; // 记录时间（performance.now），超窗口视为陈旧
const COMBO_RECORD_WINDOW = 1500;

function patchCanvasWidgetClick() {
  const LG = window.LiteGraph;
  const Canvas = LG && LG.LGraphCanvas;
  if (!Canvas || !Canvas.prototype || Canvas.prototype.__josiaMfcPWC) return;
  const orig = Canvas.prototype.processWidgetClick;
  if (typeof orig !== "function") return;
  const wrapped = function (e, node, widget, pointer) {
    const r = orig.apply(this, arguments);
    try {
      if (widget && widget.type === "combo") {
        _lastComboValue = String(widget.value ?? "");
        _lastComboAt = performance.now();
      }
    } catch (err) {}
    return r;
  };
  wrapped.__josiaMfcPWC = true;
  Canvas.prototype.processWidgetClick = wrapped;
}

function patchContextMenu() {
  const LG = window.LiteGraph;
  if (!LG || typeof LG.ContextMenu !== "function" || LG.ContextMenu.__josiaMfcCM) return;
  const Orig = LG.ContextMenu;
  function Patched(values, options) {
    const ctx = new Orig(values, options);
    try {
      // className:'dark' 只有 combo 下拉用（ComboWidget.ts L153/L181）
      if (options && options.className === "dark") onDarkMenu(ctx);
    } catch (e) {}
    return ctx;
  }
  Patched.prototype = Orig.prototype;
  Patched.__josiaMfcCM = true;
  LG.ContextMenu = Patched;
}

function onDarkMenu(ctx) {
  const root = ctx && ctx.root;
  if (!root) return;
  try {
    // 官方原生筛选框先移除（非着色 combo 会带上它），避免双输入框打架
    const native = root.querySelector(`input.${NATIVE_FILTER_CLASS}`);
    if (native) native.remove();
  } catch (e) {}
  // ComboWidget 建完菜单后同步 addItem；microtask 时机必然晚于整轮 onClick，
  // 此时实例钩子（若装了）也已写好 dataset.josiaCur。
  queueMicrotask(() => {
    try {
      if (root.isConnected) prepareDarkMenu(ctx, root);
    } catch (e) {}
  });
}

/** dark 菜单就绪：补装饰（动态值后到/克隆竞态自愈）→ 标记当前值 → 着色 → 高亮 → 装筛选框 */
function prepareDarkMenu(ctx, root) {
  let entries;
  try {
    entries = root.querySelectorAll(SEL_MENU);
  } catch (e) {
    return;
  }
  if (!entries || !entries.length) return;

  applyAll(); // 自愈：onNodeCreated 时值还没到的 widget，现在补上着色包装
  hookGraphNodeAdded(app.graph); // app.graph 可能已换过（切工作流/子图），补绑

  if (root.dataset.josiaCur === undefined && _hlEnabled) {
    const v = _lastComboValue;
    // 双重校验：记录要新，且该值必须真是本菜单的某一条 ⇒ 杜绝误伤别的 dark 菜单
    if (v !== undefined && performance.now() - _lastComboAt < COMBO_RECORD_WINDOW) {
      for (const e of entries) {
        if (e.dataset && e.dataset.value === v) {
          root.dataset.josiaCur = v;
          break;
        }
      }
    }
  }
  if (_enabled) colorizeContainer(root); // 先上 📂 色，高亮才有底色可继承
  if (_hlEnabled) highlightContainer(root);
  if (_filterEnabled) installMenuFilter(ctx, root);
  // 无论有没有筛选框都要限高/翻方向（条目 ≤4 不装筛选框，同样可能溢出）
  requestAnimationFrame(() => {
    try {
      if (root.isConnected) repositionMenu(root);
    } catch (e) {}
  });
}

function installGlobalPatches() {
  patchCanvasWidgetClick();
  patchContextMenu();
}

/**
 * 供自定义 UI 节点（如 LoRA 堆叠的自绘下拉）记录「当前选中值」：
 * 它们的点击不走画布 processWidgetClick，不开这条通道，dark 菜单的当前值
 * 高亮就取不到值。窗口期内该值必须是某菜单的条目才会被采用（防误伤）。
 */
window.JosiaMFC = window.JosiaMFC || {};
window.JosiaMFC.noteComboValue = function (v) {
  try {
    _lastComboValue = String(v ?? "");
    _lastComboAt = performance.now();
  } catch (e) {}
};

/**
 * 动态候选项后到 / 克隆 / 工作流加载的自愈：新增节点时补装饰（hook 事件而非轮询）。
 * 必须链式保留前端自己的 onNodeAdded；app.graph 会随切工作流/进退子图更换，
 * 每次 prepareDarkMenu（开下拉，低频）都检查补绑。
 */
function hookGraphNodeAdded(g) {
  try {
    if (!g || g.__josiaMfcNodeAdded) return;
    const prev = typeof g.onNodeAdded === "function" ? g.onNodeAdded : null;
    g.__josiaMfcNodeAdded = (node) => {
      if (prev) {
        try {
          prev(node);
        } catch (e) {}
      }
      requestAnimationFrame(() => {
        try {
          applyAll();
        } catch (e) {}
      });
    };
    g.onNodeAdded = g.__josiaMfcNodeAdded;
  } catch (e) {}
}

// ─────────────────────────── 2.0 Vue 筛选增强 ───────────────────────────
/** 给 Vue 下拉的官方搜索框绑一次 input 监听（幂等） */
function bindVueSearch(overlay) {
  try {
    const input = overlay.querySelector(SEL_VUE_SEARCH);
    if (!input || input.__josiaMfcBound) return;
    input.__josiaMfcBound = true;
    input.addEventListener("input", () => scheduleColorize());
  } catch (e) {}
}

/**
 * 每帧颜色/高亮收尾：Vue overlay 还要按官方搜索框的当前输入补黄底高亮
 * （筛选本身官方 Combobox 已做，这里只增强匹配字符的黄色背景）；
 * 1.0 菜单的黄匹配也要随每帧 colorize 重建（colorize 会重写 sub 段文本）。
 */
function applyVueFilterPass() {
  for (const ov of document.querySelectorAll(SEL_VUE_OVERLAY)) {
    if (!ov.isConnected) continue;
    bindVueSearch(ov);
    // 预标记选项标签的文本节点为「规范节点」：无子文件夹的选项从没被 colorize
    // 处理过，不标记的话匹配高亮会直接换掉 Vue 持有的文本节点（引用失效）。
    try {
      for (const opt of ov.querySelectorAll(SEL_STATE_ITEM)) {
        const host = opt.querySelector("span.truncate") || opt;
        for (const c of host.childNodes) {
          if (c.nodeType === 3 && c.nodeValue) c._josiaTn = 1;
        }
      }
    } catch (e) {}
    let q = "";
    try {
      const input = ov.querySelector(SEL_VUE_SEARCH);
      q = input ? String(input.value || "").trim() : "";
    } catch (e) {}
    if (_filterEnabled && q) applyMatchHighlight(ov, q.toLowerCase());
    else clearMatchHighlight(ov);
  }
}

function applyCanvasFilterPass() {
  for (const root of document.querySelectorAll(SEL_MENU_ROOT)) {
    if (!root.isConnected) continue;
    let input = null;
    try {
      input = root.querySelector(`input.${OUR_FILTER_CLASS}`);
    } catch (e) {}
    if (!input) continue;
    const q = String(input.value || "").trim().toLowerCase();
    applyMatchHighlight(root, q); // q 空时内部即 clear
  }
}

let _scheduled = false;
function scheduleColorize() {
  if (_scheduled) return;
  _scheduled = true;
  requestAnimationFrame(() => {
    _scheduled = false;
    try {
      // 🔴 扫「根」而不是「条目」：colorize 的取色要看同框所有条目才会选出
      //    覆盖键最多的色表（multi/best），逐条目扫会把多行下拉当成单行，
      //    每帧刷新时颜色可能和兄弟行不一致。
      for (const el of document.querySelectorAll(SEL_SCAN_ROOT)) {
        if (_enabled) colorizeContainer(el); // 先上 📂 色，高亮才有底色可继承
        if (_hlEnabled) highlightContainer(el); // 再按选中态涂底/反白
      }
      if (_filterEnabled) {
        applyVueFilterPass();
        applyCanvasFilterPass();
      }
    } catch (e) {}
  });
}

/** 这个新增/变更的节点值不值得管 —— 尽量廉价，避免给全局 UI 添负担 */
function isInteresting(n) {
  if (!n) return false;
  // 我们自己的匹配高亮结构（包装 span / 黄 span 及其内部文本）→ 不关，
  // 否则 applyMatchHighlight 的每次重建都会再触发一轮调度，形成空转
  if (n.nodeType === 3) {
    const v = n.nodeValue;
    if (
      typeof v === "string" &&
      (v.indexOf(MARK) >= 0 || v.indexOf(PARENT_MARK) >= 0) &&
      !(n.parentElement?.closest?.('span[data-josia-mh], span.josia-match'))
    ) {
      return true;
    }
    return false;
  }
  if (n.nodeType !== 1) return false;
  if (n.closest?.('span[data-josia-mh], span.josia-match')) return false;
  if (n.matches?.(SEL_SCAN)) return true;
  if (n.querySelector?.(SEL_SCAN)) return true;
  // reka-ui 的分批挂载：item 可能晚于 overlay 单独插入，此时要顺着祖先找回 overlay
  return !!(n.closest && n.closest(SEL_VUE_OVERLAY));
}

function installObserver() {
  if (!window.MutationObserver || window.__josiaMfcObserver) return;
  const start = () => {
    if (!document.body || window.__josiaMfcObserver) return;
    installGlobalPatches(); // LiteGraph 此时必然就绪，补一次（幂等）
    const obs = new MutationObserver((records) => {
      if (!_enabled && !_hlEnabled && !_filterEnabled) return; // 三个开关都关才彻底歇工
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
    {
      id: FILTER_SETTING_ID,
      name: "下拉快速筛选",
      type: "boolean",
      defaultValue: true,
      category: ["⚡️JosiaNodes", "下拉筛选"],
      tooltip:
        "下拉列表顶部出现筛选框，输入即筛选包含所输入字符的选项，" +
        "匹配字符带黄色背景。方向键移动、回车选中、Esc 关闭。" +
        "只影响显示，不改变实际取值。",
      onChange: (v) => {
        _filterEnabled = !!v;
        if (_filterEnabled) {
          scheduleColorize();
        } else {
          clearAllFilters();
        }
      },
    },
    {
      id: MENU_SMART_SETTING_ID,
      name: "下拉菜单智能定位",
      type: "boolean",
      defaultValue: true,
      category: ["⚡️JosiaNodes", "下拉菜单"],
      tooltip:
        "下拉菜单高度不超过「最大高度」，节点靠近屏幕底部时菜单整体向上弹出，" +
        "不再被压成一小条。关闭后完全跟随官方默认行为（80vh 限高、可能被压短）。",
      onChange: (v) => {
        _menuSmart = !!v;
        if (_menuSmart) {
          for (const root of document.querySelectorAll(SEL_MENU_ROOT)) {
            if (root.isConnected) repositionMenu(root);
          }
        } else {
          resetMenuCap();
        }
      },
    },
    {
      id: MENU_MAXH_SETTING_ID,
      name: "下拉菜单最大高度",
      type: "number",
      defaultValue: 0,
      category: ["⚡️JosiaNodes", "下拉菜单"],
      tooltip:
        "像素值。0 = 按屏幕高度自动（2K 屏约 800、1K 屏约 500、更小屏约 340）；" +
        "填具体数值则所有下拉都按这个高度上限弹出（空间不足时自动向上翻）。",
      onChange: (v) => {
        let n = Number(v);
        if (!isFinite(n) || n < 0) n = 0;
        _menuMaxH = Math.min(Math.round(n), 4000);
        if (_menuSmart) {
          for (const root of document.querySelectorAll(SEL_MENU_ROOT)) {
            if (root.isConnected) repositionMenu(root);
          }
        }
      },
    },
  ],

  init() {
    const v = readSetting(SETTING_ID);
    if (v !== undefined && v !== null) _enabled = !!v;
    const hv = readSetting(HL_SETTING_ID);
    if (hv !== undefined && hv !== null) _hlEnabled = !!hv;
    const fv = readSetting(FILTER_SETTING_ID);
    if (fv !== undefined && fv !== null) _filterEnabled = !!fv;
    const sm = readSetting(MENU_SMART_SETTING_ID);
    if (sm !== undefined && sm !== null) _menuSmart = !!sm;
    const mh = Number(readSetting(MENU_MAXH_SETTING_ID));
    if (isFinite(mh) && mh >= 0) _menuMaxH = Math.min(Math.round(mh), 4000);
    installGlobalPatches();
    installObserver();
  },

  async setup() {
    installGlobalPatches();
    installObserver();
    applyAll();
    hookGraphNodeAdded(app.graph);
  },

  async beforeRegisterNodeDef(nodeType /*, nodeData */) {
    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      orig?.apply(this, arguments);
      const node = this;
      if (!_enabled && !_hlEnabled && !_filterEnabled) return; // 任一开关开着都要跑（高亮不依赖着色）
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
