/**
 * JosiaNodes · 设置项：依赖安装器（交互式）
 * 对应 Josia媒体保存 的可选格式后端依赖。
 *
 * 设计红线：Comfy Registry 禁止运行时 subprocess 装包，故本设置项「只生成命令 + 复制」，
 * 不自动执行 pip install；打开设置页时自动调用只读检测路由（/josia_dep/check）
 * 禁用已装项并取得 ComfyUI 专用 Python 路径。
 *
 * 生成命令的安全设计（全程零外部进程，不弹终端不开文件夹）：
 *   命令内嵌 ComfyUI 专用 Python 的绝对路径 + 阿里云 PyPI 镜像源，
 *   用户在任意目录的终端 / 任意 bat 中执行，都只会装入 ComfyUI 环境，
 *   绝不会误装进系统 Python。命令体纯英文，可安全存为 bat。
 *
 * 注册范式（与 model_folder_colors.js / group_enhancements.js 一致）：
 *   用 app.registerExtension({ settings: [...] }) 声明式字段，函数型 type 返回自定义 HTMLElement。
 *   函数型 type 由前端 FormItem.vue → CustomFormValue 挂载（已取证 comfyui_frontend 1.52.7）。
 *   CustomFormValue 在重渲染时会清空重建 DOM，故所有交互状态放在闭包 state，
 *   每次重建都从 state 恢复，勾选态不丢。
 *
 * 布局：FormItem 默认「标签左 + 控件右」两栏；这里注入一条 :has() 规则让带
 *   .josia-setting-block 的行改为换行布局（标签一行、内容整行铺开），实现上下排列。
 *
 * ⚠️ 不要用 app.ui.settings.addSetting（已 @deprecated，init 时机 settings 可能未就绪，
 *    会导致设置项静默不注册）。
 */
import { app } from "../../scripts/app.js";

// 阿里云镜像（国内速度快；清华镜像较慢，不用）
const PYPI_MIRROR = "https://mirrors.aliyun.com/pypi/simple/";

// 依赖清单（key 与后端 /josia_dep/check 返回字段一致）
const DEPS = [
  { key: "avif", label: "AVIF", pkg: "pillow-avif-plugin", note: "图像格式" },
  { key: "heif", label: "HEIF", pkg: "pillow-heif", note: "图像格式（iPhone 实拍常见）" },
  // 🔴 pip 包名必须照抄 PyPI：JPEG XL 插件的发布名是 pillow-jxl-plugin（import 名 pillow_jxl）。
  //    曾按字面父项目猜成 pillow-jxl ⇒ pip 直接报 "No matching distribution found"，
  //    而且 pip 是「先收集全部再安装」，一条命令里只要有一个包找不到，其余的一并安装失败。
  { key: "jxl", label: "JPEG XL", pkg: "pillow-jxl-plugin", note: "图像格式" },
  // 🔴 PyAV 不是图像格式：它撑的是视频容器（MP4 / MKV / WebM）与全部音频格式，
  //    随 ComfyUI 自带 —— 所以「图像格式」下拉里找不到叫 PyAV 的项属正常，别再当 bug。
  { key: "pyav", label: "PyAV (av)", pkg: "av",
    note: "视频容器 / 音频格式后端 · ComfyUI 自带（不是图像格式）" },
];

// 依赖 → 它在「图像格式」下拉里对应的格式名（pyav 不在图像下拉里，故不在此表）
const FORMAT_OF = { avif: "AVIF", heif: "HEIF", jxl: "JPEG XL" };

// 闭包状态：跨 DOM 重建保留
const state = {
  selected: new Set(), // 用户勾选的 key
  installed: {}, // 后端检测结果 {key: bool}
  nodeLabels: null, // 节点「图像格式」下拉里当前实际出现的格式名（null = 未取到）
  python: "", // 后端 sys.executable 绝对路径（命令内嵌，保证装进 ComfyUI 环境）
  detail: {}, // 后端逐项状态：missing / no_saver / ok
  checked: false, // 是否已完成首次自动检测
  checking: false,
  msg: "", // 提示文案
  root: null, // 当前挂载的根元素（供事件内重建）
};

