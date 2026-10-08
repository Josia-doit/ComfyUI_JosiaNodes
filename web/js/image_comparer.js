/**
 * Josia 图像对比节点前端交互逻辑
 * 功能：支持滑动/点击两种图像对比模式，适配ComfyUI节点画布渲染
 * 本地文件名：image_comparer.js（全小写）
 * 匹配后端节点标识：JosiaImageComparer
 * 依赖：app（ComfyUI核心）、api（ComfyUI接口）
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// 工具函数：将图像数据转换为预览URL
function imageDataToUrl(data) {
    return api.apiURL(`/view?filename=${encodeURIComponent(data.filename)}&type=${data.type}&subfolder=${data.subfolder || ""}${app.getPreviewFormatParam()}${app.getRandParam()}`);
}

/* ============================================================================
 * 胶囊控件（与 media_save 同款样式：统一高度 + 圆头胶囊 + thumb 实测定位）
 * ----------------------------------------------------------------------------
 * 只做「展示 + 点选」，状态落 node.properties（与原有 comparer_mode 一致），
 * 不新增后端参数，避免破坏旧工作流的 widgets_values 顺序。
 * ========================================================================== */
const CMP_ROW_H = 22;
// 图像绘制区起点 = 标题区 + 按钮行（DOM widget）高度 + 留白。
// 🔴 按钮行是 addDOMWidget 挂进来的真实 DOM，节点画布上不占「绘制像素」，
// 只写死一个 titleH 会让图像顶部压到按钮底下（10-04 哥哥实测反馈）。
// 这里只做兜底常量；draw 里会实测那个 DOM 的 bottom 顶替它（量不到才用常量）
//  —— 不同主题 / 字体 / 标题高度下写死必然再翻车。
const CMP_TITLE_H = 48;          // 标题区兜底高度
const CMP_DOM_H = CMP_ROW_H + 6; // 按钮行高度，与 domWidget.computeSize 保持一致
const CMP_CONTENT_GAP = 4;       // 按钮行与图像区之间的留白
let _cmpStyleInjected = false;

/** 注入胶囊样式（幂等，只注入一次） */
function cmpInjectStyles() {
    if (_cmpStyleInjected) return;
    _cmpStyleInjected = true;
    const css = `
.jcmp-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;box-sizing:border-box;}
.jcmp-capsule{height:${CMP_ROW_H}px;box-sizing:border-box;
  border:1px solid var(--border-default,rgba(128,128,128,.5));
  background:var(--base-background,rgba(20,20,22,.92));
  color:var(--base-foreground,inherit);font-size:11px;
  border-radius:999px;display:inline-flex;align-items:center;padding:3px;gap:0;flex:0 0 auto;}
.jcmp-cap-track{position:relative;display:inline-flex;align-items:center;}
.jcmp-cap-thumb{position:absolute;top:0;left:0;height:100%;border-radius:999px;
  background:var(--primary-background,#3d6ea8);transition:transform .14s ease,width .14s ease;pointer-events:none;}
.jcmp-cap-item{position:relative;z-index:1;padding:0 10px;height:16px;line-height:16px;font-size:10px;
  cursor:pointer;white-space:nowrap;opacity:.72;user-select:none;}
.jcmp-cap-item.on{opacity:1;font-weight:600;color:#fff;}
/* 数字输入（混合度：内联灰标签 + 上下步进箭头，与 media_save 同款） */
.jcmp-numwrap{height:${CMP_ROW_H}px;box-sizing:border-box;
  border:1px solid var(--border-default,rgba(128,128,128,.5));
  background:var(--base-background,rgba(20,20,22,.92));
  color:var(--base-foreground,inherit);font-size:11px;
  border-radius:999px;display:inline-flex;align-items:center;overflow:hidden;flex:0 0 auto;}
.jcmp-in-lab{flex:0 0 auto;opacity:.55;font-size:10px;padding:0 4px 0 8px;white-space:nowrap;user-select:none;}
.jcmp-numwrap input{border:none;background:transparent;color:inherit;font:inherit;text-align:right;
  width:34px;padding:0 2px;outline:none;-moz-appearance:textfield;appearance:textfield;}
.jcmp-numwrap input::-webkit-outer-spin-button,
.jcmp-numwrap input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;display:none;}
.jcmp-num-step{flex:0 0 auto;width:14px;border:none;background:transparent;color:inherit;cursor:pointer;
  font-size:9px;opacity:.6;padding:0;}
.jcmp-num-step:hover{opacity:1;}
`;
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
}

/**
 * 数字输入（纯 UI 状态，不绑后端 widget）：手动输入 + 滚轮 + 上下箭头，步进取整。
 * 🔴 步进结果必须钳回 [min,max]（media_save 质量框踩过「100 上推到 105」的坑）。
 */
