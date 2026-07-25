# ESP32C3-METER Host

基于 Electron 开发的 ESP32C3 USB 电表上位机软件，用于与 ESP32C3 设备通信并实时显示测量数据。

## 功能特性

- **串口通信**: 支持多种波特率，实时双向数据传输
- **实时曲线**: 电压、电流、功率、温度等多参数实时图表显示
- **数据导出**: 支持将数据保存为 CSV 格式，曲线保存为 PNG 图片
- **固件更新**: 内置 esptool-js 烧录引擎，支持固件烧录和 Flash 擦除
- **主题切换**: 支持亮色/暗色主题，可跟随系统设置
- **日志记录**: 串口日志和操作日志保存功能

## 支持的平台

- Windows 10/11

## 安装运行

### 环境要求

- Node.js 16+
- npm

### 安装步骤

```bash
# 克隆项目
git clone <repository-url>
cd ESP32C3_USB_METER_Host

# 安装依赖
npm install

# 运行程序
npm start
```

## 编译打包

### 构建命令

```bash
# 打包为 Windows 绿色便携版（同时输出单EXE + 免安装zip）
npm run build:win
```

### 构建产物

打包完成后，产物将生成在 `release/` 目录下：

| 产物 | 说明 |
|------|------|
| `ESP32C3-METER-vX.X.X-portable.exe` | 单文件便携版，无需安装，双击即用 |
| `ESP32C3-METER-vX.X.X-win-x64.zip` | 免安装绿色版，解压后运行 `ESP32C3-METER.exe` |
| `win-unpacked/` | 解压后的绿色版目录 |

### 构建配置说明

`package.json` 中 `build` 字段关键配置：

- **`win.target`**: `portable`（单EXE） + `dir`（绿色目录），构建后自动压缩为 zip
- **`compression: "maximum"`**: 最高压缩级别，减小产物体积
- **`asar: true`**: 应用代码打包为 asar 归档
- **`win.icon`**: 应用图标（`build/icon.png`，需 ≥256×256）

## 使用说明

### 串口连接

1. 选择对应的串口端口
2. 选择波特率（默认 921600）
3. 点击"打开串口"按钮

### 曲线采集

1. 连接串口后，点击"曲线界面"进入数据曲线窗口
2. 选择采样间隔，点击"开始采集"
3. 数据将实时显示在图表中

### 数据导出

- **保存曲线**: 菜单栏 → 文件 → 保存当前曲线为PNG
- **保存数据**: 菜单栏 → 文件 → 保存数据为CSV
- **导出日志**: 菜单栏 → 文件 → 导出操作日志

## 项目结构

```
ESP32C3_USB_METER_Host/
├── main.js                   # 主进程入口（串口通信 + 固件烧录 IPC）
├── preload.js                # 预加载脚本（IPC 桥接）
├── renderer.js               # 主窗口渲染进程
├── firmware-renderer.js      # 固件窗口渲染进程（IPC 方案）
├── firmware-flash.js         # 主进程烧录/擦除逻辑
├── serialport-transport.js   # serialport → esptool-js Transport 适配层
├── index.html                # 主窗口页面
├── curve.html                # 曲线窗口页面
├── firmware.html             # 固件更新窗口页面
├── styles.css                # 样式文件
├── package.json              # 项目配置
├── version-info.json         # 版本说明/更新日志
├── build/                    # 构建资源（图标等）
│   └── icon.png              # 应用图标（256×256）
└── patches/                  # npm 补丁
```

## 技术栈

- **框架**: Electron 28
- **图表库**: Chart.js 4 + chartjs-plugin-zoom
- **截图库**: html2canvas
- **串口通信**: serialport


## 版本信息

- 命名方式：`ESP32C3-METER-v版本-portable.exe`（单EXE）/ `ESP32C3-METER-v版本-win-x64.zip`（免安装包）

## 更新日志

### v2.0.0 (2026-07-25)

**数据结构同步**
- 下位机结构体更新：移除 `sw_version`/`hw_version`，新增 `temperature_cpu`，`time_ms` → `esp_time_us`（微秒），数据包 64→44 字节
- 上位机解析 `main.js` 同步适配：新增 `temperatureCpu` 解析，`temperature` → `temperatureAdc`

**曲线窗口增强**
- 新增 CPU 温度显示（HEX 原始数据面板）
- 存储深度改为内存预算模式：5~200 MB 可选，右侧动态显示预计录制时长
- 时长格式自适应：<1天显示"X小时X分钟"，≥1天显示"X天X小时"
- 修复 Chart.js Canvas 中文字体渲染（`Chart.defaults.font.family` 配置微软雅黑/苹方）
- Tooltip 标题添加"时间（s）"前缀

**工程优化**
- 版本号从 `package.json` 动态读取，无需同步修改 `main.js`
- 新增 `version-info.json` 可编辑版本说明文件，显示在"关于"对话框
- 新增项目 README 更新日志

### v1.2.1 (2026-07-09)

**构建优化**
- 构建目标改为绿色便携版：同时输出单文件 EXE (`portable`) + 免安装 zip (`dir`)
- 移除未使用依赖 (`all`、`chartjs-plugin-crosshair`)，优化产物体积
- 修复阈值输入框 CSS 特异性冲突导致无法手动输入的问题
- 应用图标更换为 `USB_Host.ico`

**修复**
- 修复「编译时间」显示为文件解压/打开时间而非真实构建时间的问题；改为打包时写入 `build-info.json`，运行时读取

### v1.2.0Beta (2026-07-08)

**修复**
- 修复主窗口连接芯片后日志显示 MAC 地址即白屏（`processTextData` 全局 `dataBuffer` 污染）
- 修复固件烧录窗口在 stub 上传阶段白屏卡死（**Electron 28 WebSerial C++ 级崩溃**）

**固件烧录**
- 烧录引擎从渲染进程 WebSerial 迁移至**主进程 serialport npm 包**
- 新增 `serialport-transport.js`：esptool-js 的 Node.js serialport 适配层（SLIP 编解码 / DTR-RTS / 缓冲读取）
- 新增 `firmware-flash.js`：主进程烧录/擦除逻辑，IPC 推送进度
- 固件窗口移除 WebSerial 授权流程，改为普通 COM 口下拉选择
- 烧录前自动释放主界面串口，避免 COM 口冲突
- 修复 SLIP 多包响应数据丢弃（芯片一次返回 8 个响应包时仅消费第 1 个）
- 修复 ESP32-C3 USB-JTAG-Serial 复位序列
- 终端输出缓冲机制，避免逐字符 DOM 更新风暴

**功能改进**
- 固件窗口默认三行分区（bootloader / partitions / firmware），预填正确地址
- 分区表标题旁增加 `?` 提示图标，显示常用分区地址映射
- 提示气泡适配亮色/暗色主题
- 移除按钮横向排列，事件委托统一处理

### v1.1.4Beta

- 初始固件烧录功能（WebSerial 方案，存在 Electron 兼容性问题）

## AI Coding 辅助说明

本项目在开发过程中使用了 AI Coding 辅助工具进行代码编写和调试。

## 许可证

ISC
