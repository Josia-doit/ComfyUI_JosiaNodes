/**
 * Josia Group Controller - 分组控制节点前端交互文件
 * 功能：
 * 1. JosiaGroupControllerM（多组控制）：
 *    - 自动扫描工作流中所有编组，逐组提供跳过/启用开关；
 *    - 提供"全部跳过"/"全部启用"全局按钮；
 *    - 点击编组名称导航至该编组位置；
 *    - 实时刷新编组内节点状态，支持批量操作。
 * 2. JosiaGroupControllerS（单组控制）：
 *    - 下拉框选择目标编组（支持颜色标识、名称截断）；
 *    - 单个开关控制选中编组的跳过/启用状态；
 *    - 选中编组信息随工作流序列化保存；
 *    - 显示编组内节点数量，支持导航至编组。
 * 节点英文标识：JosiaGroupControllerM / JosiaGroupControllerS
 * 节点中文显示名：Josia多组控制 / Josia单组控制
 */

import { app } from "../../scripts/app.js";

// ─────────────────────────────────────────────
// 节点标识（与Python端/ __init__.py 严格一致）
// ─────────────────────────────────────────────
const NODE_NAME_M  = "JosiaGroupControllerM";  // 多组控制：Python类名/注册名
const NODE_TYPE_M  = "Josia多组控制";          // 多组控制：中文显示名
const NODE_BADGE_M = "JosiaGroupControllerM";  // 多组控制：徽章标识（已注释绘制）

const NODE_NAME_S  = "JosiaGroupControllerS";  // 单组控制：Python类名/注册名
const NODE_TYPE_S  = "Josia单组控制";          // 单组控制：中文显示名
const NODE_BADGE_S = "JosiaGroupControllerS";  // 单组控制：徽章标识（已注释绘制）

const NODE_NAME_G  = "JosiaGroupControllerG";  // 分组控制：Python类名/注册名
const NODE_TYPE_G  = "Josia分组控制";          // 分组控制：中文显示名
const NODE_BADGE_G = "JosiaGroupControllerG";  // 分组控制：徽章标识

// ─────────────────────────────────────────────
// 分组控制节点：布局常量（与多组/单组风格一致）
// ─────────────────────────────────────────────
const G_PAD        = 10;        // 内边距
const G_HEADER_H   = 36;        // 顶部控制条高度
const G_ROW_H      = 34;        // 已选编组行高
const G_ROW_GAP    = 4;         // 行间距
const G_DD_H       = 28;        // 待选下拉框高度
const G_BTN_W      = 64;        // 开关按钮宽度
const G_BTN_H      = 22;        // 开关按钮高度
const G_MIN_ROWS   = 1;         // 最少编组槽位
const G_MAX_ROWS   = 20;        // 最多编组槽位
const G_MIN_W      = 300;       // 节点最小宽度
const G_SM_BTN     = 24;        // 顶部 − / + 小按钮尺寸
const G_RECOMP     = 300;       // 重新计算节流(ms)

// 将任意颜色字符串解析为 [r,g,b]（兼容 #rgb / #rrggbb / rgb() / rgba()）
function parseColor(c) {
  if (!c) return null;
  c = String(c).trim();
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    return [parseInt(c[1] + c[1], 16), parseInt(c[2] + c[2], 16), parseInt(c[3] + c[3], 16)];
  }
  if (/^#[0-9a-fA-F]{6}$/.test(c)) {
    return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  }
  const m = c.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length >= 3) return [p[0], p[1], p[2]];
  }
  return null;
}

// ComfyUI 编组默认调色板（精确中文名，与 ComfyUI 颜色菜单翻译一致）
const COMFY_GROUP_COLORS = {
  "#a82a2a": "红色", "#902808": "棕色",
  "#3fa870": "绿色", "#2a4b7a": "蓝色", "#3f3fbf": "蓝色",
  "#a8991a": "黄色", "#cf7a1a": "黄色",
  "#7a52c7": "紫色", "#c71a8f": "粉色", "#1a9acf": "青色",
  "#444": "黑色", "#9a9a9a": "灰色", "#cfcfcf": "浅灰色", "#335": "深蓝灰", "#335566": "蓝灰色"
};

// 根据颜色 RGB 推导实际中文颜色名（避免出现"自定义色"）
function colorName(c) {
  const rgb = typeof c === "string" ? parseColor(c) : (Array.isArray(c) ? c : null);
  if (!rgb) return "未设色";
  const key = (typeof c === "string" ? c : "").toLowerCase();
  if (COMFY_GROUP_COLORS[key]) return COMFY_GROUP_COLORS[key];
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const light = (max + min) / 2, delta = max - min;
  if (delta < 20 && light > 210) return "白色";
  if (delta < 20 && light < 45)  return "黑色";
  if (delta < 30) return light > 140 ? "浅灰色" : "灰色";
  let h = 0;
  if (delta !== 0) {
    if (max === r)      h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else                h = (r - g) / delta + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const sat = max === 0 ? 0 : delta / max;
  if (sat < 0.15) return light > 140 ? "浅灰色" : "灰色";
  if (h < 15 || h >= 345) return "红色";
  if (h < 45)  return "黄色";
  if (h < 70)  return "黄色";
  if (h < 165) return (light > 175 || (sat < 0.5 && light > 150)) ? "淡绿色" : "绿色";
  if (h < 200) return "青色";
  if (h < 260) {
    // 蓝 / 淡蓝：按实测反馈，较浅/低饱和的蓝标记为「蓝色」、较深的标记为「淡蓝色」
    if (light > 170 || sat < 0.42) return "蓝色";
    return "淡蓝色";
  }
  if (h < 345) return "紫色";   // 紫色统一归为"紫色"，避免误判为"粉色"
  return "红色";
}
// 取编组内节点数（兼容不同 ComfyUI 版本）
function getGroupNodeCount(group) {
  if (!group) return 0;
  return getGroupNodes(group).length;
}

// ─────────────────────────────────────────────
// 编组唯一标识（用 group.id，而非 title——多个编组可同名）
// ─────────────────────────────────────────────
function groupIdOf(g) {
  return "GID:" + (g.id != null ? g.id : (g.title ?? ""));
}
function resolveGroupByKey(key) {
  if (!key) return null;
  const groups = getAllGroups();
  for (const g of groups) if (groupIdOf(g) === key) return g;
  for (const g of groups) if ((g.title ?? "") === key) return g; // 兼容旧版 title 主键
  return null;
}
// 旧版本用 title 作主键，迁移为 id 主键
function migrateSlots(node) {
  const slots = node.properties?.gSlots ?? [null];
  let changed = false;
  const out = slots.map((s) => {
    if (s == null) return null;
    if (typeof s === "string" && s.startsWith("GID:")) return s;
    const g = getAllGroups().find((gg) => (gg.title ?? "") === s);
    if (g) { changed = true; return groupIdOf(g); }
    return s;
  });
  return changed ? out : null;
}

// 节点局部坐标 → 屏幕坐标（用于自定义下拉定位）
function nodeLocalToScreen(node, lx, ly) {
  try {
    const ds = app.canvas.ds;
    const cv = app.canvas.canvas ?? app.canvas.background_canvas;
    const crect = cv?.getBoundingClientRect?.();
    const ox = crect?.left ?? 0, oy = crect?.top ?? 0;
    const gx = node.pos[0] + lx, gy = node.pos[1] + ly;
    return [ox + (gx - ds.offset[0]) * ds.scale, oy + (gy - ds.offset[1]) * ds.scale];
  } catch (_) {
    return [0, 0];
  }
}

// ── 自定义下拉菜单（保证色块稳定渲染，不依赖 ContextMenu 内部实现）──
// 取真实光标屏幕坐标（最稳妥的下拉锚点，规避 graph→screen 变换的偏移/反向问题）
function _eventClientPos(e) {
  if (e && typeof e.clientX === "number") return [e.clientX, e.clientY];
  return null;
}
let _josiaDD = null;
function _josiaDDOutside(e) { if (_josiaDD && !_josiaDD.el.contains(e.target)) _josiaDDClose(); }
function _josiaDDKey(e) { if (e.key === "Escape") _josiaDDClose(); }
function _josiaDDClose() {
  if (!_josiaDD) return;
  _josiaDD.el.remove();
  _josiaDD = null;
  document.removeEventListener("pointerdown", _josiaDDOutside, true);
  document.removeEventListener("keydown", _josiaDDKey);
}
function openJosiaDropdown(ax, ay, items) {
  _josiaDDClose();
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;z-index:100000;min-width:190px;background:#1e1e1e;color:#e6e6e6;border:1px solid #444;border-radius:6px;padding:4px;box-shadow:0 6px 20px rgba(0,0,0,.55);font:12px sans-serif;max-height:340px;overflow:auto;";
  for (const it of items) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;cursor:pointer;white-space:nowrap;";
    if (it.disabled) { row.style.opacity = "0.5"; row.style.cursor = "default"; }
    if (it.color) {
      const sw = document.createElement("span");
      sw.style.cssText = "width:12px;height:12px;border-radius:3px;background:" + it.color + ";flex:0 0 auto;";
      row.appendChild(sw);
    }
    const lab = document.createElement("span");
    lab.textContent = it.label;
    row.appendChild(lab);
    if (it.count != null) {
      const cnt = document.createElement("span");
      cnt.style.cssText = "margin-left:auto;color:#999;font-size:11px;";
      cnt.textContent = String(it.count);
      row.appendChild(cnt);
    }
    if (!it.disabled) {
      row.addEventListener("mouseenter", () => { row.style.background = "rgba(255,255,255,0.08)"; });
      row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });
      row.addEventListener("click", () => { _josiaDDClose(); it.callback && it.callback(); });
    }
    el.appendChild(row);
  }
  document.body.appendChild(el);
  const vw = window.innerWidth, vh = window.innerHeight;
  const r = el.getBoundingClientRect();
  let px = ax, py = ay;
  if (px + r.width > vw - 8) px = Math.max(8, vw - r.width - 8);
  if (py + r.height > vh - 8) py = Math.max(8, vh - r.height - 8);
  el.style.left = px + "px"; el.style.top = py + "px";
  _josiaDD = { el };
  setTimeout(() => {
    document.addEventListener("pointerdown", _josiaDDOutside, true);
    document.addEventListener("keydown", _josiaDDKey);
  }, 0);
}