function cmpMkNumber(getValue, onChange, { label, step = 5, min = 0, max = 100 } = {}) {
    const wrap = document.createElement("div");
    wrap.className = "jcmp-numwrap";
    if (label) {
        const s = document.createElement("span");
        s.className = "jcmp-in-lab";
        s.textContent = label;
        wrap.appendChild(s);
    }
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = min;
    inp.max = max;
    inp.value = getValue();

    const clamp = (v) => Math.max(min, Math.min(max, v));
    const commit = (snap) => {
        let v = parseFloat(inp.value);
        if (!isFinite(v)) v = min;
        if (snap) v = Math.round(v / step) * step;
        v = clamp(v);
        inp.value = v;
        onChange(v);
    };
    const stepBy = (dir) => {
        let v = parseFloat(inp.value);
        if (!isFinite(v)) v = Number(getValue()) || min;
        v = clamp(v);
        // 向上取整到下一个 step 倍数、向下取整到上一个 → 28→上30下25再±step
        if (dir > 0) v = (v % step === 0) ? v + step : Math.ceil(v / step) * step;
        else v = (v % step === 0) ? v - step : Math.floor(v / step) * step;
        v = clamp(v); // 🔴 步进结果钳回范围内
        inp.value = v;
        onChange(v);
    };

    inp.addEventListener("change", () => commit(false));
    inp.addEventListener("blur", () => commit(false));
    inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commit(false);
        else if (e.key === "ArrowUp") { e.preventDefault(); stepBy(1); }
        else if (e.key === "ArrowDown") { e.preventDefault(); stepBy(-1); }
    });
    // 滚轮调数值，别把事件漏给画布缩放
    inp.addEventListener("wheel", (e) => {
        e.preventDefault(); e.stopPropagation();
        stepBy(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });

    const up = document.createElement("button");
    up.type = "button"; up.className = "jcmp-num-step"; up.textContent = "▲";
    const dn = document.createElement("button");
    dn.type = "button"; dn.className = "jcmp-num-step"; dn.textContent = "▼";
    up.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); stepBy(1); });
    dn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); stepBy(-1); });

    wrap.appendChild(inp);
    wrap.appendChild(up);
    wrap.appendChild(dn);
    wrap._input = inp;
    return wrap;
}

/**
 * 胶囊：多项互斥选择。
 * thumb 用单元格实测几何定位（offsetLeft / offsetWidth 元素坐标系）—— 直接用
 * 百分比 translateX(idx*100%) 会让最后一项的色块贴到容器边缘（media_save 踩过的坑）；
 * 用 rect（屏幕像素）则会被画布 transform 缩放再乘一次，色块过宽甚至跑出胶囊。
 * 🔴 同心圆等距：thumb 填满 track（top:0/height:100%），四向留白全部由胶囊 padding
 * 统一提供（3px）—— 若 thumb 自己再 inset（如 top:2px），垂直间距就是 padding+inset，
 * 会大于水平间距，色块看起来「上下松、左右贴边」。
 */
function cmpMkCapsule(items, getValue, onPick) {
    const box = document.createElement("div");
    box.className = "jcmp-capsule";
    const track = document.createElement("div");
    track.className = "jcmp-cap-track";
    const thumb = document.createElement("div");
    thumb.className = "jcmp-cap-thumb";
    track.appendChild(thumb);
    const cells = [];
    for (const it of items) {
        const s = document.createElement("span");
        s.className = "jcmp-cap-item";
        s.textContent = it.label;
        s.title = it.tip || it.label;
        s.addEventListener("click", (e) => {
            e.stopPropagation();
            onPick(it.value);
            sync();
        });
        track.appendChild(s);
        cells.push(s);
    }
    box.appendChild(track);

    function sync() {
        const v = getValue();
        let idx = items.findIndex((it) => String(it.value) === String(v));
        if (idx < 0) idx = 0;
        const cell = cells[idx];
        // 🔴 必须用 offsetLeft / offsetWidth（元素坐标系），绝不能用 getBoundingClientRect。
        // 原因：DOM widget 容器带 transform/zoom（ComfyUI 用 useAbsolutePosition+transform 定位），
        // rect 量到的是「屏幕像素」= 元素尺寸 × 画布缩放；把它写进 thumb.style.width / translateX
        // 会被再乘一次缩放 ⇒ 色块过宽、切换时整块跑出胶囊外（实测色块≈2 个单元格宽）。
        const x = cell.offsetLeft;
        const w = cell.offsetWidth;
        if (w > 0) {
            thumb.style.transform = `translateX(${x}px)`;
            thumb.style.width = `${w}px`;
        }        cells.forEach((c, i) => c.classList.toggle("on", i === idx));
    }

    // 字体加载完成 / 容器尺寸变化后重新量一次，避免首帧量到旧布局
    try {
        if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
            document.fonts.ready.then(() => sync()).catch(() => {});
        }
        const ro = new ResizeObserver(() => sync());
        ro.observe(track);
    } catch (e) { /* 老环境无 ResizeObserver 时忽略 */ }

    return { el: box, sync };
}

/* ============================================================================
 * 渲染结果留存（撤销 / 切换工作流 / 刷新页面后不丢失）
 * ----------------------------------------------------------------------------
 * 对比图由后端 PreviewImage.save_images 写入 ComfyUI 的 temp 目录，只要服务进程
 * 没重启，文件一直都在（temp 只在启动与退出时被清空）。所以前端只需要把
 * 「文件名 + subfolder + type」这 3 个字段记住，随时都能重新取回图像。
 *
 * 为什么用 localStorage 而不是 node.properties：
 *   ① properties 会进工作流 JSON，执行一次就把工作流标记为「已修改」；
 *   ② properties 参与撤销栈快照，而「撤销」恰恰是本功能要兼容的操作，
 *      存进去反而会让撤销出现一次无意义的状态回退。
 *   localStorage 完全不触碰图状态，对工作流、撤销栈、文件内容零影响。
 * ========================================================================== */
