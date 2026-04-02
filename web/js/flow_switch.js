import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "Josia.FlowSwitch",
    async setup() {
        app.graph.onNodeCreated = (node) => {
            if (node.type === "JosiaFlowSwitch") {
                // 1. 把输入input_1-input_5改成输入①-输入⑤，完美对齐输出
                const inputCircle = ["①", "②", "③", "④", "⑤"];
                node.inputs?.forEach((input, idx) => {
                    input.name = `输入${inputCircle[idx]}`;
                });

                // 2. 调整节点尺寸，适配美化后的开关文字
                node.size = [360, 280];

                // 3. 优化开关宽度，让文字完全对齐
                node.widgets?.forEach(w => {
                    if (w.name.startsWith("ch")) {
                        w.computeSize = () => [320, 32];
                    }
                });
            }
        };
    }
});