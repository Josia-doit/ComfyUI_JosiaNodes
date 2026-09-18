/**
 * Josia Group Enhancements — 编组增强补丁（旧版画布模式）
 *
 * 功能（两个独立开关，均默认关闭）：
 *   1) 四角缩放（JosiaNodes.CornerResize）：
 *      原生只有右下角可缩放，本补丁补上 左上 / 右上 / 左下 三个角；
 *      内部节点绝不跟随移动（只改 group.pos / group.size，等价于原生 resize 语义）。
 *      对齐网格与原生完全一致：开启全局「对齐网格」时，只有「正在拖动的角」吸附到网格，
 *      锚点角（相对角）保持不动，再由其反算宽高 —— 与 LGraphCanvas 原生右下角 resize 的
 *      snapToGrid 行为一致（canvas.snapToGrid 为真则按 canvas.grid_size 吸附）。
 *   2) 编组标题按钮（JosiaNodes.GroupTitleButtons）：
 *        • 「绕」— 一键绕过 / 恢复（切换）编组内所有节点（Bypass）
 *        • 「适」— 适配组内节点（顶边距 = 标题栏高度 + 3 格网格、左右下边距 2 格网格；开启"对齐网格"时整体吸附网格）
 *
 * 设置面板分类：⚡️JosiaNodes（带 ⚡️ Emoji，独立成项，不归入「其他」）。
 * 两个开关同处「编组增强」分栏：编组四角缩放 + 编组标题按钮。
 *
 * 实现严格对齐 ComfyUI 当前 litegraph（@comfyorg/litegraph）原生逻辑：
 *   - 编组由 LGraphGroup.prototype.draw(graphCanvas, ctx) 绘制；
 *   - 右下角 resize 标记颜色 = group.color + graphCanvas.editor_alpha，路径为
 *     moveTo(x+W, y+H) -> lineTo(x+W-RL, y+H) -> lineTo(x+W, y+H-RL)（不加 0.5）；
 *   - 四角标记完全镜像该公式，保证与右下角视觉一致、无偏移；
 *   - 交互通过 window capture 阶段 pointerdown 优先拦截，命中即 stopPropagation，
 *     不再被标题栏双击改标题 / 原生缩放劫持。
 */

import { app } from "../../scripts/app.js";

const BYPASS_MODE = 4;
const ACTIVE_MODE = 0;
const ENH_BTN_W   = 22;   // 标题栏按钮宽
const ENH_BTN_H   = 16;   // 标题栏按钮高
const ENH_GAP     = 4;    // 按钮间距（= 上下边距，视觉居中）
const GROUP_MIN_W = 80;   // 编组最小宽（拖拽保底，避免缩到 0）
const GROUP_MIN_H = 80;   // 编组最小高

// ─────────────────────────────────────────────
// 设置开关（ComfyUI 设置面板：⚡️JosiaNodes，两个独立开关、各自独立子分类，默认关闭）
// ─────────────────────────────────────────────
let _cornerResizeEnabled = false;   // 四角缩放（左上/右上/左下）
let _titleButtonsEnabled = false;   // 编组标题按钮（绕/适）

// 任一开关开启即需要接管绘制与命中（draw 补丁常驻，内部各自再判断）
function isGroupEnhEnabled() { return _cornerResizeEnabled || _titleButtonsEnabled; }
function cornerResizeOn() { return _cornerResizeEnabled; }
function titleButtonsOn() { return _titleButtonsEnabled; }
function setCornerResize(v) { _cornerResizeEnabled = !!v; }
function setTitleButtons(v) { _titleButtonsEnabled = !!v; }

function readSetting(id) {
  try {
    if (app.ui?.settings?.getSettingValue) return app.ui.settings.getSettingValue(id);
    if (app.extensionManager?.settings?.getSettingValue) return app.extensionManager.settings.getSettingValue(id);
    if (app.settings?.getSettingValue) return app.settings.getSettingValue(id);
    if (app.settings?.get) return app.settings.get(id);
  } catch (_) {}
  return undefined;
}

// ─────────────────────────────────────────────
// LiteGraph 辅助
// ─────────────────────────────────────────────
function getLG() { return (typeof window !== "undefined" && window.LiteGraph) ? window.LiteGraph : null; }

