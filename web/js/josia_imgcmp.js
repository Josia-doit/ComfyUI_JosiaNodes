import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

function imageDataToUrl(data) {
    return api.apiURL(`/view?filename=${encodeURIComponent(data.filename)}&type=${data.type}&subfolder=${data.subfolder || ""}${app.getPreviewFormatParam()}${app.getRandParam()}`);
}

class JosiaImageComparerNode {
    constructor(node) {
        this.node = node;
        this.imgs = [];
        this.isPointerOver = false;
        this.pointerPos = [0, 0];
        this.comparerMode = "Slide";

        this.initProperties();
        this.setupEvents();
        this.addModeToggle();
    }

    addModeToggle() {
        const toggle = this.node.addWidget(
            "toggle",
            "Mode",
            this.comparerMode === "Click",
            (value) => {
                this.comparerMode = value ? "Click" : "Slide";
                this.node.setDirtyCanvas(true, false);
            },
            { 
                on: "Click (按住显示 B)", 
                off: "Slide (鼠标滑动)" 
            }
        );

        toggle.computeSize = () => [this.node.size[0] - 24, 28];

        toggle.tooltip = 
            "Slide 模式：鼠标在图像上移动时出现分界线（左边 Image A，右边 Image B）\n" +
            "Click 模式：鼠标按住图像区域 → 显示 Image B，松开立即恢复 Image A";
    }

    initProperties() {
        const node = this.node;
        if (!node.properties) node.properties = {};
        if (!node.properties.comparer_mode) node.properties.comparer_mode = "Slide";
        this.comparerMode = node.properties.comparer_mode;

        const originalSetProperty = node.setProperty;
        node.setProperty = (name, value) => {
            originalSetProperty.call(node, name, value);
            if (name === "comparer_mode") {
                this.comparerMode = value;
                node.setDirtyCanvas(true, false);
            }
        };
    }

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

        node.getExtraMenuOptions = null;
    }

    onExecuted(output) {
        this.imgs = [];
        if (output.a_images?.[0]) {
            const imgA = new Image();
            imgA.src = imageDataToUrl(output.a_images[0]);
            imgA.onload = () => this.node.setDirtyCanvas(true, false);
            this.imgs[0] = imgA;
        }
        if (output.b_images?.[0]) {
            const imgB = new Image();
            imgB.src = imageDataToUrl(output.b_images[0]);
            imgB.onload = () => this.node.setDirtyCanvas(true, false);
            this.imgs[1] = imgB;
        }
    }

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

        const imgAspect = imgA.naturalWidth / imgA.naturalHeight;
        let drawW = w, drawH = w / imgAspect;
        if (drawH > h) { drawH = h; drawW = h * imgAspect; }

        const offsetX = x + (w - drawW) / 2;
        const offsetY = y + (h - drawH) / 2;

        if (this.comparerMode === "Click") {
            const isDown = this.node.mouse_down || app.canvas.pointer_is_down || false;
            const activeImg = isDown && imgB.complete ? imgB : imgA;
            ctx.drawImage(activeImg, offsetX, offsetY, drawW, drawH);
            return;
        }

        ctx.drawImage(imgA, offsetX, offsetY, drawW, drawH);

        if (this.isPointerOver && imgB.complete) {
            let dividerX = Math.max(offsetX, Math.min(offsetX + drawW, this.pointerPos[0]));

            ctx.save();
            ctx.beginPath();
            ctx.rect(dividerX, offsetY, offsetX + drawW - dividerX, drawH);
            ctx.clip();
            ctx.drawImage(imgB, offsetX, offsetY, drawW, drawH);
            ctx.restore();

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

// 注册节点
app.registerExtension({
    name: "Josia.JosiaImgCmp",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "JosiaImgCmp") return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            originalOnNodeCreated?.call(this);
            this.josiaComparer = new JosiaImageComparerNode(this);
            if (this.size[0] < 520) this.size[0] = 520;
            if (this.size[1] < 420) this.size[1] = 420;
        };

        const originalOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {
            originalOnExecuted?.call(this, output);
            if (this.josiaComparer) this.josiaComparer.onExecuted(output);
        };

        const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function (ctx) {
            originalOnDrawBackground?.call(this, ctx);
            if (this.josiaComparer) this.josiaComparer.draw(ctx);
        };
    }
});