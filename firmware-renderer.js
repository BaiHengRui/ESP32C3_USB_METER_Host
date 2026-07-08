// 固件更新窗口渲染进程
// 通过 IPC 调用主进程 serialport 方案进行烧录（避免 Electron WebSerial 崩溃）

let isFlashing = false
let availablePorts = []
let elements

window.addEventListener('error', (e) => {
  console.error('[FIRMWARE] 未捕获的错误:', e.error)
  appendLog(`未捕获的错误: ${e.error ? e.error.message : e.error}`)
})

window.addEventListener('unhandledrejection', (e) => {
  console.error('[FIRMWARE] 未处理的 Promise 拒绝:', e.reason)
  appendLog(`未处理的 Promise 拒绝: ${e.reason ? e.reason.message : e.reason}`)
})

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

function appendLog(msg) {
  const timestamp = new Date().toLocaleTimeString()
  const logArea = document.getElementById('logArea')
  if (logArea) {
    logArea.value += `[${timestamp}] ${msg}\n`
    logArea.scrollTop = logArea.scrollHeight
  }
  console.log(`[FIRMWARE] ${msg}`)
}

async function init() {
  elements = getElements()
  appendLog('初始化开始...')
  appendLog('烧录引擎: 主进程 serialport（稳定方案）')

  setupEventListeners()
  initTheme()
  bindBrowseButtons()
  updateRemoveButtons()  // 更新初始行的移除按钮状态
  await refreshPorts()

  window.electronAPI.onFlashProgress(({ percent, message }) => {
    updateProgress(percent, message)
  })
  window.electronAPI.onFlashLog((message) => {
    appendLog(message)
  })

  appendLog('初始化完成')
}

async function initTheme() {
  try {
    const theme = await window.electronAPI.getTheme()
    applyTheme(theme)
    window.electronAPI.onThemeChanged((theme) => { applyTheme(theme) })
  } catch (e) {
    appendLog('主题初始化失败: ' + e.message)
  }
}

function applyTheme(theme) {
  document.body.classList.remove('theme-light', 'theme-dark')
  document.body.classList.add(`theme-${theme}`)
}

async function refreshPorts() {
  try {
    appendLog('正在刷新串口列表...')
    const ports = await window.electronAPI.listSerialPorts()
    availablePorts = ports || []

    elements.portSelect.innerHTML = '<option value="">选择端口...</option>'
    for (const port of availablePorts) {
      const option = document.createElement('option')
      option.value = port.path
      const mfr = port.manufacturer ? ` (${port.manufacturer})` : ''
      option.textContent = port.path + mfr
      elements.portSelect.appendChild(option)
    }

    if (availablePorts.length > 0 && !elements.portSelect.value) {
      elements.portSelect.value = availablePorts[0].path
    }
    appendLog(`找到 ${availablePorts.length} 个串口`)
  } catch (err) {
    appendLog(`刷新串口失败: ${err.message}`)
    console.error(err)
  }
}

function setupEventListeners() {
  elements.refreshPortsBtn.addEventListener('click', refreshPorts)
  elements.addRowBtn.addEventListener('click', () => addPartitionRow())
  elements.startBtn.addEventListener('click', startFlashing)
  elements.stopBtn.addEventListener('click', stopFlashing)
  elements.eraseBtn.addEventListener('click', eraseFlash)

  // 事件委托：移除分区行（兼容 HTML 初始行 + 动态添加的行）
  elements.partitionTableBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-remove')
    if (!btn) return
    const row = btn.closest('tr')
    if (!row) return
    row.remove()
    updateRowNumbers()
    updateRemoveButtons()
  })
}

function bindBrowseButtons() {
  const browseButtons = elements.partitionTableBody.querySelectorAll('.btn-browse-fw')
  browseButtons.forEach(btn => {
    const newBtn = btn.cloneNode(true)
    btn.parentNode.replaceChild(newBtn, btn)
    newBtn.addEventListener('click', function () { browseFirmware(this) })
  })
}

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

