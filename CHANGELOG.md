# Changelog

所有项目的重要变更都会记录在这个文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [1.5.5] - 2026-07-19

### ✨ 新增功能

#### 图像对比节点（JosiaImageComparer）
- **新增输出口「拼接图像」**：将原「透传单张图像」改为把图像A与图像B左右无缝拼接成一张图输出。
  - 两图高度不一致时，自动把 B 用 lanczos 等比缩放到与 A 同高再拼接，避免上下错位 / 黑边。
  - batch 数不同时取较小者对齐；只接一张则原样输出；都不接输出空（不再崩溃）。
- **画布对比层（A/B 滑动 / 按住对比）恢复**：后端按原生 `ImageCompare` 约定，把 `a_images`/`b_images` 直接放在 `ui` 根下（不包 `output` 层）；前端 `onExecuted` 改为深搜取数 + null 防御，彻底解决对比层消失问题。

### 🐛 Bug 修复

#### 模型加载节点（JosiaCheckpointPlus）
- **修复 CLIP 类型报错（flux2 / lumina2 等）**：根因为 `_clip_type_to_enum` 用 `getattr(CT, type)` 小写枚举名，而 `comfy.sd.CLIPType` 成员全大写，导致永远回退 `STABLE_DIFFUSION`。改为 `getattr(CT, type.upper())` 对齐原生 `CLIPLoader`，现全部 24 种 CLIP 类型（含 flux2 / lumina2）均正常启用。

#### 图像对比节点（JosiaImageComparer）
- **修复下游节点接收输出报 `NoneType` 崩溃**：补充 `RETURN_TYPES=("IMAGE",)`，输出口正确透传拼接图像（之前继承 `PreviewImage` 无 IMAGE 输出，接到下游会传 None 而崩）。

#### 多图加载节点（JosiaMultiImageLoader）
- **修复节点消失问题**：此前误删 `node_properties.py` 的 `NODE_CATEGORY` 共享常量，导致 `multi_image_loader.py` / `image_scaling.py` 因 import 失败被 ComfyUI 静默跳过。恢复常量并统一 `CATEGORY="Josia"`，全部节点恢复正常。

### ♻️ 重构 / 优化

#### 模型加载节点（JosiaCheckpointPlus）
- **取消自研显存调度（块交换）功能**：新版 ComfyUI（0.28.1）已内置更先进的 DynamicVRAM 调度，移除 block 级搬运接入（代码文件 `block_swap_engine.py` 保留作参考，不再被引用）。保留「UNET 保活」开关。

#### 缓存清理节点（JosiaCacheCleanup）
- **重写实现（v2）回归设计初衷**：在保持模型缓存状态下清理无用显存 / 内存，不卸载模型。
  - 仅做 `gc.collect()` + `comfy.model_management.soft_empty_cache()`（等价于 `torch.cuda.empty_cache()`，只释放空闲显存、不卸载被引用模型）。
  - 不再卸载模型、不再清理 Windows 系统文件缓存 / 进程工作集。
  - 新增「深度回收」开关（默认关，额外二次 `empty_cache` + gc）。

#### 多图加载节点（JosiaMultiImageLoader）
- **前端灰化优化**：关闭图像缩放时，只灰化当前实际显示的缩放参数（像素模式只灰化像素相关、边长模式只灰化边长相关），不再强制显示并灰化另一模式的参数。
- **上游图像端口 display_name 改为英文 `image_in`**（内部参数名 `images` 不变）。

#### 分类与节点顺序
- 恢复单级分类 `Josia`（不再用带编号子分类，避免某些版本分类名覆盖导致节点丢失），节点菜单由 ComfyUI 默认排序。

### 📝 文档更新
- 更新 `README.md`：图像对比节点新增拼接输出说明、缓存清理节点对齐 v2 行为、模型加载节点补充 CLIP 类型修复说明。
- 更新 `CHANGELOG.md`，记录 v1.5.5 版本变更。
- 更新 `pyproject.toml` 版本号 1.5.3 → 1.5.5。

---

## [1.5.3] - 2026-07-02

### ✨ 新增功能

