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
function recomputeGroupNodes(group) {
  const graph = group.graph ?? app.graph;
  if (!graph) return;
  const grpBounds = group._bounding;
  if (!grpBounds) return;
  const [gx, gy, gw, gh] = grpBounds;
  const allNodes = graph.nodes ?? graph._nodes ?? [];

  if (group._children instanceof Set) {
    group._children.clear();
    if (!Array.isArray(group.nodes)) group.nodes = [];
    group.nodes.length = 0;
    for (const node of allNodes) {
      let bounds;
      try { bounds = node.getBounding?.(); } catch (_) { continue; }
      if (!bounds) continue;
      const cx = bounds[0] + bounds[2] * 0.5;
      const cy = bounds[1] + bounds[3] * 0.5;
      if (cx >= gx && cx < gx + gw && cy >= gy && cy < gy + gh) {
        group._children.add(node);
        group.nodes.push(node);
      }
    }
    return;
  }
  try { group.recomputeInsideNodes?.(); } catch (_) {}
}

/**
 * 获取编组内的节点列表（兼容不同ComfyUI版本）
 * @param {object} group - 编组实例
 * @returns {Array} 节点列表
 */
function getGroupNodes(group) {
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
  node._lastRecomputeMs = 0;             // 最后一次重新计算时间
  node.serialize_widgets = false;        // 不序列化widgets
  node.isVirtualNode    = true;          // 标记为虚拟节点
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
  // 动态调整节点高度
  if (Math.abs(node.size[1] - neededH) > 1) node.size[1] = neededH;

  node._hitRows       = [];
  node._hitHeaderBtns = [];

  let y = PAD_Y;

  // 绘制全局按钮（全部跳过/全部启用）
  const halfW = (W - PAD_X * 2 - 6) / 2;
  _drawHeaderBtn(node, ctx, PAD_X,             y, halfW, HEADER_H - 6, "全部跳过", "#7a1515", "bypass_all");
  _drawHeaderBtn(node, ctx, PAD_X + halfW + 6, y, halfW, HEADER_H - 6, "全部启用", "#155c30", "enable_all");
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
      setGroupBypass(row.group, !row.bypassed);
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
  },

  /**
   * 工作流加载后刷新节点尺寸
   * @param {object} node - 加载的节点实例
   */
  loadedGraphNode(node) {
    const isM = node.type === NODE_TYPE_M || node.comfyClass === NODE_NAME_M;
    const isS = node.type === NODE_TYPE_S || node.comfyClass === NODE_NAME_S;
    if (!isM && !isS) return;

    requestAnimationFrame(() => {
      if (isM) {
        ensureStateM(node);
        node.size[1] = computeHeightM(getAllGroups().length);
      } else {
        ensureStateS(node);
        node.size[1] = SINGLE_H;
      }
      app.graph?.setDirtyCanvas?.(true, false);
    });
  },
});
