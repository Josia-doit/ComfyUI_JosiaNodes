# Josia ComfyUI 自定义节点集
一套功能完整、轻量稳定、高度兼容最新版 ComfyUI 的实用节点集。专为解决老旧节点包兼容性差、体积臃肿、运行卡顿问题而设计，把高频刚需功能浓缩为一套轻量化扩展，让 ComfyUI 工作流更简洁、更顺畅。
<img width="1853" height="1174" alt="image" src="https://github.com/user-attachments/assets/61bd0a91-650c-49cc-92a4-d118405a723f" />

---

## 📂 完整文件结构
```
ComfyUI_JosiaNodes/
├── __init__.py                    # 节点总注册、统一导出、加载日志
├── node_properties.py             # 全节点常量、尺寸预设、描述文案
├── encoder.py                     # 文本 + 多图参考编码节点
├── image_scaling.py               # 多功能图像缩放裁切节点
├── image_comparer.py              # 双图对比预览节点
├── flow_valve.py                  # 5 通道流量阀门节点
├── group_controller.py            # 分组控制节点（多组 + 单组）
├── lora_stack.py                  # LoRA 堆叠节点（多组顺序应用）
├── seed.py                        # 随机种子管理节点
├── cache_cleanup.py               # 显存 / 内存 / 系统缓存清理节点
│
└── web/
    └── js/
        ├── encoder.js             # 文本编码节点默认尺寸配置
        ├── flow_valve.js          # 流量阀门前端美化
        ├── seed.js                # 随机种子前端按钮、快捷操作
        ├── image_comparer.js      # 图像对比滑动 / 按住对比交互
        ├── group_controller.js    # 分组控制前端 UI、开关、导航逻辑
        └── lora_stack.js          # LoRA 堆叠前端交互（滑块、开关、强度调节）
```

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

### 2. Josia图像缩放（JosiaImageScaling）
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

### 3. Josia图像对比（JosiaImageComparer）
- **分类**：Josia
- **核心功能**：双图实时对比预览，支持两种交互模式
- **输入**：image_a、image_b（均为可选）
- **模式**：
  - Slide 模式：鼠标滑动显示竖直分割线，左 A 右 B
  - Click 模式：按住显示 B 图，松开显示 A 图
- **特点**：继承官方 PreviewImage、自动保存、前端渲染流畅、支持拉大节点舒适对比
<img width="875" height="776" alt="image" src="https://github.com/user-attachments/assets/b751189a-acae-4643-97a1-9fba48375b22" />

---

### 4. Josia流量阀门（JosiaFlowValve）
- **分类**：Josia
- **核心功能**：5 路独立通道开关，自由控制数据透传或截断
- **输入**：通道1~5（任意类型，可选）
- **输出**：输出1~5（开 = 原数据透传，关 = None 截断）
- **特点**：全类型兼容、可视化开关状态、前端自动美化、容错性极强
<img width="503" height="505" alt="image" src="https://github.com/user-attachments/assets/aef75660-1f87-475a-9507-7be755620d3e" />

---

### 5. Josia随机种子（JosiaSeed）
- **分类**：Josia
- **核心功能**：专业级随机种子管理，支持自动/递增/递减/固定模式
- **种子规则**：
  - `-1`：每次运行自动随机新种子
  - `-2`：基于上一次种子自动 +1
  - `-3`：基于上一次种子自动 -1
  - 其他数值：固定种子，稳定复现结果
- **前端功能**：
  - 🎲 每次随机
  - 🎲 新固定随机
  - ♻️ 使用上一次种子（快捷按钮）
<img width="734" height="496" alt="image" src="https://github.com/user-attachments/assets/a81eaa52-b3f6-4344-830b-f59ec17d59d0" />

---

