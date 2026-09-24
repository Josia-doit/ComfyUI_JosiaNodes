/**
 * Josia 媒体保存 节点前端扩展
 * 节点标识：JosiaMediaSave（与后端 media_save.py 的 NODE_CLASS_MAPPINGS 键一致）
 *
 * 设计取舍（用户明确要求）：
 *  1) 所有控件由本文件用 DOM 渲染成一个紧凑面板，原生 widget 全部隐藏（仅作数据载体）。
 *  2) 每个 DOM 控件一对一绑定后端同名 widget，值 / 默认值 / 范围 / 序列化全部走原路。
 *  3) 下拉框不用 <select>，改用自定义浮层（OS 绘制的 <select> 列表底色/高亮控制不了，会与原生割裂）。
 *  4) 「图像 / 视频 / 音频」三档胶囊：切的是「当前编辑哪一组设置」；后端是三个独立参数，切换保值。
 *
 * 关键实现坑（本包血泪史，勿改）：
 *  · 经典 LiteGraph 看 widget.hidden，Node 2.0(Vue) 看 widget.options.hidden → 两个都要设。
 *  · Node 2.0 检测只认官方内部标志 window.LiteGraph.vueNodesMode === true（严格）。
 *  · 前端构造阶段就为每个 widget 建输入槽（早于 onNodeCreated），只 hidden 只挡绘制、槽仍在
 *    node.inputs → 必须 socketless + removeInput（见 dropStaleInputs）。
 *  · EXPOSED_INPUTS 里的参数故意保留输入槽（可从上游连线），并留高度防叠在左上角。
 *  · 滚轮缩放：节点面板捕获 wheel → 直接调用 LiteGraph 原生 handler 转发给画布（仿 multi_image_loader）。
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

/* ============================ Node 2.0 (Vue) 检测 ============================ */
function isVueNodes2() {
  try {
    const lg = (typeof window !== "undefined" && window.LiteGraph) ? window.LiteGraph : null;
    return !!(lg && lg.vueNodesMode === true);
  } catch (e) { return false; }
}

/* ================================ 尺寸常量 ================================ */
const ROW_H = 22;           // 控件行高（本包 22px 按钮规范）
const ROW_GAP = 6;
const PAD = 8;
const MIN_PANEL_H = 96;
const EXT_NAME = "JosiaNodes.JosiaMediaSave";
const DEF_VIDEO = "MP4";                 // 视频 tab 默认容器
const AUDIO_LOSSLESS = new Set(["FLAC", "WAV"]);   // 无损音频 → 音质灰化
// 绝对无损图像格式（没有有损分支）：「质量」无意义 ⇒ 灰化并固定显示 100（后端也按 100 处理）。
// 与后端 ALWAYS_LOSSLESS 保持一致（去掉 ⭐ 前缀后的显示名）。
const ALWAYS_LOSSLESS = new Set(["PNG", "TIFF", "BMP", "TGA", "PPM", "PBM", "ICO", "DDS", "PCX"]);

// 故意保留输入槽的参数（用户要的「帧率等数值可从上游连线进来」）+ 各留的高度。
const EXPOSED_INPUTS = { filename_prefix: 14, "帧率": 14, "质量": 14 };

// 压缩级别三档胶囊（PNG zlib 0~9，不影响画质，只影响体积与耗时）
const COMPRESS_STEPS = [
  { label: "最快", value: 1 },
  { label: "标准", value: 4 },
  { label: "最小", value: 9 },
];
const compressToStep = (v) => {
  const n = Number(v) || 0;
  if (n <= 2) return 1;
  if (n <= 6) return 4;
  return 9;
};

const TABS = [
  { label: "图像", value: "image" },
  { label: "视频", value: "video" },
  { label: "音频", value: "audio" },
];

// 🔴 必须与后端 media_save.py 的同名常量逐字一致
const USE_JOSIA_VAE = "使用Josia模型加载VAE";   // VAE1 / VAE2 检测到 Josia 模型加载节点时自动选中
const VAE1_PLACEHOLDER = "🎨 请选择模型…";      // VAE1 默认占位符
const PLACEHOLDER_VAE2 = "🎵 请选择模型…";      // VAE2（音频 VAE）的默认项
// 🔴 必须与后端 media_save.py 的 DEFAULT_PREFIX 逐字一致。
// `JosiaMedia\` ＝ output 下的子目录；`%001%` ＝ 3 位序号占位（写在哪替换在哪）。
const DEFAULT_PREFIX = "JosiaMedia\\Media_%001%";
const DEFAULT_NAME = "Media_%001%";               // 只有文件名那一段（兜底用）

