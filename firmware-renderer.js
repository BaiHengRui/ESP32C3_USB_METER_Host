// 固件更新窗口渲染进程
// 使用 esptool-js 进行 ESP32 烧录

import { ESPLoader, Transport, UsbJtagSerialReset } from 'esptool-js'

// 延迟函数
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// 状态变量
let isFlashing = false

// DOM 元素 (延迟获取)
let elements

// 全局错误处理
window.addEventListener('error', (e) => {
  console.error('[FIRMWARE] 未捕获的错误:', e.error)
  if (typeof appendLog === 'function') {
    appendLog(`未捕获的错误: ${e.error ? e.error.message : e.message}`)
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
  // 如果有 path，直接返回 path
  if (info.path) {
    return info.path
  }
  // 否则使用 VID:PID 格式，确保转换为十六进制
  const vid = info.usbVendorId ? info.usbVendorId.toString(16).padStart(4, '0') : '0000'
  const pid = info.usbProductId ? info.usbProductId.toString(16).padStart(4, '0') : '0000'
  return `VID:${vid}-PID:${pid}`
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
            // 增加延迟时间，确保串口完全关闭
            await delay(1000)
            // 验证串口是否已关闭
            let retryCount = 0
            while (retryCount < 5) {
              const stillOpen = await window.electronAPI.isPortOpen()
              if (!stillOpen) {
                appendLog('主界面串口已成功释放')
                break
              }
              appendLog(`等待串口关闭... (${retryCount + 1}/5)`)
              await delay(500)
              retryCount++
            }
          }
        } catch (e) {
          appendLog('释放主界面串口时出错: ' + e.message)
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
        // 将 Web Serial 的 VID/PID 转换为十六进制字符串进行比较
        const vidHex = vid.toString(16).toLowerCase().padStart(4, '0')
        const pidHex = pid.toString(16).toLowerCase().padStart(4, '0')
        
        const matchedPort = systemPorts.find(p => {
          const pVid = p.vendorId ? p.vendorId.toLowerCase() : null
          const pPid = p.productId ? p.productId.toLowerCase() : null
          return pVid === vidHex && pPid === pidHex
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

  // 获取当前最大的 data-row 索引
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
        <button class="btn-browse-fw">浏览</button>
      </div>
    </td>
    <td>
      <input type="text" class="partition-address" value="${address}">
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
    // 至少保留一行
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

// 执行 USB-JTAG-Serial 复位序列
// 参考 esptool-js 的 UsbJtagSerialReset 实现
async function performUsbJtagReset(port) {
  try {
    // 打开端口以便设置信号
    if (!port.readable && !port.writable) {
      await port.open({
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none'
      })
      appendLog('临时打开端口进行复位...')
    }
    
    // USB-JTAG-Serial 复位序列
    // 参考 esptool-js 的 UsbJtagSerialReset.reset()
    await port.setSignals({ dataTerminalReady: false, requestToSend: false })
    await delay(100)
    await port.setSignals({ dataTerminalReady: true, requestToSend: false })
    await delay(100)
    await port.setSignals({ dataTerminalReady: false, requestToSend: true })
    await delay(100)
    await port.setSignals({ dataTerminalReady: false, requestToSend: false })
    
    // 关闭端口，让 esptool-js 重新打开
    await port.close()
    appendLog('复位端口已关闭')
    
  } catch (e) {
    appendLog(`USB-JTAG复位失败: ${e.message}`)
    // 尝试关闭端口
    try {
      if (port.readable || port.writable) {
        await port.close()
      }
    } catch (err) {
      // 忽略
    }
  }
}

// 将设备重置为 bootloader 模式
// ESP32C3 USB-JTAG 模式下，esptool-js 需要自己处理复位
async function resetToBootloader(port) {
  try {
    // 如果端口已打开，先关闭（确保干净的状态）
    if (port.readable || port.writable) {
      appendLog('端口已打开，先关闭...')
      try {
        await port.close()
        await delay(500)
      } catch (e) {
        appendLog('关闭端口时出错: ' + e.message)
      }
    }
    
    appendLog('复位完成（等待 esptool-js 自动处理）')
    
  } catch (err) {
    appendLog('复位设备时出错: ' + err.message)
    // 尝试强制关闭端口
    try {
      if (port.readable || port.writable) {
        await port.close()
      }
    } catch (e) {
      // 忽略
    }
  }
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
  elements.progressPercent.textContent = '0%'
  elements.progressText.textContent = '准备烧录...'
  
  appendLog('开始烧录...')

  let transport = null
  let esploader = null
  
  try {
    // 如果主界面占用了串口，先释放
    try {
      const mainWindowPortOpen = await window.electronAPI.isPortOpen()
      if (mainWindowPortOpen) {
        appendLog('正在释放主界面占用的串口...')
        await window.electronAPI.closePort()
        await delay(1000)
      }
    } catch (e) {
      appendLog('释放主界面串口时出错: ' + e.message)
    }
    
    // 准备文件列表（提前读取，避免在烧录过程中阻塞）
    appendLog('准备文件列表...')
    const fileArray = []
    for (const part of partitions) {
      const partName = part.firmwareFile.split(/[/\\]/).pop()
      appendLog(`正在读取固件: ${partName}`)
      
      const fileData = await window.electronAPI.readFile(part.firmwareFile)
      const dataArray = new Uint8Array(fileData)
      
      fileArray.push({
        data: dataArray,
        address: parseInt(part.address, 16)
      })
      
      appendLog(`已加载: ${partName} -> ${part.address} (${dataArray.length} 字节)`)
    }
    
    // 连接并检测芯片（带重试）
    let chip = null
    let connectAttempts = 0
    const maxAttempts = 3
    
    while (connectAttempts < maxAttempts) {
      try {
        // 确保端口处于关闭状态
        if (port.readable || port.writable) {
          appendLog('端口已打开，先关闭...')
          await port.close()
          await delay(500)
        }
        
        appendLog(`正在检测芯片... (尝试 ${connectAttempts + 1}/${maxAttempts})`)
        
        // 获取设备 PID，判断是否为 USB-JTAG-Serial
        const portInfo = port.getInfo()
        const pid = portInfo.usbProductId
        appendLog(`设备 PID: 0x${pid.toString(16)}`)
        
        // 确保端口已经关闭
        try {
          if (port.readable || port.writable) {
            appendLog('端口已打开，正在关闭...')
            await port.close()
            await new Promise(resolve => setTimeout(resolve, 200))
            appendLog('端口已关闭')
          }
        } catch (e) {
          appendLog(`关闭端口失败: ${e.message}`)
        }
        
        // 创建 Transport 对象（esptool-js 会自动打开端口）
        appendLog('创建 Transport 对象...')
        transport = new Transport(port, true)
        appendLog('Transport 对象创建成功')
        
        // 创建 ESPLoader，初始波特率 115200
        appendLog('创建 ESPLoader 对象...')
        esploader = new ESPLoader({
          transport: transport,
          baudrate: 115200,
          terminal: terminal,
          debugLogging: false
        })
        appendLog('ESPLoader 对象创建成功')
        
        // 连接并检测芯片（esploader 会自动检测设备类型并执行相应的复位序列）
        appendLog('开始连接芯片...')
        const startTime = Date.now()
        const chipName = await esploader.main()
        const connectTime = Date.now() - startTime
        appendLog(`检测到芯片: ${chipName} (耗时 ${connectTime}ms)`)
        
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
            const fileProgress = (seq / total) * 100
            const totalProgress = ((fileIndex + fileProgress / 100) / fileArray.length) * 100
            updateProgress(Math.min(totalProgress, 100), `烧录中... ${Math.floor(totalProgress)}%`)
          }
        })
        
        // 烧录完成后复位设备
        appendLog('正在复位设备...')
        await esploader.after('hard_reset')
        
        updateProgress(100, '烧录完成')
        appendLog('烧录完成！')
        
        flashComplete(true, '烧录成功')
        return
        
      } catch (err) {
        connectAttempts++
        appendLog(`检测失败 (${connectAttempts}/${maxAttempts}): ${err.message}`)
        
        // 清理资源
        if (esploader) {
          try {
            await esploader.close()
          } catch (e) {
            // 忽略
          }
          esploader = null
        }
        if (transport) {
          try {
            await transport.close()
          } catch (e) {
            // 忽略
          }
          transport = null
        }
        
        // 确保端口关闭
        try {
          if (port.readable || port.writable) {
            await port.close()
          }
        } catch (e) {
          // 忽略
        }
        
        if (connectAttempts < maxAttempts) {
          appendLog('等待后重试...')
          await delay(2000)
        }
      }
    }
    
    throw new Error('无法检测到芯片，请确保设备已进入 bootloader 模式')
    
  } catch (err) {
    appendLog(`错误: ${err.message}`)
    console.error('烧录失败:', err)
    flashComplete(false, err.message)
  } finally {
    // 清理资源
    if (esploader) {
      try {
        await esploader.close()
      } catch (e) {
        // 忽略
      }
    }
    if (transport) {
      try {
        await transport.close()
      } catch (e) {
        // 忽略
      }
    }
    
    elements.startBtn.disabled = false
    elements.stopBtn.disabled = true
    elements.eraseBtn.disabled = false
    elements.addRowBtn.disabled = false
    elements.portSelect.disabled = false
    
    // 恢复所有浏览按钮
    browseButtons.forEach(btn => btn.disabled = false)
  }
}

// 停止烧录
function stopFlashing() {
  appendLog('停止按钮当前不可用（烧录进行中无法中断）')
}

// 擦除 Flash
async function eraseFlash() {
  let transport = null
  let esploader = null
  
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
        await delay(1000)
      }
    } catch (e) {
      appendLog('释放主界面串口时出错: ' + e.message)
    }
    
    // 检测芯片（带重试）
    let chip = null
    let connectAttempts = 0
    const maxAttempts = 3
    
    while (connectAttempts < maxAttempts) {
      try {
        // 确保端口处于关闭状态
        if (port.readable || port.writable) {
          appendLog('端口已打开，先关闭...')
          await port.close()
          await delay(500)
        }
        
        appendLog(`正在检测芯片... (尝试 ${connectAttempts + 1}/${maxAttempts})`)
        
        // 获取设备 PID，判断是否为 USB-JTAG-Serial
        const portInfo = port.getInfo()
        const pid = portInfo.usbProductId
        appendLog(`设备 PID: 0x${pid.toString(16)}`)
        
        // 如果是 USB-JTAG-Serial (PID 0x1001)，手动执行复位序列
        if (pid === 0x1001) {
          appendLog('检测到 USB-JTAG-Serial 设备，执行特殊复位序列...')
          await performUsbJtagReset(port)
          appendLog('USB-JTAG-Serial 复位完成')
        }
        
        // 创建 Transport 对象（esptool-js 会自动打开端口）
        appendLog('创建 Transport 对象...')
        transport = new Transport(port, true)
        appendLog('Transport 对象创建成功')
        
        // 创建 ESPLoader
        appendLog('创建 ESPLoader 对象...')
        esploader = new ESPLoader({
          transport: transport,
          baudrate: 115200,
          terminal: terminal,
          debugLogging: false
        })
        appendLog('ESPLoader 对象创建成功')
        
        // 检测芯片
        appendLog('开始连接芯片...')
        const startTime = Date.now()
        const chipName = await esploader.main()
        const connectTime = Date.now() - startTime
        appendLog(`检测到芯片: ${chipName} (耗时 ${connectTime}ms)`)
        
        // 擦除 Flash
        appendLog('正在擦除 Flash...')
        appendLog('注意：全芯片擦除可能需要几秒钟时间，请耐心等待...')
        
        let eraseSuccess = false
        try {
          const eraseResult = await esploader.eraseFlash()
          appendLog(`擦除完成！结果: ${eraseResult}`)
          eraseSuccess = true
        } catch (eraseErr) {
          appendLog(`擦除失败: ${eraseErr.message}`)
          appendLog('尝试使用低级命令擦除...')
          try {
            // 尝试使用低级命令直接擦除
            const result = await esploader.checkCommand('erase flash', esploader.ESP_ERASE_FLASH, undefined, undefined, undefined, esploader.CHIP_ERASE_TIMEOUT)
            appendLog(`低级命令擦除结果: ${result}`)
            eraseSuccess = true
          } catch (lowErr) {
            appendLog(`低级命令擦除也失败: ${lowErr.message}`)
            throw new Error(`擦除失败: ${lowErr.message}`)
          }
        }
        
        if (!eraseSuccess) {
          throw new Error('擦除操作未成功完成')
        }
        
        // 复位
        appendLog('正在复位设备...')
        await esploader.after('hard_reset')
        
        appendLog('复位完成')
        flashComplete(true, '擦除成功')
        return
        
      } catch (err) {
        connectAttempts++
        appendLog(`检测失败 (${connectAttempts}/${maxAttempts}): ${err.message}`)
        
        // 清理资源
        if (esploader) {
          try {
            await esploader.close()
          } catch (e) {
            // 忽略
          }
          esploader = null
        }
        if (transport) {
          try {
            await transport.close()
          } catch (e) {
            // 忽略
          }
          transport = null
        }
        
        // 确保端口关闭
        try {
          if (port.readable || port.writable) {
            await port.close()
          }
        } catch (e) {
          // 忽略
        }
        
        if (connectAttempts < maxAttempts) {
          appendLog('等待后重试...')
          await delay(2000)
        }
      }
    }
    
    throw new Error('无法检测到芯片，请确保设备已进入 bootloader 模式')
    
  } catch (err) {
    appendLog(`擦除失败: ${err.message}`)
    console.error('擦除失败:', err)
  } finally {
    // 清理资源
    if (esploader) {
      try {
        await esploader.close()
      } catch (e) {
        // 忽略
      }
    }
    if (transport) {
      try {
        await transport.close()
      } catch (e) {
        // 忽略
      }
    }
    
    elements.eraseBtn.disabled = false
    elements.startBtn.disabled = false
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
  
  if (success) {
    appendLog(`成功: ${message}`)
  } else {
    appendLog(`烧录失败: ${message}`)
  }
}

// 更新进度
function updateProgress(percent, message) {
  elements.progressFill.style.width = `${percent}%`
  elements.progressPercent.textContent = `${Math.floor(percent)}%`
  elements.progressText.textContent = message
}

// 页面加载完成后初始化
window.addEventListener('DOMContentLoaded', init)
