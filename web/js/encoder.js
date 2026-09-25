/**
 * Josia 文本编码节点前端扩展
 * 功能：设置节点默认尺寸、绑定开关回调逻辑
 * 本地文件名：encoder.js（全小写）
 * 匹配后端节点标识：JosiaEncoder
 * 依赖：app（ComfyUI核心）、ComfyWidgets（ComfyUI组件）
 */
import { app } from "../../../scripts/app.js";
import { ComfyWidgets } from "../../../scripts/widgets.js";

// ── 动态图像输入 ─────────────────────────────────────────────
// 默认只显示 image1；接入 imageN 后自动出现 image(N+1)，最多 image10。
// 依赖后端 INPUT_TYPES 已声明 image1..image10（encoder.py），且均带 display_name 图像N。
//
// 🔴 接口显示名的正确字段是 localized_name，不是 display_name：
//   前端两套渲染器解析插槽文本的链路都是 `label || localized_name || name`
//     · 1.0 canvas：NodeSlot.renderingLabel（065_NodeSlot.ts）
//     · 2.0 Vue  ：InputSlot.vue 模板 `slotData.label || slotData.localized_name || slotData.name`
//   官方建节点代码（litegraphService.ts）也是把后端声明的 display_name 经
//   resolveNodeDefSlotText() 换算后写进 `localized_name`。
//   ⇒ 后端 node def 上的 display_name 会变中文，但因为它是**静态声明**的，
//     只有「节点重建」（刷新页面/重载工作流）时才会走一遍换算；
//     而前端动态 addInput 是运行时直接插槽，走不进这条链路。
//   ⇒ 所以动态新增接口必须显式传 {localized_name:"图像N"}，
//     只传 display_name 会被忽略 → 回落成裸键名（显示 Image N），
//     直到刷新页面节点重建、由后端 display_name 重新算出 localized_name 才变中文。
// ⚠️ 前端绝不可改写 input.name：input.name 是执行时传给后端 encode(**inputs) 的
//    kwarg 键名，必须是后端声明的英文键 image1..image10。改写 .name 会导致
//    TypeError: encode() got an unexpected keyword argument '图像1'。
const MAX_IMAGES = 10;
const IMG_DISPLAY_PREFIX = "图像";

function getImageInputs(node) {
  if (!node.inputs) return [];
  return node.inputs
    .map((inp, idx) => {
      // 兼容两种命名：后端「imageN」/ 前端「图像N」，统一取末尾数字
      const m = String(inp.name).match(/(\d+)\s*$/);
      const num = m ? parseInt(m[1], 10) : NaN;
      return { inp, idx, num };
    })
    .filter((o) => !Number.isNaN(o.num))
    .sort((a, b) => a.num - b.num);
}

// （旧 renameImageInputs 已删除：改写 input.name 会破坏后端 kwarg 映射，见上方说明）

// 按「链式」规则刷新可见图像接口：image1 永远存在；imageN 存在 ⇔ 1..N-1 全部已连接。
// 仅移除未连接的尾部接口，已连接的接口任何情况下都保留。
//
// ⚠️ 防重复关键：绝不为 image1 调用 addInput。后端 INPUT_TYPES 已声明 image1..image10，
// 若再 add 一个「图像1」，会与后端那个重名 → 出现两个「图像1」，且二者位置映射错乱
// （一个喂 image1、一个错位喂 image2），表现为「接入第一个无法使用，却多出接口」。
// 判定「是否已存在」一律用编号(末尾数字)，不用中文名——因为部分 ComfyUI 版本
// 后端声明的 image1 其 .name 仍是英文键名 "image1"，若按中文名查找会误判缺失而重复添加。
function syncImageInputs(node) {
  if (!node || node._syncingImages) return;
  const imgs = getImageInputs(node);
  if (!imgs.length) return;

  const presentNums = new Set(imgs.map((o) => o.num));
  // image1 永远在；imageN(n>=2) 应存在 ⇔ 1..N-1 全部已连接（连续前缀）。
  // 🔴 必须逐级 break 而不能只看「前一个编号的 link」：否则当 image1 断开、
  //    image2 仍连接（已连接接口按规则保留）时，会误判 image2 已就绪而凭空补出 image3。
  const desired = new Set([1]);
  for (let n = 2; n <= MAX_IMAGES; n++) {
    if (!desired.has(n - 1)) break;
    const prev = imgs.find((o) => o.num === n - 1);
    if (!prev || prev.inp.link == null) break;
    desired.add(n);
  }

  node._syncingImages = true;
  try {
    // 修复：旧版本动态新增的接口只写了 display_name、缺 localized_name（表现为显示 Image N）。
    //       这里对已存在的图像接口补一次 localized_name，无需刷新页面即可变中文；
    //       对已是中文的接口是幂等空操作。绝不改动 .name（执行期 kwarg 键）。
    for (const o of imgs) {
      if (o.inp.localized_name !== IMG_DISPLAY_PREFIX + o.num) {
        o.inp.localized_name = IMG_DISPLAY_PREFIX + o.num;
      }
    }
    // 移除：仅 num>1 且不在 desired 且未连接的尾部接口（从高到低，避免索引位移）
    for (let k = imgs.length - 1; k >= 0; k--) {
      const o = imgs[k];
      if (o.num > 1 && !desired.has(o.num) && o.inp.link == null) {
        node.removeInput(o.idx);
      }
    }
    // 补齐：仅对 num>=2 且 desired 中缺失的，以后端键名 imageN 追加
    //       （绝不给 image1 追加；name 必须是 imageN 才能映射到后端 encode 的 kwarg）。
    //       必须同时给 localized_name 与 display_name：
    //         · localized_name → 渲染器实际读取的显示名，保证「实时」就是中文；
    //         · display_name   → 与后端 INPUT_TYPES 声明保持一致，供序列化/其他消费者复用。
    for (let n = 2; n <= MAX_IMAGES; n++) {
      if (desired.has(n) && !presentNums.has(n)) {
        const label = IMG_DISPLAY_PREFIX + n;
        node.addInput("image" + n, "IMAGE", {
          localized_name: label,
          display_name: label,
        });
      }
    }
  } finally {
    node._syncingImages = false;
  }
  node.setDirtyCanvas(true, true);
}

