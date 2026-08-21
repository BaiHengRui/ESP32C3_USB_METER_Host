const { app, BrowserWindow, ipcMain, dialog, screen, Menu, nativeTheme } = require('electron')
const path = require('path')
const fs = require('fs')
const { SerialPort } = require('serialport')
const { scheduleStartupCheck, checkForUpdatesManually, registerUpdateIPC } = require('./update')

// 设置应用名称（影响任务管理器中主进程和子进程的显示名称）
app.setName('meter host')

// 设置 Windows AppUserModelId，使所有窗口在任务管理器中归组到同一应用
if (process.platform === 'win32') {
  app.setAppUserModelId('com.esp32usb.meter')
}

// 应用信息
const APP_NAME = 'ESP32-USB-METER 上位机'
const APP_VERSION = require('./package.json').version

// 获取编译时间
function getBuildTime() {
  try {
    // 优先读取打包时写入的 build-info.json
    const buildInfoPath = path.join(__dirname, 'build-info.json')
    if (fs.existsSync(buildInfoPath)) {
      const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'))
      const buildDate = new Date(buildInfo.buildTime)
      // 转换为GMT+8
      const gmt8Time = new Date(buildDate.getTime() + 8 * 60 * 60 * 1000)
      const year = gmt8Time.getUTCFullYear()
      const month = String(gmt8Time.getUTCMonth() + 1).padStart(2, '0')
      const day = String(gmt8Time.getUTCDate()).padStart(2, '0')
      const hours = String(gmt8Time.getUTCHours()).padStart(2, '0')
      const minutes = String(gmt8Time.getUTCMinutes()).padStart(2, '0')
      const seconds = String(gmt8Time.getUTCSeconds()).padStart(2, '0')
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} (GMT+8)`
    }
    // 降级：开发模式下用文件修改时间
    const stats = fs.statSync(__filename)
    const buildDate = new Date(stats.mtime)
    const gmt8Time = new Date(buildDate.getTime() + 8 * 60 * 60 * 1000)
    const year = gmt8Time.getUTCFullYear()
    const month = String(gmt8Time.getUTCMonth() + 1).padStart(2, '0')
    const day = String(gmt8Time.getUTCDate()).padStart(2, '0')
    const hours = String(gmt8Time.getUTCHours()).padStart(2, '0')
    const minutes = String(gmt8Time.getUTCMinutes()).padStart(2, '0')
    const seconds = String(gmt8Time.getUTCSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} (GMT+8) (DEV)`
  } catch (e) {
    return '未知'
  }
}
const BUILD_TIME = getBuildTime()

// 旧版 USB_CDC_Data 结构体大小（单 0xAA 包头）
const USB_CDC_DATA_SIZE = 44
// 新版 USB_CDC_Data 结构体大小（0x55 0xAA 双包头）
const USB_CDC_NEW_DATA_SIZE = 44

// 读取版本信息文件
function getVersionInfo() {
  try {
    const infoPath = path.join(__dirname, 'version-info.json')
    if (fs.existsSync(infoPath)) {
      return JSON.parse(fs.readFileSync(infoPath, 'utf8'))
    }
  } catch (e) { /* 忽略 */ }
  return { releaseNotes: '', changelog: '' }
}

// 配置文件路径
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json')

// 操作日志数组
const operationLogs = []

// 日志添加函数
function addOperationLog(type, action, detail) {
  const timestamp = new Date().toISOString()
  const logEntry = {
    timestamp,
    type,
    action,
    detail
  }
  operationLogs.push(logEntry)
  console.log(`[${timestamp}] [${type}] ${action}: ${detail}`)
}

// 当前主题设置
let currentTheme = 'system' // 'light', 'dark', 'system'

// 全局变量
let mainWindow = null
let curveWindow = null
let firmwareWindow = null
let driverWindow = null
let serialPort = null
let isReading = false
let dataBuffer = Buffer.alloc(0)
let lastPort = ''
let lastBaudRate = 921600

// 固件更新相关

