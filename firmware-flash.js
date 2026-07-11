// firmware-flash.js (主进程)
// 使用 serialport + esptool-js 进行固件烧录
// 通过 IPC 向前端发送进度

const { SerialPortTransport } = require('./serialport-transport')

let ESPLoader = null
let UsbJtagSerialReset = null
let esptoolReady = false

// 动态加载 esptool-js (ESM 模块)
async function loadEsptool() {
  if (esptoolReady) return
  try {
    const mod = await import('esptool-js')
    ESPLoader = mod.ESPLoader
    UsbJtagSerialReset = mod.UsbJtagSerialReset
    esptoolReady = true
    console.log('[FLASH] esptool-js 加载成功')
  } catch (e) {
    console.error('[FLASH] esptool-js 加载失败:', e.message)
    throw e
  }
}

/**
 * 烧录固件
 * @param {Object} params
 * @param {string} params.portPath - COM 口路径
 * @param {Array<{firmwareFile: string, address: string}>} params.partitions - 分区列表
 * @param {Function} onProgress - 进度回调 (percent, message)
 * @param {Function} onLog - 日志回调 (message)
 */
async function flashFirmware(params, onProgress, onLog) {
  await loadEsptool()

  const { portPath, partitions } = params

  onLog('===== 开始烧录流程 =====')
  onProgress(5, '正在初始化...')

  // 终端输出缓冲
  let terminalBuffer = ''
  function flushTermBuf() {
    if (terminalBuffer.length > 0) { onLog(terminalBuffer); terminalBuffer = '' }
  }
  function termWrite(data) {
    if (typeof data !== 'string' || data.length === 0) return
    if (data.includes('\n')) {
      const parts = data.split('\n')
      for (let i = 0; i < parts.length - 1; i++) { terminalBuffer += parts[i]; flushTermBuf() }
      terminalBuffer += parts[parts.length - 1]
    } else { terminalBuffer += data }
    if (terminalBuffer.length >= 256) flushTermBuf()
  }

  const transport = new SerialPortTransport(portPath, 115200)

  const esploader = new ESPLoader({
    transport,
    baudrate: 115200,
    terminal: {
      clean: () => { terminalBuffer = '' },
      writeLine: (data) => { flushTermBuf(); onLog(data) },
      write: (data) => termWrite(data)
    }
  })

  try {
    onLog('正在连接芯片...')
    onProgress(8, '正在连接芯片...')

    const chipName = await Promise.race([
      esploader.main('usb_reset'),  // ESP32-C3 USB-JTAG-Serial 复位
      new Promise((_, reject) => setTimeout(() => reject(new Error('连接超时(120s)')), 120000))
    ])
    onLog(`✅ 检测到芯片: ${chipName}`)

    // 读取固件文件
    onLog('正在读取固件文件...')
    onProgress(10, '正在读取固件...')

    const fs = require('fs')
    const fileDataArray = []
    for (const part of partitions) {
      const partName = part.firmwareFile.split(/[/\\]/).pop()
      onLog(`  读取: ${partName}...`)
      const buffer = fs.readFileSync(part.firmwareFile)
      const data = new Uint8Array(buffer)
      fileDataArray.push({ data, address: parseInt(part.address, 16) })
      onLog(`  已加载: ${partName} -> ${part.address} (${data.length} 字节)`)
    }

    // 烧录
    onLog('开始烧录固件...')
    onProgress(12, '正在烧录固件...')

    await esploader.writeFlash({
      fileArray: fileDataArray,
      flashMode: 'dio',
      flashFreq: '80m',
      flashSize: '4MB',
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        const fileProgress = (written / total) * 100
        const overallProgress = 12 + ((fileIndex + fileProgress / 100) / fileDataArray.length) * 83
        onProgress(Math.min(overallProgress, 95), `烧录中... ${Math.floor(overallProgress)}%`)
      }
    })

    // 复位设备（ESP_FLASH_END + reboot 标志，所有 stub 均支持）
    onLog('正在复位设备...')
    onProgress(97, '正在复位设备...')
    try {
      // 方法1：通过 ESP_FLASH_END 命令（reboot=1）告诉 stub 重启到用户程序
      //   writeFlash 内部已调用 flashFinish(false) 退出烧录模式，此处再调用 flashFinish(true) 触发软重启
      onLog('发送重启命令 (ESP_FLASH_END)...')
      await esploader.flashFinish(true, 5000)
      onLog('设备已复位（软件复位）')
    } catch (e) {
      // 如果芯片已重启，可能收不到响应，超时属正常
      if (e.message && (e.message.includes('timeout') || e.message.includes('serial') || e.message.includes('no data'))) {
        onLog('设备已复位（芯片重启中...）')
      } else {
        onLog(`软件复位失败: ${e.message}`)
        // 方法2：降级使用 RTS 硬复位（适用于外部 USB-UART 如 CP2102 连接 EN 引脚）
        try {
          onLog('尝试 RTS 硬复位...')
          await esploader.after('hard_reset', true)
          onLog('设备已复位（RTS 硬复位）')
        } catch (e2) {
          onLog(`RTS 硬复位失败: ${e2.message}，请手动复位设备（按 EN 键或重新插拔 USB）`)
        }
      }
    }

    onProgress(100, '✅ 烧录完成！')
    onLog('===== 烧录完成！ =====')
    return { success: true }
  } catch (err) {
    onLog(`❌ 烧录失败: ${err.message}`)
    console.error('[FLASH] 烧录失败:', err)
    return { success: false, error: err.message }
  } finally {
    flushTermBuf()
    try { await transport.disconnect() } catch (e) { /* ignore */ }
  }
}

