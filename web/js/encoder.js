/**
 * Josia 文本编码节点前端扩展
 * 功能：设置节点默认尺寸、绑定开关回调逻辑
 * 本地文件名：encoder.js（全小写）
 * 匹配后端节点标识：JosiaEncoder
 * 依赖：app（ComfyUI核心）、ComfyWidgets（ComfyUI组件）
 */
import { app } from "../../../scripts/app.js";
import { ComfyWidgets } from "../../../scripts/widgets.js";

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

            // 重写节点创建方法
            nodeType.prototype.onNodeCreated = function () {
                const result = onNodeCreated?.apply(this, arguments);
                const node = this;  // 捕获节点引用，供后续回调使用（回调内 this 是 widget 而非 node）

                // 设置节点默认尺寸（宽度420px，高度550px）
                this.size = [420, 550];

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
                return r;
            };
        }
    }
});
