// 固件更新窗口渲染进程
// 使用 esptool-js 进行 ESP32 烧录

import { ESPLoader, Transport } from 'esptool-js'

// 延迟函数
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// 状态变量
let isFlashing = false

// DOM 元素 (延迟获取)
let elements

// 获取 DOM 元素
function getElements() {
  return {
    portSelect: document.getElementById('portSelect'),
    refreshPortsBtn: document.getElementById('refreshPortsBtn'),
    partitionTableBody: document.getElementById('partitionTableBody'),
    addRowBtn: document.getElementById('addRowBtn'),
    progressFill: document.getElementById('progressFill'),
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

// 终端接口实现
const terminal = {
  clean: () => {
    const logArea = document.getElementById('logArea')
    if (logArea) logArea.value = ''
  },
  writeLine: (data) => {
    appendLog(data)
  },
  write: (data) => {
    appendLog(data)
  }
}

// 获取端口标识符
function getPortIdentifier(port) {
  const info = port.getInfo()
  return info.path || `VID:${info.usbVendorId}-PID:${info.usbProductId}`
}

// 初始化
async function init() {
  // 获取 DOM 元素
  elements = getElements()
  
  appendLog('初始化开始...')
  appendLog('Web Serial API 可用: ' + !!navigator.serial)
  appendLog('Electron API 可用: ' + !!window.electronAPI)
  
  if (!navigator.serial) {
    appendLog('错误: navigator.serial 不可用!')
    appendLog('请确保在 main.js 中设置了 enableWebSerial: true')
  } else {
    appendLog('请点击"刷新"按钮选择串口设备')
  }
  
  setupEventListeners()
  initTheme()
  bindBrowseButtons()
  
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
    
    // 检查 Web Serial API 是否可用
    if (!navigator.serial) {
      appendLog('错误: navigator.serial 不可用')
      appendLog('请确保在 main.js 中设置了 enableWebSerial: true')
      return
    }
    
    // 清空下拉框
    elements.portSelect.innerHTML = '<option value="">选择端口...</option>'
    
    // 先获取已授权的端口
    let webSerialPorts = await navigator.serial.getPorts()
    appendLog('已授权的端口数量: ' + webSerialPorts.length)
    
    // 如果没有已授权的端口，让用户选择
    if (webSerialPorts.length === 0) {
      appendLog('正在请求串口访问（需要用户授权）...')
      try {
        // 如果主界面占用了串口，先释放
        try {
          const mainWindowPortOpen = await window.electronAPI.isPortOpen()
          if (mainWindowPortOpen) {
            appendLog('正在释放主界面占用的串口...')
            await window.electronAPI.closePort()
            await delay(500)
          }
        } catch (e) {
          // 忽略
        }
        
        const selectedPort = await navigator.serial.requestPort()
        webSerialPorts = [selectedPort]
        appendLog('串口已授权')
      } catch (err) {
        appendLog('未选择串口: ' + err.message)
        return
      }
    }
    
    // 通过主进程获取完整的端口列表（包含 COM 端口名等友好信息）
    let systemPorts = []
    try {
      systemPorts = await window.electronAPI.listPorts()
      appendLog('系统端口列表: ' + systemPorts.map(p => p.path).join(', '))
    } catch (err) {
      appendLog('获取系统端口列表失败: ' + err.message)
    }
    
    // 填充下拉框
    for (const port of webSerialPorts) {
      const identifier = getPortIdentifier(port)
      const portInfo = port.getInfo()
      const vid = portInfo.usbVendorId
      const pid = portInfo.usbProductId
      
      // 尝试获取友好显示名称
      let displayText = identifier
      if (vid && pid) {
        const vidDecimal = parseInt(vid, 10)
        const pidDecimal = parseInt(pid, 10)
        const matchedPort = systemPorts.find(p => {
          const pVid = p.vendorId ? parseInt(p.vendorId, 16) : null
          const pPid = p.productId ? parseInt(p.productId, 16) : null
          return pVid === vidDecimal && pPid === pidDecimal
        })
        if (matchedPort) {
          displayText = matchedPort.path
          if (matchedPort.manufacturer) {
            displayText += ` (${matchedPort.manufacturer})`
          }
        }
      }
      
      const option = document.createElement('option')
      option.value = identifier          // 关键：value 用标识符
      option.textContent = displayText   // 显示可以用友好名称
      elements.portSelect.appendChild(option)
      
      appendLog('添加端口: ' + identifier + ' -> ' + displayText)
    }
    
    appendLog('端口刷新完成，共 ' + webSerialPorts.length + ' 个端口')
    
    // 如果有端口，自动选择第一个
    if (webSerialPorts.length > 0 && elements.portSelect.options.length > 1) {
      elements.portSelect.selectedIndex = 1  // 跳过第一个"选择端口..."选项
      appendLog('自动选择端口: ' + elements.portSelect.value)
    }
  } catch (err) {
    console.error('获取串口列表失败:', err)
    appendLog(`获取串口列表失败: ${err.message}`)
  }
}

// 设置事件监听
function setupEventListeners() {
  // 刷新端口
  elements.refreshPortsBtn.addEventListener('click', refreshPorts)

  // 添加分区行
  elements.addRowBtn.addEventListener('click', () => addPartitionRow())

  // 开始烧录
  elements.startBtn.addEventListener('click', startFlashing)

  // 停止烧录
  elements.stopBtn.addEventListener('click', stopFlashing)

  // 擦除
  elements.eraseBtn.addEventListener('click', eraseFlash)
  
  appendLog('事件监听器已设置')
}

// 为所有浏览按钮绑定事件
function bindBrowseButtons() {
  const browseButtons = elements.partitionTableBody.querySelectorAll('.btn-browse-fw')
  browseButtons.forEach(btn => {
    // 移除所有旧的事件监听器
    const newBtn = btn.cloneNode(true)
    btn.parentNode.replaceChild(newBtn, btn)
    // 添加新的事件监听器
    newBtn.addEventListener('click', function() {
      browseFirmware(this)
    })
  })
  appendLog('浏览按钮已绑定')
}

// 浏览固件文件（针对特定行）
async function browseFirmware(button) {
  try {
    const result = await window.electronAPI.openFirmwareDialog()
    appendLog('文件对话框结果: ' + JSON.stringify(result))
    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
      // 找到这个按钮所在的行
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
function addPartitionRow(address = '0x00000', hint = '') {
  const rows = elements.partitionTableBody.querySelectorAll('tr')
  if (rows.length >= 5) {
    alert('最多支持5个分区')
    return
  }

  const rowIndex = rows.length + 1
  const newRow = document.createElement('tr')
  newRow.setAttribute('data-row', rowIndex - 1)
  
  const hintHtml = hint ? `<span class="address-hint">${hint}</span>` : ''
  
  newRow.innerHTML = `
    <td>${rowIndex}</td>
    <td>
      <div class="file-selector">
        <input type="text" class="firmware-file" readonly placeholder="选择固件...">
        <button class="btn-browse-fw">浏览</button>
      </div>
    </td>
    <td>
      <input type="text" class="partition-address" value="${address}">
      ${hintHtml}
    </td>
    <td><button class="btn-remove">移除</button></td>
  `
  
  // 添加浏览按钮事件
  newRow.querySelector('.btn-browse-fw').addEventListener('click', (e) => {
    browseFirmware(e.target)
  })
  
  // 添加移除按钮事件
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

// 开始烧录
async function startFlashing() {
  const portPath = elements.portSelect.value
  
  if (!portPath) {
    alert('请选择串口端口！')
    return
  }

  // 动态获取端口对象
  let port = null
  try {
    const ports = await navigator.serial.getPorts()
    port = ports.find(p => getPortIdentifier(p) === portPath)
  } catch (err) {
    appendLog(`获取端口列表失败: ${err.message}`)
  }
  if (!port) {
    alert('未找到对应的端口，请点击"刷新"按钮重新选择')
    appendLog(`错误: 端口标识符 ${portPath} 未匹配到任何设备`)
    return
  }
  
  // 调试：验证 port 对象
  appendLog(`port 类型: ${typeof port}`)
  appendLog(`port.getInfo 存在: ${typeof port.getInfo}`)
  appendLog(`port.open 存在: ${typeof port.open}`)
  if (typeof port.getInfo === 'function') {
    try {
      const info = port.getInfo()
      appendLog(`port.getInfo 结果: ${JSON.stringify(info)}`)
    } catch(e) {
      appendLog(`port.getInfo 调用失败: ${e.message}`)
    }
  }
  
  // 额外验证：确保 port 是 Web Serial API 的 SerialPort 对象
  if (typeof port.getInfo !== 'function') {
    appendLog('错误: port 对象不是有效的 Web Serial 对象！')
    alert('端口对象无效，请刷新页面后重试')
    return
  }
  
  const partitions = getPartitions()
  if (partitions.length === 0) {
    alert('请至少添加一个烧录分区！')
    return
  }

  // 验证所有分区
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

  // 开始烧录
  isFlashing = true
  elements.startBtn.disabled = true
  elements.stopBtn.disabled = false
  elements.eraseBtn.disabled = true
  elements.addRowBtn.disabled = true
  elements.portSelect.disabled = true
  
  // 禁用所有浏览按钮
  const browseButtons = elements.partitionTableBody.querySelectorAll('.btn-browse-fw')
  browseButtons.forEach(btn => btn.disabled = true)
  
  elements.progressFill.style.width = '0%'
  elements.progressFill.textContent = '0%'
  elements.progressText.textContent = '准备烧录...'
  
  appendLog('开始烧录...')

  let transport = null
  
  try {
    // 如果主界面占用了串口，先释放
    try {
      const mainWindowPortOpen = await window.electronAPI.isPortOpen()
      if (mainWindowPortOpen) {
        appendLog('正在释放主界面占用的串口...')
        await window.electronAPI.closePort()
        await delay(500)
      }
    } catch (e) {
      // 忽略
    }
    
    // 创建 Transport 对象（esptool-js 会自动打开端口）
    appendLog('创建 Transport 对象...')
    transport = new Transport(port, true)
    
    // 创建 ESPLoader，初始波特率 115200
    appendLog('创建 ESPLoader 对象...')
    const esploader = new ESPLoader({
      transport: transport,
      baudrate: 115200,
      terminal: terminal
    })
    
    // 连接并检测芯片
    appendLog('正在检测芯片...')
    const chip = await esploader.main()
    const chipName = chip.getChipName ? chip.getChipName() : chip
    appendLog(`检测到芯片: ${chipName}`)
    
    // 准备文件列表
    const fileArray = []
    for (const part of partitions) {
      const partName = part.firmwareFile.split(/[/\\]/).pop()
      appendLog(`正在读取固件: ${partName}`)
      
      // 通过主进程读取文件
      const fileData = await window.electronAPI.readFile(part.firmwareFile)
      const dataArray = new Uint8Array(fileData)
      
      fileArray.push({
        data: dataArray,
        address: parseInt(part.address, 16)
      })
      
      appendLog(`已加载: ${partName} -> ${part.address} (${dataArray.length} 字节)`)
    }
    
    // 烧录固件
    appendLog('开始烧录...')
    await esploader.writeFlash({
      fileArray: fileArray,
      flashSize: 'keep',
      flashMode: 'dio',
      flashFreq: '80m',
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, seq, total) => {
        // 计算总进度
        const fileProgress = (seq / total) * 100
        const totalProgress = ((fileIndex + fileProgress / 100) / fileArray.length) * 100
        updateProgress(Math.min(totalProgress, 100), `烧录中... ${Math.floor(totalProgress)}%`)
      }
    })
    
    // 复位设备
    appendLog('正在复位设备...')
    await esploader.hardReset()
    
    updateProgress(100, '烧录完成')
    appendLog('烧录完成！')
    
    flashComplete(true, '烧录成功')
    
  } catch (err) {
    appendLog(`错误: ${err.message}`)
    console.error('烧录失败:', err)
    flashComplete(false, err.message)
  } finally {
    if (transport) {
      try {
        transport.close()
      } catch (e) {
        // 忽略关闭错误
      }
    }
  }
}

// 停止烧录
function stopFlashing() {
  appendLog('停止按钮当前不可用（烧录进行中无法中断）')
}

// 擦除 Flash
async function eraseFlash() {
  let transport = null
  
  const portPath = elements.portSelect.value
  
  if (!portPath) {
    alert('请选择串口端口！')
    return
  }

  // 动态获取端口对象
  let port = null
  try {
    const ports = await navigator.serial.getPorts()
    port = ports.find(p => getPortIdentifier(p) === portPath)
  } catch (err) {
    appendLog(`获取端口列表失败: ${err.message}`)
  }
  if (!port) {
    alert('未找到对应的端口，请点击"刷新"按钮重新选择')
    appendLog(`错误: 端口标识符 ${portPath} 未匹配到任何设备`)
    return
  }
  
  // 调试：验证 port 对象
  appendLog(`port 类型: ${typeof port}`)
  appendLog(`port.getInfo 存在: ${typeof port.getInfo}`)
  appendLog(`port.open 存在: ${typeof port.open}`)
  if (typeof port.getInfo === 'function') {
    try {
      const info = port.getInfo()
      appendLog(`port.getInfo 结果: ${JSON.stringify(info)}`)
    } catch(e) {
      appendLog(`port.getInfo 调用失败: ${e.message}`)
    }
  }
  
  // 额外验证：确保 port 是 Web Serial API 的 SerialPort 对象
  if (typeof port.getInfo !== 'function') {
    appendLog('错误: port 对象不是有效的 Web Serial 对象！')
    alert('端口对象无效，请刷新页面后重试')
    return
  }

  if (!confirm('确定要擦除设备 Flash 吗？')) {
    return
  }

  elements.eraseBtn.disabled = true
  elements.startBtn.disabled = true
  
  appendLog('开始擦除 Flash...')

  try {
    // 如果主界面占用了串口，先释放
    try {
      const mainWindowPortOpen = await window.electronAPI.isPortOpen()
      if (mainWindowPortOpen) {
        appendLog('正在释放主界面占用的串口...')
        await window.electronAPI.closePort()
        await delay(500)
      }
    } catch (e) {
      // 忽略
    }
    
    // 创建 Transport 对象（esptool-js 会自动打开端口）
    appendLog('创建 Transport 对象...')
    transport = new Transport(port, true)
    
    // 创建 ESPLoader
    appendLog('创建 ESPLoader 对象...')
    const esploader = new ESPLoader({
      transport: transport,
      baudrate: 115200,
      terminal: terminal
    })
    
    // 检测芯片
    appendLog('正在检测芯片...')
    const chip = await esploader.main()
    const chipName = chip.getChipName ? chip.getChipName() : chip
    appendLog(`检测到芯片: ${chipName}`)
    
    // 擦除 Flash
    appendLog('正在擦除 Flash...')
    await esploader.eraseFlash()
    
    appendLog('擦除完成！')
    
    // 复位
    await esploader.hardReset()
    
  } catch (err) {
    appendLog(`擦除失败: ${err.message}`)
    console.error('擦除失败:', err)
  } finally {
    elements.eraseBtn.disabled = false
    elements.startBtn.disabled = false
    if (transport) {
      try {
        transport.close()
      } catch (e) {
        // 忽略关闭错误
      }
    }
  }
}

// 烧录完成
function flashComplete(success, message) {
  isFlashing = false
  elements.startBtn.disabled = false
  elements.stopBtn.disabled = true
  elements.eraseBtn.disabled = false
  elements.addRowBtn.disabled = false
  elements.portSelect.disabled = false
  
  // 恢复所有浏览按钮
  const browseButtons = elements.partitionTableBody.querySelectorAll('.btn-browse-fw')
  browseButtons.forEach(btn => btn.disabled = false)
  
  if (!success) {
    appendLog(`烧录失败: ${message}`)
  }
}

// 更新进度
function updateProgress(percent, message) {
  elements.progressFill.style.width = `${percent}%`
  elements.progressFill.textContent = `${Math.floor(percent)}%`
  elements.progressText.textContent = message
}

// 页面加载完成后初始化
window.addEventListener('DOMContentLoaded', init)
