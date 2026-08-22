# 更新日志

## v2.5.0 (2026-08-22)

**离线数据查看**
- 新增「离线数据查看」窗口，可列出、导出并查看设备 SPIFFS 离线记录
- 主界面新增「离线数据」按钮，菜单栏「工具 → 离线数据查看」（快捷键 `Ctrl+D`）
- 支持 `export:list` 列出存储文件与 SPIFFS 占用、`export[:编号]` 按编号导出、`export:erase` 清除全部条目
- USB CDC 分块导出数据自动收集重组（`pack_type` 0x01首/0x00中/0x02末 流式传输）
- 记录以表格 + 曲线 + 统计信息展示，支持一键导出 CSV
- 曲线支持电压/电流/功率/温度/mAh/mWh 可选显示

## v2.4.0 (2026-08-21)

**数据包协议升级**
- 新增新版数据包解析：`0x55 0xAA` 双包头格式（含 `pack_type`/`pack_index`/`pack_length`，移除 `snid`）
- 上位机自动识别新旧协议：旧版单 `0xAA` 包头解析保持不变，新版 `0x55 0xAA` 自动切换
- 保留原有的 XOR 校验、数据有效性校验与功率修正逻辑

## v2.3.0 (2026-08-01)

**设备信息自动同步**
- 连接串口后自动发送 info 命令查询设备信息
- 在串口连接状态右侧实时显示 SN（序列号）、SW（软件版本）、HW（硬件版本）
- 根据 info 数据自动同步亮度滑块和采样率下拉框到设备当前值
- 点击「查询信息」按钮同样触发解析并更新界面控件
- 断开连接时自动隐藏设备信息区域

## v2.2.0 (2026-07-26)

**自动更新**
- 启动后自动检查 GitHub Releases 最新版本
- 更新弹窗 UI：模态框展示更新日志（Markdown 渲染）、下载进度条、实时速度、剩余时间
- 支持免安装版（zip）和单文件便携版（exe）一键下载、替换、重启
- 下载多源策略：ghproxy 镜像 → GitHub 直连，失败自动重试切换
- 适配系统代理（Clash 等），使用 Electron net 模块走 Chromium 代理
- 帮助菜单新增「检查更新」手动入口

## v2.1.0 (2026-07-25)

**驱动安装**
- 工具菜单新增「安装驱动」选项，内置 ESP32 USB JTAG 驱动
- 驱动窗口支持安装/卸载，通过 UAC 提权执行 pnputil
- 驱动文件位于 `drives/esp32-jtag-usb-drives/`，打包时自动解包

**子窗口完善**
- 曲线/固件/驱动三个子窗口采用独立图标
- 修复主窗口关闭时子窗口未同步关闭的问题
- 修复子窗口未适配亮色/暗色主题的问题

**文档**
- 新增用户使用说明书 `USER_MANUAL.md`（含界面截图与操作步骤）
- README 更新项目结构与使用说明

## v2.0.0 (2026-07-25)

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

## v1.2.1 (2026-07-09)

**构建优化**
- 构建目标改为绿色便携版：同时输出单文件 EXE (`portable`) + 免安装 zip (`dir`)
- 移除未使用依赖 (`all`、`chartjs-plugin-crosshair`)，优化产物体积
- 修复阈值输入框 CSS 特异性冲突导致无法手动输入的问题
- 应用图标更换为 `USB_Host.ico`

**修复**
- 修复「编译时间」显示为文件解压/打开时间而非真实构建时间的问题；改为打包时写入 `build-info.json`，运行时读取

## v1.2.0Beta (2026-07-08)

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

## v1.1.4Beta

- 初始固件烧录功能（WebSerial 方案，存在 Electron 兼容性问题）