### 6. Josia分组控制（JosiaGroupControllerM / JosiaGroupControllerS）
- **分类**：Josia
- **多组控制（Josia多组控制）**：自动扫描所有编组，一键全部跳过/启用，点击组名快速定位，激活“单选模式”可启用互斥激活
- **单组控制（Josia单组控制）**：下拉选择编组，单个开关精准控制启用/跳过
- **状态显示**：
  - 绿色：已启用
  - 红色：已跳过
  - 橙色：部分跳过
- **特点**：纯前端交互、不占算力、支持右键菜单、状态随工作流保存
<img width="652" height="757" alt="image" src="https://github.com/user-attachments/assets/dcc74c21-55d5-4c2c-9adf-ef447583df19" />

---

### 7. Josia LoRA 堆叠（JosiaLoraStack）
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

### 8. Josia缓存清理（JosiaCacheCleanup）
- **分类**：Josia
- **核心功能**：轻量安全释放显存/内存/系统缓存，不卸载模型
- **输入**：任意类型数据（可选，透传用）
- **输出**：透传的输入数据（原样返回）
- **清理项**：
  - 显存缓存（全平台，保留模型不卸载）
  - Windows 系统文件缓存
  - Windows 非系统进程空闲内存
- **特点**：
  - 任意数据透传，串联不中断工作流
  - 自动识别系统，非 Windows 自动安全降级（仅清显存）
  - 实时日志输出，耗时统计
<img width="588" height="378" alt="image" src="https://github.com/user-attachments/assets/fee19c3a-ff28-4d69-852b-8ea974046ba5" />

---

### 9. Josia模型加载（JosiaCheckpointPlus）
- **分类**：Josia
- **核心功能**：高级智能一体化模型加载节点，100% 平替所有原生加载器
- **输入**：主模型、CLIP模型（可选）、CLIP类型、VAE模型（可选）、UNET保活开关
- **输出**：MODEL / CLIP / VAE
- **自动识别模式**：
  - **AIO Checkpoint**：模型内含 UNET+CLIP+VAE，自动复用内置组件，自动禁用外部 CLIP/VAE 选框
  - **独立 UNET**：仅含 UNET，可自由选配外部 CLIP 与 VAE
  - **GGUF UNET**：量化模型，可搭配任意格式 CLIP（GGUF 或非 GGUF 均可）
- **CLIP类型选择**：
  - 1:1 复刻原生 CLIPLoader 全部 24 种类型（sdxl / flux / sd3 / wan / LTXV 等）
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
  - 显示 CLIP / VAE 来源（内置 or 外部文件名）
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
6. 看到控制台输出 `[JosiaNodes] ✅ JosiaNodes 加载成功，注册节点数：9` 即成功

---

## 🎯 设计理念
- **轻量不臃肿**：拒绝冗余，只保留真正高频刚需功能
- **新版高兼容**：专为最新 ComfyUI 开发，不依赖老旧库
- **低占用流畅**：自动 GC、显存优化、前端轻量化
- **中文友好**：全中文界面、符号可视化、逻辑直白
- **稳定安全**：不删文件、不杀进程、不破坏工作流

---

## ⚠️ 重要说明
1. 随机种子节点「♻️ 使用上一次种子」功能目前失效，欢迎社区提交 PR 修复
2. 文本编码节点的 VAE 端口为可选输入，未接入时图生图模式自动降级为空 Latent
3. 图像缩放节点内置分辨率上限保护（400万像素），避免显存溢出
4. 缓存清理节点在 Windows 上优化更明显，其他系统仅清理显存
5. 分组控制、图像对比、流量阀门、种子节点、模型加载节点均依赖前端 JS 文件，不可删除
6. 所有节点均已配置 `DESCRIPTION` 属性，在搜索节点界面和鼠标悬浮时可查看功能简介
7. **模型加载节点 GGUF 依赖**：加载 GGUF 格式模型需安装 ComfyUI-GGUF 插件；ckpt/safetensors/bin 格式完全独立运行

---

## 💡 致谢
感谢 ComfyUI 官方提供强大的扩展能力，感谢所有测试与反馈的朋友。
本项目持续维护，欢迎提交 Issue 与建议。