// 数据解析函数
function parseUSBCDCData(data) {
  try {
    if (data.length !== USB_CDC_DATA_SIZE) {
      return null
    }

    // 校验和验证（XOR 所有字节，不含 checksum 自身）
    let checksum = 0
    for (let i = 0; i < USB_CDC_DATA_SIZE - 1; i++) {
      checksum ^= data[i]
    }
    if (checksum !== data[USB_CDC_DATA_SIZE - 1]) {
      console.log('校验和错误')
      return null
    }

    // Header 验证
    const header = data[0]
    if (header !== 0xAA) {
      console.log('Header错误')
      return null
    }

    let offset = 0

    // header (1 byte)
    offset += 1

    // pack_length (1 byte)
    const packLength = data[offset]
    offset += 1

    // snid (4 bytes, uint32_t little-endian)
    const snid = data.readUInt32LE(offset)
    offset += 4

    // temperature_cpu (4 bytes, float little-endian) — ESP32 芯片温度
    const temperatureCpu = data.readFloatLE(offset)
    offset += 4

    // temperature_adc (4 bytes, float little-endian) — INA228 温度传感器
    const temperatureAdc = data.readFloatLE(offset)
    offset += 4

    // voltage (4 bytes, float little-endian)
    const voltage = data.readFloatLE(offset)
    offset += 4

    // current (4 bytes, float little-endian)
    const current = data.readFloatLE(offset)
    offset += 4

    // power (4 bytes, float little-endian) — 固件发送的原始功率值，仅供参考
    const rawPower = data.readFloatLE(offset)
    offset += 4

    // energy_mWh (4 bytes, float little-endian)
    const energyMWh = data.readFloatLE(offset)
    offset += 4

    // charge_mAh (4 bytes, float little-endian)
    const chargeMAh = data.readFloatLE(offset)
    offset += 4

    // esp_time_us (8 bytes, uint64_t little-endian) — esp_timer_get_time() 微秒
    const espTimeUs = Number(data.readBigUInt64LE(offset))
    offset += 8

    // current_direction (1 byte, bool)
    const currentDirection = data[offset] !== 0

    // === 宽松的数据有效性校验（仅过滤明显异常值） ===
    // INA228 芯片支持范围
    if (voltage < 0 || voltage > 85) {           // VBUS: 0~85V
      console.log('电压超 INA228 范围:', voltage)
      return null
    }
    if (current < -50 || current > 50) {         // 配合分流器，典型 ±32A
      console.log('电流超范围:', current)
      return null
    }
    if (temperatureAdc < -40 || temperatureAdc > 150) { // 芯片温度传感器
      console.log('温度超 INA228 范围:', temperatureAdc)
      return null
    }

    // === 功率修正 ===
    // 固件发送的功率值可能不准，使用电压×电流计算更可靠
    const power = voltage * current

    return {
      header,
      snid,
      temperatureCpu,
      temperatureAdc,
      voltage,
      current,
      power,
      energyMWh,
      chargeMAh,
      espTimeUs,
      currentDirection
    }
  } catch (err) {
    console.error('数据解析错误:', err)
    return null
  }
}

// 新版数据解析函数（0x55 0xAA 双包头，44 字节）
function parseUSBCDCDataNew(data) {
  try {
    if (data.length !== USB_CDC_NEW_DATA_SIZE) {
      return null
    }

    // Header 验证：0x55 0xAA
    if (data[0] !== 0x55 || data[1] !== 0xAA) {
      return null
    }

    // 校验和验证（XOR 所有字节，不含 checksum 自身）
    let checksum = 0
    for (let i = 0; i < USB_CDC_NEW_DATA_SIZE - 1; i++) {
      checksum ^= data[i]
    }
    if (checksum !== data[USB_CDC_NEW_DATA_SIZE - 1]) {
      console.log('新版校验和错误')
      return null
    }

    let offset = 2

    // pack_type (1 byte)：0x00=单包，0x01=分块开始，0x02=分块结束
    const packType = data[offset]
    offset += 1

    // pack_index (2 bytes, uint16_t little-endian)：分块传输时的包索引，单包为 0
    const packIndex = data.readUInt16LE(offset)
    offset += 2

    // pack_length (1 byte)
    const packLength = data[offset]
    offset += 1

    // temperature_cpu (4 bytes, float little-endian) — ESP32 芯片温度
    const temperatureCpu = data.readFloatLE(offset)
    offset += 4

    // temperature_adc (4 bytes, float little-endian) — INA228 温度传感器
    const temperatureAdc = data.readFloatLE(offset)
    offset += 4

    // voltage (4 bytes, float little-endian)
    const voltage = data.readFloatLE(offset)
    offset += 4

    // current (4 bytes, float little-endian)
    const current = data.readFloatLE(offset)
    offset += 4

    // power (4 bytes, float little-endian) — 固件发送的原始功率值，仅供参考
    const rawPower = data.readFloatLE(offset)
    offset += 4

    // energy_mWh (4 bytes, float little-endian)
    const energyMWh = data.readFloatLE(offset)
    offset += 4

    // charge_mAh (4 bytes, float little-endian)
    const chargeMAh = data.readFloatLE(offset)
    offset += 4

    // esp_time_us (8 bytes, uint64_t little-endian) — esp_timer_get_time() 微秒
    const espTimeUs = Number(data.readBigUInt64LE(offset))
    offset += 8

    // current_direction (1 byte, bool)
    const currentDirection = data[offset] !== 0

    // === 宽松的数据有效性校验（仅过滤明显异常值） ===
    if (voltage < 0 || voltage > 85) {           // VBUS: 0~85V
      console.log('新版电压超 INA228 范围:', voltage)
      return null
    }
    if (current < -50 || current > 50) {         // 配合分流器，典型 ±32A
      console.log('新版电流超范围:', current)
      return null
    }
    if (temperatureAdc < -40 || temperatureAdc > 150) { // 芯片温度传感器
      console.log('新版温度超 INA228 范围:', temperatureAdc)
      return null
    }

    // === 功率修正 ===
    // 固件发送的功率值可能不准，使用电压×电流计算更可靠
    const power = voltage * current

    return {
      header: 0xAA, // 兼容字段：新格式实际为 0x55 0xAA 双包头
      packType,
      packIndex,
      packLength,
      snid: 0, // 新格式无 snid 字段
      temperatureCpu,
      temperatureAdc,
      voltage,
      current,
      power,
      energyMWh,
      chargeMAh,
      espTimeUs,
      currentDirection
    }
  } catch (err) {
    console.error('新版数据解析错误:', err)
    return null
  }
}

