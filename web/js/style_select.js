/**
 * Josia 风格选择节点前端扩展
 * 节点标识：JosiaStyleSelect（与后端 style_select.py 的 NODE_CLASS_MAPPINGS 键一致）
 *
 * 布局约定（重要）：
 *  - 用户提示词使用「原生多行文本控件」，这样 LiteGraph 才会把该输入端口的圆点
 *    对齐到文本框上（自建 textarea 会导致端口跑到 CLIP 端口上方）。
 *  - 主题 / 分类 / 搜索条 / 预览网格 / 提示词格式 由 DOM 控件承载。
 *  - 预览网格用「JS 计算固定列宽 + grid-auto-rows 像素值」，行列完全确定，
 *    不会出现缩略图叠放；列数随容器宽度自适应。
 *  - 文本框与预览网格高度随节点高度按比例分配。
 */
import { app } from "../../../scripts/app.js";

const MULTI_MAX = 3;      // 多选叠加上限
const HOVER_DELAY = 240;  // 悬停浮窗延迟(ms)

// ---------------- 尺寸常量 ----------------
const TILE_MIN = 96;          // 单个预览图最小边长（决定每行数量）
const GAP = 8;                // 网格间距
const TA_MIN = 130;           // 文本框默认高度
const CHROME = 56;            // 标题栏 + 槽位 + 内边距（微调减少底部多余空间）
const CTRL_FALLBACK = 210;    // 控件区高度兜底值
const POP_IMG = 512;          // 悬停浮窗图片显示边长（回退到原尺寸）
const POP_INFO_W = 480;       // 右侧文本区宽度（收窄让浮窗紧凑，文本填满高度）
const OLD_DEFAULT_W = 757;    // 上一版默认节点宽度（4 列基础宽再 +1/3），用于识别未自定义加宽/仍过宽的节点
const GRID_MAX_H = 800;       // 预览网格高度上限(px)：仅用于 1.0 经典路径；远高于正常尺寸，不影响自由缩放

// ---------------- Node 2.0(Vue) 检测 ----------------
// 仅以官方内部标志 LiteGraph.vueNodesMode 为唯一判据（严格 === true）；取不到时返回 false。
// 默认 false ⇒ 走 1.0 经典路径，保证经典界面行为与上一版完全一致、绝不被误伤。
// （历史教训：曾用设置项 + 多重兜底判据做检测，在 1.0 下误判为 true，导致四个节点自定义 UI 全部失效。）
function isVueNodes2() {
  try {
    const lg = (typeof window !== "undefined" && window.LiteGraph) ? window.LiteGraph : null;
    return !!(lg && lg.vueNodesMode === true);
  } catch (e) { return false; }
}

// ---------------- 分类双语 ----------------
const SECTION_ORDER = ["3D Render", "Anime", "Cartoon", "Comics", "Cover Art",
  "Design", "Digital Painting", "Drawing", "Painting", "Photography"];
const SECTION_CN = {
  "3D Render": "3D渲染", "Anime": "动漫", "Cartoon": "卡通", "Comics": "漫画",
  "Cover Art": "封面艺术", "Design": "设计", "Digital Painting": "数字绘画",
  "Drawing": "素描", "Painting": "绘画", "Photography": "摄影",
};
const sectionLabel = (s) => s ? `${SECTION_CN[s] || s} · ${s}` : s;

const THEME_NONE = "请选择主题…";
const THEME_LABEL = { krea2: "Krea2" };
const themeDisplay = (id) =>
  (!id || id === THEME_NONE) ? THEME_NONE : (THEME_LABEL[id] || (id.charAt(0).toUpperCase() + id.slice(1)));

const getWidget = (node, name) => node.widgets?.find((w) => w.name === name);

