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

// 图像对比节点类（封装所有交互逻辑）
class JosiaImageComparerNode {
    constructor(node) {
        this.node = node;
        this.imgs = []; // 存储对比图像A/B
        this.isPointerOver = false; // 鼠标是否悬停在节点上
        this.pointerPos = [0, 0]; // 鼠标位置
        this.comparerMode = "Slide"; // 默认对比模式：滑动

        this.initProperties(); // 初始化节点属性
        this.setupEvents(); // 绑定鼠标事件
        this.addModeToggle(); // 添加模式切换开关
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

        this.imgs = [];
        // 加载图像A
        if (data.a_images?.[0]) {
            const imgA = new Image();
            imgA.src = imageDataToUrl(data.a_images[0]);
            imgA.onload = () => this.node.setDirtyCanvas(true, false);
            this.imgs[0] = imgA;
        }
        // 加载图像B
        if (data.b_images?.[0]) {
            const imgB = new Image();
            imgB.src = imageDataToUrl(data.b_images[0]);
            imgB.onload = () => this.node.setDirtyCanvas(true, false);
            this.imgs[1] = imgB;
        }
    }

    // 绘制图像对比界面
    draw(ctx) {
        if (!this.imgs[0] || !this.imgs[0].complete) return;

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
        node.setDirtyCanvas(true, false);
    }
});