function getGroupClass() {
  const LG = getLG();
  if (LG && LG.LGraphGroup) return LG.LGraphGroup;
  const g0 = app.canvas?.graph?.groups?.[0] ?? app.canvas?.graph?._groups?.[0];
  return g0?.constructor;
}

function titleHeight() {
  return getLG()?.NODE_TITLE_HEIGHT || 24;
}

function defaultColour() {
  const GC = getGroupClass();
  return GC?.defaultColour || getLG()?.DEFAULT_GROUP_COLOR || "#335";
}

function resizeLength() {
  const GC = getGroupClass();
  return GC?.resizeLength || 10;
}

function cornerCursor(corner) {
  // 左上/右下 => nwse-resize；左下/右上 => nesw-resize（与用户要求一致）
  return (corner === "tl" || corner === "br") ? "nwse-resize" : "nesw-resize";
}

// ─────────────────────────────────────────────
// 动作
// ─────────────────────────────────────────────
function _groupNodes(g) {
  if (g._children instanceof Set) {
    return Array.from(g._children).filter((c) => c && typeof c === "object" && "mode" in c);
  }
  return g.nodes ?? g._nodes ?? [];
}

function toggleBypassGroup(g) {
  try { g.recomputeInsideNodes?.(); } catch (_) {}
  const ns = _groupNodes(g);
  if (!ns.length) return;
  const allBypassed = ns.every((n) => n.mode === BYPASS_MODE);
  const target = allBypassed ? ACTIVE_MODE : BYPASS_MODE;
  for (const n of ns) n.mode = target;
  (g.graph ?? app.graph)?.setDirtyCanvas?.(true, false);
}

// 纯函数：根据子节点 bbox 计算适配矩形（含上下左右非对称边距 + 可选网格吸附）
//   - 上边距 = 3 格网格、左右下边距 = 2 格网格（grid 由调用方从 canvas.grid_size 等取得）
//   - snap=true 时四条边各自 round 到 grid 整数倍（与原生 snapToGrid 行为一致）
// 返回 {x, y, w, h}，无子节点返回 null。
function computeFitRect(nodes, grid, snap) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (!n || !n.pos) continue;
    const nx = n.pos[0], ny = n.pos[1];
    const nw = (n.size && n.size[0]) || 100;
    const nh = (n.size && n.size[1]) || 100;
    if (nx < minX) minX = nx;
    if (ny < minY) minY = ny;
    if (nx + nw > maxX) maxX = nx + nw;
    if (ny + nh > maxY) maxY = ny + nh;
  }
  if (!isFinite(minX)) return null;
  // 顶边距 = 标题栏高度 + 3 格网格：编组自带标题栏会吃掉一部分上边距，
  // 仅留 3 格会让节点顶边几乎贴住标题栏（视觉距≈0）；加标题栏高度后标题下方真正留 3 格。
  const topM = titleHeight() + 3 * grid;
  const sideM = 2 * grid;  // 左右边距 2 格
  const botM = 2 * grid;   // 下边距 2 格
  let x = minX - sideM;
  let y = minY - topM;
  let right = maxX + sideM;
  let bottom = maxY + botM;
  if (snap) {
    const s = (v) => Math.round(v / grid) * grid;
    x = s(x); y = s(y); right = s(right); bottom = s(bottom);
  }
  return { x, y, w: right - x, h: bottom - y };
}

// 适配组内节点（重新设计）：
//   1) 上边距 3 格网格、左右下边距 2 格网格（边距以 grid_size 为单位，与四角缩放一致）；
//   2) 开启全局「对齐网格」时，最终 pos/size 也吸附到网格线（四条边各自 round 到 grid 整数倍），
//      保证编组整体落在网格上，与四角缩放的吸附行为完全一致；
//   3) pinned 编组不可适配；空编组直接返回。
function fitGroupToNodes(g) {
  if (g.pinned) return;
  try { g.recomputeInsideNodes?.(); } catch (_) {}
  const nodes = _groupNodes(g);
  if (!nodes || nodes.length === 0) return;
  const grid = getGridSize();
  const r = computeFitRect(nodes, grid, isSnapToGrid());
  if (!r) return;
  let { x, y, w, h } = r;
  // 最小尺寸保底（吸附时按 grid 整数倍对齐，保持网格一致性）
  const minW = isSnapToGrid() ? Math.max(GROUP_MIN_W, Math.ceil(GROUP_MIN_W / grid) * grid) : GROUP_MIN_W;
  const minH = isSnapToGrid() ? Math.max(GROUP_MIN_H, Math.ceil(GROUP_MIN_H / grid) * grid) : GROUP_MIN_H;
  if (w < minW) w = minW;
  if (h < minH) h = minH;
  g.pos = [x, y];
  g.size = [w, h];
  try { g.recomputeInsideNodes?.(); } catch (_) {}
  const cv = app.canvas;
  if (cv) { cv.dirty_canvas = true; cv.dirty_bgcanvas = true; }
}

