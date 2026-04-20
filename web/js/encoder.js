/**
 * Josia 文本编码节点前端扩展
 * 功能：设置节点默认尺寸、绑定开关回调逻辑
 * 本地文件名：encoder.js（全小写）
 * 匹配后端节点标识：JosiaEncoder
 * 依赖：app（ComfyUI核心）、ComfyWidgets（ComfyUI组件）
 */
import { app } from "../../../scripts/app.js";
import { ComfyWidgets } from "../../../scripts/widgets.js";

// 注册ComfyUI扩展（扩展名匹配节点标识）
app.registerExtension({
    name: "JosiaNodes.JosiaEncoder",
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        // 仅处理JosiaEncoder节点（与后端py文件的NODE_CLASS_MAPPINGS键一致）
        if (nodeData.name === "JosiaEncoder") { 
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            
            // 重写节点创建方法
            nodeType.prototype.onNodeCreated = function () {
                const result = onNodeCreated?.apply(this, arguments);
                
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
                const negativePromptWidget = this.widgets.find(w => w.name === "negative_prompt");
                if (negativeSwitch && negativePromptWidget) {
                    const originalCallback = negativeSwitch.callback;
                    negativeSwitch.callback = function(value) {
                        if (originalCallback) originalCallback.apply(this, arguments);
                        // value = true: 负向提示词生效，显示输入框
                        // value = false: 负向提示词归零，隐藏输入框
                        negativePromptWidget.hidden = !value;
                        // 标记需要重绘，但不改变节点尺寸
                        this.setDirtyCanvas(true, true);
                    }.bind(this);
                    
                    // 初始化时根据当前开关状态设置显隐
                    negativePromptWidget.hidden = !negativeSwitch.value;
                }
                
                return result;
            };
        }
    }
});
