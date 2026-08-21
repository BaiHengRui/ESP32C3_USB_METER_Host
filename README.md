# ESP32-USB-METER Host

基于 Electron 开发的 ESP32C3 USB 电表上位机软件，用于与 ESP32C3 设备通信并实时显示测量数据。

> 📖 **详细使用说明请参阅：[USER_MANUAL.md](./USER_MANUAL.md)**（含界面截图与操作步骤）

## 功能特性

- **串口通信**: 支持多种波特率，实时双向数据传输
- **实时曲线**: 电压、电流、功率、温度等多参数实时图表显示
- **数据导出**: 支持将数据保存为 CSV 格式，曲线保存为 PNG 图片
- **固件更新**: 内置 esptool-js 烧录引擎，支持固件烧录和 Flash 擦除
- **OTA 更新**: 启动自动检查 GitHub Releases，支持一键下载更新替换重启
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

请参阅 **[📖 完整使用说明书 (USER_MANUAL.md)](./USER_MANUAL.md)**，包含：

- 界面截图与区域说明
- 串口连接与设备控制步骤
- 曲线采集与数据导出操作
- 固件更新（烧录/擦除）完整流程
- 主题切换与常见问题解答

## 项目结构

```
ESP32C3_USB_METER_Host/
├── main.js                   # 主进程入口（串口通信 + 固件烧录 + 驱动安装 IPC）
├── preload.js                # 预加载脚本（IPC 桥接）
├── renderer.js               # 主窗口渲染进程
├── firmware-renderer.js      # 固件窗口渲染进程
├── firmware-flash.js         # 主进程烧录/擦除逻辑
├── serialport-transport.js   # serialport → esptool-js Transport 适配层
├── index.html                # 主窗口页面
├── curve.html                # 曲线窗口页面
├── firmware.html             # 固件更新窗口页面
├── driver.html               # 驱动安装窗口页面
├── styles.css                # 样式文件
├── start.bat                 # 开发启动脚本
├── package.json              # 项目配置
├── USER_MANUAL.md            # 用户使用说明书
├── version-info.json         # 版本说明/更新日志
├── CHANGELOG.md              # 更新日志（版本变更记录）
├── build/                    # 构建资源（图标等）
│   ├── icon.png              # 主窗口图标
│   ├── curve.png             # 曲线窗口图标
│   ├── update.png            # 固件更新窗口图标
│   └── drive.png             # 驱动安装窗口图标
├── drives/                   # ESP32-C3 USB JTAG 驱动文件
│   └── esp32-jtag-usb-drives/
├── imgs/                     # 说明书截图资源
├── patches/                  # npm 补丁
└── release/                  # 构建产物（单EXE + 免安装zip）
```

## 技术栈

- **框架**: Electron 28
- **图表库**: Chart.js 4 + chartjs-plugin-zoom
- **截图库**: html2canvas
- **串口通信**: serialport


## 版本信息

- 命名方式：`ESP32C3-METER-v版本-portable.exe`（单EXE）/ `ESP32C3-METER-v版本-win-x64.zip`（免安装包）

## 更新日志

完整的版本更新日志请参阅 **[CHANGELOG.md](./CHANGELOG.md)**。

## AI Coding 辅助说明

本项目在开发过程中使用了 AI Coding 辅助工具进行代码编写和调试。

## 许可证

ISC