// ─────────────────────────────────────────────
// 绘制：标题栏按钮 + 四角标（与右下角原生同款）
// ─────────────────────────────────────────────
function _drawEnhBtn(ctx, x, y, w, h, label, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, 3);
  else ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
  ctx.restore();
}

// 实心角标 —— 完全镜像原生右下角标记（不加 0.5，保证与右下角视觉一致、无偏移）
function _drawCorner(ctx, cx, cy, corner, color, alpha) {
  const s = resizeLength();
  ctx.save();
  ctx.globalAlpha = alpha ?? 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (corner === "tl") {
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + s, cy);
    ctx.lineTo(cx, cy + s);
  } else if (corner === "tr") {
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - s, cy);
    ctx.lineTo(cx, cy + s);
  } else if (corner === "bl") {
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + s, cy);
    ctx.lineTo(cx, cy - s);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawGroupEnhUI(group, graphCanvas, ctx) {
  if (!isGroupEnhEnabled()) return;   // 两个开关都关时不绘制（零干扰）
  const x = group.pos[0], y = group.pos[1];
  const W = group.size[0], H = group.size[1];
  const th = titleHeight();
  const M = Math.max(2, (th - ENH_BTN_H) / 2);
  const color = group.color || defaultColour();
  const alpha = graphCanvas?.editor_alpha ?? 1;

  ctx.save();
  // 标题栏按钮（垂直居中、右边距 = 上下边距 M）—— 仅「编组标题按钮」开启时
  if (titleButtonsOn()) {
    const bypassX = x + W - M - ENH_BTN_W;
    const fitX    = bypassX - ENH_GAP - ENH_BTN_W;
    const by      = y + M;
    _drawEnhBtn(ctx, bypassX, by, ENH_BTN_W, ENH_BTN_H, "绕", "#7a4c15");
    _drawEnhBtn(ctx, fitX, by, ENH_BTN_W, ENH_BTN_H, "适", "#155c30");
  }

  // 四角缩放提示（左上 / 右上 / 左下；右下角由 ComfyUI 原生处理）—— 仅「四角缩放」开启时
  if (cornerResizeOn()) {
    _drawCorner(ctx, x,      y,      "tl", color, alpha);
    _drawCorner(ctx, x + W,  y,      "tr", color, alpha);
    _drawCorner(ctx, x,      y + H,  "bl", color, alpha);
  }
  ctx.restore();
}

// ─────────────────────────────────────────────
// 角点命中（仅 tl / tr / bl；br 留给原生）
// ─────────────────────────────────────────────
function hitGroupCorner(g, gx, gy) {
  const [x, y] = g.pos;
  const [W, H] = g.size;
  const right = x + W, bottom = y + H;
  const s = resizeLength();
  const dx = gx - x, dy = gy - y;          // 距左边 / 上边
  const dxR = right - gx, dyB = bottom - gy; // 距右边 / 下边
  if (dx >= 0 && dy >= 0 && dx + dy < s)   return "tl";
  if (dxR >= 0 && dy >= 0 && dxR + dy < s)  return "tr";
  if (dx >= 0 && dyB >= 0 && dx + dyB < s)  return "bl";
  return null;
}

// ─────────────────────────────────────────────
// 四角缩放（自管拖拽，只改 pos/size，内部节点不动）
// ─────────────────────────────────────────────
let _activeResize = null;