// ─────────────────────────────────────────────
// 布局常量（共享）
// ─────────────────────────────────────────────
const PAD_X        = 10;        // 水平内边距
const PAD_Y        = 8;         // 垂直内边距
const HEADER_H     = 38;        // 多组：全局按钮行高
const ROW_H        = 32;        // 编组行高
const ROW_GAP      = 3;         // 编组行间距
const BTN_W        = 72;        // 开关按钮宽度
const BTN_H        = 22;        // 开关按钮高度
const MIN_W        = 270;       // 节点最小宽度
const DROPDOWN_H   = 28;        // 单组：下拉框高度
const SINGLE_H     = PAD_Y + DROPDOWN_H + 6 + ROW_H + PAD_Y; // 单组节点总高度（82px）
const RECOMPUTE_INTERVAL = 300; // 编组节点重新计算节流时间（ms）

// ─────────────────────────────────────────────
// Canvas 工具函数
// ─────────────────────────────────────────────

/**
 * 绘制圆角矩形（兼容不同Canvas版本）
 * @param {CanvasRenderingContext2D} ctx - Canvas上下文
 * @param {number} x - 左上角X坐标
 * @param {number} y - 左上角Y坐标
 * @param {number} w - 宽度
 * @param {number} h - 高度
 * @param {number} r - 圆角半径
 */
function drawRoundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * 文本截断（超出宽度显示省略号）
 * @param {CanvasRenderingContext2D} ctx - Canvas上下文
 * @param {string} text - 原始文本
 * @param {number} maxWidth - 最大显示宽度
 * @returns {string} 截断后的文本
 */
function truncateText(ctx, text, maxWidth) {
  if (!text) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + "…").width > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + "…";
}

// ─────────────────────────────────────────────
// LiteGraph / ComfyUI 兼容工具（共享）
// ─────────────────────────────────────────────
const BYPASS_MODE = 4;  // LiteGraph 跳过模式（BYPASS）
const ACTIVE_MODE = 0;  // LiteGraph 激活模式（NORMAL）

/**
 * 获取当前激活的画布/graph
 * @returns {LiteGraph.Graph} 当前Graph实例
 */
function getActiveGraph() {
  return app.canvas?.getCurrentGraph?.() ?? app.graph;
}

/**
 * 获取工作流中所有编组（包括子图）
 * @returns {Array} 编组列表
 */
function getAllGroups() {
  const graph = getActiveGraph();
  if (!graph) return [];
  const groups = [...(graph._groups ?? [])];
  const subgraphs = graph.subgraphs?.values?.();
  if (subgraphs) {
    for (const sg of subgraphs) {
      if (sg?.groups) groups.push(...sg.groups);
    }
  }
  return groups;
}

/**
 * 重新计算编组内的节点（兼容不同ComfyUI版本）
 * @param {object} group - 编组实例
 */
// 重新计算编组内成员（新前端：调用原生 recomputeInsideNodes）
function recomputeGroupNodes(group) {
  if (!group) return;
  try { group.recomputeInsideNodes?.(); } catch (_) {}
}

/**
 * 获取编组内的节点列表（兼容不同ComfyUI版本）
 * @param {object} group - 编组实例
 * @returns {Array} 节点列表
 */
function getGroupNodes(group) {
  if (!group) return [];
  if (group._children instanceof Set) {
    return Array.from(group._children).filter(
      (c) => c != null && typeof c === "object" && "mode" in c
    );
  }
  return group.nodes ?? group._nodes ?? [];
}

/**
 * 设置编组内所有节点的跳过/启用状态
 * @param {object} group - 编组实例
 * @param {boolean} bypass - 是否跳过（true=跳过，false=启用）
 */
function setGroupBypass(group, bypass) {
  const nodes = getGroupNodes(group);
  for (const node of nodes) {
    node.mode = bypass ? BYPASS_MODE : ACTIVE_MODE;
  }
  (group.graph ?? app.graph)?.setDirtyCanvas?.(true, false);
}

/**
 * 导航至指定编组（画布居中显示）
 * @param {object} group - 编组实例
 */
function navigateToGroup(group) {
  const canvas = app.canvas;
  if (!canvas || !group?._bounding) return;
  const [gx, gy, gw, gh] = group._bounding;
  const cx = gx + gw / 2;
  const cy = gy + gh / 2;
  const ds = canvas.ds;
  if (ds) {
    const scale = ds.scale || 1;
    const cW = canvas.canvas?.clientWidth  ?? canvas.canvas?.width  ?? 800;
    const cH = canvas.canvas?.clientHeight ?? canvas.canvas?.height ?? 600;
    ds.offset[0] = cW / 2 / scale - cx;
    ds.offset[1] = cH / 2 / scale - cy;
  }
  (typeof canvas.setDirty === "function")
    ? canvas.setDirty(true, true)
    : canvas.setDirtyCanvas?.(true, true);
}

