/*
 * Josia 图像编码 前端联动（原生控件，无自定义样式）
 * 做三件事：
 *  1) 按「缩放类型」变形唯一缩放参数行：关 → 整行隐藏；其它类型只显示对应的那一个
 *     （缩放系数 / 长边尺寸 / 短边尺寸 / 百万像素），对齐倍数仅在「关」时灰化。
 *  2) VAE 自动联动：图内有「Josia模型加载」节点时自动切到「使用Josia模型加载VAE」；
 *     无该节点时移除该项并把已选中的降级回占位符；VAE 端口接线时灰化下拉（接线优先）。
 *  3) 上传联动：「图像」端口接线时（端口优先）灰化「选择图像」下拉，并把节点里那张
 *     上传预览图压到 PREVIEW_DIM_FACTOR 的透明度 —— 表示「上游已接入，本节点载入的图会被忽略」；
 *     断线自动恢复。
 *     上传按钮 + 图片预览由前端 image_upload 原生机制提供（预览是 node.imgs，
 *     由 litegraph 画在 canvas 上而非 DOM）⇒ 这里只能走 canvas 绘制层，不能用 CSS 不透明度。
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

// 上游接线后，节点里那张「选择图像」预览图的呈现强度（≈30% 不透明度）
// 🔴 预览走 litegraph 的 canvas 绘制（node.imgs），CSS 不透明度对它无效 ⇒ 只能改绘制时的
//    globalAlpha。这里乘在一个"当前值"上，避免把节点已有的透明度冲掉。
const PREVIEW_DIM_FACTOR = 0.3;

function getWidget(node, name) {
  return node.widgets ? node.widgets.find((w) => w.name === name) : null;
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
  // 🔴 仅重算高度，保留宽度（避免把翻倍的默认宽度改回去）
  try {
    const sz = node.computeSize ? node.computeSize() : [node.size[0], node.size[1]];
    node.setSize([node.size[0], sz[1]]);
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

// VAE 自动联动（口径与 Josia媒体保存 完全一致）：
//   图内有「Josia模型加载」节点 ⇒ 下拉里**加入**「使用Josia模型加载VAE」并自动选中；
//   该节点被删除             ⇒ 下拉里**移掉**该项，并把选中它的实例回落到「请选择VAE模型」。
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

  // 3) 自动切换 / 回落（只有在没接线时才有意义）
  if (present) {
    if (!wired && cur === VAE_PLACEHOLDER) setWidgetValue(node, w, USE_JOSIA_VAE);
  } else if (cur === USE_JOSIA_VAE) {
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

// ── 上传预览图压暗（表示「上游已接线，本节点载入的图会被忽略」）──
// 🔴 原理：上传预览存在 node.imgs（HTMLImageElement 数组），由 litegraph 用 ctx.drawImage 画在
//    节点 canvas 上 ⇒ 没有 DOM 元素可挂 CSS 样式，只能拦截绘制、在画这些图时压低 globalAlpha。
//    拦截窗口放在节点自身的 draw()（整个节点的绘制入口）⇒ 覆盖 imgs 在任何绘制阶段的发生。
// 🔴 铁律：只认 node.imgs 里的那几个 img，其它绘制（背景 / 边框 / 文字 / 其它节点的图）一律不碰；
//    画完必须把 globalAlpha 与 drawImage 原样还原，绝不留污染。
function installPreviewDim(node) {
  if (node.__josiaPreviewHooked) return;
  const base = node.draw;
  if (typeof base !== "function") return;
  node.__josiaPreviewHooked = true;
  node.draw = function (ctx, ...args) {
    const imgs = this.__josiaPreviewDim && this.imgs ? this.imgs : null;
    if (!imgs || imgs.length === 0 || !ctx || typeof ctx.drawImage !== "function") {
      return base.apply(this, [ctx, ...args]);
    }
    const od = ctx.drawImage;
    ctx.drawImage = function (img, ...da) {
      const owned = imgs.indexOf(img) >= 0;
      if (!owned) return od.call(this, img, ...da);
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = prev * PREVIEW_DIM_FACTOR;
      try {
        return od.call(this, img, ...da);
      } finally {
        ctx.globalAlpha = prev;
      }
    };
    try {
      return base.apply(this, [ctx, ...args]);
    } finally {
      ctx.drawImage = od;
    }
  };
}

// 开关预览压暗；切换时请求一次重绘，让状态立刻生效（不必等下一次交互）
function setPreviewDim(node, dim) {
  node.__josiaPreviewDim = !!dim;
  if (dim) installPreviewDim(node);
  try { app.graph?.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
}

// 「图像」端口接线 ⇒ 灰化「选择图像」下拉 + 压暗已载入的预览图（端口优先）
function syncUploadCombo(node) {
  const up = getWidget(node, "选择图像");
  if (up) up.disabled = isPortWired(node, "image");
  setPreviewDim(node, isPortWired(node, "image"));
}

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
      // 🔴 装上图节点增删钩子（删掉「Josia模型加载」节点时才能实时把该项移出下拉）
      installGraphHooks(this);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      syncAll(this);
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
  },
});
