/*
 * Josia 图像编码 前端联动（原生控件，无自定义样式）
 * 做三件事：
 *  1) 按「缩放类型」变形唯一缩放参数行：关 → 整行隐藏；其它类型只显示对应的那一个
 *     （缩放系数 / 长边尺寸 / 短边尺寸 / 百万像素），对齐倍数仅在「关」时灰化。
 *  2) VAE 自动联动：图内有「Josia模型加载」节点时自动切到「使用Josia模型加载VAE」；
 *     无该节点时移除该项并把已选中的降级回占位符；VAE 端口接线时灰化下拉（接线优先）。
 *  3) 上传联动：「图像」端口接线时灰化「选择图像」下拉（端口优先）。
 *     上传按钮 + 图片预览由前端 image_upload 原生机制提供，这里不做任何自定义样式。
 *
 * 🔴 铁律：
 *   · 下拉 callback 触发时 this 指向「控件」而非节点 ⇒ applyScaleVisibility 内部统一归一到节点。
 *   · 显隐控件后只重算「高度」、严禁用 computeSize 改「宽度」，否则会把设定的默认宽度改回去。
 *   · 只设「默认宽度」NODE_W，不覆写最小尺寸限制 ⇒ 用户可自由改窄（便于工作流整洁）；
 *     用户保存的尺寸由 onConfigure 恢复，会自然覆盖默认宽度。
 */
import { app } from "../../scripts/app.js";

const SCALE_WIDGETS = ["缩放系数", "长边尺寸", "短边尺寸", "百万像素"];

// 每种缩放类型下「需要显示」的那个唯一参数（其余隐藏；「关」特殊：整行隐藏）
const SCALE_VISIBLE = {
  "关": [],
  "按系数缩放": ["缩放系数"],
  "按长边缩放": ["长边尺寸"],
  "按短边缩放": ["短边尺寸"],
  "按像素缩放": ["百万像素"],
};

const USE_JOSIA_VAE = "使用Josia模型加载VAE";
const VAE_PLACEHOLDER = "请选择VAE模型";   // 无 Josia模型加载 节点时的默认占位符
const JOSIA_LOADER_TYPES = ["JosiaCheckpointPlus", "JosiaModelLoader"];

// ── 图节点增删监听所需的运行状态 ──
// 删除「Josia模型加载」节点不会触发本节点的 onConnectionsChange，只能靠 graph 级钩子；
// 少了它，下拉里那一项会一直留着（＝哥哥说的「常驻」）。与 Josia媒体保存 同一范式。
const LIVE_NODES = new Set();          // 已创建的本节点实例
let _graphHooksInstalled = false;

// 默认宽度（自然宽 ~300px，取 400 便于容纳中文长标签）；不设最小限制，用户可改窄
const NODE_W = 400;

/* 🔴 不要再加「底部分辨率行」这类 addDOMWidget（10-04 教训，代价很大）：
 *   它是 DOM widget 却没有 computeSize ⇒ litegraph 判定它「可增长」，把节点的**剩余空间
 *   全部**分配给它（实测 computedHeight=666，而节点总高才 900）⇒ 官方 image upload 预览
 *   区被挤成一条缝，图片看起来又小又「不成比例」，整个节点排版也不对。
 *   预览图与「原尺寸 × 宽 × 高」文字都归官方 renderer 画，本节点一律不碰。 */

function getWidget(node, name) {
  return node.widgets ? node.widgets.find((w) => w.name === name) : null;
}

/* ── 上传按钮那一行右侧显示「输出分辨率」──────────────────────────────────
 * 官方在图片**下方**画「原宽 × 原高」。想改写它做不到：官方预览是在 onDrawForeground
 * **之后**绘制的（实测 fillText 顺序：自定义的在它前面 ⇒ 被盖；onDrawOverlay 影子绘制
 * 不落帧缓冲），所以只在图片上方另起一行、互不重叠。
 * 🔴 落点选在「上传按钮」那一行（预览区**上方**）的右侧 —— 那是 widget 绘制阶段画的，
 *    借 upload 按钮自己的 drawWidget 绘制链补在按钮行右侧，见 patchUploadDraw。
 *
 * 缩放公式严格复刻后端 image_encode._compute_target / _align_to_multiple，
 * 含 Python round 的「五取偶」（与 JS Math.round 的「五入」不同，不复刻会在 .5 边界对不上）。 */

function pyRound(v) {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return (f % 2 === 0) ? f : f + 1;                // Python：.5 取偶
}