// 创建主窗口
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    title: `${APP_NAME} v${APP_VERSION}`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'build', 'icon.png')
      : path.join(__dirname, 'build', 'icon.png')
  })

  mainWindow.loadFile(path.join(__dirname, 'index.html'))

  // 窗口加载完成后发送当前主题
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('theme-changed', getCurrentTheme())
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    closeSerialPort()
    if (curveWindow && !curveWindow.isDestroyed()) {
      curveWindow.close()
    }
    if (firmwareWindow && !firmwareWindow.isDestroyed()) {
      firmwareWindow.close()
    }
    if (driverWindow && !driverWindow.isDestroyed()) {
      driverWindow.close()
    }
  })
}

// 创建曲线窗口
function createCurveWindow() {
  if (curveWindow && !curveWindow.isDestroyed()) {
    curveWindow.focus()
    return
  }

  // 获取屏幕尺寸，设置为屏幕的 85%
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize
  const windowWidth = Math.floor(screenWidth * 0.85)
  const windowHeight = Math.floor(screenHeight * 0.85)

  curveWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: Math.floor(windowWidth * 0.8),
    minHeight: Math.floor(windowHeight * 0.8),
    title: '实时数据曲线',
    center: true,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'build', 'curve.png')
      : path.join(__dirname, 'build', 'curve.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  curveWindow.loadFile(path.join(__dirname, 'curve.html'))

  // 为曲线窗口设置菜单
  const curveMenuTemplate = [
    {
      label: '文件',
      submenu: [
        {
          label: '保存当前曲线为PNG',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            if (curveWindow && !curveWindow.isDestroyed()) {
              curveWindow.webContents.send('menu-save-image')
            }
          }
        },
        {
          label: '保存数据为CSV',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            if (curveWindow && !curveWindow.isDestroyed()) {
              curveWindow.webContents.send('menu-save-data')
            }
          }
        },
        { type: 'separator' },
        {
          label: '关闭',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (curveWindow && !curveWindow.isDestroyed()) {
              curveWindow.close()
            }
          }
        }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '重置视图',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (curveWindow && !curveWindow.isDestroyed()) {
              curveWindow.webContents.send('menu-reset-view')
            }
          }
        },
        { type: 'separator' },
        {
          label: '主题',
          submenu: [
            {
              label: '亮色',
              type: 'radio',
              checked: currentTheme === 'light',
              click: () => setTheme('light')
            },
            {
              label: '暗色',
              type: 'radio',
              checked: currentTheme === 'dark',
              click: () => setTheme('dark')
            },
            {
              label: '跟随系统',
              type: 'radio',
              checked: currentTheme === 'system',
              click: () => setTheme('system')
            }
          ]
        },
        { type: 'separator' },
        {
          label: '开发者工具',
          accelerator: 'F12',
          click: () => {
            if (curveWindow && !curveWindow.isDestroyed()) {
              curveWindow.webContents.toggleDevTools()
            }
          }
        }
      ]
    }
  ]

  const curveMenu = Menu.buildFromTemplate(curveMenuTemplate)
  curveWindow.setMenu(curveMenu)

  // 窗口加载完成后发送当前主题
  curveWindow.webContents.on('did-finish-load', () => {
    curveWindow.webContents.send('theme-changed', getCurrentTheme())
  })

  curveWindow.on('closed', () => {
    curveWindow = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('curve-window-closed')
    }
  })
}

// 创建固件更新窗口
function createFirmwareWindow() {
  if (firmwareWindow && !firmwareWindow.isDestroyed()) {
    firmwareWindow.focus()
    return
  }

  firmwareWindow = new BrowserWindow({
    width: 800,
    height: 700,
    minWidth: 500,
    minHeight: 600,
    title: '固件更新',
    center: true,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'build', 'update.png')
      : path.join(__dirname, 'build', 'update.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  firmwareWindow.loadFile(path.join(__dirname, 'firmware.html'))

  // 窗口加载完成后发送当前主题
  firmwareWindow.webContents.on('did-finish-load', () => {
    firmwareWindow.webContents.send('theme-changed', getCurrentTheme())
  })

  // F12 打开当前窗口的控制台
  firmwareWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      event.preventDefault()
      firmwareWindow.webContents.toggleDevTools()
    }
  })

  firmwareWindow.on('closed', () => {
    firmwareWindow = null
  })
}

// 创建驱动安装窗口
function createDriverWindow() {
  if (driverWindow && !driverWindow.isDestroyed()) {
    driverWindow.focus()
    return
  }

  driverWindow = new BrowserWindow({
    width: 600,
    height: 600,
    minWidth: 450,
    minHeight: 450,
    title: '驱动安装',
    center: true,
    resizable: true,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'build', 'drive.png')
      : path.join(__dirname, 'build', 'drive.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  driverWindow.loadFile(path.join(__dirname, 'driver.html'))

  driverWindow.webContents.on('did-finish-load', () => {
    driverWindow.webContents.send('theme-changed', getCurrentTheme())
  })

  driverWindow.on('closed', () => {
    driverWindow = null
  })
}

// 获取驱动文件所在目录（处理 asar 打包路径）
function getDriverDir() {
  // extraResources 在打包后位于 resources/drives/，开发模式在项目根目录
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'drives', 'esp32-jtag-usb-drives')
  }
  return path.join(__dirname, 'drives', 'esp32-jtag-usb-drives')
}