#### 文本列表节点（JosiaTextList）v2.1.0
- **节点下方自动扩展预览窗口**：运行后在节点下方动态显示分割结果，每个文本段一个独立显示框
- **自定义分隔符**：支持 `\n`（换行）、`\t`（制表）、逗号、分号等任意分隔符
- **去重过滤**：自动去除重复行，保持原始顺序
- **正则过滤**：支持正则表达式筛选匹配的行，内置 11 种自定义快捷规则：
  - `/汉字/` 匹配中文 | `/汉字开头/` 匹配以汉字开头 | `/纯汉字/` 纯中文行
  - `/英文/` 匹配英文 | `/数字/` 匹配数字 | `/空行/` 匹配空行 | `/空格/` 匹配空格
  - `/序号行/` 匹配带序号行 | `/标签行/` 匹配标签行
  - `/?文本/` 万能匹配（如 `/天空/` 匹配含"天空"的行）
  - `/?文本开头/` 万能开头匹配（如 `/天空开头/` 匹配以"天空"开头的行）
- **显示模式切换**：列表模式（每段文本一个显示框）/ 完整文本（合并为一段显示）
- **支持独立运行**：点击节点上方运行按钮可单独执行节点

### 🎨 界面优化
- **开关按钮 Emoji 统一**：开启使用 ✅，关闭使用 ❎
- **正则过滤提示**：采用多行对齐格式，展示自定义规则、规范正则表达式和功能说明

### 🐛 Bug 修复
- **修复运行后开关按钮消失**：使用 `onNodeCreated` 捕获初始 widget 数量，只清除动态添加的预览框

### 📝 文档更新
- 更新 `README.md`，新增文本列表节点完整功能说明
- 更新 `CHANGELOG.md`，记录 v1.5.3 版本变更
- 更新 `pyproject.toml` 版本号 1.5.0 → 1.5.3

---

## [1.5.0] - 2026-07-01

### ✨ 新增功能

#### 文本列表节点（JosiaTextList）
- 将多行字符串按换行符分割为字符串列表，每行作为一个独立字符串输出
- 支持上游文本节点连接，自动按换行符分割
- 可选过滤空行（默认开启）：自动去除分割后的空行
- 可选修剪空白（默认开启）：去除每行首尾空格、制表符等
- 适用场景：提示词批量处理、路径列表拆分、配置项拆分
- 纯 Python 标准库实现，零依赖

#### 文本保存节点（JosiaTextSave）
- 将文本内容保存到文件，支持通配符解析、文件夹选择、图像文件名复用
- 通配符支持：%date%（日期）、%time%（时间）、%date:格式%（自定义日期格式）、%003%（序号占位）
- 可选图像输入：接入图像时自动复用原图文件名作为基础名称
- 文件格式支持：txt / csv（CSV 自动添加 UTF-8 BOM，Excel 友好）
- 文件名冲突处理：同名文件自动追加 _001、_002 等编号
- 支持「选择文件夹」按钮：点击打开系统文件夹选择器
- 纯 Python 标准库实现，零依赖

### 📝 文档更新
- 更新 `pyproject.toml` 版本号 1.4.5 → 1.5.0，描述新增文本列表和文本保存节点
- 更新 `README.md`，新增文本列表和文本保存节点完整说明
- 更新 `README.md` 文件结构，添加 text_list.py / text_save.py 及前端 JS 文件
- 更新 `CHANGELOG.md`，记录 v1.5.0 版本变更

---

## [1.4.5] - 2026-06-29

### ✨ 新增功能

#### 随机种子节点（JosiaSeed）v7.2.2
- **新增 ⬆️ 递增 / ⬇️ 递减按钮**：与 🎲 每次随机同一行，使用原生 `addWidget("button")` 实现
- **递增/递减按钮初始灰化**：无历史种子时禁用（opacity:0.35 + pointer-events:none），运行生成种子后自动激活
- **后端逻辑简化**：删除 `_current_mode` 状态追踪，改为仅检查 `self._last_seed is not None`
  - `-2`（递增）：有历史种子则 `_last_seed + 1`，无则返回 `0`（不再随机初始化基数）
  - `-3`（递减）：有历史种子则 `_last_seed - 1`，无则返回 `0`（不再随机初始化基数）
- **修复固定种子分支**：else 分支新增 `self._last_seed = seed`，确保用户设定的种子值可作为后续递增/递减基数

