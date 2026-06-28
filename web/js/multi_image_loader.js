/**
 * JosiaMultiImageLoader 前端 v7.2
 *
 * v7.2 改进（完全重做递增机制 — 抛弃 control_after_generate）:
 * - ★ 后端维护 self._next_index，通过 PromptServer 自定义消息 "josia_mil_inc" 通知前端
 * - ★ 监听 josia_mil_inc 消息 → 更新 output_index widget（后递增+1）
 * - ★ ★ api.addEventListener 接收 CustomEvent，数据在 event.detail 里（不是 raw dict！）
 * - ★ 支持工作流运行和下游预览单独执行（自定义消息不限返回格式）
 * - ★ 达到最大值归零（next_index=0，显示0=已全部输出完毕），不循环
 * - ★ 序号=0 时输出空列表，下游不执行，提示用户恢复默认后再运行
 * - ★ 上游端口连接/断开 → 序号自动复位为1（onConnectionsChange）
 * - ★ 恢复默认按钮：重置参数（output_index→1），不清空图库，不切换输出模式
 * - ★ display_name: 输出序号→下次输出序号（避免歧义）
 * - ★ 移除所有 control_after_generate COMBO 搜索/隐藏代码
 * - ★ 移除 afterQueued 备用方案
 *
 * v7.1: control_after_generate 种子递增尝试（已废弃）
 * v7.0: 输出序号 + 原生开关 + 自动递增
 * v6.9: 输出模式开关 + 端口改名 images_out
 * v6.8: 真正的 N 步渐进缩放 + Emoji统一
 * v6.7: 标准上传 API + Emoji更换
 * v6.6: 完全基于对标节点重做布局系统
 * v6.0: 每图独立等比缩放 + 图库自适应 optimizeGrid
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MAX_OUTPUTS = 50;
const DEFAULT_NODE_WIDTH = 380;

// ═══ CSS ════════════════════════════════════════
const STYLES = `
.josia-mil-container {
    width:100%; box-sizing:border-box;
    background:var(--bg-color,#1a1a1a);
    border:1px solid var(--border-color,#333);
    border-radius:6px; margin-top:6px; padding:8px;
    display:flex; flex-direction:column; gap:6px;
    pointer-events:auto; overflow:hidden; margin-left:0; margin-right:0;
}
/* Toolbar */
.josia-mil-toolbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.josia-mil-btn{
    padding:4px 10px;border-radius:4px;border:1px solid #555;cursor:pointer;
    font-size:11px;font-family:inherit;white-space:nowrap;transition:background .15s
}
.josia-mil-btn-primary{background:#3a6fd8;color:#fff;border-color:#2a5fc8}
.josia-mil-btn-primary:hover{background:#4a7fe8}
.josia-mil-btn-danger{background:#c0392b;color:#fff;border-color:#a93226}
.josia-mil-btn-danger:hover{background:#e74c3c}
.josia-mil-btn-normal{background:#2a2a2a;color:#ccc}
.josia-mil-btn-normal:hover{background:#3a3a3a}
.josia-mil-btn-toggle{background:#2a2a2a;color:#ccc;border-color:#555;font-weight:normal}
.josia-mil-btn-toggle:hover{background:#3a3a3a}
.josia-mil-btn-toggle.active{background:#4a3a6d;color:#c8b0ff;border-color:#6a5a8d;font-weight:bold}
.josia-mil-count{font-size:11px;color:#888;margin-left:auto}
/* Grid wrapper — 参考对标节点：绝对定位填满区域 */
.josia-mil-grid-wrapper{
    position:relative;flex-grow:1;width:100%;min-height:0;
}
/* Grid — CSS grid，由 optimizeGrid 动态设置列数和行高 */
.josia-mil-grid{
    position:absolute;top:0;left:0;right:0;bottom:0;
    display:grid;gap:6px;
    justify-content:center;align-content:center;
}
/* 缩略图容器 — 填满 grid cell，无限缩放 */
.josia-mil-thumb-wrap{
    position:relative;width:100%;height:100%;
    display:flex;align-items:center;justify-content:center;
    border:2px solid transparent;border-radius:4px;overflow:hidden;
    cursor:grab;background:#111;
}
.josia-mil-thumb-wrap:hover{border-color:#3a6fd8}
.josia-mil-thumb-img{
    display:block;width:100%;height:100%;
    object-fit:contain;pointer-events:none;
    -webkit-user-drag:none;user-select:none;
    opacity:0;transition:opacity .3s
}
.josia-mil-thumb-img.loaded{opacity:1}
/* Overlay labels */
.josia-mil-overlay-top{
    position:absolute;top:0;left:0;right:0;
    display:flex;justify-content:space-between;align-items:flex-start;padding:1px 3px;
    background:linear-gradient(to bottom,rgba(0,0,0,.65) 0%,transparent 100%);
    pointer-events:none;z-index:1
}
.josia-mil-badge-index{
    font-size:9px;color:#fff;font-weight:bold;
    background:rgba(0,0,0,.55);padding:0 4px;border-radius:2px
}
.josia-mil-badge-res{
    font-size:8px;color:#bbb;
    background:rgba(0,0,0,.55);padding:0 4px;border-radius:2px
}
.josia-mil-overlay-bottom{
    position:absolute;bottom:0;left:0;right:0;
    padding:1px 3px;
    background:linear-gradient(to top,rgba(0,0,0,.65) 0%,transparent 100%);
    pointer-events:none;z-index:1
}
.josia-mil-filename{
    font-size:8px;color:#ddd;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis;display:block;text-align:center
}
.josia-mil-thumb-delete{
    position:absolute;top:1px;right:1px;width:16px;height:16px;
    border-radius:50%;background:rgba(200,0,0,.75);color:#fff;border:none;
    font-size:11px;line-height:16px;text-align:center;cursor:pointer;
    display:none;z-index:2;padding:0
}
.josia-mil-thumb-wrap:hover .josia-mil-thumb-delete{display:block}
.josia-mil-placeholder{
    display:flex;align-items:center;justify-content:center;
    color:#555;font-size:12px;padding:20px;text-align:center;
    min-height:80px;width:100%
}`;

let styleInjected = false;
function injectStyles() {
    if (styleInjected) return;
    const s = document.createElement("style");
    s.textContent = STYLES;
    document.head.appendChild(s);
    styleInjected = true;
}

app.registerExtension({
    name: "Josia.MultiImageLoader",

    async nodeCreated(node) {
        if (node.comfyClass !== "JosiaMultiImageLoader") return;
        try {
            await initNode(node);
        } catch(err) {
            console.error("[Josia多图加载] 初始化失败:", err);
        }
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "JosiaMultiImageLoader") return;
        const keywords = ["多图加载", "multi image", "multiimage",
            "batch load", "批量加载", "图库", "gallery",
            "加载多张", "图像列表", "image list"];
        if (!nodeType.searchKeywords) nodeType.searchKeywords = [];
        if (Array.isArray(nodeType.searchKeywords)) {
            keywords.forEach(k => {
                if (!nodeType.searchKeywords.includes(k)) nodeType.searchKeywords.push(k);
            });
        }
    },
});

// ══════════════════════════════════════════════════
async function initNode(node) {
    injectStyles();
    await node.loaded;

    // 尽早获取 input 目录
    getInputDir().catch(() => {});

    // ── 查找 widgets（v6.0 新参数结构）──
    const pathsW         = node.widgets.find(w => w.name === "image_paths");
    const resizeModeW    = node.widgets.find(w => w.name === "resize_mode");
    const megapixelsW    = node.widgets.find(w => w.name === "megapixels");
    const resStepsW      = node.widgets.find(w => w.name === "resolution_steps");
    const edgeDirectionW = node.widgets.find(w => w.name === "edge_direction");
    const edgeValueW     = node.widgets.find(w => w.name === "edge_value");
    const outputModeW    = node.widgets.find(w => w.name === "output_mode");
    const outputIdxW     = node.widgets.find(w => w.name === "output_index");

    // ── widget 显隐辅助 ──
    function setWidgetVisible(w, visible) {
        if (!w) return;
        try {
            w.hidden = !visible;
            if (w.element) w.element.style.display = visible ? "" : "none";
            const rowEl = w.inputEl && (w.inputEl.closest(".comfy-widget-row") || w.inputEl.closest(".widget-row"));
            if (rowEl) rowEl.style.display = visible ? "" : "none";
        } catch(e) {}
    }

    // v6.4/v6.7: 缩放模式切换 — BOOLEAN 开关触发参数显隐
    // resize_mode: 🖼️=按像素缩放 → 显示 megapixels+steps; 📐=按边长缩放 → 显示 edge_direction+edge_value
    function syncWidgetVisibility() {
        if (!resizeModeW) return;
        const isPixel = !!resizeModeW.value;  // BOOLEAN: true=按像素缩放, false=按边长缩放
        // 按像素缩放参数
        setWidgetVisible(megapixelsW, isPixel);
        setWidgetVisible(resStepsW, isPixel);
        // 按边长缩放参数
        setWidgetVisible(edgeDirectionW, !isPixel);
        setWidgetVisible(edgeValueW, !isPixel);
        // v7.0: output_index 灰化 — 批次模式不可编辑
        syncOutputIndexEditable();
    }

    // ★ v7.2: output_index 灰化逻辑（简化版 — 不再操作 COMBO widget）
    // 批次模式：灰化 output_index（不可编辑，序号不递增）
    // 列表模式：可编辑 output_index（后端执行后自动递增）
    function syncOutputIndexEditable() {
        if (!outputIdxW || !outputModeW) return;
        const isList = !!outputModeW.value;
        try {
            outputIdxW.disabled = !isList;
            const rowEl = outputIdxW.inputEl && (
                outputIdxW.inputEl.closest(".comfy-widget-row") ||
                outputIdxW.inputEl.closest(".widget-row")
            );
            if (rowEl) {
                rowEl.style.opacity = isList ? "1" : "0.4";
                rowEl.style.pointerEvents = isList ? "auto" : "none";
            }
            if (outputIdxW.inputEl) {
                outputIdxW.inputEl.disabled = !isList;
                outputIdxW.inputEl.style.opacity = isList ? "1" : "0.4";
            }
        } catch(e) { /* 静默 */ }
    }

    if (resizeModeW) {
        const origCallback = resizeModeW.callback || (()=>{});
        resizeModeW.callback = function(v) {
            origCallback(v);
            syncWidgetVisibility();
            node.setDirtyCanvas(true, true);
        };
    }

    // ★ v7.0: output_mode callback — 切换列表/批次时更新 output_index 灰化状态
    if (outputModeW) {
        const origModeCallback = outputModeW.callback || (()=>{});
        outputModeW.callback = function(v) {
            origModeCallback(v);
            syncOutputIndexEditable();
            node.setDirtyCanvas(true, true);
        };
    }

    // ── DOMWidget 容器（图库区）──
    const container = document.createElement("div");
    container.className = "josia-mil-container";

    const toolbar = document.createElement("div");
    toolbar.className = "josia-mil-toolbar";
    container.appendChild(toolbar);

    // ★ v6.0: 参考对标节点 — gridWrapper + 绝对定位 grid
    const gridWrapper = document.createElement("div");
    gridWrapper.className = "josia-mil-grid-wrapper";

    const grid = document.createElement("div");
    grid.className = "josia-mil-grid";
    gridWrapper.appendChild(grid);
    container.appendChild(gridWrapper);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.multiple = true;
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    container.appendChild(fileInput);

    let imageItems = [];

    const galleryWidget = node.addDOMWidget("gallery", "html_gallery", container, {
        serialize: false,
        getValue() { return JSON.stringify(imageItems.map(i => i.path)); },
        setValue(v) {
            if (v) {
                try {
                    const arr = JSON.parse(v);
                    if (Array.isArray(arr)) addImages(arr).catch(() => {});
                } catch(e) {}
            }
        },
    });

    // ═══ v6.2: 绝对路径去重 — 记录已载入图片的原始绝对路径 ═══
    const loadedAbsPaths = new Set();  // 存储已载入图片的绝对路径（用于去重）

    // 规范化绝对路径（统一分隔符、去除尾部斜杠）
    function normalizeAbsPath(p) {
        if (!p) return "";
        return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    }

    // 从已加载的 imageItems 初始化去重集合
    function rebuildAbsPathSet() {
        loadedAbsPaths.clear();
        for (const item of imageItems) {
            if (item.absPath) loadedAbsPaths.add(normalizeAbsPath(item.absPath));
            else if (item.path) loadedAbsPaths.add(normalizeAbsPath(item.path));
        }
    }
    function parsePaths() {
        if (!pathsW) return [];
        return (pathsW.value || "").split("\n").map(s => s.trim()).filter(Boolean);
    }
    function writePaths(paths) {
        if (!pathsW) return;
        pathsW.value = paths.join("\n");
    }

    // ═══ 动态输出端口（完全对标 syncOutputs 模式）═══
    // ★ v6.6: 检测 wasFresh 状态（outputs>=50 说明是 RETURN_TYPES 声明的初始值）
    // 返回 { changed, wasFresh } 供调用方决定是否 force-shrink
    let outputApiMethod = null;
    function detectOutputAPI() {
        if (outputApiMethod !== null) return outputApiMethod;
        try {
            outputApiMethod = (typeof node.removeOutput === "function" && typeof node.addOutput === "function") ? "api" : "length";
        } catch(e) { outputApiMethod = "length"; }
        return outputApiMethod;
    }

    function updateOutputPorts(count) {
        const result = { changed: false, wasFresh: false };
        try {
            if (!node.outputs || node.outputs.length === 0) return result;
            const targetTotal = count + 1;
            const prevLength = node.outputs.length;

            // ★ 对标节点关键：检测 fresh 状态（初始 outputs >= 50）
            result.wasFresh = (prevLength >= 50);

            detectOutputAPI();
            if (outputApiMethod === "api") {
                while (node.outputs.length > targetTotal && node.outputs.length > 1) {
                    node.removeOutput(node.outputs.length - 1);
                }
                for (let i = node.outputs.length; i < targetTotal; i++) {
                    node.addOutput("image_" + i, "IMAGE");
                }
            } else {
                node.outputs.length = Math.min(targetTotal, MAX_OUTPUTS + 1);
            }
            result.changed = (node.outputs.length !== prevLength);
            if (result.changed) node.setDirtyCanvas(true, true);
        } catch(err) {
            console.warn("[Josia多图加载] updateOutputPorts:", err);
        }
        return result;
    }

    // ═══ 图片信息 ═══
    async function loadImageInfo(path) {
        try {
            const resp = await api.fetchApi("/josia_multi_image/info", {
                method: "POST",
                body: JSON.stringify({ path }),
                headers: { "Content-Type": "application/json" },
            });
            if (resp.ok) {
                const data = await resp.json();
                if (!data.error) return {w:data.width, h:data.height};
            }
        } catch(e) {}
        return {w:0,h:0};
    }

    let _inputDirCache = null;
    async function getInputDir() {
        if (_inputDirCache !== null) return _inputDirCache;
        try {
            const resp = await api.fetchApi("/josia_multi_image/input_dir", { method: "GET" });
            if (resp.ok) {
                const data = await resp.json();
                _inputDirCache = data.input_dir || "";
            }
        } catch(e) { _inputDirCache = ""; }
        return _inputDirCache;
    }

    function buildImageUrl(path) {
        const inputDir = _inputDirCache;
        let relPath = path;
        if (inputDir && path.startsWith(inputDir)) {
            relPath = path.slice(inputDir.length).replace(/^[\\/]/, "");
        }
        if (relPath === path && path.includes(":\\")) {
            return buildThumbnailUrl(path);
        }
        return "/api/view?filename=" + encodeURIComponent(relPath) + "&type=input";
    }

    function buildThumbnailUrl(path) {
        return "/josia_multi_image/thumbnail?path=" + encodeURIComponent(path);
    }

    // ═══ v6.0: 图库网格优化（参考对标节点 optimizeGrid）═══
    // 同时考虑图库宽度和高度，找到能让缩略图最大的列数（无限缩放）
    function optimizeGrid(gridW, gridH) {
        const N = imageItems.length;
        const gap = 6;

        if (N === 0) {
            grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(75px, 1fr))';
            grid.style.gridAutoRows = 'max-content';
            return;
        }
        if (gridW <= 0 || gridH <= 0) return;

        let bestS = 0;
        let bestCols = 1;

        for (let c = 1; c <= N; c++) {
            const r = Math.ceil(N / c);
            const maxW = Math.max(5, (gridW - (c - 1) * gap) / c);
            const maxH = Math.max(5, (gridH - (r - 1) * gap) / r);
            const size = Math.min(maxW, maxH);
            if (size >= bestS - 0.1) {
                bestS = size;
                bestCols = c;
            }
        }
        bestS = Math.max(20, Math.floor(bestS));
        grid.style.gridTemplateColumns = `repeat(${bestCols}, ${bestS}px)`;
        grid.style.gridAutoRows = `${bestS}px`;
    }

    // ═══ 渲染图库 ═══
    function renderGallery() {
        grid.innerHTML = "";

        if (imageItems.length === 0) {
            const ph = document.createElement("div");
            ph.className = "josia-mil-placeholder";
            ph.textContent = "点击「载入图像」添加图片，或拖拽/粘贴";
            grid.appendChild(ph);
            return;
        }

        for (let idx = 0; idx < imageItems.length; idx++) {
            const item = imageItems[idx];
            const wrap = document.createElement("div");
            wrap.className = "josia-mil-thumb-wrap";
            wrap.draggable = true;
            wrap.dataset.index = String(idx);

            // 占位符（加载前显示，加载后隐藏）
            const placeholder = document.createElement("div");
            placeholder.style.cssText = "color:#444;font-size:18px;pointer-events:none;";
            placeholder.textContent = "\ud83d\udcbc";
            wrap.appendChild(placeholder);

            // 图片（无限缩放：width/height 100% + object-fit contain）
            const img = document.createElement("img");
            img.className = "josia-mil-thumb-img";
            img.loading = "lazy";
            img.src = buildImageUrl(item.path);
            img.onload = () => {
                img.classList.add("loaded");
                if (placeholder.parentNode) placeholder.style.display = "none";
            };
            img.onerror = () => {
                img.src = buildThumbnailUrl(item.path);
                img.onerror = () => {
                    img.style.display = "none";
                    placeholder.textContent = "\u274c";
                    placeholder.style.color = "#a00";
                };
            };
            wrap.appendChild(img);

            // 顶部叠加：编号 + 分辨率
            const topOv = document.createElement("div");
            topOv.className = "josia-mil-overlay-top";
            const bIdx = document.createElement("span");
            bIdx.className = "josia-mil-badge-index";
            bIdx.textContent = "#" + (idx + 1);
            const bRes = document.createElement("span");
            bRes.className = "josia-mil-badge-res";
            bRes.textContent = (item.w && item.h) ? item.w + "\u00d7" + item.h : "";
            topOv.appendChild(bIdx);
            topOv.appendChild(bRes);

            // 底部叠加：文件名
            const botOv = document.createElement("div");
            botOv.className = "josia-mil-overlay-bottom";
            const fnLbl = document.createElement("span");
            fnLbl.className = "josia-mil-filename";
            fnLbl.textContent = item.name;
            botOv.appendChild(fnLbl);

            // 删除按钮
            const delBtn = document.createElement("button");
            delBtn.className = "josia-mil-thumb-delete";
            delBtn.textContent = "\u00d7";
            delBtn.onclick = (e) => { e.stopPropagation(); e.preventDefault(); removeImage(idx); };

            // 拖拽排序
            wrap.ondragstart = (e) => {
                e.dataTransfer.setData("text/plain", String(idx));
                wrap.classList.add("dragging");
            };
            wrap.ondragend = () => wrap.classList.remove("dragging");
            wrap.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect="move"; };
            wrap.ondrop = (e) => {
                e.preventDefault();
                const fi = parseInt(e.dataTransfer.getData("text/plain"));
                const ti = parseInt(wrap.dataset.index);
                if (!isNaN(fi) && !isNaN(ti) && fi !== ti) reorderImages(fi, ti);
            };

            wrap.appendChild(topOv);
            wrap.appendChild(botOv);
            wrap.appendChild(delBtn);
            grid.appendChild(wrap);
        }

        const countSpan = toolbar.querySelector(".josia-mil-count");
        if (countSpan) countSpan.textContent = imageItems.length > 0
            ? imageItems.length + " 张" : "";

        // 渲染后立即优化网格布局
        requestAnimationFrame(() => {
            if (gridWrapper.offsetWidth > 0) {
                optimizeGrid(gridWrapper.offsetWidth, gridWrapper.offsetHeight);
            }
        });
    }

    // ═══ 图像上传（v6.7: 对标节点模式 — 使用 ComfyUI 标准 /upload/image API）═══
    // ★ v6.7 关键修复：不再使用 f.path + 自定义 /josia_multi_image/upload，
    //   改为与对标节点完全一致：FormData + /upload/image（ComfyUI 标准接口）
    async function handleFiles(files) {
        if (!files || files.length === 0) return;
        const uploaded = [];
        for (const f of files) {
            const body = new FormData();
            body.append("image", f);
            try {
                const resp = await api.fetchApi("/upload/image", { method: "POST", body });
                if (resp.status === 200) {
                    const data = await resp.json();
                    let name = data.name;
                    if (data.subfolder) name = data.subfolder + "/" + name;
                    uploaded.push(name);
                }
            } catch (e) {
                console.warn("[Josia多图加载] 上传失败:", e);
            }
        }
        if (uploaded.length === 0) return;

        // 去重后追加到路径列表
        const cur = parsePaths();
        let added = false;
        for (const p of uploaded) {
            const normP = normalizeAbsPath(p);
            if (!cur.includes(p) && !loadedAbsPaths.has(normP)) {
                cur.push(p);
                loadedAbsPaths.add(normP);
                added = true;
            }
        }
        if (!added) return;
        writePaths(cur);
        await refreshImageList();
    }

    // 兼容旧接口名
    async function addFiles(fileList) { return handleFiles(fileList); }

    // ═══ 操作函数 ═══
    async function addImages(paths) {
        // v6.7: 简化为直接追加路径（上传已由 handleFiles 完成）
        const cur = parsePaths();
        let added = false;
        for (const p of paths) {
            const normP = normalizeAbsPath(p);
            if (!cur.includes(p) && !loadedAbsPaths.has(normP)) {
                cur.push(p);
                loadedAbsPaths.add(normP);
                added = true;
            }
        }
        if (!added) return;
        writePaths(cur);
        await refreshImageList();
    }

    // ★ v6.6: 完全对标 refreshGallery 调用链：
    //   1. renderGallery()        → 渲染图库内容
    //   2. updateOutputPorts()    → 同步输出端口，返回 {changed, wasFresh}
    //   3. if changed||wasFresh → rAF( updateLayout(wasFresh) + optimizeGrid )
    async function refreshImageList() {
        const paths = parsePaths();
        imageItems = paths.map(p => ({
            path: p,
            name: p.replace(/\\/g, "/").split("/").pop() || p,
            w: 0, h: 0,
            absPath: p,
        }));
        rebuildAbsPathSet();

        // 1️⃣ 渲染图库（先渲染一次显示 placeholder）
        renderGallery();

        // 2️⃣ 加载图片信息后重新渲染（带分辨率标签）
        for (const it of imageItems) {
            const info = await loadImageInfo(it.path);
            it.w = info.w;
            it.h = info.h;
        }
        renderGallery();

        // 3️⃣ 同步输出端口（获取 fresh 状态）
        const portResult = updateOutputPorts(imageItems.length);

        // 4️⃣ ★ 对标节点关键：changed || wasFresh 时才触发布局更新
        //    wasFresh=true 意味着首次从 51 个输出收缩到实际数量 → 需要 force-shrink
        if (portResult.changed || portResult.wasFresh) {
            requestAnimationFrame(() => {
                updateLayout(portResult.wasFresh);
                if (node.syncLayoutToNode) node.syncLayoutToNode();
                if (gridWrapper.offsetWidth > 0) {
                    optimizeGrid(gridWrapper.offsetWidth, gridWrapper.offsetHeight);
                }
            });
        } else {
            // 端口没变时仍然优化网格
            requestAnimationFrame(() => {
                if (node.syncLayoutToNode) node.syncLayoutToNode();
                if (gridWrapper.offsetWidth > 0) {
                    optimizeGrid(gridWrapper.offsetWidth, gridWrapper.offsetHeight);
                }
            });
        }
        node.setDirtyCanvas(true, true);
    }

    function removeImage(idx) {
        const p = parsePaths();
        p.splice(idx, 1);
        writePaths(p);
        // v6.2: 从去重集合移除
        if (imageItems[idx]) {
            const ap = normalizeAbsPath(imageItems[idx].absPath || imageItems[idx].path);
            loadedAbsPaths.delete(ap);
        }
        refreshImageList();
    }

    function reorderImages(from, to) {
        const p = parsePaths();
        const [it] = p.splice(from, 1);
        p.splice(to, 0, it);
        writePaths(p);
        refreshImageList();
    }

    function clearImages() {
        writePaths([]);
        imageItems = [];
        loadedAbsPaths.clear();
        const countSpan = toolbar.querySelector(".josia-mil-count");
        if (countSpan) countSpan.textContent = "";
        renderGallery();
        const portResult = updateOutputPorts(0);
        // ★ v6.6: 清空时也用 wasFresh 判断是否需要 force-shrink
        requestAnimationFrame(() => {
            updateLayout(portResult.wasFresh);
            if (node.syncLayoutToNode) node.syncLayoutToNode();
        });
        node.setDirtyCanvas(true, true);
    }

    // ★ v7.2: 万能恢复默认 — 重置所有参数回归默认值（不清空图库已加载图像）
    function resetParamsOnly() {
        const defaults = {
            resize_mode: true,        // BOOLEAN: 🖼️=按像素缩放
            megapixels: 0.0,
            resolution_steps: 1,      // 缩放步数（默认1=一步到位）
            edge_direction: true,     // BOOLEAN: ➡️=按长边缩放
            edge_value: 0,
            interpolation: "lanczos",
            multiple_of: "16",
            // ★ v7.2: 不重置 output_mode！保持用户选择的图像列表/图像批次状态
            output_index: 1,          // ★ v7.2: 重置序号为 1（万能恢复）
        };
        for (const w of node.widgets) {
            if (w.name === "output_mode") continue; // ★ 不重置输出模式
            if (defaults.hasOwnProperty(w.name)) {
                w.value = defaults[w.name];
                if (w.callback) w.callback(w.value);
            }
        }
        // ★ 重置后端实例变量（通过 PromptServer 消息同步 next_index=1）
        syncWidgetVisibility();
        syncOutputIndexEditable();
        node.setDirtyCanvas(true, true);
        console.log("[Josia多图加载] ✅ 已恢复默认（参数重置，图库保留，输出模式不变）");
    }

    function resortByName() {
        const p = parsePaths();
        p.sort((a,b) => {
            const na = a.replace(/\\/g,"/").split("/").pop().toLowerCase();
            const nb = b.replace(/\\/g,"/").split("/").pop().toLowerCase();
            return na.localeCompare(nb);
        });
        writePaths(p);
        refreshImageList();
    }

    // ═══ 工具栏按钮 ═══
    function mkBtn(text, cls) {
        const b = document.createElement("button");
        b.textContent = text;
        b.className = "josia-mil-btn " + cls;
        return b;
    }
    const btnUpload = mkBtn("载入图像", "josia-mil-btn-primary");
    const btnResort = mkBtn("重新排序", "josia-mil-btn-normal");
    const btnClear  = mkBtn("清空图像", "josia-mil-btn-danger");
    const btnReset  = mkBtn("恢复默认", "josia-mil-btn-normal");
    const lblCount  = document.createElement("span");
    lblCount.className = "josia-mil-count";
    // 工具栏（v7.0: 删除 btnOutput，回到4按钮+计数，单行不换行）
    toolbar.append(btnUpload, btnResort, btnClear, btnReset, lblCount);

    // ★ v7.2: PromptServer josia_mil_inc 消息监听 — 后端执行后通知前端更新序号
    // 后端通过 PromptServer.send_sync 发送 {node_id, next_index, total, upstream_count}
    // 前端监听并更新 output_index widget 值为 next_index（后递增 +1）
    // 此机制支持工作流运行和下游预览单独执行（自定义消息不限返回格式）
    let _lastTotal = 0;
    let _lastUpstreamCount = -1;
    const _milIncListener = (event) => {
        // ★ ComfyUI api.addEventListener 接收 CustomEvent，数据在 event.detail 里
        const data = event.detail;
        if (String(data.node_id) !== String(node.id)) {
            console.log(`[Josia多图加载] [调试] 收到其他节点的 josia_mil_inc 消息: node_id=${data.node_id}, 本节点id=${node.id}`);
            return;
        }
        console.log(`[Josia多图加载] ✅ 收到本节点的 josia_mil_inc 消息: next_index=${data.next_index}, total=${data.total}`);
        
        // 只在列表模式下更新序号（批次模式不递增）
        if (!outputModeW || !outputModeW.value) {
            console.log(`[Josia多图加载] [调试] 当前为批次模式，不更新序号`);
            return;
        }
        if (!outputIdxW) {
            console.log(`[Josia多图加载] ⚠️ outputIdxW 不存在，无法更新序号`);
            return;
        }

        _lastTotal = parseInt(data.total) ?? 0;
        _lastUpstreamCount = parseInt(data.upstream_count) ?? 0;
        // ★ 修复：不能用 || 1（0 || 1 = 1），必须用 ??（仅 null/undefined 时才回退）
        const nextIndex = parseInt(data.next_index) ?? 1;

        // 更新 widget 值 + 触发 callback 让 ComfyUI 同步到 graph
        outputIdxW.value = nextIndex;
        if (outputIdxW.callback) outputIdxW.callback(nextIndex);
        node.setDirtyCanvas(true, true);
        console.log(`[Josia多图加载] ✅ output_index 已更新为 ${nextIndex}`);
    };
    api.addEventListener("josia_mil_inc", _milIncListener);

    // ★ v7.2: 节点移除时清理监听器
    const origOnRemoved = node.onRemoved;
    node.onRemoved = function() {
        api.removeEventListener("josia_mil_inc", _milIncListener);
        if (origOnRemoved) origOnRemoved.apply(this, arguments);
    };

    // ★ v7.2: 上游端口连接变化 → 序号自动复位为1
    // 无论是连接还是断开上游"images"输入端口，都重置 output_index 为1
    const origOnConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function(type, slotIndex, isConnected, linkInfo, slotInfo) {
        if (origOnConnectionsChange) origOnConnectionsChange.apply(this, arguments);
        // type === 1 表示输入端口变化
        if (type === 1 && node.inputs && node.inputs[slotIndex]) {
            const inputName = node.inputs[slotIndex].name;
            if (inputName === "images") {
                // 上游端口变化（连接/断开）→ 序号复位为1
                if (outputIdxW) {
                    const prevValue = parseInt(outputIdxW.value) || 0;
                    if (prevValue !== 1) {
                        outputIdxW.value = 1;
                        if (outputIdxW.callback) outputIdxW.callback(1);
                        node.setDirtyCanvas(true, true);
                        console.log(`[Josia多图加载] 上游端口"${inputName}"${isConnected ? "已连接" : "已断开"}，序号复位为1`);
                    }
                }
            }
        }
    };

    // 事件绑定（v6.7: 统一使用 handleFiles）
    btnUpload.onclick = () => fileInput.click();
    fileInput.onchange = (e) => { handleFiles(e.target.files); };
    btnResort.onclick = resortByName;
    btnClear.onclick  = clearImages;
    btnReset.onclick  = resetParamsOnly;

    // ★ v5.4: 滚轮透传 — 直接调用 LiteGraph 原生 handler
    container.addEventListener("wheel", (e) => {
        e.preventDefault();
        const c = app.canvas;
        if (c) {
            const handler = c.onMouseWheel || c.processMouseWheel || c._on_mouse_wheel;
            if (typeof handler === "function") {
                handler.call(c, e);
                return;
            }
            if (c.canvas) {
                c.canvas.dispatchEvent(new WheelEvent("wheel", {
                    deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
                    clientX: e.clientX, clientY: e.clientY,
                    ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey,
                    bubbles: true, cancelable: true,
                }));
            }
        }
    });

    container.ondragover = (e) => e.preventDefault();
    container.ondrop = (e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
        if (files.length) handleFiles(files);
    };

    document.addEventListener("paste", (e) => {
        if (!app.canvas || !app.canvas.selected_nodes) return;
        const s = app.canvas.selected_nodes;
        const sel = (typeof s.has === "function") ? s.has(node.id) : s[node.id] !== undefined;
        if (!sel) return;
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        const files = [];
        for (const it of items) {
            if (it.kind === "file" && it.type.startsWith("image/")) {
                const f = it.getAsFile();
                if (f) files.push(f);
            }
        }
        if (files.length) { e.preventDefault(); handleFiles(files); }
    });

    // ═══ v6.6: 布局管理（完全对标节点 syncOutputs + updateLayout 模式）═══
    // ★ 核心常量（与对标节点保持一致）
    const LAYOUT = {
        MIN_GALLERY: 250,       // 图库最小高度（对标节点用 250）
        PB: 25,                  // 底部内边距（V1 模式，对标用 25）
        MIN_W: 220,              // 节点最小宽度
    };

    let isLayouting = false;

    // ★ 完全对标 syncLayoutToNode — 显式设置容器宽度跟随节点宽度
    node.syncLayoutToNode = function() {
        const nodeWidth = this.size?.[0] || DEFAULT_NODE_WIDTH;
        const targetWidth = Math.max(10, nodeWidth - 30);
        if (container) {
            container.style.width = `${targetWidth}px`;
            container.style.maxWidth = `${targetWidth}px`;
            container.style.boxSizing = "border-box";
        }
    };

    // ★ 完全对标 updateLayout — 统一的高度计算公式
    function updateLayout(forceShrink = false) {
        if (isLayouting) return;
        isLayouting = true;
        try {
            const galleryY = galleryWidget.last_y || 40;
            const minOutputsHeight = (node.outputs ? node.outputs.length : 1) * 20;
            const { MIN_GALLERY, PB, MIN_W } = LAYOUT;

            // ★ 对标公式：absoluteMinHeight = max(图库区最小, 输出端口所需)
            const absoluteMinHeight = Math.max(galleryY + MIN_GALLERY + PB, minOutputsHeight + 40);

            node.min_size = [MIN_W, absoluteMinHeight];

            let targetW = Math.max(node.size[0] || DEFAULT_NODE_WIDTH, MIN_W);
            // ★ forceShrink=true 时强制收缩到最小值（首次加载 / 清空时）
            let targetH = forceShrink ? absoluteMinHeight : (node.size[1] || absoluteMinHeight);
            targetH = Math.max(targetH, absoluteMinHeight);

            if (node.size[0] !== targetW || node.size[1] !== targetH) {
                node.setSize([targetW, targetH]);
                app.graph?.setDirtyCanvas(true, true);
            }

            // 同步容器宽度
            node.syncLayoutToNode();

            // 设置图库容器高度
            const availableGalleryHeight = targetH - galleryY - PB;
            container.style.height = availableGalleryHeight + "px";
        } finally {
            isLayouting = false;
        }
    }

    // ★ 完全对标 galleryWidget.computeSize
    galleryWidget.computeSize = function(width) {
        const galleryY = this.last_y || 40;
        const minOutputsHeight = (node.outputs ? node.outputs.length : 1) * 20;
        const { MIN_GALLERY, PB, MIN_W } = LAYOUT;
        const requiredGalleryHeight = Math.max(MIN_GALLERY, minOutputsHeight + 40 - galleryY);
        const nodeWidth = node.size?.[0] || width || DEFAULT_NODE_WIDTH;
        return [Math.max(MIN_W, nodeWidth - 30), requiredGalleryHeight];
    };

    // ★ v6.6: 覆盖 computeSize — 完全对标节点
    const origComputeSize = node.computeSize;
    node.computeSize = function(out) {
        const { MIN_GALLERY, PB, MIN_W } = LAYOUT;
        let res = origComputeSize ? origComputeSize.apply(this, arguments) : [MIN_W, MIN_GALLERY + PB];
        const galleryY = galleryWidget.last_y || 40;
        const minOutputsHeight = (this.outputs ? this.outputs.length : 1) * 20;
        const absoluteMinHeight = Math.max(galleryY + MIN_GALLERY + PB, minOutputsHeight + 40);
        this.min_size = [MIN_W, absoluteMinHeight];
        res[0] = Math.max(res[0], MIN_W);
        res[1] = Math.max(res[1], absoluteMinHeight);
        return res;
    };

    // ★ v6.6: 覆盖 setSize — 完全对标节点
    const origSetSize = node.setSize;
    node.setSize = function(size) {
        const { MIN_GALLERY, PB, MIN_W } = LAYOUT;
        const galleryY = galleryWidget.last_y || 40;
        const minOutputsHeight = (this.outputs ? this.outputs.length : 1) * 20;
        const absoluteMinHeight = Math.max(galleryY + MIN_GALLERY + PB, minOutputsHeight + 40);

        size[0] = Math.max(size[0], MIN_W);
        size[1] = Math.max(size[1], absoluteMinHeight);

        if (origSetSize) {
            origSetSize.call(this, size);
        } else {
            this.size = size;
        }
        this.syncLayoutToNode();
    };

    // ★ v6.6: 覆盖 onResize — 完全对标节点
    const origResize = node.onResize;
    node.onResize = function(size) {
        const { MIN_GALLERY, PB, MIN_W } = LAYOUT;

        if (origResize) origResize.call(this, size);
        this.syncLayoutToNode();
        if (isLayouting) return;

        const galleryY = galleryWidget.last_y || 40;
        const minOutputsHeight = (this.outputs ? this.outputs.length : 1) * 20;
        const absoluteMinHeight = Math.max(galleryY + MIN_GALLERY + PB, minOutputsHeight + 40);

        this.min_size = [MIN_W, absoluteMinHeight];
        size[0] = Math.max(size[0], MIN_W);
        size[1] = Math.max(size[1], absoluteMinHeight);

        const availableGalleryHeight = size[1] - galleryY - PB;
        container.style.height = availableGalleryHeight + "px";

        // 延迟优化网格（等 DOM layout 稳定）
        requestAnimationFrame(() => {
            if (gridWrapper.offsetWidth > 0) {
                optimizeGrid(gridWrapper.offsetWidth, gridWrapper.offsetHeight);
            }
        });
    };

    // ★ v6.6: 覆盖 onConfigure — 对标节点模式
    const origOnConfigure = node.onConfigure;
    node.onConfigure = function(info) {
        const out = origOnConfigure ? origOnConfigure.apply(this, arguments) : undefined;
        setTimeout(() => {
            if (this.syncLayoutToNode) this.syncLayoutToNode();
        }, 0);
        return out;
    };

    // ★ v6.6: 覆盖 onAdded — V1 模式下强制紧凑布局（完全对标）
    const origOnAdded = node.onAdded;
    node.onAdded = function() {
        if (origOnAdded) origOnAdded.apply(this, arguments);
        requestAnimationFrame(() => {
            const { MIN_GALLERY, PB } = LAYOUT;
            const galleryY = galleryWidget.last_y || 40;
            const minOutputsHeight = (this.outputs ? this.outputs.length : 1) * 20;
            const absoluteMinHeight = Math.max(galleryY + MIN_GALLERY + PB, minOutputsHeight + 40);
            // ★ V1 首次放入画布时强制收缩到最小尺寸
            if (this.size && this.size[1] > absoluteMinHeight + 5) {
                this.setSize([this.size[0], absoluteMinHeight]);
                if (app.graph) app.graph.setDirtyCanvas(true, true);
            }
            if (this.syncLayoutToNode) this.syncLayoutToNode();
        });
    };

    // ★ ResizeObserver — 监听 gridWrapper 尺寸变化自动优化网格
    let lastObservedW = 0, lastObservedH = 0;
    const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
            const w = Math.round(entry.contentRect.width);
            const h = Math.round(entry.contentRect.height);
            if (Math.abs(w - lastObservedW) > 1 || Math.abs(h - lastObservedH) > 1) {
                lastObservedW = w;
                lastObservedH = h;
                if (h > 0 && w > 0) {
                    optimizeGrid(w, h);
                }
            }
        }
    });
    resizeObserver.observe(gridWrapper);

    // 窗口大小改变时重算
    window.addEventListener("resize", () => {
        if (node.syncLayoutToNode) node.syncLayoutToNode();
        if (gridWrapper.offsetWidth > 0) {
            optimizeGrid(gridWrapper.offsetWidth, gridWrapper.offsetHeight);
        }
    });

    // ═══ 初始化（完全对标节点模式）═══
    // 对标节点：
    //   1. 立即 refreshGallery()  → 触发 syncOutputs(0) → wasFresh=true → updateLayout(true) 强制收缩
    //   2. setTimeout 100ms       → refreshGallery() 保险 + syncLayoutToNode
    //   3. onAdded                → V1 模式下再次强制紧凑
    requestAnimationFrame(() => {
        setWidgetVisible(pathsW, false);
        // ★ v7.0: outputModeW 为原生 BOOLEAN 开关（可见）
        syncWidgetVisibility();
        syncOutputIndexEditable();            // v7.2: 初始化灰化状态（简化版）
        // ★ v7.2: 不再搜索 control_after_generate COMBO widget（已废弃该机制）
        if (node.syncLayoutToNode) node.syncLayoutToNode();
        try { refreshImageList(); } catch(e) { renderGallery(); }
    });

    // ★ 100ms 保险（对标节点的标准模式）
    setTimeout(() => {
        try { refreshImageList(); } catch(e) {}
        if (node.syncLayoutToNode) node.syncLayoutToNode();
        getInputDir().catch(() => {});
    }, 100);
}
