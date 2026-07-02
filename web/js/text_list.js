/**
 * JosiaTextList 前端扩展 v2.1.0
 * 功能：搜索关键词 + 显示分割后的文本列表（保留开关按钮，支持列表/完整文本模式）
 * 本地文件名：text_list.js
 * 匹配后端节点标识：JosiaTextList
 */
import { app } from "../../../scripts/app.js";
import { ComfyWidgets } from "../../../scripts/widgets.js";

app.registerExtension({
    name: "JosiaNodes.JosiaTextList",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "JosiaTextList") return;
        const keywords = ["文本列表", "text list", "string to list",
            "字符串转列表", "多行分割", "提示词列表", "prompt list"];
        if (!nodeType.searchKeywords) nodeType.searchKeywords = [];
        if (Array.isArray(nodeType.searchKeywords)) {
            keywords.forEach(k => {
                if (!nodeType.searchKeywords.includes(k)) nodeType.searchKeywords.push(k);
            });
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            this._staticWidgetCount = this.widgets.length;
        };

        function populate(text, isListMode) {
            const count = this._staticWidgetCount ?? 0;
            for (let i = count; i < this.widgets.length; i++) {
                this.widgets[i].onRemove?.();
            }
            this.widgets.length = count;

            if (isListMode) {
                const v = [...text];
                if (!v[0]) {
                    v.shift();
                }
                for (let list of v) {
                    if (!(list instanceof Array)) list = [list];
                    for (const l of list) {
                        const w = ComfyWidgets["STRING"](this, "text_" + (this.widgets?.length ?? 0), ["STRING", { multiline: true }], app).widget;
                        w.inputEl.readOnly = true;
                        w.inputEl.style.opacity = 0.6;
                        w.value = l;
                    }
                }
            } else {
                const fullText = Array.isArray(text) ? text.join("\n") : text;
                const w = ComfyWidgets["STRING"](this, "text_full", ["STRING", { multiline: true }], app).widget;
                w.inputEl.readOnly = true;
                w.inputEl.style.opacity = 0.6;
                w.value = fullText;
            }

            requestAnimationFrame(() => {
                const sz = this.computeSize();
                if (sz[0] < this.size[0]) {
                    sz[0] = this.size[0];
                }
                if (sz[1] < this.size[1]) {
                    sz[1] = this.size[1];
                }
                this.onResize?.(sz);
                app.graph.setDirtyCanvas(true, false);
            });
        }

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            populate.call(this, message.text, message.is_list_mode);
        };

        const VALUES = Symbol();
        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function () {
            this[VALUES] = arguments[0]?.widgets_values;
            return configure?.apply(this, arguments);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            const widgets_values = this[VALUES];
            if (widgets_values?.length) {
                requestAnimationFrame(() => {
                    const count = this._staticWidgetCount ?? 0;
                    const displayModeIdx = count - 1;
                    const isListMode = displayModeIdx >= 0 ? !widgets_values[displayModeIdx] : true;
                    populate.call(this, widgets_values.slice(count), isListMode);
                });
            }
        };
    },
});
