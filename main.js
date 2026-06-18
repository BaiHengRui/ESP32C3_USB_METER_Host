const { app, BrowserWindow, ipcMain, dialog, screen, Menu, nativeTheme } = require('electron')
const path = require('path')
const fs = require('fs')
const { SerialPort } = require('serialport')

// 应用信息
const APP_NAME = 'ESP32C3-METER 上位机'
const APP_VERSION = '1.1.6Beta'

// 获取编译时间
function getBuildTime() {
  try {
    const stats = fs.statSync(__filename)
    const buildDate = new Date(stats.mtime)
    // 转换为GMT+8
    const gmt8Time = new Date(buildDate.getTime() + 8 * 60 * 60 * 1000)
    const year = gmt8Time.getUTCFullYear()
    const month = String(gmt8Time.getUTCMonth() + 1).padStart(2, '0')
    const day = String(gmt8Time.getUTCDate()).padStart(2, '0')
    const hours = String(gmt8Time.getUTCHours()).padStart(2, '0')
    const minutes = String(gmt8Time.getUTCMinutes()).padStart(2, '0')
    const seconds = String(gmt8Time.getUTCSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} (GMT+8)`
  } catch (e) {
    return '未知'
  }
}
const BUILD_TIME = getBuildTime()

// USB_CDC_Data 结构体大小
const USB_CDC_DATA_SIZE = 64

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

    // 校验和验证
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

    // sw_version (12 bytes, string)
    const swVersion = data.slice(offset, offset + 12).toString('utf8').replace(/\0/g, '')
    offset += 12

    // hw_version (12 bytes, string)
    const hwVersion = data.slice(offset, offset + 12).toString('utf8').replace(/\0/g, '')
    offset += 12

    // voltage (4 bytes, float little-endian)
    const voltage = data.readFloatLE(offset)
    offset += 4

    // current (4 bytes, float little-endian)
    const current = data.readFloatLE(offset)
    offset += 4

    // power (4 bytes, float little-endian)
    const power = data.readFloatLE(offset)
    offset += 4

    // energy_mWh (4 bytes, float little-endian)
    const energyMWh = data.readFloatLE(offset)
    offset += 4

    // charge_mAh (4 bytes, float little-endian)
    const chargeMAh = data.readFloatLE(offset)
    offset += 4

    // temperature (4 bytes, float little-endian)
    const temperature = data.readFloatLE(offset)
    offset += 4

    // time_ms (8 bytes, uint64_t little-endian)
    const timeMs = Number(data.readBigUInt64LE(offset))
    offset += 8

    // current_direction (1 byte, bool)
    const currentDirection = data[offset] !== 0

    // 温度范围验证
    if (temperature < -40.0 || temperature > 125.0) {
      console.log('温度异常:', temperature)
      return null
    }

    return {
      header,
      snid,
      swVersion,
      hwVersion,
      voltage,
      current,
      power,
      energyMWh,
      chargeMAh,
      energyWh: 0.0,
      chargeAh: 0.0,
      temperature,
      timeMs,
      currentDirection
    }
  } catch (err) {
    console.error('数据解析错误:', err)
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
    icon: path.join(__dirname, 'assets', 'icon.png')
  })

  mainWindow.loadFile('index.html')

  // 窗口加载完成后发送当前主题
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('theme-changed', getCurrentTheme())
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    closeSerialPort()
    if (curveWindow) {
      curveWindow.close()
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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  curveWindow.loadFile('curve.html')

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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  firmwareWindow.loadFile('firmware.html')

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

// 处理串口数据
function handleSerialData(data) {
  // 将新数据追加到缓冲区
  dataBuffer = Buffer.concat([dataBuffer, data])

  // 二进制模式：扫描缓冲区寻找 0xAA 包头
  while (dataBuffer.length >= USB_CDC_DATA_SIZE) {
    // 查找 0xAA 包头
    const headerIndex = dataBuffer.indexOf(0xAA)
    
    if (headerIndex === -1) {
      // 没有找到包头，退出循环，等待更多数据
      break
    }

    // 如果包头不在缓冲区开头，先处理前面的数据（作为文本）
    if (headerIndex > 0) {
      const preHeaderData = dataBuffer.slice(0, headerIndex)
      processTextData(preHeaderData)
      dataBuffer = dataBuffer.slice(headerIndex)
    }

    // 现在 dataBuffer[0] === 0xAA，检查是否有完整的 64 字节数据包
    if (dataBuffer.length < USB_CDC_DATA_SIZE) {
      // 数据不完整，等待更多数据
      break
    }

    const packet = dataBuffer.slice(0, USB_CDC_DATA_SIZE)
    const parsedData = parseUSBCDCData(packet)
    
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
      // 校验失败，跳过当前字节继续寻找下一个 0xAA
      dataBuffer = dataBuffer.slice(1)
    }
  }

  // 处理剩余缓冲区中的文本数据（最后可能没有完整的二进制数据包）
  processTextData(dataBuffer)

  // 防止缓冲区过大
  if (dataBuffer.length > 1024) {
    dataBuffer = dataBuffer.slice(-512)
  }
}

// 处理文本数据（查找换行符）
function processTextData(buffer) {
  if (buffer.length === 0) return
  
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
  
  // 更新 dataBuffer 为未处理完的剩余数据
  if (tempBuffer.length > 0) {
    dataBuffer = tempBuffer
  } else {
    dataBuffer = Buffer.alloc(0)
  }
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
    // 等待串口完全关闭，给操作系统释放端口的时间
    await delay(1000)
    console.log('[FIRMWARE] 主界面串口已关闭')
    return { success: true, released: true }
  }
  return { success: true, released: false }
})

ipcMain.handle('open-curve-window', async () => {
  createCurveWindow()
  return { success: true }
})

ipcMain.handle('open-firmware-window', async () => {
  // 先关闭主界面的串口连接，释放端口占用
  if (serialPort && serialPort.isOpen) {
    console.log('[FIRMWARE] 正在关闭主界面串口...')
    await closeSerialPort()
    await delay(1000)
    console.log('[FIRMWARE] 主界面串口已关闭')
  }

  createFirmwareWindow()
  return { success: true }
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
          click: async () => {
            // 先关闭主界面的串口连接，释放端口占用
            if (serialPort && serialPort.isOpen) {
              console.log('[FIRMWARE] 正在关闭主界面串口...')
              await closeSerialPort()
              await delay(1000)
              console.log('[FIRMWARE] 主界面串口已关闭')
            }
            createFirmwareWindow()
          }
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: `${APP_NAME}`,
              detail: `版本: ${APP_VERSION}\n编译时间: ${BUILD_TIME}\n\nESP32C3 USB 电表上位机\n用于与 ESP32C3 设备通信并实时显示数据。`
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
  
  createMenu()
  createMainWindow()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow()
  }
})

// 应用退出前保存配置
app.on('before-quit', () => {
  addOperationLog('APP', 'QUIT', '应用程序即将退出')
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

// ========================================
// 固件更新 — NodeTransport + 主进程烧录
// ========================================

// 固件更新状态
let firmwareAborted = false

/**
 * 基于 serialport 的 NodeTransport，实现 esptool-js Transport 接口
 */
class NodeTransport {
  constructor(portPath) {
    this.portPath = portPath
    this.baudrate = 115200
    this.serialPort = null
    this.buffer = new Uint8Array(0)
    this.tracing = false
    this.SLIP_END = 0xC0
    this.SLIP_ESC = 0xDB
    this.SLIP_ESC_END = 0xDC
    this.SLIP_ESC_ESC = 0xDD
    this.onDeviceLostCallback = null
  }

  /** 打开串口 */
  async connect(baud = 115200, serialOptions = {}) {
    this.baudrate = baud
    return new Promise((resolve, reject) => {
      this.serialPort = new SerialPort({
        path: this.portPath,
        baudRate: baud,
        dataBits: serialOptions.dataBits || 8,
        stopBits: serialOptions.stopBits || 1,
        parity: serialOptions.parity || 'none',
        flowControl: serialOptions.flowControl || 'none',
        autoOpen: false,
      })
      this.serialPort.open((err) => {
        if (err) { reject(err); return }
        // 启动数据收集
        this._startReadLoop()
        resolve()
      })
    })
  }

  /** 关闭串口 */
  async disconnect() {
    return new Promise((resolve) => {
      if (this.serialPort && this.serialPort.isOpen) {
        this.serialPort.close(() => resolve())
      } else {
        resolve()
      }
    })
  }

  /** 写入数据（SLIP 编码后） */
  async write(data) {
    const outData = this.slipWriter(data)
    return new Promise((resolve, reject) => {
      if (!this.serialPort || !this.serialPort.isOpen) {
        reject(new Error('串口未打开'))
        return
      }
      this.serialPort.write(Buffer.from(outData), (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  /** 读取数据（SLIP 解码，带超时） */
  async read(timeout) {
    let partialPacket = null
    let isEscaping = false
    let readBytes = null

    while (true) {
      const timeStamp = Date.now()
      readBytes = new Uint8Array(0)

      while (Date.now() - timeStamp < timeout) {
        if (this.buffer.length > 0) {
          readBytes = this.buffer
          this.buffer = new Uint8Array(0)
          break
        }
        await sleep(1)
      }

      if (!readBytes || readBytes.length === 0) {
        const msg = partialPacket === null
          ? 'Serial data stream stopped: Possible serial noise or corruption.'
          : 'No serial data received.'
        if (this.tracing) console.log('[NodeTransport] ' + msg)
        throw new Error(msg)
      }

      for (let i = 0; i < readBytes.length; i++) {
        const byte = readBytes[i]
        if (partialPacket === null) {
          if (byte === this.SLIP_END) {
              partialPacket = new Uint8Array(0)
            } else {
              // 非 SLIP 数据（如芯片启动日志），抛出异常让 readPacket 重试
              if (this.tracing) {
                console.log('[NodeTransport] 收到无效数据（非 SLIP 包头）: 0x' + byte.toString(16))
              }
              throw new Error('Invalid head of packet (0x' + byte.toString(16) + '): Possible serial noise or corruption.')
            }
        } else if (isEscaping) {
          isEscaping = false
          if (byte === this.SLIP_ESC_END) {
            const newPacket = new Uint8Array(partialPacket.length + 1)
            newPacket.set(partialPacket)
            newPacket[partialPacket.length] = this.SLIP_END
            partialPacket = newPacket
          } else if (byte === this.SLIP_ESC_ESC) {
            const newPacket = new Uint8Array(partialPacket.length + 1)
            newPacket.set(partialPacket)
            newPacket[partialPacket.length] = this.SLIP_ESC
            partialPacket = newPacket
          } else {
            // Invalid escape sequence, restart packet
            partialPacket = null
          }
        } else if (byte === this.SLIP_ESC) {
          isEscaping = true
        } else if (byte === this.SLIP_END) {
          if (partialPacket.length > 0) {
            this.detectPanicHandler(partialPacket)
            return partialPacket
          }
        } else {
          const newPacket = new Uint8Array(partialPacket.length + 1)
          newPacket.set(partialPacket)
          newPacket[partialPacket.length] = byte
          partialPacket = newPacket
        }
      }
    }
  }

  /** SLIP 编码 */
  slipWriter(data) {
    const output = []
    output.push(this.SLIP_END)
    for (let i = 0; i < data.length; i++) {
      if (data[i] === this.SLIP_END) {
        output.push(this.SLIP_ESC, this.SLIP_ESC_END)
      } else if (data[i] === this.SLIP_ESC) {
        output.push(this.SLIP_ESC, this.SLIP_ESC_ESC)
      } else {
        output.push(data[i])
      }
    }
    output.push(this.SLIP_END)
    return new Uint8Array(output)
  }

  /** 启动后台数据读取 */
  _startReadLoop() {
    this.serialPort.on('data', (data) => {
      const newData = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      const combined = new Uint8Array(this.buffer.length + newData.length)
      combined.set(this.buffer)
      combined.set(newData, this.buffer.length)
      this.buffer = combined
    })
    this.serialPort.on('close', () => {
      if (this.onDeviceLostCallback) {
        this.onDeviceLostCallback()
      }
    })
    this.serialPort.on('error', (err) => {
      console.error('[NodeTransport] 错误:', err.message)
      if (this.onDeviceLostCallback) {
        this.onDeviceLostCallback()
      }
    })
  }

  /** 设置设备丢失回调 */
  setDeviceLostCallback(callback) {
    this.onDeviceLostCallback = callback
  }

  /** 设置 DTR 信号（用于芯片复位） */
  async setDTR(state) {
    this._DTR_state = state
    return new Promise((resolve, reject) => {
      if (!this.serialPort || !this.serialPort.isOpen) {
        reject(new Error('串口未打开'))
        return
      }
      this.serialPort.set({ dtr: state }, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  /** 设置 RTS 信号（用于芯片复位） */
  async setRTS(state) {
    return new Promise((resolve, reject) => {
      if (!this.serialPort || !this.serialPort.isOpen) {
        reject(new Error('串口未打开'))
        return
      }
      this.serialPort.set({ rts: state }, async (err) => {
        if (err) { reject(err); return }
        // 兼容 Windows usbser.sys 驱动：生成虚拟 DTR 变化
        try {
          await this.setDTR(this._DTR_state)
          resolve()
        } catch (e) {
          reject(e)
        }
      })
    })
  }

  /** 获取端口信息（ESPLoader 构造函数中调用） */
  getInfo() {
    return `Serial port ${this.portPath}`
  }

  /** 获取产品 ID（NodeTransport 不直接支持，返回 undefined） */
  getPid() {
    return undefined
  }

  /** 跟踪日志输出 */
  trace(message) {
    if (this.tracing) {
      console.log(`[NodeTransport TRACE] ${message}`)
    }
    this.traceLog = (this.traceLog || '') + message + '\n'
  }

  /** 十六进制格式化（用于跟踪日志） */
  hexConvert(uint8Array, autoSplit = true) {
    const hexify = (s) => Array.from(s)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .padEnd(16, ' ')
    if (autoSplit && uint8Array.length > 16) {
      let result = ''
      let s = uint8Array
      while (s.length > 0) {
        const line = s.slice(0, 16)
        const asciiLine = String.fromCharCode(...line)
          .split('')
          .map((c) => (c === ' ' || (c >= ' ' && c <= '~' && c !== '  ') ? c : '.'))
          .join('')
        s = s.slice(16)
        result += `\n    ${hexify(line.slice(0, 8))} ${hexify(line.slice(8))} | ${asciiLine}`
      }
      return result
    } else {
      return hexify(uint8Array)
    }
  }

  /** 启动后台读取循环（与 _startReadLoop 相同，兼容 esptool-js 接口） */
  readLoop() {
    // 已在 connect() 中调用 _startReadLoop()，无需重复
  }

  /** 检测 Guru Meditation / Fatal 错误 */
  detectPanicHandler(input) {
    const guruMeditationRegex = /G?uru Meditation Error: (?:Core \d panic'ed \(([a-zA-Z ]*)\))?/
    const fatalExceptionRegex = /F?atal exception \(\d+\): (?:([a-zA-Z ]*)?.*epc)?/
    const inputString = new TextDecoder('utf-8').decode(input)
    const match = inputString.match(guruMeditationRegex) || inputString.match(fatalExceptionRegex)
    if (match) {
      const cause = match[1] || match[2]
      const msg = `Guru Meditation Error detected${cause ? ` (${cause})` : ''}`
      throw new Error(msg)
    }
  }

  // 以下为兼容接口方法
  appendArray(arr1, arr2) {
    const combined = new Uint8Array(arr1.length + arr2.length)
    combined.set(arr1)
    combined.set(arr2, arr1.length)
    return combined
  }
  flushInput() { this.buffer = new Uint8Array(0) }
  inWaiting() { return this.buffer.length }
  peek() { return this.buffer }
}

/** 动态加载 esptool-js（使用 lib/index.js ESM 入口） */
let _esptoolModule = null
async function getESPLoader() {
  if (!_esptoolModule) {
    _esptoolModule = await import('./node_modules/esptool-js/lib/index.js')
  }
  return _esptoolModule.ESPLoader
}

/** 向固件窗口发送日志 */
function firmwareLog(msg) {
  console.log('[FIRMWARE] ' + msg)
  if (firmwareWindow && !firmwareWindow.isDestroyed()) {
    firmwareWindow.webContents.send('firmware:log', msg)
  }
}

/** 向固件窗口发送进度 */
function firmwareProgress(percent, message) {
  if (firmwareWindow && !firmwareWindow.isDestroyed()) {
    firmwareWindow.webContents.send('firmware:progress', { percent, message })
  }
}

/** 向固件窗口发送完成状态 */
function firmwareComplete(success, error) {
  if (firmwareWindow && !firmwareWindow.isDestroyed()) {
    firmwareWindow.webContents.send('firmware:complete', { success, error })
  }
}

/** 固件 IPC：列出可用串口 */
ipcMain.handle('firmware:list-ports', async () => {
  return await listPorts()
})

/** 固件 IPC：开始烧录 */
ipcMain.handle('firmware:start-flash', async (event, { portPath, fileArray, baudRate }) => {
  firmwareAborted = false

  let transport = null
  let esploader = null

  // 添加总超时（30秒），防止卡死
  const TIMEOUT_DURATION = 30000
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('操作超时（30秒）')), TIMEOUT_DURATION)
  })

  try {
    firmwareLog('准备烧录...')
    firmwareProgress(0, '准备中')

    // 解析文件数据
    firmwareLog('正在读取固件文件...')
    const fileDataArray = []
    for (let i = 0; i < fileArray.length; i++) {
      const part = fileArray[i]
      const partName = part.firmwareFile.split(/[/\\]/).pop()
      const buf = fs.readFileSync(part.firmwareFile)
      fileDataArray.push({
        data: new Uint8Array(buf),
        address: parseInt(part.address, 16)
      })
      firmwareLog(`已加载: ${partName} -> ${part.address} (${buf.length} 字节)`)
    }

    if (firmwareAborted) throw new Error('操作已中止')

    // 创建 Transport + ESPLoader
    firmwareLog('创建 Transport 对象...')
    transport = new NodeTransport(portPath)
    transport.tracing = true
    firmwareLog('Transport 对象创建成功')

    const ESPLoader = await getESPLoader()
    firmwareLog('创建 ESPLoader 对象...')
    esploader = new ESPLoader({
      transport: transport,
      baudrate: baudRate || 115200,
      terminal: {
        clean: () => {},
        writeLine: (data) => firmwareLog(data),
        write: (data) => firmwareLog(data)
      },
      debugLogging: true
    })
    firmwareLog('ESPLoader 对象创建成功')

    // 连接芯片（加入超时保护）
    firmwareLog('正在连接芯片...')
    firmwareProgress(5, '连接芯片...')
    const chipName = await Promise.race([
      esploader.main(),
      timeoutPromise
    ])
    firmwareLog(`检测到芯片: ${chipName}`)

    if (firmwareAborted) throw new Error('操作已中止')

    // 烧录固件
    firmwareLog('开始烧录固件...')
    firmwareProgress(10, '正在烧录...')
    await Promise.race([
      esploader.writeFlash({
        fileArray: fileDataArray,
        flashMode: 'dio',
        flashFreq: '80m',
        flashSize: '4MB',
        eraseAll: false,
        compress: true,
        reportProgress: (fileIndex, written, total) => {
          if (firmwareAborted) throw new Error('操作已中止')
          const fileProgress = (written / total) * 100
          const totalProgress = ((fileIndex + fileProgress / 100) / fileDataArray.length) * 100
          firmwareProgress(Math.min(totalProgress, 100), `烧录中... ${Math.floor(totalProgress)}%`)
        }
      }),
      timeoutPromise
    ])

    if (firmwareAborted) throw new Error('操作已中止')

    // 复位设备
    firmwareLog('正在复位设备...')
    firmwareProgress(95, '复位中...')
    await esploader.after('hard_reset')

    firmwareProgress(100, '烧录完成')
    firmwareLog('烧录完成！')
    firmwareComplete(true)
  } catch (err) {
    if (err.message === '操作已中止' || firmwareAborted) {
      firmwareLog('操作已手动停止')
    } else {
      firmwareLog(`错误: ${err.message}`)
      console.error('[FIRMWARE] 烧录失败:', err)
    }
    firmwareComplete(false, firmwareAborted ? '操作已中止' : err.message)
  } finally {
    if (esploader) {
      try { await esploader.close() } catch (e) { /* ignore */ }
    }
    if (transport) {
      try { await transport.disconnect() } catch (e) { /* ignore */ }
    }
  }
})

/** 固件 IPC：擦除 Flash */
ipcMain.handle('firmware:erase-flash', async (event, { portPath, baudRate }) => {
  firmwareAborted = false

  let transport = null
  let esploader = null

  try {
    firmwareLog('开始擦除 Flash...')
    firmwareProgress(0, '擦除中')

    transport = new NodeTransport(portPath)
    const ESPLoader = await getESPLoader()
    esploader = new ESPLoader({
      transport: transport,
      baudrate: baudRate || 115200,
      terminal: {
        clean: () => {},
        writeLine: (data) => firmwareLog(data),
        write: (data) => firmwareLog(data)
      },
      debugLogging: true
    })

    firmwareLog('正在连接芯片...')
    await esploader.main()
    firmwareLog('芯片连接成功')

    if (firmwareAborted) throw new Error('操作已中止')

    firmwareLog('正在擦除 Flash...')
    await esploader.eraseFlash()
    firmwareLog('擦除完成')

    firmwareLog('正在复位设备...')
    await esploader.after('hard_reset')
    firmwareLog('复位完成')

    firmwareComplete(true)
  } catch (err) {
    if (err.message === '操作已中止' || firmwareAborted) {
      firmwareLog('操作已手动停止')
    } else {
      firmwareLog(`错误: ${err.message}`)
      console.error('[FIRMWARE] 擦除失败:', err)
    }
    firmwareComplete(false, firmwareAborted ? '操作已中止' : err.message)
  } finally {
    if (esploader) {
      try { await esploader.close() } catch (e) { /* ignore */ }
    }
    if (transport) {
      try { await transport.disconnect() } catch (e) { /* ignore */ }
    }
  }
})

/** 固件 IPC：停止操作 */
ipcMain.handle('firmware:stop', async () => {
  firmwareAborted = true
  return { success: true }
})
