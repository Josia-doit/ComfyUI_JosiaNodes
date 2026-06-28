/**
 * Josia 随机种子节点前端 v7.2.2
 *
 * 基于 v7.0 原生 addWidget("button") 方案，仅新增 2 个递增/递减按钮。
 * 不使用任何自定义 DOM/CSS，保持与原生 ComfyUI 按钮完全一致的样式。
 */
import { app } from "/scripts/app.js";

const SEED_RANDOM = -1;
const SEED_INC   = -2;
const SEED_DEC   = -3;
const LAST_DEF   = "♻️ (使用上一次种子)";

app.registerExtension({
    name: "josia.seed",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "JosiaSeed") return;

        const origOnCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            origOnCreated?.apply(this, arguments);

            let seedWidget = null;
            let ctrlWidget = null;

            for (const w of this.widgets) {
                if (w.name === "seed")       seedWidget = w;
                if (w.name === "control_after_generate") ctrlWidget = w;
            }

            // 隐藏 control_after_generate COMBO
            if (ctrlWidget) {
                const i = this.widgets.indexOf(ctrlWidget);
                if (i !== -1) this.widgets.splice(i, 1);
            }

            if (!seedWidget) return;

            // ── 1. 🎲 每次随机 ──
            this.addWidget("button", "🎲 每次随机", "", () => {
                seedWidget.value = SEED_RANDOM;
            }, { tooltip: "设置seed=-1，每次队列都生成新随机种子" });

            // ── 2. ⬆️ 递增（初始灰化）───
            const incBtn = this.addWidget("button", "⬆️ 递增", "", () => {
                seedWidget.value = SEED_INC;
            }, { tooltip: "seed=-2，每次执行后种子+1" });
            incBtn.disabled = true;
            this._incBtn = incBtn;

            // ── 3. ⬇️ 递减（初始灰化）───
            const decBtn = this.addWidget("button", "⬇️ 递减", "", () => {
                seedWidget.value = SEED_DEC;
            }, { tooltip: "seed=-3，每次执行后种子-1" });
            decBtn.disabled = true;
            this._decBtn = decBtn;

            // ── 4. 🎲 固定随机 ──
            this.addWidget("button", "🎲 固定随机", "", () => {
                seedWidget.value = Math.floor(Math.random() * 1125899906842625);
            }, { tooltip: "生成一个新固定种子" });

            // ── 5. ♻️ 使用上一次种子 ──
            this.lastSeed = undefined;
            const lastBtn = this.addWidget("button", LAST_DEF, "", () => {
                if (this.lastSeed != null) seedWidget.value = this.lastSeed;
                lastBtn.name = LAST_DEF;
                lastBtn.disabled = true;
            }, { tooltip: "回填上一次成功生成的种子" });
            lastBtn.disabled = true;
            this.lastSeedBtn = lastBtn;

            // onExecuted：记录种子 + 激活 ⬆️⬇️
            const origOnExec = this.onExecuted;
            this.onExecuted = function (output) {
                origOnExec?.apply(this, arguments);
                if (output?.seed?.length > 0) {
                    this.lastSeed = output.seed[0];
                    this.lastSeedBtn.name = `♻️ ${this.lastSeed}`;
                    this.lastSeedBtn.disabled = false;

                    // 有历史种子 → 激活递增/递减
                    if (this._incBtn) this._incBtn.disabled = false;
                    if (this._decBtn) this._decBtn.disabled = false;
                }
            };
        };
    },
});