#### 多图加载节点（JosiaMultiImageLoader）v7.2.1
- **完全重做递增机制**：抛弃 `control_after_generate` 方案（存在 +2 bug、预递增、仅工作流生效等问题）
  - 后端维护 `self._next_index` 实例变量，执行后后递增 +1
  - 通过 `PromptServer.send_sync("josia_mil_inc")` 自定义消息通知前端更新 widget
  - 支持工作流运行和下游预览单独执行两种触发方式
- **归零而非循环**：达到最大序号后 `next_index=0`（前端显示 `0 = 已全部输出完毕`）
  - `output_index=0` 时输出空列表 + 友好提示，不触发下游执行
  - 修复 JS `parseInt(0) || 1 = 1` bug（改用 `?? 1`，仅 null/undefined 回退）
- **上游端口变化自动复位**：`onConnectionsChange(type=1, inputName="images")` → 序号复位为 1
- **万能恢复默认**：重置 `output_index→1`，不清空图库，不切换 `output_mode`
- **重命名**：输出序号 → 下次输出序号（避免歧义）

### 🐛 Bug 修复

#### 多图加载节点
- **修复递增 +2 bug**：`control_after_generate` COMBO 机制和底层 widget 都递增，导致每次 +2 → 改用自定义消息机制
- **修复预递增**：`control_after_generate` 是预递增设计 → 改为后端后递增（先输出当前 idx，再计算 next_index）
- **修复仅工作流生效**：`control_after_generate` 仅对执行队列中的节点触发 → 改用 `PromptServer` 自定义消息（对工作流和单节点预览均生效）
- **修复归零失效**：JS `||` 运算符对 `0` 返回 `1` → 改用 `??` 空值合并运算符
- **修复手动设 0 仍输出图像**：Python 负索引 `all_tensors[-1]` 获取最后一张图 → 增加 `idx < 1` 显式检查

#### 随机种子节点
- **修复递增/递减首次随机基数**：固定种子分支不记录 `_last_seed`，导致切换 -2/-3 时走随机初始化 → else 分支添加 `self._last_seed = seed`
- **修复按钮样式异常**（v7.2.1）：自定义 `<a>` 元素按钮导致初始超大、hover 变形、文本可选中、点击延迟生效 → v7.2.2 回退原生 `addWidget("button")`

### 📝 文档更新
- 更新 `README.md` 随机种子节点说明，对齐 v7.2.2 功能
- 更新 `README.md` 多图加载节点说明，对齐 v7.2.1 功能
- 更新 `pyproject.toml` 版本号 1.4 → 1.4.5
- backup 目录从 `ComfyUI_JosiaNodes/backup/` 移至项目根目录 `ComfyUI custom nodes/backup/`

---

## [1.4.0] - 2026-06-27

### ✨ 新增功能

#### 多图加载节点（JosiaMultiImageLoader）
- **批量加载多张图片**：支持文件选择 / 拖拽 / 粘贴三种来源，一键批量载入
- **每张图独立等比缩放**（参考原生 ImageScaleToTotalPixels），无黑边无拉伸
  - 🖼️ 按像素缩放：按总像素目标等比缩放，每张图独立计算目标尺寸
  - 📐 按边长缩放：➡️ 按长边 / ⬇️ 按短边等比缩放，另一方向自动适配
  - 默认值=0：不缩放，原图直出
- **N 步渐进缩放**：`缩放步数` 控制分几步缩放到目标分辨率
  - 默认 1 = 一步到位（最快）
  - 2~16 = 分步渐进，大比例缩小时减少锯齿和伪影
  - 单步走 PIL 直接缩放路径（更快），多步转 tensor 分步执行（质量更好）
- **动态输出端口**：`image_list` 批次输出 + `image_1` ~ `image_N` 独立输出（最多 50 张）
- **串联模式**：可选 `images` 输入端口，上游图像插入本节点图像之前合并输出
- **原生 BOOLEAN 开关**：缩放模式 / 边长方向使用 ComfyUI 原生 BOOLEAN 控件
  - 全中文参数名 + Emoji 标签（参考 Josia文本编码节点 label_on/label_off 模式）
  - 开关状态动态显隐对应参数（syncWidgetVisibility）