/* ================================== CSS ================================== */
const STYLE_ID = "josia-media-save-style";
const CSS = `
.jms-root{box-sizing:border-box;width:100%;padding:${PAD}px;display:flex;flex-direction:column;
  gap:${ROW_GAP}px;font-size:11px;line-height:1.25;color:inherit;
  /* 🔴 面板高度跟随节点：内容装不下时「面板内部滚动」，绝不溢出到节点外。
     注意不能写 height:100%（会让面板被拉伸、留白异常）。节点高度只由用户拖拽决定。 */
  max-height:100%;overflow-y:auto;overflow-x:hidden;
  /* 🔴🔴 面板整体 pointer-events:none —— 这**不是**「面板不可交互」，而是把「空白处」的指针
     事件让给下层 canvas。官方 DOM widget 就是「容器穿透 + 控件抢回」这套模型：
       · 空白处 pointerdown 原生落到 canvas ⇒ 官方 CanvasPointer 接管并在拖动时
         setPointerCapture，所以按住面板空白 / 生成的图像也能像原生节点一样移动节点；
       · 面板自己再也收不到空白区事件 ⇒ 顺带根除「在空白处拖动划选文字、触发浏览器
         『搜索选中内容』」的老毛病（上一版只能用 user-select:none 打补丁）。
     ⚠️ 真正的交互控件在下面逐条抢回 auto；**信息窗属于纯交互区，不参与拖动**（哥哥明确要求）。 */
  pointer-events:none;
  user-select:none;-webkit-user-select:none;}
/* 只有这些控件接收指针事件，其余一律穿透到画布（＝按住即移动节点） */
.jms-root input,.jms-root textarea,.jms-root button,
.jms-root .jms-btn,.jms-root .jms-numwrap,.jms-root .jms-drop,
.jms-root .jms-capsule,.jms-root .jms-dot,.jms-root .jms-info{pointer-events:auto;}
/* 输入框内文本照常可选中/编辑 */
.jms-root input,.jms-root textarea{user-select:text;-webkit-user-select:text;}
/* 🔴 已被「接线优先」灰化的下拉必须继续不可点（本条特异性更高，压过上面的 auto） */
.jms-root .jms-drop.disabled{pointer-events:none;}
/* 🔴🔴 让 **DOM widget 的外层盒子**也对画布透明 —— 参数面板的空白处才能按住拖动节点。
   取证（GraphView → src/components/graph/widgets/DomWidget.vue）确认：官方给这层
   「div.dom-widget」写的是**行内** pointer-events（visible 且非只读 ⇒ 'auto'），
   而它正好罩在面板外面 ⇒ 空白处（root 已 none）透下来又被它吃掉 ⇒ 面板空白永远拖不动。
   行内样式只能被 !important 压过；用 :has(> .jms-root) 精确指向「装着我们面板的那一层」，
   其它节点的 DOM widget 不受影响。面板里的真控件在 .jms-root 内各自抢回 auto，照常可点。 */
div.dom-widget:has(> .jms-root){pointer-events:none !important;}
/* 🔴 行永不被压缩：面板高度不足时靠 root 自己滚动，行的高度必须是自然高度。
   否则 flex 纵向收缩会让 offsetHeight 变小 ⇒ 量出来的内容高度偏小 ⇒ 尺寸判断连环错。 */
.jms-root>*{flex:0 0 auto;}
.jms-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;}
/* 🔴 信息窗＝四行文本（不再用多格容器、不再罗列全部选项的当前值）：
   输入 / 输出 / 其他 三行是「正常显示信息」，由 updateInfo() 维护；
   最底部一行是「状态日志」，只有 setStatus() 会写它 —— 打开目录之类的操作日志
   绝不允许覆盖上面三行（这是上一版的 bug）。 */
.jms-info{box-sizing:border-box;min-height:30px;padding:5px 26px 5px 7px;border-radius:6px;
  border:1px solid #333;
  background:#000;color:#e6e6e6;
  font-size:10px;line-height:1.5;
  position:relative;
  /* 🔴 信息窗里的文本要能鼠标选中/复制（面板整体是 user-select:none，这里单独放开） */
  user-select:text;-webkit-user-select:text;}
/* 右上角「复制全部文本」按钮 */
.jms-info-copy{position:absolute;top:3px;right:4px;width:18px;height:18px;line-height:1;
  display:inline-flex;align-items:center;justify-content:center;
  border:1px solid rgba(128,128,128,.4);border-radius:4px;background:rgba(40,40,44,.92);
  color:#c9c9c9;font-size:11px;cursor:pointer;padding:0;
  user-select:none;-webkit-user-select:none;}
.jms-info-copy:hover{background:rgba(70,70,78,.95);color:#fff;}
.jms-inf-line{white-space:pre-wrap;word-break:break-all;}
.jms-inf-line .jms-inf-k{opacity:.5;}
.jms-inf-status{margin-top:3px;padding-top:3px;border-top:1px solid rgba(128,128,128,.25);
  opacity:.85;white-space:pre-wrap;word-break:break-all;}
.jms-inf-status.err{color:#ffb4b4;opacity:1;}
.jms-info.plain{display:block;}
.jms-inf-err{white-space:pre-wrap;word-break:break-all;color:#ffb4b4;}
.jms-sep{width:1px;height:14px;background:rgba(128,128,128,.32);margin:0 2px;flex:0 0 auto;}

/* 🔴 信息窗里的「已被改动」高亮（醒目黄）：输出帧率一旦离开默认值就用它标出来，
   误操作 / 忘了改回默认时一眼可见。 */
.jms-hi-warn{color:#ffd24a;font-weight:700;}
/* 🔴 分块行（解码方式那一行）紧凑版：默认节点宽度下六颗胶囊必须落在同一行。
   只收紧内边距与间距（不改字号、不截断文本）——省下的每一像素都是为「不换行」服务的。 */
.jms-row4{gap:4px;}
.jms-row4 .jms-drop{padding:0 3px 0 6px;gap:3px;}
.jms-row4 .jms-drop-lab{padding-right:2px;}
.jms-row4 .jms-caret{padding-left:2px;}
/* 🔴 恢复默认按钮：默认态与其他按钮同款深灰（哥哥要求：橙红渐变不实现），仅加粗字重强调。
   点击后原地变形为「确认(红)/取消(蓝)」双小胶囊（仿清理缓存长条：外框深灰、内部小胶囊带色块、
   中间竖线分隔、四向留白一致）。 */
.jms-btn-reset{font-weight:600;}
/* 未武装态：只显示文字标签；武装态：隐藏标签、露出两颗小胶囊 + 中间竖线 */
.jms-btn-reset .jms-reset-lab{display:inline;}
.jms-btn-reset.armed .jms-reset-lab{display:none;}
.jms-btn-reset .jms-reset-cap,
.jms-btn-reset .jms-reset-div{display:none;}
/* 武装态：外框 padding 3px ⇒ 左胶囊左边距 / 右胶囊右边距 = 上下边距（四向同距） */
.jms-btn-reset.armed{gap:0;padding:3px;}
.jms-btn-reset.armed .jms-reset-div{display:inline-block;}
/* 🔴 小胶囊（16px 高）：内部色块仿清理缓存的 thumb（绝对定位铺满），文字 z-index 1 +
   line-height:1 + flex 居中 ⇒ 文字垂直居中（旧版基线偏下已修） */
.jms-btn-reset.armed .jms-reset-cap{position:relative;display:inline-flex;align-items:center;
  height:16px;padding:0 11px;border-radius:999px;font-size:10px;font-weight:600;color:#fff;
  cursor:pointer;user-select:none;}
.jms-btn-reset.armed .jms-reset-thumb{position:absolute;top:0;left:0;height:100%;width:100%;
  border-radius:999px;pointer-events:none;}
.jms-btn-reset.armed .jms-reset-txt{position:relative;z-index:1;line-height:1;}
.jms-reset-confirm .jms-reset-thumb{background:linear-gradient(180deg,#ff5a5a,#d83636);}
.jms-reset-cancel .jms-reset-thumb{background:linear-gradient(180deg,#4f8cff,#2f6fe0);}

/* 统一：所有控件 22px 高 + 胶囊圆头（大圆角） */
.jms-drop,.jms-numwrap,.jms-capsule,.jms-dot,.jms-btn{
  height:${ROW_H}px;box-sizing:border-box;
  border:1px solid var(--border-default,rgba(128,128,128,.5));
  background:var(--base-background,rgba(20,20,22,.92));
  color:var(--base-foreground,inherit);font-size:11px;}
.jms-drop,.jms-numwrap,.jms-capsule,.jms-dot{border-radius:999px;display:inline-flex;align-items:center;}
.jms-btn{border-radius:999px;cursor:pointer;white-space:nowrap;padding:0 10px;display:inline-flex;align-items:center;}
.jms-btn:hover{background:var(--secondary-background,rgba(128,128,128,.24));}
.jms-btn:disabled{opacity:.4;cursor:default;}

/* 带内联灰标签的下拉框：左边灰字 + 右边选中值 + 箭头
   🔴 宽度按内容自适应（不再写死像素宽，避免「分块解码」被挤成「分…」）：
      flex:0 0 auto + width:auto ⇒ 基准宽度取 max-content，整块胶囊完整显示；
      一行放不下时由 .jms-row 的 flex-wrap 换行，而不是把文字压成省略号。 */
.jms-drop{padding:0 4px 0 7px;gap:5px;cursor:pointer;min-width:84px;position:relative;
  flex:0 0 auto;white-space:nowrap;}
.jms-drop.disabled{opacity:.45;pointer-events:none;}
/* 🔴「不支持的选项一律灰化、绝不隐藏」（哥哥要求）：隐藏会让胶囊宽度忽宽忽窄、
   切格式时整行突然跳一下 —— 灰化禁用则尺寸恒定，视觉不割裂。
   胶囊 / 数字控件 / 圆点开关同样套用，与下拉保持同一观感。 */
.jms-capsule.disabled{opacity:.45;pointer-events:none;}
.jms-numwrap.disabled{opacity:.45;pointer-events:none;}
.jms-dot.disabled{opacity:.45;pointer-events:none;}
.jms-drop-lab{flex:0 0 auto;opacity:.55;font-size:10px;white-space:nowrap;}
/* 🔴 选中值文本在「文本容器」内居中（哥哥要求：左对齐/右对齐版面不美观）：
      btn 改 flex:1 1 auto 吃掉标签与箭头之间的全部剩余宽度 ⇒ 定宽胶囊（视频行 118px、
      分块行按各自内容定宽）里选中值永远居中；自适应宽度的胶囊按钮本就贴内容，视觉不变。 */
.jms-drop-btn{flex:1 1 auto;border:none;background:none;color:inherit;text-align:center;
  font:inherit;outline:none;white-space:nowrap;cursor:pointer;padding:0;}
/* 🔴 箭头属于点击热区：让用户点右边的 ▾ 也能开菜单
   （此前 pointer-events:none ⇒ 只有文字能点，非常割裂） */
.jms-caret{margin-left:auto;opacity:.6;font-size:9px;padding-left:3px;flex:0 0 auto;cursor:pointer;}
.jms-drop:focus-within,.jms-numwrap:focus-within,.jms-btn:focus{border-color:var(--primary-background,#7aa2ff);}

/* 浮层菜单 + 透明遮罩（点画布/节点任意空白都能收起） */
.jms-overlay{position:fixed;inset:0;z-index:99998;}
.jms-menu{position:fixed;z-index:99999;box-sizing:border-box;padding:4px;border-radius:6px;
  background:var(--base-background,#171718);color:var(--base-foreground,#fff);
  border:1px solid var(--border-default,#494a50);box-shadow:0 6px 24px rgba(0,0,0,.5);
  max-height:60vh;overflow:auto;font-size:11px;}
.jms-menu-item{padding:5px 10px;border-radius:4px;cursor:pointer;white-space:nowrap;opacity:.92;}
.jms-menu-item:hover{background:var(--secondary-background,#262729);}
.jms-menu-item.on{background:var(--primary-background,#3d6ea8);color:#fff;font-weight:600;opacity:1;}

/* 胶囊（三档 / 双选 / 长条） */
/* 🔴 同心圆等距：thumb 填满 track（top:0/height:100%），四向留白全由胶囊 padding 统一提供
   （3px）—— thumb 自己再 inset 会让垂直间距 = padding+inset > 水平间距，色块左右贴边。 */
.jms-capsule{padding:3px;gap:0;flex:0 0 auto;}
/* 🔴 左内边距 7px：与外框 padding(3px) 合计 10px，和其它胶囊/下拉的内联标签左间距一致
   （原来只有 2px，合计 5px ⇒ 标签贴着胶囊左边缘，看着比别的胶囊窄） */
.jms-cap-label{flex:0 0 auto;opacity:.6;font-size:10px;padding:0 5px 0 7px;white-space:nowrap;user-select:none;}
.jms-cap-track{position:relative;display:inline-flex;align-items:center;}
.jms-cap-thumb{position:absolute;top:0;left:0;height:100%;border-radius:999px;
  background:var(--primary-background,#3d6ea8);transition:transform .14s ease,width .14s ease;pointer-events:none;}
.jms-cap-item{position:relative;z-index:1;padding:0 10px;height:16px;line-height:16px;
  font-size:10px;cursor:pointer;white-space:nowrap;opacity:.72;user-select:none;}
.jms-cap-item.on{opacity:1;font-weight:600;color:#fff;}
.jms-lc-div{width:1px;height:10px;background:rgba(128,128,128,.32);margin:0 4px;flex:0 0 auto;}
/* 内嵌小胶囊（清理缓存长条里套的两颗）：自身比外框矮，四向留白由外框 padding 统一给
   （外框 22px + padding 3px → 内容 16px，小胶囊 16px 恰好嵌入，右端与上下边距一致）。 */
.jms-cap-inner{height:16px;padding:2px;}
.jms-cap-inner .jms-cap-item{height:12px;line-height:12px;font-size:9px;padding:0 8px;}

/* 圆点开关（保存元数据 / 保存 Latent） */
.jms-dot{gap:6px;padding:0 11px;cursor:pointer;flex:0 0 auto;
  width:108px;justify-content:center;overflow:hidden;}
.jms-dot-txt{opacity:.85;font-size:10px;white-space:nowrap;}
.jms-dot-mark{width:10px;height:10px;border-radius:50%;border:2px solid var(--primary-background,#3d6ea8);
  box-sizing:border-box;background:transparent;transition:background .12s,border-color .12s;}
.jms-dot.on .jms-dot-mark{background:var(--primary-background,#3d6ea8);}
.jms-dot.on .jms-dot-txt{opacity:1;font-weight:600;}

/* 数字输入（带内联灰标签 + 上下步进箭头） */
.jms-numwrap{overflow:hidden;flex:0 0 auto;}
.jms-in-lab{flex:0 0 auto;opacity:.55;font-size:10px;padding:0 4px 0 7px;white-space:nowrap;}
.jms-numwrap input{border:none;background:transparent;color:inherit;font:inherit;text-align:center;
  width:46px;padding:0 2px;outline:none;-moz-appearance:textfield;appearance:textfield;}
.jms-numwrap input::-webkit-outer-spin-button,
.jms-numwrap input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;display:none;}
.jms-num-step{flex:0 0 auto;width:15px;border:none;background:transparent;color:inherit;cursor:pointer;
  font-size:9px;opacity:.6;padding:0;}
.jms-num-step:hover{opacity:1;}

.jms-mask{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.5);
  display:flex;align-items:center;justify-content:center;}
.jms-panel{box-sizing:border-box;width:min(560px,86vw);max-height:74vh;display:flex;
  flex-direction:column;gap:8px;padding:12px;border-radius:8px;
  background:var(--base-background,#171718);color:var(--base-foreground,#fff);
  border:1px solid var(--border-default,#494a50);box-shadow:0 12px 40px rgba(0,0,0,.55);font-size:12px;}
.jms-panel-head{display:flex;align-items:center;justify-content:space-between;font-weight:600;}
.jms-panel-bar{display:flex;gap:6px;align-items:center;}
.jms-panel-bar input{flex:1 1 auto;min-width:80px;height:${ROW_H}px;box-sizing:border-box;padding:0 6px;
  border-radius:4px;border:1px solid var(--border-default,#494a50);
  background:rgba(128,128,128,.14);color:inherit;font-size:11px;}
.jms-panel-list{flex:1 1 auto;min-height:180px;max-height:44vh;overflow:auto;border-radius:6px;
  border:1px solid var(--border-default,#494a50);padding:3px;}
.jms-dir{padding:5px 8px;border-radius:4px;cursor:pointer;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;}
.jms-dir:hover{background:var(--secondary-background,#262729);}
.jms-chips{display:flex;flex-wrap:wrap;gap:6px;}
.jms-chip{padding:3px 9px;border-radius:999px;cursor:pointer;font-size:11px;
  border:1px solid var(--border-default,#494a50);background:rgba(128,128,128,.12);}
.jms-chip:hover{background:var(--secondary-background,#262729);}
.jms-panel-foot{display:flex;align-items:center;gap:8px;justify-content:space-between;}
.jms-panel-foot .cur{opacity:.72;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
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

function comboValues(w, node) {
  const v = w?.options?.values;
  try {
    if (typeof v === "function") return v(w, node) || [];
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

function mkRow() { return el("div", "jms-row"); }

/* 🔴「不保存」三兄弟：图像 / 视频 / 音频各有一个，值由后端 INPUT_TYPES 提供。
   规则：恒排在各下拉的**最后一项**（以后新增格式一律插在它前面）；
   选中它 ⇒ 该路不落盘，同时「保存Latent」强制开启（本节点必须有产物，禁止空转）。 */
const NONE_IMAGE = "不保存图像";
const NONE_VIDEO = "不保存视频";
const NONE_AUDIO = "不保存音频";

// 下拉排序：把「不保存X」顶到最后；weight 用于同时保留其它既定排序（如视频 GIF 排倒数第二）
function noneWeight(v, noneVal, extraLast) {
  if (String(v) === noneVal) return 2;
  if (extraLast && String(v) === extraLast) return 1;
  return 0;
}
function sortNoneLast(items, noneVal, extraLast) {
  return items.slice().sort(
    (a, b) => noneWeight(a.value, noneVal, extraLast) - noneWeight(b.value, noneVal, extraLast));
}

/**
 * 灰化（禁用）一个控件，而不是隐藏它。
 * 支持三种形态：mkDrop 的包装对象 {el}、mkNumber/mkText 的 DOM、mkCapsule 的包装对象 {el}。
 */
function grayCtl(ctl, on, tipWhenGray, tipNormal) {
  const e = ctl && ctl.el ? ctl.el : ctl;
  if (!e) return;
  if (e.dataset.jmsTitle === undefined) e.dataset.jmsTitle = tipNormal || e.title || "";
  e.classList.toggle("disabled", !!on);
  e.title = on ? tipWhenGray : e.dataset.jmsTitle;
  // 数字控件的输入框要真的禁用（避免还能键盘输入）
  const inp = e.querySelector ? e.querySelector("input") : null;
  if (inp) inp.disabled = !!on;
}

/* ============================ 下拉浮层 + 遮罩 ============================ */
let _openLayer = null;
let _openOverlay = null;

function closeMenu() {
  if (_openLayer) { _openLayer.remove(); _openLayer = null; }
  if (_openOverlay) { _openOverlay.remove(); _openOverlay = null; }
  _openOwner = null;
}
let _openOwner = null;   // 当前打开的菜单属于哪个按钮（pointerdown→click 连发去重用）
let _openedAt = 0;
window.addEventListener("blur", closeMenu);
// 滚动时直接关掉浮层（滚轮缩放的转发在节点面板 root 上单独处理）
document.addEventListener("wheel", closeMenu, { passive: true, capture: true });

/**
 * 自定义下拉。items: [{value,label}]（缺省取 widget 的 combo 选项）；
 * label 为显示在控件左侧的灰色说明字（如「文件格式」「VAE1」）。
 */
function mkDrop(node, widget, { width, label, items = null, decorate = null, onChange = null } = {}) {
  const wrap = el("div", "jms-drop");
  if (label) wrap.appendChild(el("span", "jms-drop-lab", label));
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "jms-drop-btn";
  const caret = el("span", "jms-caret", "▾");
  wrap.appendChild(btn);
  wrap.appendChild(caret);

  const listItems = () => {
    const raw = items ? items() : (comboValues(widget, node) || []);
    return raw.map((v) => {
      const value = (v && typeof v === "object") ? v.value : v;
      const label = (v && typeof v === "object") ? v.label : String(v);
      return { value, label: decorate ? decorate(value, label) : label };
    });
  };

  const sync = () => {
    const cur = String(widget?.value ?? "");
    const hit = listItems().find((it) => String(it.value) === cur);
    btn.textContent = hit ? hit.label : cur;   // 始终显示当前值（候选为空也显示原始值）
    // 🔴 绝不把「当前值」写成悬浮提示：值已经明明白白在屏幕上，再弹一遍没有任何信息量。
    //    整块胶囊（含右侧 ▾）统一显示调用点设在 wrap 上的「功能说明」。
  };

  function openMenu() {
    closeMenu();
    const overlay = el("div", "jms-overlay");
    const layer = el("div", "jms-menu");
    layer.setAttribute("role", "listbox");
    const cur = String(widget?.value ?? "");
    const itemsNow = listItems();
    if (!itemsNow.length) {
      const empty = el("div", "jms-menu-item", "（无可用选项）");
      empty.style.opacity = ".6";
      empty.style.cursor = "default";
      layer.appendChild(empty);
    }
    for (const it of itemsNow) {
      const sel = String(it.value) === cur;
      const row = el("div", "jms-menu-item" + (sel ? " on" : ""), it.label);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", sel ? "true" : "false");
      row.title = it.label;
      row.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setWidgetValue(node, widget, it.value);
        closeMenu();
        sync();
        onChange ? onChange(it.value) : node._jmsRefresh?.();
      });
      layer.appendChild(row);
    }
    overlay.appendChild(layer);
    document.body.appendChild(overlay);
    _openLayer = layer;
    _openOverlay = overlay;

    const r = btn.getBoundingClientRect();
    const mh = layer.offsetHeight;
    const mw = layer.offsetWidth;
    let top = r.bottom + 2;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 2);
    layer.style.top = top + "px";
    layer.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + "px";
    layer.style.minWidth = Math.max(r.width, 80) + "px";
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) closeMenu(); });
  }

  // 🔴 双通道开菜单：pointerdown + click 都挂（带归属去重）。
  //    只挂 pointerdown 的版本在部分环境下事件被吞 ⇒ 下拉彻底无入口（「所有下拉点不动」根因之一）。
  //    pointerdown 先到 → 开菜单；随后的 click（同一块 500ms 内）忽略，避免开完立刻又被关掉。
  const toggleMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (_openLayer) {
      if (_openOwner === wrap && Date.now() - _openedAt < 500) return; // 自己刚开的，忽略连发
      closeMenu();
      return;
    }
    _openOwner = wrap;
    _openedAt = Date.now();
    try { openMenu(); } catch (err) {
      try { console.error("[Josia媒体保存] 下拉菜单打开失败：", err); } catch (e2) { /* 忽略 */ }
    }
  };
  // 🔴 挂在**整块胶囊**上而不是只挂按钮：内联灰标签、右侧 ▾ 箭头都成为点击热区。
  //    只挂按钮时，用户本能地去点箭头/边缘反而毫无反应 —— 这就是「▾ 点不动」的根因。
  wrap.addEventListener("pointerdown", toggleMenu);
  wrap.addEventListener("click", toggleMenu);

  if (width) wrap.style.width = width + "px";
  wrap.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  // 🔴 构造完立即 sync 一次：当前值立刻上屏，不依赖 refresh 链
  //    （此前 refreshInner 一旦抛异常，所有下拉就永远是空标签 + 无值的「死」观感）。
  try { sync(); } catch (e) { /* 忽略 */ }
  // 诊断：候选为空时给一次告警，方便排错（前端显示空下拉＝后端没给候选）
  try {
    if (!listItems().length && !mkDrop._warned) {
      mkDrop._warned = true;
      console.warn(`[Josia媒体保存] 下拉「${label || "?"}」无候选（comboValues 为空），请检查后端选项是否提供。`);
    }
  } catch (e) { /* 忽略 */ }
  // 🔴 一并把 listItems 交出去：调用点（分块行定宽）要按「真实候选标签」量宽 ——
  //    候选标签可能被 decorate 改过（加 ⭐ / 加 Emoji），只读 comboValues 会量偏 ⇒ 文本被挤。
  return { el: wrap, sync, btn, items: listItems };
}

/* ============================== 胶囊组件 ============================== */
function mkCapsule(items, getValue, onPick, { label = null, onChange = null, cls = "", tip = "" } = {}) {
  const box = el("div", "jms-capsule" + (cls ? " " + cls : ""));
  if (label) box.appendChild(el("span", "jms-cap-label", label));
  const track = el("div", "jms-cap-track");
  const thumb = el("div", "jms-cap-thumb");
  track.appendChild(thumb);
  const cells = [];
  for (const it of items) {
    const s = el("span", "jms-cap-item", it.label);
    // 🔴 悬浮提示＝这一档的功能说明；指向「已选中的那一档」也显示同一条，
    //    绝不把取值本身当提示（值就在屏幕上，重复弹一遍没有意义）。
    s.title = it.tip || tip || it.label;
    s.addEventListener("click", () => { onPick(it.value); sync(); });
    track.appendChild(s);
    cells.push(s);
  }
  box.appendChild(track);
  if (tip) box.title = tip;
  box.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  function sync() {
    const v = getValue();
    let idx = items.findIndex((it) => String(it.value) === String(v));
    if (idx < 0) idx = 0;
    // 🔴 用 offsetLeft / offsetWidth（元素坐标系）实测单元格几何 → 与 padding/边距严格对齐。
    // 不能用 getBoundingClientRect：DOM widget 容器带 transform/zoom，rect 是屏幕像素，
    // 写进 style.width / translateX 会被再乘一次缩放 ⇒ 色块过宽、切换时跑出胶囊外。
    const cell = cells[idx];
    const x = cell.offsetLeft;
    const w = cell.offsetWidth;
    if (w > 0) {
      thumb.style.transform = `translateX(${x}px)`;
      thumb.style.width = `${w}px`;
    }
    cells.forEach((c, i) => c.classList.toggle("on", i === idx));
  }
  // 字体加载 / 尺寸变化后重新量（首帧可能量到旧布局）
  try {
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(() => sync()).catch(() => {});
    }
    const ro = new ResizeObserver(() => sync());
    ro.observe(track);
  } catch (e) { /* 老环境无 ResizeObserver 时忽略 */ }
  if (onChange) box._onChange = onChange;
  return { el: box, sync };
}

/* ============================== 数字输入（自定义步进） ============================== */
function mkNumber(node, widget, { width, label, step = 1, wstep, min, max, prec } = {}) {
  const wrap = el("div", "jms-numwrap");
  if (label) wrap.appendChild(el("span", "jms-in-lab", label));
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
  // 🔴 step 的小数位数＝结果精度。Math.ceil(v / 0.1) * 0.1 会算出 0.30000000000000004，
  //    直接写进 input.value 就显示成那样（浮点噪声，帧率 0.1 步进最容易踩）。
  const _dec = (s) => {
    const t = String(s);
    const i = t.indexOf(".");
    return i < 0 ? 0 : (t.length - i - 1);
  };
  // 🔴 wstep＝滚轮/上下箭头的步进（默认同 step）。可以是**函数** ⇒ 按当前值动态分档
  //    （帧率：≥1 走 1、[0.1,1) 走 0.1、<0.1 走 0.01 —— 哥哥要求的「越往下越细」）。
  const WSTEP = (wstep !== undefined && wstep !== null && (typeof wstep === "function" || wstep > 0)) ? wstep : step;
  const _wstepAt = (v) => (typeof WSTEP === "function") ? WSTEP(v) : WSTEP;
  // 🔴 prec＝显式精度（覆盖按 step/wstep 推出来的位数）。帧率要精确到小数点后两位
  //    （手输 29.97 不得在 blur 时被 0.1 的精度抹成 30），必须显式给 2。
  const PREC = (prec !== undefined && prec !== null)
    ? Math.max(0, Math.min(6, prec))
    : Math.max(0, Math.min(6, Math.max(_dec(step), _dec((typeof WSTEP === "function") ? 0 : WSTEP))));
  const FACTOR = Math.pow(10, PREC);
  const rnd = (x) => Math.round((x + Number.EPSILON) * FACTOR) / FACTOR;
  const commit = (snap) => {
    let v = parseFloat(inp.value);
    if (!isFinite(v)) v = (o.default !== undefined) ? o.default : (mn ?? 0);
    if (snap) v = Math.round(v / step) * step;
    v = rnd(clamp(v));
    inp.value = v;
    setWidgetValue(node, widget, v);
  };
  const stepBy = (dir) => {
    let v = parseFloat(inp.value);
    if (!isFinite(v)) v = Number(widget?.value ?? 0);
    v = rnd(clamp(v));
    // 🔴🔴 整数化步进 + ε 修正 —— 上一版在这里被浮点噪声卡死：
    //    0.03/0.01 = 2.9999999999999996 ⇒ Math.ceil 取整后又乘回 0.03（原地不动），
    //    1.7/0.1 = 16.999999999999996 同理 —— 表现就是「滚轮/箭头调几步就再也调不动」。
    // 🔴 动态档位（wstep 为函数时）：按「当前值所在区间」取步进。
    //    下行先把当前值减一个极小量再定档 —— 正好停在档位边界（1 / 0.1）时，
    //    继续下行走**更细**的一档（1→0.9、0.1→0.09），而不是一步跨过边界或跨到 0。
    const ref = (dir > 0) ? v : (v - Math.max(Math.abs(v), 1) * 1e-9);
    const ws = _wstepAt(ref);
    const k = v / ws;
    const kr = Math.round(k);
    // 已在档位网格上 ⇒ 正常 ±1 档；不在网格（如手输 29.97）⇒ 先**吸附**到移动方向的
    // 网格点（上行 ceil / 下行 floor），下一步起才是真正的 ±1 档。
    // （29.97 上推 → 30、下推 → 29，之后以 1 为步进继续 —— 哥哥要求的手输取整续步。）
    const onGrid = Math.abs(k - kr) < 1e-6;
    const nk = onGrid ? (kr + dir) : (dir > 0 ? Math.ceil(k - 1e-9) : Math.floor(k + 1e-9));
    let nv = nk * ws;
    // 🔴 步进结果必须钳回 [min,max]，再按精度取整，避免 0.1 步进累出 0.30000000000000004。
    nv = rnd(clamp(nv));
    inp.value = nv;
    setWidgetValue(node, widget, nv);
    node._jmsRefresh?.();
  };

  inp.addEventListener("change", () => commit(false));
  inp.addEventListener("blur", () => commit(false));
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit(false);
    else if (e.key === "ArrowUp") { e.preventDefault(); stepBy(1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); stepBy(-1); }
  });
  inp.addEventListener("wheel", (e) => {
    e.preventDefault(); e.stopPropagation();
    stepBy(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  const up = el("button", "jms-num-step", "▲"); up.type = "button";
  const dn = el("button", "jms-num-step", "▼"); dn.type = "button";
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
  const wrap = el("div", "jms-dot");
  const txt = el("span", "jms-dot-txt");
  const mark = el("span", "jms-dot-mark");
  wrap.appendChild(txt);
  wrap.appendChild(mark);
  function sync() {
    const on = !!widget?.value;
    wrap.classList.toggle("on", on);
    txt.textContent = on ? onText : offText;
    // 🔴 不写 wrap.title：开关的「当前状态」已经由文字显示出来了，
    //    悬浮提示留给调用点写明这个开关的**功能**（否则提示只是在重复取值）。
  }
  wrap.addEventListener("click", () => {
    setWidgetValue(node, widget, !widget?.value);
    sync();
    node._jmsRefresh?.();
  });
  sync();
  return { el: wrap, sync };
}

function mkText(node, widget, { label } = {}) {
  const wrap = el("div", "jms-numwrap");
  if (label) wrap.appendChild(el("span", "jms-in-lab", label));
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = widget?.value ?? "";
  inp.style.width = "100%";          // 填满容器（容器本身是 flex:1，随节点宽度自适应）
  inp.style.minWidth = "40px";
  inp.style.textAlign = "left";
  const commit = () => setWidgetValue(node, widget, inp.value);
  inp.addEventListener("change", commit);
  inp.addEventListener("blur", commit);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); });
  inp.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  wrap.appendChild(inp);
  wrap._input = inp;
  return wrap;
}

function mkBtn(text, title) {
  const b = el("button", "jms-btn", text);
  b.type = "button";
  if (title) b.title = title;
  return b;
}

/* ============================ 主 UI 注册 ============================ */
app.registerExtension({
  name: EXT_NAME,

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "JosiaMediaSave") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    const onConfigure = nodeType.prototype.onConfigure;
    const origResize = nodeType.prototype.onResize;

    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      const node = this;
      injectStyle();

      const W = {};
      for (const name of ["filename_prefix", "图像格式", "无损", "质量", "压缩级别",
        "视频容器", "帧率", "视频编码", "视频质量", "输出帧率", "音频格式", "音频质量",
        "保存潜空间", "解码方式", "分块尺寸", "分块重叠", "时间分块", "时间重叠",
        "解码精度", "清理缓存", "清理时机", "写入元数据", "临时预览", "VAE1", "VAE2"]) {
        W[name] = getWidget(node, name);
      }

      // VAE 注册表快照 + 自动切换闸门（Point 3：识别 Josia 模型加载节点）
      let vaeShared = null;            // /josia_media_save/vae_list 返回：Josia 模型加载节点是否载入了 VAE
      let _jmsJosiaAutoDone = false;   // 「使用Josia模型加载VAE」自动切换只触发一次的闸门（节点消失后复位可再触发）

      // 🔴🔴 VAE 联动的判定依据（2026-09-21 修）：**看图里有没有「Josia模型加载」节点**，
      //    而不是「注册表里有没有 VAE」。
      //    旧写法只看 /vae_list 的注册表快照，而注册表只在 `JosiaCheckpointPlus.load_model()`
      //    真正跑过一次之后才有值 ⇒ 新建工作流 / 重开工作流 / 先建媒体保存后建模型加载
      //    全都联动不上（用户报的问题 1：无论谁先创建都不联动）。
      //    现在两层判定「或」起来：
      //      ① 图里存在该节点（立刻生效，与创建先后无关）；
      //      ② 注册表里确实已有 VAE（那次运行真的载入过 ⇒ 可标注「已就绪」）。
      const JOSIA_LOADER_TYPES = ["JosiaCheckpointPlus", "JosiaModelLoader"];
      function graphHasJosiaLoader() {
        try {
          const g = app.graph;
          const list = g?._nodes || g?.nodes || [];
          for (let i = 0; i < list.length; i++) {
            const t = list[i]?.comfyClass || list[i]?.type;
            if (t && JOSIA_LOADER_TYPES.includes(String(t))) return true;
          }
        } catch (e) { /* 忽略 */ }
        return false;
      }
      // 「使用Josia模型加载VAE」这一项是否可用 / 是否可自动选中
      function josiaVaePresent() {
        if (graphHasJosiaLoader()) return true;
        return !!(vaeShared && (vaeShared.vae1 || vaeShared.vae2));
      }
      // 该共享 VAE 是否已经真的载入过（用于信息窗标注「已就绪 / 待运行」）
      function josiaVaeReady() {
        return !!(vaeShared && (vaeShared.vae1 || vaeShared.vae2));
      }

      // 格式能力正则 / 容器清单（refreshInner 与 updateInfo 都要用 → 提到外层作用域）
      const LOSSLESS_CAPABLE = /PNG|WebP|TIFF|AVIF|HEIF|JPEG XL|JPEG 2000/;
      const PNGISH = /PNG|JPEG 2000/;
      const AV_CONTAINERS = ["MP4", "MKV", "WebM"];

      // 🔴 可写元数据格式表（/josia_media_save/formats 异步填充）。
      // 必须声明在所有 mkDrop(decorate) 之前：下拉 sync() 会在面板构建/刷新期间
      // 同步调用 decorate 闭包（642/656 行引用 metaOk），声明放后面会触发
      // TDZ「Cannot access 'metaOk' before initialization」，整个工作流加载被中断。
      const metaOk = { image: new Set(), video: new Set(), audio: new Set() };

      // 🔴 共享状态一律声明在状态区（同一条 TDZ 铁律）：
      //    面板控件、刷新链、尺寸贴合都会引用它们，声明放后段会触发
      //    「Cannot access 'X' before initialization」，整个工作流加载会被中断。
      let lastRun = null;         // 后端 ui.josia_info：运行期权威信息
      let hasRun = false;         // 本节点是否已经跑过至少一次（信息窗据此区分「待运行」）
      let prevQ = undefined;      // 进入绝对无损格式前「质量」的真实值，切回普通格式时恢复
      let domWidget = null;       // addDOMWidget 返回的 DOM 控件（尺寸贴合要读它的 y / computedHeight）
      const extMap = {};          // 图像格式名 → 扩展名（/josia_media_save/formats 异步填充）

      // ---- 隐藏全部原生 widget（两种渲染器都要设，否则会漏出来）----
      for (const name of Object.keys(W)) {
        const w = W[name];
        if (!w) continue;
        w.hidden = true;
        w.options = w.options || {};
        w.options.hidden = true;
        // ★ 关键：显式把原生控件的 DOM 也藏掉（对照 multi_image_loader 的写法）。
        // 仅设 hidden/options.hidden 在部分前端下原生元素仍会渲染并盖在自定义面板上方，
        // 把上半区控件压住、导致「只剩底部圆点开关可点」的假死现象。
        if (w.element) w.element.style.display = "none";
        if (Object.prototype.hasOwnProperty.call(EXPOSED_INPUTS, name)) {
          w.computeSize = () => [0, EXPOSED_INPUTS[name]];
        } else {
          w.options.socketless = true;
          w.computeSize = () => [0, 0];
        }
      }

      const dropStaleInputs = () => {
        try {
          const stale = [];
          for (let i = 0; i < (node.inputs?.length || 0); i++) {
            const inp = node.inputs[i];
            if (!inp || !inp.widget) continue;
            if (inp.link) continue;
            if (EXPOSED_INPUTS[inp.widget.name] !== undefined) continue;
            stale.push(i);
          }
          for (let k = stale.length - 1; k >= 0; k--) node.removeInput(stale[k]);
        } catch (e) { /* 旧前端无此结构时忽略 */ }
      };
      node._jmsDropStaleInputs = dropStaleInputs;
      dropStaleInputs();

      /* ======================= 尺寸（Node 1.0 优先）======================= */
      // 用户明确跑 Node 1.0（classic LiteGraph）：直接设 node.size 即可，不必依赖 2.0 的
      // computeSize 加宽重试。规则：
      //   · 暂不设最小尺寸（用户要求：尺寸定准前先允许自由收窄 / 加宽）；
      //   · 新建节点（当前宽 < DEF_W）给到期望默认宽高；
      //   · 已较宽（用户保存过 / 拖宽过，含从工作流加载）则尊重，不强制。
      const DEF_W = 680;     // 期望默认宽（仅新建节点套用；下一轮再定最终值）
      const DEF_H = 300;     // 期望默认高
      const MIN_W = 300;     // 拖拽缩小下限（宽）
      const MIN_H = 120;     // 拖拽缩小下限（高）
      node.min_size = [MIN_W, MIN_H];
      // 🔴 节点里「不属于面板」的高度（标题栏 + 少量余量）。1.0 的 LiteGraph.NODE_TITLE_HEIGHT = 30。
      const chromeH = () => Math.round((Number(window.LiteGraph?.NODE_TITLE_HEIGHT) || 30) + 2);
      // 用户是否手动拖过尺寸（只由官方拖拽路径 node.setSize → onResize 置真，程序自身动作不经过它）
      let userResized = false;
      // 🔴🔴 尺寸铁律：computeSize() **绝不能返回「当前尺寸」**，必须返回固定的最小值。
      //    前端源码（LGraphCanvas.ts 拖拽缩放分支）：
      //      const min = node.computeSize()
      //      if (newBounds.width  < min[0]) newBounds.width  = min[0]
      //      if (newBounds.height < min[1]) newBounds.height = min[1]
      //      node.setSize(newBounds.size)
      //    —— computeSize() 被当作**最小尺寸**用。返回当前尺寸 ⇒ 任何缩小都被钳回当前尺寸
      //    ⇒ 表现「只能放大、不能缩小」（且与 userSized / applyLayout 都无关，改那些全白费）。
      node.computeSize = function () { return [MIN_W, MIN_H]; };
      // 新建节点直接给默认宽高；已较宽则尊重（从工作流加载的节点在 onConfigure 后会以保存尺寸为准）
      if (!(node.size && node.size[0] >= DEF_W)) {
        const w = (node.size && node.size[0] > 0) ? Math.max(node.size[0], DEF_W) : DEF_W;
        const h = (node.size && node.size[1] > 0) ? Math.max(node.size[1], DEF_H) : DEF_H;
        try { node.size = [w, h]; } catch (e) { /* 忽略 */ }
      }

      /* ======================= 面板骨架 ======================= */
      const root = el("div", "jms-root");

      // ---------- 行 1：[预览|保存] → [图像|视频|音频] → 📁选择 → 文件名前缀 → 📂打开 ----------
      const row1 = mkRow();
      const capPV = mkCapsule(
        [{ label: "预览", value: true, tip: "只写 temp、不落本地 output；仍可右键图像/视频另存" },
         { label: "保存", value: false, tip: "正常保存到 output 目录" }],
        () => !!W["临时预览"]?.value,
        (v) => { setWidgetValue(node, W["临时预览"], v); node._jmsRefresh?.(); });
      row1.appendChild(capPV.el);

      // 三档分类胶囊（图像 / 视频 / 音频）：置于预览/保存之后、文件名前缀之前
      const capTab = mkCapsule(TABS, () => tab, (v) => {
        const changed = (v !== tab);
        tab = v;
        if (changed) {
          // 🔴 只有「视频」分类才会输出视频 —— 切到非视频分类一律把「视频格式」置
          //    「不保存视频」（以前这儿的值是「关」，现已下线）。
          //    早点不重置会让上一轮在「视频」分类里选过的 MP4 静默生效，
          //    多图批次被擅自合成 MP4（用户报的「居然生成了 mp4」）。
          const _vBefore = String(W["视频容器"]?.value ?? NONE_VIDEO);
          if (tab === "video") {
            // 切回视频分类：悄悄还原上一次真正选过的容器（首次则回落到默认容器）。
            //    🔴 用户显式选过「不保存视频」时不还原 —— 那是他自己的选择，不能偷偷改掉
            //    （标记记在 node.properties.jms_vid_none，随工作流一起存）。
            const _noneByChoice = node.properties?.jms_vid_none === true;
            if ((_vBefore === NONE_VIDEO && !_noneByChoice) || _vBefore === "关") {
              setWidgetValue(node, W["视频容器"], lastVideoContainer || DEF_VIDEO);
            }
          } else {
            if (_vBefore !== NONE_VIDEO && _vBefore !== "关") lastVideoContainer = _vBefore;
            setWidgetValue(node, W["视频容器"], NONE_VIDEO);
            if (tab === "audio") setWidgetValue(node, W["音频格式"], "FLAC");
          }
          try { node.properties.jms_tab = tab; } catch (e) { /* 忽略 */ }
        }
        node._jmsRefresh?.();
      });
      capTab.el.title = "切到哪一组设置（图像 / 视频 / 音频）；各分类参数独立保值。";
      row1.appendChild(capTab.el);

      // 📁 选择：放在文件名前缀之前
      const btnPick = mkBtn("📁 选择", "选择一个输出目录（会在文件名框填入它的绝对路径）");
      row1.appendChild(btnPick);

      const fileWrap = mkText(node, W["filename_prefix"], { label: "文件名前缀" });
      fileWrap.style.flex = "1 1 120px";
      fileWrap.title =
        "输出文件名前缀。\n• 支持子目录：images/ComfyUI\n" +
        "• 通配符：%date% %time% %date:yyyyMMdd% %time:hhmm% %batch_num%\n" +
        "• 序号：不写就是「_ + 4 位序号」（JosiaMedia → JosiaMedia_0004）；\n" +
        "  想自定义位数就写 %0001%（4 位）/ %003%（3 位），写了下划线也由你自己控制（如 shot_%0001% → shot_0001）\n" +
        "• 📁 选择 = 插入绝对路径（不选则存 output）";
      row1.appendChild(fileWrap);

      const btnOpen = mkBtn("📂 打开", "打开当前保存目录；未选择目录时打开 output 目录");
      row1.appendChild(btnOpen);
      root.appendChild(row1);

      // ---------- 信息窗：输入 / 输出 / 其他 三行 + 状态一行 ----------
      // 🔴 显示信息与状态日志严格分离：打开目录之类的操作日志只写最底部那行，
      //    绝不覆盖上面三行（上一版是直接整块替换信息窗，三行信息一操作就全没了）。
      const infoBox = el("div", "jms-info");
      const lineIn = el("div", "jms-inf-line");
      const lineOut = el("div", "jms-inf-line");
      const lineEtc = el("div", "jms-inf-line");
      // 🔴 重大后端执行报错：后端 save_media 软失败时把异常写进 josia_info.error/error_detail，
      //    这里用红色整块显示，方便用户整窗复制反馈排障（见 updateInfo）。
      const lineErr = el("div", "jms-inf-err");
      lineErr.style.display = "none";
      const lineSt = el("div", "jms-inf-status");
      infoBox.appendChild(lineIn);
      infoBox.appendChild(lineOut);
      infoBox.appendChild(lineEtc);
      infoBox.appendChild(lineErr);
      infoBox.appendChild(lineSt);

      // ---- 信息窗「富文本片段」：片段 = 字符串（纯文本）或 { t, cls }（带样式的小段）----
      // 🔴 信息窗一行现在要能混排多种颜色（如「输出帧率」被改动时整段标黄），但排版仍沿用
      //    原来「标签：内容」的样子 ⇒ 用片段数组表达内容，由 setLine 落成 DOM。
      const RX = (t) => ({ t: String(t ?? "") });
      const RHW = (t) => ({ t: String(t ?? ""), cls: "jms-hi-warn" });   // 醒目黄＝已被改动
      // 把若干「组」用 sep 连接：组 = 片段 | 片段[]；空组自动跳过（不产生连续分隔符）
      function RS(sep, groups) {
        const out = [];
        for (const g of groups) {
          const segs = (Array.isArray(g) ? g : [g])
            .map((s) => (s && typeof s === "object") ? { t: String(s.t ?? ""), cls: s.cls } : RX(s))
            .filter((s) => s.t !== "");
          if (!segs.length) continue;
          if (out.length) out.push(RX(sep));
          out.push(...segs);
        }
        return out;
      }
      // 写一行「标签：内容」；内容为空则整行收起（不留空行）。
      // text 可为字符串，也可为片段数组（见 RS）⇒ 后者支持一行内混排颜色。
      function setLine(elm, label, text) {
        const segs = (Array.isArray(text) ? text : [RX(text)])
          .map((s) => (s && typeof s === "object") ? { t: String(s.t ?? ""), cls: s.cls } : RX(s));
        if (!segs.some((s) => s.t !== "")) { elm.style.display = "none"; elm.textContent = ""; return; }
        elm.style.display = "";
        elm.textContent = "";
        elm.appendChild(el("span", "jms-inf-k", label + "："));
        for (const s of segs) {
          if (s.t === "") continue;
          if (s.cls) elm.appendChild(el("span", s.cls, s.t));
          else elm.appendChild(document.createTextNode(s.t));
        }
      }
      // 🔴 状态行＝工作进度 / 当前操作（打开目录、上传、保存结果、报错…）。
      //    后一条覆盖前一条，永远显示最新；上面三行的显示信息完全不受影响。
      function setStatus(txt, isErr) {
        lineSt.textContent = String(txt ?? "");
        lineSt.classList.toggle("err", !!isErr);
      }

      // ---------- 预览缓存管理 ----------
      // 🔴 官方有**三条互不清理**的预览通道（取证：litegraphService.unsafeUpdatePreviews +
      //    useNodeImage.ts / useImagePreviewWidget.ts）：
      //      ① `video-preview`             —— useNodeVideo 的播放器（canvasOnly DOM widget）
      //      ② `$$canvas-image-preview`    —— 静态图预览（下限 220px）
      //      ③ `$$comfy_animation_preview` —— 动图预览
      //    再叠加我们自己的状态缓存：node.imgs（官方静态图）、node.videos、node.videoContainer。
      //    `node.previewMediaType` 是官方判定「走哪条通道」的开关
      //    （litegraphUtil.isVideoNode = previewMediaType==='video' || !!videoContainer），
      //    它只由 useNodeImage / useNodeVideo 在**构造时**写一次 ⇒ 视频跑过一次后永远是 'video'。
      function removePreviewWidget(name) {
        try {
          const idx = (node.widgets || []).findIndex((w) => w && w.name === name);
          if (idx > -1) {
            const w = node.widgets[idx];
            w.onRemove?.();
            node.widgets.splice(idx, 1);
          }
        } catch (e) { /* 忽略 */ }
      }
      // what: "all"（默认，图像+视频）｜"image"｜"video"
      function clearPreviewCache(what) {
        const image = (!what || what === "all" || what === "image");
        const video = (!what || what === "all" || what === "video");
        if (image) {
          removePreviewWidget("$$canvas-image-preview");
          removePreviewWidget("$$comfy_animation_preview");
        }
        if (video) removePreviewWidget("video-preview");
        try { if (image) { node.imgs = []; node.images = undefined; } } catch (e) { /* 忽略 */ }
        try { if (video) { node.videos = []; node.videoContainer = undefined; } } catch (e) { /* 忽略 */ }
      }

      // 右上角「复制信息窗全部文本」（信息窗文本本身也可鼠标选中后手动复制）
      const btnCopy = el("button", "jms-info-copy", "⧉");
      btnCopy.type = "button";
      btnCopy.title = "复制信息窗全部文本";
      btnCopy.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
      btnCopy.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        const txt = [lineIn, lineOut, lineEtc, lineErr, lineSt]
          .filter((x) => x && String(x.textContent || "").trim())
          .map((x) => String(x.textContent).trim()).join("\n");
        let ok = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(txt);
            ok = true;
          }
        } catch (err) { ok = false; }
        if (!ok) {   // 非安全上下文/无权限时的兜底（127.0.0.1 属安全上下文，通常走不到这里）
          try {
            const ta = document.createElement("textarea");
            ta.value = txt;
            ta.style.position = "fixed"; ta.style.left = "-9999px"; ta.style.top = "0";
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            ok = document.execCommand("copy");
            ta.remove();
          } catch (err2) { ok = false; }
        }
        btnCopy.textContent = ok ? "✓" : "✗";
        setTimeout(() => { btnCopy.textContent = "⧉"; }, 1200);
      });
      infoBox.appendChild(btnCopy);
      root.appendChild(infoBox);

      // 🔴 状态行默认就有内容：「待机中」。
      //    以前刚载入时状态行是空的，信息窗会短一截（只有上面三行），视觉上像缺一块。
      setStatus("待机中");

      // ---------- 行 2：文件格式 + 该分类细项（分类胶囊已上移到行 1）----------
      const row2 = mkRow();

      const imgBox = el("span", "jms-row"); imgBox.style.flex = "1 1 100%"; imgBox.style.gap = "6px";
      // 🔴「不保存图像」恒排最后（新增格式插在它前面）—— 由 sortNoneLast 保证，与后端字典顺序解耦
      const dropImg = mkDrop(node, W["图像格式"], { label: "文件格式",
        items: () => sortNoneLast((comboValues(W["图像格式"], node) || [])
          .map((v) => ((v && typeof v === "object") ? v : { value: String(v), label: String(v) })),
          NONE_IMAGE) });
      // 🔴 自适应节点宽度：文件格式下拉吃本行余宽，
      //    与视频行「视频格式」、行 4「解码方式」同一套做法 ⇒ 一行铺满节点、不留空档。
      dropImg.el.style.flex = "1 1 130px";
      dropImg.el.style.minWidth = "130px";
      const capLossless = mkCapsule(
        [{ label: "无损模式", value: true, tip: "无损模式：像素逐位完全一致（PNG/WebP/TIFF/AVIF/HEIF/JPEG XL/JPEG 2000 有效）" },
         { label: "质量模式", value: false, tip: "质量模式：体积与画质由右侧「质量」决定（不是「图像变劣」，只是改用可按质量调节的编码）" }],
        () => !!W["无损"]?.value,
        (v) => { setWidgetValue(node, W["无损"], v); node._jmsRefresh?.(); });
      capLossless.el.title =
        "无损模式 / 质量模式。\n• 无损模式：像素逐位一致，体积最大、最慢。\n" +
        "• 质量模式：按「质量」编码，体积小得多；质量 100 也仍是有损编码（≠ 无损模式）。\n" +
        "• PNG 恒无损，本开关对它无意义。";
      const numQ = mkNumber(node, W["质量"], { label: "质量", step: 5, width: 42, min: 1, max: 100 });
      numQ.title = "「质量模式」下的画质（越高越好、文件越大）。「无损模式」下此值被忽略。步进 5。";
      const capCompress = mkCapsule(COMPRESS_STEPS,
        () => compressToStep(W["压缩级别"]?.value),
        (v) => { setWidgetValue(node, W["压缩级别"], v); node._jmsRefresh?.(); },
        { label: "压缩级别" });
      capCompress.el.title =
        "PNG/APNG 压缩级别（zlib 0~9），**不影响画质**只影响体积与耗时：\n最快=1｜标准=4（默认）｜最小=9";
      imgBox.appendChild(dropImg.el);
      imgBox.appendChild(capLossless.el);
      imgBox.appendChild(numQ);
      imgBox.appendChild(capCompress.el);

      const vidBox = el("span", "jms-row"); vidBox.style.flex = "1 1 100%"; vidBox.style.gap = "6px";
      // 🔴 动图类型在菜单里明确标记「动图」（GIF/APNG/WebP），与真视频容器区分开；
      //    GIF 排到最后（哥哥要求），「动图WebP」显示名改「WebP（动图）」（值不变，后端契约不动）。
      const VID_ANIM_LABELS = { "GIF": "GIF（动图）", "APNG": "APNG（动图）", "动图WebP": "WebP（动图）" };
      // 🔴 下拉里没有任何「关」：不想落盘就选「不保存视频」（它会撑起「必须落盘 .latent」
      //    的强制规则，不像当年的「关」那样让工作流空转）。老工作流存的「关」由 _jmsSyncTab
      //    自动升级成「不保存视频」，用户看不到、也选不到它。
      const dropVid = mkDrop(node, W["视频容器"], { label: "视频格式",
        items: () => sortNoneLast((comboValues(W["视频容器"], node) || [])
          .map((v) => (v && typeof v === "object") ? v : { value: String(v), label: VID_ANIM_LABELS[String(v)] || String(v) }),
          NONE_VIDEO, "GIF"),
        decorate: (v, l) => ((metaOk.video.size && metaOk.video.has(String(v))) ? "⭐ " : "") + l,
        onChange: (v) => {
          // 记住在视频分类下真正选过的容器；显式选「不保存视频」时打标记，
          // 供切走分类再切回来时判断要不要还原（用户的选择不被偷偷改掉）。
          try {
            node.properties.jms_vid_none = (String(v) === NONE_VIDEO);
          } catch (e) { /* 忽略 */ }
          if (String(v) !== NONE_VIDEO) lastVideoContainer = String(v);
          node._jmsRefresh?.();
        } });
      dropVid.el.title = "由图像批次合成视频 / 动图；接 VIDEO 输入时按此容器转存。\n"
        + "🔴 只有切到「视频」分类时本项才生效 —— 切回「图像」/「音频」分类时视频输出自动暂停"
        + "（图像批次改存逐张静图）。GIF / APNG / WebP（动图）是动图容器（单文件循环播放），"
        + "MP4 / MKV / WebM 是真视频。⭐ = 可写元数据。";
      const dropCodec = mkDrop(node, W["视频编码"], { label: "编码" });
      // 🔴 帧率：最小 0.01、精确到小数点后两位（prec:2，手输 29.97 不会被抹成 30）；
      //    滚轮/箭头动态步进 —— ≥1 步进 1、[0.1,1) 步进 0.1、<0.1 步进 0.01；
      //    正好停在档位边界（1 / 0.1）继续下行走更细一档；手输 29.97 上推→30 / 下推→29 再按 1 续步。
      // 🔴 名称与「输出帧率」成对（哥哥要求：胶囊内文案与信息窗完全一致）：
      //    输入帧率＝源帧的播放帧率；输出帧率＝实际落盘帧率（0＝跟随输入帧率）。
      const numFps = mkNumber(node, W["帧率"], { label: "输入帧率", step: 0.1, prec: 2, width: 46, min: 0.01, max: 1000,
        wstep: (v) => (v >= 1 ? 1 : (v >= 0.1 ? 0.1 : 0.01)) });
      numFps.title =
        "输入帧率 = 源帧（图片 / 视频）按多少帧每秒播放；与右侧「输出帧率」成对。\n" +
        "每秒播放多少张图（＝每张图停留 1/帧率 秒）：\n" +
        "1 ⇒ 每张 1 秒，0.2 ⇒ 每张 5 秒，0.1 ⇒ 每张 10 秒 —— 用图片做幻灯片就调到 1 上下。\n" +
        "最小 0.01，可精确到小数点后两位（如 29.97）。\n" +
        "滚轮 / 上下箭头智能步进：≥1 步进 1 → 1 以下步进 0.1 → 0.1 以下步进 0.01；\n" +
        "手输两位小数（如 29.97）后上推取整到 30、下推取整到 29，再以 1 续步。原生 Save WEBM 默认 24。可从上游连线传入。";
      const numCrf = mkNumber(node, W["视频质量"], { label: "CRF", step: 1, width: 42, min: 0, max: 63 });
      numCrf.title = "画质/体积权衡：越小画质越高、文件越大（Save WEBM 默认 32）。";
      // 🔴「输出帧率」：仅视频/动图容器生效，实际**输出**的播放帧率；0/留空＝跟随「帧率」不转换。
      //    例：图片帧率=1、输出帧率=24 ⇒ 该图复制成 24 帧、合成 1 秒视频；MiniMax 24fps 视频→输出 16/30 改变帧率。
      const numOutFps = mkNumber(node, W["输出帧率"], { label: "输出帧率", step: 0.01, wstep: 1, width: 46, min: 0, max: 1000 });
      numOutFps.title = "实际**输出**时的帧率（播放帧数）。0（默认）＝跟随「帧率」，不转换；\n"
        + "大于 0＝把源帧按此帧率重采样：输出帧数 = 源帧数 × 输出帧率 ÷ 输入帧率。\n"
        + "滚轮 / 上下箭头步进 1；也可直接键入小数（如 0.5）。\n"
        + "轻量化实现＝最近邻复制/抽帧（**不插帧**），秒级完成、不加载任何模型。";
      vidBox.appendChild(dropVid.el);
      vidBox.appendChild(dropCodec.el);
      vidBox.appendChild(numFps);
      vidBox.appendChild(numCrf);
      vidBox.appendChild(numOutFps);
      // 🔴 布局（哥哥要求「胶囊尺寸视觉上舒适」）：视频格式吃本行余宽，其余四颗按**自身内容**量宽：
      //    下拉＝最长候选标签宽；数字控件＝「标签宽 + 输入框可读宽」。
      //    旧版把四颗一律写死 118px ⇒ 「输入帧率」这种 4 字标签被挤、几颗控件宽窄参差；
      //    现在每颗刚好装下自己的内容，且「输入帧率 / 输出帧率」用同一档位数 ⇒ 天然同款等宽。
      dropVid.el.style.flex = "1 1 130px";
      dropVid.el.style.minWidth = "130px";
      // 各数字控件输入框要放下的字符数（帧率要能显示 29.97 两位小数 ⇒ 给 6 位）
      const VID_NUM_CH = new Map([[numFps, 6], [numCrf, 3], [numOutFps, 6]]);
      const VID_SIZED = [dropCodec, numFps, numCrf, numOutFps];
      function sizeVidRowDrops() {
        try {
          for (const d of VID_SIZED) {
            const e2 = d && d.el ? d.el : d;               // mkDrop 传包装对象、mkNumber 直接给 DOM
            if (!e2) continue;
            const isDrop = !!(d && d.items);
            if (isDrop) {
              const btn = e2.querySelector(".jms-drop-btn");
              if (!btn) continue;
              let labels = [];
              try { labels = ((d.items ? d.items() : []) || []).map((it) => String(it?.label ?? it?.value ?? "")); }
              catch (err) { labels = []; }
              const longest = labels.reduce((a, b) => (b.length > a.length ? b : a), "");
              if (!longest) continue;
              const oldTxt = btn.textContent;
              btn.textContent = longest;
              e2.style.width = "auto";
              const w = e2.offsetWidth;
              btn.textContent = oldTxt;
              if (!(w > 0)) continue;          // 本行还不可见（display:none）⇒ 量不到，等下次
              e2.style.width = Math.ceil(w + 2) + "px";
              e2.style.overflow = "hidden";
            } else {
              const inp = e2.querySelector("input");
              if (!inp) continue;
              // 11px 字号下数字的近似字宽；+14px 给输入框自身的内边距与光标
              const want = Math.ceil((VID_NUM_CH.get(e2) || 4) * 7.4) + 14;
              inp.style.flex = "0 0 auto";
              inp.style.minWidth = "0";
              inp.style.width = want + "px";
              e2.style.width = "auto";
              const w = e2.offsetWidth;
              if (!(w > 0)) continue;          // 同上：不可见时不写宽度，避免写成 2px
              e2.style.width = Math.ceil(w + 2) + "px";
            }
          }
        } catch (e) { /* 量宽失败就保持原生自适应，不致命 */ }
      }
      node._jmsSizeVidRow = sizeVidRowDrops;

      const audBox = el("span", "jms-row"); audBox.style.flex = "1 1 100%"; audBox.style.gap = "6px";
      const dropAud = mkDrop(node, W["音频格式"], { label: "音频格式",
        decorate: (v, l) => ((metaOk.audio.size && metaOk.audio.has(String(v))) ? "⭐ " : "") + l,
        items: () => sortNoneLast((comboValues(W["音频格式"], node) || [])
          .map((v) => ((v && typeof v === "object") ? v : { value: String(v), label: String(v) })),
          NONE_AUDIO) });
      dropAud.el.title = "接入音频时按此格式落盘。⭐ = 可写元数据（FLAC/MP3/Opus 支持，WAV 不支持）。";
      // 🔴 固定宽度（哥哥要求：**不随选项自动变化**）：以「⭐ FLAC」的实测宽度为基准 +20% 写死
      //    ⇒ 切到「不保存音频」这类长选项时胶囊不会撑宽、切回也不缩，整行视觉不跳。
      //    隐藏（display:none）时 offsetWidth 为 0 ⇒ 量不到就等切到音频分类时再量（见 refreshInner）。
      let audWidthFixed = false;
      function sizeAudDrop() {
        if (audWidthFixed) return;
        try {
          const btn = dropAud.el.querySelector(".jms-drop-btn");
          if (!btn) return;
          const old = btn.textContent;
          btn.textContent = "⭐ FLAC";
          dropAud.el.style.flex = "0 0 auto";
          dropAud.el.style.width = "auto";
          const w = dropAud.el.offsetWidth;
          btn.textContent = old;
          if (!(w > 0)) return;
          dropAud.el.style.width = Math.ceil(w * 1.2) + "px";
          dropAud.el.style.minWidth = "0";
          dropAud.el.style.overflow = "hidden";
          audWidthFixed = true;
        } catch (e) { /* 量宽失败就保持自适应，不致命 */ }
      }
      node._jmsSizeAudRow = sizeAudDrop;
      const dropAQ = mkDrop(node, W["音频质量"], { label: "音质" });
      dropAQ.el.title = "有损音频码率；FLAC/WAV 为无损，本项灰化显示「无损」。";
      audBox.appendChild(dropAud.el);
      audBox.appendChild(dropAQ.el);

      row2.appendChild(imgBox);
      row2.appendChild(vidBox);
      row2.appendChild(audBox);
      root.appendChild(row2);

      // ---------- 行 4：解码 + 精度 + 分块 ----------
      const row4 = mkRow();
      // 🔴 本行加「紧凑」类：默认节点宽度下六颗胶囊必须落在**同一行**
      //    （只收紧内边距/间距，不改字号、不截断文本 ⇒ 不会出现省略号）。
      row4.classList.add("jms-row4");
      // 🔴 解码方式各选项加 Emoji：**只改显示标签，值一个字母都不动** ——
      //    后端契约、refreshInner 里的 `dec !== \"直接解码\"` 判断全都按原值走。
      const DEC_LABELS = { "自动": "🔄 自动解码", "直接解码": "⚡ 直接解码", "分块解码": "🧩 分块解码" };
      const dropDec = mkDrop(node, W["解码方式"], { label: "解码方式",
        items: () => (comboValues(W["解码方式"], node) || []).map((v) => {
          const val = (v && typeof v === "object") ? v.value : v;
          return { value: val, label: DEC_LABELS[String(val)] || String(val) };
        }) });
      // 🔴 自适应节点宽度（哥哥要求）：本行只让「解码方式」吃余宽（flex-grow），
      //    和视频行的「视频格式」同一套做法 ⇒ 一行正好铺满节点，不换行也不留难看的空档；
      //    它的最小宽度由实测内容（最长选项含 Emoji）锁定 ⇒ 再窄也不会把文字挤成省略号。
      dropDec.el.style.flex = "1 1 auto";
      dropDec.el.style.minWidth = "0";
      dropDec.el.title =
        "自动 = 先直接解码，显存不足（OOM）时自动改分块重试。\n直接解码 = 一次性解完（最快最吃显存）。\n分块解码 = 切块逐块解（省显存）。\n选「自动/分块解码」时下方分块设置生效；「直接解码」时隐藏。";
      row4.appendChild(dropDec.el);
      const dropPrec = mkDrop(node, W["解码精度"], { label: "解码精度" });
      dropPrec.el.title = "强制 VAE 解码精度，专治黑图 / 雪花屏。fp32 最稳但最吃显存。";
      row4.appendChild(dropPrec.el);

      const mkTileDrop = (name, label, tip) => {
        const d = mkDrop(node, W[name], { label });
        d.el.title = tip;
        return d;
      };
      const dropTile = mkTileDrop("分块尺寸", "分块大小",
        "分块边长（像素）。大图切块逐块解码降低显存峰值。8G 显存建议 512；6G 建议 256~384。");
      const dropOverlap = mkTileDrop("分块重叠", "空间重叠",
        "相邻块之间的重叠像素，消除拼接接缝。默认 64；有接缝纹理再调到 128。");
      const dropTStep = mkTileDrop("时间分块", "解码批次",
        "仅视频 VAE：一次解码多少帧（原生默认 64）。");
      const dropTOverlap = mkTileDrop("时间重叠", "帧间重叠",
        "仅视频 VAE：帧间重叠帧数，消除时间方向闪烁/接缝（原生默认 8）。");
      row4.appendChild(dropTile.el);
      row4.appendChild(dropOverlap.el);
      row4.appendChild(dropTStep.el);
      row4.appendChild(dropTOverlap.el);
      root.appendChild(row4);

      // 🔴 分块行六颗胶囊**按各自最长选项 + 1 字位**定宽（哥哥要求：不再统一等宽，
      //    也不随当前选中值伸缩 —— 全行取最宽会让短选项的容器显得很空）。
      //    做法：临时把值文本换成该下拉自己的最长选项 → 量自然宽度 → 还原 →
      //    再加一个「0」字形宽（按按钮字体现量，fp32 / 2048 这类内容最自然）。
      //    必须在挂进 DOM 并布局完成之后量（offsetWidth），所以放 init 的 rAF + 兜底延时里跑。
      // 🔴 分块行六颗胶囊**压到最短、且绝不截断文本**（哥哥要求：默认宽度下不许换行）。
      //    做法：把每颗胶囊的按钮文本临时换成「自己最长的那条候选标签」→ 量自然宽 → 还原 →
      //    定死这个宽度（只 +2px 的取整余量，**不再留「1 字位」** —— 那 6×1 字位正是把这一行
      //    顶成两行的元凶之一）。
      //    候选标签必须走该下拉自己的 items（而不是 comboValues）：解码方式带 Emoji、
      //    视频/音频带 ⭐ 前缀，这些 decorate 结果才是真正要显示的文本，按原值量会量偏。
      //    「解码方式」＝自适应那一颗：只锁定 minWidth（下限＝内容宽），宽度交给 flex-grow 吃余宽。
      const ROW4_DROPS = [["解码方式", dropDec], ["解码精度", dropPrec], ["分块尺寸", dropTile],
        ["分块重叠", dropOverlap], ["时间分块", dropTStep], ["时间重叠", dropTOverlap]];
      const ROW4_GROW = "解码方式";
      function sizeRow4Drops() {
        try {
          for (const [nm, d] of ROW4_DROPS) {
            const e2 = d && d.el; if (!e2) continue;
            const btn = e2.querySelector(".jms-drop-btn"); if (!btn) continue;
            let labels = [];
            try { labels = ((d.items ? d.items() : []) || []).map((it) => String(it?.label ?? it?.value ?? "")); }
            catch (err) { labels = []; }
            if (!labels.length) {
              labels = (comboValues(W[nm], node) || [])
                .map((v) => (v && typeof v === "object") ? String(v.label ?? v.value ?? "") : String(v ?? ""));
            }
            const longest = labels.reduce((a, b) => (b.length > a.length ? b : a), "");
            if (!longest) continue;
            const isGrow = (nm === ROW4_GROW);
            const oldFlex = e2.style.flex;
            // 量「内容宽」时必须先关掉伸缩，否则量到的是被 flex-grow 撑大后的宽度（会把下限定大 ⇒ 反而换行）
            if (isGrow) e2.style.flex = "0 0 auto";
            const oldTxt = btn.textContent;
            btn.textContent = longest;
            e2.style.width = "auto";
            const w = e2.offsetWidth;
            btn.textContent = oldTxt;
            const need = Math.ceil(w + 2);
            if (isGrow) {
              e2.style.flex = oldFlex;
              e2.style.minWidth = need + "px";
            } else {
              e2.style.width = need + "px";
              e2.style.overflow = "hidden";
            }
          }
        } catch (e) { /* 量宽失败就保持原生自适应，不致命 */ }
      }
      node._jmsSizeRow4 = sizeRow4Drops;

      // ---------- 行 5：VAE1 / VAE2 同一行，两者等分共同撑满节点宽度，常驻 ----------
      const rowVAE = mkRow();
      const dropV1 = mkDrop(node, W["VAE1"], {
        label: "VAE1",
        // 无 Josia 模型加载节点时，下拉里去掉「使用Josia模型加载VAE」这一项
        items: () => {
          const all = comboValues(W["VAE1"], node) || [];
          const josia = josiaVaePresent();
          if (josia) return all;
          return all.filter((v) => {
            const value = (v && typeof v === "object") ? v.value : v;
            return value !== USE_JOSIA_VAE;
          });
        },
      });
      dropV1.el.title =
        "解码主 VAE。\n• 「使用Josia模型加载VAE」= 复用「Josia模型加载」节点载入的 VAE，无需连线（检测到该节点时自动选中一次）。\n" +
        "• 也可手动选 models/vae 里的模型。\n• 给「Video_VAE」端口接线后本项自动灰化（接线优先）。";
      // 🔴 同一行等分撑满：flex 基准 220px（够放下「使用Josia模型加载VAE」整串，不再挤成省略号）。
      //    两个下拉基准和 > 行宽时，.jms-row 的 flex-wrap 会把它们分到两行，各自撑满。
      dropV1.el.style.flex = "1 1 220px";
      dropV1.el.style.minWidth = "0";
      rowVAE.appendChild(dropV1.el);

      const dropV2 = mkDrop(node, W["VAE2"], { label: "VAE2" });
      dropV2.el.title =
        "解码**音频路**潜空间用的 VAE（LTX / MiniMax H3 等双 VAE）。\n" +
        "• 「🎵 请选择模型…」= 不使用音频 VAE。\n• 想同时保存音频时，在这里选模型，或直接给「Audio_VAE」端口接线（接线后本项灰化）。\n" +
        "• 也可手动选 models/vae 里的模型。";
      dropV2.el.style.flex = "1 1 220px";
      dropV2.el.style.minWidth = "0";
      rowVAE.appendChild(dropV2.el);
      root.appendChild(rowVAE);

      // ---------- 行 6：底栏（清理缓存长条胶囊 + 元数据 + 保存Latent）----------
      const row6 = mkRow();
      const longCap = el("div", "jms-capsule");
      longCap.appendChild(el("span", "jms-cap-label", "清理缓存"));
      const capClean = mkCapsule(
        [{ label: "关闭", value: "关" }, { label: "轻度", value: "轻度" }, { label: "深度", value: "深度" }],
        () => String(W["清理缓存"]?.value ?? "关"),
        (v) => { setWidgetValue(node, W["清理缓存"], v); node._jmsRefresh?.(); },
        { cls: "jms-cap-inner" });
      capClean.el.title = "只回收无引用张量与 CUDA 空闲块，绝不卸载已加载模型，热启动不降速。";
      const div1 = el("span", "jms-lc-div");
      const capWhen = mkCapsule(
        [{ label: "解码前执行", value: "解码前" }, { label: "解码后执行", value: "解码后" }],
        () => String(W["清理时机"]?.value ?? "解码前"),
        (v) => { setWidgetValue(node, W["清理时机"], v); node._jmsRefresh?.(); },
        { cls: "jms-cap-inner" });
      capWhen.el.title = "解码前清理降低解码峰值显存；解码后清理为下次运行腾空间。";
      longCap.appendChild(capClean.el);
      longCap.appendChild(div1);
      longCap.appendChild(capWhen.el);
      row6.appendChild(longCap);

      const dotMeta = mkDotSwitch(node, W["写入元数据"],
        { onText: "保存元数据", offText: "丢弃元数据" });
      dotMeta.el.title = "把 prompt / workflow 写进文件（PNG 私有块 / 其它格式 EXIF 或容器元数据）。不支持的格式自动隐藏本开关。";
      const dotLatent = mkDotSwitch(node, W["保存潜空间"],
        { onText: "保存Latent", offText: "不存Latent" });
      dotLatent.el.title =
        "开启＝额外把潜空间另存一份 .latent 原始张量文件（与原生 Save Latent 同格式）到输出目录。\n" +
        "• 只是「多存一个本地文件」，与下游的 Latent 输出端口无关。\n" +
        "• 「Video Latent / Audio Latent」输出端口是把混合的 AV Latent 拆成单独两路输出，和本开关是两回事。";
      // 🔴 锁定态「保存Latent」胶囊：选中「不保存图像 / 不保存视频 / 不保存音频」时，
      //    用它**替换**真开关胶囊（真胶囊的 widget 值原封不动 ⇒ 取消「不保存」后自动恢复
      //    用户原先的开启/关闭状态）。外观与开关一致、恒显示开启、不可点击、不灰化
      //    （灰化会被误读成「关闭」），悬浮提示说明被强制开启的原因。
      const dotLatentLock = (() => {
        const wrap = el("div", "jms-dot");
        const txt = el("span", "jms-dot-txt");
        const mark = el("span", "jms-dot-mark");
        wrap.appendChild(txt);
        wrap.appendChild(mark);
        wrap.classList.add("on");
        txt.textContent = "🔒 落盘 .latent";
        wrap.title =
          "已选中「不保存」—— 本节点必须留下产物，否则工作流接入本节点等于空转。\n" +
          "因此保存Latent 被强制开启且不可关闭；选回其它格式后，会恢复你原来的开关状态。";
        return { el: wrap, sync() {} };
      })();
      row6.appendChild(dotMeta.el);
      row6.appendChild(dotLatent.el);
      row6.appendChild(dotLatentLock.el);

      // 🔴 「恢复默认」（哥哥要求）：一键把**所有**参数拉回「刚载入节点时的默认值」，并释放
      //    预览缓存 —— 参数被调乱时不用逐个回忆默认值；预览窗错乱时等于做一次软复位。
      //    默认值取自 widget.options.default（＝后端 INPUT_TYPES 里那一份，与新建节点完全一致），
      //    不在这里硬编码常量 ⇒ 后端改默认值时此处自动跟随。
      function resetAllDefaults() {
        try {
          for (const name of Object.keys(W)) {
            const w = W[name];
            if (!w || !w.options) continue;
            if (!Object.prototype.hasOwnProperty.call(w.options, "default")) continue;
            setWidgetValue(node, w, w.options.default);
            // 顺带触发原生 widget 自己的回调：有些控件靠它刷新内部状态
            try { w.callback?.(w.value); } catch (e2) { /* 忽略 */ }
          }
        } catch (e) { /* 单个控件失败不影响其余 */ }
        // 分类回到「图像」；非视频分类必须停在「不保存视频」（既定规则）
        try {
          tab = "image";
          try { node.properties.jms_tab = tab; } catch (e2) { /* 忽略 */ }
          setWidgetValue(node, W["视频容器"], NONE_VIDEO);
          lastVideoContainer = null;                       // 记忆一并清空，回到出厂默认
          try { node.properties.jms_vid_none = false; } catch (e2) { /* 忽略 */ }
        } catch (e) { /* 忽略 */ }
        // 释放预览缓存 + 预览通道状态（治偶发的预览窗错乱 / 旧播放器残留）
        try { clearPreviewCache("all"); } catch (e) { /* 忽略 */ }
        try {
          node.previewMediaType = undefined;
          node.animatedImages = false;
          node.imageIndex = null;
          node.preview = undefined;
        } catch (e) { /* 忽略 */ }
        // 信息窗回到「刚载入」的观感
        prevQ = undefined;
        hasRun = false;
        lastRun = null;
        _fitFail = 0;
        setStatus("♻️ 已恢复默认参数，并释放预览缓存");
        try { node._jmsSizeRow4?.(); node._jmsSizeVidRow?.(); } catch (e) { /* 忽略 */ }
        refresh();
        applyLayout();
        try { node.setDirtyCanvas?.(true, true); } catch (e) { /* 忽略 */ }
      }
      // 🔴「恢复默认」：点击不立即执行，而是**原地变形**——外框深灰大胶囊内露出
      //    「确认(红)/取消(蓝)」两颗小胶囊 + 中间竖线（风格仿「清理缓存」长条）。
      //    每颗小胶囊内部有铺满的 thumb 色块（仿清理缓存选中项的色块），文字垂直居中。
      //    确认才真的复位，取消则还原——避免误触把调好的参数一次性清掉。
      const btnReset = el("button", "jms-btn jms-btn-reset");
      btnReset.type = "button";
      btnReset.title =
        "把所有参数恢复为默认值（＝刚载入节点时的样子），并释放预览缓存。\n" +
        "点击后会变成「确认 / 取消」两枚小胶囊：确认才真正执行，取消则还原，避免误触。";
      const resetLab = el("span", "jms-reset-lab", "♻️ 恢复默认");
      const resetConfirm = el("span", "jms-reset-cap jms-reset-confirm");
      resetConfirm.appendChild(el("span", "jms-reset-thumb"));
      resetConfirm.appendChild(el("span", "jms-reset-txt", "确认"));
      const resetCancel = el("span", "jms-reset-cap jms-reset-cancel");
      resetCancel.appendChild(el("span", "jms-reset-thumb"));
      resetCancel.appendChild(el("span", "jms-reset-txt", "取消"));
      const resetDiv = el("span", "jms-lc-div jms-reset-div");
      btnReset.appendChild(resetLab);
      btnReset.appendChild(resetConfirm);
      btnReset.appendChild(resetDiv);
      btnReset.appendChild(resetCancel);

      let resetArmed = false;
      function armReset() { resetArmed = true; btnReset.classList.add("armed"); }
      function disarmReset() { resetArmed = false; btnReset.classList.remove("armed"); }
      btnReset.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!resetArmed) { armReset(); return; }   // 第一次点：进入确认/取消
        disarmReset();                              // 已武装：点大胶囊空白处＝取消
      });
      resetConfirm.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!resetArmed) return;
        disarmReset();
        resetAllDefaults();
      });
      resetCancel.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!resetArmed) return;
        disarmReset();
      });
      row6.appendChild(btnReset);
      root.appendChild(row6);

      /* ======================= 联动显隐 ======================= */
      // （metaOk 已提前到面板构建前的状态声明区 —— decorate 闭包在此处声明前就会被调用）
      // 🔴 分类「图像 / 视频 / 音频」＝输出模式的唯一真源，且随工作流存进 node.properties。
      //    以前 tab 不落盘 ⇒ 用「视频」分类留下的 MP4 在工作流重载后没人重置，
      //    图像分类保存多图批次照样出视频（用户报的「居然生成了 mp4」）。
      const TAB_VALUES = TABS.map((t) => t.value);
      let tab = TAB_VALUES.includes(String(node.properties?.jms_tab))
        ? String(node.properties.jms_tab) : "image";
      let prevTab = null;
      // 记住用户上一次真正选过的视频容器：切走分类时会被置成「不保存视频」，
      // 切回来时用它还原，避免「切回视频分类却停在不保存、还得重新挑一遍容器」。
      let lastVideoContainer = null;

      async function loadMetaTables() {
        try {
          const resp = await api.fetchApi("/josia_media_save/formats");
          const data = await resp.json();
          for (const it of (data.images || [])) {
            if (it.meta) metaOk.image.add(it.label);
            // 扩展名表：信息窗「预测文件名」要拼 .png / .jpg 这种后缀（去掉 ⭐ 前缀两种键都存）
            if (it.ext) {
              extMap[String(it.label)] = it.ext;
              extMap[String(it.label).replace(/^[⭐\s]+/, "")] = it.ext;
            }
          }
          for (const it of (data.videos || [])) if (it.meta) metaOk.video.add(it.label);
          for (const it of (data.audios || [])) if (it.meta) metaOk.audio.add(it.label);
        } catch (e) { /* 取不到就退化成「都显示」 */ }
        refresh();
      }

      function currentFormat() {
        if (tab === "video") return String(W["视频容器"]?.value ?? NONE_VIDEO);
        if (tab === "audio") return String(W["音频格式"]?.value ?? NONE_AUDIO);
        return String(W["图像格式"]?.value ?? "");
      }
      function metaSupported() {
        const f = currentFormat();
        // 「不保存X」不落盘 ⇒ 谈不上写元数据
        if (f === NONE_IMAGE || f === NONE_VIDEO || f === NONE_AUDIO) return false;
        if (tab === "video") return metaOk.video.size ? metaOk.video.has(f) : (f !== NONE_VIDEO && f !== "关" && f !== "GIF");
        if (tab === "audio") return metaOk.audio.size ? metaOk.audio.has(f) : (f !== NONE_AUDIO && f !== "关");
        return metaOk.image.size ? metaOk.image.has(f) : true;
      }

      // 识别 Josia 模型加载节点：检测到则一次性自动切 VAE1 到「使用Josia模型加载VAE」；
      // 节点消失则去掉该选项并把已选中的降级为占位符。
      // 🔴 判定＝「图里有该节点」或「注册表里已有 VAE」（见 josiaVaePresent），与创建先后无关。
      // VAE2 的候选里有没有「使用Josia模型加载VAE」这一项（后端 _vae2_choices 决定）
      function vae2HasJosiaOption() {
        try {
          const vals = comboValues(W["VAE2"], node) || [];
          return vals.length ? vals.indexOf(USE_JOSIA_VAE) >= 0 : true;
        } catch (e) { return true; }
      }
      function syncJosiaVae() {
        const josiaPresent = josiaVaePresent();
        const v1 = String(W["VAE1"]?.value ?? "");
        const v2 = String(W["VAE2"]?.value ?? "");
        if (josiaPresent) {
          if (v1 === VAE1_PLACEHOLDER) setWidgetValue(node, W["VAE1"], USE_JOSIA_VAE);
          // 🔴 VAE2 跟随 VAE1 一起切到共享 VAE（哥哥明确要求）——
          //    以前只切 VAE1，VAE2 一直停在占位符上，看着像「只有 VAE1 联动」。
          if (v2 === PLACEHOLDER_VAE2 && vae2HasJosiaOption()) {
            setWidgetValue(node, W["VAE2"], USE_JOSIA_VAE);
          }
          _jmsJosiaAutoDone = true;
        } else {
          if (v1 === USE_JOSIA_VAE) setWidgetValue(node, W["VAE1"], VAE1_PLACEHOLDER);
          if (v2 === USE_JOSIA_VAE) setWidgetValue(node, W["VAE2"], PLACEHOLDER_VAE2);
          _jmsJosiaAutoDone = false;
        }
      }

      function refreshInner() {
        const fmt = String(W["图像格式"]?.value ?? "");
        const lossless = !!W["无损"]?.value;
        // 🔴 视频分类下「视频容器」不会停在空值：老工作流遗留的「关」自动落到 MP4，
        //    用户主动选的「不保存视频」则原样保留（不能偷偷替用户改掉选择）。
        if (tab === "video" && String(W["视频容器"]?.value ?? NONE_VIDEO) === "关") {
          setWidgetValue(node, W["视频容器"], "MP4");
        }
        const vid = String(W["视频容器"]?.value ?? NONE_VIDEO);
        const aud = String(W["音频格式"]?.value ?? NONE_AUDIO);
        const dec = String(W["解码方式"]?.value ?? "自动");
        const v1 = String(W["VAE1"]?.value ?? "");
        const v2 = String(W["VAE2"]?.value ?? "");
        const isAV = AV_CONTAINERS.includes(vid);

        // tab 行显隐
        imgBox.style.display = tab === "image" ? "inline-flex" : "none";
        vidBox.style.display = tab === "video" ? "inline-flex" : "none";
        audBox.style.display = tab === "audio" ? "inline-flex" : "none";
        // 🔴 视频行刚被显示出来 ⇒ 立刻量一次宽度：隐藏（display:none）时 offsetWidth 恒为 0，
        //    量不到就不能定宽；改成可见后读 offsetWidth 会强制同步布局，这里能拿到真实宽度。
        if (tab === "video") { try { node._jmsSizeVidRow?.(); } catch (e) { /* 忽略 */ } }
        // 音频下拉刚显示出来 ⇒ 立刻量一次固定宽度（隐藏时 offsetWidth 为 0，量不到）
        if (tab === "audio") { try { node._jmsSizeAudRow?.(); } catch (e) { /* 忽略 */ } }

        // 图像细项：🔴 **一律常驻显示**，不支持的项只灰化禁用（隐藏会让本行胶囊宽度突变，
        //    切格式时整行突然跳一下 —— 哥哥明确要求尺寸恒定、不要视觉割裂）。
        capLossless.el.style.display = "inline-flex";
        capCompress.el.style.display = "inline-flex";
        const fmtBase = fmt.replace(/^⭐\s*/, "").trim();
        const alwaysLossless = ALWAYS_LOSSLESS.has(fmtBase);
        const imgNone = fmt === NONE_IMAGE;
        if (alwaysLossless) {
          // 记住切走前的真实质量值，切回普通格式时还原；再把控件固定到 100。
          if (W["质量"] && W["质量"].value !== 100) prevQ = W["质量"].value;
          if (W["质量"]) W["质量"].value = 100;
          numQ._input.value = "100";
        } else {
          // 普通（有损）格式：若之前被绝对无损格式改成 100，这里还原到记忆值。
          if (W["质量"] && prevQ !== undefined && W["质量"].value === 100) {
            W["质量"].value = prevQ;
          }
          numQ._input.value = String(W["质量"]?.value ?? numQ._input.value);
        }
        grayCtl(capLossless, imgNone || alwaysLossless || !LOSSLESS_CAPABLE.test(fmt),
          imgNone ? "已选「不保存图像」—— 不落盘图像，本项无意义。"
            : (alwaysLossless ? `${fmtBase} 恒为无损，本开关无意义。`
              : `${fmtBase} 不支持无损编码，本开关无意义。`));
        grayCtl(numQ, imgNone || alwaysLossless || (LOSSLESS_CAPABLE.test(fmt) && lossless),
          imgNone ? "已选「不保存图像」—— 不落盘图像，本项无意义。"
            : (alwaysLossless ? `${fmtBase} 恒为无损，质量固定 100。`
              : "当前处于「无损模式」，质量由无损编码决定。"));
        grayCtl(capCompress, imgNone || !PNGISH.test(fmt),
          imgNone ? "已选「不保存图像」—— 不落盘图像，本项无意义。"
            : `${fmtBase} 不走 PNG 压缩，本项无意义。`);
        // 🔴 无损模式下**绝不能**把输入框的值改写成 100（那是改显示、不改 widget 值，
        //    会造成「节点显示 100 / 信息窗读到 90」的错位）—— 现在统一只灰化禁用。

        // 视频细项：常驻显示、不适用则灰化（编码 / CRF 只对真视频容器有意义；输出帧率动图也吃）
        const vidNone = vid === NONE_VIDEO;
        grayCtl(dropCodec, vidNone || !isAV,
          vidNone ? "已选「不保存视频」—— 不落盘视频，本项无意义。"
            : "GIF / APNG / 动图WebP 是动图容器，没有视频编码器可选。");
        grayCtl(numCrf, vidNone || !isAV,
          vidNone ? "已选「不保存视频」—— 不落盘视频，本项无意义。"
            : "动图容器不用 CRF（画质由调色板 / 无损决定）。");
        grayCtl(numOutFps, vidNone, "已选「不保存视频」—— 不落盘视频，本项无意义。");

        // 音频音质：常驻显示；无损格式 / 不落盘音频 ⇒ 灰化（保留「无损」字样）
        const audLossless = AUDIO_LOSSLESS.has(aud);
        const audOff = aud === NONE_AUDIO || aud === "关";   // 「关」＝老工作流遗留值
        if (audLossless) dropAQ.btn.textContent = "无损";
        grayCtl(dropAQ, audOff || audLossless,
          audOff ? "已选「不保存音频」—— 不落盘音频，本项无意义。"
            : `${aud} 是无损格式，码率对它没有意义 —— 所以这一项灰化。`);

        // 分块参数显隐（哥哥更正）：**一律显示、不再隐藏**（隐藏会把「解码方式」胶囊拉长），
        // 仅「直接解码」时灰化禁用（它不使用分块）；「自动」「分块解码」正常可交互。
        const grayTile = (dec === "直接解码");
        for (const d of [dropTile, dropOverlap, dropTStep, dropTOverlap]) {
          if (d.el.dataset.jmsTitle === undefined) d.el.dataset.jmsTitle = d.el.title || "";
          d.el.style.display = "inline-flex";
          d.el.classList.toggle("disabled", grayTile);
          d.el.title = grayTile
            ? "「直接解码」不使用分块，分块参数灰化不可调。"
            : d.el.dataset.jmsTitle;
        }

        // 元数据圆点：常驻显示，不支持则灰化（隐藏会让底栏宽度跳一下）
        grayCtl(dotMeta, !metaSupported(), "当前格式不支持写入工作流元数据 —— 本开关灰化。");

        // 🔴「不保存图像 / 不保存视频 / 不保存音频」⇒ 保存Latent 强制开启：
        //    用锁定胶囊**替换**真开关胶囊（真胶囊的 widget 值一个字节都不动 ⇒
        //    取消「不保存」后自动恢复用户原来的开启/关闭状态）。
        const latentLocked = (tab === "image" && fmt === NONE_IMAGE)
          || (tab === "video" && vid === NONE_VIDEO)
          || (tab === "audio" && aud === NONE_AUDIO);
        dotLatent.el.style.display = latentLocked ? "none" : "inline-flex";
        dotLatentLock.el.style.display = latentLocked ? "inline-flex" : "none";

        // 预览/保存：预览时灰化文件名前缀 + 选目录
        const preview = !!W["临时预览"]?.value;
        fileWrap._input.disabled = preview;
        fileWrap.style.opacity = preview ? ".5" : "1";
        btnPick.disabled = preview;

        // VAE 下拉：Josia 模型加载节点检测（自动切换 / 移除清理）—— 必须在 sync 前跑
        syncJosiaVae();

        // VAE 下拉灰化（接了线以接线为准）
        const vaeWired = hasWired("Video_VAE");
        const vae2Wired = hasWired("Audio_VAE");
        dropV1.el.style.opacity = vaeWired ? ".45" : "1";
        dropV1.el.style.pointerEvents = vaeWired ? "none" : "auto";
        dropV2.el.style.opacity = vae2Wired ? ".45" : "1";
        dropV2.el.style.pointerEvents = vae2Wired ? "none" : "auto";
        dropV1.el.title = vaeWired ? "已接入「Video_VAE」端口 —— 以接线为准，本项灰化。" : dropV1.el.title;

        // VAE1 / VAE2 都常驻显示；等分宽度已在构建时设好（flex:1 1 0），此处不再改 flex。

      }

      // 同步所有下拉 + 胶囊（独立一段，单个控件抛错不拖累整段）
      function syncAll() {
        [dropImg, dropVid, dropAud, dropCodec, dropAQ, dropDec, dropPrec,
         dropTile, dropOverlap, dropTStep, dropTOverlap, dropV1, dropV2].forEach((d) => {
          try { d && d.sync && d.sync(); } catch (e) { /* 忽略单个控件 */ }
        });
        try { capTab.sync(); } catch (e) {}
        try { capLossless.sync(); } catch (e) {}
        try { capCompress.sync(); } catch (e) {}
        try { capClean.sync(); } catch (e) {}
        try { capWhen.sync(); } catch (e) {}
        try { dotMeta.sync(); } catch (e) {}
        try { dotLatent.sync(); } catch (e) {}
      }

      // 🔴 面板异常＝**开发期诊断信息**，不该把整段堆栈糊在信息窗里（用户看不懂、又长又占地方），
      //    所以状态行只留一句短提示，完整堆栈走 console.error（F12 可见）。
      function showPanelError(stage, err) {
        try {
          setStatus("⚠️ 面板「" + stage + "」刷新异常（F12 控制台看详情）", true);
        } catch (e2) { /* 状态行都写不了就放弃 */ }
        try { console.error("[Josia媒体保存] " + stage + " 刷新异常：", err); } catch (e3) {}
      }

      // 🔴 分三段独立刷新：任一段抛错都只影响自己、其它段照常、且错误可见。
      //   此前是「refreshInner 一抛就整段中断」—— 显隐阶段一旦出错，下面的同步与信息窗全都不会跑，
      //   表现就是「信息窗空白 + 下拉无值且像死了一样」。现在三段互不拖累。
      function refresh() {
        try { refreshInner(); } catch (err) { showPanelError("显隐联动", err); }
        try { syncAll(); } catch (err) { showPanelError("控件同步", err); }
        try { updateInfo(); } catch (err) { showPanelError("信息窗", err); }
        try { applyLayout(); } catch (err) { showPanelError("布局", err); }
        // 第五段：出图后官方会把预览图挂上来 ⇒ 顺手再禁一次原生图片拖拽
        //（声明是函数声明 ⇒ 已提升，这里调用不会踩 TDZ）
        try { killImgDrag(); } catch (err) { /* 忽略 */ }
      }
      node._jmsRefresh = refresh;
      // 供 onConfigure 复用：把「分类」恢复成工作流里保存的那一个，
      // 并保证「非视频分类 ⇒ 视频格式=关」（旧工作流里遗留的 MP4 在这里被清掉）。
      node._jmsSyncTab = (v) => {
        tab = TAB_VALUES.includes(String(v)) ? String(v) : "image";
        // 🔴 老工作流里存的「关」已被「不保存X」取代，这里一次性升级：
        //    视频分类下沿用它当年对等的落盘行为（落到 MP4），其余分类升级为「不保存视频」；
        //    音频一律升级为「不保存音频」（不落盘音频 ⇒ 自动强制落盘 .latent）。
        const _v0 = String(W["视频容器"]?.value ?? NONE_VIDEO);
        const _a0 = String(W["音频格式"]?.value ?? NONE_AUDIO);
        if (_v0 === "关") {
          setWidgetValue(node, W["视频容器"], tab === "video" ? DEF_VIDEO : NONE_VIDEO);
        }
        if (_a0 === "关") setWidgetValue(node, W["音频格式"], NONE_AUDIO);
        // 🔴 离开视频分类 ⇒ 视频输出暂停（置「不保存视频」），但已在「不保存视频」的原样保留
        //    （那正是用户自己的选择，不能偷偷改回别的值）。
        const _v = String(W["视频容器"]?.value ?? NONE_VIDEO);
        if (tab !== "video" && _v !== NONE_VIDEO) {
          setWidgetValue(node, W["视频容器"], NONE_VIDEO);
        }
      };

      function hasWired(inputName) {
        try {
          const inp = node.inputs?.find((i) => i.name === inputName);
          return !!(inp && inp.link != null);
        } catch (e) { return false; }
      }

      vaeShared = null;
      async function loadVaeState() {
        try {
          const resp = await api.fetchApi("/josia_media_save/vae_list");
          const data = await resp.json();
          vaeShared = data.registry || null;
        } catch (e) { vaeShared = null; }
        refresh();
      }

      // 🔴 信息窗内容＝三行「显示信息」，不罗列各控件的当前值（那些值控件上已经写着）。
      //    输入：这次接进来了什么 + （运行后的）实际画面尺寸
      //    输出：输出目录 ｜ 预测文件名（%0000% 占位）/ 运行后的真实文件名 ｜ 该分类的重要设置
      //    其他：只有运行期才知道的杂项（分辨率 / 耗时 / 落盘位置）
      const clean = (val) => String(val ?? "").replace(/^[⭐\s]+/, "");
      const WIRED_NAMES = ["图像", "Latent", "视频", "音频"];
      // 视频容器 / 音频格式 → 扩展名（图像格式用后端 /formats 给的 extMap，不重复硬编码）
      const VIDEO_EXT = { "MP4": "mp4", "WebM": "webm", "MKV": "mkv", "GIF": "gif", "APNG": "png", "动图WebP": "webp" };
      const AUDIO_EXT = { "MP3": "mp3", "FLAC": "flac", "WAV": "wav", "Opus": "opus" };

      // 运行后的真实画面尺寸：官方出图会把 node.imgs 挂到画布预览上（HTMLImageElement）
      function shapeText() {
        try {
          const arr = node.imgs || [];
          const im = arr[0];
          const w = Number(im && (im.naturalWidth || im.width)) || 0;
          const h = Number(im && (im.naturalHeight || im.height)) || 0;
          if (w > 0 && h > 0) return w + "×" + h + (arr.length > 1 ? "（共 " + arr.length + " 张）" : "");
        } catch (e) { /* 忽略 */ }
        return "";
      }

      function inputInfoText() {
        if (lastRun && lastRun.inputs && lastRun.inputs.length) return lastRun.inputs.join(" ＋ ");
        const wired = WIRED_NAMES.filter((n) => hasWired(n));
        if (!wired.length) return "未接入（等待上游连线）";
        const sh = shapeText();
        if (sh) return wired.join(" ＋ ") + "　" + sh;
        // 🔴 不再写「形态待运行确认」这种看不懂的措辞
        return wired.join(" ＋ ") + (hasRun ? "（已运行）" : "（尺寸待运行后显示）");
      }

      // 预测文件名：沿用「文本保存」节点的通配符写法，序号用 %0000% 占位。
      // 🔴 用户不写通配符时，默认＝「前缀 + _ + 4 位序号」，序号后面**不再**补下划线。
      const COUNTER_WILD = /%([0-9]+)%/;
      function stemPreview() {
        const cur = String(W["filename_prefix"]?.value ?? "");
        const base = String(cur.split(/[\\/]/).pop() || DEFAULT_NAME);
        const m = base.match(COUNTER_WILD);
        if (!m) return base + "_%0000%";
        return base.slice(0, m.index) + "%" + "0".repeat(m[1].length) + "%" + base.slice(m.index + m[0].length);
      }
      function extOfFormat() {
        const f = clean(currentFormat());
        if (!f) return "";
        // 老工作流遗留的「关」＝不落盘 ⇒ 与「不保存X」同解
        if (f === "关") return "latent";
        // 「不保存X」：该路不落盘 ⇒ 信息窗显示 latent（唯一的产物是潜空间文件）
        if (f === NONE_IMAGE || f === NONE_VIDEO || f === NONE_AUDIO) return "latent";
        if (tab === "image") return extMap[f] || "";
        if (tab === "video") return VIDEO_EXT[f] || f.toLowerCase();
        return AUDIO_EXT[f] || f.toLowerCase();
      }
      // 该分类的「重要设置」摘要（图像＝质量/压缩级别；视频＝编码/帧率/CRF；音频＝音质）
      function formatDetail() {
        try {
          const f = clean(currentFormat());
          if (!f || f === "关") return "";
          // 🔴「不保存X」：该路不落盘，唯一产物就是潜空间文件，质量/编码对它无意义
          //    ⇒ 不显示「质量 90」这种误导信息，改为明确说明仅落盘无损潜空间（哥哥要求）。
          if (f === NONE_IMAGE || f === NONE_VIDEO || f === NONE_AUDIO) return "仅保存 Latent（无损）";
          if (tab === "image") {
            // 🔴 按「本格式在面板上的**实际属性**」显示，绝不拿隐藏选项的残留值说话
            //    （哥哥要求，Round 19 问题 2）：后端 JPEG 分支只吃 quality、完全忽略无损开关，
            //    所以 jpg 必须显示「质量 X」；PNG/TIFF 这类绝对无损格式质量恒 100 ⇒「无损」；
            //    WebP/AVIF/JXL/JPEG 2000 才真正随「无损」开关切换「无损模式 / 质量 X」。
            const fmtBase = f.replace(/^⭐\s*/, "").trim();
            let qualityBit;
            if (ALWAYS_LOSSLESS.has(fmtBase)) {
              qualityBit = "无损";
            } else if (LOSSLESS_CAPABLE.test(fmtBase) && !!W["无损"]?.value) {
              qualityBit = "无损模式";
            } else {
              qualityBit = "质量 " + String(W["质量"]?.value ?? "");
            }
            const bits = [qualityBit];
            if (PNGISH.test(f)) {
              const st = COMPRESS_STEPS.find((s) => Number(s.value) === compressToStep(W["压缩级别"]?.value));
              bits.push("压缩级别 " + (st ? st.label : String(W["压缩级别"]?.value ?? "")));
            }
            return RS(" ｜ ", bits);
          }
          if (tab === "video") {
            // 🔴 信息窗必须能一眼看出「输出帧率被改过」（哥哥要求）：
            //    输出帧率 = 0（默认）⇒ 显示与「输入帧率」相同的值（＝跟随，不转换）；
            //    输出帧率 > 0 ⇒ 显示真实值并**整段标醒目黄** —— 误操作 / 忘了改回默认时立刻可见。
            //    名称与下方胶囊严格一致：输入帧率 / 输出帧率。
            const inFpsRaw = W["帧率"]?.value;
            const inFps = String(inFpsRaw ?? "");
            const outFpsNum = Number(W["输出帧率"]?.value);
            const outChanged = isFinite(outFpsNum) && outFpsNum > 0;
            const fpsSegs = [RX("输入帧率 " + inFps), RX(" · ")];
            if (outChanged) fpsSegs.push(RHW("输出帧率 " + outFpsNum));
            else fpsSegs.push("输出帧率 " + (inFps !== "" ? inFps : "—"));
            const groups = ["编码 " + String(W["视频编码"]?.value ?? ""), fpsSegs];
            if (AV_CONTAINERS.includes(f)) groups.push("CRF " + String(W["视频质量"]?.value ?? ""));
            return RS(" ｜ ", groups);
          }
          return RS(" ｜ ", [AUDIO_LOSSLESS.has(f) ? "无损音质" : "音质 " + String(W["音频质量"]?.value ?? "")]);
        } catch (e) { return ""; }
      }

      // 运行后：把本次落盘的**全部**文件名按数量收敛成一个可读串
      //   1 张 ⇒ 名字；2 张 ⇒ A、B；≥3 张 ⇒ A ~ C（首 ~ 末）
      // 旧版只显示 lastRun.filename（首图），多图时信息窗与日志对不上（用户报的条2）。
      function savedFileText() {
        const names = (lastRun && Array.isArray(lastRun.filenames))
          ? lastRun.filenames.filter(Boolean) : [];
        if (!names.length) return "";
        if (names.length === 1) return names[0];
        if (names.length === 2) return names[0] + "、" + names[1];
        return names[0] + " ~ " + names[names.length - 1];
      }

      function outputInfoText() {
        const cur = String(W["filename_prefix"]?.value ?? "");
        const absDir = absFolderOf(cur);
        const dir = (lastRun && lastRun.dir) ? lastRun.dir : (absDir || "output（默认）");
        const ext = extOfFormat();
        const detail = formatDetail();                 // 质量 / 编码 / 「仅保存 Latent（无损）」等
        const outBits = [dir, "文件格式：" + (ext ? "." + ext : "（未选格式）")];
        if (detail) outBits.push(detail);
        // 🔴「不保存X」时 latent 就是产物本身（detail 已写明），无需再标；
        //    其余情况「保存潜空间」开启 ⇒ 明确标出「同时还落盘 .latent」（哥哥要求：产物 + Latent 并存可见）。
        const f = clean(currentFormat());
        if (f !== NONE_IMAGE && f !== NONE_VIDEO && f !== NONE_AUDIO && !!W["保存潜空间"]?.value) {
          outBits.push("＋ 保存 Latent");
        }
        // 🔴「写入元数据」开启且本格式支持写元数据 ⇒ 信息窗标明（哥哥要求）。
        if (metaSupported() && !!W["写入元数据"]?.value) {
          outBits.push("＋ 元数据");
        }
        return RS(" ｜ ", outBits);
      }

      function extraInfoText() {
        const bits = [];
        const sh = shapeText();
        if (sh) bits.push("分辨率 " + sh.replace(/（.*?）/, ""));
        // VAE1 选了「使用Josia模型加载VAE」时，标注该共享 VAE 当前是否真的已载入
        // （图里有节点 ⇒ 可选中；但真正拿去解码还得它跑过一次，这里把状态说清楚）
        if (String(W["VAE1"]?.value ?? "") === USE_JOSIA_VAE) {
          const lab = (vaeShared && vaeShared.label1) ? "（" + vaeShared.label1 + "）" : "";
          bits.push(josiaVaeReady() ? "共享VAE 已就绪" + lab : "共享VAE 待运行");
        }
        if (lastRun && lastRun.cost) bits.push("耗时 " + lastRun.cost + "s");
        if (lastRun && lastRun.count) bits.push("产物 " + lastRun.count + " 个");
        if (hasRun || lastRun) bits.push(!!W["临时预览"]?.value ? "落 temp（预览模式）" : "落 output 目录");
        if (!bits.length) return "待运行（运行后这里显示 分辨率 / 耗时 / 落盘位置）";
        return bits.join(" ｜ ");
      }
      function updateInfo() {
        setLine(lineIn, "输入", inputInfoText());
        setLine(lineOut, "输出", outputInfoText());
        setLine(lineEtc, "其他", extraInfoText());
        // 🔴 重大后端执行报错：后端 save_media 软失败时会把异常写进 lastRun.error/error_detail，
        //    这里红色整块显示（含完整堆栈），便于用户整窗复制反馈排障。无报错则整行收起。
        if (lastRun && lastRun.error) {
          const detail = String(lastRun.error_detail || "").trim();
          lineErr.textContent = "❌ 执行报错：" + String(lastRun.error) + (detail ? "\n" + detail : "");
          lineErr.style.display = "";
        } else {
          lineErr.style.display = "none";
          lineErr.textContent = "";
        }
      }

      /* ============ 高度：面板固定＝内容高；节点高默认＝内容高（不留空白）============ */
      // 🔴🔴 历史坑（勿重演）：曾经按 root 的 scrollHeight 去撑高 node.size，而 DOM 控件层会把
      //    root 拉伸到「节点高 − 标题栏」，于是量到的是**拉伸后**的高度 ⇒ 每帧 +2px 无限膨胀。
      //    现在只做两件事：
      //      ① applyLayout 只写 DOM 样式（root 的 maxHeight），**绝不写 node.size**；
      //      ② 面板需要多高由我们上报（内容高 + 上下各 10px 的 DOM 边距），
      //         minHeight = maxHeight = 面板高 ⇒ 面板既不被拉伸留白、也不被压扁；
      //         节点装不下时由官方 _arrangeWidgets 的 tail（y > bodyHeight → setSize）撑到刚好。
      const MARGIN = 10;          // = DOMWidgetImpl.DEFAULT_MARGIN：元素四周各让出 10px
      let _panelH = 0;            // 面板需要的高度（内容高 + 2*MARGIN）；0 = 还没量到
      let _fitFail = 0;

      // 量内容高：把每行的自然高度（offsetHeight，不受画布 transform/zoom 影响）累加。
      // 关键前提：.jms-root>* 设了 flex:0 0 auto ⇒ 行不会被压扁，量到的是真实高度。
      function measureContent() {
        try {
          const cs = getComputedStyle(root);
          const gap = parseFloat(cs.rowGap) || 0;
          const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
          let h = 0, n = 0;
          for (const c of root.children) {
            if (c.nodeType !== 1 || c.style.display === "none") continue;
            const oh = c.offsetHeight;
            if (oh > 0) { h += oh; n++; }
          }
          if (n === 0) return 0;
          return Math.round(pad + h + gap * Math.max(0, n - 1));
        } catch (e) { return 0; }
      }
      function refreshPanelH() {
        const c = measureContent();
        if (c > 40) _panelH = c + MARGIN * 2;   // 太小 ⇒ 面板还没挂进 DOM，忽略这次测量
        return _panelH;
      }

      // 🔴🔴 视频预览控件的「高度下限」必须**跟着节点宽度走**。
      //    取证（前端 1.52.7）：
      //      · useNodeImage.ts → useNodeVideo：minHeight 是闭包变量，只在
      //        `video.onloadeddata → setMinDimensions(video)` 里按**当时**的 node.size[0] 算一次
      //        （fitDimensionsToNodeWidth），此后永久冻结；
      //      · 而 `widget.computeLayoutSize = () => ({ minHeight, minWidth })` 每次布局都返回这个旧值；
      //      · LGraphNode._arrangeWidgets → distributeSpace(freeSpace, requests)：若
      //        ΣminSize > freeSpace ⇒ 直接返回各 minSize ⇒ y > bodyHeight
      //        ⇒ `if (!vueNodesMode) this.setSize([w, y])` 把节点**撑回**去。
      //    结论：宽度变窄后 minHeight 仍是按旧宽算的大值 ⇒ 高度被锁死、怎么拖都不缩（宽度却能缩）。
      //    修法：把它的 computeLayoutSize 换成「按当前宽度等比算」，且**不冻结** ——
      //    宽度一变下限就变，节点能一路缩到 computeSize() 的 MIN_H，播放器自己按宽度缩小。
      function relaxVideoMinHeight() {
        try {
          const w = (node.widgets || []).find((x) => x && x.name === "video-preview");
          if (!w || w._jmsMinRelaxed) return;
          w._jmsMinRelaxed = true;
          w.computeLayoutSize = function (n) {
            try {
              const cw = Math.max(1, Number(n?.size?.[0]) || Number(node.size?.[0]) || 300);
              const v = node.videoContainer?.querySelector?.("video");
              const vw = Number(v?.videoWidth) || 0;
              const vh = Number(v?.videoHeight) || 0;
              // 拿不到真实宽高比时按 16:9 估（只影响「能让节点缩多小」，不影响播放器自身缩放）
              const ar = (vw > 0 && vh > 0) ? (vh / vw) : 0.5625;
              return { minHeight: Math.max(40, Math.round(Math.max(1, cw - 20) * ar)), minWidth: 0 };
            } catch (e) {
              return { minHeight: 40, minWidth: 0 };
            }
          };
        } catch (e) { /* 忽略 */ }
      }

      let applying = false;
      function applyLayout() {
        if (applying) return;
        applying = true;
        try {
          // 每次布局前顺一次视频下限（幂等，只在首次真正改写）—— 这是「视频模式缩不小」的解药。
          relaxVideoMinHeight();
          refreshPanelH();
          // 面板可用高度 = 节点高 − 标题栏；用它给 root 设 maxHeight，让内部滚动精确生效。
          // 只写 DOM 样式、不写 node.size ⇒ 不产生任何反馈回路。
          const avail = Math.max(0, Math.round((node.size?.[1] || 0) - chromeH()));
          if (avail > 0) root.style.maxHeight = avail + "px";
        } finally { applying = false; }
        fitHeight();
        node.setDirtyCanvas?.(true, true);
      }

      // 🔴 高度贴合：把节点收成「刚好装下**所有可见控件**」的高度 —— 这就是「默认不留空白区域」。
      //    只收不撑：需要更高时由官方 tail（y > bodyHeight → setSize）负责撑高。
      //    🔴 关键：不能只按「我们面板的底边」算。后端出图后，官方会往 node.widgets 里追加一个
      //       **画布图像预览控件**（下限 220px），它排在面板下方；若只按面板底边收高，节点会被
      //       收短 ⇒ 图像被挤到节点**外面**「悬挂」着，而且与官方撑高来回打架（点空白处闪一下）。
      //       所以这里取「所有可见控件底边」的最大值作为所需高度。
      function fitHeight() {
        const w = domWidget;
        if (!w || !_panelH || !w.computedHeight) return;
        // 🔴 只要这次带了图输出（官方会把 node.imgs 挂到画布预览上），就**完全不再自动收高**：
        //    高度由官方 _arrangeWidgets 的 tail 决定，我们插手只会把图片挤到节点外。
        // 出图后官方会把预览挂到 node.imgs：默认不再自动收高（避免把预览挤到节点外）。
        // 但**用户一旦手动拖过尺寸（userResized）就尊重其意图**——允许继续收高，
        // 否则「视频预览已随宽度变窄、却怎么都拖不短节点高度」的问题无解。
        try {
          if (node.imgs && node.imgs.length && !userResized) { _fitFail = 0; return; }
        } catch (e) { /* 忽略 */ }
        const bodyH = Number(node.bodyHeight) || 0;
        let yTotal = Number(w.y || 0) + Number(w.computedHeight || 0);
        try {
          for (const it of (node.widgets || [])) {
            if (it === w) continue;
            if (it.hidden || it.options?.hidden) continue;   // 被我们隐藏的原生 widget 不算
            const by = Number(it.y || 0) + Number(it.computedHeight || 0);
            if (by > yTotal) yTotal = by;
          }
        } catch (e) { /* 忽略 */ }
        if (!(bodyH > 0) || !(yTotal > 0)) return;
        const delta = Math.round(yTotal - bodyH);
        if (delta >= -6) { _fitFail = 0; return; }      // 已贴合 / 内容需要更高 → 交给官方 tail
        if (_fitFail >= 2) return;                       // 收敛失败就别再动，避免来回抖
        const before = Math.round(node.size?.[1] || 0);
        const next = Math.max(_panelH + 60, before + delta);
        if (Math.abs(next - before) < 2) { _fitFail++; return; }
        try { node.size[1] = next; } catch (e) { return; }
        node.setDirtyCanvas?.(true, true);
      }

      // 🔴 刷新调度统一走 rAF 合帧：onResize 在一次拖拽里会连发几十次，而且
      //    setTimeout(0) 执行时 Vue 可能还没把新宽度提交进 DOM ⇒ 量到旧宽、_panelH 过期。
      //    rAF 在本轮 DOM 变更之后执行，量到的是真实布局。
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
        origResize?.apply(this, arguments);
        // onResize 由官方 setSize（拖拽 + 自动撑高）调用 ⇒ 视为「尺寸被改过」。
        userResized = true;
        _fitFail = 0;
        scheduleHeal();
      };

      // 🔴🔴 面板自愈观察器（Round 19 问题 3）：「调完尺寸挪一下节点，信息窗缩短且不再
      //    自适应、右键刷新才恢复」＝ 宽度变化后没有人**重新量内容高** —— onResize 里的
      //    量宽竞态让 _panelH 停在旧值，行在新宽度下重排之后，官方按 _panelH 分配给面板的
      //    高度（computedHeight）就永远错了；挪节点不触发任何重算 ⇒ 一直错到节点重建。
      //    这里监听 root 自身的盒子变化：宽度变了、或内容装不下（溢出）⇒ 重跑 applyLayout
      //    自愈。回路安全性：初始化默认宽之后我们**从不写宽度**（fitHeight 只写 node.size[1]、
      //    maxHeight 只影响高度）⇒ 宽度事件只会来自用户/官方的真实尺寸变化，不会自我触发。
      let _lastW = 0;
      try {
        const _ro = new ResizeObserver((entries) => {
          for (const en of entries) {
            const w = Math.round(en.contentRect.width);
            const changed = _lastW > 0 && Math.abs(w - _lastW) >= 1;
            _lastW = w;
            if (changed) { scheduleHeal(); continue; }
            // 高度变化：只在「内容被截断」时重新对齐一次（单向收敛，不做几何回写）
            try {
              if (root.scrollHeight > root.clientHeight + 2) scheduleHeal();
            } catch (e2) { /* 忽略 */ }
          }
        });
        _ro.observe(root);
      } catch (e) { /* 旧内核无 ResizeObserver 时忽略 */ }

      // 端口连线 / 断开时重算（VAE 灰化依赖）
      const origConnectionsChange = node.onConnectionsChange;
      node.onConnectionsChange = function () {
        origConnectionsChange?.apply(this, arguments);
        setTimeout(() => { closeMenu(); refresh(); }, 0);
      };

      // 图内增删节点时刷新 VAE 注册表状态（识别 Josia 模型加载节点的增删）
      try {
        if (app.graph) {
          const _ga = app.graph.onNodeAdded;
          app.graph.onNodeAdded = function () { try { _ga?.apply(this, arguments); } catch (e) {} loadVaeState(); };
          const _gr = app.graph.onNodeRemoved;
          app.graph.onNodeRemoved = function () { try { _gr?.apply(this, arguments); } catch (e) {} loadVaeState(); };
        }
      } catch (e) { /* 旧前端无此钩子时忽略 */ }

      /* ======================= 滚轮缩放转发 ======================= */
      // 节点面板捕获 wheel → 调用 LiteGraph 原生 handler，恢复「滚轮缩放画布」。
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

      /* ======================= 选目录 / 打开目录 ======================= */
      function absFolderOf(prefix) {
        const p = String(prefix || "").replace(/\//g, "\\");
        if (!/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith("\\\\") && !p.startsWith("\\")) return null;
        const trimmed = p.replace(/[\\]+$/, "");
        const idx = trimmed.lastIndexOf("\\");
        if (idx <= 2) return null;
        return trimmed.slice(0, idx);
      }
      function startFolder() {
        const cur = String(W["filename_prefix"]?.value || "");
        return absFolderOf(cur) || cur.replace(/[^\\/]*$/, "").replace(/[\\/]+$/, "") || "";
      }
      // 前缀里的「目录部分」＝最后一个分隔符之前的内容（未点「选择目录」时，
      // 它就是 output 下的子层级，如 `JosiaMedia\Media_%001%` ⇒ `JosiaMedia`）。
      function relSubOf(p) {
        const s = String(p || "");
        const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
        return i > 0 ? s.slice(0, i) : "";
      }
      // 把选中的目录写回「文件名前缀」（保留原来的文件名尾部）
      function applyPickedFolder(p) {
        const cur = String(W["filename_prefix"]?.value || "");
        const tail = absFolderOf(cur) ? cur.replace(/^.*[\\/]/, "") : cur.split(/[\\/]/).pop();
        const name = (tail && !/[\\/]/.test(tail)) ? tail : DEFAULT_NAME;
        setWidgetValue(node, W["filename_prefix"], String(p).replace(/[\\/]+$/, "") + "\\" + name);
        fileWrap._input.value = String(W["filename_prefix"]?.value ?? "");
        refresh();
      }
      // 🔴「📁 选择」优先调用 **Windows 原生「选择文件夹」对话框**
      //    （后端 ctypes 直调 shell32，进程内调用、零子进程 —— subprocess 写法会被注册表扫成
      //     python_command_injection_risk）。原生框左侧就有「此电脑」，可以随时退回顶层，
      //     正好解决内置浏览器「进了盘符就回不去」的问题。
      //     非 Windows / 调用失败 / 接口不存在 ⇒ 自动退回内置文件夹浏览器（功能不丢）。
      btnPick.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        if (btnPick.disabled) return;
        setStatus("⏳ 已打开系统「选择文件夹」窗口，请在弹窗里选择目录…");
        btnPick.disabled = true;
        try {
          const resp = await api.fetchApi("/josia_media_save/pick_dir", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "选择输出目录", initial: startFolder() }),
          });
          const data = await resp.json().catch(() => ({}));
          if (resp.ok && data.ok && data.path) {
            applyPickedFolder(data.path);
            setStatus(`📁 已选择：${data.path}`);
            return;
          }
          if (data.error === "cancelled") { setStatus("已取消选择。"); return; }
          setStatus(`原生选择器不可用（${data.error || resp.status}），已改用内置文件夹浏览器。`);
        } catch (err) {
          setStatus(`原生选择器调用失败（${err}），已改用内置文件夹浏览器。`);
        } finally {
          btnPick.disabled = false;
        }
        openFolderBrowser(startFolder(), applyPickedFolder);
      });
      btnOpen.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        const cur = String(W["filename_prefix"]?.value || "");
        const absDir = absFolderOf(cur);
        btnOpen.disabled = true;
        try {
          // 🔴 没点「选择目录」时也要能定位到 output 的**子层级**：
          //    `JosiaMedia\Media_%001%` ⇒ 打开 output\JosiaMedia（后端会在目录还不存在时建出来）。
          const body = absDir
            ? { dir: absDir }
            : { type: !!W["临时预览"]?.value ? "temp" : "output", subfolder: relSubOf(cur) };
          const resp = await api.fetchApi("/josia_media_save/open_folder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || !data.ok) setStatus(`⚠️ 打开目录失败：${data.error || resp.status}`, true);
          else setStatus(`📂 已打开：${data.path}`);
        } catch (err) {
          setStatus(`⚠️ 打开目录失败：${err}`, true);
        } finally {
          btnOpen.disabled = false;
          applyLayout();
        }
      });

      /* ======================= 老工作流兼容 ======================= */
      const hintWarn = (msg) => { setStatus("⚠️ " + msg, true); };
      function healFormatValue() {
        const w = W["图像格式"];
        if (!w) return;
        const vals = comboValues(w, node) || [];
        if (!vals.length) return;
        const cur = String(w.value);
        if (!vals.includes(cur)) {
          const def = String(w.options?.default ?? vals[0]);
          setWidgetValue(node, w, def);
          hintWarn(`原格式「${cur}」在当前环境不可用（可能缺编码器插件），已改用「${def}」。`);
        }
      }

      /* ======================= 执行结果 ======================= */
      let lastSaved = null;
      const origExec = node.onExecuted;
      node.onExecuted = function (message) {
        origExec?.apply(this, arguments);
        try {
          // 后端 ui.josia_info：这次**真实**收到了什么、实际写到哪个目录 / 序号 / 格式。
          // 它是「输入 / 输出 / 其他」三行的权威数据源（比只读面板选项准确）。
          hasRun = true;
          if (message && message.josia_info) lastRun = message.josia_info;

          const imgs = message?.images || [];
          const auds = message?.audio || [];
          const lat = message?.latents || [];
          const parts = [];
          if (imgs.length) parts.push(`图片 ${imgs.length}`);
          if (auds.length) parts.push(`音频 ${auds.length}`);
          if (lat.length) parts.push(`Latent ${lat.length}`);
          // 🔴 状态行必须列出**本次全部**落盘文件名（1 个＝名字 / 2 个＝A、B / ≥3＝A ~ C）。
          //    以前只取 `imgs[0]` ⇒ 图像批次存了 3 张却只报 1 个名字，和目录里对不上。
          const allNames = [].concat(imgs || [], auds || [], lat || [])
            .map((d) => {
              const n = d && d.filename ? String(d.filename) : "";
              if (!n) return "";
              return d.subfolder ? String(d.subfolder).replace(/[\\/]+$/, "") + "/" + n : n;
            })
            .filter(Boolean);

          // 🔴🔴 预览窗只显示**本次**产物（哥哥报的「旧图挂在播放器上/下、播放器永不消失」）。
          //    取证（前端 1.52.7 litegraphService.unsafeUpdatePreviews）：官方有**三条互不清理**的
          //    预览通道 —— ① video-preview（视频播放器 DOM widget）② $$comfy_animation_preview
          //    （动图预览，取 node.imgs[0]）③ $$canvas-image-preview（静态图预览）。
          //    漏洞：a) 官方任何分支都**从不删除** video-preview ⇒ 播放器永留；
          //          b) 视频输出时 node.imgs 还是上一轮的旧图 ⇒ showAnimatedPreview 把旧图
          //             塞进 ② ⇒ 播放器上/下挂着上一次的图。
          //    修法：按本次产物扩展名清理另一类残留（照抄官方 removeAnimatedPreview 的
          //    onRemove + splice 写法，保证事件监听随 AbortController 一起释放）。
          const _outNames = (message?.images || []).map((d) => String(d?.filename || ""));
          const _isVideoOut = _outNames.some((n) => /\.(mp4|mkv|webm)$/i.test(n));
          if (_isVideoOut) {
            // 视频（MP4/MKV/WebM）：清掉上一轮的静态图/动图预览，播放器由官方复用。
            clearPreviewCache("image");
          } else if (_outNames.length) {
            // 静图 / 动图（GIF/APNG/动图WebP）：移除上一轮的视频播放器
            // （顺带丢掉那个被冻结的高度下限 —— 下次视频会自动按当前宽度重建）。
            clearPreviewCache("video");
          }
          // 🔴🔴 关键修正（治「从视频切回图像后新图没有预览」）：
          //    官方 useNodeImage / useNodeVideo **只在构造时**写一次 node.previewMediaType，
          //    此后没有任何地方重置 ⇒ 视频跑过一次后它**永远是 'video'**；而官方分轨判定是
          //      `isVideo = isVideoOutput(output) || isVideoNode(this)`，其中
          //      `isVideoNode = previewMediaType==='video' || !!videoContainer`。
          //    于是切回图像模式时它仍被当成视频节点 ⇒ 拿 PNG 去 <video> 加载必然 onerror
          //    ⇒ 图像预览永远不出现，只剩信息窗日志。这里按本次产物显式写回正确的通道类型。
          if (_outNames.length) {
            try { node.previewMediaType = _isVideoOut ? "video" : "image"; } catch (e) { /* 忽略 */ }
          }

          // 🔴 保存结果属于「当前操作日志」⇒ 只写状态行，绝不覆盖上面三行的显示信息。
          // 视频/动图经过「输出帧率」转换后，把实际落盘的播放帧率也带回状态行，方便核对。
          const _afps = message?.josia_info?.actual_fps;
          const fpsSuffix = (_afps !== undefined && _afps !== null) ? `｜输出帧率 ${_afps} fps` : "";
          if (message?.josia_info?.error) {
            // 后端软失败（save_media 已被 try 包裹）：信息窗已用红字显示完整异常，
            // 状态行只给一句提示，不要再用 ✅ 误导。
            setStatus("❌ 执行出错：详情见信息窗（可整窗复制反馈）", true);
          } else if (allNames.length) {
            lastSaved = allNames.length === 1 ? allNames[0]
              : allNames.length === 2 ? (allNames[0] + "、" + allNames[1])
                : (allNames[0] + " ~ " + allNames[allNames.length - 1]);
            setStatus(`✅ 已保存 ${allNames.length} 个媒体文件（${parts.join(" / ")}）：${lastSaved}${fpsSuffix}`);
          } else if (parts.length) {
            lastSaved = parts.join(" / ");
            setStatus(`✅ 已保存：${lastSaved}${fpsSuffix}`);
          } else {
            setStatus("✅ 运行完成（本次没有产物落盘）。");
          }
          refresh();
          loadVaeState();
          // 🔴 官方把出图结果挂到画布预览（node.imgs）发生在这一帧之后 ⇒ 再补几拍刷新，
          //    信息窗的「输入行尺寸 / 其他行分辨率」才能立刻反映出图结果。
          [0, 120, 400].forEach((ms) => setTimeout(() => {
            try { refresh(); node.setDirtyCanvas?.(true, true); } catch (e) { /* 忽略 */ }
          }, ms));
        } catch (e) { /* 忽略 */ }
      };

      /* ======================= 默认宽度（新建节点）======================= */
      // 只作用于「新建」的节点：从旧工作流载入的节点保持用户自己保存的宽度。
      // 两条路径都走：① 直接改 node.size（2.0 下 setSize 的增长可能被禁，直接赋值才稳）；
      // ② 再调 setSize 触发官方布局/重绘。
      function applyDefaultWidth() {
        // 1.0：默认宽已由 onNodeCreated 直接设在 node.size；从工作流加载（_jmsFromWorkflow）的
        // 节点尺寸以保存为准，不再强制。此处仅防御：极窄的新节点兜底到 DEF_W。
        // 🔴 用户一旦手动调过尺寸（userResized）就绝不再套默认宽 —— 否则紧接着的 60/300ms
        //    兜底会把你刚拖窄的节点又顶回 DEF_W（表现：拖了就弹回去）。
        if (node._jmsFromWorkflow || userResized) return;
        const curW = node.size?.[0] || 0;
        if (curW > 0 && curW < DEF_W) {
          try { node.size[0] = DEF_W; } catch (e) { /* 忽略 */ }
          try { node.setDirtyCanvas?.(true, true); } catch (e) { /* 忽略 */ }
        }
      }

      /* ======================= 初始化 ======================= */
      requestAnimationFrame(() => {
        healFormatValue();
        refresh();
        loadMetaTables();
        loadVaeState();
        applyLayout();
        try { node._jmsSizeRow4?.(); node._jmsSizeVidRow?.(); } catch (e) { /* 忽略 */ }
        // 新建节点默认给到宽尺寸；多补几帧 + 延时，确保 DOM 布局落定后宽度不被回退。
        // 高度不用在这里设：refresh → applyLayout → fitHeight 会把节点收成「刚好装下内容」。
        applyDefaultWidth();
        [0, 60, 300].forEach((ms) => setTimeout(() => {
          try { node._jmsSizeRow4?.(); node._jmsSizeVidRow?.(); } catch (e) { /* 忽略 */ }
          applyDefaultWidth(); applyLayout();
        }, ms));
        node.setDirtyCanvas?.(true, true);
      });

      // 挂 DOM 控件
      // 🔴 hideOnZoom: false —— 官方 addDOMWidget 默认 true，缩小画布时整块面板会被换成
      //    占位矩形（看着还在，实际已经不可交互）。
      // 🔴🔴🔴 绝不给 DOM 控件设 computeSize！（「高度无限增长」的直接元凶）
      //    `LGraphNode._arrangeWidgets()`：
      //      if (w.computeSize) { const h = w.computeSize()[1] + 4; w.computedHeight = h }   // 当成「固定高度」
      //      else if (w.computeLayoutSize) { …growableWidgets… }                             // 当成「可伸缩」
      //      …
      //      if (!LiteGraph.vueNodesMode && y > bodyHeight) this.setSize([this.size[0], y])  // 撑高节点
      //    —— 有 computeSize 的控件走**固定高度**分支；没有的走 computeLayoutSize，作为**可伸缩**
      //    控件分到「节点剩余空间」。曾经给它加过 computeSize 覆写、且回报的高度由 node.size 推出：
      //      computedHeight = node.size[1] − 32 + 4 = node.size[1] − 28
      //      → 累加后 y = startY + node.size[1] − 28 > bodyHeight（startY 恒 > 28）
      //      → setSize([w, y]) 撑高节点 → 下一帧更大 ⇒ **每帧增长、无限膨胀**。
      //    正确做法＝只走 computeLayoutSize，用 getMinHeight / getMaxHeight 控制高度：
      //      minHeight = maxHeight = 面板内容高 + 上下边距
      //      ⇒ 面板既不被拉伸留白（不再「下方预留一大片空白」），也不会被压扁；
      //      ⇒ 剩余空间留给官方图像预览控件（生成图像后自动在面板下方弹出图像区）。
      domWidget = node.addDOMWidget("media_ui", "media_save_ui", root, {
        serialize: false,
        hideOnZoom: false,
        // 量到之前先退回「可伸缩」的默认行为，避免面板被算成 0 高而消失
        getMinHeight: () => (_panelH > 0 ? _panelH : 50),
        getMaxHeight: () => (_panelH > 0 ? _panelH : undefined),
      });

      // 诊断用：面板是否真的收到了指针事件、点在哪个控件上（排查「点不动」时看控制台 F12）
      let _jmsHits = 0;
      root.addEventListener("pointerdown", (e) => {
        _jmsHits++;
        if (_jmsHits <= 5) {
          try {
            const t = e.target;
            console.info(`[Josia媒体保存] 面板收到点击 #${_jmsHits} →`, t?.className || t?.tagName, t?.textContent?.slice(0, 12) || "");
          } catch (err) { /* 忽略 */ }
        }
      }, { capture: true, passive: true });
      node._jmsHits = () => _jmsHits;

      /* ======================= 按住空白 / 图像 ⇒ 移动节点 ======================= */
      // 面板 CSS 已把 .jms-root 设成 pointer-events:none（只有控件抢回 auto），所以空白处的
      // pointerdown 会**原生**落到下层 canvas 上，由官方 CanvasPointer 接管，拖动时它会
      // setPointerCapture ⇒ 拖到节点外也不会断，手感和原生节点完全一致。
      // 下面这一层是保险：万一某个上级容器仍写着 pointer-events:auto（把空白区吃掉），
      // 就在它身上捕获 pointerdown / wheel 并「转发给画布」。转发用的是官方同一套写法
      // （app.canvas.canvas 上派发同型事件），所以命中判定与坐标全都不用自己算。
      // ⚠️ 信息窗（.jms-info）属于**纯交互区**：它不在转发白名单里会被跳过，按住它不移动节点。
      const JMS_INTERACTIVE_SEL =
        ".jms-info,input,textarea,button,select,a," +
        ".jms-btn,.jms-numwrap,.jms-drop,.jms-capsule,.jms-dot," +
        ".jms-overlay,.jms-menu,.jms-mask,.jms-panel";
      function isJmsInteractive(t) {
        try { return !!(t && t.closest && t.closest(JMS_INTERACTIVE_SEL)); } catch (e) { return false; }
      }
      // 🔴 宿主元素**必须在事件发生时再取**！
      //    addDOMWidget 只是把 root 登记给节点，真正被官方塞进 `div.dom-widget` 是
      //    Vue 组件 mount 之后的 nextTick（DomWidget.vue 的 mountElementIfVisible）。
      //    以前在这里**同步**取 root.parentElement ⇒ 那时它还是 null ⇒ 转发根本没挂上
      //    ⇒ 「面板空白处拖不动」的老毛病一直没修掉。
      function jmsHost() {
        try { return root.parentElement || root; } catch (e) { return root; }
      }
      function forwardToCanvas(e) {
        const cv = app.canvas?.canvas;
        if (!cv) return false;
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
          return true;
        } catch (err) { return false; }
      }
      // 🔴 挂在 document 上做捕获（宿主 late-bind），命中范围严格限定为「装着本面板的那个
      //    外层盒子及其后代」，绝不波及页面上其它元素。
      const jmsInOurBox = (t) => {
        if (!(t instanceof Node)) return false;
        const host = jmsHost();
        if (!host || host === document.body || host === document.documentElement) return false;
        try { return host === t || host.contains(t); } catch (e) { return false; }
      };
      document.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 && e.button !== 1) return;        // 只接管左键 / 中键
        if (!jmsInOurBox(e.target)) return;
        if (isJmsInteractive(e.target)) return;               // 控件自己处理
        forwardToCanvas(e);
      }, true);
      document.addEventListener("wheel", (e) => {
        if (!jmsInOurBox(e.target)) return;
        if (isJmsInteractive(e.target)) return;
        forwardToCanvas(e);                                   // 滚轮＝缩放画布（与原生一致）
      }, { capture: true, passive: false });
      // 图像预览：禁掉浏览器原生「拖图片」（拖出去会变成在新标签打开/搜索图片），
      // 让它和原生节点一样「按住图像＝移动节点」。
      // 🔴 预览图是官方挂在画布 DOM 层里的（.comfy-img-preview），它**不在**我们面板盒子里，
      //    所以以前只扫 jmsHost() ⇒ 一张图都没扫到 ⇒ 拖图像仍然会被浏览器拖出去。
      //    改成扫整个画布 DOM 层（只认 .dom-widget / .comfy-img-preview 里的 img/video）。
      const JMS_IMG_SCOPE = ".dom-widget,.comfy-img-preview,.litegraph";
      function killImgDrag() {
        try {
          const list = document.querySelectorAll(JMS_IMG_SCOPE + " img," + JMS_IMG_SCOPE + " video");
          list.forEach((elm) => {
            try { elm.draggable = false; } catch (err) { /* 忽略 */ }
            try { elm.style.webkitUserDrag = "none"; } catch (err) { /* 忽略 */ }
          });
        } catch (err) { /* 忽略 */ }
      }
      document.addEventListener("dragstart", (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (!t.matches("img,video")) return;                 // 只掐图片/视频的原生拖拽
        if (!t.closest(JMS_IMG_SCOPE)) return;               // 画布 DOM 层之外的不管
        if (isJmsInteractive(t)) return;
        e.preventDefault();
      }, true);
      killImgDrag();
      [0, 120, 400].forEach((ms) => setTimeout(killImgDrag, ms));

      return r;
    };

    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      const node = this;
      node._jmsConfigured = true;
      // 由工作流 / 复制粘贴恢复出来的节点：保留用户自己保存的宽度，不再套用默认宽
      node._jmsFromWorkflow = true;
      node._jmsDropStaleInputs?.();
      // 恢复工作流里保存的「分类」；非视频分类顺手把遗留的视频容器置「不保存视频」
      // （旧工作流可能在「图像」分类下留着 MP4 ⇒ 多图批次会被擅自合成视频）
      node._jmsSyncTab?.(node.properties?.jms_tab);
      if (node._jmsRefresh) requestAnimationFrame(() => {
        node._jmsDropStaleInputs?.();
        node._jmsSyncTab?.(node.properties?.jms_tab);
        node._jmsRefresh();
      });
      return r;
    };
  },
});

