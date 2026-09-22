/**
 * JosiaNodes · 设置项：依赖安装（占位符）
 * 对应 media_save.py 的运行期提示：「可在设置里的『依赖安装』中安装对应插件」。
 * 这里在 ComfyUI 设置的「⚡️JosiaNodes」分类下挂一个占位项，
 * 把可选格式后端依赖的 pip 安装命令直接放在默认值里，方便随时复制，避免忘记。
 *
 * 依赖说明（缺哪个装哪个，不必全装）：
 *   · AVIF     → pillow-avif-plugin
 *   · HEIF     → pillow-heif
 *   · JPEG XL  → pillow-jxl
 *   · 视频/动图容器（MP4 / MKV / WebM / APNG）→ PyAV（av），通常随 ComfyUI 自带
 */
import { app } from "../../../scripts/app.js";

// 缺省即完整的一键安装命令（单行，便于直接从设置输入框复制）
const DEP_INSTALL_CMD =
  "pip install pillow-avif-plugin pillow-heif pillow-jxl av";

app.registerExtension({
  name: "JosiaNodes.Settings.DependencyInstall",
  async init() {
    try {
      const settings = app.ui?.settings;
      if (!settings || typeof settings.addSetting !== "function") return;
      settings.addSetting({
        id: "JosiaNodes.DependencyInstall",
        name: "依赖安装（Josia媒体保存 · 复制命令去终端执行）",
        // 🔴 一级分类统一 ⚡️JosiaNodes（与项目其它设置保持一致）
        category: ["⚡️JosiaNodes"],
        type: "text",
        defaultValue: DEP_INSTALL_CMD,
        // 简短说明（部分 ComfyUI 版本会在设置项旁展示）
        tooltip:
          "Josia媒体保存 的可选格式依赖：AVIF / HEIF / JPEG XL 需要 pillow 插件，" +
          "视频/动图容器需要 PyAV(av)。复制上方命令到终端执行即可补齐。",
      });
    } catch (e) {
      // 设置项注册失败不应阻断节点本身
      console.warn("[JosiaNodes] 依赖安装设置项注册失败：", e);
    }
  },
});
