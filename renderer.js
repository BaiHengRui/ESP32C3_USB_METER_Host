// ESP32-METER 上位机 - 渲染进程
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

  // 阈值设置
  thrStartV: document.getElementById('thrStartV'),
  thrStartVMinus: document.getElementById('thrStartVMinus'),
  thrStartVPlus: document.getElementById('thrStartVPlus'),
  thrStartI: document.getElementById('thrStartI'),
  thrStartIMinus: document.getElementById('thrStartIMinus'),
  thrStartIPlus: document.getElementById('thrStartIPlus'),
  setStartBtn: document.getElementById('setStartBtn'),
  thrEndV: document.getElementById('thrEndV'),
  thrEndVMinus: document.getElementById('thrEndVMinus'),
  thrEndVPlus: document.getElementById('thrEndVPlus'),
  thrEndI: document.getElementById('thrEndI'),
  thrEndIMinus: document.getElementById('thrEndIMinus'),
  thrEndIPlus: document.getElementById('thrEndIPlus'),
  setEndBtn: document.getElementById('setEndBtn'),
  queryThresholdBtn: document.getElementById('queryThresholdBtn'),

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

  // 阈值设置
  elements.setStartBtn.addEventListener('click', setStartThreshold)
  elements.setEndBtn.addEventListener('click', setEndThreshold)
  elements.queryThresholdBtn.addEventListener('click', () => sendCommand('threshold'))

  // 阈值 +/- 按钮
  setupThresholdStepper('thrStartV', 100)
  setupThresholdStepper('thrStartI', 10)
  setupThresholdStepper('thrEndV', 100)
  setupThresholdStepper('thrEndI', 10)

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

  // ========== 应用更新事件 ==========
  window.electronAPI.onUpdateAvailable((info) => {
    showUpdatePanel(info)
  })

  window.electronAPI.onUpdateProgress((progress) => {
    updateProgressUI(progress)
  })

  window.electronAPI.onUpdateComplete((info) => {
    showUpdateComplete(info)
  })

  window.electronAPI.onUpdateError((error) => {
    showUpdateError(error)
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

// 阈值步进按钮通用绑定(name不含后缀, step步长)
function setupThresholdStepper(name, step) {
  const input = elements[name]
  const minus = elements[name + 'Minus']
  const plus = elements[name + 'Plus']
  if (!input || !minus || !plus) return
  minus.addEventListener('click', () => {
    const v = Math.max(0, (parseInt(input.value) || 0) - step)
    input.value = v
  })
  plus.addEventListener('click', () => {
    const v = (parseInt(input.value) || 0) + step
    input.value = v
  })
}

// 设置起始阈值
async function setStartThreshold() {
  const v = elements.thrStartV.value || '0'
  const i = elements.thrStartI.value || '0'
  await sendCommand(`set_start=${v},${i}`)
}

// 设置结束阈值
async function setEndThreshold() {
  const v = elements.thrEndV.value || '0'
  const i = elements.thrEndI.value || '0'
  await sendCommand(`set_end=${v},${i}`)
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

// =============================================
//  应用更新 UI 逻辑
// =============================================

const updateUI = {
  overlay: document.getElementById('updateOverlay'),
  modal: document.getElementById('updateModal'),
  stateInfo: document.getElementById('updateStateInfo'),
  stateProgress: document.getElementById('updateStateProgress'),
  stateComplete: document.getElementById('updateStateComplete'),

  closeBtn: document.getElementById('updateCloseBtn'),
  downloadBtn: document.getElementById('updateDownloadBtn'),
  dismissBtn: document.getElementById('updateDismissBtn'),
  viewReleaseBtn: document.getElementById('updateViewReleaseBtn'),
  cancelBtn: document.getElementById('updateCancelBtn'),

  newVersion: document.getElementById('updateNewVersion'),
  currentVersion: document.getElementById('updateCurrentVersion'),
  assetInfo: document.getElementById('updateAssetInfo'),
  changelog: document.getElementById('updateChangelog'),
  progressFill: document.getElementById('updateProgressFill'),
  percent: document.getElementById('updatePercent'),
  speed: document.getElementById('updateSpeed'),
  remaining: document.getElementById('updateRemaining'),
  sizeInfo: document.getElementById('updateSizeInfo'),
  progressTitle: document.getElementById('updateProgressTitle'),
  completeTitle: document.getElementById('updateCompleteTitle'),
  completeSub: document.getElementById('updateCompleteSub'),
  completeActions: document.getElementById('updateCompleteActions')
}

let updateDownloading = false

// 简单的 Markdown → HTML 转换（支持 GitHub Release 格式）
function markdownToHTML(md) {
  if (!md) return '<p>暂无更新日志</p>'

  let html = md
    // 转义 HTML
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // 粗体
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // 行内代码
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // 链接
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    // 分割线
    .replace(/^---+/gm, '<hr>')
    // ### 标题
    .replace(/^###\s+(.+)$/gm, '<h4>$1</h4>')
    // ## 标题
    .replace(/^##\s+(.+)$/gm, '<h3>$1</h3>')
    // 无序列表项
    .replace(/^[\s]*[-*]\s+(.+)$/gm, '<li>$1</li>')
    // 换行处理
    .replace(/\r\n/g, '\n')

  // 包裹连续的 <li>
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, (match) => {
    if (!match.includes('\n\n') && !match.includes('<h') && !match.includes('<hr')) {
      return '<ul>' + match + '</ul>'
    }
    return match
  })

  // 段落：连续两个换行
  html = html.replace(/\n\n+/g, '</p><p>')
  html = '<p>' + html + '</p>'
  // 清理空段落和多余标签
  html = html.replace(/<p>\s*<\/p>/g, '')
  html = html.replace(/<p>(<h[34]>)/g, '$1')
  html = html.replace(/(<\/h[34]>)<\/p>/g, '$1')
  html = html.replace(/<p>(<ul>)/g, '$1')
  html = html.replace(/(<\/ul>)<\/p>/g, '$1')
  html = html.replace(/<p>(<hr>)<\/p>/g, '$1')

  return html
}

function showOverlay() {
  updateUI.overlay.style.display = 'flex'
}

function hideOverlay() {
  if (updateDownloading) return
  updateUI.overlay.style.display = 'none'
}

function showUpdatePanel(info) {
  if (updateDownloading) return

  updateUI.newVersion.textContent = `v${info.version}`
  updateUI.currentVersion.textContent = info.currentVersion || '--'
  updateUI.assetInfo.textContent = `${info.assetName} · ${info.assetSize}`
  updateUI.changelog.innerHTML = markdownToHTML(info.body)

  updateUI.stateInfo.style.display = 'flex'
  updateUI.stateProgress.style.display = 'none'
  updateUI.stateComplete.style.display = 'none'
  updateUI.closeBtn.style.display = 'block'
  showOverlay()

  updateUI.downloadBtn.onclick = async () => {
    updateDownloading = true
    updateUI.closeBtn.style.display = 'none'
    showProgressState()
    await window.electronAPI.startUpdate()
  }
  updateUI.dismissBtn.onclick = hideOverlay
  updateUI.viewReleaseBtn.onclick = () => {
    window.electronAPI.openReleasePage()
  }
  updateUI.cancelBtn.onclick = async () => {
    await window.electronAPI.cancelUpdate()
    updateDownloading = false
    updateUI.closeBtn.style.display = 'block'
    hideOverlay()
  }
  // 关闭按钮
  updateUI.closeBtn.onclick = hideOverlay
  // 点击遮罩关闭
  updateUI.overlay.onclick = (e) => {
    if (e.target === updateUI.overlay) hideOverlay()
  }
}

function showProgressState() {
  updateUI.stateInfo.style.display = 'none'
  updateUI.stateProgress.style.display = 'flex'
  updateUI.stateComplete.style.display = 'none'

  updateUI.progressTitle.textContent = '正在下载更新...'
  updateUI.percent.textContent = '0%'
  updateUI.progressFill.style.width = '0%'
  updateUI.speed.textContent = '正在连接...'
  updateUI.remaining.textContent = ''
  updateUI.sizeInfo.textContent = ''
}

function updateProgressUI(progress) {
  updateUI.stateInfo.style.display = 'none'
  updateUI.stateProgress.style.display = 'flex'
  updateUI.stateComplete.style.display = 'none'

  if (progress.status === 'processing') {
    updateUI.progressTitle.textContent = '正在处理更新包...'
    updateUI.speed.textContent = '正在解压...'
    updateUI.remaining.textContent = ''
    return
  }

  if (progress.status === 'retry') {
    updateUI.progressTitle.textContent = '正在下载更新...'
    updateUI.progressFill.style.width = '0%'
    updateUI.percent.textContent = '0%'
    updateUI.speed.textContent = progress.speed || '切换下载源...'
    updateUI.remaining.textContent = ''
    updateUI.sizeInfo.textContent = ''
    return
  }

  updateUI.percent.textContent = `${progress.percent}%`
  updateUI.progressFill.style.width = `${progress.percent}%`
  updateUI.speed.textContent = progress.speed || '--'
  updateUI.remaining.textContent = progress.remaining ? `剩余 ${progress.remaining}` : ''

  if (progress.downloadedStr && progress.totalStr) {
    updateUI.sizeInfo.textContent = `${progress.downloadedStr} / ${progress.totalStr}`
  }
}

function showUpdateComplete(info) {
  updateDownloading = false
  updateUI.closeBtn.style.display = 'block'
  updateUI.stateInfo.style.display = 'none'
  updateUI.stateProgress.style.display = 'none'
  updateUI.stateComplete.style.display = 'flex'

  if (info.appFormat === 'unpacked' || info.scriptFile) {
    updateUI.completeTitle.textContent = '更新已准备就绪！'
    updateUI.completeSub.textContent = '点击「立即重启」将关闭当前程序并自动完成更新。'
    updateUI.completeActions.innerHTML = `
      <button id="updateRestartBtn" class="update-btn update-btn-success">立即重启</button>
      <button id="updateLaterBtn" class="update-btn update-btn-ghost">稍后</button>
    `
    document.getElementById('updateRestartBtn').onclick = () => {
      window.electronAPI.restartApp()
    }
    document.getElementById('updateLaterBtn').onclick = hideOverlay
  } else {
    updateUI.completeTitle.textContent = '下载完成！'
    updateUI.completeSub.textContent = `新版本已保存到:\n${info.filePath}`
    updateUI.completeActions.innerHTML = `
      <button id="updateOpenFolderBtn" class="update-btn update-btn-primary">打开文件夹</button>
      <button id="updateGotItBtn" class="update-btn update-btn-ghost">知道了</button>
    `
    document.getElementById('updateOpenFolderBtn').onclick = () => {
      window.electronAPI.openUpdateFolder(info.filePath)
    }
    document.getElementById('updateGotItBtn').onclick = hideOverlay
  }
}

function showUpdateError(error) {
  updateDownloading = false
  updateUI.closeBtn.style.display = 'block'
  updateUI.stateInfo.style.display = 'flex'
  updateUI.stateProgress.style.display = 'none'
  updateUI.stateComplete.style.display = 'none'

  if (error.message === '下载已取消') {
    hideOverlay()
    return
  }

  updateUI.newVersion.textContent = '更新失败'
  updateUI.changelog.innerHTML = markdownToHTML(error.message || '未知错误')
  updateUI.downloadBtn.textContent = '重试'
  updateUI.downloadBtn.className = 'update-btn update-btn-primary'
  updateUI.dismissBtn.textContent = '关闭'
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