- **6 种缩放算法**：lanczos / nearest / bilinear / bicubic / area / nearest-exact
- **尺寸对齐倍数**：0 / 8 / 16 / 32，适配 VAE 编解码
- **前端图库**：
  - 自适应缩略图网格（参考对标节点 optimizeGrid 算法，缩略图无限缩放）
  - 节点尺寸随图库区域自动变化（wasFresh 检测 + force-shrink 机制）
  - 使用 ComfyUI 标准 `/upload/image` API（稳定可靠）
  - 绝对路径去重，防止同名不同目录的图片重复载入
  - 滚轮缩放、分辨率标签显示、一键排序 / 清空 / 重置参数
- **公共 API 端点**：
  - `/josia_multi_image/info` — 获取图片原始宽高
  - `/josia_multi_image/input_dir` — 获取 input 目录路径
  - `/josia_multi_image/thumbnail` — 缩略图服务（多策略路径解析 + 占位图）
  - `/josia_multi_image/upload` — 拷贝外部图像到 input 目录
  - `/josia_multi_image/upload_files` — 批量上传 multipart 文件

### 🐛 Bug 修复

#### 多图加载节点
- **修复自定义 DOM 注入破坏 ComfyUI 布局**：v6.2 使用 `insertBefore` 注入开关按钮导致 `last_y`/`computeSize` 全乱 → v6.4 彻底改用原生 BOOLEAN 控件
- **修复节点高度失控**：v6.5 调用链时序混乱导致高度递增 → v6.6 完全基于对标节点重做布局系统（LAYOUT 常量 + wasFresh 检测 + force-shrink）
- **修复图像无法加载**：v6.6 自定义 `/josia_multi_image/upload` API 不稳定 → v6.7 改用 ComfyUI 标准 `/upload/image` API
- **修复"分辨率步数"名称歧义**：之前实际只做尺寸取整 → v6.8 实现真正的 N 步渐进缩放功能 + 改名"缩放步数"

### 🎨 界面优化

- **两组开关 Emoji 完全区分**：
  - 缩放模式：🖼️ 按像素缩放 / 📐 按边长缩放（图画 + 尺子系列）
  - 边长方向：➡️ 按长边缩放 / ⬇️ 按短边缩放（方向箭头系列）
- **全中文参数名**：缩放模式 / 百万像素 / 缩放步数 / 边长方向 / 边长值 / 缩放算法 / 对齐倍数

### 🔧 技术改进

- **布局系统完全对标参考节点**：
  - 统一 `LAYOUT = { MIN_GALLERY: 250, PB: 25, MIN_W: 220 }` 常量对象
  - `updateOutputPorts()` 返回 `{changed, wasFresh}` — wasFresh 检测初始 51 端口状态
  - `updateLayout(forceShrink)` 支持强制收缩模式（首次/清空时触发）
  - 覆盖 `computeSize` / `setSize` / `onResize` / `onConfigure` / `onAdded` 统一使用 LAYOUT 常量
  - 初始化不设固定尺寸，靠 `updateLayout(true)` 自动计算最小高度
- **多步渐进缩放**：`resize_tensor_multi_step()` 函数，每步线性插值中间尺寸，最后一步精确到达目标 + 对齐倍数
- **安全图像打开**：`safe_pil_open()` 参考原生 `node_helpers.pillow` 处理截断图像
- **多策略路径解析**：绝对路径 / 相对 input / 按文件名查找 / output 目录查找

### 📝 文档更新
- 更新 `README.md`，新增多图加载节点完整说明
- 更新 `README.md` 文件结构，添加 `multi_image_loader.py` 和 `multi_image_loader.js`
- 更新 `README.md` 安装方法，节点数 9 → 10
- 更新 `README.md` 重要说明，新增 image_list letterbox 说明
- 更新 `CHANGELOG.md`，记录 v1.4.0 版本变更
- 更新 `pyproject.toml`，版本号 1.3.1 → 1.4，描述新增多图加载节点

---

## [1.3.1] - 2026-06-07

### ⚠️ 临时修复