// CSS：让带 .josia-setting-block 的 FormItem 行换行 —— 标签一行、内容整行铺开
function injectPanelStyle() {
  if (document.getElementById("josia-dep-style")) return;
  const s = document.createElement("style");
  s.id = "josia-dep-style";
  s.textContent =
    "div.flex.min-h-8.flex-row:has(.josia-setting-block){flex-wrap:wrap;}" +
    "div.flex.min-h-8.flex-row:has(.josia-setting-block)>div.form-input" +
    "{flex:0 0 100%;justify-content:flex-start;}";
  document.head.appendChild(s);
}

function buildCmd() {
  const pkgs = DEPS.filter((d) => state.selected.has(d.key)).map((d) => d.pkg);
  if (!pkgs.length) return "";
  if (!state.python) return "";
  return `"${state.python}" -m pip install ${pkgs.join(" ")} -i ${PYPI_MIRROR}`;
}

function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) Object.assign(node, props);
  for (const c of children || []) {
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function styleBtn(btn, primary) {
  btn.style.height = "22px";
  btn.style.borderRadius = "4px";
  btn.style.border = "1px solid " + (primary ? "#4c8bf5" : "#555");
  btn.style.background = primary ? "#4c8bf5" : "transparent";
  btn.style.color = primary ? "#fff" : "var(--fg, #ddd)";
  btn.style.cursor = "pointer";
  btn.style.padding = "0 10px";
  btn.style.fontSize = "12px";
}

function buildInto(root) {
  root.innerHTML = "";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "8px";
  root.style.width = "100%";

  // 说明（用法全列举，命令零外部进程、任意目录可执行）
  const tip = el("div");
  tip.style.fontSize = "12px";
  tip.style.color = "var(--fg-muted, #888)";
  tip.style.lineHeight = "1.6";
  tip.textContent =
    "命令已内嵌 ComfyUI 专用 Python 的绝对路径与阿里云镜像源，在任意目录执行都只装入 ComfyUI 环境，不影响系统 Python。三种用法任选：" +
    "① Win+R 输入 cmd 回车，粘贴命令回车；" +
    "② 在任意文件夹的地址栏输入 cmd 回车，粘贴命令回车；" +
    "③ 新建 install.bat（内容保持纯英文），粘贴保存后双击运行。" +
    "装完点「重新检测」确认，再重启 ComfyUI 生效。也可以直接把命令发给 AI，让 AI 指导逐步操作。";
  root.appendChild(tip);

  // 兼容性兜底（各种用户环境的一键排障清单，都不需要动 ComfyUI 本体）
  const caveats = el("div");
  caveats.style.fontSize = "12px";
  caveats.style.color = "var(--fg-muted, #888)";
  caveats.style.lineHeight = "1.6";
  caveats.style.borderLeft = "2px solid #555";
  caveats.style.paddingLeft = "8px";
  // 逐条独立成行（挤成一坨没人读）
  for (const line of [
    "• 报 “No module named pip”：先在同一个终端执行 "
      + `"${state.python || "ComfyUI 的 python.exe"}" -m ensurepip --upgrade，再重试。`,
    "• 镜像源访问不了：把命令末尾 -i 那一段换成 -i https://pypi.org/simple 用官方源。",
    "• Python 3.9 的环境装不了新版 JPEG XL 插件：单独执行 "
      + `"${state.python || "python"}" -m pip install "pillow-jxl-plugin<1.3.5"。`,
    "• HEIF 插件要求 Pillow ≥ 11.1：环境里 Pillow 更旧时会被顺带升级"
      + "（ComfyUI 自身不限 Pillow 版本）；介意的话就别一次全勾选。",
    "• Linux / macOS 命令相同；不要加 sudo（sudo 会绕开绝对路径、装进系统环境）。",
  ]) {
    const d = el("div", { textContent: line });
    d.style.marginBottom = "2px";
    caveats.appendChild(d);
  }
  root.appendChild(caveats);

  // 依赖勾选行
  const list = el("div");
  list.style.display = "flex";
  list.style.flexDirection = "column";
  list.style.gap = "4px";
  for (const d of DEPS) {
    const row = el("label");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "6px";
    row.style.fontSize = "13px";

    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = state.installed[d.key] === true || state.selected.has(d.key);
    cb.disabled = state.installed[d.key] === true;
    cb.addEventListener("change", () => {
      if (cb.checked) state.selected.add(d.key);
      else state.selected.delete(d.key);
      preview.value = buildCmd();
    });

    const txt = el("span");
    txt.textContent = `${d.label}（${d.pkg}）— ${d.note}`;
    if (state.installed[d.key] === true) {
      const ok = el("span");
      ok.textContent = " ✓已装";
      ok.style.color = "#4caf50";
      txt.appendChild(ok);
    } else if (state.detail[d.key] === "no_saver") {
      // 包装上了、但没能向 Pillow 注册保存器 ⇒ 节点下拉里照样没有这个格式
      const bad = el("span");
      bad.textContent = " ⚠️ 装了但没生效（Pillow 没能登记它的保存器）";
      bad.style.color = "#ff9800";
      txt.appendChild(bad);
    }
    row.appendChild(cb);
    row.appendChild(txt);
    list.appendChild(row);
  }
  root.appendChild(list);

  // 按钮行
  const btns = el("div");
  btns.style.display = "flex";
  btns.style.gap = "8px";

  const copyBtn = el("button");
  copyBtn.type = "button";
  copyBtn.textContent = "复制命令";
  styleBtn(copyBtn, true);
  copyBtn.addEventListener("click", onCopy);
  btns.appendChild(copyBtn);

  // 「重新检测」：force=1 让后端作废缓存重新探测 ⇒ 在终端里刚装完、还没重启 ComfyUI 时，
  // 点一下就能立刻确认是否装上（不必重启 ComfyUI 去赌）。
  const checkBtn = el("button");
  checkBtn.type = "button";
  checkBtn.textContent = state.checking ? "检测中…" : "重新检测";
  styleBtn(checkBtn, false);
  checkBtn.disabled = state.checking;
  checkBtn.style.opacity = state.checking ? ".5" : "1";
  checkBtn.title =
    "重新向后端查询一次（作废缓存）。刚在终端装完依赖但还没重启 ComfyUI 时，点它可以立刻确认是否装上。";
  checkBtn.addEventListener("click", () => {
    void runCheck(true);
  });
  btns.appendChild(checkBtn);
  root.appendChild(btns);

  // 命令预览（只读）
  const preview = el("textarea");
  preview.readOnly = true;
  preview.rows = 2;
  preview.value = buildCmd();
  preview.style.width = "100%";
  preview.style.fontFamily = "monospace";
  preview.style.fontSize = "12px";
  preview.style.resize = "vertical";
  root.appendChild(preview);

  // 状态 / 提示
  const status = el("div");
  status.style.fontSize = "12px";
  status.style.minHeight = "16px";
  status.style.color = state.msg.startsWith("✅")
    ? "#4caf50"
    : state.msg.startsWith("⚠️")
    ? "#ff9800"
    : "var(--fg-muted, #888)";
  status.textContent = state.msg;
  root.appendChild(status);
}

// 节点「图像格式」下拉当前实际有哪些格式（去掉 ⭐ 前缀后比对）
async function loadNodeFormats() {
  try {
    const r = await fetch("/josia_media_save/formats");
    if (!r.ok) return;
    const d = await r.json();
    const set = new Set();
    for (const it of (d.images || [])) {
      if (it && it.label) set.add(String(it.label).replace(/^[⭐\s]+/, "").trim());
    }
    state.nodeLabels = set;
  } catch (e) { /* 取不到就不做交叉核对，不影响主流程 */ }
}

async function runCheck(force) {
  if (state.checking) return;
  state.checking = true;
  if (state.root) buildInto(state.root);
  try {
    const r = await fetch(force ? "/josia_dep/check?force=1" : "/josia_dep/check");
    if (r.ok) {
      const d = await r.json();
      state.python = typeof d.python === "string" ? d.python : "";
      state.installed = d;
      state.detail = d.detail || {};
      const done = DEPS.filter((x) => d[x.key]).map((x) => x.label);
      const miss = DEPS.filter((x) => !d[x.key]).map((x) => x.label);
      // 装上了但没能向 Pillow 注册保存器 ⇒ 节点下拉里照样没有这个格式
      const broke = DEPS.filter((x) => state.detail[x.key] === "no_saver")
        .map((x) => x.label);
      state.msg = `检测完成：已装 ${done.join("、") || "无"}；未装 ${miss.join("、") || "无"}`;
      if (broke.length) {
        state.msg += ` ｜ ⚠️ ${broke.join("、")} 装了但没注册保存器（节点下拉里仍不会出现）`;
      }
      // 交叉核对节点下拉：装了却没出现 ⇒ 说明本次启动早于安装，需要重启
      await loadNodeFormats();
      const pending = DEPS.filter(
        (x) => d[x.key] && FORMAT_OF[x.key] && state.nodeLabels
          && !state.nodeLabels.has(FORMAT_OF[x.key])).map((x) => FORMAT_OF[x.key]);
      if (pending.length) {
        state.msg += ` ｜ ⚠️ ${pending.join("、")} 尚未出现在节点下拉里 —— 重启 ComfyUI 后生效`;
      }
      if (force && done.length && !pending.length && !broke.length) {
        state.msg = `✅ ${done.join("、")} 检测通过 —— 重启 ComfyUI 后即可在「图像格式」下拉里选择`;
      }
    } else {
      // 404 = 路由没注册（模块没加载）；其它状态码多半是 handler 内部报错 —— 别混为一谈
      if (r.status === 404) {
        state.msg = "⚠️ 检测失败：后端路由不存在（插件未加载？须重启 ComfyUI）";
      } else {
        state.msg = `⚠️ 检测失败：后端报错 ${r.status}（看 ComfyUI 控制台的完整报错）`;
      }
    }
  } catch (e) {
    state.msg = "⚠️ 检测失败：" + (e && e.message ? e.message : String(e));
  }
  state.checked = true;
  state.checking = false;
  if (state.root) buildInto(state.root);
}

// 打开设置页自动检测一次（走后端缓存；点「重新检测」按钮才 force 重新探测）
function ensureChecked() {
  if (state.checked || state.checking) return;
  void runCheck(false);
}

async function onCopy() {
  const cmd = buildCmd();
  if (!cmd) {
    state.msg = state.python
      ? "⚠️ 请先勾选要安装的依赖"
      : "⚠️ 检测服务不可用，拿不到 ComfyUI 专用 Python 路径，已停止生成命令（避免误装系统环境）";
    if (state.root) buildInto(state.root);
    return;
  }
  try {
    await navigator.clipboard.writeText(cmd);
    state.msg = "✅ 已复制命令，按上方说明在任意目录执行，重启 ComfyUI 生效";
  } catch (e) {
    // 非安全上下文（远程访问）降级：选中文本让用户手动 Ctrl+C
    const ta = state.root && state.root.querySelector("textarea");
    if (ta) {
      ta.focus();
      ta.select();
    }
    state.msg = "已生成命令，请按 Ctrl+C 复制：" + cmd;
  }
  if (state.root) buildInto(state.root);
}

app.registerExtension({
  name: "JosiaNodes.Settings.DependencyInstall",
  settings: [
    {
      id: "JosiaNodes.DependencyInstall",
      name: "Josia媒体保存 · 可选格式依赖",
      // 🔴 category 必须是「多级路径」（≥2 段）：首段 ⚡️JosiaNodes 与项目其它设置统一，
      //    末段作唯一树键（仅作树键、不显示在 UI）。绝不可写成单段 ["⚡️JosiaNodes"]：
      //    前端 buildTree()（treeUtil.ts）会把该一级节点标成 leaf，useSettingUI() 随即
      //    把它当「悬浮设置」整体并入合成的 "Other" 节点 ⇒ ⚡️JosiaNodes 从自定义分类里消失。
      category: ["⚡️JosiaNodes", "依赖安装"],
      // 函数型 type：返回自定义 HTMLElement（E 盘实测前端版本的 custom widget 写法）
      type: (name, setValue, value, attrs) => {
        injectPanelStyle();
        const root = document.createElement("div");
        root.className = "josia-setting-block";
        state.root = root;
        buildInto(root);
        void ensureChecked();
        return root;
      },
      defaultValue: "",
      tooltip:
        "Josia媒体保存 的可选格式依赖：AVIF / HEIF / JPEG XL 需要 pillow 插件，" +
        "视频/动图容器需要 PyAV(av)。打开本页自动检测；勾选后复制命令到任意终端执行即可补齐，重启 ComfyUI 生效。",
    },
  ],
});