// ─────────────────────────────────────────────
// 多组节点：高度计算
// ─────────────────────────────────────────────

/**
 * 计算多组控制节点的高度
 * @param {number} groupCount - 编组数量
 * @returns {number} 节点高度
 */
function computeHeightM(groupCount) {
  return PAD_Y + HEADER_H + ROW_GAP
       + Math.max(1, groupCount) * (ROW_H + ROW_GAP)
       + PAD_Y;
}

// ─────────────────────────────────────────────
// 多组节点：实例状态初始化
// ─────────────────────────────────────────────

/**
 * 初始化多组控制节点的实例状态
 * @param {object} node - 多组控制节点实例
 */
function ensureStateM(node) {
  if (node._gbcM) return;
  node._gbcM            = true;          // 标记已初始化
  node._hitRows         = [];            // 编组行点击区域
  node._hitHeaderBtns   = [];            // 头部按钮点击区域
  node._hitMutexBtn     = null;          // 互斥模式按钮点击区域
  node._lastRecomputeMs = 0;             // 最后一次重新计算时间
  node._lastGroupCount   = 0;             // 上次检查时的分组数量（用于检测新增分组）
  node.serialize_widgets = false;        // 不序列化widgets
  node.isVirtualNode    = true;          // 标记为虚拟节点
  
  // 初始化互斥模式属性（序列化保存）
  if (!node.properties) node.properties = {};
  if (typeof node.properties.mutexMode !== "boolean") {
    node.properties.mutexMode = false;
  }
  
  node.size             = [MIN_W, computeHeightM(0)]; // 初始尺寸
}

// ─────────────────────────────────────────────
// 多组节点：绘制
// ─────────────────────────────────────────────

/**
 * 绘制多组控制节点
 * @param {object} node - 多组控制节点实例
 * @param {CanvasRenderingContext2D} ctx - Canvas上下文
 */
function drawMultiNode(node, ctx) {
  if (node.flags?.collapsed) return;

  const now = Date.now();
  // 节流重新计算编组节点
  if (now - node._lastRecomputeMs >= RECOMPUTE_INTERVAL) {
    node._lastRecomputeMs = now;
    for (const g of getAllGroups()) recomputeGroupNodes(g);
  }

  const groups  = getAllGroups();
  const W       = node.size[0];
  const neededH = computeHeightM(groups.length);
  
  // 检测分组数量变化：如果变化且单选模式开启，则自动关闭
  const currentGroupCount = groups.length;
  if (node._lastGroupCount > 0 && node._lastGroupCount !== currentGroupCount) {
    // 分组数量发生变化
    if (node.properties?.mutexMode) {
      node.properties.mutexMode = false;
      console.log("[JosiaGroupController] 检测到分组数量变化，已自动关闭单选模式");
    }
  }
  node._lastGroupCount = currentGroupCount;
  
  // 动态调整节点高度
  if (Math.abs(node.size[1] - neededH) > 1) node.size[1] = neededH;

  node._hitRows       = [];
  node._hitHeaderBtns = [];
  node._hitMutexBtn   = null;

  let y = PAD_Y;

  // 计算三个头部按钮的宽度（等宽，自适应节点宽度）
  const headerTotalW = W - PAD_X * 2;
  const btnGap = 4;  // 按钮之间的间距
  const headerBtnW = (headerTotalW - btnGap * 2) / 3;  // 三个按钮等宽
  const headerBtnH = HEADER_H - 6;  // 与头部按钮相同的高度
  
  // 绘制全局按钮（全部跳过/全部启用）和单选模式按钮
  _drawHeaderBtn(node, ctx, PAD_X, y, headerBtnW, headerBtnH, "全部跳过", "#7a1515", "bypass_all");
  _drawHeaderBtn(node, ctx, PAD_X + headerBtnW + btnGap, y, headerBtnW, headerBtnH, "全部启用", "#155c30", "enable_all");
  
  // 绘制单选模式按钮
  const mutexMode = node.properties?.mutexMode ?? false;
  const mutexX = PAD_X + (headerBtnW + btnGap) * 2;
  node._hitMutexBtn = { x: mutexX, y: y, w: headerBtnW, h: headerBtnH };
  
  ctx.save();
  ctx.fillStyle = mutexMode ? "#1a73e8" : "rgba(255,255,255,0.06)";
  ctx.strokeStyle = mutexMode ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  drawRoundRect(ctx, mutexX, y, headerBtnW, headerBtnH, 5);
  ctx.fill();
  if (!mutexMode) ctx.stroke();
  ctx.fillStyle    = mutexMode ? "#ffffff" : "#888";
  ctx.font         = "bold 12px sans-serif";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("单选模式", mutexX + headerBtnW / 2, y + headerBtnH / 2);
  ctx.restore();
  
  y += HEADER_H;

  // 绘制分隔线
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(PAD_X, y - 4);
  ctx.lineTo(W - PAD_X, y - 4);
  ctx.stroke();
  ctx.restore();

  // 无编组时显示提示
  if (!groups.length) {
    ctx.save();
    ctx.fillStyle    = "#666";
    ctx.font         = "italic 12px sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("工作流中没有编组", W / 2, y + ROW_H / 2 + 4);
    ctx.restore();
    return;
  }

  // 绘制每个编组行
  for (const group of groups) {
    const nodes    = getGroupNodes(group);
    const bypassed = nodes.length > 0 && nodes.every((n) => n.mode === BYPASS_MODE);
    const mixed    = !bypassed && nodes.some((n) => n.mode === BYPASS_MODE);
    node._hitRows.push({ group, y, bypassed, mixed });
    _drawGroupRow(ctx, group, y, bypassed, mixed, nodes.length, W);
    y += ROW_H + ROW_GAP;
  }
}

/**
 * 绘制多组节点头部按钮
 * @param {object} node - 多组控制节点实例
 * @param {CanvasRenderingContext2D} ctx - Canvas上下文
 * @param {number} x - X坐标
 * @param {number} y - Y坐标
 * @param {number} w - 宽度
 * @param {number} h - 高度
 * @param {string} label - 按钮文本
 * @param {string} color - 按钮背景色
 * @param {string} action - 按钮动作（bypass_all/enable_all）
 */
function _drawHeaderBtn(node, ctx, x, y, w, h, label, color, action) {
  node._hitHeaderBtns.push({ x, y, w, h, action });
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  drawRoundRect(ctx, x, y, w, h, 5);
  ctx.fill();
  ctx.fillStyle    = "rgba(255,255,255,0.88)";
  ctx.font         = "bold 12px sans-serif";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2);
  ctx.restore();
}

/**
 * 绘制编组行
 * @param {CanvasRenderingContext2D} ctx - Canvas上下文
 * @param {object} group - 编组实例
 * @param {number} y - Y坐标
 * @param {boolean} bypassed - 是否已跳过
 * @param {boolean} mixed - 是否部分跳过
 * @param {number} nodeCount - 编组内节点数
 * @param {number} W - 节点宽度
 */
