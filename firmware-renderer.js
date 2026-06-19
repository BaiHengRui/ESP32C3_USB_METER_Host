// 固件更新窗口渲染进程
// 通过 IPC 调用主进程进行烧录（使用 serialport + esptool-js）

// 状态变量
let isFlashing = false
let firmwareLogCleanup = null
let firmwareProgressCleanup = null
let firmwareCompleteCleanup = null
// 端口信息映射表，存储每个端口的 VID/PID，用于 USB-JTAG 设备识别
const portInfoMap = new Map()

// DOM 元素
let elements

// 全局错误处理
window.addEventListener('error', (e) => {
  console.error('[FIRMWARE] 未捕获的错误:', e.error)
  if (typeof appendLog === 'function') {
    appendLog(`未捕获的错误: ${e.error ? e.error.message : e.error}`)
  }
})

window.addEventListener('unhandledrejection', (e) => {
  console.error('[FIRMWARE] 未处理的 Promise 拒绝:', e.reason)
  if (typeof appendLog === 'function') {
    appendLog(`未处理的 Promise 拒绝: ${e.reason ? e.reason.message : e.reason}`)
  }
})

// 获取 DOM 元素
function getElements() {
  return {
    portSelect: document.getElementById('portSelect'),
    refreshPortsBtn: document.getElementById('refreshPortsBtn'),
    partitionTableBody: document.getElementById('partitionTableBody'),
    addRowBtn: document.getElementById('addRowBtn'),
    progressFill: document.getElementById('progressFill'),
    progressPercent: document.getElementById('progressPercent'),
    progressText: document.getElementById('progressText'),
    eraseBtn: document.getElementById('eraseBtn'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    logArea: document.getElementById('logArea')
  }
}

// 添加日志
function appendLog(log) {
  const timestamp = new Date().toLocaleTimeString()
  const logArea = document.getElementById('logArea')
  if (logArea) {
    logArea.value += `[${timestamp}] ${log}\n`
    logArea.scrollTop = logArea.scrollHeight
  }
  console.log(`[FIRMWARE] ${log}`)
}

// 初始化
async function init() {
  elements = getElements()

  appendLog('初始化开始...')
  appendLog('Electron API 可用: ' + !!window.electronAPI)

  // 注册固件事件监听
  firmwareLogCleanup = window.electronAPI.onFirmwareLog((msg) => {
    appendLog(msg)
  })
  firmwareProgressCleanup = window.electronAPI.onFirmwareProgress((data) => {
    if (elements) {
      const percent = data.percent || 0
      elements.progressFill.style.width = `${percent}%`
      elements.progressPercent.textContent = `${Math.floor(percent)}%`
      elements.progressText.textContent = data.message || ''
    }
  })
  firmwareCompleteCleanup = window.electronAPI.onFirmwareComplete((data) => {
    setFlashingUI(false)
    if (data.success) {
      appendLog('操作成功完成！')
    } else {
      appendLog(`操作失败: ${data.error || '未知错误'}`)
    }
  })

  setupEventListeners()
  initTheme()
  bindBrowseButtons()

  // 自动刷新端口列表
  await refreshPorts()

  appendLog('初始化完成')
}

// 初始化主题
async function initTheme() {
  try {
    const theme = await window.electronAPI.getTheme()
    applyTheme(theme)
    window.electronAPI.onThemeChanged((theme) => {
      applyTheme(theme)
    })
  } catch (e) {
    appendLog('主题初始化失败: ' + e.message)
  }
}

// 应用主题
function applyTheme(theme) {
  document.body.classList.remove('theme-light', 'theme-dark')
  document.body.classList.add(`theme-${theme}`)
}

// 刷新端口列表
async function refreshPorts() {
  try {
    appendLog('开始刷新端口...')

    elements.portSelect.innerHTML = '<option value="">选择端口...</option>'

    // 清空端口信息映射
    portInfoMap.clear()

    // 通过主进程获取端口列表
    const systemPorts = await window.electronAPI.firmwareListPorts()
    appendLog('系统端口数量: ' + systemPorts.length)

    if (systemPorts.length === 0) {
      appendLog('未检测到串口设备')
      return
    }

    // 填充下拉框
    for (const port of systemPorts) {
      const option = document.createElement('option')
      option.value = port.path

      let displayText = port.path
      if (port.manufacturer) {
        displayText += ` (${port.manufacturer})`
      }
      if (port.vendorId && port.productId) {
        const vid = port.vendorId.toLowerCase().padStart(4, '0')
        const pid = port.productId.toLowerCase().padStart(4, '0')
        displayText += ` [${vid}:${pid}]`
      }
      option.textContent = displayText
      elements.portSelect.appendChild(option)

      // 存储端口 VID/PID 信息，用于 USB-JTAG 识别
      portInfoMap.set(port.path, {
        vendorId: port.vendorId ? parseInt(port.vendorId, 16) : 0,
        productId: port.productId ? parseInt(port.productId, 16) : 0
      })
    }

    appendLog('端口刷新完成，共 ' + systemPorts.length + ' 个端口')

    if (systemPorts.length > 0) {
      elements.portSelect.selectedIndex = 1
      appendLog('自动选择端口: ' + elements.portSelect.value)
    }
  } catch (err) {
    console.error('获取串口列表失败:', err)
    appendLog(`获取串口列表失败: ${err.message}`)
  }
}

// 设置事件监听
function setupEventListeners() {
  elements.refreshPortsBtn.addEventListener('click', refreshPorts)
  elements.addRowBtn.addEventListener('click', () => addPartitionRow())
  elements.startBtn.addEventListener('click', startFlashing)
  elements.stopBtn.addEventListener('click', stopFlashing)
  elements.eraseBtn.addEventListener('click', eraseFlash)

  appendLog('事件监听器已设置')
}

// 为所有浏览按钮绑定事件
function bindBrowseButtons() {
  const browseButtons = elements.partitionTableBody.querySelectorAll('.btn-browse-fw')
  browseButtons.forEach(btn => {
    const newBtn = btn.cloneNode(true)
    btn.parentNode.replaceChild(newBtn, btn)
    newBtn.addEventListener('click', function () {
      browseFirmware(this)
    })
  })
  appendLog('浏览按钮已绑定')
}

// 浏览固件文件
async function browseFirmware(button) {
  try {
    const result = await window.electronAPI.openFirmwareDialog()
    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
      const row = button.closest('tr')
      const fileInput = row.querySelector('.firmware-file')
      fileInput.value = result.filePaths[0]
      appendLog('已选择文件: ' + result.filePaths[0])
    }
  } catch (err) {
    appendLog('选择文件失败: ' + err.message)
  }
}