const CACHE_PREFIX = "JosiaComparer.v1.";
const DESC_FIELDS = ["filename", "subfolder", "type"];
const CACHE_MAX_ENTRIES = 200;
let _cacheWrites = 0;

/** 当前工作流标识：跨刷新稳定（路径也是前端自己给草稿/缩略图用的键） */
function currentWorkflowKey() {
    try {
        const wf = app.extensionManager?.workflow?.activeWorkflow;
        const key = wf?.path ?? wf?.key;
        return key ? String(key) : null;
    } catch (e) {
        return null;
    }
}

/** 只保留持久化所需的 3 个字段，避免把整个 ui 对象写进 localStorage */
function pickDesc(img) {
    if (!img || typeof img !== "object" || !img.filename) return null;
    const d = {};
    for (const f of DESC_FIELDS) {
        if (img[f] !== undefined) d[f] = img[f];
    }
    return d;
}

/** 描述符指纹：判断「已渲染的是不是同一对图」，保证还原是幂等的 */
function descSig(d) {
    return d ? `${d.type || "temp"}|${d.subfolder || ""}|${d.filename}` : "";
}

/** 遍历根图（含子图）内的所有节点 */
function walkNodes(fn) {
    const seen = new Set();
    const visit = (graph, depth) => {
        if (!graph || depth > 3) return;
        for (const node of graph._nodes || []) {
            if (!node || seen.has(node)) continue;
            seen.add(node);
            try {
                fn(node);
            } catch (e) {}
            if (node.subgraph) visit(node.subgraph, depth + 1);
        }
    };
    try {
        visit(app.graph, 0);
    } catch (e) {}
}

// 图像对比节点类（封装所有交互逻辑）
class JosiaImageComparerNode {
    constructor(node) {
        this.node = node;
        this.imgs = []; // 存储对比图像A/B
        this.descs = [null, null]; // 当前已渲染图像的描述符（后端 temp 文件名等）
        this.imgSig = ""; // 已渲染图像对的指纹（幂等还原用）
        this.healTries = 0; // 自愈式还原的尝试次数上限
        this.isPointerOver = false; // 鼠标是否悬停在节点上
        this.pointerPos = [0, 0]; // 鼠标位置
        // 🔴 刚进入节点的那一帧不画分隔线：此时 pointerPos 还是上次离开时留下的旧坐标，
        //    直接拿来当 wipeX 会让线「凭空跳到旧位置」（10-05 哥哥反馈的割裂感来源之一）。
        //    draw() 画完一帧会把它清掉，之后线就严格等于指针位置。
        this._skipWipe = false;
        this.comparerMode = "Slide"; // 默认对比模式：滑动
        this.fitMode = "默认"; // 显示适配方式：默认 / 等宽 / 等高
        this.blend = 0; // 混合度：A/B 互补不透明度（0=A 全实 B 全隐；50=各半；100=B 全实 A 全隐）
        this.contentTop = null; // 图像区在节点内的实际起点（实测按钮行底部，量不到才用常量）
        this._topMeasuredAt = 0; // 上次实测时刻（节流，避免每帧 getBoundingClientRect）
        this._nodeBg = null; // 采样到的节点底色（透明背景最终显示的就是它）
        this._nodeBgAt = 0;

        this.initProperties(); // 初始化节点属性
        this.setupEvents(); // 绑定鼠标事件
        this.addModeToggle(); // 添加模式切换开关
        this.scheduleRestore(); // 还原上次的渲染结果（撤销/切换工作流/刷新后用）
    }

    /* ======================= 渲染结果留存（本地缓存） ======================= */

    /** 缓存键：工作流标识 + 节点ID（两者都跨刷新稳定，且避免不同工作流的同名节点串味） */
    cacheKey() {
        const wk = currentWorkflowKey();
        const id = this.node?.id;
        if (!wk || id === undefined || id === null) return null;
        return `${CACHE_PREFIX}${wk}#${id}`;
    }

    /** 写入/清除缓存；a、b 都为空表示清除 */
    writeCache(a, b) {
        const key = this.cacheKey();
        if (!key) return;
        try {
            if (!a && !b) {
                localStorage.removeItem(key);
                return;
            }
            localStorage.setItem(key, JSON.stringify({ a, b, t: Date.now() }));
            if (++_cacheWrites % 20 === 0) this.pruneCache();
        } catch (e) {}
    }

