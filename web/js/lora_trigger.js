/**
 * Josia LoRA 堆叠 · 触发词悬浮面板 + 配置管理（前端 v1.0）
 *
 * 功能（哥哥定稿）：
 *  1. 总控行「🏷️ 触发词」按钮开启节点右侧悬浮面板组：每个 LoRA 一块面板，
 *     漫画对话框样式（圆角 4px 与节点按钮一致 + 左侧三角尾巴指向该 LoRA 行），
 *     面板高度与 LoRA 两行 UI 同高（LH+LG+SH=54），随节点移动 / 缩放 / 尺寸变化吸附；
 *  2. 面板 = 缩略图 + 文本框：
 *     - 缩略图：默认空白占位；hover 浮现编辑按钮 → 文件选择器选图 / 拖拽上传；
 *       上传后显示缩略图，hover 时上方浮出大图预览、移开消失；
 *     - 文本框：显示触发词（不可选中/编辑）；hover 左侧浮现编辑按钮 →
 *       自定义 JS 对话框（上方左「请输入触发词：」右「确认」，点对话框以外=取消），
 *       下方可编辑文本框（支持输入/粘贴），确认后面板显示；右侧复制按钮（小字号）。
 *  3. 配置按 LoRA 文件名唯一绑定，存节点包 user_config/lora_trigger/（后端 lora_trigger.py，
 *     图片统一压缩 webp 质量 50 长边 800）；
 *  4. 设置面板（⚡️JosiaNodes / LoRA触发词）：预览图显示尺寸 + 配置管理窗口（表格增删）。
 *
 * 与 lora_stack.js 的协作：布局数据经 window.JosiaLoraStackLayout(node) 读取，
 * 不反向解析其内部状态；模块间零 import，规避加载顺序依赖。
 */
import { app } from "../../scripts/app.js";

// ═══ 常量 ═══
const API = "/josia_lora_trigger";
// 面板几何（画布单位，与 lora_stack.js 布局一致：LH=28 LG=2 SH=24）
const PANEL_H = 54;       // 与 LoRA 两行 UI 同高，避免上下面板重叠
const PANEL_GAP = 8;      // 面板与节点右边界的间距
const PANEL_W = 260;      // 面板宽度（较原 220 加宽约 18%，留出更多文本空间）
const TAIL_H = 8;         // 三角尾巴高度
const MW = 500;           // lora_stack.js 的最小节点宽度（Math.max(size[0], MW)）
const LS_KEY = "josia.loraTrigger.bigPreviewSize";
const DEFAULT_BIG_SIZE = 800; // 大图预览窗最长边默认 800px

