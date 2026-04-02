import { app } from "/scripts/app.js";

const SPECIAL_SEED_RANDOM = -1;
const SPECIAL_SEED_INCREMENT = -2;
const SPECIAL_SEED_DECREMENT = -3;
const SPECIAL_SEEDS = [SPECIAL_SEED_RANDOM, SPECIAL_SEED_INCREMENT, SPECIAL_SEED_DECREMENT];
const LAST_SEED_BUTTON_LABEL = "♻️ (使用上一次种子)";

app.registerExtension({
    name: "josia.seed",
    async setup() {
        await new Promise(resolve => setTimeout(resolve, 500));
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "JosiaSeed") {
            const origOnCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                origOnCreated?.apply(this, arguments);

                this.lastSeed = undefined;
                let seedWidget = null;
                let controlAfterGenerateWidget = null;

                for (let i = 0; i < this.widgets.length; i++) {
                    const w = this.widgets[i];
                    if (w.name === "seed") {
                        seedWidget = w;
                    } else if (w.name === "control_after_generate") {
                        controlAfterGenerateWidget = w;
                    }
                }

                if (controlAfterGenerateWidget) {
                    const idx = this.widgets.indexOf(controlAfterGenerateWidget);
                    if (idx !== -1) {
                        this.widgets.splice(idx, 1);
                    }
                }

                if (!seedWidget) return;

                // 1. 🎲 每次随机（中文）
                this.addWidget("button", "🎲 每次随机", "", () => {
                    seedWidget.value = SPECIAL_SEED_RANDOM;
                }, { tooltip: "设置seed为-1，每次队列都会生成新的随机种子" });

                // 2. 🎲 新固定随机（中文）
                this.addWidget("button", "🎲 新固定随机", "", () => {
                    const min = 0;
                    const max = 1125899906842624;
                    seedWidget.value = Math.floor(Math.random() * (max - min)) + min;
                }, { tooltip: "生成一个新的固定种子，不会随队列变化" });

                // 3. ♻️ 使用上一次种子（中文）
                const lastSeedButton = this.addWidget("button", LAST_SEED_BUTTON_LABEL, "", () => {
                    if (this.lastSeed != null) {
                        seedWidget.value = this.lastSeed;
                    }
                    lastSeedButton.name = LAST_SEED_BUTTON_LABEL;
                    lastSeedButton.disabled = true;
                }, { tooltip: "回填上一次成功生成的种子，方便复现结果" });
                lastSeedButton.disabled = true;
                this.lastSeedButton = lastSeedButton;

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