function _drawGroupRow(ctx, group, y, bypassed, mixed, nodeCount, W) {
  ctx.save();
  // 行背景色（跳过/启用状态区分）
  ctx.fillStyle = bypassed ? "rgba(122,21,21,0.18)" : "rgba(255,255,255,0.04)";
  ctx.beginPath();
  drawRoundRect(ctx, PAD_X, y + 1, W - PAD_X * 2, ROW_H - 2, 4);
  ctx.fill();

  let textStartX = PAD_X + 8;
  // 绘制编组颜色色块
  if (group.color) {
    ctx.fillStyle = group.color;
    ctx.beginPath();
    drawRoundRect(ctx, PAD_X + 5, y + (ROW_H - 16) / 2, 6, 16, 3);
    ctx.fill();
    textStartX += 14;
  }

  // 开关按钮位置
  const btnX = W - PAD_X - BTN_W - 4;
  const btnY = y + (ROW_H - BTN_H) / 2;

  // 绘制开关按钮（跳过/启用/部分跳过）
  ctx.fillStyle = bypassed ? "#7a1515" : (mixed ? "#7a4c15" : "#155c30");
  ctx.beginPath();
  drawRoundRect(ctx, btnX, btnY, BTN_W, BTN_H, 11);
  ctx.fill();

  ctx.fillStyle    = "rgba(255,255,255,0.9)";
  ctx.font         = "bold 10px sans-serif";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    bypassed ? "已跳过" : (mixed ? "部分跳过" : "已启用"),
    btnX + BTN_W / 2, btnY + BTN_H / 2
  );

  // 绘制节点数徽章
  const cntX = btnX - 28;
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.beginPath();
  drawRoundRect(ctx, cntX, btnY, 24, BTN_H, 4);
  ctx.fill();
  ctx.fillStyle    = "#999";
  ctx.font         = "10px sans-serif";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(nodeCount), cntX + 12, btnY + BTN_H / 2);

  // 绘制编组名称（截断）
  const maxTitleW = cntX - textStartX - 6;
  ctx.fillStyle    = bypassed ? "#777" : "#ddd";
  ctx.font         = "13px sans-serif";
  ctx.textAlign    = "left";
  ctx.textBaseline = "middle";
  const title = truncateText(ctx, group.title || "未命名编组", maxTitleW);
  ctx.fillText(title, textStartX, y + ROW_H / 2);

  // 跳过状态下添加删除线
  if (bypassed) {
    const tw = ctx.measureText(title).width;
    ctx.strokeStyle = "#666";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(textStartX, y + ROW_H / 2);
    ctx.lineTo(textStartX + tw, y + ROW_H / 2);
    ctx.stroke();
  }
  ctx.restore();
}

// ─────────────────────────────────────────────
// 多组节点：鼠标事件
// ─────────────────────────────────────────────

/**
 * 处理多组控制节点的鼠标点击事件
 * @param {object} node - 多组控制节点实例
 * @param {MouseEvent} e - 鼠标事件
 * @param {Array} localPos - 节点内本地坐标 [x, y]
 * @returns {boolean} 是否处理了事件
 */
