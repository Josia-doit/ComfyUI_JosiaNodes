/**
 * JosiaTextSave 前端扩展 v1.18
 * 功能：选择文件夹、打开输出目录、图像输入联动
 * 本地文件名：text_save.js
 * 匹配后端节点标识：JosiaTextSave
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

app.registerExtension({
    name: "JosiaNodes.JosiaTextSave",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "JosiaTextSave") return;

        const keywords = ["文本保存", "text save", "save text to file",
            "保存文本", "写入文件", "保存文件", "输出文本"];
        if (!nodeType.searchKeywords) nodeType.searchKeywords = [];
        if (Array.isArray(nodeType.searchKeywords)) {
            keywords.forEach(k => {
                if (!nodeType.searchKeywords.includes(k)) nodeType.searchKeywords.push(k);
            });
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;

            // ── 选择文件夹按钮（移到 output_path 上方）──
            const folderBtn = node.addWidget("button", "选择文件夹", "", async () => {
                try {
                    const resp = await api.fetchApi("/josia_text_save/pick_folder", { method: "POST" });
                    const data = await resp.json();
                    if (data && data.path) {
                        const outputPathW = node.widgets.find(w => w.name === "output_path");
                        if (outputPathW) {
                            outputPathW.value = data.path;
                            if (outputPathW.callback) outputPathW.callback(data.path);
                            node.setDirtyCanvas(true, true);
                        }
                    }
                } catch (e) {
                    console.error("[JosiaTextSave] 文件夹选择失败:", e);
                }
            }, { tooltip: "打开系统文件夹选择对话框" });

            // ── 打开输出目录按钮（移到最底部）──
            const openBtn = node.addWidget("button", "打开输出目录", "", async () => {
                const outputPathW = node.widgets.find(w => w.name === "output_path");
                const path = outputPathW ? outputPathW.value : "";
                if (!path) {
                    console.warn("[JosiaTextSave] 输出路径为空");
                    return;
                }
                try {
                    await api.fetchApi("/josia_text_save/open_folder", {
                        method: "POST",
                        body: JSON.stringify({ path }),
                    });
                } catch (e) {
                    console.error("[JosiaTextSave] 打开文件夹失败:", e);
                }
            }, { tooltip: "在文件资源管理器中打开当前输出路径" });

            // ── 重新排序 widgets ──
            requestAnimationFrame(() => {
                const w = node.widgets;

                // 移动 folderBtn 到 output_path 上方
                const fi = w.findIndex(x => x === folderBtn);
                if (fi !== -1) {
                    w.splice(fi, 1);
                    const pi = w.findIndex(x => x.name === "output_path");
                    w.splice(pi, 0, folderBtn);
                }

                // 移动 openBtn 到最底部
                const oi = w.findIndex(x => x === openBtn);
                if (oi !== -1 && oi < w.length - 1) {
                    w.splice(oi, 1);
                    w.push(openBtn);
                }

                node.setDirtyCanvas(true, true);
            });

            // ── 图像输入联动 ──
            const fileNameW = node.widgets.find(w => w.name === "file_name");

            function syncFileNameEditable() {
                const hasImage = node.inputs && node.inputs.some(
                    inp => inp.name === "image" && inp.link !== null
                );
                if (fileNameW) fileNameW.disabled = hasImage;
                if (fileNameW && fileNameW.inputEl) {
                    fileNameW.inputEl.disabled = hasImage;
                    fileNameW.inputEl.style.opacity = hasImage ? "0.4" : "1";
                }
                node.setDirtyCanvas(true, true);
            }
            syncFileNameEditable();

            const origOnConnectionsChange = node.onConnectionsChange;
            node.onConnectionsChange = function (type, slotIndex, isConnected, linkInfo, slotInfo) {
                if (origOnConnectionsChange) origOnConnectionsChange.apply(this, arguments);
                if (type === 1 && node.inputs && node.inputs[slotIndex]) {
                    if (node.inputs[slotIndex].name === "image") syncFileNameEditable();
                }
            };
        };
    },
});
