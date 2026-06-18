const { contextBridge, ipcRenderer } = require('electron')

// 暴露安全的 API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // 串口操作
  listPorts: () => ipcRenderer.invoke('list-ports'),
  openPort: (path, baudRate) => ipcRenderer.invoke('open-port', { path, baudRate }),
  closePort: () => ipcRenderer.invoke('close-port'),
  sendCommand: (cmd) => ipcRenderer.invoke('send-command', cmd),
  requestData: () => ipcRenderer.invoke('request-data'),
  isPortOpen: () => ipcRenderer.invoke('is-port-open'),

  // 窗口操作
  openCurveWindow: () => ipcRenderer.invoke('open-curve-window'),
  openFirmwareWindow: () => ipcRenderer.invoke('open-firmware-window'),

  // 文件对话框
  saveDialog: (defaultName, filters) => ipcRenderer.invoke('save-dialog', { defaultName, filters }),
  saveImageDialog: (defaultName) => ipcRenderer.invoke('save-image-dialog', { defaultName }),
  saveImageFile: (filePath, dataUrl) => ipcRenderer.invoke('save-image-file', { filePath, dataUrl }),
  saveLogFile: (filePath, content) => ipcRenderer.invoke('save-log-file', { filePath, content }),

  // 事件监听
  onSerialData: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('serial-data', listener)
    return () => ipcRenderer.removeListener('serial-data', listener)
  },

  onMeterData: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('meter-data', listener)
    return () => ipcRenderer.removeListener('meter-data', listener)
  },

  onSerialError: (callback) => {
    const listener = (event, error) => callback(error)
    ipcRenderer.on('serial-error', listener)
    return () => ipcRenderer.removeListener('serial-error', listener)
  },

  onSerialClosed: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('serial-closed', listener)
    return () => ipcRenderer.removeListener('serial-closed', listener)
  },

  onCurveWindowClosed: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('curve-window-closed', listener)
    return () => ipcRenderer.removeListener('curve-window-closed', listener)
  },

  // 菜单事件
  onMenuSaveLog: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('menu-save-log', listener)
    return () => ipcRenderer.removeListener('menu-save-log', listener)
  },

  onMenuRefreshPorts: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('menu-refresh-ports', listener)
    return () => ipcRenderer.removeListener('menu-refresh-ports', listener)
  },

  // 曲线窗口菜单事件
  onMenuSaveImage: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('menu-save-image', listener)
    return () => ipcRenderer.removeListener('menu-save-image', listener)
  },

  onMenuSaveData: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('menu-save-data', listener)
    return () => ipcRenderer.removeListener('menu-save-data', listener)
  },

  onMenuResetView: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('menu-reset-view', listener)
    return () => ipcRenderer.removeListener('menu-reset-view', listener)
  },

  // 主题
  getTheme: () => ipcRenderer.invoke('get-theme'),
  getLastPort: () => ipcRenderer.invoke('get-last-port'),
  getLastBaudRate: () => ipcRenderer.invoke('get-last-baudrate'),
  onThemeChanged: (callback) => {
    const listener = (event, theme) => callback(theme)
    ipcRenderer.on('theme-changed', listener)
    return () => ipcRenderer.removeListener('theme-changed', listener)
  },

  // 操作日志
  getOperationLogs: () => ipcRenderer.invoke('get-operation-logs'),
  exportOperationLog: (filePath) => ipcRenderer.invoke('export-operation-log', { filePath }),

  // 固件更新
  openFirmwareDialog: () => ipcRenderer.invoke('open-firmware-dialog'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  releaseMainPort: () => ipcRenderer.invoke('release-main-port'),

  // 固件更新（主进程烧录 — 新方案）
  firmwareListPorts: () => ipcRenderer.invoke('firmware:list-ports'),
  firmwareStartFlash: (params) => ipcRenderer.invoke('firmware:start-flash', params),
  firmwareEraseFlash: (params) => ipcRenderer.invoke('firmware:erase-flash', params),
  firmwareStop: () => ipcRenderer.invoke('firmware:stop'),

  // 固件更新事件
  onFirmwareLog: (callback) => {
    const listener = (_event, msg) => callback(msg)
    ipcRenderer.on('firmware:log', listener)
    return () => ipcRenderer.removeListener('firmware:log', listener)
  },
  onFirmwareProgress: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('firmware:progress', listener)
    return () => ipcRenderer.removeListener('firmware:progress', listener)
  },
  onFirmwareComplete: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('firmware:complete', listener)
    return () => ipcRenderer.removeListener('firmware:complete', listener)
  },
})