// ═══ CSS ═══
const CSS = `
.josia-lt-layer{position:fixed;inset:0;pointer-events:none;z-index:1000}
.josia-lt-panel{
    position:absolute;top:0;left:0;transform-origin:0 0;
    box-sizing:border-box;display:flex;align-items:center;gap:6px;
    padding:0 6px 0 10px;pointer-events:auto;
    background:#2a2a2a;border:1px solid #4a4a4a;border-radius:4px;
    box-shadow:0 4px 16px rgba(0,0,0,.55);
    font-family:var(--font-family,sans-serif);
}
.josia-lt-tail{
    position:absolute;left:-8px;top:10px;width:0;height:0;
    border-top:4px solid transparent;border-bottom:4px solid transparent;
    border-right:8px solid #2a2a2a;
    filter:drop-shadow(-2px 1px 1px rgba(0,0,0,.4));
}
/* 缩略图区 */
.josia-lt-thumb{
    position:relative;flex:0 0 auto;
    width:40px;height:40px;
    background:#1c1c1c;border:1px solid #555;border-radius:4px;
    display:flex;align-items:center;justify-content:center;
    overflow:visible;cursor:default;
}
.josia-lt-thumb.drag{border-color:#4c8bf5;background:#22304a}
.josia-lt-thumb-img{
    position:absolute;inset:0;width:100%;height:100%;
    object-fit:cover;border-radius:3px;display:none;
    -webkit-user-drag:none;user-select:none;
}
.josia-lt-thumb.has-img .josia-lt-thumb-img{display:block}
.josia-lt-thumb.has-img .josia-lt-thumb-empty{display:none}
.josia-lt-thumb-empty{font-size:10px;color:#555;user-select:none;pointer-events:none}
.josia-lt-thumb-edit{
    position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
    width:22px;height:22px;border:none;border-radius:4px;
    background:rgba(0,0,0,.72);color:#fff;font-size:12px;line-height:1;
    cursor:pointer;display:none;align-items:center;justify-content:center;padding:0;
}
.josia-lt-thumb:hover .josia-lt-thumb-edit{display:inline-flex}
.josia-lt-thumb-edit:hover{background:#4c8bf5}
.josia-lt-thumb-uploading{position:absolute;inset:0;background:rgba(0,0,0,.6);
    color:#fff;font-size:10px;display:none;align-items:center;justify-content:center;border-radius:3px}
.josia-lt-thumb.busy .josia-lt-thumb-uploading{display:flex}
/* 大图预览浮窗（hover 面板任意位置浮现，固定尺寸不随 ComfyUI 缩放） */
.josia-lt-popup{
    position:fixed;left:0;top:0;display:none;pointer-events:none;z-index:1001;
    background:#262626;border:1px solid #4a4a4a;border-radius:6px;
    box-shadow:0 8px 28px rgba(0,0,0,.6);
    font-family:var(--font-family,sans-serif);overflow:hidden;
}
.josia-lt-popup-imgwrap{
    display:flex;align-items:center;justify-content:center;background:#161616;overflow:hidden;
}
.josia-lt-popup-note{
    width:260px;height:120px;display:flex;align-items:center;justify-content:center;
    color:#555;font-size:12px;background:#161616;
}
.josia-lt-popup-img{display:block;max-width:94vw;max-height:84vh}
.josia-lt-popup-text{
    padding:10px 12px;font-size:12px;line-height:1.5;color:#dcdcdc;
    white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;
}
.josia-lt-popup-text.empty{color:#777;font-style:italic}
/* 文本框区 */
.josia-lt-text{
    position:relative;flex:1 1 auto;min-width:0;height:calc(100% - 12px);
    display:flex;align-items:center;
}
.josia-lt-text-val{
    font-size:9px;line-height:1.35;color:#ccc;
    display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;
    overflow:hidden;word-break:break-all;
    user-select:none;-webkit-user-select:none;cursor:default;
    transition:opacity .12s ease;
}
.josia-lt-text:hover .josia-lt-text-val{opacity:.22}
.josia-lt-text-val.empty{color:#666}
.josia-lt-text-edit{
    position:absolute;left:0;top:50%;transform:translateY(-50%);
    width:22px;height:22px;border:none;border-radius:4px;
    background:rgba(0,0,0,.72);color:#fff;font-size:12px;line-height:1;
    cursor:pointer;display:none;align-items:center;justify-content:center;padding:0;z-index:2;
}
.josia-lt-text:hover .josia-lt-text-edit{display:inline-flex}
.josia-lt-text-edit:hover{background:#4c8bf5}
/* 复制按钮：默认隐藏，hover 文本框时与编辑按钮并列浮现（无文本时灰化禁用） */
.josia-lt-copy{
    position:absolute;left:26px;top:50%;transform:translateY(-50%);
    width:30px;height:22px;border:1px solid #555;border-radius:4px;
    background:rgba(0,0,0,.72);color:#aaa;font-size:10px;cursor:pointer;padding:0;
    display:none;align-items:center;justify-content:center;z-index:2;
}
.josia-lt-text:hover .josia-lt-copy{display:inline-flex}
.josia-lt-copy:hover:not(:disabled){color:#fff;border-color:#4c8bf5}
.josia-lt-copy:disabled{opacity:.35;cursor:default}
.josia-lt-copy.ok{color:#4caf50;border-color:#4caf50}
/* ═══ 文本编辑对话框 ═══ */
.josia-lt-mask{
    position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1200;
    display:flex;align-items:center;justify-content:center;
    /* 关键：显式 auto。ComfyUI 设置面板等模态弹窗会给 document.body 设
       pointer-events:none（让背后界面点不动），而 pointer-events 可继承，
       若此处不写死 auto，遮罩会从 body 继承 none → 整块面板「看得见点不到」，
       点击穿透到下方设置面板。写死 auto 后无论父级是否被模态层设 none 都能正常交互。 */
    pointer-events:auto;
}
.josia-lt-dlg{
    width:340px;max-width:90vw;background:#2b2b2b;border:1px solid #555;
    border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.6);
    font-family:var(--font-family,sans-serif);
    pointer-events:auto;
}
.josia-lt-dlg-head{
    display:flex;align-items:center;justify-content:space-between;
    padding:10px 12px;border-bottom:1px solid #444;
}
.josia-lt-dlg-title{font-size:13px;font-weight:bold;color:#eee}
.josia-lt-dlg-ok{
    height:22px;padding:0 12px;border:none;border-radius:4px;
    background:#4c8bf5;color:#fff;font-size:12px;cursor:pointer;
}
.josia-lt-dlg-ok:hover{background:#5d9af7}
.josia-lt-dlg-body{padding:10px 12px 12px}
.josia-lt-dlg-body textarea{
    width:100%;box-sizing:border-box;height:96px;resize:vertical;
    background:#1e1e1e;border:1px solid #555;border-radius:4px;
    color:#ddd;font-size:12px;padding:6px 8px;font-family:inherit;
}
.josia-lt-dlg-body textarea:focus{outline:none;border-color:#4c8bf5}
/* ═══ 管理窗口 ═══ */
.josia-lt-mgr{
    width:1280px;max-width:96vw;height:720px;max-height:92vh;
    background:#2b2b2b;border:1px solid #555;border-radius:8px;
    box-shadow:0 8px 32px rgba(0,0,0,.6);
    display:flex;flex-direction:column;overflow:hidden;
    font-family:var(--font-family,sans-serif);
    pointer-events:auto;
}
.josia-lt-mgr-head{
    display:flex;align-items:center;justify-content:space-between;
    padding:10px 14px;border-bottom:1px solid #444;
    cursor:grab;user-select:none;
}
.josia-lt-mgr-head:active{cursor:grabbing}
.josia-lt-mgr-title{font-size:14px;font-weight:bold;color:#eee}
.josia-lt-mgr-x{
    width:22px;height:22px;border:none;border-radius:4px;background:transparent;
    color:#aaa;font-size:14px;cursor:pointer;
}
.josia-lt-mgr-x:hover{background:rgba(255,255,255,.1);color:#fff}
.josia-lt-mgr-add{display:flex;gap:6px;padding:10px 14px;border-bottom:1px solid #444}
.josia-lt-mgr-add input, .josia-lt-mgr-add select{
    background:#1e1e1e;border:1px solid #555;border-radius:4px;
    color:#ddd;font-size:12px;padding:4px 8px;font-family:inherit;
}
.josia-lt-mgr-add input:focus, .josia-lt-mgr-add select:focus{outline:none;border-color:#4c8bf5}
.josia-lt-mgr-add .f-lora{flex:1 1 40%;min-width:0}
.josia-lt-mgr-add .f-text{flex:1 1 45%;min-width:0}
.josia-lt-mgr-add select{cursor:pointer}
.josia-lt-mgr-addbtn{
    flex:0 0 auto;height:24px;padding:0 14px;border:none;border-radius:4px;
    background:#4c8bf5;color:#fff;font-size:12px;cursor:pointer;
}
.josia-lt-mgr-addbtn:hover{background:#5d9af7}
.josia-lt-mgr-addbtn:disabled{opacity:.5;cursor:default}
.josia-lt-mgr-tablewrap{flex:1 1 auto;overflow:auto;padding:0 14px}
.josia-lt-mgr-tablewrap table{width:100%;border-collapse:collapse;font-size:12px}
.josia-lt-mgr-tablewrap th{
    position:sticky;top:0;background:#2b2b2b;color:#999;font-weight:normal;
    text-align:left;padding:8px 6px;border-bottom:1px solid #444;white-space:nowrap;
}
.josia-lt-mgr-tablewrap td{
    padding:6px;border-bottom:1px solid #383838;color:#ccc;vertical-align:middle;
}
.josia-lt-mgr-name,.josia-lt-mgr-text{
    padding:6px;border-bottom:1px solid #383838;color:#ccc;vertical-align:middle;
}
.josia-lt-mgr-text{color:#aaa}
/* 单元格超长省略号（不换行、保持行高；hover 显示完整内容） */
.josia-lt-mgr-cell{
    max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.josia-lt-mgr-time{white-space:nowrap;color:#888;font-size:11px}
.josia-lt-mgr-thumb{
    width:32px;height:32px;border-radius:4px;background:#1c1c1c;
    border:1px solid #555;object-fit:cover;display:block;
}
.josia-lt-mgr-noimg{
    width:32px;height:32px;border-radius:4px;background:#1c1c1c;
    border:1px dashed #555;display:flex;align-items:center;justify-content:center;
    color:#555;font-size:10px;
}
.josia-lt-mgr-del{
    height:22px;padding:0 10px;border:1px solid #555;border-radius:4px;
    background:transparent;color:#aaa;font-size:11px;cursor:pointer;white-space:nowrap;
}
.josia-lt-mgr-del:hover{color:#fff;border-color:#c0392b}
.josia-lt-mgr-del.armed{background:#c0392b;border-color:#c0392b;color:#fff}
.josia-lt-mgr-empty{padding:32px;text-align:center;color:#666;font-size:12px}
.josia-lt-mgr-foot{
    display:flex;align-items:center;justify-content:space-between;gap:8px;
    padding:8px 14px;border-top:1px solid #444;
}
.josia-lt-mgr-tip{font-size:11px;color:#777;word-break:break-all}
.josia-lt-mgr-hint{display:block;margin-top:4px;font-size:11px;line-height:1.6;color:#9a9a9a}
.josia-lt-mgr-actions{display:flex;gap:8px;flex:0 0 auto}
.josia-lt-mgr-btn{
    height:22px;padding:0 12px;border:1px solid #555;border-radius:4px;
    background:transparent;color:#ccc;font-size:12px;cursor:pointer;
}
.josia-lt-mgr-btn:hover{border-color:#4c8bf5;color:#fff}
/* 管理面板工具栏（悬停预览尺寸单选） */
.josia-lt-mgr-toolbar{
    display:flex;align-items:center;gap:12px;padding:6px 14px;
    border-bottom:1px solid #444;font-size:12px;color:#aaa;flex-wrap:wrap;
}
.josia-lt-mgr-toolbar .lab{color:#bbb}
.josia-lt-mgr-toolbar label{display:flex;align-items:center;gap:3px;cursor:pointer;color:#ccc}
.josia-lt-mgr-toolbar input[type=radio]{accent-color:#4c8bf5;cursor:pointer;margin:0}
/* 管理面板行 hover 大图弹窗（屏幕坐标 fixed，不随缩放；只显示图） */
.josia-lt-mgr-hover{
    position:fixed;left:0;top:0;display:none;pointer-events:none;z-index:1001;
    background:#262626;border:1px solid #4a4a4a;border-radius:6px;
    box-shadow:0 8px 28px rgba(0,0,0,.6);overflow:hidden;
    font-family:var(--font-family,sans-serif);
}
.josia-lt-mgr-hover img{display:block;max-width:96vw;max-height:80vh}
/* 编辑弹窗控件 */
.josia-lt-mgr-editbtn{
    height:22px;padding:0 10px;border:1px solid #555;border-radius:4px;
    background:transparent;color:#aaa;font-size:11px;cursor:pointer;white-space:nowrap;margin-right:6px;
}
.josia-lt-mgr-editbtn:hover{color:#fff;border-color:#4c8bf5}
.josia-lt-mgr-edit-img{
    width:160px;height:160px;object-fit:contain;background:#1c1c1c;
    border:1px solid #555;border-radius:4px;display:block;margin-bottom:8px;
}
.josia-lt-mgr-edit-noimg{
    width:160px;height:160px;border:1px dashed #555;border-radius:4px;
    display:flex;align-items:center;justify-content:center;color:#666;font-size:11px;margin-bottom:8px;
}
.josia-lt-mgr-edit-file{
    display:inline-block;height:22px;line-height:22px;padding:0 12px;margin-bottom:10px;
    border:1px solid #555;border-radius:4px;color:#ccc;font-size:12px;cursor:pointer;
}
.josia-lt-mgr-edit-file:hover{border-color:#4c8bf5;color:#fff}
`;