function computeOutSize(ow, oh, type, factor, longest, shortest, mp) {
  if (type === "按系数缩放") {
    return [Math.max(1, pyRound(ow * factor)), Math.max(1, pyRound(oh * factor))];
  }
  if (type === "按长边缩放") {
    if (ow <= 0 || oh <= 0) return [longest, longest];
    const s = longest / Math.max(ow, oh);
    return [Math.max(1, pyRound(ow * s)), Math.max(1, pyRound(oh * s))];
  }
  if (type === "按短边缩放") {
    if (ow <= 0 || oh <= 0) return [shortest, shortest];
    const s = shortest / Math.min(ow, oh);
    return [Math.max(1, pyRound(ow * s)), Math.max(1, pyRound(oh * s))];
  }
  if (type === "按像素缩放") {
    const total = mp * 1000000;
    const aspect = (oh > 0 && ow > 0) ? (ow / oh) : 1.0;
    const tw = Math.sqrt(total * aspect);
    return [Math.max(1, pyRound(tw)), Math.max(1, pyRound(tw / aspect))];
  }
  return [ow, oh];                                   // 关
}

function alignToMultiple(w, h, m) {
  m = Math.trunc(Number(m) || 0);
  if (m <= 1) return [w, h];
  const wOk = w % m === 0;
  const hOk = h % m === 0;
  if (wOk && hOk) return [w, h];
  if (wOk) return [w, Math.max(m, Math.floor(h / m) * m)];
  if (hOk) return [Math.max(m, Math.floor(w / m) * m), h];
  const shortSide = w <= h ? w : h;
  const longSide = w <= h ? h : w;
  const newShort = Math.floor(shortSide / m) * m;
  if (newShort < m) return [w, h];
  const scale = newShort / shortSide;
  const newLong = Math.max(m, Math.floor(Math.trunc(longSide * scale) / m) * m);
  return w <= h ? [newShort, newLong] : [newLong, newShort];
}

/** 按当前缩放设置算输出尺寸（与后端同口径） */
function outputSizeOf(node, ow, oh) {
  const st = getWidget(node, "缩放类型");
  const type = st ? String(st.value) : "关";
  if (type === "关") return [ow, oh];
  const numOf = (name, dflt) => {
    const w = getWidget(node, name);
    const v = parseFloat(w && w.value);
    return isFinite(v) ? v : dflt;
  };
  const t = computeOutSize(
    ow, oh, type,
    numOf("缩放系数", 1), numOf("长边尺寸", 1024),
    numOf("短边尺寸", 1024), numOf("百万像素", 1)
  );
  const av = getWidget(node, "对齐倍数");
  const raw = av ? av.value : 1;
  const m = (raw == null || raw === "关") ? 1 : (parseInt(raw, 10) || 1);
  const a = alignToMultiple(t[0], t[1], m);
  return [Math.max(32, a[0]), Math.max(32, a[1])];
}

/**
 * 在上传按钮那一行的**右侧**写「输出 W × H」（短文案，避免挤占节点宽度）。
 * 三重保护，缺一个就会出现哥哥截图里的问题：
 *   ① 右端对齐到「节点宽 − 10」⇒ 不会超出容器；
 *   ② 高度避让：画在按钮下沿，不与「选择上传的文件」同一基线；
 *   ③ 宽度避让：量出文字宽度后，若左侧留给按钮文字的空间不够就**整条不画**
 *      （宁可不显示，也绝不与按钮文字重叠）。
 */
function drawOutResText(ctx, widget, node) {
  const idx = node.imageIndex == null ? 0 : node.imageIndex;
  const img = node.imgs && node.imgs[idx];
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  const [fw, fh] = outputSizeOf(node, img.naturalWidth, img.naturalHeight);

  const nodeW = node.size[0] || 0;
  const y = (widget ? widget.y : 0) + (widget && widget.height ? widget.height : 20) * 0.72;
  const rightX = nodeW - 10;
  const text = `输出 ${fw} × ${fh}`;
  ctx.save();
  ctx.font = "10px sans-serif";
  const tw = ctx.measureText(text).width;
  // 按钮自带文字「选择上传的文件」居中（实测半宽约 42px），左边必须留够，否则重叠
  if (rightX - tw < nodeW / 2 + 46) { ctx.restore(); return; }
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.fillText(text, rightX, y);
  ctx.restore();
}

/**
 * 包装 upload 按钮的 drawWidget，在它画完之后补这行字。
 * 🔴 只能借 widget 自己的绘制链：官方预览图是在更晚的阶段绘制的，
 *    onDrawForeground / onDrawOverlay 的自定义绘制都会被它盖掉（10-04 实测）。
 * 🔴 必须先抓局部引用再包装（`.bind(` 会命中注册表 yara 扫描规则，箭头代理会自递归）。
 */