- **移除 CLIP/VAE 外部文件名显示功能**：该功能代码不稳定，且在状态栏显示外部文件名作用甚微，直接删除
  - 删除 `checkpoint_plus.py` 中 `clip_source`/`vae_source` 变量及 UI state 回传
  - 删除 `web/js/checkpoint_plus.js` 中 `clipSource`/`vaeSource` 变量及所有使用
  - 第二行状态栏回归纯尺寸显示（`UNET 5.2 GB | CLIP 320 MB | VAE 180 MB`）
  - 同步更新 `node_properties.py` / `README.md` / `CHANGELOG.md` 相关描述

---

## [1.3.0] - 2026-06-07

### ✨ 新增功能

#### 模型加载节点（JosiaCheckpointPlus）
- **智能一体化模型加载**：一个节点 100% 平替原生 CheckpointLoader / UNETLoader / CLIPLoader / VAELoader
- **自动识别三种模型类型**：
  - AIO Checkpoint（三合一）：自动复用模型内置 CLIP/VAE，自动禁用外部选框
  - 独立 UNET：可自由选配外部 CLIP 与 VAE
  - GGUF UNET：量化模型，支持搭配任意格式 CLIP（GGUF 或非 GGUF 均可）
  - **GGUF 格式依赖**：加载 GGUF 模型需安装 [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) 插件；ckpt/safetensors/bin 格式完全独立运行
- **CLIP 类型手动选择**：1:1 复刻原生 CLIPLoader 全部 24 种类型（sdxl / flux / flux2 / sd3 / wan / LTXV / hunyuan_image 等）
  - AIO 模式自动适配，独立 UNET/GGUF 模式需手动选择
  - 未选择类型时使用 STABLE_DIFFUSION 兜底
- **UNET 保活模式**（默认开启）：
  - 防止 ComfyUI 意外卸载 UNET 模型，复用工作流时跳过重新加载
  - 不强制占用物理显存，允许 ComfyUI 智能调度（`force_full_load=False`）
- **前端智能状态栏**：
  - 选中模型后自动调用 API 识别类型，显示动态加载动画
  - 实时显示模型类型标签（AIO / UNET / GGUF 量化等级）
  - 显示模型文件名、UNET / CLIP / VAE 尺寸
  - 显示 CLIP / VAE 来源（内置 or 外部文件名）
  - 显示 UNET保活开关状态
- **公共 API 端点**：注册 `/josia/detect_model_type`，供前端实时识别模型类型
- **GGUF 扩展名自动注册**：启动时自动将 `.gguf` 注册到 ComfyUI 文件系统
- **支持格式**：ckpt / safetensors / bin / gguf 全格式

### 🐛 Bug 修复

#### 模型加载节点
- **修复非 safetensors 文件重复加载**：`_detect_category_from_file()` 对非 safetensors 文件不再重复检测，默认按 AIO 处理
- **修复 AIO 模式下 CLIP 类型 "Value not in list" 报错**（v2.9.4）：AIO 模式不再替换 options.values，改为值合法性检查
- **修复 AIO 提示文本渲染**（v2.9.2-hotfix）：禁用控件时不再修改 value/options，避免运行时验证失败
- **修复 GGUF CLIP 过滤问题**（v2.9.2）：GGUF 模式不再过滤 CLIP 列表，允许搭配非 GGUF CLIP
- **修复 CLIP 类型下拉框只显示 LTXV**（v2.9.1）：取消枚举过滤，全量显示 24 种类型

### 🎨 界面优化

- **占位文本统一**：主模型🖼️ / CLIP🧠 / VAE🎨 / CLIP类型🏷️，带 Emoji 图标
- **控件联动禁用**：AIO 模式下自动禁用外部 CLIP/VAE 选框，灰色样式提示
- **GGUF 量化等级显示**：自动解析文件名中的 Q4/Q5/Q8 等量化等级
- **状态栏信息增强**（v2.9.7）：新增 CLIP/VAE 来源指示，标签 "保活" 扩展为 "UNET保活"

### ⚠️ 重要变更

- **移除分时显存优化功能**（v2.9.7）：开启后出图速度降至 201s，功能鸡肋且有副作用，彻底移除
- **移除模型精度调节功能**（v2.9.5）：RTX 4060 无 FP8 硬件加速，精度转换导致内存抖动 + 画质劣化
- **移除 SmartCLIP/SmartVAE 包装器**（v2.9.6）：不再干扰 ComfyUI 原生调度，直接使用原生对象

