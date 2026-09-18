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
        this.comparerMode = "Slide"; // 默认对比模式：滑动

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

    // 添加模式切换开关
    addModeToggle() {
        const toggle = this.node.addWidget(
            "toggle",
            "切换模式",
            this.comparerMode === "Click",
            (value) => {
                this.comparerMode = value ? "Click" : "Slide";
                // 同步保存到节点属性，确保工作流保存/加载后状态一致
                this.node.properties.comparer_mode = this.comparerMode;
                this.node.setDirtyCanvas(true, false);
            },
            {
                on: "🖱️ 点击对比（按住鼠标切换图像）",
                off: "↔️ 滑动对比（鼠标滑动分割图像）"
            }
        );

        // 适配开关宽度
        toggle.computeSize = () => [this.node.size[0] - 24, 28];

        // 开关提示文本（与最新文本一致）
        toggle.tooltip =
            "↔️ 滑动对比：鼠标在图像上移动时出现分界线（左A右B）\n" +
            "🖱️ 点击对比：按住鼠标显示图像B，松开恢复图像A";

        // 保存开关引用，用于加载工作流时同步状态
        this.modeToggle = toggle;
    }

    // 初始化节点属性（兼容旧版数据）
    initProperties() {
        const node = this.node;
        if (!node.properties) node.properties = {};
        if (!node.properties.comparer_mode) node.properties.comparer_mode = "Slide";
        this.comparerMode = node.properties.comparer_mode;

        // 重写setProperty方法，监听模式变化并同步开关状态
        const originalSetProperty = node.setProperty;
        node.setProperty = (name, value) => {
            originalSetProperty.call(node, name, value);
            if (name === "comparer_mode") {
                this.comparerMode = value;
                // 同步开关部件的状态，修复加载工作流时状态不一致的问题
                if (this.modeToggle) {
                    this.modeToggle.value = (value === "Click");
                }
                node.setDirtyCanvas(true, false);
            }
        };
    }

    // 绑定鼠标事件（悬停/点击/移动）
    setupEvents() {
        const node = this.node;
        node.onMouseEnter = () => { this.isPointerOver = true; node.setDirtyCanvas(true, false); };
        node.onMouseLeave = () => { this.isPointerOver = false; node.setDirtyCanvas(true, false); };

        node.onMouseDown = () => { node.setDirtyCanvas(true, false); return false; };
        node.onMouseUp = () => { node.setDirtyCanvas(true, false); };

        node.onMouseMove = (e, pos) => {
            if (this.isPointerOver) {
                this.pointerPos = [...pos];
                node.setDirtyCanvas(true, false);
            }
        };

        // 清空额外菜单（避免冲突）
        node.getExtraMenuOptions = null;
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
        const titleH = 48;
        const w = node.size[0] - pad * 2;
        const h = node.size[1] - titleH - pad * 2;
        const x = pad;
        const y = titleH + pad;

        const imgA = this.imgs[0];
        const imgB = this.imgs[1] || imgA;

        // 计算图像A的适配宽度（保持宽高比）
        const imgAAspect = imgA.naturalWidth / imgA.naturalHeight;
        let sharedW = w, drawHA = w / imgAAspect;
        if (drawHA > h) { drawHA = h; sharedW = h * imgAAspect; }

        // 图像B使用与图像A相同的宽度，高度按自身宽高比自适应
        const imgBAspect = imgB.naturalWidth / imgB.naturalHeight;
        let drawHB = sharedW / imgBAspect;
        // 如果图像B高度超出显示区，则以容纳两者为准缩小宽度
        if (drawHB > h) {
            sharedW = h * imgBAspect;
            drawHA = sharedW / imgAAspect;
            drawHB = h;
        }

        // 两图宽度一致，水平位置相同；垂直各自居中
        const drawW = sharedW;
        const offsetXA = x + (w - drawW) / 2;
        const offsetYA = y + (h - drawHA) / 2;
        const offsetXB = offsetXA; // 与A水平对齐
        const offsetYB = y + (h - drawHB) / 2;

        // Click模式：按住显示B图，松开显示A图
        if (this.comparerMode === "Click") {
            const isDown = this.node.mouse_down || app.canvas.pointer_is_down || false;
            if (isDown && imgB.complete) {
                ctx.drawImage(imgB, offsetXB, offsetYB, drawW, drawHB);
            } else {
                ctx.drawImage(imgA, offsetXA, offsetYA, drawW, drawHA);
            }
            return;
        }

        // Slide模式：默认显示A图，鼠标位置右侧显示B图
        ctx.drawImage(imgA, offsetXA, offsetYA, drawW, drawHA);

        if (this.isPointerOver && imgB.complete) {
            // 分界线位置（两图宽度一致，直接用同一坐标裁剪）
            let dividerX = Math.max(offsetXA, Math.min(offsetXA + drawW, this.pointerPos[0]));

            // 绘制B图（仅分界线右侧）
            ctx.save();
            ctx.beginPath();
            ctx.rect(dividerX, offsetYB, offsetXA + drawW - dividerX, drawHB);
            ctx.clip();
            ctx.drawImage(imgB, offsetXB, offsetYB, drawW, drawHB);
            ctx.restore();

            // 绘制分界线（白色，贯穿两图高度范围）
            ctx.save();
            ctx.imageSmoothingEnabled = false;
            ctx.globalCompositeOperation = "difference";
            const lineWidth = 1 / (app.canvas.ds.scale || 1);
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(dividerX - lineWidth / 2, Math.min(offsetYA, offsetYB), lineWidth, Math.max(drawHA, drawHB));
            ctx.restore();
        }
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
        if (comparer.modeToggle) {
            comparer.modeToggle.value = (savedMode === "Click");
        }
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