let cssInjected = false;
function injectCSS() {
    if (cssInjected) return;
    cssInjected = true;
    const s = document.createElement("style");
    s.id = "josia-lt-style";
    s.textContent = CSS;
    document.head.appendChild(s);
}

// ═══ 大图预览尺寸（设置项持久化）═══
function loadBigSize() {
    let v = null;
    try { v = localStorage.getItem(LS_KEY); } catch (_) { /* 隐私模式等 */ }
    const n = parseInt(v, 10);
    return (Number.isFinite(n) && n >= 400 && n <= 1200) ? n : DEFAULT_BIG_SIZE;
}
function applyBigSize(v) {
    // 仅用于设置面板即时生效，实际尺寸在 showLtPopup 中读取 loadBigSize()
}

// ═══ 配置缓存 ═══
// cfgByKey: Map<key, cfg>；cfgByName: Map<loraName, cfg>（面板按当前 LoRA 名反查）
const cfgByKey = new Map();
const cfgByName = new Map();
let cfgLoaded = false;

function indexConfigs(list) {
    cfgByKey.clear(); cfgByName.clear();
    for (const c of list || []) {
        cfgByKey.set(c.key, c);
        if (c.lora) cfgByName.set(c.lora, c);
    }
    cfgLoaded = true;
}

async function loadConfigs(force) {
    if (cfgLoaded && !force) return;
    try {
        const r = await fetch(`${API}/configs`);
        if (!r.ok) return;
        const d = await r.json();
        if (d && d.success) indexConfigs(d.configs || []);
    } catch (e) { console.warn("[Josia触发词] 加载配置失败:", e); }
    // 配置刷新后，让所有已展开的节点预览面板实时同步（事件驱动、非轮询，开销极低）
    refreshOpenPanels();
}

function imageUrl(cfg) {
    // cfg.key 已是 URL 编码态，直接放 URL 会双编码导致 404；用原始 LoRA 名重新单编码
    const raw = cfg.lora || decodeSafe(cfg.key);
    return `${API}/image/${encodeURIComponent(raw)}?t=${cfg.updated || 0}`;
}

function decodeSafe(k) {
    try { return decodeURIComponent(k); } catch (_e) { return k; }
}

// ═══ 面板组管理 ═══
// openGroups: Map<nodeId, {node, layer, panels, sig, raf}>
const openGroups = new Map();

function createLayer() {
    injectCSS();
    cleanupZombieLayers();
    const layer = document.createElement("div");
    layer.className = "josia-lt-layer";
    document.body.appendChild(layer);
    return layer;
}

// 清理 body 上不受 openGroups 管理的僵尸 layer（工作流切换/异常时兜底）
function cleanupZombieLayers() {
    document.querySelectorAll(".josia-lt-layer").forEach((layer) => {
        const managed = Array.from(openGroups.values()).some((g) => g.layer === layer);
        if (!managed) {
            try { layer.remove(); } catch (_) {}
        }
    });
    if (!openGroups.size) hideLtPopup();
}

// ═══ 顶层 z-index（与 ComfyUI 设置弹窗 .p-dialog 对齐，确保自定义弹窗始终在其之上）═══
// ComfyUI 设置面板是 PrimeVue 的 .p-dialog，动态分配极高 z-index（约 10200+），
// 若不高于它，从设置面板里打开的管理窗口会被设置面板遮住。
function topZIndex(offset) {
    let max = 0;
    document.querySelectorAll(".p-dialog").forEach((d) => {
        const z = parseInt(window.getComputedStyle(d).zIndex, 10);
        if (!isNaN(z) && z > max) max = z;
    });
    return (max > 0 ? max : 10200) + (offset || 0);
}

// 读取 lora_stack.js 暴露的布局桥（ac / 各 LoRA 名 / 每组第一行 y）
function layoutOf(n) {
    try {
        if (typeof window.JosiaLoraStackLayout === "function") {
            return window.JosiaLoraStackLayout(n) || {};
        }
    } catch (_) { /* 降级到直接读内部字段 */ }
    return {
        ac: n._ac || 1,
        names: (n._st || []).map((s) => s && s.name),
        rows: (n._ha && n._ha.rows) || [],
    };
}

function signatureOf(n) {
    const L = layoutOf(n);
    // rows.length 进签名：首帧 rows 可能还没就绪（空数组），就位后必须触发一次重建
    return (L.ac || 1) + "|" + (L.rows || []).length + "|" + (L.names || []).join(",");
}

function isOpen(n) { return openGroups.has(n.id); }

async function toggle(n) {
    if (isOpen(n)) closeGroup(n);
    else await openGroup(n);
    // 持久化开关状态到工作流，切换工作流后可恢复
    if (n && n.properties) n.properties._jmsLoraTriggerOpen = isOpen(n);
}

async function openGroup(n) {
    if (!n) return;
    // 同一 id 可能残留旧节点对象的 layer（工作流切换后节点实例被替换）。
    // 先强制关闭旧实例并清理僵尸 DOM，再为新节点创建独立 layer。
    if (isOpen(n)) closeGroup(n);
    cleanupZombieLayers();
    // 开面板时强制拉取最新配置：管理窗口/其他页面改过的数据要立即生效
    await loadConfigs(true);
    const layer = createLayer();
    const g = { node: n, layer, panels: [], sig: "", raf: 0 };
    openGroups.set(n.id, g);
    rebuildPanels(g);
    startTicking();
}

function closeGroup(n) {
    const g = openGroups.get(n.id);
    if (!g) return;
    openGroups.delete(n.id);
    hideLtPopup();
    if (g.layer) {
        try { g.layer.remove(); } catch (_) {}
    }
    if (!openGroups.size) stopTicking();
}

function closeAll() {
    const ids = Array.from(openGroups.keys());
    for (const id of ids) {
        const g = openGroups.get(id);
        if (g) closeGroup(g.node);
    }
    cleanupZombieLayers();
}

// ═══ 大图预览浮窗（全局单例，屏幕坐标固定，不随 ComfyUI 缩放变化）═══
// 结构：上方图像（最长边锁定 800px、按原比例）+ 下方完整触发词文本
let ltPopup = null;
function getLtPopup() {
    if (ltPopup) return ltPopup;
    const pop = document.createElement("div");
    pop.className = "josia-lt-popup";

    const imgwrap = document.createElement("div");
    imgwrap.className = "josia-lt-popup-imgwrap";
    const img = document.createElement("img");
    img.className = "josia-lt-popup-img";
    img.alt = "";
    img.draggable = false;
    imgwrap.appendChild(img);
    const note = document.createElement("div");
    note.className = "josia-lt-popup-note";
    note.textContent = "暂无预览图";
    note.style.display = "none";
    imgwrap.appendChild(note);

    const text = document.createElement("div");
    text.className = "josia-lt-popup-text";

    pop.appendChild(imgwrap);
    pop.appendChild(text);
    document.body.appendChild(pop);
    ltPopup = pop;
    return pop;
}

function showLtPopup(panelEl) {
    const pop = getLtPopup();
    const imgwrap = pop.querySelector(".josia-lt-popup-imgwrap");
    const img = pop.querySelector(".josia-lt-popup-img");
    const note = pop.querySelector(".josia-lt-popup-note");
    const text = pop.querySelector(".josia-lt-popup-text");

    // 动态读取最新配置（先传图后输词也能立即反映）
    const loraName = panelEl.dataset.lora || "";
    const cfg = cfgByName.get(loraName) || null;
    const bigSize = loadBigSize();

    // 图像：最长边锁定 bigSize，按原比例显示（横图 / 竖图均适用）
    if (cfg && cfg.has_image) {
        note.style.display = "none";
        img.style.display = "block";
        img.onload = () => {
            const nw = img.naturalWidth || bigSize;
            const nh = img.naturalHeight || bigSize;
            let dw = nw, dh = nh;
            if (nw >= nh) { dw = bigSize; dh = Math.round(bigSize * nh / nw); }
            else { dh = bigSize; dw = Math.round(bigSize * nw / nh); }
            imgwrap.style.width = dw + "px";
            imgwrap.style.height = dh + "px";
            img.style.width = dw + "px";
            img.style.height = dh + "px";
            positionLtPopup(panelEl, pop);
        };
        img.src = imageUrl(cfg);
    } else {
        img.style.display = "none";
        img.removeAttribute("src");
        note.style.display = "flex";
        imgwrap.style.width = "260px";
        imgwrap.style.height = "120px";
    }

    // 文本：完整触发词（不截断）
    const t = (cfg && cfg.text) ? cfg.text : "（未设置触发词）";
    text.textContent = t;
    text.classList.toggle("empty", !(cfg && cfg.text));

    pop.style.display = "block";
    positionLtPopup(panelEl, pop);
}
function hideLtPopup() { if (ltPopup) ltPopup.style.display = "none"; }

