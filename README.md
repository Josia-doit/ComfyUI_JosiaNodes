# Josia ComfyUI 自定义节点集
一套功能完整、轻量稳定、高度兼容最新版 ComfyUI 的实用节点集。专为解决老旧节点包兼容性差、体积臃肿、运行卡顿问题而设计，把高频刚需功能浓缩为一套轻量化扩展，让 ComfyUI 工作流更简洁、更顺畅。

> 📺 **我的 B 站主页（教程 / 演示 / 更新动态）**：[Josia 的 B 站空间](https://space.bilibili.com/3706973113551694) — 节点使用讲解、效果演示视频持续更新，欢迎关注支持！

<img width="2228" height="1158" alt="image" src="https://github.com/user-attachments/assets/2e9e0946-c160-4edb-9c58-df5461456473" />

---

## 📂 完整文件结构
```
ComfyUI_JosiaNodes/
├── __init__.py                    # 节点总注册、统一导出、加载日志
├── node_properties.py             # 全节点常量、尺寸预设、描述文案
├── encoder.py                     # 文本 + 多图参考编码节点
├── multi_image_loader.py          # 多图批量加载节点（缩放/上传/拖拽/粘贴）
├── text_list.py                   # 文本列表节点（多行按行分割为列表）
├── text_save.py                   # 文本保存节点（保存文本到文件）
├── image_scaling.py               # 多功能图像缩放裁切节点
├── image_comparer.py              # 双图对比预览节点
├── flow_valve.py                  # 5 通道流量阀门节点
├── group_controller.py            # 分组控制节点（多组 + 单组）
├── lora_stack.py                  # LoRA 堆叠节点（多组顺序应用）
├── seed.py                        # 随机种子管理节点
├── cache_cleanup.py               # 无用显存 / 内存清理节点（保持模型常驻，不卸载）
├── checkpoint_plus.py             # 高级智能一体化模型加载节点
│
└── web/
    └── js/
        ├── encoder.js             # 文本编码节点默认尺寸配置
        ├── multi_image_loader.js  # 多图加载前端（图库/拖拽/缩略图/自适应布局）
        ├── text_list.js           # 文本列表前端
        ├── text_save.js           # 文本保存前端（文件夹选择器）
        ├── flow_valve.js          # 流量阀门前端美化
        ├── seed.js                # 随机种子前端按钮、快捷操作
        ├── image_comparer.js      # 图像对比滑动 / 按住对比交互
        ├── group_controller.js    # 分组控制前端 UI、开关、导航逻辑
        ├── lora_stack.js          # LoRA 堆叠前端交互（滑块、开关、强度调节）
        └── checkpoint_plus.js     # 模型加载节点类型识别与状态栏
```

---

## 📑 节点目录

1. [Josia文本编码（JosiaEncoder）](#1-josia文本编码josiaencoder)
2. [Josia文本列表（JosiaTextList）](#2-josia文本列表josiatextlist)
3. [Josia文本保存（JosiaTextSave）](#3-josia文本保存josiatextsave)
4. [Josia多图加载（JosiaMultiImageLoader）](#4-josia多图加载josiamultiimageloader)
5. [Josia图像缩放（JosiaImageScaling）](#5-josia图像缩放josiaimagescaling)
6. [Josia图像对比（JosiaImageComparer）](#6-josia图像对比josiaimagecomparer)
7. [Josia流量阀门（JosiaFlowValve）](#7-josia流量阀门josiaflowvalve)
8. [Josia随机种子（JosiaSeed）](#8-josia随机种子josiaseed)
9. [Josia分组控制（JosiaGroupControllerM / JosiaGroupControllerS）](#9-josia分组控制josiagroupcontrollerm--josiagroupcontrollers)
10. [JosiaLoRA堆叠（JosiaLoraStack）](#10-josialora堆叠josialorastack)
11. [Josia缓存清理（JosiaCacheCleanup）](#11-josia缓存清理josiacachecleanup)
12. [Josia模型加载（JosiaCheckpointPlus）](#12-josia模型加载josiacheckpointplus)

---

## 📋 节点列表与功能说明

### 1. Josia文本编码（JosiaEncoder）
- **分类**：Josia
- **核心功能**：文生图 + 图生图一体化 CLIP/VAE 编码，最多融合 5 张参考图
- **输入**：
  - CLIP、VAE（可选）
  - 图像1~5（可选，最多 5 张参考图）
  - 正向提示词、负向提示词
- **输出**：正向条件 / 负向条件 / Latent
- **核心开关**：
  - **图像参考模式**：开启 = 图生图模式（图像经 VAE 编码为 Latent），关闭 = 文生图模式（输出空 Latent）
  - **参考 Latent 模式**：开启 = 注入参考 Latent 条件（模型参考原图特征），关闭 = 标准 VAE 编码（纯文本条件驱动图生图）
  - **负向提示词生效**：开启 = 负向提示词正常编码，关闭 = 负向条件自动归零
- **四种工作模式**：

  | 状态 | 图像参考模式 | 参考 Latent 模式 | Latent 输出 | 条件输出 |
  |------|:---:|:---:|---|---|
  | 文生图 | 关 | — | 1024×1024 空画布 | 纯文本条件 |
  | 文生图（带图尺寸） | 关 | — | 原图尺寸空画布 | 纯文本条件 |
  | 标准图生图 | 开 | 关 | VAE 编码 Latent | 纯文本条件 |
  | 参考图生图 | 开 | 开 | VAE 编码 Latent | 参考 Latent 条件 |

- **特点**：VAE 端口可选（未接入时自动降级为空 Latent）、原生逻辑兼容 Flux / 千问等模型
<img width="708" height="980" alt="image" src="https://github.com/user-attachments/assets/486e8d56-1a87-4e0b-a8de-7d708009cc01" />

---

### 2. Josia文本列表（JosiaTextList）

- **分类**：Josia
- **核心功能**：将多行字符串按分隔符分割为字符串列表，支持多种过滤和显示模式
- **输入**：文本（多行字符串，支持上游文本节点连接）
- **输出**：prompt_list（字符串列表）
- **可选设置**：
  - 过滤空行（默认开启）：自动去除分割后的空行
  - 修剪空白（默认开启）：去除每行首尾空格、制表符等空白字符
  - 分隔符（默认 `\n`）：支持 `\n`（换行）、`\t`（制表）、逗号、分号等自定义分隔符；**留空则不分割**，整段文本作为单条输出（适合把本节点当纯文本框显示任意内容，无需塞无意义分隔符）
  - 去重过滤（默认关闭）：自动去除重复行，保持原始顺序
  - 正则过滤：支持正则表达式筛选匹配的行，内置 11 种自定义快捷规则：
    - `/汉字/` 匹配中文 | `/汉字开头/` 匹配以汉字开头 | `/纯汉字/` 纯中文行
    - `/英文/` 匹配英文 | `/数字/` 匹配数字 | `/空行/` 匹配空行 | `/空格/` 匹配空格
    - `/序号行/` 匹配带序号行 | `/标签行/` 匹配标签行
    - `/?文本/` 万能匹配（如 `/天空/` 匹配含"天空"的行）
    - `/?文本开头/` 万能开头匹配（如 `/天空开头/` 匹配以"天空"开头的行）
  - 显示模式：列表模式（每段文本一个显示框）/ 完整文本（合并为一段显示）
- **适用场景**：
  - 提示词批量处理：将多行提示词逐行拆分为独立条目
  - 提示词筛选：过滤 LLM 输出的序号行（如 `[prompt 1]`），只保留有效提示词
  - 路径列表拆分：将多行路径字符串拆分为路径列表
  - 配置项拆分：将多行配置文本按自定义分隔符拆分
- **特点**：纯 Python 标准库实现，零依赖；节点下方自动扩展预览窗口，直观显示分割结果
<img width="1362" height="607" alt="image" src="https://github.com/user-attachments/assets/0f5b5889-639a-46fc-8687-136fe2673e42" />

---

### 3. Josia文本保存（JosiaTextSave）

- **分类**：Josia
- **核心功能**：将文本内容保存到文件，支持通配符解析、文件夹选择、图像文件名复用
- **输入**：
  - 文本（多行字符串，支持上游节点连接）
  - 图像（可选，接入时自动复用原图文件名）
- **输出**：输出文本（透传输入文本，方便串联）
- **参数**：
  - 选择输出目录：点击按钮打开系统文件夹选择器（置于文本输入框之后，符合「先选目录」的使用惯性）
  - 保存路径：手动输入或自动填充的目录路径
  - 文件名：支持通配符（%date%/%time%/序号等）
  - 保存格式：txt / csv
- **稳定性**：重启 ComfyUI 后各参数正确保存，不再因前端按钮序列化导致字段错位（路径串入文本 / 通配符乱跳）
- **通配符规则**（成对 %xxx% 解析）：
  - `%date%` → 2026-06-30
  - `%time%` → 07:38:41
  - `%date:yyMMdd%` → 260630
  - `%003%` → 3位序号从003开始
- **文件名冲突处理**：同名文件自动追加 _001、_002 等编号
- **特点**：支持 CSV 格式（自动添加 UTF-8 BOM，Excel 友好）；纯 Python 标准库实现，零依赖
<img width="2013" height="389" alt="image" src="https://github.com/user-attachments/assets/42cd1ea4-1fb8-4afa-9de1-4590b486881c" />

---

### 4. Josia多图加载（JosiaMultiImageLoader）
- **分类**：Josia
- **核心功能**：批量加载多张图片，支持选择文件 / 拖拽 / 粘贴，每张图独立等比缩放
- **输入**：
  - 图片路径（前端图库区自动管理，无需手动输入）
  - 上游图像（可选，串联模式：上游图像插入本节点图像之前合并输出）
  - 缩放模式 / 百万像素 / 缩放步数 / 边长方向 / 边长值 / 缩放算法 / 对齐倍数
- **输出**：
  - `images_out`：汇总输出。
    - **列表模式**：返回全部 N 张图的 list，配合 ComfyUI 原生 list 展开（`OUTPUT_IS_LIST`），下游（如 llama.cpp 反推）**自动逐张执行 N 次**——一次排队 = 全部图像打完标，无需手动批次按钮、无需序号递增。混合比例时自动 letterbox。
    - **批次模式**：返回合并 batch（所有图像拼为一个 batch，混合比例时自动 letterbox）。
  - `image_1` ~ `image_N`：每张图独立输出（各自正确的等比缩放尺寸，无黑边无拉伸）
- **按图片数量自动跑 N 次**：列表模式下 `images_out` 以 list 形式输出，ComfyUI 自动把下游节点展开为「每张图一次」，特别适合「多图加载 → 反推打标 → 文本保存」的批量字幕工作流（输出与图像同名，txt 边跑边写）
- **缩放模式**（原生 BOOLEAN 开关，全中文参数名）：
  - 🖼️ **按像素缩放**：按总像素目标等比缩放（参考原生 ImageScaleToTotalPixels），每张图独立计算
  - 📐 **按边长缩放**：按长边或短边等比缩放，另一方向自动适配
    - ➡️ 按长边缩放 / ⬇️ 按短边缩放
- **缩放步数**（N 步渐进缩放）：
  - 默认 1 = 一步到位（最快）
  - 2~16 = 分步渐进缩放，大比例缩小时减少锯齿和伪影，质量更好
- **高级特性**：
  - 6 种缩放算法（lanczos / nearest / bilinear / bicubic / area / nearest-exact）
  - 尺寸对齐倍数（0 / 8 / 16 / 32），适配 VAE 编解码
  - 绝对路径去重，防止同名不同目录的图片重复载入
  - 缩放值=0 表示不缩放，原图直出
- **前端图库**：
  - 自适应缩略图网格（参考对标节点 optimizeGrid 算法，无限缩放）
  - 节点尺寸随图库区域自动变化（wasFresh 检测 + force-shrink 机制）
  - 支持文件选择 / 拖拽 / 粘贴三种来源
  - 滚轮缩放、分辨率标签显示、一键排序 / 清空 / 重置参数
- **特点**：使用 ComfyUI 标准 `/upload/image` API，原生 BOOLEAN 开关（不破坏 ComfyUI 布局），全中文参数名
<img width="2133" height="861" alt="image" src="https://github.com/user-attachments/assets/aab8996e-f909-450d-aeb3-542f8bee0d62" />


---

### 3. Josia图像缩放（JosiaImageScaling）
- **分类**：Josia
- **核心功能**：全能图像缩放裁切，支持 4 大比例 + 3 种自定义模式
- **输入**：图像（可选）、遮罩（可选）
- **输出**：图像 / 遮罩 / 宽度 / 高度
- **预设比例**：
  - 1:1 正方形
  - 2:3 / 3:2 摄影比例
  - 3:4 / 4:3 短视频比例
  - 16:9 / 9:16 全平台视频
- **缩放模式**：
  - 📏 边长缩放（按最长/最短边）
  - 🖼️ 像素缩放（按百万像素自动算尺寸，最高优先级）
  - ✏️ 手动宽高（支持一键切换宽高）
- **高级特性**：
  - 锁定 2/4/8/16/32/64/128 倍数对齐
  - 中心/上下左右裁剪 + 拉伸缩放
  - 5 种缩放算法（nearest / bilinear / area / bicubic / lanczos）
  - 渐进式多步缩放，低像素更清晰
  - 自动分辨率保护，上限 400 万像素
- **特点**：不设置任何尺寸时图像原封不动透传；无图像输入时可提供宽高数值用于文生图
<img width="526" height="932" alt="image" src="https://github.com/user-attachments/assets/9712297a-0ceb-4928-86b8-c53da88fcda6" />

---

### 4. Josia图像对比（JosiaImageComparer）
- **分类**：Josia
- **核心功能**：双图实时对比预览，支持两种交互模式；并输出 A/B 左右无缝拼接图
- **输入**：image_a、image_b（均为可选）
- **输出**：拼接图像（IMAGE）——把图像A与图像B沿宽度方向左右无缝拼接成一张图
  - 两图高度不一致时，自动把 B 等比缩放（lanczos）到与 A 同高再拼接，避免错位 / 黑边
  - 只接一张图则原样输出；都不接输出空
- **模式**：
  - Slide 模式：鼠标滑动显示竖直分割线，左 A 右 B
  - Click 模式：按住显示 B 图，松开显示 A 图
- **特点**：继承官方 PreviewImage、自动保存、前端渲染流畅、支持拉大节点舒适对比；画布对比层与拼接输出口互不干扰
<img width="875" height="776" alt="image" src="https://github.com/user-attachments/assets/b751189a-acae-4643-97a1-9fba48375b22" />

---

### 7. Josia流量阀门（JosiaFlowValve）
- **分类**：Josia
- **核心功能**：5 路独立通道开关，自由控制数据透传或截断
- **输入**：通道1~5（任意类型，可选）
- **输出**：输出1~5（开 = 原数据透传，关 = None 截断）
- **特点**：全类型兼容、可视化开关状态、前端自动美化、容错性极强
<img width="503" height="505" alt="image" src="https://github.com/user-attachments/assets/aef75660-1f87-475a-9507-7be755620d3e" />

---

### 6. Josia随机种子（JosiaSeed）
- **分类**：Josia
- **核心功能**：专业级随机种子管理，支持自动/递增/递减/固定模式
- **种子规则**：
  - `-1`：每次运行自动随机新种子
  - `-2`：基于上一次种子自动 +1（需先有历史种子，否则返回 0）
  - `-3`：基于上一次种子自动 -1（需先有历史种子，否则返回 0）
  - 其他数值：固定种子，稳定复现结果
- **前端功能**（5 个按钮，全部原生样式）：
  - 🎲 每次随机（设置 seed=-1）
  - ⬆️ 递增（设置 seed=-2，无种子时灰化禁用）
  - ⬇️ 递减（设置 seed=-3，无种子时灰化禁用）
  - 🎲 固定随机（生成一个新固定种子，同时激活 ⬆️⬇️ 按钮）
  - ♻️ 使用上一次种子（快捷回填，运行后自动激活）
- **递增/递减说明**：
  - 按钮初始为灰色不可用状态
  - 先运行一次（或点 🎲 固定随机）生成种子后，⬆️⬇️ 按钮自动亮起
  - 后端不再随机初始化基数，无历史种子时返回 0 并提示
- **特点**：前端按钮全部使用 ComfyUI 原生控件，稳定无渲染 bug
<img width="1263" height="568" alt="image" src="https://github.com/user-attachments/assets/0fe30dd3-5253-4035-bcf8-eb9b72f11a6b" />


---

### 9. Josia分组控制（JosiaGroupControllerM / JosiaGroupControllerS）
- **分类**：Josia
- **多组控制（Josia多组控制）**：自动扫描所有编组，一键全部跳过/启用，点击组名快速定位，激活"单选模式"可启用互斥激活
- **单组控制（Josia单组控制）**：下拉选择编组，单个开关精准控制启用/跳过
- **状态显示**：
  - 绿色：已启用
  - 红色：已跳过
  - 橙色：部分跳过
- **特点**：纯前端交互、不占算力、支持右键菜单、状态随工作流保存
<img width="652" height="757" alt="image" src="https://github.com/user-attachments/assets/dcc74c21-55d5-4c2c-9adf-ef447583df19" />

---

### 10. Josia LoRA 堆叠（JosiaLoraStack）
- **分类**：Josia
- **核心功能**：多组 LoRA 顺序堆叠，支持 1-10 组独立控制
- **输入**：模型、CLIP（可选）
- **输出**：模型、CLIP
- **总控功能**：
  - 总控开关：关闭时 model/CLIP 原样透传，开启时按顺序应用启用的 LoRA 组
  - 内存/显存加载模式切换：显存加载（默认）、内存加载（节省显存）
- **LoRA 数量控制**：
  - 点击 ◀ ▶ 箭头或下拉框选择激活组数（1-10 组）
  - 减少数量时隐藏的组保留所有设置，恢复时原样显示
- **每组独立控制**：
  - LoRA 选择：从可用 LoRA 列表中选择（支持搜索过滤）
  - 开关按钮：控制该组 LoRA 是否生效
  - 模型强度：LoRA 对模型的影响强度（-3.00 ~ 3.00，步进 0.05）
  - CLIP 强度：LoRA 对 CLIP 的影响强度（-3.00 ~ 3.00，步进 0.05）
  - 同步开关：开启后模型/CLIP 强度保持一致
- **前端交互**：
  - 滑块支持单击定位 + 拖拽跟随（v8 修复）
  - 箭头步进调节（±0.05）
  - 支持键盘输入精确值（-10.00 ~ 10.00）
- **特点**：纯前端交互、不占算力、状态随工作流保存
<img width="1169" height="705" alt="image" src="https://github.com/user-attachments/assets/c710b123-aa4e-44c3-ad91-c98edcf540b0" />

---

### 9. Josia缓存清理（JosiaCacheCleanup）
- **分类**：Josia
- **核心功能**：在保持模型缓存状态下，轻量清理无用的显存 / 内存，不卸载模型
- **输入**：任意类型数据（可选，透传用）
- **输出**：透传的输入数据（原样返回）
- **清理项**：
  - **清理无用缓存**（默认开）：`gc.collect()` + `comfy.model_management.soft_empty_cache()`（等价于 `torch.cuda.empty_cache()`），只释放空闲显存、不卸载被引用的模型
  - **深度回收**（默认关）：额外二次 `empty_cache` + gc，用于内存碎片化严重时进一步回收
- **设计初衷**：节省显存让重复运行更快，同时保持模型常驻、避免重新加载
- **特点**：
  - 任意数据透传，串联不中断工作流
  - 不卸载模型、不清理系统文件缓存 / 进程工作集，安全无副作用
  - 实时日志输出，耗时统计
<img width="588" height="378" alt="image" src="https://github.com/user-attachments/assets/fee19c3a-ff28-4d69-852b-8ea974046ba5" />

---

### 12. Josia模型加载（JosiaCheckpointPlus）
- **分类**：Josia
- **核心功能**：高级智能一体化模型加载节点，100% 平替所有原生加载器
- **输入**：主模型、CLIP模型（可选）、CLIP类型、VAE模型（可选）、UNET保活开关
- **输出**：MODEL / CLIP / VAE
- **自动识别模式**：
  - **AIO Checkpoint**：模型内含 UNET+CLIP+VAE，自动复用内置组件，自动禁用外部 CLIP/VAE 选框
  - **独立 UNET**：仅含 UNET，可自由选配外部 CLIP 与 VAE
  - **GGUF UNET**：量化模型，可搭配任意格式 CLIP（GGUF 或非 GGUF 均可）
- **CLIP类型选择**：
  - 1:1 复刻原生 CLIPLoader 全部 24 种类型（sdxl / flux / flux2 / sd3 / lumina2 / wan / LTXV 等），全部可正常启用（已修复 flux2 / lumina2 等类型报错问题）
  - AIO 模式自动适配 CLIP 类型，独立 UNET/GGUF 模式需手动选择
- **UNET保活**（默认开启）：
  - 防止 ComfyUI 意外卸载 UNET 模型，复用工作流时跳过重新加载
  - 不强制占用物理显存，允许 ComfyUI 智能调度
- **支持格式**：ckpt / safetensors / bin / gguf 全格式
- **GGUF 依赖说明** ⚠️：
  - 加载 **GGUF 格式模型**需要安装 [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) 插件
  - 本节点负责智能调度（自动识别类型、控件联动、状态栏显示），GGUF 文件的实际解码由 ComfyUI-GGUF 插件完成
  - 未安装时，GGUF 模型加载会报错并提示安装
  - 非 GGUF 模型（ckpt / safetensors / bin）**完全独立运行**，无需任何额外插件
- **状态栏信息**：
  - 实时显示模型类型标签（AIO / UNET / GGUF 量化等级）
  - 显示模型文件名、UNET / CLIP / VAE 尺寸
  - 显示 UNET保活开关状态
- **特点**：100% 平替原生 CheckpointLoader / UNETLoader / CLIPLoader / VAELoader，一个节点搞定全部加载需求
<img width="1270" height="802" alt="image" src="https://github.com/user-attachments/assets/795bd2db-6a17-44a6-9228-fbb8306c765c" />

---

## 🛠️ 安装方法
1. 下载整个 `ComfyUI_JosiaNodes` 文件夹
2. 放入 `ComfyUI/custom_nodes/` 目录下
3. **（如使用 GGUF 模型）** 安装 [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) 插件到 `ComfyUI/custom_nodes/`
4. 确保 `web/js` 文件夹完整，不要移动或删除文件
5. 重启 ComfyUI
6. 看到控制台输出 `[JosiaNodes] ✅ JosiaNodes 加载成功，注册节点数：12` 即成功

---

## 🎯 设计理念
- **轻量不臃肿**：拒绝冗余，只保留真正高频刚需功能
- **新版高兼容**：专为最新 ComfyUI 开发，不依赖老旧库
- **低占用流畅**：自动 GC、显存优化、前端轻量化
- **中文友好**：全中文界面、符号可视化、逻辑直白
- **稳定安全**：不删文件、不杀进程、不破坏工作流

---

## ⚠️ 重要说明
1. 文本编码节点的 VAE 端口为可选输入，未接入时图生图模式自动降级为空 Latent
3. 图像缩放节点内置分辨率上限保护（400万像素），避免显存溢出
4. 缓存清理节点只清理无用显存/内存（不卸载模型、不清理系统文件缓存），全平台行为一致，安全无副作用
5. 分组控制、图像对比、流量阀门、种子节点、模型加载节点、多图加载节点均依赖前端 JS 文件，不可删除
6. 所有节点均已配置 `DESCRIPTION` 属性，在搜索节点界面和鼠标悬浮时可查看功能简介
7. **模型加载节点 GGUF 依赖**：加载 GGUF 格式模型需安装 ComfyUI-GGUF 插件；ckpt/safetensors/bin 格式完全独立运行
8. **多图加载节点**：`images_out` 批次输出在混合不同比例图片时会自动 letterbox（黑边居中），这是 PyTorch tensor batch 的数学限制；如需每张图独立的正确尺寸，请使用 `image_1` ~ `image_N` 单独输出端口
9. 文本列表和文本保存节点为纯 Python 标准库实现，不依赖前端 JS 文件，即使前端 JS 丢失也可正常工作（仅文件夹选择功能需 JS 支持）

---

## 💡 致谢
感谢 ComfyUI 官方提供强大的扩展能力，感谢所有测试与反馈的朋友。
本项目持续维护，欢迎提交 Issue 与建议。
