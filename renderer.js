// ESP32C3-METER 上位机 - 渲染进程
// 主窗口逻辑

// 状态变量
let isConnected = false
let logLines = []

// DOM 元素
const elements = {
  // 串口设置
  portSelect: document.getElementById('portSelect'),
  baudSelect: document.getElementById('baudSelect'),
  togglePortBtn: document.getElementById('togglePortBtn'),
  refreshPortsBtn: document.getElementById('refreshPortsBtn'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),

  // 控制区域
  brightnessRange: document.getElementById('brightnessRange'),
  brightnessInput: document.getElementById('brightnessInput'),
  brightnessMinus: document.getElementById('brightnessMinus'),
  brightnessPlus: document.getElementById('brightnessPlus'),
  setBrightnessBtn: document.getElementById('setBrightnessBtn'),
  rotationSelect: document.getElementById('rotationSelect'),
  setRotationBtn: document.getElementById('setRotationBtn'),
  sampleRateSelect: document.getElementById('sampleRateSelect'),
  setSampleRateBtn: document.getElementById('setSampleRateBtn'),

  // 常用命令
  queryInfoBtn: document.getElementById('queryInfoBtn'),
  helpBtn: document.getElementById('helpBtn'),
  resetDefaultsBtn: document.getElementById('resetDefaultsBtn'),
  openFirmwareBtn: document.getElementById('openFirmwareBtn'),
  openCurveBtn: document.getElementById('openCurveBtn'),

  // 自定义命令
  customCmdInput: document.getElementById('customCmdInput'),
  sendCustomBtn: document.getElementById('sendCustomBtn'),

  // 日志
  logArea: document.getElementById('logArea'),
  autoScrollCheck: document.getElementById('autoScrollCheck'),
  clearLogBtn: document.getElementById('clearLogBtn'),
  saveLogBtn: document.getElementById('saveLogBtn')
}

// 初始化
async function init() {
  await refreshPorts()
  setupEventListeners()
  setupIPCListeners()
  initTheme()
  await restoreLastSerialSettings()
}

// 恢复上次串口设置
async function restoreLastSerialSettings() {
  try {
    const lastPort = await window.electronAPI.getLastPort()
    const lastBaudRate = await window.electronAPI.getLastBaudRate()
    
    if (lastPort) {
      // 查找并选择上次的串口
      const portOption = Array.from(elements.portSelect.options).find(opt => opt.value === lastPort)
      if (portOption) {
        elements.portSelect.value = lastPort
      }
    }
    
    if (lastBaudRate) {
      const baudOption = Array.from(elements.baudSelect.options).find(opt => opt.value === String(lastBaudRate))
      if (baudOption) {
        elements.baudSelect.value = String(lastBaudRate)
      }
    }
  } catch (err) {
    console.error('恢复串口设置失败:', err)
  }
}

// 初始化主题
async function initTheme() {
  const theme = await window.electronAPI.getTheme()
  applyTheme(theme)

  // 监听主题变化
  window.electronAPI.onThemeChanged((theme) => {
    applyTheme(theme)
  })
}

// 应用主题
function applyTheme(theme) {
  document.body.classList.remove('theme-light', 'theme-dark')
  document.body.classList.add(`theme-${theme}`)
}

// 刷新端口列表
async function refreshPorts() {
  try {
    const ports = await window.electronAPI.listPorts()
    console.log('获取到的串口列表:', ports)
    elements.portSelect.innerHTML = '<option value="">选择端口...</option>'

    ports.forEach(port => {
      const option = document.createElement('option')
      option.value = port.path
      // 标识虚拟串口
      const virtualTag = port.isVirtual ? ' [虚拟]' : ' [物理]'
      const manufacturer = port.manufacturer ? ` (${port.manufacturer})` : ''
      option.textContent = port.path + manufacturer + virtualTag
      console.log('串口:', port.path, 'isVirtual:', port.isVirtual, '显示:', option.textContent)
      elements.portSelect.appendChild(option)
    })

    if (ports.length > 0 && !elements.portSelect.value) {
      elements.portSelect.value = ports[0].path
    }
  } catch (err) {
    console.error('刷新端口失败:', err)
  }
}