// 定位：优先浮在面板上方，空间不足翻到下方；水平居中并夹到视口内
function positionLtPopup(panelEl, pop) {
    const r = panelEl.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let top = r.top - ph - 8;
    if (top < 8) top = r.bottom + 8;
    if (top + ph > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - ph - 8);
    }
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    pop.style.left = left + "px";
    pop.style.top = top + "px";
}

// ═══ 面板构建 ═══
function buildPanel(g, gi, rowY) {
    const n = g.node;
    const L = layoutOf(n);
    // 归一化分隔符：节点内部名在 Windows 上可能带反斜线，统一为正斜线，
    // 才能与后端 /loras 接口（正斜线）生成同一份配置 key（否则 %5C 与 %2F 两份文件互不可见）
    const loraName = ((L.names && L.names[gi]) || "None").replace(/\\/g, "/");
    if (!loraName || loraName === "None") return null;

    const cfg = cfgByName.get(loraName) || null;

    const panel = document.createElement("div");
    panel.className = "josia-lt-panel";
    panel.style.width = PANEL_W + "px";
    panel.style.height = PANEL_H + "px";
    panel.dataset.gi = String(gi);
    panel.dataset.lora = loraName;

    // 三角尾巴：对准 LoRA 第一行中心（LH/2 = 14，尾巴高 8）
    const tail = document.createElement("div");
    tail.className = "josia-lt-tail";
    panel.appendChild(tail);

    // ── 缩略图区 ──
    const thumb = document.createElement("div");
    thumb.className = "josia-lt-thumb" + (cfg && cfg.has_image ? " has-img" : "");

    const empty = document.createElement("div");
    empty.className = "josia-lt-thumb-empty";
    empty.textContent = "无图";
    thumb.appendChild(empty);

    if (cfg && cfg.has_image) {
        const img = document.createElement("img");
        img.className = "josia-lt-thumb-img";
        img.src = imageUrl(cfg);
        img.alt = "";
        img.draggable = false;
        img.onerror = () => { thumb.classList.remove("has-img"); };
        thumb.appendChild(img);
    }

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "josia-lt-thumb-edit";
    editBtn.title = "选择预览图";
    editBtn.textContent = "✏️";
    thumb.appendChild(editBtn);

    const busy = document.createElement("div");
    busy.className = "josia-lt-thumb-uploading";
    busy.textContent = "…";
    thumb.appendChild(busy);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    thumb.appendChild(fileInput);

    editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        fileInput.click();
    });
    fileInput.addEventListener("change", () => {
        if (fileInput.files && fileInput.files[0]) {
            void uploadImage(g, gi, loraName, thumb, fileInput.files[0]);
        }
        fileInput.value = "";
    });
    // 拖拽上传
    thumb.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        thumb.classList.add("drag");
    });
    thumb.addEventListener("dragleave", () => thumb.classList.remove("drag"));
    thumb.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        thumb.classList.remove("drag");
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f && f.type.startsWith("image/")) {
            void uploadImage(g, gi, loraName, thumb, f);
        }
    });

    panel.appendChild(thumb);

    // ── 文本框区（编辑 / 复制按钮 hover 时浮现，文本变暗）──
    const textBox = document.createElement("div");
    textBox.className = "josia-lt-text";

    const textVal = document.createElement("span");
    textVal.className = "josia-lt-text-val" + (cfg && cfg.text ? "" : " empty");
    textVal.textContent = (cfg && cfg.text) ? cfg.text : "未设置触发词";
    textBox.appendChild(textVal);

    const textEdit = document.createElement("button");
    textEdit.type = "button";
    textEdit.className = "josia-lt-text-edit";
    textEdit.title = "编辑触发词";
    textEdit.textContent = "✏️";
    textBox.appendChild(textEdit);

    // 复制按钮：默认隐藏，hover 文本框时与编辑按钮并列浮现；无文本时灰化禁用
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "josia-lt-copy";
    copyBtn.textContent = "复制";
    copyBtn.title = "复制触发词";
    copyBtn.disabled = !(cfg && cfg.text);
    textBox.appendChild(copyBtn);

    textEdit.addEventListener("click", (e) => {
        e.stopPropagation();
        openTextDialog(loraName, (cfg && cfg.text) || "", async (val) => {
            await saveText(g, gi, loraName, val, textVal, copyBtn);
        });
    });
    copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const txt = textVal.textContent || "";
        if (!txt || txt === "未设置触发词") return;
        let ok = false;
        try {
            await navigator.clipboard.writeText(txt);
            ok = true;
        } catch (_) {
            // 非安全上下文降级
            try {
                const ta = document.createElement("textarea");
                ta.value = txt;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.select();
                ok = document.execCommand("copy");
                document.body.removeChild(ta);
            } catch (__) { ok = false; }
        }
        copyBtn.textContent = ok ? "✓" : "✕";
        copyBtn.classList.toggle("ok", ok);
        setTimeout(() => {
            copyBtn.textContent = "复制";
            copyBtn.classList.remove("ok");
        }, 1500);
    });
    panel.appendChild(textBox);

    // 鼠标指向面板任意位置 → 上方浮现大图预览 + 完整触发词（不随缩放变化）
    panel.addEventListener("mouseenter", () => showLtPopup(panel));
    panel.addEventListener("mouseleave", hideLtPopup);

    g.layer.appendChild(panel);
    return { el: panel, gi, rowY, loraName };
}

function rebuildPanels(g) {
    // 清空旧面板
    for (const p of g.panels) {
        if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    }
    g.panels = [];
    const L = layoutOf(g.node);
    const ac = Math.max(1, Math.min(10, L.ac || 1));
    const rows = L.rows || [];
    for (let gi = 0; gi < ac; gi++) {
        const rowY = rows[gi];
        if (!Number.isFinite(rowY)) continue;
        const p = buildPanel(g, gi, rowY);
        if (p) g.panels.push(p);
    }
}

// 让所有已展开的节点预览组实时重建（配置在别处被改后，同步到节点面板）
function refreshOpenPanels() {
    for (const g of openGroups.values()) {
        try { rebuildPanels(g); } catch (_) { /* 节点瞬态忽略 */ }
    }
}

// ═══ 位置循环（跟随节点移动 / 缩放 / 尺寸）═══
let tickRaf = 0;
let tickCount = 0;
function startTicking() {
    if (tickRaf) return;
    const tick = () => {
        tickRaf = requestAnimationFrame(tick);
        tickCount++;
        // 约每 1 秒做一次全局兜底清理，防止工作流切换/异常留下的僵尸 layer
        if (tickCount % 60 === 0) cleanupZombieLayers();
        for (const id of Array.from(openGroups.keys())) {
            const g = openGroups.get(id);
            if (!g) continue;
            const n = g.node;
            // 节点被删除 / 不在当前图 → 关面板
            if (!app.canvas || !n.graph || n.graph !== app.graph) {
                closeGroup(n);
                continue;
            }
            g.layer.style.display = n.flags && n.flags.collapsed ? "none" : "";
            if (n.flags && n.flags.collapsed) continue;
            try {
                const ds = app.canvas.ds;
                const cv = app.canvas.canvas || app.canvas.background_canvas;
                const rect = cv && cv.getBoundingClientRect ? cv.getBoundingClientRect() : null;
                if (!ds || !rect) continue;
                const scale = ds.scale || 1;
                // litegraph 换算（adjustMouseEvent 源码实证）：canvas = client/scale − offset
                // 反推：screen = (canvas + offset) × scale + rect
                const baseX = rect.left + (n.pos[0] + ds.offset[0]) * scale;
                const baseY = rect.top + (n.pos[1] + ds.offset[1]) * scale;
                const nodeW = Math.max(n.size[0], MW) * scale;
                const sig = signatureOf(n);
                if (sig !== g.sig) {
                    g.sig = sig;
                    rebuildPanels(g);
                }
                for (const p of g.panels) {
                    const px = baseX + nodeW + PANEL_GAP * scale;
                    const py = baseY + p.rowY * scale;
                    p.el.style.transform =
                        `translate(${px}px, ${py}px) scale(${scale})`;
                }
            } catch (e) { /* 画布瞬态（切换工作流）不打断循环 */ }
        }
        if (!openGroups.size) stopTicking();
    };
    tickRaf = requestAnimationFrame(tick);
}
function stopTicking() {
    if (tickRaf) {
        cancelAnimationFrame(tickRaf);
        tickRaf = 0;
    }
}