/**
 * 擦除 Flash
 */
async function eraseFlashChip(portPath, onProgress, onLog) {
  await loadEsptool()

  onLog('===== 开始擦除 Flash =====')
  onProgress(5, '正在初始化...')

  let termBuf = ''
  function flush() { if (termBuf.length > 0) { onLog(termBuf); termBuf = '' } }
  function tw(data) {
    if (typeof data !== 'string' || data.length === 0) return
    if (data.includes('\n')) {
      const p = data.split('\n')
      for (let i = 0; i < p.length - 1; i++) { termBuf += p[i]; flush() }
      termBuf += p[p.length - 1]
    } else { termBuf += data }
    if (termBuf.length >= 256) flush()
  }

  const transport = new SerialPortTransport(portPath, 115200)
  const esploader = new ESPLoader({
    transport,
    baudrate: 115200,
    terminal: {
      clean: () => { termBuf = '' },
      writeLine: (data) => { flush(); onLog(data) },
      write: (data) => tw(data)
    }
  })

  try {
    onLog('正在连接芯片...')
    onProgress(10, '正在连接芯片...')
    const chipName = await Promise.race([
      esploader.main('usb_reset'),  // ESP32-C3 USB-JTAG-Serial 复位
      new Promise((_, reject) => setTimeout(() => reject(new Error('连接超时(120s)')), 120000))
    ])
    onLog(`✅ 检测到芯片: ${chipName}`)

    onLog('正在擦除 Flash（可能需要数十秒）...')
    onProgress(20, '正在擦除 Flash...')
    await esploader.eraseFlash()
    onLog('擦除完成')

    onLog('正在复位设备...')
    onProgress(90, '正在复位设备...')
    try {
      // 通过 ESP_FLASH_END 命令（reboot=1）告诉 stub 重启
      onLog('发送重启命令 (ESP_FLASH_END)...')
      await esploader.flashFinish(true, 5000)
      onLog('设备已复位（软件复位）')
    } catch (e) {
      if (e.message && (e.message.includes('timeout') || e.message.includes('serial') || e.message.includes('no data'))) {
        onLog('设备已复位（芯片重启中...）')
      } else {
        onLog(`软件复位失败: ${e.message}`)
        try {
          onLog('尝试 RTS 硬复位...')
          await esploader.after('hard_reset', true)
          onLog('设备已复位（RTS 硬复位）')
        } catch (e2) {
          onLog(`RTS 硬复位失败: ${e2.message}，请手动复位设备（按 EN 键或重新插拔 USB）`)
        }
      }
    }

    onProgress(100, '✅ 擦除完成！')
    onLog('===== 擦除完成！ =====')
    return { success: true }
  } catch (err) {
    onLog(`❌ 擦除失败: ${err.message}`)
    console.error('[FLASH] 擦除失败:', err)
    return { success: false, error: err.message }
  } finally {
    flush()
    try { await transport.disconnect() } catch (e) { /* ignore */ }
  }
}

module.exports = { flashFirmware, eraseFlashChip }