// 根据负向开关当前值，固定负向提示词输入框的显隐（关闭=隐藏，开启=显示）。
// 抽为独立函数，供「开关回调(onNodeCreated)」与「节点恢复(onConfigure)」复用，
// 避免重载/撤销(redo/undo) 时 widget 值被恢复成关闭、但 hidden 仍停在默认(可见) 导致框重现。
function applyNegativeVisibility(node) {
    if (!node.widgets) return;
    const negativeSwitch = node.widgets.find(w => w.name === "negative_switch");
    const negativePromptWidget = node.widgets.find(w => w.name === "negative_prompt");
    if (negativeSwitch && negativePromptWidget) {
        // negative_switch 默认值为 true(开启)；重载/撤销后此处读取的是已恢复的真实值
        negativePromptWidget.hidden = !negativeSwitch.value;
        node.setDirtyCanvas(true, true);
    }
}

// 注册ComfyUI扩展（扩展名匹配节点标识）
app.registerExtension({
    name: "JosiaNodes.JosiaEncoder",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        // 处理 JosiaEncoder（与后端 encoder.py 的 NODE_CLASS_MAPPINGS 键一致）
        if (nodeData.name === "JosiaEncoder") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            const onConfigure = nodeType.prototype.onConfigure;
            const onConnectionsChange = nodeType.prototype.onConnectionsChange;

            // 重写节点创建方法
            nodeType.prototype.onNodeCreated = function () {
                const result = onNodeCreated?.apply(this, arguments);
                const node = this;  // 捕获节点引用，供后续回调使用（回调内 this 是 widget 而非 node）

                // 设置节点默认尺寸（宽度420px，高度550px）
                this.size = [420, 550];

                // 延迟到下一帧再同步图像接口：保证重载工作流时 configure 已先恢复连接，
                // 否则在 onNodeCreated 内直接 removeInput 会破坏链路还原。
                requestAnimationFrame(() => syncImageInputs(node));

                // 绑定开关组件的回调逻辑
                const imageRefSwitch = this.widgets.find(w => w.name === "image_reference_switch");
                const refLatentSwitch = this.widgets.find(w => w.name === "reference_latent_mode");
                const negativeSwitch = this.widgets.find(w => w.name === "negative_switch");

                // 图像参考模式开关回调
                if (imageRefSwitch) {
                    const originalCallback = imageRefSwitch.callback;
                    imageRefSwitch.callback = function() {
                        if (originalCallback) originalCallback.apply(this, arguments);
                    };
                }
                // 参考Latent模式开关回调
                if (refLatentSwitch) {
                    const originalCallback = refLatentSwitch.callback;
                    refLatentSwitch.callback = function() {
                        if (originalCallback) originalCallback.apply(this, arguments);
                    };
                }
                // 负向提示词开关回调：控制负向提示词输入框的显隐
                // 注意：布尔开关 callback 被调用时，this 指向开关 widget 本身，
                // 必须用外部捕获的 node 调用 applyNegativeVisibility，否则传入的是 widget、
                // node.widgets 为 undefined → 函数直接 return、隐藏失效。
                if (negativeSwitch) {
                    const originalCallback = negativeSwitch.callback;
                    negativeSwitch.callback = function() {
                        if (originalCallback) originalCallback.apply(this, arguments);
                        applyNegativeVisibility(node);
                    };
                }

                // 初始化时根据当前开关状态设置显隐
                applyNegativeVisibility(node);

                // 兜底：Nodes 2.0（Vue）挂载时可能重置 widget.hidden，
                // 下一帧再固化一次（此时负向开关值已是恢复后的真实值）。
                if (typeof requestAnimationFrame === "function") {
                    requestAnimationFrame(() => applyNegativeVisibility(node));
                }

                return result;
            };

            // 节点被配置/恢复时调用：重载工作流、撤销/重做(redo/undo) 均会触发，
            // 且此时 negativeSwitch.value 已是恢复后的真实值。必须重新应用 hidden，
            // 否则框会停留在 onNodeCreated 中按默认值(true=可见) 设置的可见状态。
            nodeType.prototype.onConfigure = function () {
                const r = onConfigure?.apply(this, arguments);
                applyNegativeVisibility(this);
                syncImageInputs(this);
                return r;
            };

            // 连接发生变化（接入/断开图像）时，按链式规则刷新图像接口显隐
            nodeType.prototype.onConnectionsChange = function () {
                const r = onConnectionsChange?.apply(this, arguments);
                syncImageInputs(this);
                return r;
            };
        }
    }
});