// ═══ 上传 / 保存 ═══
async function uploadImage(g, gi, loraName, thumbEl, file) {
    thumbEl.classList.add("busy");
    try {
        const dataUrl = await new Promise((resolve, reject) => {
            const rd = new FileReader();
            rd.onload = () => resolve(rd.result);
            rd.onerror = () => reject(rd.error);
            rd.readAsDataURL(file);
        });
        const r = await fetch(`${API}/save_image`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lora: loraName, image: dataUrl }),
        });
        const d = await r.json().catch(() => null);
        if (!d || !d.success) throw new Error((d && d.error) || "save failed");
        // 如果该 group 已不在 openGroups（工作流切换过），直接关闭清理，避免更新到僵尸 layer
        if (!openGroups.has(g.node.id)) {
            hideLtPopup();
            try { g.layer.remove(); } catch (_) {}
            return;
        }
        // 更新缓存并即时刷新缩略图 / 大图
        const cfg = d.config || { key: d.key, lora: loraName, text: "", has_image: true };
        cfgByKey.set(cfg.key, cfg);
        cfgByName.set(cfg.lora || loraName, cfg);
        // 重建所有已展开面板以显示新图（保留拖拽 / 编辑事件）
        refreshOpenPanels();
    } catch (e) {
        console.warn("[Josia触发词] 上传失败:", e);
        alert("预览图上传失败：" + (e && e.message ? e.message : String(e)));
    } finally {
        thumbEl.classList.remove("busy");
    }
}

async function saveText(g, gi, loraName, text, textValEl, copyBtnEl) {
    try {
        const r = await fetch(`${API}/save_text`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lora: loraName, text }),
        });
        const d = await r.json().catch(() => null);
        if (!d || !d.success) throw new Error((d && d.error) || "save failed");
        const cfg = d.config || {};
        cfg.key = cfg.key || null;
        cfg.lora = cfg.lora || loraName;
        cfg.text = text;
        cfg.has_image = !!cfg.has_image;
        if (cfg.key) cfgByKey.set(cfg.key, cfg);
        cfgByName.set(cfg.lora, cfg);
        textValEl.textContent = text || "未设置触发词";
        textValEl.classList.toggle("empty", !text);
        if (copyBtnEl) copyBtnEl.disabled = !text;
        refreshOpenPanels();
    } catch (e) {
        console.warn("[Josia触发词] 保存文本失败:", e);
        alert("触发词保存失败：" + (e && e.message ? e.message : String(e)));
    }
}

// ═══ 文本编辑对话框（JS 样式，点对话框以外 = 取消）═══
let textDlg = null;
function openTextDialog(loraName, current, onConfirm) {
    closeTextDialog();
    const mask = document.createElement("div");
    mask.className = "josia-lt-mask";
    mask.style.zIndex = String(topZIndex(10));

    const dlg = document.createElement("div");
    dlg.className = "josia-lt-dlg";
    dlg.addEventListener("click", (e) => e.stopPropagation());

    const head = document.createElement("div");
    head.className = "josia-lt-dlg-head";
    const title = document.createElement("span");
    title.className = "josia-lt-dlg-title";
    title.textContent = "请输入触发词：";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "josia-lt-dlg-ok";
    okBtn.textContent = "确认";
    head.appendChild(title);
    head.appendChild(okBtn);

    const body = document.createElement("div");
    body.className = "josia-lt-dlg-body";
    const ta = document.createElement("textarea");
    ta.value = current || "";
    ta.placeholder = "输入触发词，支持粘贴（Ctrl+V）";
    body.appendChild(ta);

    dlg.appendChild(head);
    dlg.appendChild(body);
    mask.appendChild(dlg);
    document.body.appendChild(mask);

    function finish(save) {
        const val = ta.value;
        closeTextDialog();
        if (save) onConfirm(val);
    }
    okBtn.addEventListener("click", (e) => { e.stopPropagation(); finish(true); });
    mask.addEventListener("click", () => finish(false)); // 点对话框以外 = 取消
    mask.addEventListener("keydown", (e) => {
        if (e.key === "Escape") finish(false);
    });
    ta.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); finish(false); return; }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); return; }
        e.stopPropagation(); // 防止触发画布快捷键
    });

    textDlg = { mask, finish };
    setTimeout(() => { ta.focus(); ta.select(); }, 0);
}
function closeTextDialog() {
    if (!textDlg) return;
    if (textDlg.mask.parentNode) textDlg.mask.parentNode.removeChild(textDlg.mask);
    textDlg = null;
}

// ═══ 管理窗口（表格统计 + 手动添加 / 删除）═══
let mgrWin = null;

// ═══ 管理面板：悬停预览尺寸（关 / 200 / 400 / 800，默认 400）+ 行 hover 大图弹窗 + 编辑弹窗 ═══
const MGR_HOVER_KEY = "josia.loraTrigger.mgrHoverSize";
let mgrHoverSize = loadMgrHoverSize();
function loadMgrHoverSize() {
    let v = null;
    try { v = localStorage.getItem(MGR_HOVER_KEY); } catch (_) { /* 隐私模式 */ }
    const n = parseInt(v, 10);
    return ([0, 200, 400, 600].includes(n)) ? n : 400;
}
function saveMgrHoverSize(v) {
    try { localStorage.setItem(MGR_HOVER_KEY, String(v)); } catch (_) { /* 隐私模式 */ }
}

// 行 hover 大图弹窗（屏幕坐标 fixed，不随 ComfyUI 缩放；只显示图，不显示触发词）
let mgrHoverEl = null;
function getMgrHover() {
    if (mgrHoverEl && document.body.contains(mgrHoverEl)) return mgrHoverEl;
    mgrHoverEl = document.createElement("div");
    mgrHoverEl.className = "josia-lt-mgr-hover";
    const img = document.createElement("img");
    img.alt = "";
    mgrHoverEl.appendChild(img);
    document.body.appendChild(mgrHoverEl);
    return mgrHoverEl;
}
function positionMgrHover(rowEl, pop) {
    const r = rowEl.getBoundingClientRect();
    const pw = pop.offsetWidth || (mgrHoverSize || 200);
    const ph = pop.offsetHeight || (mgrHoverSize || 200);
    // 默认浮在左侧；左侧贴边（空间不足）则翻到右侧
    let left = r.left - pw - 12;
    if (left < 8) left = r.right + 12;
    // 右侧也放不下则夹到视口内
    if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
    let top = r.top;
    if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8;
    if (top < 8) top = 8;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
}
function showMgrHover(rowEl, cfg) {
    if (!mgrHoverSize) return;                 // 「关」
    if (!cfg || !cfg.has_image) return;
    const pop = getMgrHover();
    // 必须高于管理窗口遮罩（topZIndex(10)），否则会被半透明遮罩压在下方而变暗
    pop.style.zIndex = String(topZIndex(30));
    const img = pop.querySelector("img");
    img.onload = () => {
        const nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
        let dw = nw, dh = nh;
        if (nw >= nh) { dw = mgrHoverSize; dh = Math.round(mgrHoverSize * nh / nw); }
        else { dh = mgrHoverSize; dw = Math.round(mgrHoverSize * nw / nh); }
        pop.style.width = dw + "px";
        pop.style.height = dh + "px";
        img.style.width = dw + "px";
        img.style.height = dh + "px";
        pop.style.display = "block";
        positionMgrHover(rowEl, pop);
    };
    img.src = imageUrl(cfg);
    pop.style.display = "block";              // 先显示（估算尺寸），onload 后修正
    positionMgrHover(rowEl, pop);
}
function hideMgrHover() {
    if (mgrHoverEl) mgrHoverEl.style.display = "none";
}