// 判断是否为虚拟串口
function isVirtualPort(port) {
  // 虚拟串口软件的常见制造商名称
  const virtualManufacturers = [
    'com0com',
    'Virtual',
    'VSPD',
    'Eltima',
    'HW VSP3',
    'Virtual Serial',
    'TightVNC'
  ]

  // 检查制造商名称
  if (port.manufacturer) {
    const manufacturer = port.manufacturer.toLowerCase()
    for (const vm of virtualManufacturers) {
      if (manufacturer.includes(vm.toLowerCase())) {
        return true
      }
    }
  }

  // 如果厂商信息表明是已知的虚拟串口驱动，则视为虚拟串口
  if (port.manufacturer) {
    const manufacturer = port.manufacturer.toLowerCase()
    for (const vm of virtualManufacturers) {
      if (manufacturer.includes(vm.toLowerCase())) {
        return true
      }
    }
  }

  // 有 vendorId 和 productId 通常说明这是一个真实的 USB 串口设备，而非软件虚拟端口
  if (port.vendorId && port.productId) {
    return false
  }

  // 如果 pnpId 明确包含 virtual，则可以认为是虚拟串口
  if (port.pnpId) {
    const pnpId = port.pnpId.toLowerCase()
    if (pnpId.includes('virtual')) {
      return true
    }
  }

  return false
}

// 使用Windows注册表获取串口列表（备用方法）- 已注释
/*
function getPortsFromRegistry() {
  try {
    const { execSync } = require('child_process')
    // 使用PowerShell查询注册表获取串口
    const output = execSync('powershell -Command "Get-ItemProperty -Path \'HKLM:\\HARDWARE\\DEVICEMAP\\SERIALCOMM\\\' 2>$null | Select-Object -Property * -ExcludeProperty PS* | ConvertTo-Json"', {
      encoding: 'utf8',
      timeout: 5000
    })
    
    if (!output || output.trim() === '') {
      return []
    }
    
    const data = JSON.parse(output)
    const ports = []
    
    // 处理单个或多个串口的情况
    if (Array.isArray(data)) {
      data.forEach(item => {
        Object.values(item).forEach(value => {
          if (typeof value === 'string' && value.startsWith('COM')) {
            ports.push({
              path: value,
              manufacturer: 'Registry',
              isVirtual: true
            })
          }
        })
      })
    } else if (typeof data === 'object') {
      Object.values(data).forEach(value => {
        if (typeof value === 'string' && value.startsWith('COM')) {
          ports.push({
            path: value,
            manufacturer: 'Registry',
            isVirtual: true
          })
        }
      })
    }
    
    return ports
  } catch (err) {
    console.error('从注册表获取串口失败:', err.message)
    return []
  }
}
*/

// 获取可用串口列表
async function listPorts() {
  try {
    const ports = await SerialPort.list()
    console.log('SerialPort.list() 返回:', ports)
    
    // 如果SerialPort.list()返回空，返回空数组（已移除注册表获取方式）
    if (ports.length === 0) {
      console.log('SerialPort.list()为空')
      return []
    }
    
    const result = ports.map(port => ({
      path: port.path,
      manufacturer: port.manufacturer,
      pnpId: port.pnpId,
      productId: port.productId,
      vendorId: port.vendorId,
      isVirtual: isVirtualPort(port)
    }))
    console.log('处理后的串口列表:', result)
    return result
  } catch (err) {
    console.error('获取串口列表失败:', err)
    // 出错时返回空数组（已移除注册表获取方式）
    return []
  }
}

// 打开串口
async function openSerialPort(portPath, baudRate) {
  return new Promise((resolve, reject) => {
    if (serialPort && serialPort.isOpen) {
      serialPort.close()
    }

    serialPort = new SerialPort({
      path: portPath,
      baudRate: parseInt(baudRate),
      autoOpen: false
    })

    serialPort.open((err) => {
      if (err) {
        reject(err)
        return
      }

      isReading = true
      dataBuffer = Buffer.alloc(0)

      serialPort.on('data', (data) => {
        handleSerialData(data)
      })

      serialPort.on('error', (err) => {
        console.error('串口错误:', err)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('serial-error', err.message)
        }
      })

      serialPort.on('close', () => {
        isReading = false
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('serial-closed')
        }
      })

      resolve()
    })
  })
}

// 关闭串口
function closeSerialPort() {
  return new Promise((resolve) => {
    isReading = false
    if (serialPort && serialPort.isOpen) {
      serialPort.close(() => {
        resolve()
      })
    } else {
      resolve()
    }
  })
}

// 扫描缓冲区，查找下一个数据包头
// 返回 { headerIndex, isNewFormat }；未找到返回 null
// 新格式：0x55 0xAA 双包头；旧格式：0xAA 单包头
function scanForHeader(buffer) {
  const end = buffer.length - 1
  for (let i = 0; i < end; i++) {
    // 新格式：0x55 后紧跟 0xAA
    if (buffer[i] === 0x55 && buffer[i + 1] === 0xAA) {
      return { headerIndex: i, isNewFormat: true }
    }
    // 旧格式：0xAA（若前一个字节是 0x55，则它属于新格式头，跳过）
    if (buffer[i] === 0xAA && (i === 0 || buffer[i - 1] !== 0x55)) {
      return { headerIndex: i, isNewFormat: false }
    }
  }
  return null
}

