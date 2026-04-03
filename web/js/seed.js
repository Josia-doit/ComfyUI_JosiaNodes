/**
 * Josia 随机种子节点前端扩展
 * 功能：添加快捷按钮（每次随机/新固定随机/使用上一次种子），自动回填上一次生成的种子
 * 本地文件名：seed.js
 * 匹配后端节点标识：JosiaSeed
 * 依赖：app（ComfyUI核心）
 */
import { app } from "/scripts/app.js";

// 特殊种子值定义（与后端保持一致）
const SPECIAL_SEED_RANDOM = -1;        // 每次随机
const SPECIAL_SEED_INCREMENT = -2;     // 递增
const SPECIAL_SEED_DECREMENT = -3;     // 递减
const SPECIAL_SEEDS = [SPECIAL_SEED_RANDOM, SPECIAL_SEED_INCREMENT, SPECIAL_SEED_DECREMENT];
const LAST_SEED_BUTTON_LABEL = "♻️ (使用上一次种子)";

// 注册ComfyUI扩展
app.registerExtension({
    name: "josia.seed",
    async setup() {
        // 延迟初始化（避免与ComfyUI核心加载冲突）
        await new Promise(resolve => setTimeout(resolve, 500));
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        // 仅处理JosiaSeed节点（与后端py文件的NODE_CLASS_MAPPINGS键一致）
        if (nodeData.name === "JosiaSeed") {
            const origOnCreated = nodeType.prototype.onNodeCreated;
            
            // 重写节点创建方法
            nodeType.prototype.onNodeCreated = function () {
                origOnCreated?.apply(this, arguments);

                // 初始化变量：存储上一次种子、种子组件、控制组件
                this.lastSeed = undefined;
                let seedWidget = null;
                let controlAfterGenerateWidget = null;

                // 查找种子输入组件和控制组件
                for (let i = 0; i < this.widgets.length; i++) {
                    const w = this.widgets[i];
                    if (w.name === "seed") {
                        seedWidget = w;
                    } else if (w.name === "control_after_generate") {
                        controlAfterGenerateWidget = w;
                    }
                }

                // 移除多余的控制组件（优化界面）
                if (controlAfterGenerateWidget) {
                    const idx = this.widgets.indexOf(controlAfterGenerateWidget);
                    if (idx !== -1) {
                        this.widgets.splice(idx, 1);
                    }
                }

                // 未找到种子组件则终止
                if (!seedWidget) return;

                // 1. 添加「🎲 每次随机」按钮
                this.addWidget("button", "🎲 每次随机", "", () => {
                    seedWidget.value = SPECIAL_SEED_RANDOM;
                }, { tooltip: "设置seed为-1，每次队列都会生成新的随机种子" });

                // 2. 添加「🎲 新固定随机」按钮
                this.addWidget("button", "🎲 新固定随机", "", () => {
                    const min = 0;
                    const max = 1125899906842624;
                    seedWidget.value = Math.floor(Math.random() * (max - min)) + min;
                }, { tooltip: "生成一个新的固定种子，不会随队列变化" });

                // 3. 添加「♻️ 使用上一次种子」按钮
                const lastSeedButton = this.addWidget("button", LAST_SEED_BUTTON_LABEL, "", () => {
                    if (this.lastSeed != null) {
                        seedWidget.value = this.lastSeed;
                    }
                    lastSeedButton.name = LAST_SEED_BUTTON_LABEL;
                    lastSeedButton.disabled = true;
                }, { tooltip: "回填上一次成功生成的种子，方便复现结果" });
                
                // 初始化按钮状态
                lastSeedButton.disabled = true;
                this.lastSeedButton = lastSeedButton;

                // 重写节点执行完成方法（记录上一次种子）
                const origOnExecuted = this.onExecuted;
                this.onExecuted = function (output) {
                    origOnExecuted?.apply(this, arguments);
                    if (output && output.seed != null) {
                        this.lastSeed = output.seed;
                        this.lastSeedButton.name = `♻️ ${this.lastSeed}`;
                        this.lastSeedButton.disabled = false;
                    }
                };
            };
        }
    },
});