// 编辑弹窗：可修改预览图 + 触发词
let editDlg = null;
async function openEditDialog(cfg) {
    closeEditDialog();
    const mask = document.createElement("div");
    mask.className = "josia-lt-mask";
    mask.style.zIndex = String(topZIndex(20)); // 高于管理窗口(10)
    const dlg = document.createElement("div");
    dlg.className = "josia-lt-dlg";
    dlg.style.width = "420px";
    dlg.style.maxWidth = "92vw";
    dlg.addEventListener("click", (e) => e.stopPropagation());

    const head = document.createElement("div");
    head.className = "josia-lt-dlg-head";
    const title = document.createElement("span");
    title.className = "josia-lt-dlg-title";
    title.textContent = "编辑：" + (cfg.lora || decodeSafe(cfg.key));
    const xBtn = document.createElement("button");
    xBtn.type = "button"; xBtn.className = "josia-lt-dlg-ok"; xBtn.textContent = "✕";
    xBtn.addEventListener("click", closeEditDialog);
    head.appendChild(title); head.appendChild(xBtn);

    const body = document.createElement("div");
    body.className = "josia-lt-dlg-body";

    const imgWrap = document.createElement("div");
    function paintImg() {
        imgWrap.innerHTML = "";
        if (cfg.has_image) {
            const im = document.createElement("img");
            im.className = "josia-lt-mgr-edit-img";
            im.src = imageUrl(cfg);
            imgWrap.appendChild(im);
        } else {
            const no = document.createElement("div");
            no.className = "josia-lt-mgr-edit-noimg";
            no.textContent = "无预览图";
            imgWrap.appendChild(no);
        }
    }
    paintImg();

    const fileLabel = document.createElement("label");
    fileLabel.className = "josia-lt-mgr-edit-file";
    fileLabel.textContent = "选择预览图";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    fileLabel.appendChild(fileInput);
    fileInput.addEventListener("change", async () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        fileLabel.textContent = "上传中…";
        try {
            const dataUrl = await new Promise((res, rej) => {
                const rd = new FileReader();
                rd.onload = () => res(rd.result);
                rd.onerror = () => rej(rd.error);
                rd.readAsDataURL(f);
            });
            const r = await fetch(`${API}/save_image`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ lora: cfg.lora, image: dataUrl }),
            });
            const d = await r.json().catch(() => null);
            if (!d || !d.success) throw new Error((d && d.error) || "save failed");
            cfg.has_image = true;
            cfg.updated = (d.config && d.config.updated) || cfg.updated;
            cfgByKey.set(cfg.key, cfg);
            if (cfg.lora) cfgByName.set(cfg.lora, cfg);
            paintImg();
            refreshOpenPanels();
        } catch (e) {
            alert("预览图上传失败：" + (e && e.message ? e.message : String(e)));
        } finally {
            fileLabel.textContent = "选择预览图";
        }
    });

    const ta = document.createElement("textarea");
    ta.value = cfg.text || "";
    ta.placeholder = "输入触发词，支持粘贴（Ctrl+V）";

    body.appendChild(imgWrap);
    body.appendChild(fileLabel);
    body.appendChild(ta);

    const foot = document.createElement("div");
    foot.className = "josia-lt-dlg-head";
    foot.style.borderTop = "1px solid #444";
    foot.style.borderBottom = "none";
    foot.style.marginTop = "10px";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button"; cancelBtn.className = "josia-lt-mgr-btn";
    cancelBtn.style.height = "22px"; cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", closeEditDialog);
    const saveBtn = document.createElement("button");
    saveBtn.type = "button"; saveBtn.className = "josia-lt-dlg-ok"; saveBtn.textContent = "保存";
    saveBtn.addEventListener("click", async () => {
        saveBtn.textContent = "保存中…"; saveBtn.disabled = true;
        try {
            const r = await fetch(`${API}/save_text`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ lora: cfg.lora, text: ta.value }),
            });
            const d = await r.json().catch(() => null);
            if (!d || !d.success) throw new Error((d && d.error) || "save failed");
            cfg.text = ta.value;
            cfgByKey.set(cfg.key, cfg);
            if (cfg.lora) cfgByName.set(cfg.lora, cfg);
            refreshOpenPanels();
            closeEditDialog();
            if (mgrWin && mgrWin.render) mgrWin.render(); // 刷新管理表格
        } catch (e) {
            alert("触发词保存失败：" + (e && e.message ? e.message : String(e)));
            saveBtn.textContent = "保存"; saveBtn.disabled = false;
        }
    });
    foot.appendChild(cancelBtn);
    foot.appendChild(saveBtn);

    dlg.appendChild(head);
    dlg.appendChild(body);
    dlg.appendChild(foot);
    mask.appendChild(dlg);
    document.body.appendChild(mask);
    editDlg = { mask };
    setTimeout(() => { ta.focus(); }, 0);
}
function closeEditDialog() {
    if (!editDlg) return;
    if (editDlg.mask.parentNode) editDlg.mask.parentNode.removeChild(editDlg.mask);
    editDlg = null;
}

function fmtTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts * 1000);
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 按住标题栏拖动窗口（脱离 mask 的 flex 居中，改为 fixed 定位跟随鼠标）
function makeDraggable(win, handle) {
    handle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;                 // 仅左键
        if (e.target.closest("button")) return;      // 标题栏上的按钮（✕）不触发拖动
        const rect = win.getBoundingClientRect();
        win.style.position = "fixed";
        win.style.left = rect.left + "px";
        win.style.top = rect.top + "px";
        win.style.margin = "0";
        const dx = e.clientX - rect.left;
        const dy = e.clientY - rect.top;
        const move = (ev) => {
            let nl = ev.clientX - dx;
            let nt = ev.clientY - dy;
            // 限制不要拖出视口太远（始终保留标题栏可抓）
            nl = Math.min(Math.max(nl, -rect.width + 80), window.innerWidth - 80);
            nt = Math.min(Math.max(nt, 0), window.innerHeight - 30);
            win.style.left = nl + "px";
            win.style.top = nt + "px";
        };
        const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            document.body.style.userSelect = "";
            win.style.cursor = "";
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
        document.body.style.userSelect = "none";
        win.style.cursor = "grabbing";
        e.preventDefault();
    });
}