// 处理串口数据
function handleSerialData(data) {
  // 将新数据追加到缓冲区
  dataBuffer = Buffer.concat([dataBuffer, data])

  // 二进制模式：扫描缓冲区寻找数据包头（新格式 0x55 0xAA / 旧格式 0xAA）
  while (dataBuffer.length >= USB_CDC_DATA_SIZE) {
    // 查找下一个数据包头
    const found = scanForHeader(dataBuffer)

    if (!found) {
      // 没有找到包头，退出循环，等待更多数据
      break
    }

    const { headerIndex, isNewFormat } = found

    // 如果包头不在缓冲区开头，先处理前面的数据（作为文本）
    if (headerIndex > 0) {
      const preHeaderData = dataBuffer.slice(0, headerIndex)
      const textRemaining = processTextData(preHeaderData)
      // 将文本剩余数据与包头之后的数据合并（textRemaining 通常为空）
      dataBuffer = Buffer.concat([textRemaining, dataBuffer.slice(headerIndex)])
    }

    // 现在 dataBuffer[0] 为包头，检查是否有完整的数据包
    if (dataBuffer.length < USB_CDC_DATA_SIZE) {
      // 数据不完整，等待更多数据
      break
    }

    const packet = dataBuffer.slice(0, USB_CDC_DATA_SIZE)
    const parsedData = isNewFormat ? parseUSBCDCDataNew(packet) : parseUSBCDCData(packet)

    if (parsedData) {
      // 校验通过，提取数据包
      dataBuffer = dataBuffer.slice(USB_CDC_DATA_SIZE)

      // 发送解析后的数据到渲染进程
      if (curveWindow && !curveWindow.isDestroyed()) {
        curveWindow.webContents.send('meter-data', parsedData)
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('meter-data', parsedData)
      }
    } else {
      // 校验失败，跳过当前字节继续寻找下一个包头
      dataBuffer = dataBuffer.slice(1)
    }
  }

  // 处理剩余缓冲区中的文本数据（最后可能没有完整的二进制数据包）
  dataBuffer = processTextData(dataBuffer)

  // 防止缓冲区过大
  if (dataBuffer.length > 1024) {
    dataBuffer = dataBuffer.slice(-512)
  }
}

// 处理文本数据（查找换行符），返回未处理完的剩余数据
function processTextData(buffer) {
  if (buffer.length === 0) return Buffer.alloc(0)
  
  let tempBuffer = Buffer.from(buffer)
  let newlineIndex
  
  while ((newlineIndex = tempBuffer.indexOf('\n')) !== -1) {
    const lineBuffer = tempBuffer.slice(0, newlineIndex)
    tempBuffer = tempBuffer.slice(newlineIndex + 1)

    // 检查是否为有效文本（过滤二进制数据）
    if (isValidText(lineBuffer)) {
      const line = lineBuffer.toString('utf8')
      // 发送文本数据到渲染进程
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial-data', line)
      }
    }
  }
  
  // 返回未处理完的剩余数据（不再直接修改全局 dataBuffer）
  return tempBuffer
}

// 检查数据是否为有效文本（过滤二进制数据）
function isValidText(buffer) {
  // 检查是否包含不可打印的控制字符（除了常见的换行、制表符）
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i]
    // 排除控制字符（0x00-0x1F，除了 0x09 TAB, 0x0A LF, 0x0D CR）
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0A && byte !== 0x0D) {
      return false
    }
    // 排除 DEL 字符
    if (byte === 0x7F) {
      return false
    }
  }
  
  // 尝试解码为 UTF-8，检查是否有替换字符
  try {
    const str = buffer.toString('utf8')
    if (str.includes('\uFFFD')) {
      return false
    }
  } catch (e) {
    return false
  }
  
  return true
}