// 添加分区行
function addPartitionRow(address = '0x00000') {
  const rows = elements.partitionTableBody.querySelectorAll('tr')
  if (rows.length >= 5) {
    alert('最多支持5个分区')
    return
  }

  let maxRowIndex = -1
  rows.forEach(row => {
    const idx = parseInt(row.getAttribute('data-row'))
    if (!isNaN(idx) && idx > maxRowIndex) {
      maxRowIndex = idx
    }
  })

  const newRowIndex = maxRowIndex + 1
  const displayIndex = rows.length + 1

  const newRow = document.createElement('tr')
  newRow.setAttribute('data-row', newRowIndex)

  newRow.innerHTML = `
    <td>${displayIndex}</td>
    <td>
      <div class="file-selector">
        <input type="text" class="firmware-file" readonly placeholder="选择固件...">
        <button class="btn btn-secondary btn-browse-fw">浏览</button>
      </div>
    </td>
    <td>
      <input type="text" class="partition-address" value="${address}">
    </td>
    <td><button class="btn-remove">移除</button></td>
  `

  newRow.querySelector('.btn-browse-fw').addEventListener('click', (e) => {
    browseFirmware(e.target)
  })

  newRow.querySelector('.btn-remove').addEventListener('click', () => {
    newRow.remove()
    updateRowNumbers()
    updateRemoveButtons()
  })

  elements.partitionTableBody.appendChild(newRow)
  updateRemoveButtons()
}

// 更新行号
function updateRowNumbers() {
  const rows = elements.partitionTableBody.querySelectorAll('tr')
  rows.forEach((row, index) => {
    row.querySelector('td:first-child').textContent = index + 1
  })
}