async function openManager() {
    if (mgrWin) return;
    await loadConfigs(true);
    if (mgrWin) return; // 并发保护

    const mask = document.createElement("div");
    mask.className = "josia-lt-mask";
    mask.style.zIndex = String(topZIndex(10));

    const win = document.createElement("div");
    win.className = "josia-lt-mgr";
    win.addEventListener("click", (e) => e.stopPropagation());

    // 头部
    const head = document.createElement("div");
    head.className = "josia-lt-mgr-head";
    const title = document.createElement("span");
    title.className = "josia-lt-mgr-title";
    title.textContent = "LoRA 触发词配置管理";
    const xBtn = document.createElement("button");
    xBtn.type = "button";
    xBtn.className = "josia-lt-mgr-x";
    xBtn.textContent = "✕";
    xBtn.title = "关闭";
    xBtn.addEventListener("click", closeManager);
    head.appendChild(title);
    head.appendChild(xBtn);
    win.appendChild(head);
    makeDraggable(win, head);   // 按住标题栏拖动

    // 添加行：LoRA 名用下拉列表（来自 loras 文件夹，已添加的不出现）
    const addRow = document.createElement("div");
    addRow.className = "josia-lt-mgr-add";
    const loraSelect = document.createElement("select");
    loraSelect.className = "f-lora";
    const fText = document.createElement("input");
    fText.className = "f-text";
    fText.placeholder = "触发词（可留空后补）";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "josia-lt-mgr-addbtn";
    addBtn.textContent = "添加";
    addRow.appendChild(loraSelect);
    addRow.appendChild(fText);
    addRow.appendChild(addBtn);
    win.appendChild(addRow);

    // 悬停预览尺寸工具栏（单选：关 / 200 / 400 / 800，默认 400）
    const toolbar = document.createElement("div");
    toolbar.className = "josia-lt-mgr-toolbar";
    const tl = document.createElement("span");
    tl.className = "lab";
    tl.textContent = "悬停预览尺寸：";
    toolbar.appendChild(tl);
    const sizes = [["关", 0], ["200", 200], ["400", 400], ["600", 600]];
    const radioName = "josia-lt-mgr-hover-size";
    for (const [label, val] of sizes) {
        const lab = document.createElement("label");
        const rb = document.createElement("input");
        rb.type = "radio";
        rb.name = radioName;
        rb.value = String(val);
        if (val === mgrHoverSize) rb.checked = true;
        rb.addEventListener("change", () => {
            mgrHoverSize = val;
            saveMgrHoverSize(val);
            hideMgrHover();
        });
        lab.appendChild(rb);
        lab.appendChild(document.createTextNode(label));
        toolbar.appendChild(lab);
    }
    win.appendChild(toolbar);

    // 表格区
    const wrap = document.createElement("div");
    wrap.className = "josia-lt-mgr-tablewrap";
    win.appendChild(wrap);

    // 底部
    const foot = document.createElement("div");
    foot.className = "josia-lt-mgr-foot";
    const tip = document.createElement("span");
    tip.className = "josia-lt-mgr-tip";
    const actions = document.createElement("div");
    actions.className = "josia-lt-mgr-actions";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "josia-lt-mgr-btn";
    openBtn.textContent = "打开目录";
    openBtn.title = "在文件管理器中打开本地配置目录";
    openBtn.addEventListener("click", async () => {
        try {
            const r = await fetch(`${API}/open_dir`, { method: "POST" });
            const d = await r.json().catch(() => null);
            if (!d || !d.success) alert("打开目录失败：" + ((d && d.error) || "未知错误"));
        } catch (e) {
            alert("打开目录失败：" + (e && e.message ? e.message : String(e)));
        }
    });
    // 导出配置（备份）：把所有触发词与预览图导出为单个本地 JSON 文件
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "josia-lt-mgr-btn";
    exportBtn.textContent = "导出配置";
    exportBtn.title = "把所有触发词与预览图导出为单个本地文件（备份用）";
    exportBtn.addEventListener("click", async () => {
        try {
            const r = await fetch(`${API}/export`);
            const d = await r.json().catch(() => null);
            if (!d || !d.success) { alert("导出失败：" + ((d && d.error) || "未知错误")); return; }
            const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
            const a = document.createElement("a");
            const t = new Date();
            const pad = (n) => String(n).padStart(2, "0");
            const fn = `josia_lora_trigger_backup_${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}.json`;
            a.href = URL.createObjectURL(blob);
            a.download = fn;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { try { URL.revokeObjectURL(a.href); a.remove(); } catch (_) { /* */ } }, 1000);
        } catch (e) {
            alert("导出失败：" + (e && e.message ? e.message : String(e)));
        }
    });
    // 导入配置（恢复）：从导出文件读回，逐条写回本地目录
    const importInput = document.createElement("input");
    importInput.type = "file";
    importInput.accept = "application/json,.json";
    importInput.style.display = "none";
    importInput.addEventListener("change", async () => {
        const file = importInput.files && importInput.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            const configs = Array.isArray(data) ? data : (data && data.configs);
            if (!Array.isArray(configs)) { alert("文件格式不正确（应为导出的备份 JSON）"); importInput.value = ""; return; }
            const r = await fetch(`${API}/import`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ configs }),
            });
            const d = await r.json().catch(() => null);
            if (d && d.success) {
                await loadConfigs(true);
                await renderTable();
                await refreshLoraSelect(false);
                let msg = `已导入 ${d.imported || 0} 条配置`;
                if (d.skipped) msg += `，跳过 ${d.skipped} 条无效`;
                alert(msg);
            } else {
                alert("导入失败：" + ((d && d.error) || "未知错误"));
            }
        } catch (e) {
            alert("导入失败：" + (e && e.message ? e.message : String(e)));
        }
        importInput.value = "";
    });
    document.body.appendChild(importInput);
    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "josia-lt-mgr-btn";
    importBtn.textContent = "导入配置";
    importBtn.title = "从「导出配置」生成的备份文件恢复触发词与预览图";
    importBtn.addEventListener("click", () => importInput.click());
    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "josia-lt-mgr-btn";
    refreshBtn.textContent = "刷新";
    refreshBtn.addEventListener("click", async () => {
        await renderTable();
        await refreshLoraSelect(true); // 重新扫描 loras 文件夹（等效主界面 R 键）
    });
    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "josia-lt-mgr-btn";
    doneBtn.textContent = "完成";
    doneBtn.addEventListener("click", closeManager);
    actions.appendChild(openBtn);
    actions.appendChild(exportBtn);
    actions.appendChild(importBtn);
    actions.appendChild(refreshBtn);
    actions.appendChild(doneBtn);
    foot.appendChild(tip);
    foot.appendChild(actions);
    win.appendChild(foot);

    mask.appendChild(win);
    mask.addEventListener("click", closeManager);
    document.body.appendChild(mask);
    mgrWin = { mask, render: renderTable };

    // 目录路径提示（后端返回）
    try {
        const r = await fetch(`${API}/configs`);
        const d = await r.json();
        if (d && d.success && d.dir) {
            tip.textContent = "配置目录：" + d.dir;
            const hint = document.createElement("div");
            hint.className = "josia-lt-mgr-hint";
            hint.textContent = "这些配置都是本地文件：可直接复制上面的目录备份；或点「导出配置」下载单个文件，" +
                "重装 / 换电脑后用「导入配置」一键恢复。也可点「打开目录」直接进入该文件夹手动管理。";
            tip.appendChild(hint);
        }
    } catch (_) { /* 忽略 */ }

    async function renderTable() {
        wrap.innerHTML = "";
        await loadConfigs(true);
        const list = Array.from(cfgByKey.values()).sort(
            (a, b) => (a.updated || 0) - (b.updated || 0));
        if (!list.length) {
            const empty = document.createElement("div");
            empty.className = "josia-lt-mgr-empty";
            empty.textContent = "暂无配置 —— 在上方下拉列表选择 LoRA 后点击添加，或在节点面板里上传预览图 / 编辑触发词";
            wrap.appendChild(empty);
            return;
        }
        const table = document.createElement("table");
        const thead = document.createElement("thead");
        const htr = document.createElement("tr");
        for (const h of ["预览图", "LoRA 文件名", "触发词", "更新时间", "操作"]) {
            const th = document.createElement("th");
            th.textContent = h;
            htr.appendChild(th);
        }
        thead.appendChild(htr);
        table.appendChild(thead);
        const tbody = document.createElement("tbody");
        for (const c of list) {
            const tr = document.createElement("tr");
            // 预览图（最前面）
            const tdImg = document.createElement("td");
            if (c.has_image) {
                const img = document.createElement("img");
                img.className = "josia-lt-mgr-thumb";
                img.src = imageUrl(c);
                img.alt = "";
                tdImg.appendChild(img);
            } else {
                const no = document.createElement("div");
                no.className = "josia-lt-mgr-noimg";
                no.textContent = "无图";
                tdImg.appendChild(no);
            }
            tr.appendChild(tdImg);
            // 文件名（超长省略号，hover 显示完整）
            const tdName = document.createElement("td");
            tdName.className = "josia-lt-mgr-name";
            const nmText = c.lora || decodeURIComponent(c.key);
            const nmCell = document.createElement("div");
            nmCell.className = "josia-lt-mgr-cell";
            nmCell.textContent = nmText;
            nmCell.title = nmText;
            tdName.appendChild(nmCell);
            tr.appendChild(tdName);
            // 触发词（超长省略号，hover 显示完整）
            const tdText = document.createElement("td");
            tdText.className = "josia-lt-mgr-text";
            const txCell = document.createElement("div");
            txCell.className = "josia-lt-mgr-cell";
            txCell.textContent = c.text || "—";
            txCell.title = c.text || "";
            tdText.appendChild(txCell);
            tr.appendChild(tdText);
            // 时间
            const tdTime = document.createElement("td");
            tdTime.className = "josia-lt-mgr-time";
            tdTime.textContent = fmtTime(c.updated);
            tr.appendChild(tdTime);
            // 操作（编辑 + 两段式删除）
            const tdOp = document.createElement("td");
            const editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "josia-lt-mgr-editbtn";
            editBtn.textContent = "编辑";
            editBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                openEditDialog(c);
            });
            tdOp.appendChild(editBtn);
            const delBtn = document.createElement("button");
            delBtn.type = "button";
            delBtn.className = "josia-lt-mgr-del";
            delBtn.textContent = "删除";
            let armed = false, armTimer = 0;
            delBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                if (!armed) {
                    armed = true;
                    delBtn.textContent = "确认";
                    delBtn.classList.add("armed");
                    armTimer = setTimeout(() => {
                        armed = false;
                        delBtn.textContent = "删除";
                        delBtn.classList.remove("armed");
                    }, 3000);
                    return;
                }
                clearTimeout(armTimer);
                try {
                    const r = await fetch(`${API}/delete`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ key: c.key }),
                    });
                    const d = await r.json().catch(() => null);
                    if (d && d.success) {
                        await loadConfigs(true);
                        renderTable();
                    } else {
                        alert("删除失败：" + ((d && d.error) || "未知错误"));
                    }
                } catch (e2) {
                    alert("删除失败：" + (e2 && e2.message ? e2.message : String(e2)));
                }
            });
            tdOp.appendChild(delBtn);
            tr.appendChild(tdOp);
            // 鼠标指向行 → 旁边弹出大预览图（不显示触发词）
            tr.addEventListener("mouseenter", () => showMgrHover(tr, c));
            tr.addEventListener("mouseleave", hideMgrHover);
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
    }

    // 下拉列表：ComfyUI loras 文件夹内、且尚未配置的 LoRA
    async function refreshLoraSelect(refresh) {
        let loras = [], err = null;
        try {
            const r = await fetch(`${API}/loras?refresh=${refresh ? 1 : 0}`);
            const d = await r.json().catch(() => null);
            if (d && d.success) loras = Array.isArray(d.loras) ? d.loras : [];
            else err = (d && d.error) || "请求失败";
        } catch (e) { err = (e && e.message) ? e.message : String(e); }
        const added = new Set(
            Array.from(cfgByKey.values()).map((c) => c.lora).filter(Boolean));
        const avail = loras.filter((n) => !added.has(n));
        const prev = loraSelect.value;
        loraSelect.innerHTML = "";
        if (err || !loras.length) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = err
                ? ("扫描失败：" + err)
                : "（未扫描到 loras 文件夹内的 LoRA，点击刷新重试）";
            loraSelect.appendChild(opt);
            loraSelect.disabled = true;
            return;
        }
        if (!avail.length) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "（已无更多可用 LoRA — 都已配置）";
            loraSelect.appendChild(opt);
            loraSelect.disabled = true;
            return;
        }
        loraSelect.disabled = false;
        for (const n of avail) {
            const opt = document.createElement("option");
            opt.value = n;
            opt.textContent = n;
            loraSelect.appendChild(opt);
        }
        if (prev && avail.includes(prev)) loraSelect.value = prev;
    }

    async function doAdd() {
        const lora = loraSelect.value;
        if (!lora) {
            alert("请先在下拉列表中选择一个 LoRA");
            return;
        }
        // 记录当前选中项在（过滤后）列表中的位置，用于添加后跳到下一个
        const opts = Array.from(loraSelect.options).map((o) => o.value);
        const selIdx = opts.indexOf(lora);
        addBtn.disabled = true;
        try {
            const r = await fetch(`${API}/add`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ lora, text: fText.value }),
            });
            const d = await r.json().catch(() => null);
            if (d && d.success) {
                fText.value = "";
                await loadConfigs(true);
                renderTable();
                await refreshLoraSelect(false);
                // 选中“下一个 LoRA”（被添加的已移除，原位置正好落到下一个）
                const newLen = loraSelect.options.length;
                if (newLen > 0) {
                    loraSelect.selectedIndex = Math.min(selIdx, newLen - 1);
                }
            } else {
                alert("添加失败：" + ((d && d.error) || "未知错误"));
            }
        } catch (e) {
            alert("添加失败：" + (e && e.message ? e.message : String(e)));
        } finally {
            addBtn.disabled = false;
        }
    }
    addBtn.addEventListener("click", doAdd);
    fText.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doAdd(); }
        e.stopPropagation();
    });

    void renderTable();
    void refreshLoraSelect(false);
}
function closeManager() {
    if (!mgrWin) return;
    if (mgrWin.mask.parentNode) mgrWin.mask.parentNode.removeChild(mgrWin.mask);
    hideMgrHover();
    mgrWin = null;
}