// 发送命令到串口
function sendCommand(cmd) {
  return new Promise((resolve, reject) => {
    if (!serialPort || !serialPort.isOpen) {
      reject(new Error('串口未打开'))
      return
    }

    const command = cmd.endsWith('\n') ? cmd : cmd + '\n'
    serialPort.write(command, 'utf8', (err) => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

// 请求数据包
async function requestDataPacket() {
  if (!serialPort || !serialPort.isOpen) {
    return
  }

  try {
    // 清空输入缓冲区
    await new Promise((resolve) => {
      serialPort.flush(() => resolve())
    })

    // 发送 data 命令
    await sendCommand('data')
  } catch (err) {
    console.error('请求数据包失败:', err)
  }
}

// IPC 处理程序
ipcMain.handle('list-ports', async () => {
  return await listPorts()
})

ipcMain.handle('open-port', async (event, { path, baudRate }) => {
  try {
    await openSerialPort(path, baudRate)
    lastPort = path
    lastBaudRate = baudRate
    saveConfig({ lastPort: path, lastBaudRate: baudRate })
    addOperationLog('SERIAL', 'CONNECT', `连接串口: ${path} @ ${baudRate}bps`)
    return { success: true }
  } catch (err) {
    addOperationLog('SERIAL', 'CONNECT_ERROR', `连接串口失败: ${err.message}`)
    return { success: false, error: err.message }
  }
})

ipcMain.handle('close-port', async () => {
  addOperationLog('SERIAL', 'DISCONNECT', '关闭串口')
  await closeSerialPort()
  return { success: true }
})

ipcMain.handle('send-command', async (event, cmd) => {
  try {
    await sendCommand(cmd)
    addOperationLog('SERIAL', 'SEND_CMD', `发送命令: ${cmd}`)
    return { success: true }
  } catch (err) {
    addOperationLog('SERIAL', 'SEND_ERROR', `发送命令失败: ${err.message}`)
    return { success: false, error: err.message }
  }
})

ipcMain.handle('request-data', async () => {
  await requestDataPacket()
  return { success: true }
})

ipcMain.handle('is-port-open', async () => {
  return serialPort && serialPort.isOpen
})

// 固件更新专用：释放主窗口串口（阻塞式，确保完全释放）
ipcMain.handle('release-main-port', async () => {
  if (serialPort && serialPort.isOpen) {
    console.log('[FIRMWARE] 正在关闭主界面串口...')
    addOperationLog('SERIAL', 'RELEASE_FOR_FIRMWARE', '固件更新释放串口')
    await closeSerialPort()
    // USB 复合设备（如 ESP32-C3 USB-JTAG）需要更长冷却时间
    // 确保操作系统完全注销端口权限并重新注册
    await delay(2000)
    console.log('[FIRMWARE] 主界面串口已关闭（冷却 2s）')
    return { success: true, released: true }
  }
  return { success: true, released: false }
})

ipcMain.handle('open-curve-window', async () => {
  createCurveWindow()
  return { success: true }
})

ipcMain.handle('open-firmware-window', async () => {
  createFirmwareWindow()
  return { success: true }
})

// === 固件烧录（主进程 serialport 方案，避免 Electron WebSerial 崩溃）===

const { flashFirmware, eraseFlashChip } = require('./firmware-flash')

ipcMain.handle('flash-firmware', async (event, params) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  
  const onProgress = (percent, message) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('flash-progress', { percent, message })
    }
  }
  
  const onLog = (message) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('flash-log', message)
    }
  }

  // 先释放主界面串口
  if (serialPort && serialPort.isOpen) {
    console.log('[FLASH] 正在关闭主界面串口...')
    await closeSerialPort()
    await delay(2000)
  }

  const result = await flashFirmware(params, onProgress, onLog)
  return result
})

ipcMain.handle('erase-flash', async (event, portPath) => {
  const win = BrowserWindow.fromWebContents(event.sender)

  const onProgress = (percent, message) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('flash-progress', { percent, message })
    }
  }

  const onLog = (message) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('flash-log', message)
    }
  }

  // 先释放主界面串口
  if (serialPort && serialPort.isOpen) {
    console.log('[FLASH] 正在关闭主界面串口...')
    await closeSerialPort()
    await delay(2000)
  }

  const result = await eraseFlashChip(portPath, onProgress, onLog)
  return result
})

// 打开固件文件对话框
ipcMain.handle('open-firmware-dialog', async () => {
  const result = await dialog.showOpenDialog(firmwareWindow || mainWindow, {
    title: '选择固件文件',
    filters: [
      { name: 'Binary Files', extensions: ['bin'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  })
  return result
})

// 读取文件
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const data = fs.readFileSync(filePath)
    // 返回 ArrayBuffer
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  } catch (err) {
    console.error('读取文件失败:', err)
    throw err
  }
})

// 驱动安装（通过 PowerShell Start-Process -Verb RunAs 提权 + 临时文件捕获输出）
function runPnputil(command, infPath) {
  const { exec } = require('child_process')
  const os = require('os')
  const subCmd = command === 'add-driver' ? 'install' : 'uninstall'
  const tmpOut = path.join(os.tmpdir(), `pnputil_out_${Date.now()}.txt`)
  const psScript = path.join(os.tmpdir(), `pnputil_${Date.now()}.ps1`)

  // PowerShell 单引号转义：单引号内反斜杠是字面量，只需处理内嵌单引号
  const sq = (s) => "'" + s.replace(/'/g, "''") + "'"

  // 两层结构：外层用 -Verb RunAs 启动内层 PowerShell，内层执行 pnputil 并写临时文件
  const scriptContent = [
    '$tmpOut = ' + sq(tmpOut),
    '$infPath = ' + sq(infPath),
    '',
    '# 内层命令：设置 UTF-8 编码 + 执行 pnputil + 输出重定向到文件',
    '$innerCmd = "chcp 65001 > `$null; pnputil /' + command + ' `"$infPath`" /' + subCmd + ' 2>&1 | Out-File -FilePath $tmpOut -Encoding UTF8"',
    '',
    '# 以管理员身份启动内层 PowerShell',
    "Start-Process -FilePath powershell -ArgumentList '-NoProfile','-Command',$innerCmd -Verb RunAs -Wait -WindowStyle Hidden",
    '',
    'if (Test-Path $tmpOut) {',
    '  Get-Content $tmpOut -Encoding UTF8 | Write-Output',
    '  Remove-Item $tmpOut -Force',
    '} else {',
    "  Write-Output '操作已完成（无输出）'",
    '}'
  ].join('\n')

  fs.writeFileSync(psScript, scriptContent, 'utf8')
  console.log(`[DRIVER] 执行: pnputil /${command} /${subCmd}`)

  return new Promise((resolve) => {
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psScript}"`,
      { timeout: 120000, encoding: 'utf8' },
      (error, stdout, stderr) => {
        // 清理临时脚本
        try { fs.unlinkSync(psScript) } catch (_) { /* ignore */ }

        const output = (stdout + stderr).trim()
        if (error && !output) {
          resolve({ success: false, message: `操作失败: ${error.message}` })
          return
        }
        // pnputil 输出判断成功（不区分大小写）
        const lowerOutput = output.toLowerCase()
        const isSuccess = lowerOutput.includes('published') ||
                          lowerOutput.includes('successfully') ||
                          lowerOutput.includes('added driver packages') ||
                          lowerOutput.includes('成功')
        if (isSuccess) {
          resolve({ success: true, message: output || '操作完成' })
        } else {
          resolve({ success: false, message: output || '操作失败，请尝试以管理员身份运行本程序' })
        }
      })
  })
}

