/**
 * Josia CheckpointPlus — 前端智能联动 v2.9.7
 *
 * v2.9.7 变更：
 *  1. 彻底移除分时显存优化(timed_vram)功能
 *  2. 状态栏增加 CLIP/VAE 来源指示（内置 or 外部文件名）
 *  3. 状态栏"保活"标签扩展为"UNET保活"
 * v2.9.6 变更：
 *  1. 移除 SmartCLIP / SmartVAE 包装器（不再干扰 ComfyUI 原生调度）
 *  2. UNET 锁定改为仅保活模式，不强制占满 VRAM
 *  3. 修复非 safetensors 文件重复加载问题
 *  4. timed_vram 参数不再影响加载逻辑
 * v2.9.5 变更：
 *  1. AIO模式CLIP类型不再替换为"已自动识别（内置）"文本
 *     改为保持原值+禁用，避免运行时"Value not in list"报错
 *  2. 统一_origValues命名（clip_name/vae_name/clip_type一致）
 *  3. initNode中缓存clip_type原始选项列表
 * v2.9.3 修复：
 *  1. AIO模式CLIP类型正确禁用
 *  2. 复刻原生CheckpointLoaderSimple：AIO自动识别CLIP类型
 * v2.9.2 更新：
 *  1. 占位文本统一+Emoji（🖼️主模型 🧠CLIP 🏷️类型 🎨VAE）
 *  2. AIO模式禁用控件显示"已使用内置XXX"提示
 *  3. GGUF模式CLIP全量显示+CLIP类型可手动选择
 * v2.9.1 修复：
 *  1. CLIP类型下拉框全量显示（不再按枚举过滤）
 *  2. 取消自动识别，纯手动选择
 *  3. 状态条恢复原样（52px，无CLIP类型行）
 *  4. 控件顺序重排：主模型→CLIP模型→CLIP类型→VAE模型→UNET锁→分时优化
 */
import { app } from "../../scripts/app.js";

const NODE_NAME  = "JosiaCheckpointPlus";

// ─── 布局常量 ───
const DEFAULT_NODE_WIDTH = 480;
const STATUS_BAR_H       = 52;
const STATUS_BAR_MARGIN   = 8;

// ─── 颜色 ───
const C_BG       = "rgba(10, 10, 16, 0.72)";
const C_BORDER   = "rgba(255,255,255,0.06)";
const C_OK       = "#5bc27e";
const C_WARN     = "#f0a020";
const C_DIM      = "#888";
const C_ACCENT   = "#4a9eff";
const C_ERROR    = "#e05555";
const C_TAG_AIO  = "#1a8a3c";
const C_TAG_UNT  = "#1a5c8a";
const C_TAG_GUF  = "#7a3cc8";

// ─── 状态枚举 ───
const PHASE = {
    IDLE:       "idle",        // 未选模型
    IDENTIFYING:"identifying",  // 正在调用API识别
    IDENTIFIED: "identified",   // 已识别（未执行）
    LOADED:     "loaded",       // 已执行，模型加载至内存
    EXECUTING:  "executing",    // 执行中
    DONE:       "done",         // 执行完成
    ERROR:      "error",        // 报错
};

const MT = {
    AIO:       "aio",
    UNET:      "unet",
    GGUF_UNET: "gguf_unet",
    UNKNOWN:   "unknown",
};

const PLACEHOLDER_MODEL     = "🖼️ 请选择模型…";
const PLACEHOLDER_CLIP      = "🧠 请选择模型…";
const PLACEHOLDER_VAE       = "🎨 请选择模型…";
const PLACEHOLDER_CLIP_TYPE = "🏷️ 请选择类型…";

// ─── 工具 ───
function isGGUF(name) { return typeof name === "string" && name.toLowerCase().endsWith(".gguf"); }
function findWidget(node, name) { return node.widgets?.find(w => w.name === name) ?? null; }

function parseGgufQuant(filename) {
    const m = filename.match(/[Qq](\d[\w_.]*?)(?:\.gguf)/i);
    return m ? m[0].replace(/\.gguf$/i, "").toUpperCase() : null;
}

