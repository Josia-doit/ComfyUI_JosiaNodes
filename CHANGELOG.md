# Changelog

所有项目的重要变更都会记录在这个文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