function pushSelected(node, names) {
  const w = getWidget(node, "selected_styles");
  if (!w) return;
  w.value = JSON.stringify(names);
  w.callback?.(w.value, app.canvas, node);
}
function readSelected(node) {
  const w = getWidget(node, "selected_styles");
  if (!w || !w.value) return [];
  try { const v = JSON.parse(w.value); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}

function pushMultiValue(node, val) {
  const w = getWidget(node, "multi_select");
  if (!w) return;
  w.value = val ? "true" : "false";
  w.callback?.(w.value, app.canvas, node);
}
function readMulti(node) {
  const w = getWidget(node, "multi_select");
  return !!w && w.value === "true";
}

// ===========================================================================
// 悬停大图浮窗（全局单例）
//   纯展示：无按钮 / 无滚动条 / 图片按原始分辨率
//   右侧为「风格提示词」中英双版（上中文、下英文），字号自动收缩保证不溢出
// ===========================================================================
let hoverPopup = null;

function getHoverPopup() {
  if (hoverPopup) return hoverPopup;
  const pop = document.createElement("div");
  pop.className = "josia-hover-pop";
  pop.style.cssText =
    "position:fixed;z-index:10002;display:none;pointer-events:none;" +
    "width:auto;max-width:94vw;background:#16161c;border:1px solid #3a3a46;" +
    "border-radius:12px;overflow:hidden;box-shadow:0 20px 70px rgba(0,0,0,.62);" +
    "font-family:'PingFang SC','Microsoft YaHei',sans-serif;color:#e8e8ee;";
  const LB = "font-size:11px;color:#8b8b98;letter-spacing:.5px;margin-bottom:5px;";
  pop.innerHTML =
    '<div style="display:flex;align-items:flex-start;">' +
      // ---- 左：大图（原始分辨率）----
      '<div style="flex:0 0 ' + POP_IMG + 'px;height:' + POP_IMG + 'px;background:#0d0d10;' +
        'display:flex;align-items:center;justify-content:center;">' +
        '<img style="width:' + POP_IMG + 'px;height:' + POP_IMG + 'px;object-fit:contain;display:block;" />' +
      '</div>' +
      // ---- 右：信息面板（高度=图片高度；宽度收窄到约 2/3，文本换行更密填满高度）----
      '<div class="jp-info" style="flex:0 0 ' + POP_INFO_W + 'px;width:' + POP_INFO_W + 'px;min-width:0;height:' + POP_IMG + 'px;overflow:hidden;' +
        'padding:18px 20px;display:flex;flex-direction:column;gap:11px;background:#1c1c22;box-sizing:border-box;">' +
        '<div style="flex:0 0 auto;">' +
          '<div class="jp-cn" style="font-size:19px;font-weight:700;color:#fff;line-height:1.3;"></div>' +
          '<div class="jp-en" style="font-size:12px;color:#9a9aa6;margin-top:3px;line-height:1.4;"></div>' +
          '<div class="jp-sec" style="font-size:12px;color:#6fb3ff;margin-top:5px;"></div>' +
        '</div>' +
        '<div style="flex:0 0 auto;">' +
          '<div style="' + LB + '">风格提示词（中文）</div>' +
          '<div class="jp-cn-prompt" style="font-size:13px;line-height:1.6;color:#dcdce6;white-space:pre-wrap;"></div>' +
        '</div>' +
        '<div style="flex:0 0 auto;">' +
          '<div style="' + LB + '">风格提示词（English）</div>' +
          '<div class="jp-en-prompt" style="font-size:12px;line-height:1.55;color:#a9a9b6;white-space:pre-wrap;"></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.append(pop);
  hoverPopup = pop;
  return pop;
}

/** 字号自适应：逐步缩小两段提示词的字号，直到右栏不再溢出（无滚动条） */
function fitHoverText(pop) {
  const info = pop.querySelector(".jp-info");
  const cn = pop.querySelector(".jp-cn-prompt");
  const en = pop.querySelector(".jp-en-prompt");
  if (!info || !cn || !en) return;
  let cnPx = 13, enPx = 12, guard = 0;
  const apply = () => {
    cn.style.fontSize = cnPx.toFixed(1) + "px";
    en.style.fontSize = enPx.toFixed(1) + "px";
  };
  apply();
  while (info.scrollHeight > info.clientHeight + 1 && cnPx > 9.5 && guard++ < 60) {
    cnPx -= 0.4;
    enPx = Math.max(9, enPx - 0.35);
    apply();
  }
}

function showHover(entry, anchorEl) {
  const pop = getHoverPopup();
  pop.querySelector(".jp-cn").textContent = entry.name_cn || entry.name;
  pop.querySelector(".jp-en").textContent = entry.name || "";
  pop.querySelector(".jp-sec").textContent = entry.section ? sectionLabel(entry.section) : "";
  pop.querySelector(".jp-cn-prompt").textContent = entry.prompt_cn || "（暂无中文译文）";
  pop.querySelector(".jp-en-prompt").textContent = entry.prompt || "";
  pop.querySelector("img").src =
    `/josia_style/${encodeURIComponent(entry._theme)}/thumb?file=${encodeURIComponent(entry.thumb)}`;

  pop.style.display = "block";
  pop.style.left = "0px";
  pop.style.top = "0px";
  fitHoverText(pop);

  const r = anchorEl.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = r.right + 12;
  if (left + pw > window.innerWidth - 8) left = r.left - pw - 12;
  if (left < 8) left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
  let top = r.top + r.height / 2 - ph / 2;
  top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
  pop.style.left = left + "px";
  pop.style.top = top + "px";
}
function hideHover() { if (hoverPopup) hoverPopup.style.display = "none"; }

// ===========================================================================
// 主 UI
// ===========================================================================
app.registerExtension({
  name: "JosiaNodes.JosiaStyleSelect",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "JosiaStyleSelect") return;

    // 节点尺寸稳定性：Node 2.0 高度无限生长的修复见 applyLayout 中对预览网格高度的上限钳制
    // （GRID_MAX_H），此处不覆写 computeSize，以免破坏 1.0 下节点自由缩放能力。

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    const onConfigure = nodeType.prototype.onConfigure;
    const origResize = nodeType.prototype.onResize;

    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      const node = this;

      // ---- 原生控件 ----
      const promptW = getWidget(node, "prompt");   // 保留可见：端口对齐由它保证
      const themeW = getWidget(node, "theme");
      const formatW = getWidget(node, "format");
      const selW = getWidget(node, "selected_styles");
      const multiW = getWidget(node, "multi_select");

      // 隐藏的仅作数据载体的控件（它们没有输入端口，不会影响端口位置）
      // 注意：经典 LiteGraph 依据 widget.hidden 判定显隐，而 Node 2.0(Vue) 依据 widget.options.hidden
      // （见 useProcessedWidgets 的 isWidgetVisible 与 extractWidgetDisplayOptions）。
      // 两者都设才能在两个渲染器下都隐藏；隐藏不影响取值与序列化。
      [themeW, formatW, selW, multiW].forEach((w) => {
        if (!w) return;
        w.hidden = true;
        w.options = w.options || {};
        w.options.hidden = true;
        w.computeSize = () => [0, 0];
      });

      // 原生多行文本框的悬浮提示
      try {
        const ta = promptW?.element || promptW?.inputEl || promptW?.textarea;
        if (ta && ta.style) {
          ta.title = "用户提示词：在这里输入你自己的提示词。\n"
            + "上方选中的风格会按下方「提示词格式」与这段文字拼合，一起送入 CLIP 编码。";
        }
      } catch (e) { /* 忽略 */ }

      const state = { theme: "", styles: [], selected: [], multi: false };
      let tileSize = TILE_MIN;
      let applying = false;
      let isDragging = false;       // 拖拽进行中：隐藏悬浮窗、拦截 click 误选中
      let dragJustEnded = false;    // 拖拽刚结束：拦截紧随其后的 click 事件

      // 网格行高辅助：最小行数 / 默认行数（用于固定下限，不随实时 tileSize 变化）
      const GRID_MIN_ROWS = 2;
      const GRID_DEF_ROWS = 3;
      const gridRowsH = (rows, ts = tileSize) => rows * ts + (rows - 1) * GAP + 18;
      // 固定行高（基于默认 tileSize=TILE_MIN）：节点最小/默认高度不随缩略图实时尺寸变化
      const gMinFixed = GRID_MIN_ROWS * TILE_MIN + (GRID_MIN_ROWS - 1) * GAP + 18;  // 2 行
      const gDefFixed = GRID_DEF_ROWS * TILE_MIN + (GRID_DEF_ROWS - 1) * GAP + 18;  // 3 行
      let contentH = CTRL_FALLBACK + gMinFixed;   // 追踪：DOM 控件实际内容高度（computeSize 回报固定最小值）

      // ---- 默认 / 最小尺寸（一次性计算，固定值，不随宽度/行数抖动）----
      let dimsInit = false, dimsFinal = false;
      let defW = 0, defH = 0, minW = 0, minH = 0;
      function computeDims() {
        if (dimsFinal) return;
        // 控件区使用「固定估算高度」而非实时 measureControls()：
        // 否则缩小宽度会让控件行换行变高 → ctrlH 变大 → minH 被连带抬高 → 反而触发 clamp 把节点顶高。
        const CTRL_H_BASE = 180;
        const naturalH = CHROME + TA_MIN + CTRL_H_BASE + gDefFixed;  // 3 行自然高度（固定基准）
        defH = Math.round(naturalH * 0.6);          // 默认高度 = 当前默认(×0.9) × 2/3
        minH = Math.round(naturalH * 0.405);        // 最小高度 = 当前最小(×0.9×0.9) × 1/2
        const baseW = 4 * (TILE_MIN + GAP) - GAP + 68 /*标签宽*/ + 16 * 3 + 24 + 20;
        defW = Math.round(baseW * 8 / 9);           // 默认宽度 ≈ 505（用户确认合适，保持不变）
        minW = Math.round(defW * 0.4 * 2);          // 最小宽度 = 当前最小(×0.4) × 2
        dimsInit = true;
      }

      // ---- 用户偏好（收藏 + 自定义排序，跨重启持久化）----
      const ucfg = { favorites: new Set(), order: [] };  // order = 全部风格名的自定义排列
      let cfgDirty = false;
      let cfgTimer = null;

      function saveUserConfig() {
        cfgDirty = true;
        clearTimeout(cfgTimer);
        cfgTimer = setTimeout(async () => {
          if (!cfgDirty || !state.theme) return;
          cfgDirty = false;
          try {
            await fetch("/josia_style/config", {
              method: "POST",
              headers: {"Content-Type": "application/json"},
              body: JSON.stringify({
                favorites: { [state.theme]: [...ucfg.favorites] },
                order: { [state.theme]: [...ucfg.favorites] },
              }),
            });
          } catch (e) {}
        }, 800);
      }

      async function loadUserConfig(theme) {
        ucfg.favorites.clear();
        ucfg.order = [];
        if (!theme || theme === THEME_NONE) return;
        try {
          const res = await fetch("/josia_style/config");
          const data = await res.json();
          const favs = (data.favorites && data.favorites[theme]) || [];
          favs.forEach((n) => ucfg.favorites.add(n));
          ucfg.order = (data.order && data.order[theme]) || [];
        } catch (e) {}
      }
      // 恢复所需的两个前置条件标志（挂到 node 上，供 onConfigure 跨闭包访问）
      node._josiaStaticReady = false;   // 主题列表 + 格式列表 已异步加载完成
      node._josiaConfigReady = false;   // onConfigure 已触发（保存的配置已注入 widget 值）

      // ---- 根容器（DOM 控件） ----
      const root = document.createElement("div");
      root.style.cssText =
        "display:flex;flex-direction:column;gap:8px;width:100%;padding:2px 2px 0;" +
        "font-family:'PingFang SC','Microsoft YaHei',sans-serif;color:#e6e6ee;" +
        "box-sizing:border-box;overflow:visible;";

      const SEL_CSS =
        "flex:1;min-width:0;background:#1b1b22;border:1px solid #34343e;border-radius:8px;" +
        "color:#e8e8ee;padding:7px 8px;font-size:13px;outline:none;box-sizing:border-box;";
      const ROW_CSS = "display:flex;align-items:center;gap:8px;width:100%;";
      const LBL_CSS =
        "flex:0 0 68px;font-size:12px;color:#8b8b98;letter-spacing:.5px;" +
        "white-space:nowrap;text-align:right;user-select:none;";

      function makeRow(labelText, control, tip) {
        const row = document.createElement("div");
        row.style.cssText = ROW_CSS;
        const lb = document.createElement("span");
        lb.textContent = labelText;
        lb.style.cssText = LBL_CSS;
        if (tip) { lb.title = tip; row.title = tip; }
        row.append(lb, control);
        return row;
      }

      // ---------------- 2) 风格主题 ----------------
      const themeSel = document.createElement("select");
      themeSel.style.cssText = SEL_CSS;
      themeSel.title = "风格主题：选择风格库（对应插件 Style/ 目录下的文件夹）。\n选好后才会载入该主题的风格预览图。";
      themeSel.innerHTML = `<option value="${THEME_NONE}">${THEME_NONE}</option>`;
      themeSel.addEventListener("change", () => {
        if (themeW) { themeW.value = themeSel.value; themeW.callback?.(themeSel.value, app.canvas, node); }
        loadTheme(themeSel.value, false);
      });
      const themeRow = makeRow("风格主题", themeSel, themeSel.title);

      // ---------------- 3) 风格分类（双语） ----------------
      const catSel = document.createElement("select");
      catSel.style.cssText = SEL_CSS;
      catSel.title = "风格分类：按官方 10 个分类筛选预览图。「全部」显示该主题所有风格。";
      catSel.innerHTML = `<option value="">全部</option>`;
      catSel.addEventListener("change", () => renderGrid());
      const catRow = makeRow("风格分类", catSel, catSel.title);

      // ---------------- 4) 搜索条 ----------------
      const searchRow = document.createElement("div");
      searchRow.style.cssText = ROW_CSS;

      const searchWrap = document.createElement("div");
      searchWrap.style.cssText =
        "position:relative;flex:1;min-width:0;display:flex;align-items:center;" +
        "background:#1b1b22;border:1px solid #34343e;border-radius:8px;padding:0 8px;box-sizing:border-box;";
      const searchIcon = document.createElement("span");
      searchIcon.textContent = "🔍";
      searchIcon.style.cssText = "font-size:13px;opacity:.6;margin-right:6px;";
      const searchInput = document.createElement("input");
      searchInput.placeholder = "搜索样式…";
      searchInput.style.cssText =
        "flex:1;min-width:0;background:transparent;border:none;color:#e8e8ee;" +
        "padding:7px 0;font-size:13px;outline:none;";
      searchInput.title = "搜索样式：支持中文名与英文名实时筛选。\n输入英文字母时，预览图名称会自动切换为英文以便对照。";
      searchInput.addEventListener("input", () => renderGrid());
      searchWrap.append(searchIcon, searchInput);

      const ICON_CSS =
        "flex:0 0 auto;width:36px;height:34px;border-radius:8px;cursor:pointer;" +
        "border:1px solid #34343e;background:#1b1b22;font-size:15px;box-sizing:border-box;";

      const multiToggle = document.createElement("button");
      multiToggle.textContent = "多选";
      multiToggle.title = "多选叠加：开启后可同时选择多个风格叠加使用（上限 " + MULTI_MAX
        + " 个）。\n超过上限时会自动取消最早选择的风格。";
      multiToggle.style.cssText =
        "flex:0 0 auto;padding:7px 10px;font-size:12px;border-radius:8px;cursor:pointer;" +
        "border:1px solid #34343e;background:#1b1b22;color:#9a9aa6;white-space:nowrap;";
      multiToggle.addEventListener("click", () => {
        state.multi = !state.multi;
        if (!state.multi && state.selected.length > 1) {
          state.selected = state.selected.slice(-1);
          pushSelected(node, state.selected);
        }
        pushMultiValue(node, state.multi);
        refreshAllSel();
      });

      const trashBtn = document.createElement("button");
      trashBtn.textContent = "🗑";
      trashBtn.title = "清除选择：一键清空当前所有已选中的风格（未选中任何风格时呈灰色不可点）。";
      trashBtn.disabled = true;
      trashBtn.style.cssText = ICON_CSS + "opacity:.4;cursor:not-allowed;";
      trashBtn.addEventListener("click", () => {
        if (trashBtn.disabled) return;
        state.selected = [];
        pushSelected(node, state.selected);
        refreshAllSel();
      });

      const browserBtn = document.createElement("button");
      browserBtn.textContent = "🌐";
      browserBtn.title = "打开风格画廊：在浏览器中打开该主题的本地化风格画廊网页（中文界面、双语名称、可查看完整提示词）。";
      browserBtn.style.cssText = ICON_CSS;
      browserBtn.addEventListener("click", () => {
        if (state.theme && state.theme !== THEME_NONE) {
          window.open(`/josia_style/${encodeURIComponent(state.theme)}/gallery/`, "_blank");
        }
      });

      searchRow.append(searchWrap, multiToggle, trashBtn, browserBtn);

      // ---------------- 5) 预览容器 ----------------
      const grid = document.createElement("div");
      grid.style.cssText =
        "width:100%;flex:0 0 auto;overflow-y:auto;overflow-x:hidden;display:grid;" +
        "gap:" + GAP + "px;padding:8px;align-content:start;justify-content:start;" +
        "background:#14141a;border:1px solid #2a2a32;border-radius:10px;box-sizing:border-box;height:180px;";

      // 滚动位置持久化：跨工作流 / 撤销重建后，恢复上次浏览到的缩略图位置
      const scrollKey = () => `style_select_scroll_${node.id ?? "n"}_${state.theme || "none"}`;
      let scrollTimer = null;
      grid.addEventListener("scroll", () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          try { localStorage.setItem(scrollKey(), String(Math.round(grid.scrollTop))); } catch (e) {}
        }, 250);
      });
      function restoreGridScroll() {
        try {
          const sv = parseInt(localStorage.getItem(scrollKey()) || "0", 10);
          if (sv > 0) grid.scrollTop = sv;
        } catch (e) {}
      }

      const emptyHint = document.createElement("div");
      emptyHint.style.cssText =
        "grid-column:1/-1;text-align:center;color:#7a7a86;font-size:12px;padding:24px 0;";
      emptyHint.textContent = "请先选择主题，预览图将显示在此处";

      // ---------------- 6) 提示词格式（中文说明 + 通配符对照提示） ----------------
      let formatOptions = [];   // [{value,label}]
      let wildcardHelp = [];    // [{key,desc}]
      let formatDefault = "";

      const formatSel = document.createElement("select");
      formatSel.style.cssText = SEL_CSS;

      function formatTooltip(value) {
        const label = (formatOptions.find((o) => o.value === value) || {}).label || "自定义";
        const lines = [
          "提示词格式：决定「风格提示词 / 风格名 / 分类名」与「你的提示词」如何拼合。",
          "",
          "通配符含义：",
        ];
        wildcardHelp.forEach((w) => lines.push("  " + w.key + "  = " + w.desc));
        lines.push("", "当前规则：" + label, "实际生成的格式：", "  " + (value || ""));
        return lines.join("\n");
      }

      function fillFormatSelect() {
        formatSel.innerHTML = formatOptions.map(
          (o) => `<option value="${o.value.replace(/"/g, "&quot;")}">${o.label}</option>`).join("");
        let cur = formatW?.value || formatDefault;
        if (!formatOptions.some((o) => o.value === cur)) cur = formatDefault;
        if (cur) formatSel.value = cur;
        formatSel.title = formatTooltip(formatSel.value);
      }
      formatSel.addEventListener("change", () => {
        if (formatW) { formatW.value = formatSel.value; formatW.callback?.(formatSel.value, app.canvas, node); }
        formatSel.title = formatTooltip(formatSel.value);
      });
      const formatRow = makeRow("提示词格式", formatSel);

      root.append(themeRow, catRow, searchRow, grid, formatRow);

      // ---------------------------------------------------------------------
      // 网格布局：JS 计算固定列宽 + 行高（彻底避免缩略图叠放）
      // ---------------------------------------------------------------------
      function layoutGrid() {
        const inner = grid.clientWidth - 16 /*padding*/ - 2 /*border*/;
        if (inner <= TILE_MIN) { tileSize = TILE_MIN; return; }
        const cols = Math.max(1, Math.floor((inner + GAP) / (TILE_MIN + GAP)));
        const t = Math.floor((inner - GAP * (cols - 1)) / cols);
        tileSize = Math.max(48, t);
        grid.style.gridTemplateColumns = `repeat(${cols}, ${tileSize}px)`;
        grid.style.gridAutoRows = tileSize + "px";
      }

      // ---------------------------------------------------------------------
      // 高度自适应：文本框 + 预览容器 随节点高度同步变化
      // ---------------------------------------------------------------------
      function setPromptHeight(h) {
        if (!promptW) return;
        promptW.computeSize = (w) => [w, h];
        const el = promptW.element || promptW.inputEl;
        if (el && el.style) {
          el.style.height = h + "px";
          el.style.minHeight = h + "px";
          if (el.tagName === "TEXTAREA") el.style.resize = "none";
        }
      }

      function measureControls() {
        const h = [themeRow, catRow, searchRow, formatRow]
          .reduce((s, el) => s + (el?.offsetHeight || 0), 0);
        return h > 0 ? h + 8 * 4 + 8 : CTRL_FALLBACK;
      }

      function applyLayout() {
        if (applying) return;
        applying = true;
        try {
          computeDims();
          layoutGrid();
          const ctrlH = measureControls();
          // 节点内部可用总高（不强制下限）：文本框 + 控件区占固定部分，剩余全给网格。
          // 网格随节点自由伸缩（overflow 内部滚动），缩到多小都不会溢出节点边框。
          // 节点高度唯一来源是 this.size（用户拖拽 / 工作流保存值）；无限生长的根治在
          // 下方对预览网格高度的上限钳制（GRID_MAX_H），此处只按当前尺寸分配内部高度。
          const nodeH = node.size?.[1] || 0;
          const inner = Math.max(80, nodeH - CHROME);
          let taH = Math.round(inner * 0.3);
          taH = Math.max(50, Math.min(TA_MIN, taH));
          let gridH = inner - ctrlH - taH;
          if (gridH < 0) { gridH = 0; taH = Math.max(50, inner - ctrlH); }
          setPromptHeight(taH);
          if (isVueNodes2()) {
            // ---- Node 2.0(Vue) 路径 ----
            // 2.0 的节点高度由 DOM 实测高度驱动（节点元素为 min-height:--node-height + 内容自适应）。
            // 若给网格设「固定像素高」，该高度会成为节点 min-content 的下界 → 节点被顶高且无法缩短。
            // 改为 flex 填充（flex:1 1 auto + min-height:0，且不设固定 height）：
            //   • min-height:0 让网格的 min-content 贡献归零 → 节点不再被顶高，可自由缩放；
            //   • flex-grow 让网格自动占满剩余空间 → 高度跟随节点，内容超出时内部滚动。
            if (grid.style.flex !== "1 1 auto") grid.style.flex = "1 1 auto";
            if (grid.style.height !== "auto") grid.style.height = "auto";
            if (grid.style.minHeight !== "0px") grid.style.minHeight = "0px";
          } else {
            // ---- Node 1.0(经典) 路径：完全保持经典界面原有逻辑 ----
            // 高度上限钳制：斩断「节点尺寸→网格 DOM 高度→再测量撑大节点」的无限生长反馈环。
            // 1.0 正常拖拽尺寸远低于此上限，故对自由缩放无影响。
            if (gridH > GRID_MAX_H) gridH = GRID_MAX_H;
            grid.style.height = gridH + "px";
          }
          // computeSize 只回报固定最小高度（minH），与节点实际高度/行数彻底解耦：
          // 节点高度仅由用户拖动决定，缩放宽度不再影响高度。
          contentH = minH;
        } finally {
          applying = false;
        }
      }

      // ---------------------------------------------------------------------
      // 预览卡片
      // ---------------------------------------------------------------------
      function thumbUrl(style) {
        return `/josia_style/${encodeURIComponent(state.theme)}/thumb?file=${encodeURIComponent(style.thumb)}`;
      }

      // 拖放位置判断：返回 null 表示放在目标前，true 表示放在目标后
      function getDragAfterPosition(container, x, y) {
        const children = [...container.children];
        const sibling = children.find((c) => {
          const box = c.getBoundingClientRect();
          return x <= box.left + box.width / 2;
        });
        return sibling ? (children.indexOf(sibling) > 0 ? children[children.indexOf(sibling) - 1] : null) : children[children.length - 1];
      }

      // 排序辅助：
      //  - 收藏项：按用户拖拽调整后的收藏顺序（可重排）
      //  - 未收藏项：始终保持数据原始（默认）顺序，不可被拖拽调整位置
      function sortStyles(list) {
        const favs = [];
        const rest = [];
        for (const s of list) {
          if (ucfg.favorites.has(s.name)) favs.push(s);
          else rest.push(s);
        }
        const favOrder = [...ucfg.favorites];
        favs.sort((a, b) => favOrder.indexOf(a.name) - favOrder.indexOf(b.name));
        return [...favs, ...rest];
      }

      function makeTile(style) {
        const tile = document.createElement("div");
        tile.className = "jtile";
        // 宽高完全由网格轨道决定（不依赖 aspect-ratio，避免塌陷/叠放）
        tile.style.cssText =
          "position:relative;border-radius:8px;overflow:hidden;cursor:pointer;" +
          "background:#1e1e26;border:2px solid transparent;transition:border-color .12s;box-sizing:border-box;";
        tile.dataset.name = style.name;

        const im = document.createElement("img");
        im.loading = "lazy";
        im.draggable = false;
        im.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
        im.src = thumbUrl(style);
        im.onerror = () => { im.style.display = "none"; };

        // 名称条：位于图片内部底部，半透明暗色，最多 2 行，不越界
        const label = document.createElement("div");
        label.className = "jlabel";
        label.style.cssText =
          "position:absolute;left:0;right:0;bottom:0;padding:3px 4px;" +
          "font-size:11px;line-height:1.2;color:#fff;text-align:center;" +
          "background:rgba(0,0,0,.72);" +
          "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;";
        label.textContent = style.name_cn || style.name;

        // ---- ★ 收藏按钮（右上角，hover 显示）----
        const starBtn = document.createElement("button");
        starBtn.textContent = "\u2606";
        starBtn.title = "点击收藏（收藏的风格在筛选结果中排在最前面）";
        starBtn.style.cssText =
          "position:absolute;top:3px;right:3px;z-index:3;" +
          "width:22px;height:22px;border:none;border-radius:50%;" +
          "background:rgba(0,0,0,.55);color:#aaa;font-size:13px;" +
          "cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center;" +
          "padding:0;transition:all .15s;opacity:0;";
        tile.addEventListener("mouseenter", () => { starBtn.style.opacity = "1"; });
        tile.addEventListener("mouseleave", () => { starBtn.style.opacity = "0"; });

        function refreshStar() {
          if (ucfg.favorites.has(style.name)) {
            starBtn.textContent = "\u2605";
            starBtn.style.color = "#ffd700";
            starBtn.style.background = "rgba(40,35,0,.7)";
            starBtn.title = "已收藏（点击取消收藏）";
          } else {
            starBtn.textContent = "\u2606";
            starBtn.style.color = "#aaa";
            starBtn.style.background = "rgba(0,0,0,.55)";
            starBtn.title = "点击收藏（收藏的风格在筛选结果中排在最前面）";
          }
        }
        refreshStar();

        starBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (ucfg.favorites.has(style.name)) {
            ucfg.favorites.delete(style.name);
          } else {
            ucfg.favorites.add(style.name);
          }
          refreshStar();
          saveUserConfig();
          renderGrid();
        });

        tile.append(im, starBtn, label);

        // ---- 拖动排序支持（仅收藏项可拖拽；未收藏项保持默认顺序）----
        tile.draggable = ucfg.favorites.has(style.name);
        tile.addEventListener("dragstart", (e) => {
          if (!state.theme || state.theme === THEME_NONE || !ucfg.favorites.has(style.name)) {
            e.preventDefault(); return;
          }
          e.dataTransfer.setData("text/plain", style.name);
          e.dataTransfer.effectAllowed = "move";
          tile.classList.add("dragging");
          tile.style.opacity = ".45";
          tile.style.borderColor = "#6fb3ff";
          isDragging = true;
          hideHover();            // 拖拽时隐藏悬浮窗，避免遮挡
          dragJustEnded = false;
        });
        tile.addEventListener("dragend", () => {
          tile.classList.remove("dragging");
          tile.style.opacity = "";
          refreshStar();
          isDragging = false;
          dragJustEnded = true;   // 拦截紧随的 click，避免误选中
          setTimeout(() => { dragJustEnded = false; }, 60);
          renderGrid();           // 无论是否 drop，都按 ucfg 重排恢复一致状态
        });
        tile.addEventListener("dragover", (e) => {
          if (!isDragging) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const dragging = document.querySelector(".jtile.dragging");
          if (!dragging || dragging === tile) return;
          const after = getDragAfterPosition(tile, e.clientX, e.clientY);
          if (after === null) {
            tile.parentNode.insertBefore(dragging, tile);
          } else {
            tile.parentNode.insertBefore(dragging, tile.nextSibling);
          }
        });
        tile.addEventListener("drop", (e) => {
          if (!isDragging) return;
          e.preventDefault();
          // 仅取「收藏项」的新相对顺序重排 favorites（未收藏项不参与排序）
          const favOrder = [];
          grid.querySelectorAll(".jtile").forEach((t) => {
            const n = t.dataset.name;
            if (n && ucfg.favorites.has(n)) favOrder.push(n);
          });
          ucfg.favorites = new Set(favOrder);
          saveUserConfig();
          renderGrid();           // 重排后刷新（未收藏项恢复默认顺序）
        });

        tile._refreshSel = () => {
          const on = state.selected.includes(style.name);
          const fav = ucfg.favorites.has(style.name);
          tile.style.borderColor = on ? "#2b6cff" : (fav ? "rgba(255,215,0,.5)" : "transparent");
          tile.style.boxShadow = on ? "0 0 0 1px #2b6cff inset" : "none";
          refreshStar();
        };
        tile._refreshSel();

        tile.addEventListener("click", () => {
          if (dragJustEnded) return;   // 刚结束拖拽，拦截误触发的 click 选中
          const idx = state.selected.indexOf(style.name);
          if (state.multi) {
            if (idx >= 0) state.selected.splice(idx, 1);
            else {
              state.selected.push(style.name);
              if (state.selected.length > MULTI_MAX) state.selected.shift(); // FIFO 踢最旧
            }
          } else {
            state.selected = idx >= 0 ? [] : [style.name];
          }
          pushSelected(node, state.selected);
          refreshAllSel();
        });

        let hoverTimer = null;
        tile.addEventListener("mouseenter", () => {
          if (isDragging) return;   // 拖拽中不弹悬浮窗
          const entry = Object.assign({}, style, { _theme: state.theme });
          hoverTimer = setTimeout(() => { if (!isDragging) showHover(entry, tile); }, HOVER_DELAY);
        });
        tile.addEventListener("mouseleave", () => {
          if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
          hideHover();
        });

        return tile;
      }

      function refreshAllSel() {
        const n = state.selected.length;
        trashBtn.disabled = n === 0;
        trashBtn.style.opacity = n === 0 ? ".4" : "1";
        trashBtn.style.cursor = n === 0 ? "not-allowed" : "pointer";
        multiToggle.textContent = state.multi ? `多选 ${n}/${MULTI_MAX}` : "多选";
        multiToggle.style.background = state.multi ? "#2b6cff" : "#1b1b22";
        multiToggle.style.color = state.multi ? "#fff" : "#9a9aa6";
        multiToggle.style.borderColor = state.multi ? "#2b6cff" : "#34343e";
        grid.querySelectorAll(".jtile").forEach((t) => t._refreshSel && t._refreshSel());
      }

      function renderGrid() {
        const q = (searchInput.value || "").trim().toLowerCase();
        const isEnglish = /[a-z]/i.test(q);
        const cat = catSel.value;
        grid.innerHTML = "";
        if (!state.styles.length) { grid.append(emptyHint); return; }
        // 1) 筛选
        let filtered = state.styles.filter((s) => {
          const cn = (s.name_cn || s.name).toLowerCase();
          const en = (s.name || "").toLowerCase();
          if (q && !(cn.includes(q) || en.includes(q))) return false;
          if (cat && s.section !== cat) return false;
          return true;
        });
        // 2) 排序：收藏置顶 → 自定义顺序 → 默认
        filtered = sortStyles(filtered);
        // 3) 渲染
        let shown = 0;
        for (const s of filtered) {
          const tile = makeTile(s);
          if (isEnglish) tile.querySelector(".jlabel").textContent = s.name || s.name_cn;
          grid.append(tile);
          shown++;
        }
        if (shown === 0) {
          const none = document.createElement("div");
          none.style.cssText =
            "grid-column:1/-1;text-align:center;color:#7a7a86;font-size:12px;padding:18px 0;";
          none.textContent = "没有匹配的样式";
          grid.append(none);
        }
        layoutGrid();
        refreshAllSel();
      }

      async function loadTheme(theme, preserveSelection, restoreScroll = false) {
        hideHover();
        state.theme = theme;
        if (!preserveSelection) {
          state.selected = [];
          pushSelected(node, []);
        }
        grid.innerHTML = "";
        grid.append(emptyHint);
        if (!theme || theme === THEME_NONE) {
          state.styles = [];
          catSel.innerHTML = `<option value="">全部</option>`;
          refreshAllSel();
          return;
        }
        try {
          const res = await fetch(`/josia_style/${encodeURIComponent(theme)}/styles`);
          const data = await res.json();
          state.styles = data.list || [];
          // 加载用户配置（收藏 + 自定义排序）
          await loadUserConfig(theme);
          const present = SECTION_ORDER.filter((s) => state.styles.some((x) => x.section === s));
          catSel.innerHTML = `<option value="">全部</option>` +
            present.map((s) => `<option value="${s}">${sectionLabel(s)}</option>`).join("");
          renderGrid();
          if (restoreScroll) restoreGridScroll();
        } catch (e) {
          state.styles = [];
          refreshAllSel();
        }
      }

      // ---------------------------------------------------------------------
      // 挂载 DOM 控件 + 初始尺寸
      // ---------------------------------------------------------------------
      const widget = node.addDOMWidget("style_ui", "style_select_ui", root, { serialize: false });
      // computeSize 返回「固定最小值」contentH（在 applyLayout 中按 控件区+网格最小高度 算出，与节点实际高度解耦）。
      // 这样拖拽缩小时不会被 clamp 回弹（只增高不缩小）；节点多余高度由 grid 的 overflow 自然填充（root 为 overflow:visible）。
      widget.computeSize = (w) => [w, Math.max(0, contentH)];

      // 容器宽度变化 → 重新计算列数/行高
      try {
        const ro = new ResizeObserver(() => {
          if (applying) return;
          layoutGrid();
          applyLayout();
          node.setDirtyCanvas?.(true, false);
        });
        ro.observe(grid);
      } catch (e) { /* 老浏览器无 ResizeObserver 时忽略 */ }

      // 尺寸初始化策略（关键：切换工作流再切回必须保持用户调整后的尺寸）
      //  - 全新节点（工作流未注入保存尺寸）：套用新默认宽高
      //  - 从工作流加载的节点：保留其保存尺寸，用户拖动修改后绝不被覆盖
      //  - 仅对「宽度恰好等于上一版旧默认(757)」的遗留节点做一次收窄迁移，
      //    用户手动调整后的宽度不会恰好等于旧默认，因此不会被误伤
      requestAnimationFrame(() => {
        layoutGrid();
        computeDims();
        const cur = node.size || [];
        const curW = cur?.[0] || 0;
        const isFresh = !node._josiaConfigReady;                          // 全新节点（无配置注入）
        const atOldDefault = curW > 0 && Math.abs(curW - OLD_DEFAULT_W) <= 1; // 恰为旧默认宽度(±1px)
        // Node 2.0 下适度降低默认高度（仅 Vue 渲染器生效，经典界面尺寸保持不变）
        const defHUse = isVueNodes2() ? Math.round(defH * 0.8) : defH;
        if (isFresh) {
          node.setSize([defW, defHUse]);   // 新节点：套用默认宽高
        } else if (atOldDefault) {
          node.setSize([defW, defHUse]);   // 遗留旧默认宽节点：一次性收窄到新默认
        }
        // 任何节点都不低于最小尺寸（宽/高）
        if ((node.size?.[0] || 0) < minW) node.size[0] = minW;
        if ((node.size?.[1] || 0) < minH) node.size[1] = minH;
        dimsFinal = true;   // 尺寸已最终确定，后续不再重算（避免布局前兜底值污染）
        applyLayout();
        node.setDirtyCanvas?.(true, true);
      });

      // 节点尺寸变化 → 重新分配高度
      node.onResize = function (size) {
        origResize?.apply(this, arguments);
        if (applying) return;
        // 限制最小宽/高，防止缩到不可用（最小尺寸为固定值，不随行数变化）
        if ((node.size?.[0] || 0) < minW) node.size[0] = minW;
        if ((node.size?.[1] || 0) < minH) node.size[1] = minH;
        setTimeout(() => { applyLayout(); node.setDirtyCanvas(true, true); }, 0);
      };

      // 确保主题下拉里有 saved 这一项（列表异步加载完成前也能先选中，避免回退成默认）
      function ensureThemeOption(id) {
        if (!id || id === THEME_NONE) return;
        if ([...themeSel.options].some((o) => o.value === id)) return;
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = themeDisplay(id);
        themeSel.appendChild(opt);
      }

      function applyFormatFromWidget() {
        let cur = formatW?.value || formatDefault;
        if (formatOptions.length && !formatOptions.some((o) => o.value === cur)) cur = formatDefault;
        if (cur) { formatSel.value = cur; formatSel.title = formatTooltip(cur); }
      }

      // 统一恢复入口：从数据控件（theme/format/selected_styles/multi_select）重建 UI。
      // 关键：不依赖下拉选项是否已异步加载完，也绝不写回 themeW（避免污染已保存值）。
      function restoreFromWidgets() {
        applyFormatFromWidget();
        state.selected = readSelected(node);
        state.multi = readMulti(node);
        const saved = themeW?.value || THEME_NONE;
        if (saved && saved !== THEME_NONE) {
          ensureThemeOption(saved);
          themeSel.value = saved;
          if (state.theme !== saved || state.styles.length === 0) loadTheme(saved, true, true);
        } else {
          themeSel.value = THEME_NONE;
          if (state.theme !== THEME_NONE) loadTheme(THEME_NONE, true);
        }
        refreshAllSel();
        applyLayout();
      }

      // 仅当两个前置条件都就绪才真正恢复，否则延后（避免与异步加载竞态）
      function maybeRestore() {
        if (node._josiaStaticReady && node._josiaConfigReady) restoreFromWidgets();
      }
      node._josiaMaybeRestore = maybeRestore;   // 供 onConfigure 跨闭包调用

      // 初始化：主题列表 + 格式列表
      (async () => {
        try {
          const res = await fetch("/josia_style/themes");
          const data = await res.json();
          themeSel.innerHTML =
            `<option value="${THEME_NONE}">${THEME_NONE}</option>` +
            (data.themes || []).map((t) => {
              const nm = themeDisplay(t.id);
              return `<option value="${t.id}" title="主题：${nm}">${nm}</option>`;
            }).join("");
        } catch (e) { /* 保留默认项 */ }

        try {
          const res2 = await fetch("/josia_style/formats");
          const d2 = await res2.json();
          formatOptions = d2.options || [];
          wildcardHelp = d2.wildcards || [];
          formatDefault = d2.default || "";
        } catch (e) {
          formatOptions = [];
          wildcardHelp = [];
        }
        fillFormatSelect();

        node._josiaStaticReady = true;
        maybeRestore();   // 静态数据已就绪；若配置也已注入则立即恢复
      })();

      return result;
    };

    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      this._josiaConfigReady = true;
      this._josiaMaybeRestore?.();
      return r;
    };
  },
});