### 📝 文档更新
- 更新 `README.md`，新增模型加载节点完整说明
- 更新 `README.md` 文件结构，添加 `checkpoint_plus.py` 和 `checkpoint_plus.js`
- 更新 `README.md` 安装方法，新增 ComfyUI-GGUF 插件安装步骤
- 更新 `README.md` 重要说明，新增 GGUF 依赖提示
- 更新 `CHANGELOG.md`，记录 v1.3.0 版本变更
- 更新 `CHANGELOG.md` v1.3.0，补充 GGUF 格式依赖 ComfyUI-GGUF 插件的说明

---

## [1.2.0] - 2026-05-08

### ✨ 新增功能

#### LoRA 堆叠节点（JosiaLoraStack）
- **多组 LoRA 顺序堆叠**：支持 1-10 组 LoRA 按顺序应用
- **总控开关**：关闭时 model/CLIP 原样透传，开启时应用启用的 LoRA 组
- **内存/显存加载模式切换**：支持将 LoRA 加载到系统内存，节省显存
- **独立强度控制**：每组 LoRA 可独立调节模型强度（-3.00~3.00）和 CLIP 强度（-3.00~3.00）
- **同步开关**：支持模型/CLIP 强度联动，开启后两者保持一致
- **前端交互优化**：滑块支持单击定位 + 拖拽跟随，箭头步进调节，支持键盘输入精确值

### 🐛 Bug 修复

#### LoRA 堆叠节点
- **修复滑块单击后跟随鼠标**：根因是 LiteGraph 不保证 `onMouseDown` 返回 true 的节点能收到 `onMouseUp`，当鼠标移出节点边界后事件分发到其他节点
  - 使用 `captureInput(true)` 捕获输入，确保节点收到所有后续鼠标事件
  - 使用原生 `e.buttons & 1` 检测鼠标按键状态，避免自定义标志位失效
  - 拖拽结束时自动释放输入捕获 `captureInput(false)`

### 🔧 技术改进

#### 代码规范统一
- **所有节点描述外部化**：将 `DESCRIPTION` 统一维护在 `node_properties.py` 中
  - `lora_stack.py` 从 `node_properties.py` 导入 `LORA_STACK_DESCRIPTION`
  - 与 `image_scaling.py`、`group_controller.py` 等节点保持相同规范
  - 便于集中维护多语言描述和版本更新

#### 前端代码优化
- **LoRA 堆叠前端（lora_stack.js）**：
  - 版本更新至 v8，记录根因分析和修复方案
  - 清理残留拖拽状态，避免内存泄漏
  - 优化滑块交互逻辑，提升用户体验

### 📝 文档更新
- 更新 `README.md`，新增 LoRA 堆叠节点说明
- 更新 `README.md` 文件结构，添加 `lora_stack.py` 和 `lora_stack.js`
- 更新 `CHANGELOG.md`，记录 v1.2.0 版本变更

---

## [1.1.0] - 2026-05-07

### ✨ 新增功能

#### 多组控制节点（JosiaGroupControllerM）
- **单选模式**：头部新增"单选模式"按钮，开启后实现互斥激活功能
  - 启用任意分组时，自动跳过其他所有分组
  - 确保同时只有一个分组处于激活状态
  - 适用于需要快速切换不同工作流分支的场景

#### 智能初始化逻辑
- 开启单选模式时，自动检测当前已启用的分组
  - 如果存在多个启用分组，保持第一个启用分组，自动跳过其他分组
  - 避免开启单选模式后出现多个分组同时激活的情况

#### 分组变化自动检测
- 实时监测工作流中分组数量的变化
  - 检测到新增或删除分组时，自动关闭单选模式
  - 避免因分组结构变化导致的逻辑混乱
  - 通过 `node._lastGroupCount` 属性实现高效检测

### 🎨 界面优化

#### 按钮布局统一
- 头部按钮改为三个等宽按钮：`全部跳过` | `全部启用` | `单选模式`
- 按钮高度统一为 `32px`（`HEADER_H - 6`），与原有按钮保持一致
- 按钮宽度根据节点宽度自动计算，适配不同尺寸的节点

