// serialport-transport.js
// 为 esptool-js 提供 Node.js serialport 适配层
// 替代 WebSerial Transport，避免 Electron WebSerial 崩溃

const { SerialPort } = require('serialport')

const SLIP_END = 0xc0
const SLIP_ESC = 0xdb
const SLIP_ESC_END = 0xdc
const SLIP_ESC_ESC = 0xdd

class SerialPortTransport {
  constructor(portPath, baudRate = 115200) {
    this.portPath = portPath
    this.baudrate = baudRate
    this.port = null
    this.buffer = Buffer.alloc(0)
    this._DTR_state = false
    this.tracing = false  // 正常模式
    this.onDeviceLostCallback = null
    this.reader = null
    this.traceLog = ''
    this.lastTraceTime = Date.now()
    this.slipReaderEnabled = true

    // 绑定方法
    this._onData = this._onData.bind(this)
    this._onError = this._onError.bind(this)
    this._onClose = this._onClose.bind(this)
  }

  // === 日志 ===

  trace(msg) {
    if (!this.tracing) return
    const delta = Date.now() - this.lastTraceTime
    console.log(`TRACE ${delta.toFixed(3)} ${msg}`)
  }

  getInfo() {
    return `SerialPort ${this.portPath} @ ${this.baudrate}bps`
  }

  getPid() {
    // 通过 productId 识别 ESP32-C3 USB-JTAG (0x1001)
    // serialport 不直接提供 USB PID，这里返回 undefined 走 classic reset
    return undefined
  }

  // === 连接管理 ===

  async connect(baud, serialOptions) {
    const rate = baud || this.baudrate
    this.baudrate = rate

    return new Promise((resolve, reject) => {
      this.port = new SerialPort({
        path: this.portPath,
        baudRate: rate,
        autoOpen: false
      })

      this.port.open((err) => {
        if (err) return reject(err)
        this.port.on('data', this._onData)
        this.port.on('error', this._onError)
        this.port.on('close', this._onClose)
        resolve()
      })
    })
  }

  async disconnect() {
    return new Promise((resolve) => {
      if (!this.port || !this.port.isOpen) return resolve()
      this.port.removeAllListeners()
      this.port.close(() => resolve())
      this.port = null
    })
  }

  readLoop() {
    // serialport 使用事件驱动读取，'data' 事件已在 connect 中注册
    this.trace('readLoop started (serialport event-driven)')
  }

  waitForUnlock(timeout) {
    // serialport 不需要等待流解锁
    return Promise.resolve()
  }

  // === 数据收发 ===

  _onData(data) {
    this.buffer = Buffer.concat([this.buffer, data])
  }

  _onError(err) {
    console.error('[SerialPortTransport] 串口错误:', err.message)
    if (this.onDeviceLostCallback) {
      this.onDeviceLostCallback()
    }
  }

  _onClose() {
    this.trace('串口已关闭')
  }

  flushInput() {
    this.buffer = Buffer.alloc(0)
  }

  async flushOutput() {
    if (this.port && this.port.isOpen) {
      return new Promise((resolve) => {
        this.port.flush(() => resolve())
      })
    }
  }

  inWaiting() {
    return this.buffer.length
  }

  peek() {
    return this.buffer
  }

  // === SLIP 编解码（与 esptool-js webserial.js 保持一致）===

  slipWriter(data) {
    const outData = []
    outData.push(SLIP_END)
    for (let i = 0; i < data.length; i++) {
      if (data[i] === SLIP_ESC) {
        outData.push(SLIP_ESC, SLIP_ESC_ESC)
      } else if (data[i] === SLIP_END) {
        outData.push(SLIP_ESC, SLIP_ESC_END)
      } else {
        outData.push(data[i])
      }
    }
    outData.push(SLIP_END)
    return Buffer.from(outData)
  }