// 更新移除按钮状态
function updateRemoveButtons() {
  const rows = elements.partitionTableBody.querySelectorAll('tr')
  const removeButtons = elements.partitionTableBody.querySelectorAll('.btn-remove')
  removeButtons.forEach((btn, index) => {
    btn.disabled = rows.length <= 1
  })
}

// 获取分区列表
function getPartitions() {
  const partitions = []
  const rows = elements.partitionTableBody.querySelectorAll('tr')

  rows.forEach(row => {
    const firmwareFile = row.querySelector('.firmware-file').value
    const address = row.querySelector('.partition-address').value

    if (firmwareFile && address) {
      partitions.push({ firmwareFile, address })
    }
  })

  return partitions
}

// 设置 UI 为烧录中状态
function setFlashingUI(flashing) {
  isFlashing = flashing
  elements.startBtn.disabled = flashing
  elements.stopBtn.disabled = !flashing
  elements.eraseBtn.disabled = flashing
  elements.addRowBtn.disabled = flashing
  elements.portSelect.disabled = flashing
  elements.refreshPortsBtn.disabled = flashing

  const browseButtons = elements.partitionTableBody.querySelectorAll('.btn-browse-fw')
  browseButtons.forEach(btn => btn.disabled = flashing)

  if (flashing) {
    elements.progressFill.style.width = '0%'
    elements.progressPercent.textContent = '0%'
    elements.progressText.textContent = '准备就绪'
  }
}

// 开始烧录
async function startFlashing() {
  const portPath = elements.portSelect.value
  if (!portPath) {
    alert('请选择串口端口！')
    return
  }

  const partitions = getPartitions()
  if (partitions.length === 0) {
    alert('请至少添加一个烧录分区！')
    return
  }

  for (const part of partitions) {
    if (!part.firmwareFile) {
      alert('请为所有分区选择固件文件！')
      return
    }
    if (!part.address || !/^0x[0-9a-fA-F]+$/.test(part.address)) {
      alert('请输入有效的分区地址（如: 0x10000）！')
      return
    }
  }

  // 确保主界面串口已释放
  try {
    await window.electronAPI.releaseMainPort()
    appendLog('主界面串口已释放')
  } catch (err) {
    appendLog(`释放主界面串口失败: ${err.message}`)
  }

  setFlashingUI(true)
  appendLog('开始烧录...')

  try {
    // 获取端口 VID/PID，用于 USB-JTAG 识别
    const portInfo = portInfoMap.get(portPath)
    await window.electronAPI.firmwareStartFlash({
      portPath: portPath,
      fileArray: partitions,
      baudRate: 115200,
      productId: portInfo ? portInfo.productId : 0,
      vendorId: portInfo ? portInfo.vendorId : 0
    })
  } catch (err) {
    appendLog(`烧录调用失败: ${err.message}`)
    setFlashingUI(false)
  }
}

// 停止烧录
function stopFlashing() {
  appendLog('正在停止烧录...')
  window.electronAPI.firmwareStop().then(() => {
    appendLog('停止指令已发送')
  }).catch(err => {
    appendLog('发送停止指令失败: ' + err.message)
  })
}

// 擦除 Flash
async function eraseFlash() {
  const portPath = elements.portSelect.value
  if (!portPath) {
    alert('请选择串口端口！')
    return
  }

  if (!confirm('确定要擦除设备 Flash 吗？')) {
    return
  }

  // 确保主界面串口已释放
  try {
    await window.electronAPI.releaseMainPort()
    appendLog('主界面串口已释放')
  } catch (err) {
    appendLog(`释放主界面串口失败: ${err.message}`)
  }

  setFlashingUI(true)
  elements.progressText.textContent = '正在擦除...'
  appendLog('开始擦除 Flash...')

  try {
    // 获取端口 VID/PID，用于 USB-JTAG 识别
    const portInfo = portInfoMap.get(portPath)
    await window.electronAPI.firmwareEraseFlash({
      portPath: portPath,
      baudRate: 115200,
      productId: portInfo ? portInfo.productId : 0,
      vendorId: portInfo ? portInfo.vendorId : 0
    })
  } catch (err) {
    appendLog(`擦除调用失败: ${err.message}`)
    setFlashingUI(false)
  }
}

// 页面加载完成后初始化
window.addEventListener('DOMContentLoaded', init)