// 设置事件监听
function setupEventListeners() {
  // 刷新端口
  elements.refreshPortsBtn.addEventListener('click', refreshPorts)

  // 打开/关闭串口
  elements.togglePortBtn.addEventListener('click', togglePort)

  // 亮度同步
  elements.brightnessRange.addEventListener('input', () => {
    elements.brightnessInput.value = elements.brightnessRange.value
  })
  elements.brightnessInput.addEventListener('input', () => {
    const val = Math.max(1, Math.min(100, parseInt(elements.brightnessInput.value) || 50))
    elements.brightnessRange.value = val
  })
  elements.brightnessMinus.addEventListener('click', () => {
    const val = Math.max(1, parseInt(elements.brightnessInput.value) - 1)
    elements.brightnessInput.value = val
    elements.brightnessRange.value = val
  })
  elements.brightnessPlus.addEventListener('click', () => {
    const val = Math.min(100, parseInt(elements.brightnessInput.value) + 1)
    elements.brightnessInput.value = val
    elements.brightnessRange.value = val
  })
  elements.setBrightnessBtn.addEventListener('click', setBrightness)

  // 屏幕方向
  elements.setRotationBtn.addEventListener('click', setRotation)

  // 采样率
  elements.setSampleRateBtn.addEventListener('click', setSampleRate)

  // 常用命令
  elements.queryInfoBtn.addEventListener('click', () => sendCommand('info'))
  elements.helpBtn.addEventListener('click', () => sendCommand('help'))
  elements.resetDefaultsBtn.addEventListener('click', resetDefaults)
  elements.openFirmwareBtn.addEventListener('click', openFirmwareWindow)
  elements.openCurveBtn.addEventListener('click', openCurveWindow)

  // 自定义命令
  elements.sendCustomBtn.addEventListener('click', sendCustomCommand)
  elements.customCmdInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendCustomCommand()
  })

  // 日志
  elements.clearLogBtn.addEventListener('click', clearLog)
  elements.saveLogBtn.addEventListener('click', saveSerialLog)
}

// 设置 IPC 监听
function setupIPCListeners() {
  // 串口数据
  window.electronAPI.onSerialData((data) => {
    appendLog(`接收: ${data}`, 'recv')
  })

  // 串口错误
  window.electronAPI.onSerialError((error) => {
    appendLog(`[错误] ${error}`, 'error')
    updateConnectionStatus(false)
  })

  // 串口关闭
  window.electronAPI.onSerialClosed(() => {
    updateConnectionStatus(false)
  })

  // 菜单事件
  window.electronAPI.onMenuSaveLog(() => {
    exportOperationLog()
  })

  window.electronAPI.onMenuRefreshPorts(() => {
    refreshPorts()
  })
}

// 切换串口状态
async function togglePort() {
  if (isConnected) {
    await closePort()
  } else {
    await openPort()
  }
}

// 打开串口
async function openPort() {
  const port = elements.portSelect.value
  if (!port) {
    alert('请选择串口端口！')
    return
  }

  const baudRate = parseInt(elements.baudSelect.value)

  try {
    const result = await window.electronAPI.openPort(port, baudRate)
    if (result.success) {
      updateConnectionStatus(true)
      appendLog(`[系统] 已连接到 ${port} @ ${baudRate}`, 'system')
    } else {
      alert(`无法打开串口: ${result.error}`)
    }
  } catch (err) {
    alert(`打开串口失败: ${err.message}`)
  }
}

// 关闭串口
async function closePort() {
  try {
    await window.electronAPI.closePort()
    updateConnectionStatus(false)
    appendLog('[系统] 串口已关闭', 'system')
  } catch (err) {
    console.error('关闭串口失败:', err)
  }
}

// 更新连接状态
function updateConnectionStatus(connected) {
  isConnected = connected
  elements.statusDot.classList.toggle('connected', connected)
  elements.statusText.textContent = connected ? '已连接' : '未连接'
  elements.togglePortBtn.textContent = connected ? '关闭串口' : '打开串口'
  elements.togglePortBtn.className = connected ? 'btn btn-danger' : 'btn btn-success'
}