#### 按钮样式优化
- **单选模式按钮**：
  - 关闭状态：浅灰背景 `rgba(255,255,255,0.06)` + 灰色边框 + 灰色文字 `#888`
  - 开启状态：蓝色背景 `#1a73e8` + 白色文字 `#ffffff`
  - 字体和字号与旁边按钮一致：`bold 12px sans-serif`
  - 开启时不再显示 ✓ 符号，保持界面简洁

### 🔧 技术改进

#### 代码结构优化
- 移除硬编码的按钮尺寸常量（`MUTEX_BTN_W`、`MUTEX_BTN_H`）
- 按钮绘制逻辑统一使用 `_drawHeaderBtn` 函数，减少代码重复
- 单选模式按钮点击区域存储在 `node._hitMutexBtn` 中

#### 状态管理增强
- `ensureStateM()` 函数新增 `node._lastGroupCount` 属性
- 用于记录上次检查时的分组数量，实现分组变化检测
- 单选模式状态保存在 `node.properties.mutexMode` 中，随工作流序列化保存

#### 事件处理逻辑
- `handleMouseDownM()` 函数新增单选模式按钮点击处理
- 点击分组开关时，根据单选模式状态自动处理其他分组
- 开启单选模式时的初始化逻辑，确保只有一个分组处于启用状态

### 📝 文档更新
- 更新 README.md 中的分组控制节点说明
- 新增单选模式功能的使用说明和注意事项

---

## [1.0.0] - 2026-04-20

### ✨ 首次发布

#### 核心节点集
- **Josia文本编码（JosiaEncoder）**
  - 文生图 + 图生图一体化 CLIP/VAE 编码
  - 最多融合 5 张参考图
  - 支持图像参考模式和参考 Latent 模式
  - VAE 端口可选，未接入时自动降级为空 Latent

- **Josia图像缩放（JosiaImageScaling）**
  - 全能图像缩放裁切，支持 4 大比例 + 3 种自定义模式
  - 预设比例：1:1、2:3、3:2、3:4、4:3、16:9、9:16
  - 缩放模式：边长缩放、像素缩放、手动宽高
  - 锁定 2/4/8/16/32/64/128 倍数对齐
  - 5 种缩放算法（nearest、bilinear、area、bicubic、lanczos）

- **Josia图像对比（JosiaImageComparer）**
  - 双图实时对比预览
  - Slide 模式：鼠标滑动显示竖直分割线
  - Click 模式：按住显示 B 图，松开显示 A 图
  - 继承官方 PreviewImage、自动保存

- **Josia流量阀门（JosiaFlowValve）**
  - 5 路独立通道开关
  - 自由控制数据透传或截断
  - 全类型兼容、可视化开关状态

- **Josia随机种子（JosiaSeed）**
  - 专业级随机种子管理
  - 支持自动/递增/递减/固定模式
  - 前端快捷按钮：每次随机、新固定随机、使用上一次种子

- **Josia分组控制（JosiaGroupControllerM / JosiaGroupControllerS）**
  - 多组控制：自动扫描所有编组，一键全部跳过/启用
  - 单组控制：下拉选择编组，单个开关精准控制
  - 状态显示：绿色=已启用，红色=已跳过，橙色=部分跳过
  - 点击编组名称快速定位到该编组位置

- **Josia缓存清理（JosiaCacheCleanup）**
  - 轻量安全释放显存/内存/系统缓存
  - 不卸载模型，避免重新加载的等待
  - 支持 Windows 系统文件缓存清理
  - 任意数据透传，串联不中断工作流

### 🎨 设计特点
- **轻量不臃肿**：只保留真正高频刚需功能
- **新版高兼容**：专为最新 ComfyUI 开发
- **低占用流畅**：自动 GC、显存优化、前端轻量化
- **中文友好**：全中文界面、符号可视化、逻辑直白
- **稳定安全**：不删文件、不杀进程、不破坏工作流

### 🔧 技术特性
- 纯前端交互，不占算力
- 支持右键菜单操作
- 状态随工作流保存
- 自动识别系统，非 Windows 自动安全降级
- 实时日志输出，耗时统计

---

**图例**：
- ✨ 新增功能
- 🎨 界面优化
- 🔧 技术改进
- 🐛 Bug修复
- 📝 文档更新
- ⚠️ 重要变更