// 计算四角缩放后的矩形。gridSize>0 表示需要吸附到网格。
// 关键：与原生右下角 resize 一致 —— 锚点角（拖拽时不动的那个角）始终保持原值，
// 只把「正在拖动的角」吸附到网格，再由锚点反算宽高。这样：
//   - 锚点绝不漂移（原生行为）；
//   - 拖动角落在网格上（开启「对齐网格」时）；
//   - 不缩放时（gridSize=0）等价于纯拖拽，仅做最小尺寸保底。
function _applyCorner(corner, sp, ss, dx, dy, gridSize) {
  // 拖动角跟随鼠标移动；锚点角（相对角）保持不动（与原生 resize 一致）。
  // 关键修复：旧写法用「锚点角 - 锁定边」反算宽高，导致右上角宽度、左下角高度丢失 dx/dy 分量
  // （表现为右上角只能上下缩放、左下角只能左右缩放）。现改为由「锚点角 + 拖动角」两点直接定矩形，
  // 宽高自然包含完整的位移分量。
  let ax, ay;       // 锚点角坐标（固定不动）
  let dxc, dyc;     // 拖动角坐标（= 起点对应角 + 鼠标位移）
  if (corner === "tl") {
    dxc = sp[0] + dx;            dyc = sp[1] + dy;
    ax = sp[0] + ss[0];          ay = sp[1] + ss[1];
  } else if (corner === "tr") {
    dxc = sp[0] + ss[0] + dx;    dyc = sp[1] + dy;
    ax = sp[0];                  ay = sp[1] + ss[1];
  } else { // bl
    dxc = sp[0] + dx;            dyc = sp[1] + ss[1] + dy;
    ax = sp[0] + ss[0];          ay = sp[1];
  }

  // 对齐网格：只吸附被拖动的角（锚点角不动，与四角缩放 / 原生 resize 的 snapToGrid 一致）
  if (gridSize > 0) {
    const snap = (v) => Math.round(v / gridSize) * gridSize;
    dxc = snap(dxc); dyc = snap(dyc);
  }

  // 由锚点角 + 拖动角两点确定矩形（任一角均可能为最终左上 / 右下）
  let x = Math.min(ax, dxc), y = Math.min(ay, dyc);
  let right = Math.max(ax, dxc), bottom = Math.max(ay, dyc);
  let w = right - x, h = bottom - y;

  // 最小尺寸保底：只推「被拖动的那条边」，锚点角仍不动
  if (w < GROUP_MIN_W) { if (dxc >= ax) right = ax + GROUP_MIN_W; else x = ax - GROUP_MIN_W; w = right - x; }
  if (h < GROUP_MIN_H) { if (dyc >= ay) bottom = ay + GROUP_MIN_H; else y = ay - GROUP_MIN_H; h = bottom - y; }

  return { pos: [x, y], size: [w, h] };
}

function _setDragCursor(corner) {
  const cv = app.canvas?.canvas;
  if (cv) cv.style.cursor = cornerCursor(corner);
}
function _clearDragCursor() {
  const cv = app.canvas?.canvas;
  if (cv) cv.style.cursor = "";
}

// ─────────────────────────────────────────────
// 对齐网格（参考原生 LGraphCanvas 的 snapToGrid / grid_size）
//   - 原生 resize 时若 canvas.snapToGrid 为真，会把正在拖动的边吸附到 grid_size 网格；
//     锚点角（右下角原生缩放时为左上角）始终不动。
//   - ComfyUI 的「对齐网格」设置会同步到 canvas.snapToGrid，网格尺寸在 canvas.grid_size；
//     这里两者都取，并回退读 ComfyUI 设置项，保证在任意版本都能正确生效。
// ─────────────────────────────────────────────
function isSnapToGrid() {
  const cv = app.canvas;
  if (cv && typeof cv.snapToGrid === "boolean") return cv.snapToGrid;
  const s = readSetting("Comfy.SnapToGrid");
  return !!s;
}

function getGridSize() {
  const cv = app.canvas;
  if (cv && cv.grid_size) return cv.grid_size;
  const s = readSetting("Comfy.Graph.GridSize");
  return (typeof s === "number" && s > 0) ? s : 10;
}