    /** 读出缓存（字段非法/解析失败一律当作没有） */
    readCache() {
        const key = this.cacheKey();
        if (!key) return null;
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (!obj) return null;
            const a = pickDesc(obj.a);
            const b = pickDesc(obj.b);
            return a || b ? { a, b } : null;
        } catch (e) {
            return null;
        }
    }

    /** 缓存清理：条目过多时按时间淘汰最旧的一批，避免 localStorage 无限增长 */
    pruneCache() {
        try {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
            }
            if (keys.length <= CACHE_MAX_ENTRIES) return;
            const entries = keys.map((k) => {
                let t = 0;
                try {
                    t = JSON.parse(localStorage.getItem(k))?.t || 0;
                } catch (e) {}
                return { k, t };
            });
            entries.sort((x, y) => x.t - y.t);
            for (const e of entries.slice(0, entries.length - CACHE_MAX_ENTRIES)) {
                localStorage.removeItem(e.k);
            }
        } catch (e) {}
    }

    /**
     * 从 app.nodeOutputs 里取本节点的 ui 数据（a_images / b_images）。
     * 只在 onNodeOutputsUpdated 钩子里调用：该钩子恰好在「输出被整体替换」时触发
     * （撤销、切回工作流时前端会 restoreOutputs），此刻读到的必然是当前工作流的数据，
     * 不会读到上一个工作流的残留。
     */
    pairFromOutputs(outputs) {
        if (!outputs) return null;
        const id = this.node?.id;
        if (id === undefined || id === null) return null;
        const keys = [String(id)];
        const gid = this.node?.graph?.id;
        if (gid) keys.push(`${gid}:${id}`);
        for (const k of keys) {
            const o = outputs[k];
            if (o && (o.a_images || o.b_images)) {
                return { a: pickDesc(o.a_images?.[0]), b: pickDesc(o.b_images?.[0]) };
            }
        }
        return null;
    }

    /**
     * 应用一对描述符：加载 A/B 图像，并可选写入缓存。幂等——指纹相同直接跳过。
     * @returns {boolean} 是否发生了变化
     */
    applyPair(pair, persist) {
        if (!pair) return false;
        const a = pair.a || null;
        const b = pair.b || null;
        const sig = `${descSig(a)}||${descSig(b)}`;
        if (sig === this.imgSig) return false;

        this.imgSig = sig;
        this.descs = [a, b];
        this.imgs = [];
        if (a) this.loadImage(a, 0);
        if (b) this.loadImage(b, 1);
        if (persist) this.writeCache(a, b);
        this.node.setDirtyCanvas(true, false);
        return true;
    }

    /** 加载单张对比图；文件确实已不存在时丢弃该引用与缓存，避免反复重试 */
    loadImage(desc, index) {
        const img = new Image();
        img.src = imageDataToUrl(desc);
        img.onload = () => this.node.setDirtyCanvas(true, false);
        img.onerror = () => {
            if (this.imgs[index] === img) this.imgs[index] = undefined;
            this.descs[index] = null;
            this.imgSig = `${descSig(this.descs[0])}||${descSig(this.descs[1])}`;
            if (this.descs[0] || this.descs[1]) {
                this.writeCache(this.descs[0], this.descs[1]);
            } else {
                this.writeCache(null, null);
            }
            this.node.setDirtyCanvas(true, false);
        };
        this.imgs[index] = img;
    }

    /** 清空已渲染内容与缓存（本次执行确实没有可用图像时调用） */
    clearRendered() {
        this.imgs = [];
        this.descs = [null, null];
        this.imgSig = "";
        this.writeCache(null, null);
        this.node.setDirtyCanvas(true, false);
    }

    /** 还原渲染结果：优先本地缓存（按工作流+节点索引，最抗撤销/切换/刷新） */
    restore() {
        if (this.imgs[0]) return false;
        const cached = this.readCache();
        if (!cached) return false;
        return this.applyPair(cached, false);
    }

    /** 输出被整体替换（撤销 / 切回工作流）时，用内存中的输出兜底还原 */
    restoreFromOutputs(outputs) {
        if (this.imgs[0]) return false;
        const pair = this.pairFromOutputs(outputs);
        if (!pair) return false;
        const changed = this.applyPair(pair, false);
        if (changed) this.writeCache(pair.a, pair.b);
        return changed;
    }

    /** 节点新建/重配后，下一帧还原（此刻 node.id 一定已就绪，且撤销重载已完成） */
    scheduleRestore() {
        requestAnimationFrame(() => {
            try {
                this.restore();
            } catch (e) {}
        });
    }

    /**
     * 添加对比模式 + 适配方式胶囊（替代原生的 toggle widget，与 media_save 同款样式）
     * 状态仍落 node.properties（对齐原有的 comparer_mode），不新增后端参数。
     */
    addModeToggle() {
        cmpInjectStyles();
        const node = this.node;
        const root = document.createElement("div");
        root.className = "jcmp-row";

        // 胶囊一：对比模式（左 滑动对比 / 右 点击对比，默认滑动）
        const capMode = cmpMkCapsule(
            [
                { value: "Slide", label: "滑动对比", tip: "鼠标在图像上移动时出现分界线（左A右B）" },
                { value: "Click", label: "点击对比", tip: "按住鼠标显示图像B，松开恢复图像A" }
            ],
            () => this.comparerMode,
            (v) => {
                this.comparerMode = v;
                node.properties.comparer_mode = v;
                node.setDirtyCanvas(true, false);
            }
        );
        root.appendChild(capMode.el);

        // 胶囊二：适配方式（默认 / 等宽 / 等高，默认选中「默认」）
        const capFit = cmpMkCapsule(
            [
                { value: "默认", label: "默认", tip: "每张图各自以完整可见的最大比例适配显示区（横图吃满宽度、竖图吃满高度）" },
                { value: "等宽", label: "等宽", tip: "两图宽度相同，高度按各自宽高比" },
                { value: "等高", label: "等高", tip: "A、B 同高，且两张图都完整落在节点内（窄图居中留白、宽图自动下压高度不溢出）" }
            ],
            () => this.fitMode,
            (v) => {
                this.fitMode = v;
                node.properties.comparer_fit = v;
                node.setDirtyCanvas(true, false);
            }
        );
        root.appendChild(capFit.el);

        // 数字输入：混合 —— 上层图像B的不透明度（0=关闭；>0 时把B叠在A上，替代滑动/点击）
        const numBlend = cmpMkNumber(
            () => this.blend,
            (v) => {
                this.blend = v;
                node.properties.comparer_blend = v;
                node.setDirtyCanvas(true, false); // 实时重绘，无需重新执行节点
            },
            { label: "混合", step: 5, min: 0, max: 100 }
        );
        numBlend.title =
            "混合：两图互补不透明度 —— 数值 n 表示 A 图 (100−n)%、B 图 n%。\n" +
            "0 = 只显示 A，50 = A/B 各半，100 = 只显示 B。\n" +
            "鼠标扫过时照常分割对比：左侧按该混合显示，右侧显示 B 图原图。\n" +
            "改动实时生效，无需重新执行节点。";
        root.appendChild(numBlend);
        this.numBlend = numBlend;

        // 留一份 DOM 引用：draw 要靠它实测「按钮行底部」在节点内的位置
        this.domRoot = root;
        this.contentTop = null;
        this._topMeasuredAt = 0;

        // 面板上滚滚轮时把事件转交给画布，避免自定义 UI 吃掉画布缩放
        root.addEventListener("wheel", (e) => {
            e.preventDefault();
            const c = app.canvas;
            if (!c) return;
            const handler = c.onMouseWheel || c.processMouseWheel || c._on_mouse_wheel;
            if (handler) {
                try { handler.call(c, e); } catch (err) {}
            }
        }, { passive: false });

        // serialize:false —— 纯 UI 状态不进工作流 JSON（图像对比的输出才是真正的数据）
        const domWidget = node.addDOMWidget("comparer_ui", "JOSIA_COMPARER_UI", root, { serialize: false });
        domWidget.computeSize = () => [Math.max(0, node.size[0] - 24), CMP_ROW_H + 6];

        // 保存引用，供加载工作流 / setProperty 时同步胶囊高亮
        this.capMode = capMode;
        this.capFit = capFit;
        // 布局完成后才有真实尺寸 → 此刻才能正确定位色块。
        // 多补几帧 + 延时：DOM widget 挂载 / 字体 / 节点尺寸都可能晚于首帧。
        const syncCaps = () => {
            try { capMode.sync(); capFit.sync(); } catch (e) {}
        };
        requestAnimationFrame(syncCaps);
        [0, 60, 300].forEach((ms) => setTimeout(syncCaps, ms));

        // 节点缩放后单元格尺寸变，重新量
        const origResize = node.onResize;
        node.onResize = function () {
            try { origResize?.apply(this, arguments); } catch (e) {}
            syncCaps();
            // 节点尺寸变了 → 按钮行位置跟着变，实测缓存作废（draw 下一帧重测）
            const cmp = this.josiaComparer;
            if (cmp) {
                cmp.contentTop = null;
                cmp._topMeasuredAt = 0;
            }
        };
    }

    // 初始化节点属性（兼容旧版数据）
    initProperties() {
        const node = this.node;
        if (!node.properties) node.properties = {};
        if (!node.properties.comparer_mode) node.properties.comparer_mode = "Slide";
        if (!node.properties.comparer_fit) node.properties.comparer_fit = "默认";
        if (node.properties.comparer_blend == null) node.properties.comparer_blend = 0;
        this.comparerMode = node.properties.comparer_mode;
        this.fitMode = node.properties.comparer_fit;
        this.blend = Number(node.properties.comparer_blend) || 0;

        // 重写setProperty方法，监听模式变化并同步开关状态
        const originalSetProperty = node.setProperty;
        node.setProperty = (name, value) => {
            originalSetProperty.call(node, name, value);
            if (name === "comparer_mode") {
                this.comparerMode = value;
                // 同步胶囊高亮，修复加载工作流时状态不一致的问题
                try { this.capMode?.sync(); } catch (e) {}
                node.setDirtyCanvas(true, false);
            } else if (name === "comparer_fit") {
                this.fitMode = value;
                try { this.capFit?.sync(); } catch (e) {}
                node.setDirtyCanvas(true, false);
            } else if (name === "comparer_blend") {
                this.blend = Math.max(0, Math.min(100, Number(value) || 0));
                if (this.numBlend?._input) this.numBlend._input.value = this.blend;
                node.setDirtyCanvas(true, false);
            }
        };
    }

    // 绑定鼠标事件（悬停/点击/移动）
    setupEvents() {
        const node = this.node;
        // 进节点＝先不画线（等第一次真实 mousemove 定位），避免线跳到上一次离开时的旧坐标
        node.onMouseEnter = () => {
            this.isPointerOver = true;
            this._skipWipe = true;
            node.setDirtyCanvas(true, false);
        };
        node.onMouseLeave = () => { this.isPointerOver = false; node.setDirtyCanvas(true, false); };

        node.onMouseDown = () => { node.setDirtyCanvas(true, false); return false; };
        node.onMouseUp = () => { node.setDirtyCanvas(true, false); };

        node.onMouseMove = (e, pos) => {
            if (this.isPointerOver) {
                this.pointerPos = [...pos];
                node.setDirtyCanvas(true, false);
            }
        };

        // 🔴 不要再把 getExtraMenuOptions 置 null。
        // 官方 litegraphService 会给每个节点类型的 prototype 挂上 getExtraMenuOptions
        // （用于「打开图像 / 复制图像 / 保存图像」），第三方扩展也常在这条链上追加菜单项。
        // 置 null 会掐断整条链：部分前端/扩展在拿到 null 后直接降级，右键菜单就只剩
        // 「Save to system clipboard」一项且样式回退成旧版 litegraph 菜单。
        // 对比节点的 A/B 图存在 Comparer 实例里（不是 node.imgs），本来就不会触发那些图像项，
        // 所以这里什么都不做即可与其它节点完全一致。
    }

    // 节点执行完成后加载图像
    onExecuted(output) {
        // 防御：ComfyUI 在重绘/进度/空执行等事件下可能以 null/undefined 调用本方法。
        // 若在此处直接访问 output.a_images 会抛 TypeError，且会清空已加载的对比图，
        // 导致节点内的滑动/点击对比层消失。此处先判空，空调用直接跳过。
        if (!output) return;

        // 深搜：在 output 及其嵌套子对象中查找含 a_images / b_images 的字典。
        // 不再假设数据固定在 output / output.ui / output.output 某一层，
        // 兼容不同 ComfyUI 版本把 ui 数据放在任意层级的差异。
        let data = null;
        const visited = new WeakSet();
        const search = (obj, depth) => {
            if (data || !obj || typeof obj !== "object" || depth > 4) return;
            if (visited.has(obj)) return;
            visited.add(obj);
            if (obj.a_images || obj.b_images) { data = obj; return; }
            for (const k of Object.keys(obj)) {
                const v = obj[k];
                if (v && typeof v === "object") search(v, depth + 1);
            }
        };
        search(output, 0);
        if (!data) return;

        const a = pickDesc(data.a_images?.[0]);
        const b = pickDesc(data.b_images?.[0]);
        if (!a && !b) {
            // 本次执行确实没有图像（A/B 均未接入）→ 清空渲染内容与缓存
            this.clearRendered();
            return;
        }
        // 渲染并写入缓存：撤销 / 切换工作流 / 刷新页面后据此还原
        this.applyPair({ a, b }, true);
    }

    /**
     * 图像区在节点内的起点 y（= 按钮行底部往下再留一点）。
     * 🔴 按钮行是 addDOMWidget 挂进来的真实 DOM，而 draw 画在 canvas 上，
     * 两套坐标系并行 —— 写死一个 titleH 必然在某次主题/行高变化后又被按钮压住
     * （10-04 哥哥实测反馈：图像顶部压到「滑动对比 / 混合」那排按钮下面）。
     * 所以这里实测 DOM 下沿反算回节点局部坐标；量不到才回落兜底常量。
     * 600ms 节流：正常每帧 draw 只在首帧和尺寸变化后量一次，不会每帧 getBoundingClientRect。
     */
    ensureContentTop() {
        const node = this.node;
        const now = (typeof performance !== "undefined" && performance.now)
            ? performance.now() : Date.now();
        if (this.contentTop != null && now - this._topMeasuredAt < 600) {
            return this.contentTop;
        }

        // 唯一可信的一路：litegraph 的 widget 布局（`dw.y + 行高`）——
        // 它是**节点局部**的纯逻辑值，与画布平移 / 缩放 / DOM 裁剪全都无关。
        // 实测（10-04）：dw.y=46、行高 28 ⇒ 按钮行底部 74，起点取 78。
        let top = null;
        try {
            const dw = (node.widgets || []).find(
                (w) => w && (w.element === this.domRoot || w.name === "comparer_ui")
            );
            if (dw && Number.isFinite(Number(dw.y))) {
                let hh = CMP_DOM_H;
                try {
                    const sz = typeof dw.computeSize === "function" ? dw.computeSize() : null;
                    if (sz && Number.isFinite(Number(sz[1]))) hh = Number(sz[1]);
                } catch (e) {}
                top = Number(dw.y) + hh + CMP_CONTENT_GAP;
            }
        } catch (e) { /* 拿不到就回落兜底 */ }

        // 图像区至少留 minH 高：top 越界（节点被压得很矮 / dw.y 异常）就回落兜底常量。
        // 🔴 上一版栽在这里：额外加了一条「DOM rect 反算」并两路取 max，而 rect 是屏幕像素、
        // 要靠 ds.offset 反算 —— 画布一平移就滞后一帧偏掉（实测偏出 338），
        // 「取 max」每次都精准选中这条错的：节点越大偏得越多（图像被压到下方、只剩一条），
        // 节点缩小到 limit 之内又被踢掉、反而看起来正常。视角放大后偏差除以 scale 变小、
        // 缩小时再变回怪尺寸 —— 全是这一个换算式惹的。
        const minH = Math.min(140, Math.max(40, node.size[1] * 0.4));
        const limit = Math.max(CMP_TITLE_H, node.size[1] - minH);
        if (!Number.isFinite(top) || top <= 0 || top > limit) {
            top = Math.min(CMP_TITLE_H + CMP_DOM_H + CMP_CONTENT_GAP, limit);
        }

        this.contentTop = top;
        this._topMeasuredAt = now;
        return this.contentTop;
    }

    // 🔴 显示区不再自己垫底色：litegraph 画节点时已经把整块节点 body 填成 node.bgcolor，
    // 显示区又恒在节点 body 内（x=pad、底边=size[1]-pad）⇒ 透明背景的图透出来的就是这个
    // 节点底色，与「预览图像」节点观感一致。曾经额外 fillRect 一层「采样得来的底色」
    // （getImageData 读显示区左上角 1px + 800ms 节流）⇒ 颜色随采样内容漂移（有时节点色、
    // 有时画布网格的深灰/黑），纯属自找的抖动，已删除。

    // 绘制图像对比界面
    draw(ctx) {
        if (!this.imgs[0]) {
            // 自愈：节点被重建（撤销 / 切工作流）或还原时机早于数据就绪时，这里补还原。
            // 有次数上限，避免无缓存时每帧都去读一遍存储。
            if (this.healTries < 3) {
                this.healTries++;
                try {
                    this.restore();
                } catch (e) {}
            }
            if (!this.imgs[0]) return;
        }
        if (!this.imgs[0].complete) return;

        const node = this.node;
        const pad = 12;
        // 🔴 起点取实测的「按钮行底部」，不再写死 titleH —— 否则图像顶部会压到按钮下面
        const top = this.ensureContentTop();
        const w = node.size[0] - pad * 2;
        const h = Math.max(1, node.size[1] - top - pad);
        const x = pad;
        const y = top;

        const imgA = this.imgs[0];
        const imgB = this.imgs[1] || imgA;

        // ---- 按「适配方式」计算绘制尺寸（切换后立刻重算 → 实时切换显示，无需重新跑图）----
        const aAspect = imgA.naturalWidth / imgA.naturalHeight;
        const bAspect = imgB.naturalWidth / imgB.naturalHeight;
        const fit = this.fitMode || "默认";

        let drawWA, drawHA, drawWB, drawHB;
        if (fit === "等宽") {
            // 等宽：两图宽度相同，高度按各自宽高比（都保证不超出显示区）
            let sharedW = Math.min(w, h * aAspect, h * bAspect);
            sharedW = Math.max(1, sharedW);
            drawWA = drawWB = sharedW;
            drawHA = sharedW / aAspect;
            drawHB = sharedW / bAspect;
        } else if (fit === "等高") {
            // 等高：A、B 同高，且两张图都**完整**落在显示区内（宽与高都不超出节点）。
            // 🔴 旧逻辑只限制 A 的宽度、B 按同高自由放宽 ⇒ 当 B 比 A 更宽（横图在 B）时，
            //    B 的宽度无视显示区、被裁掉一半（看似「突破节点界限」），横图在 A 时却正常，
            //    完全不对称。修正为：共享高度取「显示区高度」与「两图都能塞进显示区宽度的
            //    最大高度」的最小值 —— 无论宽图在 A 还是 B，两图都受节点约束、同高且完整可见；
            //    若某张更宽导致无法在满高下并排完整显示，则共享高度下压到两张都能完整进框为止。
            const safeA = (aAspect && isFinite(aAspect)) ? aAspect : 1;
            const safeB = (bAspect && isFinite(bAspect)) ? bAspect : 1;
            let ha = h;
            const maxHByWidth = Math.min(w / safeA, w / safeB);
            if (maxHByWidth < ha) ha = maxHByWidth;
            drawHA = drawHB = ha;
            drawWA = ha * safeA;
            drawWB = ha * safeB;
        } else {
            // 默认：每张图**各自**以「完整可见的最大比例」适配显示区（独立 contain）——
            // 横版图吃满宽度、竖版图吃满高度，互不拖累，各自居中。
            const sa = Math.min(w / imgA.naturalWidth, h / imgA.naturalHeight) || 1;
            const sb = Math.min(w / imgB.naturalWidth, h / imgB.naturalHeight) || 1;
            drawWA = Math.max(1, imgA.naturalWidth * sa);
            drawHA = Math.max(1, imgA.naturalHeight * sa);
            drawWB = Math.max(1, imgB.naturalWidth * sb);
            drawHB = Math.max(1, imgB.naturalHeight * sb);
        }

        // 垂直统一（同高时必然一致），水平各自居中（宽度可能不同）
        const offsetYA = y + (h - drawHA) / 2;
        const offsetYB = y + (h - drawHB) / 2;
        const offsetXA = x + (w - drawWA) / 2;
        const offsetXB = x + (w - drawWB) / 2;

        // 限制在显示区内绘制（「等高」模式下 B 可能更宽，避免画到节点外）
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();

        // ---- 混合：两图互补不透明度（数值 n ⇒ 合成结果 = (1−n)·A + n·B）----
        // 🔴 下层 B 必须按 100% 铺满、上层 A 才用 (100−n)%：离屏/主画布上都不要写成
        //    「B 也按 n% 半透明」，否则 A 的半透明部分透出的是「半透明 B + 节点底色」，
        //    中间值（比如 15）会整体压暗发黑（10-04 实测，只有 0/100 正常）。
        const blend = Math.max(0, Math.min(100, Number(this.blend) || 0));
        const alphaA = (100 - blend) / 100;

        // ---- 擦除位置 wipeX：A 覆盖 B（B 在下、A 在上），鼠标扫过时把 A 的右侧擦掉露出 B ----
        //   null = 不擦，整幅按混合显示；= x 表示整幅擦掉（只剩 B）；= 指针 表示擦掉其右侧
        let wipeX = null;
        const bReady = !!imgB.complete;
        if (bReady) {
            if (this.comparerMode === "Click") {
                // 点击对比：按住＝整幅只剩 B，松开＝回到混合效果
                if (this.node.mouse_down || app.canvas.pointer_is_down) wipeX = x;
            } else if (this.isPointerOver && !this._skipWipe) {
                // 🔴 分隔线跟随指针扫过**整个显示区**（= 两图的并集、也就是最宽那张图吃满的横向范围），
                //    只夹在显示区左右边界内。绝不夹到 B 图自己的范围：
                //    A 横版 / B 竖版时 B 又窄又居中，指针一旦进到 A 超出 B 的留白区，
                //    线会卡死在 B 右边缘不动、再动鼠标也不会跟 —— 观感就是「突然跳一下、划不动」。
                //    现在指针到最右＝A 完整显示，到最左＝A 全擦只剩 B，全程连续无跳变。
                wipeX = Math.max(x, Math.min(x + w, this.pointerPos[0]));
            }
        }

        // 🔴 这里不垫底色 —— 节点 body 已经是节点底色，透明处自然透出它。

        // 下层：B 铺满（100% 不透明）；上层 A 的 (100−n)% 会把它压出 n% 的比重。
        // 混合 0 且不擦除时不必画（A 会全遮住）。
        if (bReady && (wipeX != null || blend > 0)) {
            ctx.save();
            ctx.drawImage(imgB, offsetXB, offsetYB, drawWB, drawHB);
            ctx.restore();
        }

        // 上层：A（只画擦除线左侧；不透明度按混合）
        if (alphaA > 0) {
            ctx.save();
            if (wipeX != null) {
                ctx.beginPath();
                ctx.rect(x, y, Math.max(0, wipeX - x), h);
                ctx.clip();
            }
            ctx.globalAlpha = alphaA;
            ctx.drawImage(imgA, offsetXA, offsetYA, drawWA, drawHA);
            ctx.restore();
        }

        // 分界线：跟随指针（与上面 wipeX 同一个值，全程连续），取 B 图反色（difference）。
        // 🔴 纵向贯穿**整个显示区**高度（两图各自垂直居中、高度可能差很多，A 是矮宽横版时
        //    若只画到 B 的那段高度，上下留白里会缺一块线，滑动看着像断的）—— 一条通长线
        //    才对得上「左边是 A、右边是 B」这条界。
        // 🔴 线宽取 2 个屏幕像素并对齐到整像素：1px 线只要落在半像素上就会被抗锯齿拆成
        //    两列 50% 灰（实测压在红图上是 (127,128,128)），对比度只剩一半、看着像断线。
        if (wipeX != null && wipeX > x && wipeX < x + w && bReady) {
            ctx.save();
            ctx.globalCompositeOperation = "difference";
            const scale = app.canvas.ds.scale || 1;
            const lineWidth = 2 / scale;
            const lineX = Math.round((wipeX - lineWidth / 2) * scale) / scale;
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(lineX, y, lineWidth, h);
            ctx.restore();
        }

        this._skipWipe = false;
        ctx.restore(); // 配平显示区裁剪
    }
}

