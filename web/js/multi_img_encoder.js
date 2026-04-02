/**
 * Josia文本编码节点 - 交互文件
 * 符合命名习惯，预留扩展空间
 */
import { app } from "../../scripts/app.js";

// 节点配置
const NODE_NAME = "JosiaEncoder";
// 和你截图右侧手动调整的高度完全匹配
const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 480;

app.registerExtension({
    name: "Josia.Encoder",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        console.log(`[JosiaEncoder] ✅ 节点交互文件加载成功`);

        // 节点创建时设置默认尺寸，仅此一次，后续可自由修改
        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalOnNodeCreated?.apply(this, arguments);
            this.size = [DEFAULT_WIDTH, DEFAULT_HEIGHT];
            return result;
        };

        // ========== 后续添加新功能，直接在这里写即可 ==========
    },
});