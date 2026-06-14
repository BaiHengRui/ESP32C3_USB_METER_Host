const { app, BrowserWindow, ipcMain, dialog, screen, Menu, nativeTheme } = require('electron')
const path = require('path')
const fs = require('fs')
const { SerialPort } = require('serialport')

// 应用信息
const APP_NAME = 'ESP32C3-METER 上位机'
const APP_VERSION = '1.1.4'

// 获取编译时间（使用main.js文件的修改时间，GMT+8）
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
let serialPort = null
let isReading = false
let dataBuffer = Buffer.alloc(0)
let lastPort = ''
let lastBaudRate = 921600

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

// 获取可用串口列表
async function listPorts() {
  try {
    const ports = await SerialPort.list()
    return ports.map(port => ({
      path: port.path,
      manufacturer: port.manufacturer,
      pnpId: port.pnpId,
      productId: port.productId,
      vendorId: port.vendorId
    }))
  } catch (err) {
    console.error('获取串口列表失败:', err)
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

  // 查找换行符（文本模式）
  let newlineIndex
  while ((newlineIndex = dataBuffer.indexOf('\n')) !== -1) {
    const lineBuffer = dataBuffer.slice(0, newlineIndex)
    dataBuffer = dataBuffer.slice(newlineIndex + 1)

    // 检查是否为有效文本（过滤二进制数据）
    if (isValidText(lineBuffer)) {
      const line = lineBuffer.toString('utf8')
      // 发送文本数据到渲染进程
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial-data', line)
      }
    }
  }

  // 检查是否有完整的 64 字节数据包（二进制模式）
  while (dataBuffer.length >= USB_CDC_DATA_SIZE) {
    // 检查是否是二进制数据包（以 0xAA 开头）
    if (dataBuffer[0] === 0xAA) {
      const packet = dataBuffer.slice(0, USB_CDC_DATA_SIZE)
      dataBuffer = dataBuffer.slice(USB_CDC_DATA_SIZE)

      const parsedData = parseUSBCDCData(packet)
      if (parsedData) {
        // 发送解析后的数据到渲染进程
        if (curveWindow && !curveWindow.isDestroyed()) {
          curveWindow.webContents.send('meter-data', parsedData)
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('meter-data', parsedData)
        }
      }
    } else {
      // 不是二进制数据包，丢弃一个字节
      dataBuffer = dataBuffer.slice(1)
    }
  }

  // 防止缓冲区过大
  if (dataBuffer.length > 1024) {
    dataBuffer = dataBuffer.slice(-512)
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

ipcMain.handle('open-curve-window', async () => {
  createCurveWindow()
  return { success: true }
})

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
      label: '曲线',
      submenu: [
        {
          label: '打开曲线界面',
          accelerator: 'CmdOrCtrl+M',
          click: () => {
            createCurveWindow()
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
