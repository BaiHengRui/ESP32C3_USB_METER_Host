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

### 环境要求

- electron-builder (开发依赖)

### 安装打包工具

```bash
npm install --save-dev electron-builder
```

### Windows 平台

```bash
# 打包为 Windows 可执行文件
npm run build:win
```

### macOS 平台

```bash
# 打包为 macOS 应用
npm run build:mac
```

### Linux 平台

```bash
# 打包为 Linux 应用
npm run build:linux
```

### 打包配置文件

在 `package.json` 中添加：

```json
{
  "scripts": {
    "build:win": "electron-builder --win",
    "build:mac": "electron-builder --mac",
    "build:linux": "electron-builder --linux"
  },
  "build": {
    "appId": "com.esp32c3.meter",
    "productName": "ESP32C3-METER",
    "win": {
      "target": "nsis"
    },
    "mac": {
      "target": "dmg"
    },
    "linux": {
      "target": "AppImage"
    }
  }
}
```

打包完成后，可执行文件将生成在 `dist` 目录下。

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
├── start.bat                 # Windows 启动脚本
└── package.json              # 项目配置
```

## 技术栈

- **框架**: Electron 28
- **图表库**: Chart.js 4 + chartjs-plugin-zoom
- **截图库**: html2canvas
- **串口通信**: serialport


## 版本信息

- 命名方式：项目名-v版本-系统-架构-类型.zip
- 当前版本: 1.2.1
- 编译时间: 打包时自动生成，记录真实构建时间

## 更新日志

### v1.2.1 (2026-07-09)

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