/* ============================================================================
 * 文件夹选择器（浮层实现）
 * 后端契约与 text_save 的同名接口保持一致：
 *   POST /josia_media_save/list_dirs   {path}         → {ok,path,parent,dirs,shortcuts}
 *   POST /josia_media_save/create_dir  {parent,name}  → {ok,path}
 * ========================================================================== */
function openFolderBrowser(initialPath, onConfirm) {
  const mask = el("div", "jms-mask");
  const panel = el("div", "jms-panel");
  mask.appendChild(panel);
  document.body.appendChild(mask);

  mask.addEventListener("mousedown", (e) => { if (e.target === mask) close(); });

  let curPath = initialPath || "";
  let selPath = "";

  panel.innerHTML = `
    <div class="jms-panel-head"><span>选择输出目录</span>
      <button type="button" class="jms-btn" data-act="close">✕</button></div>
    <div class="jms-chips" data-el="chips"></div>
    <div class="jms-panel-bar">
      <button type="button" class="jms-btn" data-act="up">⏫ 上级</button>
      <input type="text" data-el="path" placeholder="直接输入路径后回车，或留空列出驱动器">
      <button type="button" class="jms-btn" data-act="refresh">🔄</button>
      <button type="button" class="jms-btn" data-act="mkdir">📁 新建</button>
    </div>
    <div class="jms-panel-list" data-el="list"></div>
    <div class="jms-panel-foot">
      <span class="cur" data-el="cur"></span>
      <span style="display:flex;gap:6px;">
        <button type="button" class="jms-btn" data-act="cancel">取消</button>
        <button type="button" class="jms-btn" data-act="ok">选择此文件夹</button>
      </span>
    </div>`;

  const elQ = (n) => panel.querySelector(`[data-el="${n}"]`);
  const listEl = elQ("list");
  const chipsEl = elQ("chips");
  const pathEl = elQ("path");
  const curEl = elQ("cur");
  const okBtn = panel.querySelector('[data-act="ok"]');

  function close() { mask.remove(); }

  function renderChips(shortcuts) {
    chipsEl.innerHTML = "";
    for (const s of (shortcuts || [])) {
      const c = el("span", "jms-chip", s.name);
      c.title = s.path;
      c.addEventListener("click", () => load(s.path));
      chipsEl.appendChild(c);
    }
  }
  function renderList(dirs, parent) {
    listEl.innerHTML = "";
    if (parent) {
      const up = el("div", "jms-dir", "⏫ ..");
      up.addEventListener("dblclick", () => load(parent));
      up.addEventListener("click", () => { clearTimeout(up._t); up._t = setTimeout(() => load(parent), 260); });
      listEl.appendChild(up);
    }
    for (const d of (dirs || [])) {
      const row = el("div", "jms-dir", "📁 " + d.name);
      row.title = d.path;
      row.addEventListener("dblclick", () => load(d.path));
      row.addEventListener("click", () => { clearTimeout(row._t); row._t = setTimeout(() => load(d.path), 260); });
      listEl.appendChild(row);
    }
    if (!dirs?.length && !parent) {
      const empty = el("div", "jms-dir", "（没有子目录）");
      empty.style.opacity = ".6";
      listEl.appendChild(empty);
    }
  }
  async function load(p) {
    try {
      const resp = await api.fetchApi("/josia_media_save/list_dirs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p || "" }),
      });
      const data = await resp.json();
      if (!data.ok) { curEl.textContent = "读取失败：" + (data.error || resp.status); return; }
      curPath = data.path || "";
      selPath = curPath;
      pathEl.value = curPath;
      curEl.textContent = curPath || "（请选择驱动器）";
      renderChips(data.shortcuts);
      renderList(data.dirs, data.parent);
      okBtn.disabled = !curPath;
    } catch (e) { curEl.textContent = "读取失败：" + e; }
  }
  async function mkdir() {
    if (!curPath) return;
    const name = window.prompt("新文件夹名称：");
    if (!name) return;
    try {
      const resp = await api.fetchApi("/josia_media_save/create_dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent: curPath, name }),
      });
      const data = await resp.json();
      if (!data.ok) { curEl.textContent = "新建失败：" + (data.error || resp.status); return; }
      load(data.path);
    } catch (e) { curEl.textContent = "新建失败：" + e; }
  }
  panel.addEventListener("click", (e) => {
    const act = e.target?.dataset?.act;
    if (!act) return;
    if (act === "close" || act === "cancel") close();
    else if (act === "up") load(curPath ? curPath.replace(/[\\/][^\\/]*$/, "") || curPath.replace(/[\\/]+$/, "") : "");
    else if (act === "refresh") load(curPath);
    else if (act === "mkdir") mkdir();
    else if (act === "ok") { if (curPath) { onConfirm?.(curPath); close(); } }
  });
  pathEl.addEventListener("keydown", (e) => { if (e.key === "Enter") load(pathEl.value.trim()); });
  load(curPath);
}