ipcMain.handle('install-driver', async () => {
  const driverDir = getDriverDir()
  const infPath = path.join(driverDir, 'USB_JTAG_debug_unit.inf')

  if (!fs.existsSync(infPath)) {
    return { success: false, message: `未找到驱动文件:\n${infPath}` }
  }

  return runPnputil('add-driver', infPath)
})

ipcMain.handle('uninstall-driver', async () => {
  const driverDir = getDriverDir()
  const infPath = path.join(driverDir, 'USB_JTAG_debug_unit.inf')

  if (!fs.existsSync(infPath)) {
    return { success: false, message: `未找到驱动文件:\n${infPath}` }
  }

  return runPnputil('delete-driver', infPath)
})

// 延迟函数
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
const sleep = delay

// ========================================
ipcMain.handle('save-dialog', async (event, { defaultName, filters }) => {
  const documentsPath = app.getPath('documents')
  const defaultPath = path.normalize(path.join(documentsPath, defaultName))
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultPath,
    filters: filters
  })
  return result
})

// 保存图片对话框
ipcMain.handle('save-image-dialog', async (event, { defaultName }) => {
  const documentsPath = app.getPath('documents')
  const defaultPath = path.normalize(path.join(documentsPath, defaultName))
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultPath,
    filters: [
      { name: 'PNG Image', extensions: ['png'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  return result
})

// 保存图片文件
ipcMain.handle('save-image-file', async (event, { filePath, dataUrl }) => {
  try {
    // 规范化路径
    const normalizedPath = path.normalize(filePath)
    
    // 确保目录存在
    const dir = path.dirname(normalizedPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '')
    fs.writeFileSync(normalizedPath, Buffer.from(base64Data, 'base64'))
    addOperationLog('FILE', 'SAVE_IMAGE', `图片已保存: ${normalizedPath}`)
    return { success: true }
  } catch (err) {
    addOperationLog('ERROR', 'SAVE_IMAGE', `保存图片失败: ${err.message}`)
    return { success: false, error: err.message }
  }
})

// 保存日志文件
ipcMain.handle('save-log-file', async (event, { filePath, content }) => {
  try {
    // 规范化路径
    const normalizedPath = path.normalize(filePath)
    
    // 确保目录存在
    const dir = path.dirname(normalizedPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    
    fs.writeFileSync(normalizedPath, content, 'utf8')
    addOperationLog('FILE', 'SAVE', `文件已保存: ${normalizedPath}`)
    return { success: true }
  } catch (err) {
    addOperationLog('ERROR', 'SAVE_FILE', `保存文件失败: ${err.message}`)
    return { success: false, error: err.message }
  }
})

// 创建菜单栏
function createMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '导出操作日志',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('menu-save-log')
            }
          }
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            addOperationLog('MENU', 'QUIT', '用户点击退出菜单')
            app.quit()
          }
        }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '刷新端口',
          accelerator: 'F5',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('menu-refresh-ports')
            }
          }
        },
        { type: 'separator' },
        {
          label: '主题',
          submenu: [
            {
              label: '亮色',
              type: 'radio',
              checked: currentTheme === 'light',
              click: () => setTheme('light')
            },
            {
              label: '暗色',
              type: 'radio',
              checked: currentTheme === 'dark',
              click: () => setTheme('dark')
            },
            {
              label: '跟随系统',
              type: 'radio',
              checked: currentTheme === 'system',
              click: () => setTheme('system')
            }
          ]
        },
        { type: 'separator' },
        {
          label: '开发者工具',
          accelerator: 'F12',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.toggleDevTools()
            }
          }
        }
      ]
    },
    {
      label: '工具',
      submenu: [
        {
          label: '打开曲线界面',
          accelerator: 'CmdOrCtrl+M',
          click: () => {
            createCurveWindow()
          }
        },
        {
          type: 'separator'
        },
        {
          label: '固件更新',
          accelerator: 'CmdOrCtrl+U',
          click: () => {
            createFirmwareWindow()
          }
        },
        {
          type: 'separator'
        },
        {
          label: '安装驱动',
          click: () => {
            createDriverWindow()
          }
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新',
          click: () => {
            checkForUpdatesManually()
          }
        },
        { type: 'separator' },
        {
          label: '关于',
          click: () => {
            const info = getVersionInfo()
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: `${APP_NAME}`,
              detail: `版本: ${APP_VERSION}\n编译时间: ${BUILD_TIME}\n\n${info.releaseNotes}\n\n更新日志:\n${info.changelog}`
            })
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

// 加载配置文件
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8')
      const config = JSON.parse(data)
      
      // 加载主题设置
      if (config.theme && ['light', 'dark', 'system'].includes(config.theme)) {
        currentTheme = config.theme
        addOperationLog('CONFIG', 'LOAD', `加载配置文件成功，主题=${currentTheme}`)
      }
      
      // 加载上次使用的串口设置
      if (config.lastPort) {
        lastPort = config.lastPort
      }
      if (config.lastBaudRate) {
        lastBaudRate = config.lastBaudRate
      }
      
      return config
    } else {
      addOperationLog('CONFIG', 'CREATE', '配置文件不存在，创建默认配置')
      saveConfig({ theme: currentTheme })
    }
  } catch (err) {
    addOperationLog('CONFIG', 'ERROR', `加载配置文件失败: ${err.message}`)
    saveConfig({ theme: currentTheme })
  }
  return {}
}