function patchUploadDraw(node) {
  const up = getWidget(node, "upload");
  if (!up || up.__josiaPatched) return;
  up.__josiaPatched = true;
  const orig = up.drawWidget;
  const owner = up._node || node;
  up.drawWidget = function (ctx, opts) {
    const r = orig ? orig.call(this, ctx, opts) : undefined;
    try { drawOutResText(ctx, this, owner); } catch (e) { /* 忽略 */ }
    return r;
  };
}

// 把「可能是控件、也可能是节点」的入参归一到节点对象
function asNode(widgetOrNode) {
  if (!widgetOrNode) return null;
  if (widgetOrNode.widgets) return widgetOrNode;       // 已经是节点
  if (widgetOrNode.node) return widgetOrNode.node;     // 是控件 ⇒ 取宿主节点
  return widgetOrNode;
}

// 图里有没有「Josia模型加载」节点（comfyClass 是 JosiaCheckpointPlus）
function graphHasJosiaLoader() {
  try {
    const g = app.graph;
    const list = (g && (g._nodes || g.nodes)) || [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i] && (list[i].comfyClass || list[i].type);
      if (t && JOSIA_LOADER_TYPES.indexOf(String(t)) >= 0) return true;
    }
  } catch (e) { /* 忽略 */ }
  return false;
}

// 🔴「通道切换」悬停说明：与后端 image_encode.py 的 CHANNEL_TOOLTIP 同源。
//    后端走 INPUT_TYPES 的 tooltip，这里再挂一层到控件上 —— 鼠标指向下拉时必定能看到各通道的含义。
//    ⚠️ 改文案必须两边一起改（漏一边＝悬停提示与实际行为对不上）。
const CHANNEL_TOOLTIP =
  "决定「图像」端口输出几通道（本节点恒定另出一路「遮罩」单通道，也就是 3+1 里的那 +1）：\n" +
  "• 自动 ＝ 上游给几通道就透传几通道：三通道进 ⇒ 三通道出，四通道进 ⇒ 四通道出。最省心。\n" +
  "• RGB ＝ 强制三通道（RGB）。第四通道（透明度）不跟图像走，改成从「遮罩」端口出来，" +
  "遮罩越亮＝越透明（与原生加载图像一致的口径）。\n" +
  "• RGBA ＝ 强制四通道（RGB + A）：第四通道按下面顺序取透明度 —— " +
  "①「遮罩」端口接线了就用它合并（alpha ＝ 1 − 遮罩，遮罩亮＝透明，" +
  "等于把原生「合并图像Alpha」内置进来）；② 没接线就用上传图自带的透明度；" +
  "③ 都没有或上游是三通道就补成全不透明。「遮罩」输出端口照旧会给出一路（遮罩亮＝越透明）。\n" +
  "说明：上游是灰度等其它通道数时一律按三通道处理；三种模式下喂给 VAE 编码的都只有前三通道。\n" +
  "透明度说明：完全透明的像素在预览里一律按白色呈现（预览只画 RGB，PNG 里透明区的 RGB 常是 0，" +
  "直接透出去会被渲染成黑块）；半透明像素的颜色照旧，真正的透明信息在第四通道或「遮罩」端口。";

// 按缩放类型显隐 / 灰化子控件（原生 .hidden 与 .disabled，无自定义样式）
// 「关」＝ 完全不缩放不对齐 ⇒ 唯一缩放参数行整行隐藏，仅对齐倍数灰化
function applyScaleVisibility(widgetOrNode, scaleType) {
  const node = asNode(widgetOrNode);
  if (!node || !node.widgets) return;
  const off = scaleType === "关";
  const visible = SCALE_VISIBLE[scaleType] || [];
  for (const name of SCALE_WIDGETS) {
    const w = getWidget(node, name);
    if (!w) continue;
    // 非「关」时：只显示该类型对应的那一个参数，其余隐藏；「关」时整行隐藏
    w.hidden = !(visible.indexOf(name) >= 0);
    w.disabled = false;
  }
  const align = getWidget(node, "对齐倍数");
  if (align) align.disabled = off;
  // 🔴 只在「内容比现在高」时撑开高度，**绝不缩小**：
  //    无条件 setSize(computeSize) 等于每次改参数都把节点高度重置成最小高度，
  //    用户拉大的高度被吃掉（实测 900 → 470）⇒ 预览区跟着变窄，
  //    表现为「图像不跟随节点尺寸放大、而且一改参数就缩回去」。
  //    宽度同理不碰（避免把设定的默认宽度改回去）。
  try {
    const sz = node.computeSize ? node.computeSize() : [node.size[0], node.size[1]];
    if (sz && sz[1] > node.size[1]) node.setSize([node.size[0], sz[1]]);
  } catch (e) { /* 忽略 */ }
}