// 发送命令
async function sendCommand(cmd) {
  if (!isConnected) {
    alert('请先打开串口！')
    return
  }

  try {
    const result = await window.electronAPI.sendCommand(cmd)
    if (result.success) {
      appendLog(`发送: ${cmd}`, 'send')
    } else {
      appendLog(`发送失败: ${result.error}`, 'error')
    }
  } catch (err) {
    appendLog(`发送命令失败: ${err.message}`, 'error')
  }
}

// 设置亮度
async function setBrightness() {
  const value = parseInt(elements.brightnessInput.value)
  if (value < 1 || value > 100) {
    alert('请输入 1-100 之间的亮度值')
    return
  }
  await sendCommand(`brightness:${value}`)
}

// 设置屏幕方向
async function setRotation() {
  const value = elements.rotationSelect.value
  await sendCommand(`rotation:${value}`)
}

// 设置采样率
async function setSampleRate() {
  const value = elements.sampleRateSelect.value
  await sendCommand(`sample:${value}`)
}

// 恢复默认设置
async function resetDefaults() {
  if (!isConnected) {
    alert('请先打开串口！')
    return
  }

  elements.brightnessRange.value = 50
  elements.brightnessInput.value = 50
  elements.rotationSelect.value = '3'
  elements.sampleRateSelect.value = '1'

  await sendCommand('brightness:50')
  await sendCommand('rotation:3')
  await sendCommand('sample:1')

  alert('已恢复默认设置')
}

// 打开曲线窗口
async function openCurveWindow() {
  await window.electronAPI.openCurveWindow()
}

// 打开固件更新窗口
async function openFirmwareWindow() {
  await window.electronAPI.openFirmwareWindow()
}

// 发送自定义命令
async function sendCustomCommand() {
  const cmd = elements.customCmdInput.value.trim()
  if (cmd) {
    await sendCommand(cmd)
    elements.customCmdInput.value = ''
  }
}

// 追加日志
function appendLog(text, type = 'recv') {
  const timestamp = new Date().toLocaleTimeString()
  const line = `[${timestamp}] ${text}`
  logLines.push(line)

  // 创建日志行元素
  const logLine = document.createElement('div')
  logLine.className = `log-line log-${type}`
  logLine.textContent = line

  elements.logArea.appendChild(logLine)

  if (elements.autoScrollCheck.checked) {
    elements.logArea.scrollTop = elements.logArea.scrollHeight
  }
}

// 清空日志
function clearLog() {
  elements.logArea.innerHTML = ''
  logLines = []
}

// 保存串口内容为文件
async function saveSerialLog() {
  if (logLines.length === 0) {
    alert('串口日志为空，无需保存。')
    return
  }

  const now = new Date()
  const defaultName = `serial_log_${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}.txt`

  const result = await window.electronAPI.saveDialog(defaultName, [
    { name: 'Text Files', extensions: ['txt'] },
    { name: 'All Files', extensions: ['*'] }
  ])

  if (result.filePath) {
    const saveResult = await window.electronAPI.saveLogFile(result.filePath, logLines.join('\n'))
    if (saveResult.success) {
      alert(`串口日志已保存至:\n${result.filePath}`)
    } else {
      alert(`保存失败: ${saveResult.error}`)
    }
  }
}

// 导出操作日志
async function exportOperationLog() {
  const logs = await window.electronAPI.getOperationLogs()
  
  if (logs.length === 0) {
    alert('操作日志为空。')
    return
  }

  const now = new Date()
  const defaultName = `operation_log_${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}.txt`

  const result = await window.electronAPI.saveDialog(defaultName, [
    { name: 'Text Files', extensions: ['txt'] },
    { name: 'All Files', extensions: ['*'] }
  ])

  if (result.filePath) {
    const exportResult = await window.electronAPI.exportOperationLog(result.filePath)
    if (exportResult.success) {
      alert(`操作日志已保存至:\n${result.filePath}`)
    } else {
      alert(`保存失败: ${exportResult.error}`)
    }
  }
}

// 启动应用
init()
