/**
 * JosiaNodes · 品牌展示（设置页大标题 + 「关于」页徽章）
 *
 * 1) 设置页大标题：在设置 → ⚡️JosiaNodes 分类页最上方渲染「⚡️JosiaNodes vX.Y.Z」。
 *    走声明式 settings 字段 + 函数型 type（FormItem.vue → CustomFormValue 挂载）；
 *    分组排序规则（已取证 1.52.7 SettingDialog.sortedGroups）：按 sortOrder 降序 +
 *    label 拼音序，与注册顺序无关 —— 故给标题项设高 sortOrder 让其分组置顶。
 * 2) 「关于」页徽章：在设置 → 关于 页面的徽章行（ComfyUI 版本 / Discord / EasyUse
 *    那排）追加「JosiaNodes vX.Y.Z」徽章，点击跳转作者的 B 站空间。走前端原生
 *    aboutPageBadges 扩展字段（AboutPanel.vue 汇总渲染，EasyUse 同款做法）。
 *
 * 版本号来源：后端 /josia_dep/version（读 pyproject.toml，唯一事实源，勿在前端写死）。
 * 图标：B 站 TV 图标用 CSS mask 实现并继承 currentColor，与 PrimeIcons 字体图标观感一致。
 */
import { app } from "../../scripts/app.js";

const BILI_URL = "https://space.bilibili.com/3706973113551694";
const ICON_CLASS = "josia-bili-icon";

// B 站 TV 图标（simple-icons bilibili，24x24 单 path），经 URL 编码塞进 CSS mask
const ICON_PATH =
  "M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373Z";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${ICON_PATH}"/></svg>`;
const encoded = encodeURIComponent(svg);

function injectIconStyle() {
  if (document.getElementById("josia-bili-icon-style")) return;
  const s = document.createElement("style");
  s.id = "josia-bili-icon-style";
  s.textContent = `.${ICON_CLASS}{display:inline-block;width:1em;height:1em;background-color:currentColor;-webkit-mask:url("data:image/svg+xml,${encoded}") no-repeat center / contain;mask:url("data:image/svg+xml,${encoded}") no-repeat center / contain;}`;
  document.head.appendChild(s);
}

// 让带 .josia-setting-block 的 FormItem 行换行布局（标签一行、内容整行铺开）。
// 与 settings_dependency_install.js 共用同一条规则，id 幂等，谁先挂载谁注入。
function injectBlockStyle() {
  if (document.getElementById("josia-dep-style")) return;
  const s = document.createElement("style");
  s.id = "josia-dep-style";
  s.textContent =
    "div.flex.min-h-8.flex-row:has(.josia-setting-block){flex-wrap:wrap;}" +
    "div.flex.min-h-8.flex-row:has(.josia-setting-block)>div.form-input" +
    "{flex:0 0 100%;justify-content:flex-start;}";
  document.head.appendChild(s);
}

async function fetchVersion() {
  try {
    const r = await fetch("/josia_dep/version");
    if (r.ok) {
      const d = await r.json();
      if (d && d.version) return "v" + d.version;
    }
  } catch (e) {
    /* 路由不可用时静默降级：徽章/标题只显示名称 */
  }
  return "";
}

// 共享同一份版本号请求：徽章与大标题各取所需，不发重复 HTTP
const versionPromise = fetchVersion();

injectIconStyle();

// 设置页大标题：同步注册（设置项注册不依赖版本号，标题内版本号异步补齐）
app.registerExtension({
  name: "JosiaNodes.Settings.BrandTitle",
  settings: [
    {
      id: "JosiaNodes.BrandTitle",
      name: "",
      // 🔴 category 必须 ≥2 段（末段仅作树键）：单段 category 会让整个 ⚡️JosiaNodes
      //    分类从设置面板消失（buildTree 把一级节点标 leaf → 被并入合成 "Other"）。
      category: ["⚡️JosiaNodes", "关于"],
      // 高 sortOrder ⇒ 本分组排在该设置页最上方（其余分组默认 0，按拼音序排在后）
      sortOrder: 100,
      defaultValue: "",
      type: () => {
        injectBlockStyle();
        const root = document.createElement("div");
        root.className = "josia-setting-block";
        root.style.display = "flex";
        root.style.alignItems = "baseline";
        root.style.gap = "8px";
        const name = document.createElement("span");
        name.textContent = "⚡️JosiaNodes";
        name.style.fontSize = "20px";
        name.style.fontWeight = "700";
        const ver = document.createElement("span");
        ver.style.fontSize = "13px";
        ver.style.color = "var(--fg-muted, #888)";
        root.appendChild(name);
        root.appendChild(ver);
        versionPromise.then((v) => {
          ver.textContent = v;
        });
        return root;
      },
    },
  ],
});

// 「关于」页徽章：取到版本号后再注册，label 一次成型（原生 aboutPageBadges 汇总渲染）
(async () => {
  const ver = await versionPromise;
  app.registerExtension({
    name: "JosiaNodes.AboutPageBadge",
    aboutPageBadges: [
      {
        label: ver ? `JosiaNodes ${ver}` : "JosiaNodes",
        url: BILI_URL,
        icon: ICON_CLASS,
      },
    ],
  });
})();