function _onResizeMove(e) {
  if (!_activeResize || e.pointerId !== _activeResize.pointerId) return;
  const pos = eventToGraph(app.canvas, e);
  if (!pos) return;
  const g = _activeResize.group;
  const dx = pos[0] - _activeResize.startGraph[0];
  const dy = pos[1] - _activeResize.startGraph[1];
  // 跟随全局「对齐网格」：开启时把正在拖动的角吸附到网格（锚点角不动），逻辑同原生右下角 resize
  const r = _applyCorner(_activeResize.corner, _activeResize.startPos, _activeResize.startSize, dx, dy, _activeResize.snapGrid);
  // 只修改边框位置/尺寸，内部子节点（绝对坐标）不受影响
  g.pos = r.pos;
  g.size = r.size;
  // 强制实时重绘（等价于原生拖拽的逐帧预览）
  const cv = app.canvas;
  if (cv) { cv.dirty_canvas = true; cv.dirty_bgcanvas = true; }
}

function _onResizeUp(e) {
  if (!_activeResize || e.pointerId !== _activeResize.pointerId) return;
  try { _activeResize.group.recomputeInsideNodes?.(); } catch (_) {}
  const cv = app.canvas;
  if (cv) { cv.dirty_canvas = true; cv.dirty_bgcanvas = true; }
  _activeResize = null;
  _clearDragCursor();
  window.removeEventListener("pointermove", _onResizeMove, true);
  window.removeEventListener("pointerup", _onResizeUp, true);
}

function startGroupEnhResize(group, corner, e, startGraph) {
  if (_activeResize) return;
  // 拖拽开始时一次性读取「对齐网格」状态（与原生 resize 一致，避免逐帧重复读设置）
  const snapGrid = isSnapToGrid() ? getGridSize() : 0;
  _activeResize = {
    group,
    corner,
    pointerId: e.pointerId,
    startGraph: [...startGraph],
    startPos: [group.pos[0], group.pos[1]],
    startSize: [group.size[0], group.size[1]],
    snapGrid,
  };
  _setDragCursor(corner);
  window.addEventListener("pointermove", _onResizeMove, true);
  window.addEventListener("pointerup", _onResizeUp, true);
}

// ─────────────────────────────────────────────
// 鼠标命中（window capture 阶段优先拦截）
// ─────────────────────────────────────────────
function handleGroupEnhMouseDown(canvas, e, pos) {
  if (!isGroupEnhEnabled()) return false;   // 两个开关都关：完全放行给 ComfyUI
  const [gx, gy] = pos;
  const groups = canvas.graph?.groups ?? canvas.graph?._groups ?? [];
  const th = titleHeight();
  const M = Math.max(2, (th - ENH_BTN_H) / 2);

  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    const [x, y] = g.pos;
    const [W, H] = g.size;

    // 标题栏按钮（绕 / 适）—— 仅「编组标题按钮」开启时拦截
    if (titleButtonsOn() && gy >= y && gy <= y + th) {
      const bypassX = x + W - M - ENH_BTN_W;
      const fitX    = bypassX - ENH_GAP - ENH_BTN_W;
      const btnY    = y + M;
      if (gx >= fitX && gx <= fitX + ENH_BTN_W && gy >= btnY && gy <= btnY + ENH_BTN_H) {
        fitGroupToNodes(g); canvas.setDirtyCanvas?.(true, true); return true;
      }
      if (gx >= bypassX && gx <= bypassX + ENH_BTN_W && gy >= btnY && gy <= btnY + ENH_BTN_H) {
        toggleBypassGroup(g); canvas.setDirtyCanvas?.(true, true); return true;
      }
    }

    // 四角缩放（br 留给原生；pinned 编组不可缩放）—— 仅「四角缩放」开启时拦截
    if (cornerResizeOn() && !g.pinned) {
      const corner = hitGroupCorner(g, gx, gy);
      if (corner) {
        startGroupEnhResize(g, corner, e, pos);
        return true;
      }
    }
  }
  return false;
}

// 取得 graph 坐标（优先原生 convertEventToCanvasOffset，回退手动变换）
function eventToGraph(canvas, e) {
  if (!canvas) return null;
  if (typeof canvas.convertEventToCanvasOffset === "function") {
    try { return canvas.convertEventToCanvasOffset(e); } catch (_) {}
  }
  if (typeof canvas.convertEventToCanvas === "function") {
    try { return canvas.convertEventToCanvas(e); } catch (_) {}
  }
  const ds = canvas.ds;
  const cv = canvas.canvas;
  const rect = cv?.getBoundingClientRect?.();
  if (ds && rect) {
    return [
      (e.clientX - rect.left) / ds.scale - ds.offset[0],
      (e.clientY - rect.top) / ds.scale - ds.offset[1],
    ];
  }
  return null;
}

