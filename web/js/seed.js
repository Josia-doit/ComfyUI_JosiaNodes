/**
 * Josia 随机种子节点前端
 *
 * 控件区为 DOM 三行布局（原生 button widget 一行只能放一个，故改用 DOM）：
 *   第 1 行：🔀 随机 / ⬆️ 递增 / ⬇️ 递减
 *   第 2 行：🎲 随机生成一个新种子
 *   第 3 行：♻️ (使用上一次种子)
 */
import { app } from "/scripts/app.js";

const SEED_RANDOM = -1;
const SEED_INC    = -2;
const SEED_DEC    = -3;
const SEED_MAX    = 1125899906842624;
const LAST_DEF    = "♻️ (使用上一次种子)";

// 控件区几何（computeSize 用）
const ROW_H   = 26;
const ROW_GAP = 6;
const TOP_PAD = 4;          // 与上方种子数字控件的分隔
const BOTTOM_MARGIN = 8;    // 固定底边距：避免新增节点时最下方按钮底边贴边（0 边距）
const BOX_H   = TOP_PAD + ROW_H * 3 + ROW_GAP * 2 + BOTTOM_MARGIN;

const STYLE_ID = "josia-seed-controls-style";
const BTN_CLS  = "josia-seed-btn";
const ROW_CLS  = "josia-seed-row";

const CSS = `
.${ROW_CLS} {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  box-sizing: border-box;
}
.${BTN_CLS} {
  flex: 1 1 0;
  min-width: 0;
  height: ${ROW_H}px;
  padding: 0 6px;
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  border-radius: 4px;
  border: 1px solid var(--border-color, #4e4e4e);
  background: var(--comfy-input-bg, #2a2a2a);
  color: var(--input-text, #ddd);
  box-sizing: border-box;
  user-select: none;
  transition: filter .12s ease;
}
.${BTN_CLS}:not(:disabled):hover  { filter: brightness(1.3); }
.${BTN_CLS}:not(:disabled):active { filter: brightness(.85); }
.${BTN_CLS}:disabled { opacity: .45; cursor: not-allowed; }
.josia-seed-root {
  display: flex;
  flex-direction: column;
  gap: ${ROW_GAP}px;
  width: 100%;
  box-sizing: border-box;
  padding: ${TOP_PAD}px 0 ${BOTTOM_MARGIN}px;
}
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

function makeButton(label, tooltip, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = BTN_CLS;
  b.textContent = label;
  b.title = tooltip || label;
  // 避免拖拽节点时误触发
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (b.disabled) return;
    onClick(b);
  });
  return b;
}

function makeRow(...children) {
  const row = document.createElement("div");
  row.className = ROW_CLS;
  children.forEach((c) => row.appendChild(c));
  return row;
}

function setEnabled(btn, on) {
  btn.disabled = !on;
}

app.registerExtension({
  name: "josia.seed",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "JosiaSeed") return;

    const origOnCreated = nodeType.prototype.onNodeCreated;

    nodeType.prototype.onNodeCreated = function () {
      origOnCreated?.apply(this, arguments);

      const node = this;
      let seedWidget = null;
      let ctrlWidget = null;

      for (const w of node.widgets || []) {
        if (w.name === "seed") seedWidget = w;
        if (w.name === "control_after_generate") ctrlWidget = w;
      }

      // 隐藏 control_after_generate COMBO
      if (ctrlWidget) {
        const i = node.widgets.indexOf(ctrlWidget);
        if (i !== -1) node.widgets.splice(i, 1);
      }

      if (!seedWidget) return;

      ensureStyles();
      node.lastSeed = undefined;

      // ── 第 1 行：🔀 随机 / ⬆️ 递增 / ⬇️ 递减 ──
      const randBtn = makeButton("🔀 随机", "seed = -1：每次队列都生成新随机种子", () => {
        seedWidget.value = SEED_RANDOM;
      });
      const incBtn = makeButton("⬆️ 递增", "seed = -2：每次执行后种子 +1", () => {
        seedWidget.value = SEED_INC;
      });
      const decBtn = makeButton("⬇️ 递减", "seed = -3：每次执行后种子 -1", () => {
        seedWidget.value = SEED_DEC;
      });
      setEnabled(incBtn, false);
      setEnabled(decBtn, false);
      const row1 = makeRow(randBtn, incBtn, decBtn);

      // ── 第 2 行：🎲 随机生成一个新种子 ──
      const newSeedBtn = makeButton("🎲 随机生成一个新种子", "生成一个新固定种子", () => {
        seedWidget.value = Math.floor(Math.random() * (SEED_MAX + 1));
      });
      const row2 = makeRow(newSeedBtn);

      // ── 第 3 行：♻️ (使用上一次种子) ──
      const lastBtn = makeButton(LAST_DEF, "回填上一次成功生成的种子", () => {
        if (node.lastSeed != null) seedWidget.value = node.lastSeed;
        lastBtn.textContent = LAST_DEF;
        setEnabled(lastBtn, false);
      });
      setEnabled(lastBtn, false);
      const row3 = makeRow(lastBtn);

      const root = document.createElement("div");
      root.className = "josia-seed-root";
      root.append(row1, row2, row3);

      const domWidget = node.addDOMWidget("seed_controls", "josia_seed_controls", root, {
        serialize: false,
      });
      domWidget.computeSize = (w) => [w, BOX_H];

      // 节点高度不足时补足（只增高，不压缩用户已保存的尺寸）
      requestAnimationFrame(() => {
        try {
          if (typeof node.computeSize !== "function") return;
          const need = node.computeSize();
          if (need && need[1] > node.size[1]) node.setSize([node.size[0], need[1]]);
          app.graph?.setDirtyCanvas(true, true);
        } catch (e) {}
      });

      // 执行完成后：记录种子 + 激活 ⬆️⬇️
      const origOnExec = node.onExecuted;
      node.onExecuted = function (output) {
        origOnExec?.apply(this, arguments);
        if (output?.seed?.length > 0) {
          node.lastSeed = output.seed[0];
          lastBtn.textContent = `♻️ ${node.lastSeed}`;
          setEnabled(lastBtn, true);
          setEnabled(incBtn, true);
          setEnabled(decBtn, true);
        }
      };
    };
  },
});