function addPartitionRow(address = '0x00000') {
  const rows = elements.partitionTableBody.querySelectorAll('tr')
  if (rows.length >= 5) { alert('最多支持5个分区'); return }

  let maxRowIndex = -1
  rows.forEach(row => {
    const idx = parseInt(row.getAttribute('data-row'))
    if (!isNaN(idx) && idx > maxRowIndex) maxRowIndex = idx
  })

  const newRowIndex = maxRowIndex + 1
  const displayIndex = rows.length + 1
  const newRow = document.createElement('tr')
  newRow.setAttribute('data-row', newRowIndex)

  newRow.innerHTML = `<td>${displayIndex}</td>
    <td><div class="file-selector">
      <input type="text" class="firmware-file" readonly placeholder="选择固件...">
      <button class="btn btn-secondary btn-browse-fw">浏览</button>
    </div></td>
    <td><input type="text" class="partition-address" value="${address}"></td>
    <td><button class="btn-remove">移除</button></td>`

  newRow.querySelector('.btn-browse-fw').addEventListener('click', (e) => { browseFirmware(e.target) })

  elements.partitionTableBody.appendChild(newRow)
  updateRemoveButtons()
}

function updateRowNumbers() {
  const rows = elements.partitionTableBody.querySelectorAll('tr')
  rows.forEach((row, index) => { row.querySelector('td:first-child').textContent = index + 1 })
}

function updateRemoveButtons() {
  const btns = elements.partitionTableBody.querySelectorAll('.btn-remove')
  const rows = elements.partitionTableBody.querySelectorAll('tr')
  btns.forEach(btn => btn.disabled = rows.length <= 1)
}

function getPartitions() {
  const partitions = []
  elements.partitionTableBody.querySelectorAll('tr').forEach(row => {
    const fw = row.querySelector('.firmware-file').value
    const addr = row.querySelector('.partition-address').value
    if (fw && addr) partitions.push({ firmwareFile: fw, address: addr })
  })
  return partitions
}

function setFlashingUI(flashing) {
  isFlashing = flashing
  elements.startBtn.disabled = flashing
  elements.stopBtn.disabled = !flashing
  elements.eraseBtn.disabled = flashing
  elements.addRowBtn.disabled = flashing
  elements.portSelect.disabled = flashing
  elements.refreshPortsBtn.disabled = flashing

  elements.partitionTableBody.querySelectorAll('.btn-browse-fw').forEach(btn => btn.disabled = flashing)

  if (flashing) {
    elements.progressFill.style.width = '0%'
    elements.progressPercent.textContent = '0%'
    elements.progressText.textContent = '准备就绪'
  }
}

function updateProgress(percent, message) {
  elements.progressFill.style.width = `${percent}%`
  elements.progressPercent.textContent = `${Math.floor(percent)}%`
  if (message) elements.progressText.textContent = message
}

async function startFlashing() {
  if (isFlashing) return

  const portPath = elements.portSelect.value
  if (!portPath) { alert('请选择串口端口！'); return }

  const partitions = getPartitions()
  if (partitions.length === 0) { alert('请至少添加一个烧录分区！'); return }

  for (const part of partitions) {
    if (!part.firmwareFile) { alert('请为所有分区选择固件文件！'); return }
    if (!part.address || !/^0x[0-9a-fA-F]+$/.test(part.address)) {
      alert('请输入有效的分区地址（如: 0x10000）！'); return
    }
  }

  setFlashingUI(true)
  try {
    const result = await window.electronAPI.flashFirmware({ portPath, partitions })
    if (!result.success) {
      appendLog(`❌ 烧录失败: ${result.error}`)
      updateProgress(0, `错误: ${result.error}`)
    }
  } catch (err) {
    appendLog(`❌ 烧录异常: ${err.message}`)
    console.error('[FIRMWARE] 烧录异常:', err)
    updateProgress(0, `错误: ${err.message}`)
  } finally {
    setFlashingUI(false)
  }
}

function stopFlashing() {
  appendLog('⚠ 烧录操作进行中，无法中途取消。请等待完成。')
}

async function eraseFlash() {
  if (isFlashing) return

  const portPath = elements.portSelect.value
  if (!portPath) { alert('请选择串口端口！'); return }

  if (!confirm('确定要擦除设备 Flash 吗？此操作不可恢复！')) return

  setFlashingUI(true)
  try {
    const result = await window.electronAPI.eraseFlash(portPath)
    if (!result.success) {
      appendLog(`❌ 擦除失败: ${result.error}`)
      updateProgress(0, `错误: ${result.error}`)
    }
  } catch (err) {
    appendLog(`❌ 擦除异常: ${err.message}`)
    console.error('[FIRMWARE] 擦除异常:', err)
    updateProgress(0, `错误: ${err.message}`)
  } finally {
    setFlashingUI(false)
  }
}

window.addEventListener('DOMContentLoaded', init)