// 悬停角点时给出缩放光标（让用户"知道在哪里可以缩放"）
let _hoverCorner = null;
function handleGroupEnhHover(canvas, e) {
  if (!cornerResizeOn()) { if (_hoverCorner) { _clearDragCursor(); _hoverCorner = null; } return; }
  if (e.target !== canvas?.canvas) return;
  const pos = eventToGraph(canvas, e);
  if (!pos) return;
  const [gx, gy] = pos;
  const groups = canvas.graph?.groups ?? canvas.graph?._groups ?? [];
  let found = null;
  for (let i = groups.length - 1; i >= 0 && !found; i--) {
    const g = groups[i];
    if (g.pinned) continue;
    found = hitGroupCorner(g, gx, gy);
  }
  if (found) {
    if (found !== _hoverCorner) { _setDragCursor(found); _hoverCorner = found; }
  } else if (_hoverCorner) {
    _clearDragCursor(); _hoverCorner = null;
  }
}

function attachEnhListeners(canvas) {
  if (!canvas?.canvas || canvas._josiaEnhInstalled) return;
  canvas._josiaEnhInstalled = true;

  // 优先于 ComfyUI 原生 canvas 监听：window capture 阶段
  window.addEventListener("pointerdown", (e) => {
    if (!app.canvas?.graph) return;
    const pos = eventToGraph(app.canvas, e);
    if (pos && handleGroupEnhMouseDown(app.canvas, e, pos)) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  // 悬停光标
  window.addEventListener("pointermove", (e) => {
    if (app.canvas) handleGroupEnhHover(app.canvas, e);
  }, true);
}

// ─────────────────────────────────────────────
// 修补（一次）
// ─────────────────────────────────────────────
function applyGroupEnhancements() {
  const canvas = app.canvas;
  if (!canvas) return false;
  const LGraphGroup = getGroupClass();
  if (!LGraphGroup) return false;
  if (LGraphGroup.prototype._josiaGroupEnh) { attachEnhListeners(canvas); return true; }
  LGraphGroup.prototype._josiaGroupEnh = true;

  const origDraw = LGraphGroup.prototype.draw;
  LGraphGroup.prototype.draw = function (graphCanvas, ctx) {
    try { origDraw.apply(this, arguments); } catch (_) {}
    try { drawGroupEnhUI(this, graphCanvas, ctx); } catch (err) {
      console.warn("[JosiaGroupEnh] draw error", err);
    }
  };

  attachEnhListeners(canvas);
  return true;
}

app.registerExtension({
  name: "JosiaGroupEnhancements",
  settings: [
    // ── 编组增强区域（四角缩放 + 标题栏按钮 同处一区）──
    // ⚠️ category 末级 key 必须每个设置唯一：前端 buildTree()（treeUtil.ts）以 category
    //    数组为「树路径」，同一路径的多个设置会塌进同一个节点并被 `parent.data = item`
    //    覆盖 ⇒ 只剩最后一个，前面的设置直接从设置面板消失（四角缩放曾因此丢失）。
    //    末级 key 只作树键、不会显示在 UI 上（面板按 flattenTree 收叶子、以 setting.name 显示），
    //    中间层「编组增强」才是分组标题。官方核心设置同样用末段唯一写法。
    {
      id: "JosiaNodes.CornerResize",
      name: "编组四角缩放",
      type: "boolean",
      defaultValue: false,
      category: ["⚡️JosiaNodes", "编组增强", "CornerResize"],
      onChange: (v) => setCornerResize(v),
    },
    {
      id: "JosiaNodes.GroupTitleButtons",
      name: "编组标题按钮",
      type: "boolean",
      defaultValue: false,
      category: ["⚡️JosiaNodes", "编组增强", "GroupTitleButtons"],
      onChange: (v) => setTitleButtons(v),
    },
  ],
  init() {
    const c = readSetting("JosiaNodes.CornerResize");
    if (c !== undefined) setCornerResize(c);
    const t = readSetting("JosiaNodes.GroupTitleButtons");
    if (t !== undefined) setTitleButtons(t);
    applyGroupEnhancements();
  },
  // 兜底：部分版本 init 时 canvas 尚未就绪
  async beforeRegisterNodeDef() {
    applyGroupEnhancements();
  },
});