function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function formatSize(mb) {
    if (!mb || mb <= 0) return "";
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// ─── API调用：精确识别模型类型 ───
let _fetchController = null;
async function fetchModelType(modelName, clipName, vaeName) {
    if (_fetchController) { _fetchController.abort(); }
    _fetchController = new AbortController();
    const ctrl = _fetchController;

    try {
        const body = { model_name: modelName };
        if (clipName && clipName !== PLACEHOLDER_CLIP) body.clip_name = clipName;
        if (vaeName && vaeName !== PLACEHOLDER_VAE) body.vae_name = vaeName;
        const resp = await fetch("/josia/detect_model_type", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (resp.ok) {
            _fetchController = null;
            return await resp.json();
        }
    } catch (e) {
        if (e.name !== "AbortError") {
            console.warn("[JosiaCheckpointPlus] API请求失败：", e);
        }
    }
    _fetchController = null;
    return null;
}

// ─── 文件夹启发式预判 ───
function folderHeuristic(modelName) {
    if (!modelName || modelName === PLACEHOLDER_MODEL) return MT.UNKNOWN;
    if (isGGUF(modelName)) return MT.GGUF_UNET;
    const lower = modelName.toLowerCase();
    if (/\baio\b/.test(lower) || lower.includes("all-in-one") || lower.includes("allinone")) {
        return MT.AIO;
    }
    if (/\bunet\b/.test(lower)) return MT.UNET;
    return MT.UNKNOWN;
}

// ─── widget 禁用/启用（仅做样式标记，不动值） ───
function setWidgetDisabled(widget, disabled, hint) {
    if (!widget) return;
    widget.disabled = disabled;
    if (disabled) {
        widget._origTextColor = widget._origTextColor ?? widget.color;
        widget.color = C_DIM;
        widget._disabledHint = hint;
        widget._josiaDisabled = true;
    } else {
        if (widget._origTextColor !== undefined) {
            widget.color = widget._origTextColor;
            delete widget._origTextColor;
        }
        delete widget._disabledHint;
        delete widget._josiaDisabled;
    }
}

//  CLIP下拉选项（不再按模型类型过滤，GGUF模式也显示全部CLIP）
function updateClipOptions(node, modelType) {
    const clipW = findWidget(node, "clip_name");
    if (!clipW?.options) return;
    if (!clipW._origValues && clipW.options.values?.length) {
        clipW._origValues = [...clipW.options.values];
    }
    const orig = clipW._origValues;
    if (!orig) return;
    
    // 始终恢复完整列表，不做GGUF过滤
    clipW.options.values = orig;
}

// 根据模型类型联动UI
function applyModelTypeLinkage(node, modelType) {
    const clipW = findWidget(node, "clip_name");
    const vaeW  = findWidget(node, "vae_name");
    const clipTypeW = findWidget(node, "clip_type");

    switch (modelType) {
        case MT.GGUF_UNET:
            // 恢复CLIP类型完整选项列表
            if (clipTypeW && clipTypeW._origValues) {
                clipTypeW.options.values = clipTypeW._origValues;
                if (!clipTypeW._origValues.includes(clipTypeW.value)) {
                    clipTypeW.value = PLACEHOLDER_CLIP_TYPE;
                }
            }
            setWidgetDisabled(clipW, false);
            setWidgetDisabled(vaeW,  false);
            setWidgetDisabled(clipTypeW, false);
            updateClipOptions(node, MT.GGUF_UNET);
            break;
        case MT.AIO:
            setWidgetDisabled(clipW, true);
            setWidgetDisabled(vaeW,  true);
            // AIO：CLIP类型禁用，值确保在选项列表内
            if (clipTypeW) {
                const validValues = clipTypeW.options?.values || [];
                if (!validValues.includes(clipTypeW.value)) {
                    clipTypeW.value = PLACEHOLDER_CLIP_TYPE;
                }
                setWidgetDisabled(clipTypeW, true);
            }
            updateClipOptions(node, MT.AIO);
            break;
        case MT.UNET:
            // 恢复CLIP类型完整选项列表
            if (clipTypeW && clipTypeW._origValues) {
                clipTypeW.options.values = clipTypeW._origValues;
                if (!clipTypeW._origValues.includes(clipTypeW.value)) {
                    clipTypeW.value = PLACEHOLDER_CLIP_TYPE;
                }
            }
            setWidgetDisabled(clipW, false);
            setWidgetDisabled(vaeW,  false);
            setWidgetDisabled(clipTypeW, false);
            updateClipOptions(node, MT.UNET);
            break;
        default:
            // 恢复CLIP类型完整选项列表
            if (clipTypeW && clipTypeW._origValues) {
                clipTypeW.options.values = clipTypeW._origValues;
                if (!clipTypeW._origValues.includes(clipTypeW.value)) {
                    clipTypeW.value = PLACEHOLDER_CLIP_TYPE;
                }
            }
            setWidgetDisabled(clipW, false);
            setWidgetDisabled(vaeW,  false);
            setWidgetDisabled(clipTypeW, false);
            updateClipOptions(node, MT.UNKNOWN);
            break;
    }
}

// ─── 强制节点最小尺寸（仅宽度，高度由 computeSize 负责） ───
function enforceMinSize(node) {
    if (!node.size) return;
    const minW = 340;
    if (node.size[0] < minW) {
        node.size[0] = minW;
        if (node.setDirtyCanvas) node.setDirtyCanvas(true, false);
    }
}

// ─── 状态条绘制（两行 52px） ───
function drawStatusBar(node, ctx) {
    if (node.flags?.collapsed) return;

    const W    = node.size[0];
    const barH = STATUS_BAR_H;
    const barY = node.size[1] - barH - 8;
    const barX = 8;
    const barW = W - 16;

    ctx.save();

    // 背景
    ctx.fillStyle = C_BG;
    ctx.beginPath(); roundRect(ctx, barX, barY, barW, barH, 6); ctx.fill();

    // 细边框
    ctx.strokeStyle = C_BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath(); roundRect(ctx, barX, barY, barW, barH, 6); ctx.stroke();

    const phase = node._statePhase || PHASE.IDLE;
    const info  = node._stateInfo || {};

    switch (phase) {
        case PHASE.IDLE:
            drawIdleState(ctx, barX, barY, barW, barH);
            break;
        case PHASE.IDENTIFYING:
            drawIdentifyingState(ctx, barX, barY, barW, barH);
            break;
        case PHASE.IDENTIFIED:
        case PHASE.LOADED:
        case PHASE.EXECUTING:
        case PHASE.DONE:
        default:
            // 执行中/完成后统一显示模型识别信息，不切换阶段提示
            drawIdentifiedState(ctx, barX, barY, barW, barH, info, node);
            break;
    }

    ctx.restore();
}

function drawIdleState(ctx, bx, by, bw, bh) {
    ctx.fillStyle = C_DIM;
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("请选择主模型", bx + bw / 2, by + bh / 2);
}

let _animFrame = 0;
function drawIdentifyingState(ctx, bx, by, bw, bh) {
    _animFrame = (_animFrame + 1) % 60;
    const dots = ".".repeat(Math.floor(_animFrame / 20) + 1);
    const text = `正在读取模型信息${dots}`;
    ctx.fillStyle = C_ACCENT;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, bx + bw / 2, by + bh / 2);
}

function drawIdentifiedState(ctx, bx, by, bw, bh, info, node) {
    const mt = info.modelType || MT.AIO;
    const fileName    = info.fileName || "";
    const fileSizeMB  = info.fileSizeMB || 0;
    const clipSizeMB  = info.clipSizeMB || 0;
    const vaeSizeMB   = info.vaeSizeMB || 0;
    const ggufQuant   = info.ggufQuant || null;
    const lockUnet    = info.lockUnet ?? true;
    const clipSource  = info.clipSource || "";
    const vaeSource   = info.vaeSource || "";

    // ── 第一行：[Tag] 文件名… → 类型描述 ──
    const row1Y = by + 14;
    let x = bx + 10;

    // Tag
    const { tag, tagColor, tagLabel } = getTypeTag(mt, ggufQuant);
    if (tag && tagColor) {
        ctx.font = "bold 9px sans-serif";
        const tagW = ctx.measureText(tag).width + 10;
        ctx.fillStyle = tagColor;
        ctx.beginPath(); roundRect(ctx, x, row1Y - 8, tagW, 16, 3); ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(tag, x + 5, row1Y);
        x += tagW + 6;
    }

    // 文件名
    const rightDescW = ctx.measureText(tagLabel).width + 10;
    const maxNameW = bw - (x - bx) - rightDescW - 12;
    ctx.fillStyle = "#ddd";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    let dispName = fileName || "?";
    if (ctx.measureText(dispName).width > maxNameW) {
        while (dispName.length > 6 && ctx.measureText(dispName + "…").width > maxNameW) {
            dispName = dispName.slice(0, -1);
        }
        dispName += "…";
    }
    ctx.fillText(dispName, x, row1Y);

    // 类型描述
    ctx.fillStyle = C_DIM;
    ctx.font = "9.5px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(tagLabel, bx + bw - 10, row1Y);

    // ── 第二行：模型尺寸 + CLIP/VAE来源（左）→ UNET保活状态（右）──
    const row2Y = by + 38;
    ctx.font = "9.5px sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";

    let sizeStr = "";
    if (mt === MT.AIO) {
        const parts = [fileSizeMB > 0 ? formatSize(fileSizeMB) : ""];
        if (clipSource) parts.push("内置CLIP");
        if (vaeSource) parts.push("内置VAE");
        sizeStr = parts.filter(Boolean).join("  ·  ");
    } else {
        const parts = [];
        if (fileSizeMB > 0) parts.push(`UNET ${formatSize(fileSizeMB)}`);
        if (clipSizeMB > 0) {
            let clipLabel = `CLIP ${formatSize(clipSizeMB)}`;
            if (clipSource && clipSource !== "内置") clipLabel += ` (${clipSource})`;
            parts.push(clipLabel);
        } else if (clipSource && clipSource !== "内置") {
            parts.push(`CLIP (${clipSource})`);
        } else if (clipSource === "内置") {
            parts.push("CLIP 内置");
        } else {
            parts.push("CLIP -");
        }
        if (vaeSizeMB > 0) {
            let vaeLabel = `VAE ${formatSize(vaeSizeMB)}`;
            if (vaeSource && vaeSource !== "内置") vaeLabel += ` (${vaeSource})`;
            parts.push(vaeLabel);
        } else if (vaeSource && vaeSource !== "内置") {
            parts.push(`VAE (${vaeSource})`);
        } else if (vaeSource === "内置") {
            parts.push("VAE 内置");
        } else {
            parts.push("VAE -");
        }
        sizeStr = parts.join("  |  ");
    }

    const maxSizeW = bw * 0.55;
    ctx.fillStyle = "#999";
    let dispSize = sizeStr;
    if (ctx.measureText(dispSize).width > maxSizeW) {
        while (dispSize.length > 6 && ctx.measureText(dispSize + "…").width > maxSizeW) {
            dispSize = dispSize.slice(0, -1);
        }
        dispSize += "…";
    }
    ctx.fillText(dispSize || "", bx + 10, row2Y);

    // UNET保活指示
    ctx.textAlign = "right";
    const lockText = lockUnet ? "🔒UNET保活 ON" : "🔓UNET保活 OFF";
    ctx.fillStyle = "#777";
    ctx.font = "9px sans-serif";
    ctx.fillText(lockText, bx + bw - 10, row2Y);
}

function drawExecutingState(ctx, bx, by, bw, bh) {
    _animFrame = (_animFrame + 1) % 60;
    const pulse = 0.5 + 0.5 * Math.sin(_animFrame / 8);
    ctx.fillStyle = `rgba(240,160,32,${0.6 + 0.4 * pulse})`;
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";

    // 第一行
    ctx.fillText("⚡ 运算中…", bx + bw / 2, by + 20);
    // 第二行
    ctx.fillStyle = "#888";
    ctx.font = "9px sans-serif";
    ctx.fillText("ComfyUI 原生调度中", bx + bw / 2, by + 38);
}

function drawDoneState(ctx, bx, by, bw, bh, info) {
    ctx.fillStyle = C_OK;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("✅ 执行完成", bx + bw / 2, by + 20);
    ctx.fillStyle = "#666";
    ctx.font = "9px sans-serif";
    ctx.fillText("模型已就位 · 复用零延迟", bx + bw / 2, by + 38);
}

function drawErrorState(ctx, bx, by, bw, bh, info) {
    const errMsg = info.errorMsg || "执行出错";
    ctx.fillStyle = C_ERROR;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    // 截断显示
    let msg = errMsg.length > 50 ? errMsg.slice(0, 48) + "…" : errMsg;
    ctx.fillText(`❌ ${msg}`, bx + bw / 2, by + 20);
    ctx.fillStyle = "#777";
    ctx.font = "9px sans-serif";
    ctx.fillText("查看控制台获取完整错误详情", bx + bw / 2, by + 38);
}

function getTypeTag(modelType, ggufQuant) {
    switch (modelType) {
        case MT.AIO:
            return { tag: "AIO", tagColor: C_TAG_AIO, tagLabel: "三合一 · 内置CLIP+VAE" };
        case MT.UNET:
            return { tag: "UNET", tagColor: C_TAG_UNT, tagLabel: "独立UNET · 可搭配外部CLIP/VAE" };
        case MT.GGUF_UNET:
            return {
                tag: ggufQuant || "GGUF", tagColor: C_TAG_GUF,
                tagLabel: `GGUF量化${ggufQuant ? " · " + ggufQuant : ""} · 可搭配任意CLIP`,
            };
        default:
            return { tag: null, tagColor: null, tagLabel: "" };
    }
}

// ─── 更新节点状态并重绘 ───
function setNodePhase(node, phase, info = {}) {
    node._statePhase = phase;
    node._stateInfo  = { ...node._stateInfo, ...info };
    enforceMinSize(node);
    app.graph?.setDirtyCanvas?.(true, false);
}

// ─── 当用户选择模型后：文件夹预判 → API精确确认 ───
async function onModelSelected(node, modelName) {
    if (!modelName || modelName === PLACEHOLDER_MODEL) {
        setNodePhase(node, PHASE.IDLE);
        applyModelTypeLinkage(node, MT.UNKNOWN);
        return;
    }

    const clipName = findWidget(node, "clip_name")?.value || "";
    const vaeName  = findWidget(node, "vae_name")?.value || "";

    // 1. 文件夹启发式：立即反馈
    const heuristic = folderHeuristic(modelName);
    if (heuristic === MT.GGUF_UNET) {
        const ggufQuant = parseGgufQuant(modelName);
        setNodePhase(node, PHASE.IDENTIFIED, {
            modelType: MT.GGUF_UNET,
            fileName: modelName.split("/").pop() || modelName,
            fileSizeMB: 0, clipSizeMB: 0, vaeSizeMB: 0,
            ggufQuant,
        });
        applyModelTypeLinkage(node, MT.GGUF_UNET);
        fetchModelType(modelName, clipName, vaeName).then(result => {
            if (result?.model_type === "gguf_unet") {
                setNodePhase(node, PHASE.IDENTIFIED, {
                    modelType: MT.GGUF_UNET,
                    fileName: modelName.split("/").pop() || modelName,
                    fileSizeMB: result.file_size_mb || 0,
                    clipSizeMB: result.clip_size_mb || 0,
                    vaeSizeMB: result.vae_size_mb || 0,
                    ggufQuant: result.gguf_quant || ggufQuant,
                });
            }
        });
        return;
    }

    // 2. 启发式预判
    if (heuristic !== MT.UNKNOWN) {
        setNodePhase(node, PHASE.IDENTIFYING);
        applyModelTypeLinkage(node, heuristic);
    } else {
        setNodePhase(node, PHASE.IDENTIFYING);
    }

    // 3. 异步调API精确识别
    const result = await fetchModelType(modelName, clipName, vaeName);
    if (!result) {
        if (heuristic !== MT.UNKNOWN) {
            setNodePhase(node, PHASE.IDENTIFIED, {
                modelType: heuristic,
                fileName: modelName.split("/").pop() || modelName,
                fileSizeMB: 0, clipSizeMB: 0, vaeSizeMB: 0,
            });
        } else {
            setNodePhase(node, PHASE.IDLE);
        }
        return;
    }

    // 4. API成功：精确确认
    const finalType = mapApiType(result.model_type);

    setNodePhase(node, PHASE.IDENTIFIED, {
        modelType: finalType,
        fileName: modelName.split("/").pop() || modelName,
        fileSizeMB: result.file_size_mb || 0,
        clipSizeMB: result.clip_size_mb || 0,
        vaeSizeMB: result.vae_size_mb || 0,
        ggufQuant: result.gguf_quant || null,
        folderSource: result.folder_source || null,
    });
    applyModelTypeLinkage(node, finalType);

    console.log(
        `[JosiaCheckpointPlus] ✅ 精确识别完成：${finalType} · ` +
        `${result.file_size_mb}MB · ` +
        (result.clip_size_mb ? `CLIP ${result.clip_size_mb}MB · ` : "") +
        (result.vae_size_mb ? `VAE ${result.vae_size_mb}MB` : "")
    );
}

function mapApiType(apiType) {
    switch (apiType) {
        case "aio": return MT.AIO;
        case "unet_only": case "unet": return MT.UNET;
        case "gguf_unet": return MT.GGUF_UNET;
        default: return MT.UNKNOWN;
    }
}

// ─── 监听主模型下拉变化 ───
function watchModelWidget(node) {
    const modelW = findWidget(node, "main_model");
    if (!modelW || modelW._josiaWatched) return;
    modelW._josiaWatched = true;

    const origCb = modelW.callback;
    modelW.callback = function(value) {
        origCb?.call(this, value);
        // 清除执行状态
        node._statePhase = null;

        // 同步开关状态到 info
        const lockUnet  = findWidget(node, "lock_unet_vram");
        node._stateInfo = {
            lockUnet:  lockUnet?.value ?? true,
            isLoaded:  false,
        };

        onModelSelected(node, value);
    };
}

// ─── 监听开关变化 ───
function watchSwitchWidgets(node) {
    const w = findWidget(node, "lock_unet_vram");
    if (!w || w._josiaSwitchWatched) return;
    w._josiaSwitchWatched = true;

    const origCb = w.callback;
    w.callback = function(value) {
        origCb?.call(this, value);
        if (node._stateInfo) {
            node._stateInfo.lockUnet = value;
        }
        app.graph?.setDirtyCanvas?.(true, false);
    };
}

// ─── 监听 CLIP/VAE 下拉变化 → 刷新尺寸 ───
function watchClipVaeWidgets(node) {
    for (const name of ["clip_name", "vae_name"]) {
        const w = findWidget(node, name);
        if (!w || w._josiaClipVaeWatched) continue;
        w._josiaClipVaeWatched = true;

        const origCb = w.callback;
        w.callback = function(value) {
            origCb?.call(this, value);
            // 用户切换CLIP/VAE后，重新获取所有尺寸
            refreshAllSizes(node);
        };
    }
}

async function refreshAllSizes(node) {
    const modelW = findWidget(node, "main_model");
    const clipW  = findWidget(node, "clip_name");
    const vaeW   = findWidget(node, "vae_name");
    const modelVal = modelW?.value;
    if (!modelVal || modelVal === PLACEHOLDER_MODEL) return;

    const clipVal = clipW?.value || "";
    const vaeVal  = vaeW?.value || "";
    const result = await fetchModelType(modelVal, clipVal, vaeVal);
    if (!result) return;

    const mt = node._stateInfo?.modelType || mapApiType(result.model_type);
    setNodePhase(node, PHASE.IDENTIFIED, {
        ...(node._stateInfo || {}),
        modelType: mt,
        fileName: modelVal.split("/").pop() || modelVal,
        fileSizeMB: result.file_size_mb || 0,
        clipSizeMB: result.clip_size_mb || 0,
        vaeSizeMB: result.vae_size_mb || 0,
        ggufQuant: result.gguf_quant || node._stateInfo?.ggufQuant || null,
    });
}

// ─── 初始化节点 ───
function initNode(node) {
    if (node._josiaInit) return;
    node._josiaInit = true;

    if (!node._josiaSized) {
        node.size[0] = DEFAULT_NODE_WIDTH;
    }

    // 缓存CLIP/VAE/CLIP类型原始列表
    for (const wName of ["clip_name", "vae_name", "clip_type"]) {
        const w = findWidget(node, wName);
        if (w?.options?.values && !w._origValues) {
            w._origValues = [...w.options.values];
        }
    }

    // 初始化状态：显示开关值
    const lockUnet  = findWidget(node, "lock_unet_vram");
    node._stateInfo = {
        lockUnet:  lockUnet?.value ?? true,
        isLoaded:  false,
        modelType: MT.UNKNOWN,
    };

    watchModelWidget(node);
    watchSwitchWidgets(node);
    watchClipVaeWidgets(node);

    // 恢复状态
    const modelW = findWidget(node, "main_model");
    const savedType = node._confirmedModelType;
    const modelVal  = modelW?.value;

    if ((modelVal === PLACEHOLDER_MODEL || !modelVal) && !savedType) {
        setNodePhase(node, PHASE.IDLE);
    } else if (savedType) {
        setNodePhase(node, PHASE.IDENTIFIED, {
            ...(node._stateInfo || {}),
            modelType: savedType,
            fileName: (modelVal || "").split("/").pop() || "",
        });
        applyModelTypeLinkage(node, savedType);
    } else if (modelVal) {
        // 尝试从保存的 properties恢复
        const propsType = node.properties?.model_type;
        if (propsType && propsType !== MT.UNKNOWN) {
            node._confirmedModelType = propsType;
            setNodePhase(node, PHASE.IDENTIFIED, {
                ...(node._stateInfo || {}),
                modelType: propsType,
                fileName: (modelVal || "").split("/").pop() || "",
            });
            applyModelTypeLinkage(node, propsType);
        } else {
            // 异步识别
            onModelSelected(node, modelVal);
        }
    }

    enforceMinSize(node);
}

// ─── 注册扩展 ───
app.registerExtension({
    name: "JosiaCheckpointPlus",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        // ── onNodeCreated ──
        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origCreated?.apply(this, arguments);
            this.size[0] = DEFAULT_NODE_WIDTH;
            this._josiaSized = true;
            setTimeout(() => {
                initNode(this);
                if (!this._statePhase) setNodePhase(this, PHASE.IDLE);
            }, 50);
            return r;
        };

        // ── onAdded ──
        const origAdded = nodeType.prototype.onAdded;
        nodeType.prototype.onAdded = function (graph) {
            origAdded?.call(this, graph);
            setTimeout(() => {
                initNode(this);
                if (!this._statePhase) setNodePhase(this, PHASE.IDLE);
            }, 80);
        };

        // ── computeSize（让ComfyUI布局引擎自动预留状态条空间）──
        const origComputeSize = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (out) {
            const size = origComputeSize ? origComputeSize.call(this, out) : [this.size[0], this.size[1]];
            if (!size) return size;
            const extraH = STATUS_BAR_H + 2;
            size[1] += extraH;
            if (size[0] < 340) size[0] = 340;
            if (out) { out[0] = size[0]; out[1] = size[1]; }
            return size;
        };

        // ── onResize（用户手动缩小时：仅阻止极端缩小，不强制增高）──
        const origResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            // 绝对最小高度 = 标题 + 一个widget + 状态条 + 4px缝隙
            const absMinH = (typeof LiteGraph !== "undefined" ? LiteGraph.NODE_TITLE_HEIGHT : 30) + 24 + STATUS_BAR_H + 4;
            size[1] = Math.max(size[1], absMinH);
            size[0] = Math.max(size[0], 340);
            if (origResize) origResize.call(this, size);
        };

        // ── onDrawForeground ──
        const origDraw = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            origDraw?.call(this, ctx);
            drawStatusBar(this, ctx);
        };

        // ── onConfigure（工作流加载恢复） ──
        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origConfigure?.call(this, info);
            setTimeout(() => {
                initNode(this);
                const savedType = info?.properties?.model_type;
                if (savedType && savedType !== MT.UNKNOWN) {
                    this._confirmedModelType = savedType;
                    applyModelTypeLinkage(this, savedType);
                    const modelW = findWidget(this, "main_model");
                    setNodePhase(this, PHASE.IDENTIFIED, {
                        ...(this._stateInfo || {}),
                        modelType: savedType,
                        fileName: (modelW?.value || "").split("/").pop() || "",
                    });
                }
            }, 80);
        };

        // ── onExecuting（不切换阶段，保持模型信息显示） ──
        const origExecuting = nodeType.prototype.onExecuting;
        nodeType.prototype.onExecuting = function () {
            origExecuting?.call(this);
            // 不修改 phase，继续显示 IDENTIFIED 状态
        };

        // ── onExecuted（执行后更新模型信息，保持同一状态条显示） ──
        const origExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            origExecuted?.call(this, message);

            const backendType = message?.model_type?.[0];
            if (backendType) {
                this._confirmedModelType = backendType;
                this.properties = this.properties || {};
                this.properties.model_type = backendType;

                applyModelTypeLinkage(this, backendType);

                setNodePhase(this, PHASE.IDENTIFIED, {
                    ...(this._stateInfo || {}),
                    modelType: backendType,
                    isLoaded: true,
                    fileName: (message?.main_model?.[0] || "").split("/").pop() || "",
                    fileSizeMB: message?.file_size_mb?.[0] || 0,
                    clipSizeMB: message?.clip_size_mb?.[0] || 0,
                    vaeSizeMB: message?.vae_size_mb?.[0] || 0,
                    ggufQuant: message?.gguf_quant?.[0] || null,
                    clipSource: message?.clip_source?.[0] || "",
                    vaeSource: message?.vae_source?.[0] || "",
                });

                console.log(
                    `[JosiaCheckpointPlus] 执行完成 · ` +
                    `类型=${backendType} · ${message?.file_size_mb?.[0]}MB` +
                    (message?.clip_size_mb?.[0] ? ` · CLIP ${message.clip_size_mb[0]}MB` : "") +
                    (message?.vae_size_mb?.[0] ? ` · VAE ${message.vae_size_mb[0]}MB` : "")
                );
            } else {
                setNodePhase(this, PHASE.IDENTIFIED, {
                    ...(this._stateInfo || {}), isLoaded: true,
                    fileName: (message?.main_model?.[0] || "").split("/").pop() || "",
                    fileSizeMB: message?.file_size_mb?.[0] || 0,
                    clipSizeMB: message?.clip_size_mb?.[0] || 0,
                    vaeSizeMB: message?.vae_size_mb?.[0] || 0,
                    clipSource: message?.clip_source?.[0] || "",
                    vaeSource: message?.vae_source?.[0] || "",
                });
            }
        };

        // ── onError ──
        const origError = nodeType.prototype.onError;
        nodeType.prototype.onError = function (err) {
            origError?.call(this, err);
            setNodePhase(this, PHASE.ERROR, {
                errorMsg: err?.message || String(err),
            });
        };
    },

    // ── loadedGraphNode ──
    loadedGraphNode(node) {
        if (node.comfyClass !== NODE_NAME) return;
        setTimeout(() => {
            node._josiaSized = true;
            initNode(node);
            if (!node._statePhase) setNodePhase(node, PHASE.IDLE);
        }, 100);
    },
});
