/**
 * Josia Flow Valve - 流量阀门节点前端样式扩展
 * 功能：
 * 1. 适配Python端 JosiaFlowValve 节点，自定义前端显示样式；
 * 2. 固定节点宽度（320px），避免控件显示错乱；
 * 3. 统一"通道"/"输入"类控件的标签样式（字体大小、颜色）；
 * 节点英文标识：JosiaFlowValve（与Python端类名严格一致）
 * 节点中文显示名：Josia流量阀门
 * 本地文件名：flow_valve.js
 */

import { app } from "../../../scripts/app.js";

// 注册扩展：自定义Josia流量阀门节点样式
app.registerExtension({
    name: "Josia.FlowValve",  // 扩展名称（标识FlowValve节点扩展）
    /**
     * 节点创建后钩子：自定义节点样式
     * @param {object} node - 创建的节点实例
     */
    async nodeCreated(node) {
        // 仅适配JosiaFlowValve节点（与Python端类名匹配）
        if (node.comfyClass === "JosiaFlowValve") {
            // 固定节点宽度（避免控件显示错乱，核心样式配置）
            node.width = 320;
            
            // 遍历节点控件，统一"通道"/"输入"类控件的标签样式
            node.widgets.forEach(widget => {
                if (widget.name.startsWith("通道") || widget.name.startsWith("输入")) {
                    widget.labelStyle = { 
                        fontSize: "14px",  // 标签字体大小
                        color: "#eee"      // 标签字体颜色（浅灰色，适配暗黑主题）
                    };
                }
            });
        }
    }
});
