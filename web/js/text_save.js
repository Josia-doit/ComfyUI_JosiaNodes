/**
 * JosiaTextSave 前端扩展 v1.20
 * 功能：选择输出目录、打开输出目录、图像输入联动
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

            // ── 选择输出目录按钮（原「选择文件夹」，置于文本内容之后）──
            const folderBtn = node.addWidget("button", "选择输出目录", "", async () => {
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
            // 关键：按钮不参与序列化（保存/加载两端都跳过 serialize===false），
            // 这样无论放在节点顶部还是底部，都不会挤动下面字段的 widgets_values 对齐顺序
            folderBtn.serialize = false;

            // ── 打开输出目录按钮（置于保存格式之后）──
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
            openBtn.serialize = false;

            // ── 重新排布 widget 顺序（同步执行，避免异步时机导致保存/加载错位）──
            // 目标顺序：文本内容 → [选择输出目录按钮] → 输出路径 → 文件名 → 保存格式 → [打开输出目录按钮]
            // 两个按钮均 serialize=false，保存/加载两端对称跳过，插入到中部也不会挤动其它字段对齐
            const w = node.widgets;
            const _remove = (x) => { const i = w.indexOf(x); if (i !== -1) w.splice(i, 1); };
            _remove(folderBtn);
            _remove(openBtn);

            const _idx = (name) => w.findIndex(x => x.name === name);
            const iText = _idx("text");
            if (iText !== -1) w.splice(iText + 1, 0, folderBtn);   // 选择输出目录按钮紧跟文本内容
            const iExt = _idx("file_extension");
            if (iExt !== -1) w.splice(iExt + 1, 0, openBtn);       // 打开输出目录按钮紧跟保存格式

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