// 统一设值：优先 setValue（触发重绘），失败兜底直接赋值 —— 与 Josia媒体保存 同款
function setWidgetValue(node, w, v) {
  if (!w) return;
  try {
    if (typeof w.setValue === "function") w.setValue(v);
    else w.value = v;
  } catch (e) { w.value = v; }
  try { app.graph?.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
}

// VAE 联动（口径与 Josia媒体保存 完全一致）：
//   图内有「Josia模型加载」节点 ⇒ 下拉里**加入**「使用Josia模型加载VAE」（需用户手动选，不自动选中）；
//   该节点被删除             ⇒ 下拉里**移掉**该项，并把选中它的实例回落到「请选择VAE模型」。
//   🔴 只有用户自己选了「使用Josia模型加载VAE」才绑定模型加载节点；选真实 VAE / 默认占位符都不碰。
// 🔴 这里动的是**展示层**（options.values）：后端 INPUT_TYPES 里该项必须常驻，
//    否则 execution.validate_inputs 会拿提交值与后端候选比对 ⇒ value_not_in_list，节点跑不起来。
function syncJosiaVae(node) {
  const w = getWidget(node, "VAE模型");
  if (!w) return;
  const present = graphHasJosiaLoader();
  const cur = String(w.value ?? "");

  // 1) 展示层增删「使用Josia模型加载VAE」这一项（真正的「不常驻」）
  const opts = (w.options && w.options.values) ? w.options.values.slice() : [];
  if (present) {
    if (opts.indexOf(USE_JOSIA_VAE) < 0) {
      const at = opts.indexOf(VAE_PLACEHOLDER);   // 紧跟占位符，与后端候选顺序一致
      if (at >= 0) opts.splice(at + 1, 0, USE_JOSIA_VAE);
      else opts.unshift(USE_JOSIA_VAE);
      w.options.values = opts;
    }
  } else if (opts.indexOf(USE_JOSIA_VAE) >= 0) {
    w.options.values = opts.filter((o) => o !== USE_JOSIA_VAE);
  }

  // 2) VAE 端口接线 ⇒ 灰化（接线优先）；未接线 ⇒ 恢复可用
  const wired = isPortWired(node, "vae");
  w.disabled = wired;

  // 3) 回落：仅当模型加载节点被移除、且当前选中的是联动项时，回落占位符。
  //    🔴🔴 2026-10-07 修（哥哥反馈）：**绝不自动切换**到联动项——是否使用「Josia模型加载」
  //        联动完全由用户手动决定；选了真实 VAE 或停在默认占位符都不要碰模型加载节点。
  if (!present && cur === USE_JOSIA_VAE) {
    setWidgetValue(node, w, VAE_PLACEHOLDER);
  }
}

// 图内增删节点 ⇒ 统一刷新所有本节点实例的 VAE 联动
function installGraphHooks(node) {
  if (node) LIVE_NODES.add(node);
  if (_graphHooksInstalled) return;
  try {
    const g = app.graph;
    if (!g) return;
    const fire = () => {
      // 等 LiteGraph 真正完成增删后再判定，否则可能读到旧的节点表
      const run = () => { LIVE_NODES.forEach((n) => { try { syncJosiaVae(n); } catch (e) {} }); };
      try { requestAnimationFrame(run); } catch (e) { setTimeout(run, 0); }
    };
    const _ga = g.onNodeAdded;
    g.onNodeAdded = function () { try { _ga?.apply(this, arguments); } catch (e) {} fire(); };
    const _gr = g.onNodeRemoved;
    g.onNodeRemoved = function () { try { _gr?.apply(this, arguments); } catch (e) {} fire(); };
    _graphHooksInstalled = true;
  } catch (e) { /* 旧前端无此钩子时忽略 */ }
}

function isPortWired(node, portName) {
  const port = node.inputs ? node.inputs.find((i) => i.name === portName) : null;
  return !!(port && port.link != null);
}

// 「图像」端口接线 ⇒ 灰化「选择图像」下拉（端口优先）
function syncUploadCombo(node) {
  const up = getWidget(node, "image");
  if (!up) return;
  up.disabled = isPortWired(node, "image_in");
}

// 把控件键名 image 显示成中文「选择图像」（官方遮罩编辑器要求控件键名必须是 image，
// 但用户看到的不必是英文；借 widget.label 覆盖显示，不影响内部键名与遮罩编辑器的读写）。
function ensureComboLabel(node) {
  try {
    const w = getWidget(node, "image");
    if (w && w.label !== "选择图像") w.label = "选择图像";
  } catch (e) { /* 忽略 */ }
}

/* ── 官方遮罩编辑器兼容 ───────────────────────────────────────────────
 * 本节点把上传控件键名直接取为 "image"（见 INPUT_TYPES），与官方「加载图像」一致，
 * 所以官方 readImageWidgetValue / writeImageWidgetValue 能直接读写本控件、
 * WidgetValueStore 跟踪的是真实 live 值 —— 遮罩编辑器开箱即用，无需影子桥。
 * 中文显示名「选择图像」由 ensureComboLabel 借 widget.label 设置。 */

function syncAll(node) {
  const st = getWidget(node, "缩放类型");
  applyScaleVisibility(node, st ? st.value : "按系数缩放");
  syncJosiaVae(node);
  syncUploadCombo(node);
}

app.registerExtension({
  name: "Josia.ImageEncode",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "JosiaImageEncode") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      // 🔴 默认宽度：仅初次创建时给一次（用户手动改窄后，由 onConfigure 恢复的尺寸覆盖本值）
      if (this.size) this.size[0] = Math.max(this.size[0], NODE_W);

      // 通道切换的悬停说明（双保险：后端 INPUT_TYPES 已带 tooltip，这里再补到控件上）
      try {
        const ch = getWidget(this, "通道切换");
        if (ch) ch.tooltip = CHANNEL_TOOLTIP;
      } catch (e) { /* 忽略 */ }

      const st = getWidget(this, "缩放类型");
      if (st) {
        const prev = st.callback;
        // 🔴 callback 触发时 this = 控件本身 ⇒ 传给 applyScaleVisibility 的是控件，
        //    函数内部会归一到宿主节点，这里直接用 this 即可。
        st.callback = function (v) {
          applyScaleVisibility(this, v);
          return prev ? prev.call(this, v) : v;
        };
      }
      syncAll(this);
      // 缩放参数 / 对齐倍数变化 ⇒ 图片上方的「输出分辨率」要实时重算
      for (const nm of ["缩放系数", "长边尺寸", "短边尺寸", "百万像素", "对齐倍数"]) {
        const w = getWidget(this, nm);
        if (!w) continue;
        const prevCb = w.callback;
        w.callback = function (v) {
          const r = prevCb ? prevCb.call(this, v) : v;
          try { app.graph?.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
          return r;
        };
      }
      // 🔴 装上图节点增删钩子（删掉「Josia模型加载」节点时才能实时把该项移出下拉）
      installGraphHooks(this);
      // 借 upload 按钮的绘制链补「输出分辨率」那一行
      try { patchUploadDraw(this); } catch (e) { /* 忽略 */ }
      // 官方遮罩编辑器开箱即用（控件键名已是 image）；补中文显示名
      try { ensureComboLabel(this); } catch (e) { /* 忽略 */ }
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      syncAll(this);
      // 载入工作流后 widget 是重建的，要重新挂一次
      try { patchUploadDraw(this); } catch (e) { /* 忽略 */ }
      try { ensureComboLabel(this); } catch (e) { /* 忽略 */ }
      return r;
    };

    // 连线 / 断线实时刷新灰化状态（VAE 接线灰化 + 上传下拉灰化）
    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConnectionsChange
        ? onConnectionsChange.apply(this, arguments)
        : undefined;
      syncJosiaVae(this);
      syncUploadCombo(this);
      return r;
    };

    // 每次执行后重新判定 Josia 联动（覆盖先建本节点、后建模型加载节点的顺序）
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function () {
      syncJosiaVae(this);
      return onExecuted ? onExecuted.apply(this, arguments) : undefined;
    };

    // 节点被删除 ⇒ 移出刷新集合，避免 LIVE_NODES 无限增长
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      LIVE_NODES.delete(this);
      return onRemoved ? onRemoved.apply(this, arguments) : undefined;
    };

    // 🔴 不覆写 computeSize / onResize ⇒ 不设最小尺寸限制，用户可自由把节点改窄
    //    （默认宽度只在 onNodeCreated 里给一次；用户保存的窄尺寸由 onConfigure 恢复并保留）
    // 🔴 也绝不在这里加 DOM widget：见文件上方「不要再加底部分辨率行」的说明。
  },
});