function handleMouseDownM(node, e, localPos) {
  if (!localPos) return false;
  const [mx, my] = localPos;
  const W    = node.size[0];
  const btnX = W - PAD_X - BTN_W - 4;

  // 处理互斥模式按钮点击
  const mbtn = node._hitMutexBtn;
  if (mbtn && mx >= mbtn.x && mx <= mbtn.x + mbtn.w &&
      my >= mbtn.y && my <= mbtn.y + mbtn.h) {
    const newMutexMode = !(node.properties?.mutexMode ?? false);
    node.properties.mutexMode = newMutexMode;
    
    // 开启单选模式时，如果有启用的分组，保持第一个启用，其他自动跳过
    if (newMutexMode) {
      const groups = getAllGroups();
      // 重新计算所有编组节点
      for (const g of groups) recomputeGroupNodes(g);
      
      // 找到所有启用的分组（非跳过状态）
      const enabledGroups = groups.filter(g => {
        const nodes = getGroupNodes(g);
        return nodes.length > 0 && nodes.some((n) => n.mode !== BYPASS_MODE);
      });
      
      if (enabledGroups.length > 0) {
        // 保持第一个启用的分组，跳过其他所有分组
        const firstEnabled = enabledGroups[0];
        for (const g of groups) {
          if (g !== firstEnabled) {
            setGroupBypass(g, true);
          }
        }
        // 确保第一个分组是启用的
        setGroupBypass(firstEnabled, false);
      }
    }
    
    node._lastRecomputeMs = 0;
    app.graph?.setDirtyCanvas?.(true, false);
    return true;
  }

  // 处理头部按钮点击（全部跳过/全部启用）
  for (const btn of node._hitHeaderBtns) {
    if (mx >= btn.x && mx <= btn.x + btn.w &&
        my >= btn.y && my <= btn.y + btn.h) {
      node._lastRecomputeMs = 0;
      const groups = getAllGroups();
      for (const g of groups) recomputeGroupNodes(g);
      for (const g of groups) setGroupBypass(g, btn.action === "bypass_all");
      app.graph?.setDirtyCanvas?.(true, false);
      return true;
    }
  }

  // 处理编组行点击（开关/导航）
  for (const row of node._hitRows) {
    if (my < row.y || my > row.y + ROW_H) continue;
    const btnY = row.y + (ROW_H - BTN_H) / 2;
    // 开关按钮点击：切换跳过/启用状态
    if (mx >= btnX && mx <= btnX + BTN_W &&
        my >= btnY && my <= btnY + BTN_H) {
      recomputeGroupNodes(row.group);
      
      // 互斥模式逻辑：如果开启互斥且要启用该编组，则跳过其他所有编组
      const mutexMode = node.properties?.mutexMode ?? false;
      const willBypass = !row.bypassed;
      
      if (mutexMode && !willBypass) {
        // 启用当前编组，跳过其他所有编组
        const groups = getAllGroups();
        for (const g of groups) {
          if (g !== row.group) {
            recomputeGroupNodes(g);
            setGroupBypass(g, true);
          }
        }
        // 确保当前编组启用
        setGroupBypass(row.group, false);
      } else {
        // 正常模式或要跳过当前编组
        setGroupBypass(row.group, willBypass);
      }
      
      node._lastRecomputeMs = 0;
      return true;
    }
    // 编组名称区域点击：导航至编组
    if (mx < btnX - 30) {
      navigateToGroup(row.group);
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────
// 单组节点：实例状态初始化
// ─────────────────────────────────────────────

/**
 * 初始化单组控制节点的实例状态
 * @param {object} node - 单组控制节点实例
 */
function ensureStateS(node) {
  if (node._gbcS) return;
  node._gbcS = true;  // 标记已初始化

  // 初始化选中编组属性（序列化保存）
  if (!node.properties) node.properties = {};
  if (typeof node.properties.selectedGroup !== "string") {
    node.properties.selectedGroup = "";
  }

  node._hitDropdown     = null;          // 下拉框点击区域
  node._hitToggleS      = null;          // 开关按钮点击区域
  node._lastRecomputeMs = node._lastRecomputeMs ?? 0; // 最后一次重新计算时间
  node.serialize_widgets = false;        // 不序列化widgets
  node.isVirtualNode    = true;          // 标记为虚拟节点
  node.size             = [MIN_W, SINGLE_H]; // 固定尺寸
}

// ─────────────────────────────────────────────
// 单组节点：绘制
// ─────────────────────────────────────────────

/**
 * 绘制单组控制节点
 * @param {object} node - 单组控制节点实例
 * @param {CanvasRenderingContext2D} ctx - Canvas上下文
 */
function drawSingleNode(node, ctx) {
  if (node.flags?.collapsed) return;

  node.size[1] = SINGLE_H; // 固定高度

  const W        = node.size[0];
  const groups   = getAllGroups();
  const selTitle = node.properties?.selectedGroup ?? "";
  const group    = groups.find((g) => (g.title ?? "") === selTitle) ?? null;

  // 节流重新计算选中编组的节点
  if (group) {
    const now = Date.now();
    if (now - (node._lastRecomputeMs ?? 0) >= RECOMPUTE_INTERVAL) {
      node._lastRecomputeMs = now;
      recomputeGroupNodes(group);
    }
  }

  const groupNodes = group ? getGroupNodes(group) : [];
  const bypassed   = groupNodes.length > 0 && groupNodes.every((n) => n.mode === BYPASS_MODE);
  const mixed      = !bypassed && groupNodes.some((n) => n.mode === BYPASS_MODE);

  let y = PAD_Y;

  // ── 绘制下拉框 ──────────────────────────────
  const dX = PAD_X;
  const dY = y;
  const dW = W - PAD_X * 2;
  const dH = DROPDOWN_H;
  node._hitDropdown = { x: dX, y: dY, w: dW, h: dH };

  // 下拉框背景
  ctx.save();
  ctx.fillStyle   = "rgba(255,255,255,0.06)";
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth   = 1;
  ctx.beginPath();
  drawRoundRect(ctx, dX, dY, dW, dH, 5);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // 下拉箭头
  ctx.save();
  ctx.fillStyle    = "#888";
  ctx.font         = "11px sans-serif";
  ctx.textAlign    = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("▼", dX + 8, dY + dH / 2);
  ctx.restore();

  // 编组颜色色块（下拉框右侧）
  if (group?.color) {
    ctx.save();
    ctx.fillStyle = group.color;
    ctx.beginPath();
    drawRoundRect(ctx, dX + dW - 14, dY + (dH - 14) / 2, 8, 14, 2);
    ctx.fill();
    ctx.restore();
  }

  // 下拉框文本（选中编组/提示文字）
  const displayText = selTitle || "点击选择编组…";
  const textColor   = selTitle ? "#ddd" : "#555";
  const maxTW       = dW - 30 - (group?.color ? 18 : 0);
  ctx.save();
  ctx.fillStyle    = textColor;
  ctx.font         = "13px sans-serif";
  ctx.textAlign    = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(truncateText(ctx, displayText, maxTW), dX + 24, dY + dH / 2);
  ctx.restore();

  y += dH + 6;

  // 绘制分隔线
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(PAD_X, y - 3);
  ctx.lineTo(W - PAD_X, y - 3);
  ctx.stroke();
  ctx.restore();

  // ── 绘制开关按钮行 ───────────────────────────
  const btnX = W - PAD_X - BTN_W - 4;
  const btnY = y + (ROW_H - BTN_H) / 2;
  node._hitToggleS = { x: btnX, y: btnY, w: BTN_W, h: BTN_H };

  if (!group) {
    // 未选择编组：禁用开关按钮
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.beginPath();
    drawRoundRect(ctx, btnX, btnY, BTN_W, BTN_H, 11);
    ctx.fill();
    ctx.fillStyle    = "#555";
    ctx.font         = "bold 10px sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("未选择", btnX + BTN_W / 2, btnY + BTN_H / 2);
    ctx.restore();

    // 提示文字
    ctx.save();
    ctx.fillStyle    = "#444";
    ctx.font         = "italic 11px sans-serif";
    ctx.textAlign    = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("请先选择编组", PAD_X + 4, y + ROW_H / 2);
    ctx.restore();
  } else {
    // 已选择编组：绘制开关按钮
    ctx.save();
    ctx.fillStyle = bypassed ? "#7a1515" : (mixed ? "#7a4c15" : "#155c30");
    ctx.beginPath();
    drawRoundRect(ctx, btnX, btnY, BTN_W, BTN_H, 11);
    ctx.fill();
    ctx.fillStyle    = "rgba(255,255,255,0.9)";
    ctx.font         = "bold 10px sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      bypassed ? "已跳过" : (mixed ? "部分跳过" : "已启用"),
      btnX + BTN_W / 2, btnY + BTN_H / 2
    );
    ctx.restore();

    // 绘制节点数徽章
    const cntX = btnX - 28;
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    ctx.beginPath();
    drawRoundRect(ctx, cntX, btnY, 24, BTN_H, 4);
    ctx.fill();
    ctx.fillStyle    = "#999";
    ctx.font         = "10px sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(groupNodes.length), cntX + 12, btnY + BTN_H / 2);
    ctx.restore();

    // 绘制编组名称标签（左侧）
    ctx.save();
    ctx.fillStyle    = bypassed ? "#777" : "#bbb";
    ctx.font         = "12px sans-serif";
    ctx.textAlign    = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(
      truncateText(ctx, group.title || "未命名编组", cntX - PAD_X - 8),
      PAD_X + 4, y + ROW_H / 2
    );
    ctx.restore();
  }
}

// ─────────────────────────────────────────────
// 单组节点：鼠标事件
// ─────────────────────────────────────────────

/**
 * 处理单组控制节点的鼠标点击事件
 * @param {object} node - 单组控制节点实例
 * @param {MouseEvent} e - 鼠标事件
 * @param {Array} localPos - 节点内本地坐标 [x, y]
 * @returns {boolean} 是否处理了事件
 */
function handleMouseDownS(node, e, localPos) {
  if (!localPos) return false;
  const [mx, my] = localPos;

  // 下拉框点击：弹出编组选择菜单
  const dd = node._hitDropdown;
  if (dd && mx >= dd.x && mx <= dd.x + dd.w &&
             my >= dd.y && my <= dd.y + dd.h) {
    _showGroupMenu(node, e);
    return true;
  }

  // 开关按钮点击：切换选中编组的跳过状态
  const tg = node._hitToggleS;
  if (tg && mx >= tg.x && mx <= tg.x + tg.w &&
             my >= tg.y && my <= tg.y + tg.h) {
    const selTitle = node.properties?.selectedGroup ?? "";
    const group    = getAllGroups().find((g) => (g.title ?? "") === selTitle) ?? null;
    if (group) {
      recomputeGroupNodes(group);
      const nodes    = getGroupNodes(group);
      const bypassed = nodes.length > 0 && nodes.every((n) => n.mode === BYPASS_MODE);
      setGroupBypass(group, !bypassed);
      node._lastRecomputeMs = 0;
    }
    return true;
  }

  return false;
}

/**
 * 显示编组选择菜单
 * @param {object} node - 单组控制节点实例
 * @param {MouseEvent} e - 鼠标事件
 */
function _showGroupMenu(node, e) {
  const groups = getAllGroups();

  // 无编组时显示禁用菜单
  if (!groups.length) {
    new LiteGraph.ContextMenu(
      [{ content: "（工作流中没有编组）", disabled: true }],
      { event: e }
    );
    return;
  }

  // 构建编组菜单选项
  const items = groups.map((g) => ({
    content: g.title || "未命名编组",
    callback: () => {
      node.properties.selectedGroup = g.title ?? "";
      node._lastRecomputeMs = 0;
      app.graph?.setDirtyCanvas?.(true, false);
    },
  }));

  // 显示上下文菜单
  new LiteGraph.ContextMenu(items, {
    event:      e,
    callback:   null,
    parentMenu: null,
  });
}

// ─────────────────────────────────────────────
// 分组控制节点：实例状态初始化
// ─────────────────────────────────────────────
function ensureStateG(node) {
  if (node._gbcG) return;
  node._gbcG = true;
  if (!node.properties) node.properties = {};
  if (!Array.isArray(node.properties.gSlots)) node.properties.gSlots = [null]; // [title | null]
  if (typeof node.properties.gMutex !== "boolean") node.properties.gMutex = false;
  if (typeof node.properties.gColor !== "string") node.properties.gColor = "";
  node._gHit  = { count: null, minus: null, plus: null, color: null, mutex: null };
  node._gRows = [];
  node._lastRecomputeMs = node._lastRecomputeMs ?? 0;
  node.serialize_widgets = false;
  node.isVirtualNode    = true;
}

// 计算分组控制节点高度
function computeHeightG(node) {
  const slots = node.properties?.gSlots ?? [null];
  let h = G_PAD + G_HEADER_H + G_ROW_GAP;
  for (const s of slots) h += (s == null ? G_DD_H : G_ROW_H) + G_ROW_GAP;
  h += G_PAD;
  return h;
}

function inRect(mx, my, r) {
  return mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;
}

// ─────────────────────────────────────────────
// 分组控制节点：绘制
// ─────────────────────────────────────────────
function drawGroupNode(node, ctx) {
  if (node.flags?.collapsed) return;

  const now    = Date.now();
  const groups = getAllGroups();
  let slots  = node.properties?.gSlots ?? [null];
  const _mig = migrateSlots(node);
  if (_mig) { node.properties.gSlots = _mig; slots = _mig; }

  // 同步已删除的编组：颜色筛选后删组 → 对应下拉框移除；全删 → 恢复初始（无筛选 + 一个空下拉框）
  {
    let pruned = false;
    const keep = [];
    for (const k of slots) {
      if (k == null) { keep.push(null); continue; }
      if (resolveGroupByKey(k)) keep.push(k);
      else pruned = true;
    }
    if (pruned) {
      const live = keep.filter((k) => k != null);
      if (node.properties.gColor && live.length === 0) {
        node.properties.gColor = "";
        node.properties.gSlots = [null];
        slots = [null];
      } else {
        node.properties.gSlots = keep.length ? keep : [null];
        slots = node.properties.gSlots;
      }
    }
  }

  // 节流重新计算已选编组
  if (now - (node._lastRecomputeMs ?? 0) >= G_RECOMP) {
    node._lastRecomputeMs = now;
    for (const g of groups) {
      if (slots.includes(g.title ?? "")) recomputeGroupNodes(g);
    }
  }

  const W = node.size[0];
  const neededH = computeHeightG(node);
  if (Math.abs(node.size[1] - neededH) > 1) node.size[1] = neededH;

  node._gHit  = { count: null, minus: null, plus: null, color: null, mutex: null };
  node._gRows = [];

  let y = G_PAD;

  // ── 顶部控制条 ──
  const mutexW = 70;
  ctx.save();
  ctx.fillStyle = "#aaa"; ctx.font = "12px sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("数量 " + slots.filter((s) => s != null).length, G_PAD, y + G_HEADER_H / 2);
  ctx.restore();

  const smBtnY = y + (G_HEADER_H - G_SM_BTN) / 2;
  const minusX = G_PAD + 56;
  node._gHit.minus = { x: minusX, y: smBtnY, w: G_SM_BTN, h: G_SM_BTN };
  _drawSmallBtn(ctx, minusX, smBtnY, G_SM_BTN, G_SM_BTN, "−", "#33383f", slots.length > G_MIN_ROWS);

  const plusX = minusX + G_SM_BTN + 4;
  node._gHit.plus = { x: plusX, y: smBtnY, w: G_SM_BTN, h: G_SM_BTN };
  _drawSmallBtn(ctx, plusX, smBtnY, G_SM_BTN, G_SM_BTN, "+", "#33383f", slots.length < G_MAX_ROWS);

  const colorX = plusX + G_SM_BTN + 10;
  const colorW = Math.max(40, W - G_PAD - mutexW - 6 - colorX);
  const gColor = node.properties?.gColor ?? "";
  const hasFilter = (node.properties?.gSlots ?? []).some((s) => s);
  const colorLabel = gColor ? colorName(gColor) : (hasFilter ? "无色" : "颜色筛选");
  node._gHit.color = { x: colorX, y: smBtnY, w: colorW, h: G_SM_BTN + 4 };
  _drawColorMatchBtn(ctx, colorX, smBtnY, colorW, G_SM_BTN + 4, gColor, colorLabel);

  const mutexX = W - G_PAD - mutexW;
  node._gHit.mutex = { x: mutexX, y: smBtnY, w: mutexW, h: G_SM_BTN + 4 };
  const mutexOn = node.properties?.gMutex ?? false;
  ctx.save();
  ctx.fillStyle = mutexOn ? "#1a73e8" : "rgba(255,255,255,0.06)";
  ctx.strokeStyle = mutexOn ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath(); drawRoundRect(ctx, mutexX, smBtnY, mutexW, G_SM_BTN + 4, 5);
  ctx.fill();
  if (!mutexOn) ctx.stroke();
  ctx.fillStyle = mutexOn ? "#fff" : "#888";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("单选模式", mutexX + mutexW / 2, smBtnY + (G_SM_BTN + 4) / 2);
  ctx.restore();

  y += G_HEADER_H + G_ROW_GAP;

  // 分隔线
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.1)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(G_PAD, y - 2); ctx.lineTo(W - G_PAD, y - 2); ctx.stroke();
  ctx.restore();

  // ── 编组行 ──
  for (let i = 0; i < slots.length; i++) {
    const key = slots[i];
    if (key == null) {
      const dX = G_PAD, dY = y, dW = W - G_PAD * 2, dH = G_DD_H;
      node._gRows.push({ kind: "dd", i, x: dX, y: dY, w: dW, h: dH });
      _drawPendingDropdown(ctx, dX, dY, dW, dH);
      y += G_DD_H + G_ROW_GAP;
    } else {
      const group    = resolveGroupByKey(key);
      const gNodes   = group ? getGroupNodes(group) : [];
      const bypassed = gNodes.length > 0 && gNodes.every((n) => n.mode === BYPASS_MODE);
      const mixed    = !bypassed && gNodes.some((n) => n.mode === BYPASS_MODE);
      node._gRows.push({ kind: "row", i, y, bypassed, mixed, key });
      _drawOptRow(ctx, group, y, bypassed, mixed, gNodes.length, W, i);
      y += G_ROW_H + G_ROW_GAP;
    }
  }
}

function _drawSmallBtn(ctx, x, y, w, h, label, bg, enabled) {
  ctx.save();
  ctx.globalAlpha = enabled ? 1 : 0.4;
  ctx.fillStyle = bg;
  ctx.beginPath(); drawRoundRect(ctx, x, y, w, h, 4); ctx.fill();
  ctx.fillStyle = "#eee"; ctx.font = "bold 16px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2);
  ctx.restore();
}

function _drawColorMatchBtn(ctx, x, y, w, h, gColor, label) {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1;
  ctx.beginPath(); drawRoundRect(ctx, x, y, w, h, 5); ctx.fill(); ctx.stroke();
  let tx = x + 8;
  if (gColor) {
    ctx.fillStyle = gColor;
    ctx.beginPath(); drawRoundRect(ctx, tx, y + (h - 14) / 2, 8, 14, 2); ctx.fill();
    tx += 16;
  }
  const text = label ?? (gColor ? colorName(gColor) : "颜色筛选");
  ctx.fillStyle = gColor ? "#ddd" : "#888";
  ctx.font = "12px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText(text, tx, y + h / 2);
  ctx.restore();
}

function _drawPendingDropdown(ctx, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1;
  ctx.beginPath(); drawRoundRect(ctx, x, y, w, h, 5); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#888"; ctx.font = "11px sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("▼", x + 8, y + h / 2);
  ctx.fillStyle = "#555"; ctx.font = "12px sans-serif";
  ctx.fillText("选择编组…", x + 24, y + h / 2);
  ctx.restore();
}

function _drawOptRow(ctx, group, y, bypassed, mixed, nodeCount, W) {
  ctx.save();
  ctx.fillStyle = bypassed ? "rgba(122,21,21,0.18)" : "rgba(255,255,255,0.04)";
  ctx.beginPath(); drawRoundRect(ctx, G_PAD, y + 1, W - G_PAD * 2, G_ROW_H - 2, 4); ctx.fill();
  let textStartX = G_PAD + 8;
  if (group?.color) {
    ctx.fillStyle = group.color;
    ctx.beginPath(); drawRoundRect(ctx, G_PAD + 5, y + (G_ROW_H - 16) / 2, 6, 16, 3); ctx.fill();
    textStartX += 14;
  }
  const btnX = W - G_PAD - G_BTN_W - 4;
  const btnY = y + (G_ROW_H - G_BTN_H) / 2;
  ctx.fillStyle = bypassed ? "#7a1515" : (mixed ? "#7a4c15" : "#155c30");
  ctx.beginPath(); drawRoundRect(ctx, btnX, btnY, G_BTN_W, G_BTN_H, 11); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(bypassed ? "已跳过" : (mixed ? "部分跳过" : "已启用"), btnX + G_BTN_W / 2, btnY + G_BTN_H / 2);
  const cntX = btnX - 28;
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.beginPath(); drawRoundRect(ctx, cntX, btnY, 24, G_BTN_H, 4); ctx.fill();
  ctx.fillStyle = "#999"; ctx.font = "10px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(String(nodeCount), cntX + 12, btnY + G_BTN_H / 2);
  const maxTitleW = cntX - textStartX - 6;
  ctx.fillStyle = bypassed ? "#777" : "#ddd"; ctx.font = "13px sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText(truncateText(ctx, group?.title || "未命名编组", maxTitleW), textStartX, y + G_ROW_H / 2);
  ctx.restore();
}

// ─────────────────────────────────────────────
// 分组控制节点：鼠标事件
// ─────────────────────────────────────────────
function handleMouseDownG(node, e, localPos) {
  if (!localPos) return false;
  const [mx, my] = localPos;
  const W = node.size[0];
  const slots = node.properties?.gSlots ?? [null];

  const h = node._gHit;
  if (h.minus && inRect(mx, my, h.minus) && slots.length > G_MIN_ROWS) {
    // 手动增减组数量时，若当前处于颜色筛选状态则先取消筛选回到默认
    if (node.properties?.gColor) { node.properties.gColor = ""; node.properties.gSlots = [null]; }
    else { node.properties.gSlots = slots.slice(0, -1); }
    node._lastRecomputeMs = 0; app.graph?.setDirtyCanvas?.(true, false); return true;
  }
  if (h.plus && inRect(mx, my, h.plus) && slots.length < G_MAX_ROWS) {
    if (node.properties?.gColor) { node.properties.gColor = ""; node.properties.gSlots = [null, null]; }
    else { node.properties.gSlots = [...slots, null]; }
    node._lastRecomputeMs = 0; app.graph?.setDirtyCanvas?.(true, false); return true;
  }
  if (h.color && inRect(mx, my, h.color)) {
    _showColorMenu(node, e); return true;
  }
  if (h.mutex && inRect(mx, my, h.mutex)) {
    const newMutex = !(node.properties?.gMutex ?? false);
    node.properties.gMutex = newMutex;
    if (newMutex) {
      const firstTitle = slots.find((s) => s != null);
      applyMutexG(node, firstTitle);
    }
    node._lastRecomputeMs = 0; app.graph?.setDirtyCanvas?.(true, false); return true;
  }

  for (const row of node._gRows) {
    if (my < row.y || my > row.y + (row.kind === "dd" ? G_DD_H : G_ROW_H)) continue;
    if (row.kind === "dd") {
      _showOptionalGroupMenu(node, row.i, e); return true;
    }
    const btnX = W - G_PAD - G_BTN_W - 4;
    const btnY = row.y + (G_ROW_H - G_BTN_H) / 2;
    if (mx >= btnX && mx <= btnX + G_BTN_W && my >= btnY && my <= btnY + G_BTN_H) {
      _toggleOptGroup(node, row.key); return true;
    }
    if (mx < btnX - 30) {
      _showOptionalGroupMenu(node, row.i, e); return true;
    }
  }
  return false;
}

function _toggleOptGroup(node, key) {
  const group = resolveGroupByKey(key);
  if (!group) return;
  recomputeGroupNodes(group);
  const nodes    = getGroupNodes(group);
  const bypassed = nodes.length > 0 && nodes.every((n) => n.mode === BYPASS_MODE);
  const willEnable = bypassed;
  if (node.properties?.gMutex && willEnable) {
    applyMutexG(node, key);
  } else {
    setGroupBypass(group, !willEnable);
  }
  node._lastRecomputeMs = 0;
}

function applyMutexG(node, keepKey) {
  const slots = node.properties?.gSlots ?? [];
  for (const k of slots) {
    if (k == null) continue;
    const g = resolveGroupByKey(k);
    if (!g) continue;
    recomputeGroupNodes(g);
    setGroupBypass(g, k !== keepKey);
  }
}

// ─────────────────────────────────────────────
// 分组控制节点：下拉菜单（颜色筛选 / 编组选择）—— 自定义下拉，稳定显示色块
// ─────────────────────────────────────────────
function _showColorMenu(node, e) {
  const groups = getAllGroups();
  const colorCount = {};
  const colorSet = [];
  let noColor = 0;
  for (const g of groups) {
    if (!g.color) { noColor++; continue; }
    colorCount[g.color] = (colorCount[g.color] || 0) + 1;
    if (!colorSet.includes(g.color)) colorSet.push(g.color);
  }
  // 按原生编组颜色顺序排序（无色、红、棕、绿、蓝、淡蓝、青、紫、黄、黑），其余置后
  const NATIVE_ORDER = ["#a82a2a","#902808","#3fa870","#2a4b7a","#3f3fbf","#1a9acf","#7a52c7","#a8991a","#cf7a1a","#444"];
  colorSet.sort((a, b) => {
    const ia = NATIVE_ORDER.indexOf(a), ib = NATIVE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  const items = [{ label: "✕ 取消筛选", callback: () => _clearColorFilter(node) }];
  if (noColor > 0) {
    items.push({ label: "无色 (" + noColor + ")", color: null, callback: () => _applyColorFilter(node, "") });
  }
  for (const c of colorSet) {
    items.push({ label: colorName(c), color: c, count: colorCount[c] || 0, callback: () => _applyColorFilter(node, c) });
  }
  const h = node._gHit?.color;
  const anchor = _eventClientPos(e) || nodeLocalToScreen(node, h?.x ?? G_PAD, (h?.y ?? 0) + (G_SM_BTN + 4));
  openJosiaDropdown(anchor[0], anchor[1], items);
}

// 应用颜色筛选：完全替换当前节点的组列表为该颜色下的【所有】编组（按 id 主键）
function _applyColorFilter(node, color) {
  const groups = getAllGroups();
  const keys = [];
  for (const g of groups) {
    if ((g.color ?? "") === color) {
      const k = groupIdOf(g);
      if (!keys.includes(k)) keys.push(k);
    }
  }
  node.properties.gSlots = keys.length ? keys.slice(0, G_MAX_ROWS) : [null];
  node.properties.gColor = color;
  for (const g of groups) recomputeGroupNodes(g);
  node._lastRecomputeMs = 0;
  app.graph?.setDirtyCanvas?.(true, false);
}

// 取消筛选：恢复默认（清除筛选标记 + 组列表回到初始空状态），节点按钮显示"颜色筛选"
function _clearColorFilter(node) {
  node.properties.gColor = "";
  node.properties.gSlots = [null];
  node._lastRecomputeMs = 0;
  app.graph?.setDirtyCanvas?.(true, false);
}

function _showOptionalGroupMenu(node, slotIndex, e) {
  const groups = getAllGroups();
  const slots = node.properties?.gSlots ?? [];
  const items = [];
  for (const g of groups) {
    const k = groupIdOf(g);
    if (slots.includes(k)) continue; // 已选中的编组不再出现
    items.push({
      label: g.title || "未命名编组",
      color: g.color,
      count: getGroupNodeCount(g),
      callback: () => {
        const s = node.properties.gSlots;
        if (slotIndex < s.length) s[slotIndex] = k;
        node._lastRecomputeMs = 0;
        app.graph?.setDirtyCanvas?.(true, false);
      },
    });
  }
  if (!items.length) items.push({ label: "（没有可添加的编组）", disabled: true });
  const row = node._gRows.find((r) => r.kind === "dd" && r.i === slotIndex);
  const anchor = _eventClientPos(e) || nodeLocalToScreen(node, row?.x ?? G_PAD, (row?.y ?? 0) + (row?.h ?? G_DD_H));
  openJosiaDropdown(anchor[0], anchor[1], items);
}

// ─────────────────────────────────────────────
// 注册扩展（ComfyUI 标准方式）
// ─────────────────────────────────────────────
app.registerExtension({
  name: "JosiaGroupController",  // 扩展名称

  /**
   * 注册节点前的钩子（扩展节点功能）
   * @param {function} nodeType - 节点类型构造函数
   * @param {object} nodeData - 节点元数据
   */
  async beforeRegisterNodeDef(nodeType, nodeData) {

    // ════════════════════════════════════════
    // JosiaGroupControllerM — 多组控制节点扩展
    // ════════════════════════════════════════
    if (nodeData.name === NODE_NAME_M) {

      // 扩展onAdded：初始化状态
      const origOnAddedM = nodeType.prototype.onAdded;
      nodeType.prototype.onAdded = function (graph) {
        ensureStateM(this);
        origOnAddedM?.call(this, graph);
      };

      // 扩展computeSize：动态计算节点高度
      nodeType.prototype.computeSize = function () {
        ensureStateM(this);
        return [MIN_W, computeHeightM(getAllGroups().length)];
      };

      // 扩展onDrawForeground：自定义绘制
      nodeType.prototype.onDrawForeground = function (ctx) {
        ensureStateM(this);
        drawMultiNode(this, ctx);
      };

      // 扩展onMouseDown：处理鼠标点击
      const origMouseDownM = nodeType.prototype.onMouseDown;
      nodeType.prototype.onMouseDown = function (e, localPos, canvas) {
        ensureStateM(this);
        if (handleMouseDownM(this, e, localPos)) return true;
        return origMouseDownM?.call(this, e, localPos, canvas) ?? false;
      };

      // 扩展右键菜单：添加批量操作选项
      const origMenuM = nodeType.prototype.getExtraMenuOptions;
      nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
        origMenuM?.call(this, canvas, options);
        const self = this;
        options.unshift(
          {
            content: "跳过所有编组",
            callback: () => {
              self._lastRecomputeMs = 0;
              const groups = getAllGroups();
              for (const g of groups) recomputeGroupNodes(g);
              for (const g of groups) setGroupBypass(g, true);
            },
          },
          {
            content: "启用所有编组",
            callback: () => {
              self._lastRecomputeMs = 0;
              const groups = getAllGroups();
              for (const g of groups) recomputeGroupNodes(g);
              for (const g of groups) setGroupBypass(g, false);
            },
          },
          null  // 分隔线
        );
      };
    }

    // ════════════════════════════════════════
    // JosiaGroupControllerS — 单组控制节点扩展
    // ════════════════════════════════════════
    if (nodeData.name === NODE_NAME_S) {

      // 扩展onAdded：初始化状态
      const origOnAddedS = nodeType.prototype.onAdded;
      nodeType.prototype.onAdded = function (graph) {
        ensureStateS(this);
        origOnAddedS?.call(this, graph);
      };

      // 扩展computeSize：固定节点高度
      nodeType.prototype.computeSize = function () {
        ensureStateS(this);
        return [MIN_W, SINGLE_H];
      };

      // 扩展onDrawForeground：自定义绘制
      nodeType.prototype.onDrawForeground = function (ctx) {
        ensureStateS(this);
        drawSingleNode(this, ctx);
      };

      // 扩展onMouseDown：处理鼠标点击
      const origMouseDownS = nodeType.prototype.onMouseDown;
      nodeType.prototype.onMouseDown = function (e, localPos, canvas) {
        ensureStateS(this);
        if (handleMouseDownS(this, e, localPos)) return true;
        return origMouseDownS?.call(this, e, localPos, canvas) ?? false;
      };

      // 扩展右键菜单：添加单组操作选项
      const origMenuS = nodeType.prototype.getExtraMenuOptions;
      nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
        origMenuS?.call(this, canvas, options);
        const self = this;
        options.unshift(
          {
            content: "跳过该编组",
            callback: () => {
              const selTitle = self.properties?.selectedGroup ?? "";
              const group    = getAllGroups().find((g) => (g.title ?? "") === selTitle) ?? null;
              if (group) { recomputeGroupNodes(group); setGroupBypass(group, true); }
            },
          },
          {
            content: "启用该编组",
            callback: () => {
              const selTitle = self.properties?.selectedGroup ?? "";
              const group    = getAllGroups().find((g) => (g.title ?? "") === selTitle) ?? null;
              if (group) { recomputeGroupNodes(group); setGroupBypass(group, false); }
            },
          },
          null  // 分隔线
        );
      };
    }

    // ════════════════════════════════════════
    // JosiaGroupControllerG — 分组控制节点扩展
    // ════════════════════════════════════════
    if (nodeData.name === NODE_NAME_G) {

      const origOnAddedG = nodeType.prototype.onAdded;
      nodeType.prototype.onAdded = function (graph) {
        ensureStateG(this);
        origOnAddedG?.call(this, graph);
      };

      nodeType.prototype.computeSize = function () {
        ensureStateG(this);
        return [G_MIN_W, computeHeightG(this)];
      };

      nodeType.prototype.onDrawForeground = function (ctx) {
        ensureStateG(this);
        drawGroupNode(this, ctx);
      };

      const origMouseDownG = nodeType.prototype.onMouseDown;
      nodeType.prototype.onMouseDown = function (e, localPos, canvas) {
        ensureStateG(this);
        if (handleMouseDownG(this, e, localPos)) return true;
        return origMouseDownG?.call(this, e, localPos, canvas) ?? false;
      };
    }
  },

  /**
   * 工作流加载后刷新节点尺寸
   * @param {object} node - 加载的节点实例
   */
  loadedGraphNode(node) {
    const isM = node.type === NODE_TYPE_M || node.comfyClass === NODE_NAME_M;
    const isS = node.type === NODE_TYPE_S || node.comfyClass === NODE_NAME_S;
    const isG = node.type === NODE_TYPE_G || node.comfyClass === NODE_NAME_G;
    if (!isM && !isS && !isG) return;

    requestAnimationFrame(() => {
      if (isM) {
        ensureStateM(node);
        node.size[1] = computeHeightM(getAllGroups().length);
      } else if (isG) {
        ensureStateG(node);
        node.size[1] = computeHeightG(node);
      } else {
        ensureStateS(node);
        node.size[1] = SINGLE_H;
      }
      app.graph?.setDirtyCanvas?.(true, false);
    });
  },
});