// ═══ 设置面板栏目 ═══
app.registerExtension({
    name: "JosiaNodes.Settings.LoraTrigger",
    settings: [
        {
            id: "JosiaNodes.LoraTrigger.BigPreviewSize",
            name: "LoRA堆叠 · 预览图显示尺寸",
            // 🔴 category 末段是 buildTree 唯一树键：同一末段后者覆盖前者（BigPreviewSize 会被吞掉）。
            //    父级统一为「LoRA堆叠节点设置」满足「合并成一个分类」诉求，末段各用不同值避免覆盖。
            category: ["⚡️JosiaNodes", "LoRA堆叠节点设置", "预览图尺寸"],
            type: (name, setValue, value) => {
                injectCSS();
                const root = document.createElement("div");
                root.className = "josia-setting-block";
                root.style.display = "flex";
                root.style.alignItems = "center";
                root.style.gap = "8px";
                root.style.width = "100%";

                const inp = document.createElement("input");
                inp.type = "number";
                inp.min = "400";
                inp.max = "1200";
                inp.step = "50";
                inp.style.width = "72px";
                inp.style.background = "var(--comfy-input-bg, #1e1e1e)";
                inp.style.border = "1px solid var(--border-color, #555)";
                inp.style.borderRadius = "4px";
                inp.style.color = "var(--fg, #ddd)";
                inp.style.fontSize = "12px";
                inp.style.padding = "2px 6px";
                let cur = parseInt(value, 10);
                if (!Number.isFinite(cur) || cur < 400 || cur > 1200) cur = loadBigSize();
                inp.value = String(cur);

                const tip = document.createElement("span");
                tip.style.fontSize = "12px";
                tip.style.color = "var(--fg-muted, #888)";
                tip.textContent = "像素（400 ~ 1200）— 鼠标指向面板时弹出的大预览窗最长边，改完即时生效";

                inp.addEventListener("change", () => {
                    let v = parseInt(inp.value, 10);
                    if (!Number.isFinite(v)) v = DEFAULT_BIG_SIZE;
                    v = Math.min(1200, Math.max(400, v));
                    inp.value = String(v);
                    try { localStorage.setItem(LS_KEY, String(v)); } catch (_) { /* 隐私模式 */ }
                    if (typeof setValue === "function") setValue(v);
                });

                root.appendChild(inp);
                root.appendChild(tip);
                return root;
            },
            defaultValue: DEFAULT_BIG_SIZE,
            tooltip: "鼠标指向触发词面板时弹出的大预览窗最长边（400~1200 像素），调整后即时生效",
        },
        {
            id: "JosiaNodes.LoraTrigger.Manage",
            name: "LoRA堆叠 · 触发词配置管理",
            category: ["⚡️JosiaNodes", "LoRA堆叠节点设置", "配置管理"],
            type: () => {
                injectCSS();
                const root = document.createElement("div");
                root.className = "josia-setting-block";
                root.style.width = "100%";
                const btn = document.createElement("button");
                btn.type = "button";
                btn.textContent = "LoRA 触发词配置管理";
                btn.style.height = "22px";
                btn.style.padding = "0 14px";
                btn.style.border = "1px solid #4c8bf5";
                btn.style.borderRadius = "4px";
                btn.style.background = "#4c8bf5";
                btn.style.color = "#fff";
                btn.style.fontSize = "12px";
                btn.style.cursor = "pointer";
                btn.title = "以表格查看 / 管理全部 LoRA 的触发词与预览图配置";
                btn.addEventListener("click", () => void openManager());
                root.appendChild(btn);

                const tip = document.createElement("div");
                tip.style.fontSize = "12px";
                tip.style.color = "var(--fg-muted, #888)";
                tip.style.marginTop = "6px";
                tip.style.lineHeight = "1.6";
                tip.textContent =
                    "每个 LoRA 文件名唯一绑定一套配置（触发词 + 预览图）。" +
                    "在节点「🏷️ 触发词」悬浮面板里上传 / 编辑会自动写入这里；" +
                    "预览图统一压缩为 WebP（质量 50、长边 800）以节省空间。";
                root.appendChild(tip);
                return root;
            },
            defaultValue: "",
            tooltip: "打开 LoRA 触发词配置管理窗口：表格统计全部记录，可手动添加或删除单条配置",
        },
    ],
});

// ═══ 对外 API（lora_stack.js 通过 window 桥调用）═══
window.JosiaLoraTrigger = {
    isOpen: (n) => isOpen(n),
    toggle: (n) => void toggle(n),
    open: (n) => void openGroup(n),
    close: (n) => closeGroup(n),
    closeAll,
    openManager: () => void openManager(),
    reloadConfigs: () => loadConfigs(true),
};