// 保存配置文件
function saveConfig(updates = {}) {
  try {
    let config = {}
    
    // 读取现有配置
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8')
        config = JSON.parse(data)
      } catch (e) {
        config = {}
      }
    }
    
    // 合并更新
    config = { ...config, ...updates }
    config.lastModified = new Date().toISOString()
    
    // 保存
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
    addOperationLog('CONFIG', 'SAVE', `保存配置文件: ${JSON.stringify(updates)}`)
    return true
  } catch (err) {
    addOperationLog('CONFIG', 'ERROR', `保存配置文件失败: ${err.message}`)
    return false
  }
}

// 设置主题
function setTheme(theme) {
  const oldTheme = currentTheme
  currentTheme = theme
  
  // 保存到配置文件
  saveConfig({ theme: currentTheme })
  addOperationLog('UI', 'THEME_CHANGE', `主题变更: ${oldTheme} -> ${theme}`)
  
  // 确定实际主题
  let effectiveTheme = theme
  if (theme === 'system') {
    effectiveTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }
  
  // 通知所有窗口
  const windows = BrowserWindow.getAllWindows()
  windows.forEach(win => {
    win.webContents.send('theme-changed', effectiveTheme)
  })
  
  // 更新菜单选中状态
  createMenu()
}

// 获取当前主题
function getCurrentTheme() {
  if (currentTheme === 'system') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }
  return currentTheme
}

// 监听系统主题变化
nativeTheme.on('updated', () => {
  if (currentTheme === 'system') {
    const effectiveTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    const windows = BrowserWindow.getAllWindows()
    windows.forEach(win => {
      win.webContents.send('theme-changed', effectiveTheme)
    })
  }
})

//// IPC 处理
ipcMain.handle('get-theme', () => {
  return getCurrentTheme()
})

ipcMain.handle('get-last-port', () => {
  return lastPort
})

ipcMain.handle('get-last-baudrate', () => {
  return lastBaudRate
})

// 导出操作日志
ipcMain.handle('get-operation-logs', () => {
  return operationLogs
})

// 导出操作日志到文件
ipcMain.handle('export-operation-log', async (event, { filePath }) => {
  try {
    // 规范化路径
    const normalizedPath = path.normalize(filePath)
    
    // 确保目录存在
    const dir = path.dirname(normalizedPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    
    const logs = operationLogs.map(log => {
      return `[${log.timestamp}] [${log.type}] ${log.action}: ${log.detail}`
    }).join('\n')
    
    fs.writeFileSync(normalizedPath, '\ufeff' + logs, 'utf8')
    addOperationLog('MENU', 'EXPORT_LOG', `操作日志已导出至: ${normalizedPath}`)
    return { success: true }
  } catch (err) {
    addOperationLog('ERROR', 'EXPORT_LOG', `导出操作日志失败: ${err.message}`)
    return { success: false, error: err.message }
  }
})

// 应用启动
app.whenReady().then(() => {
  // 加载配置
  loadConfig()
  addOperationLog('APP', 'START', `应用程序启动，版本=${APP_VERSION}`)
  
  // 注册更新模块 IPC
  registerUpdateIPC()

  createMenu()
  createMainWindow()

  // 启动后延迟检查更新
  scheduleStartupCheck()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow()
  }
})

// 应用退出前清理
app.on('before-quit', () => {
  addOperationLog('APP', 'QUIT', '应用程序即将退出')
  closeSerialPort()
  saveConfig({ theme: currentTheme })
})

app.on('window-all-closed', () => {
  closeSerialPort()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 处理未捕获的异常
process.on('uncaughtException', (err) => {
  addOperationLog('ERROR', 'EXCEPTION', `未捕获的异常: ${err.message}`)
  console.error('未捕获的异常:', err)
})