// 注册ComfyUI扩展（核心：匹配后端节点标识JosiaImageComparer）
app.registerExtension({
    name: "Josia.JosiaImageComparer", // 扩展名匹配新节点标识
    async beforeRegisterNodeDef(nodeType, nodeData) {
        // 仅处理JosiaImageComparer节点
        if (nodeData.name !== "JosiaImageComparer") return;

        // 重写节点创建方法
        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            originalOnNodeCreated?.call(this);
            this.josiaComparer = new JosiaImageComparerNode(this);
            // 设置节点默认尺寸
            if (this.size[0] < 520) this.size[0] = 520;
            if (this.size[1] < 420) this.size[1] = 420;
        };

        // 重写节点执行完成方法
        const originalOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {
            // 防御空调用，避免下游 josiaComparer.onExecuted 收到 null 而崩溃
            if (output == null) return;
            originalOnExecuted?.call(this, output);
            if (this.josiaComparer) this.josiaComparer.onExecuted(output);
        };

        // 重写节点背景绘制方法
        const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function (ctx) {
            originalOnDrawBackground?.call(this, ctx);
            if (this.josiaComparer) this.josiaComparer.draw(ctx);
        };
    },

    /**
     * 工作流加载完成后同步开关状态与保存的属性
     * 修复：加载已保存的工作流时，开关显示与实际模式不一致
     */
    loadedGraphNode(node) {
        if (node.type !== "JosiaImageComparer" || !node.josiaComparer) return;

        const comparer = node.josiaComparer;
        const savedMode = node.properties?.comparer_mode || "Slide";
        comparer.comparerMode = savedMode;
        try { comparer.capMode?.sync(); } catch (e) {}
        const savedFit = node.properties?.comparer_fit || "默认";
        comparer.fitMode = savedFit;
        try { comparer.capFit?.sync(); } catch (e) {}
        comparer.blend = Math.max(0, Math.min(100, Number(node.properties?.comparer_blend) || 0));
        if (comparer.numBlend?._input) comparer.numBlend._input.value = comparer.blend;
        // 还原上次渲染结果（撤销 / 切换工作流 / 刷新页面后进入这里）
        comparer.scheduleRestore();
        node.setDirtyCanvas(true, false);
    },

    /**
     * 输出被整体替换时触发（切回工作流、撤销重载等，前端会 restoreOutputs）。
     * 这是读 app.nodeOutputs 唯一安全的时机——此刻拿到的必然是当前工作流的数据。
     * 已从本地缓存还原过的节点不会被覆盖。
     */
    onNodeOutputsUpdated(outputs) {
        walkNodes((node) => {
            if (node.type === "JosiaImageComparer" && node.josiaComparer) {
                node.josiaComparer.restoreFromOutputs(outputs);
            }
        });
    }
});
