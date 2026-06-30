/**
 * JosiaTextList 前端扩展
 * 功能：添加搜索关键词
 * 本地文件名：text_list.js
 * 匹配后端节点标识：JosiaTextList
 */
import { app } from "../../../scripts/app.js";

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
    },
});
