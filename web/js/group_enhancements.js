/**
 * Josia Group Enhancements — 编组增强补丁（旧版画布模式）
 *
 * 功能（两个独立开关，均默认关闭）：
 *   1) 四角缩放（JosiaNodes.CornerResize）：
 *      原生只有右下角可缩放，本补丁补上 左上 / 右上 / 左下 三个角；
 *      内部节点绝不跟随移动（只改 group.pos / group.size，等价于原生 resize 语义）。
 *      跟随全局「对齐网格」设置：开启时拖拽实时对齐到网格，逻辑同原生右下角 resize。
 *   2) 编组标题栏按钮（JosiaNodes.GroupTitleButtons）：
 *        • 「绕」— 一键绕过 / 恢复（切换）编组内所有节点（Bypass）
 *        • 「适」— 缩放框到节点（调用原生 group.resizeTo，复用官方"适配内容"逻辑）
 *
 * 设置面板分类：⚡ Josia节点设置（亮色闪电 Emoji + 中文名，独立成项，不归入「其他」；两个开关各自独立子分类，避免同分类合并）。
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

// ─────────────────────────────────────────────
// 设置开关（ComfyUI 设置面板：⚡ Josia节点设置，两个独立开关、各自独立子分类，默认关闭）
// ─────────────────────────────────────────────
let _cornerResizeEnabled = false;   // 四角缩放（左上/右上/左下）
let _titleButtonsEnabled = false;   // 编组标题栏按钮（绕/适）

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
function getLG() { return window.LiteGraph; }

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

// 复用官方"缩放框到节点"逻辑：原生 group.resizeTo(children, padding)
// - 默认 padding = 10（与原生 LGraphGroup.resizeTo 默认一致，距离才会相同）
// - 若全局开启"对齐网格"，原生会 expandRectToGrid，与后续拖拽网格行为一致，避免错位
function fitGroupToNodes(g) {
  try { g.recomputeInsideNodes?.(); } catch (_) {}
  const children = (g._children instanceof Set && g._children.size)
    ? g._children
    : (g.nodes ?? g._nodes ?? []);
  if (!children || (children.size ?? children.length) === 0) return;
  try { g.resizeTo?.(children, 10); } catch (_) {}   // 原生默认 padding=10
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
  // 标题栏按钮（垂直居中、右边距 = 上下边距 M）—— 仅「编组标题栏按钮」开启时
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

function _applyCorner(corner, sp, ss, dx, dy) {
  let x = sp[0], y = sp[1], w = ss[0], h = ss[1];
  if (corner === "tl")      { x = sp[0] + dx; y = sp[1] + dy; w = ss[0] - dx; h = ss[1] - dy; }
  else if (corner === "tr") { y = sp[1] + dy;                w = ss[0] + dx; h = ss[1] - dy; }
  else if (corner === "bl") { x = sp[0] + dx;                w = ss[0] - dx; h = ss[1] + dy; }
  if (w < 80) { if (corner === "tl" || corner === "bl") x = sp[0] + (ss[0] - 80); w = 80; }
  if (h < 80) { if (corner === "tl" || corner === "tr") y = sp[1] + (ss[1] - 80); h = 80; }
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

// 网格尺寸：与原生 resize 保持一致，优先取 canvas.grid_size，回退 10
function getGridSize() {
  const cv = app.canvas;
  return (cv && cv.grid_size) || 10;
}

// 跟随全局「对齐网格」：开启时把 pos / size 对齐到网格（逻辑同原生右下角 resize）
function snapToGridIfNeeded(pos, size) {
  const cv = app.canvas;
  if (!cv || !cv.snapToGrid) return { pos, size };
  const g = getGridSize();
  const snap = (v) => Math.round(v / g) * g;
  return {
    pos: [snap(pos[0]), snap(pos[1])],
    size: [snap(size[0]), snap(size[1])],
  };
}

function _onResizeMove(e) {
  if (!_activeResize || e.pointerId !== _activeResize.pointerId) return;
  const pos = eventToGraph(app.canvas, e);
  if (!pos) return;
  const g = _activeResize.group;
  const dx = pos[0] - _activeResize.startGraph[0];
  const dy = pos[1] - _activeResize.startGraph[1];
  const r = _applyCorner(_activeResize.corner, _activeResize.startPos, _activeResize.startSize, dx, dy);
  // 跟随全局对齐网格（开启时 pos/size 均吸附到网格，等价于原生右下角 resize 行为）
  const snapped = snapToGridIfNeeded(r.pos, r.size);
  // 只修改边框位置/尺寸，内部子节点（绝对坐标）不受影响
  g.pos = snapped.pos;
  g.size = snapped.size;
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
  _activeResize = {
    group,
    corner,
    pointerId: e.pointerId,
    startGraph: [...startGraph],
    startPos: [group.pos[0], group.pos[1]],
    startSize: [group.size[0], group.size[1]],
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

    // 标题栏按钮（绕 / 适）—— 仅「编组标题栏按钮」开启时拦截
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
    {
      id: "JosiaNodes.CornerResize",
      name: "四角缩放（左上 / 右上 / 左下）",
      type: "boolean",
      defaultValue: false,
      category: ["⚡ Josia节点设置", "四角缩放"],
      onChange: (v) => setCornerResize(v),
    },
    {
      id: "JosiaNodes.GroupTitleButtons",
      name: "编组标题栏按钮（绕 / 适）",
      type: "boolean",
      defaultValue: false,
      category: ["⚡ Josia节点设置", "标题栏按钮"],
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
