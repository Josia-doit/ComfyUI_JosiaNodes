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

    // 添加模式切换开关（Slide/Click）
    addModeToggle() {
        const toggle = this.node.addWidget(
            "toggle",
            "Mode",
            this.comparerMode === "Click",
            (value) => {
                this.comparerMode = value ? "Click" : "Slide";
                this.node.setDirtyCanvas(true, false); // 刷新画布
            },
            { 
                on: "Click (按住显示 B)", 
                off: "Slide (鼠标滑动)" 
            }
        );

        // 适配开关宽度
        toggle.computeSize = () => [this.node.size[0] - 24, 28];

        // 开关提示文本
        toggle.tooltip = 
            "Slide 模式：鼠标在图像上移动时出现分界线（左边 Image A，右边 Image B）\n" +
            "Click 模式：鼠标按住图像区域 → 显示 Image B，松开立即恢复 Image A";
    }

    // 初始化节点属性（兼容旧版数据）
    initProperties() {
        const node = this.node;
        if (!node.properties) node.properties = {};
        if (!node.properties.comparer_mode) node.properties.comparer_mode = "Slide";
        this.comparerMode = node.properties.comparer_mode;

        // 重写setProperty方法，监听模式变化
        const originalSetProperty = node.setProperty;
        node.setProperty = (name, value) => {
            originalSetProperty.call(node, name, value);
            if (name === "comparer_mode") {
                this.comparerMode = value;
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
        this.imgs = [];
        // 加载图像A
        if (output.a_images?.[0]) {
            const imgA = new Image();
            imgA.src = imageDataToUrl(output.a_images[0]);
            imgA.onload = () => this.node.setDirtyCanvas(true, false);
            this.imgs[0] = imgA;
        }
        // 加载图像B
        if (output.b_images?.[0]) {
            const imgB = new Image();
            imgB.src = imageDataToUrl(output.b_images[0]);
            imgB.onload = () => this.node.setDirtyCanvas(true, false);
            this.imgs[1] = imgB;
        }
    }

    // 绘制图像对比界面
    draw(ctx) {
        if (!this.imgs[0] || !this.imgs[0].complete) return;

        const node = this.node;
        const pad = 12; // 内边距
        const titleH = 48; // 标题栏高度
        const w = node.size[0] - pad * 2; // 绘制宽度
        const h = node.size[1] - titleH - pad * 2; // 绘制高度
        const x = pad; // 绘制起始X
        const y = titleH + pad; // 绘制起始Y

        const imgA = this.imgs[0];
        const imgB = this.imgs[1] || imgA; // 无B图时显示A图

        // 计算图像适配尺寸（保持宽高比）
        const imgAspect = imgA.naturalWidth / imgA.naturalHeight;
        let drawW = w, drawH = w / imgAspect;
        if (drawH > h) { drawH = h; drawW = h * imgAspect; }

        const offsetX = x + (w - drawW) / 2; // 水平居中偏移
        const offsetY = y + (h - drawH) / 2; // 垂直居中偏移

        // Click模式：按住显示B图，松开显示A图
        if (this.comparerMode === "Click") {
            const isDown = this.node.mouse_down || app.canvas.pointer_is_down || false;
            const activeImg = isDown && imgB.complete ? imgB : imgA;
            ctx.drawImage(activeImg, offsetX, offsetY, drawW, drawH);
            return;
        }

        // Slide模式：默认显示A图，鼠标位置右侧显示B图
        ctx.drawImage(imgA, offsetX, offsetY, drawW, drawH);

        if (this.isPointerOver && imgB.complete) {
            // 计算分界线位置（限制在图像范围内）
            let dividerX = Math.max(offsetX, Math.min(offsetX + drawW, this.pointerPos[0]));

            // 绘制B图（仅分界线右侧）
            ctx.save();
            ctx.beginPath();
            ctx.rect(dividerX, offsetY, offsetX + drawW - dividerX, drawH);
            ctx.clip();
            ctx.drawImage(imgB, offsetX, offsetY, drawW, drawH);
            ctx.restore();

            // 绘制分界线（白色，适配缩放）
            ctx.save();
            ctx.imageSmoothingEnabled = false;
            ctx.globalCompositeOperation = "difference";
            const lineWidth = 1 / (app.canvas.ds.scale || 1);
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(dividerX - lineWidth / 2, offsetY, lineWidth, drawH);
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
            originalOnExecuted?.call(this, output);
            if (this.josiaComparer) this.josiaComparer.onExecuted(output);
        };

        // 重写节点背景绘制方法
        const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function (ctx) {
            originalOnDrawBackground?.call(this, ctx);
            if (this.josiaComparer) this.josiaComparer.draw(ctx);
        };
    }
});