  async write(data) {
    const outData = this.slipWriter(data)
    this.trace(`Write ${outData.length} bytes: ${this.hexConvert(outData)}`)
    return new Promise((resolve, reject) => {
      if (!this.port || !this.port.isOpen) {
        return reject(new Error('串口未打开'))
      }
      this.port.write(outData, (err) => {
        if (err) return reject(err)
        this.port.drain((drainErr) => {
          if (drainErr) return reject(drainErr)
          resolve()
        })
      })
    })
  }

  /**
   * 从缓冲区读取一个完整的 SLIP 数据包（与 esptool-js read() 行为一致）
   */
  async read(timeout = 3000) {
    let partialPacket = null
    let isEscaping = false

    const startTime = Date.now()

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // 等待缓冲区有数据（轮询，每次 5ms）
      while (this.buffer.length === 0 && Date.now() - startTime < timeout) {
        await this._sleep(5)
      }

      if (this.buffer.length === 0) {
        const msg = partialPacket === null
          ? 'Serial data stream stopped: Possible serial noise or corruption.'
          : 'No serial data received.'
        throw new Error(msg)
      }

      // 取出所有可用数据
      const readBytes = this.buffer
      this.buffer = Buffer.alloc(0)
      this.trace(`Read ${readBytes.length} bytes from buffer`)

      for (let i = 0; i < readBytes.length; i++) {
        const byte = readBytes[i]

        if (partialPacket === null) {
          if (byte === SLIP_END) {
            partialPacket = Buffer.alloc(0)
          } else {
            throw new Error(`Invalid head of packet (0x${byte.toString(16)}): Possible serial noise or corruption.`)
          }
        } else if (isEscaping) {
          isEscaping = false
          if (byte === SLIP_ESC_END) {
            partialPacket = Buffer.concat([partialPacket, Buffer.from([SLIP_END])])
          } else if (byte === SLIP_ESC_ESC) {
            partialPacket = Buffer.concat([partialPacket, Buffer.from([SLIP_ESC])])
          } else {
            throw new Error(`Invalid SLIP escape (0xdb, 0x${byte.toString(16)})`)
          }
        } else if (byte === SLIP_END) {
          this.trace(`SLIP packet complete: ${partialPacket.length} bytes`)
          // 将剩余未处理字节放回缓冲区（芯片可能一次返回多个响应包）
          if (i + 1 < readBytes.length) {
            const remaining = readBytes.slice(i + 1)
            this.buffer = Buffer.concat([Buffer.from(remaining), this.buffer])
            this.trace(`  Pushed ${remaining.length} remaining bytes back to buffer`)
          }
          return partialPacket  // 完整数据包
        } else if (byte === SLIP_ESC) {
          isEscaping = true
        } else {
          partialPacket = Buffer.concat([partialPacket, Buffer.from([byte])])
        }
      }
      // 未找到完整数据包，继续等待更多数据
    }
  }

  // === 控制信号 ===

  async setRTS(state) {
    return new Promise((resolve, reject) => {
      if (!this.port || !this.port.isOpen) return resolve()
      this.port.set({ rts: state }, (err) => {
        if (err) return reject(err)
        // 模拟 esptool-js 的 Windows 兼容处理
        this.setDTR(this._DTR_state).then(resolve).catch(reject)
      })
    })
  }

  async setDTR(state) {
    this._DTR_state = state
    return new Promise((resolve, reject) => {
      if (!this.port || !this.port.isOpen) return resolve()
      this.port.set({ dtr: state }, (err) => {
        if (err) return reject(err)
        resolve()
      })
    })
  }

  // === 辅助 ===

  hexConvert(data) {
    const hex = []
    for (let i = 0; i < Math.min(data.length, 32); i++) {
      hex.push(data[i].toString(16).padStart(2, '0'))
    }
    if (data.length > 32) hex.push('...')
    return hex.join(' ')
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  appendArray(arr1, arr2) {
    return Buffer.concat([arr1, arr2])
  }

  setDeviceLostCallback(cb) {
    this.onDeviceLostCallback = cb
  }
}

module.exports = { SerialPortTransport }
