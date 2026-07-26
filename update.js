/**
 * update.js - 应用自动更新模块
 * 通过 GitHub Releases API 检查更新，IPC 推送进度到渲染进程
 * 支持绿色免安装版(win-unpacked)和单文件便携版(portable)
 */

const { app, dialog, BrowserWindow, shell, ipcMain, net, session } = require('electron')
const path = require('path')
const fs = require('fs')
const { exec } = require('child_process')
const os = require('os')

// ==================== 配置 ====================

const GITHUB_OWNER = 'BaiHengRui'
const GITHUB_REPO = 'ESP32C3_USB_METER_Host'
const GITHUB_API_LATEST = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
const CHECK_DELAY_MS = 2000

// GitHub 下载镜像站（按优先级排列，格式: `${mirror}/${原始URL}`）
const DOWNLOAD_MIRRORS = [
  'https://ghproxy.net',
  'https://moeyy.cn/gh-proxy',
  ''   // 直连 GitHub（兜底，空字符串）
]

// IPC 事件名
const IPC = {
  UPDATE_AVAILABLE: 'update-available',
  DOWNLOAD_PROGRESS: 'update-download-progress',
  DOWNLOAD_COMPLETE: 'update-download-complete',
  UPDATE_ERROR: 'update-error'
}

// 下载取消控制
let cancelDownload = false
let activeDownloadRequest = null

// ==================== 工具函数 ====================

async function httpsGet(url) {
  const response = await net.fetch(url, {
    headers: { 'User-Agent': 'ESP32-Meter-Updater' }
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.json()
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    cancelDownload = false
    activeDownloadRequest = null

    console.log(`[UPDATE] 下载文件: ${url}`)
    console.log(`[UPDATE] 保存路径: ${destPath}`)

    const file = fs.createWriteStream(destPath)

    // 使用 Electron net 模块（走 Chromium 代理设置，Clash 生效）
    const request = net.request({
      method: 'GET',
      url: url,
      redirect: 'follow'
    })
    request.setHeader('User-Agent', 'ESP32-Meter-Updater')

    activeDownloadRequest = request

    let totalSize = 0
    let downloaded = 0
    let lastTime = Date.now()
    let lastDownloaded = 0
    let speedSamples = []

    request.on('response', (response) => {
      console.log(`[UPDATE] 响应状态: HTTP ${response.statusCode}`)
      console.log(`[UPDATE] Content-Length: ${response.headers['content-length'] || '未知'}`)

      if (cancelDownload) {
        file.close()
        try { fs.unlinkSync(destPath) } catch (_) { /* ignore */ }
        return reject(new Error('用户取消下载'))
      }

      if (response.statusCode !== 200) {
        file.close()
        try { fs.unlinkSync(destPath) } catch (_) { /* ignore */ }
        return reject(new Error(`下载失败 HTTP ${response.statusCode}`))
      }

      totalSize = parseInt(response.headers['content-length'] || '0', 10) || 0

      response.on('data', (chunk) => {
        if (cancelDownload) {
          request.abort()
          file.close()
          try { fs.unlinkSync(destPath) } catch (_) { /* ignore */ }
          return
        }

        file.write(chunk)
        downloaded += chunk.length

        if (onProgress && totalSize > 0) {
          const now = Date.now()
          const timeDiff = (now - lastTime) / 1000

          if (timeDiff >= 0.5) {
            const bytesDiff = downloaded - lastDownloaded
            const instantSpeed = bytesDiff / timeDiff
            speedSamples.push(instantSpeed)
            if (speedSamples.length > 10) speedSamples.shift()
            const avgSpeed = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length

            const percent = Math.round((downloaded / totalSize) * 100)
            const remaining = avgSpeed > 0 ? (totalSize - downloaded) / avgSpeed : 0

            onProgress({
              percent,
              downloaded,
              total: totalSize,
              speed: avgSpeed,
              remainingSeconds: Math.round(remaining)
            })

            lastTime = now
            lastDownloaded = downloaded
          }
        }
      })

      response.on('end', () => {
        file.close()
        activeDownloadRequest = null
        console.log(`[UPDATE] 文件下载完成: ${formatSize(downloaded)} (${downloaded} bytes)`)
        resolve(destPath)
      })

      response.on('error', (err) => {
        file.close()
        try { fs.unlinkSync(destPath) } catch (_) { /* ignore */ }
        activeDownloadRequest = null
        reject(err)
      })
    })

    request.on('error', (err) => {
      file.close()
      try { fs.unlinkSync(destPath) } catch (_) { /* ignore */ }
      activeDownloadRequest = null
      reject(err)
    })

    request.end()
  })
}

function compareVersions(v1, v2) {
  const clean1 = v1.replace(/^[Vv]/, '')
  const clean2 = v2.replace(/^[Vv]/, '')
  const parts1 = clean1.split('.').map(Number)
  const parts2 = clean2.split('.').map(Number)
  const maxLen = Math.max(parts1.length, parts2.length)
  for (let i = 0; i < maxLen; i++) {
    const a = parts1[i] || 0
    const b = parts2[i] || 0
    if (a > b) return 1
    if (a < b) return -1
  }
  return 0
}

function detectAppFormat() {
  // electron-builder portable 模式会设置此环境变量（最可靠）
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    console.log(`[UPDATE] 检测为便携版 (PORTABLE_EXECUTABLE_FILE=${process.env.PORTABLE_EXECUTABLE_FILE})`)
    return 'portable'
  }
  // 备选：检查是否运行在 .mount- 临时目录（便携版自解压特征）
  const exePath = app.getPath('exe')
  const tempDir = os.tmpdir()
  if (exePath.startsWith(tempDir) && exePath.includes('.mount-')) {
    console.log(`[UPDATE] 检测为便携版 (.mount- 特征, exePath=${exePath})`)
    return 'portable'
  }
  console.log(`[UPDATE] 检测为免安装版 (exePath=${exePath})`)
  return 'unpacked'
}

function getAppRootDir() {
  const appPath = app.getAppPath()
  // 打包后路径: win-unpacked/resources/app.asar → 需要回到 win-unpacked/
  if (appPath.endsWith('.asar')) {
    return path.dirname(path.dirname(appPath))
  }
  return appPath
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024) return Math.round(bytesPerSec) + ' B/s'
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s'
  return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s'
}

function formatTime(seconds) {
  if (seconds <= 0) return '计算中...'
  if (seconds < 60) return `${seconds}秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
  return `${Math.floor(seconds / 3600)}时${Math.floor((seconds % 3600) / 60)}分`
}

function getMainWindow() {
  const windows = BrowserWindow.getAllWindows()
  return windows.find(w => !w.isDestroyed() && w.title.includes('上位机')) || windows[0]
}

// ==================== 核心逻辑 ====================

/**
 * 诊断当前代理配置（帮助排查 Clash 不生效问题）
 */
async function diagnoseProxy() {
  try {
    const proxy = await session.defaultSession.resolveProxy('https://api.github.com')
    console.log(`[UPDATE] 当前代理配置: ${proxy || 'DIRECT (无代理)'}`)
    if (proxy === 'DIRECT' || !proxy) {
      console.log('[UPDATE] ⚠️ 未检测到代理。如果用 Clash，请确保:')
      console.log('[UPDATE]    1. Clash 开启「系统代理」模式')
      console.log('[UPDATE]    2. Clash 在启动本程序之前已运行')
      console.log('[UPDATE]    3. 代理规则覆盖 github.com / api.github.com')
    }
  } catch (e) {
    console.log('[UPDATE] 代理检测失败:', e.message)
  }
}

async function fetchLatestRelease() {
  console.log(`[UPDATE] 请求 API: ${GITHUB_API_LATEST}`)
  await diagnoseProxy()

  try {
    const release = await httpsGet(GITHUB_API_LATEST)

    if (!release) {
      console.log('[UPDATE] API 返回空')
      return null
    }

    console.log(`[UPDATE] Release: tag=${release.tag_name}, draft=${release.draft}, prerelease=${release.prerelease}`)

    if (release.draft || release.prerelease) {
      console.log('[UPDATE] 跳过草稿/预发布版本')
      return null
    }

    const remoteVersion = release.tag_name.replace(/^[Vv]/, '')
    const localVersion = app.getVersion()

    console.log(`[UPDATE] 版本比较: 远程=${remoteVersion} vs 本地=${localVersion}`)

    if (compareVersions(remoteVersion, localVersion) <= 0) {
      console.log('[UPDATE] 已是最新版本')
      return { hasUpdate: false }
    }

    const assets = release.assets.map(a => {
      console.log(`[UPDATE]   Asset: ${a.name} (${formatSize(a.size)})`)
      return { name: a.name, url: a.browser_download_url, size: a.size }
    })

    return {
      hasUpdate: true,
      version: remoteVersion,
      tagName: release.tag_name,
      body: release.body || '',
      htmlUrl: release.html_url,
      assets
    }
  } catch (err) {
    console.error('[UPDATE] 检查更新失败:', err.message)
    return null
  }
}

function selectAsset(assets, appFormat) {
  if (appFormat === 'portable') {
    return assets.find(a => a.name.toLowerCase().includes('portable') && a.name.endsWith('.exe'))
  }
  return assets.find(a => a.name.endsWith('.zip'))
}

async function doDownloadAndReplace(asset, appFormat) {
  const tmpDir = os.tmpdir()
  const tmpFile = path.join(tmpDir, asset.name)
  const win = getMainWindow()

  // GitHub 镜像站 + 直连
  const sources = DOWNLOAD_MIRRORS.map(mirror => ({
    label: mirror ? mirror.replace('https://', '') : '直连',
    url: mirror ? `${mirror}/${asset.url}` : asset.url
  }))

  let lastError = null

  for (let i = 0; i < sources.length; i++) {
    const { label, url: downloadUrl } = sources[i]

    console.log(`[UPDATE] 尝试下载 [${i + 1}/${sources.length}]: ${label}`)
    console.log(`[UPDATE] URL: ${downloadUrl}`)

    // 如果是重试，通知前端
    if (i > 0 && win && !win.isDestroyed()) {
      win.webContents.send(IPC.DOWNLOAD_PROGRESS, {
        percent: 0,
        speed: `${label} 重试中...`,
        remaining: '',
        status: 'retry'
      })
    }

    try {
      await downloadFile(downloadUrl, tmpFile, (progress) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.DOWNLOAD_PROGRESS, {
            percent: progress.percent,
            downloaded: progress.downloaded,
            total: progress.total,
            speed: formatSpeed(progress.speed),
            remaining: formatTime(progress.remainingSeconds),
            downloadedStr: formatSize(progress.downloaded),
            totalStr: formatSize(progress.total)
          })
        }
      })

      console.log(`[UPDATE] 下载完成 (${label})`)
      break // 下载成功，退出循环

    } catch (err) {
      if (err.message === '用户取消下载') {
        console.log('[UPDATE] 下载已取消')
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.UPDATE_ERROR, { message: '下载已取消' })
        }
        return
      }

      lastError = err
      console.error(`[UPDATE] ${label} 失败:`, err.message)

      // 清理失败的临时文件
      try { fs.unlinkSync(tmpFile) } catch (_) { /* ignore */ }

      // 如果不是最后一个源，继续尝试下一个
      if (i < sources.length - 1) {
        // 重置取消标记（可能上次请求超时触发了取消逻辑）
        cancelDownload = false
        continue
      }
    }
  }

  // 所有镜像都失败
  if (lastError) {
    console.error('[UPDATE] 所有下载源均失败:', lastError.message)

    let errMsg = lastError.message
    if (lastError.message.includes('ETIMEDOUT') || lastError.message.includes('ECONNREFUSED') || lastError.message.includes('ENOTFOUND')) {
      errMsg = '所有下载方式均无法连接，请检查网络后重试。'
    }

    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.UPDATE_ERROR, { message: errMsg })
    }
    return
  }

  console.log('[UPDATE] 下载完成')

  // 推送处理状态
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.DOWNLOAD_PROGRESS, {
      percent: 100,
      speed: '正在处理...',
      remaining: '',
      status: 'processing'
    })
  }

  try {
    if (appFormat === 'unpacked') {
      await handleUnpackedUpdate(tmpFile, win)
    } else {
      await handlePortableUpdate(tmpFile, asset.name, win)
    }
  } catch (err) {
    console.error('[UPDATE] 更新处理失败:', err.message)
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.UPDATE_ERROR, { message: `更新处理失败: ${err.message}` })
    }
    try { fs.unlinkSync(tmpFile) } catch (_) { /* ignore */ }
  }
}

async function handleUnpackedUpdate(zipPath, win) {
  const appRoot = getAppRootDir()
  const extractDir = path.join(os.tmpdir(), `esp32_meter_update_${Date.now()}`)
  const scriptFile = path.join(os.tmpdir(), 'esp32_meter_updater.ps1')

  console.log(`[UPDATE] ===== 免安装版更新 =====`)
  console.log(`[UPDATE] ZIP 文件: ${zipPath}`)
  console.log(`[UPDATE] 解压目录: ${extractDir}`)
  console.log(`[UPDATE] 应用根目录: ${appRoot}`)

  // 清理旧的解压目录
  try {
    const tmpDir = os.tmpdir()
    const oldDirs = fs.readdirSync(tmpDir).filter(d => d.startsWith('esp32_meter_update_'))
    for (const old of oldDirs) {
      try { fs.rmSync(path.join(tmpDir, old), { recursive: true, force: true }) } catch (_) {}
    }
  } catch (_) {}

  console.log('[UPDATE] 正在解压更新包...')

  await new Promise((resolve, reject) => {
    exec(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
      { timeout: 120000 },
      (error, stdout, stderr) => {
        if (stdout) console.log(`[UPDATE] 解压输出: ${stdout.trim()}`)
        if (stderr) console.log(`[UPDATE] 解压 stderr: ${stderr.trim()}`)
        if (error) reject(new Error(`解压失败: ${error.message}`))
        else resolve()
      }
    )
  })

  console.log('[UPDATE] 解压完成')

  // PowerShell 更新脚本（无编码问题）
  const psContent = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
$host.UI.RawUI.WindowTitle = 'ESP32 USB Meter - Updating'
Write-Host '============================================'
Write-Host ' ESP32 USB Meter - Auto Update'
Write-Host '============================================'
Write-Host ''
Write-Host "Source : ${extractDir}"
Write-Host "Target : ${appRoot}"
Write-Host ''
Write-Host 'Waiting for app to exit...'
Start-Sleep -Seconds 2

$retry = 0
while ($retry -lt 5) {
    $retry++
    Write-Host "Attempt $retry - Replacing files..."
    try {
        Copy-Item -Path "${extractDir}\\*" -Destination "${appRoot}\\" -Recurse -Force -ErrorAction Stop
        Write-Host 'Update complete! Starting new version...'
        Remove-Item -Path "${extractDir}" -Recurse -Force -ErrorAction SilentlyContinue
        Start-Process -FilePath "${appRoot}\\ESP32USB_Meter_Host.exe"
        Remove-Item -LiteralPath "${scriptFile}" -Force -ErrorAction SilentlyContinue
        exit 0
    } catch {
        Write-Host "Failed: $_"
        if ($retry -lt 5) {
            Write-Host 'Retrying in 2s...'
            Start-Sleep -Seconds 2
        }
    }
}
Write-Host 'Update FAILED after 5 attempts!'
Read-Host 'Press Enter to exit'
`

  fs.writeFileSync(scriptFile, '\ufeff' + psContent, 'utf8')
  console.log(`[UPDATE] PowerShell 脚本已生成: ${scriptFile}`)

  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.DOWNLOAD_COMPLETE, {
      appFormat: 'unpacked',
      scriptFile
    })
  }
}

async function handlePortableUpdate(exePath, exeName, win) {
  const originalExe = process.env.PORTABLE_EXECUTABLE_FILE
  const scriptFile = path.join(os.tmpdir(), 'esp32_meter_portable_updater.ps1')

  console.log(`[UPDATE] ===== 便携版更新 =====`)
  console.log(`[UPDATE] 新文件: ${exePath}`)
  console.log(`[UPDATE] 原始文件: ${originalExe || '(未检测到)'}`)

  if (!originalExe || !fs.existsSync(originalExe)) {
    const downloadsDir = app.getPath('downloads')
    const destPath = path.join(downloadsDir, exeName)
    console.log(`[UPDATE] 无法定位原始 exe，保存到: ${destPath}`)
    fs.copyFileSync(exePath, destPath)

    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.DOWNLOAD_COMPLETE, {
        appFormat: 'portable',
        filePath: destPath,
        fileName: exeName
      })
    }
    return
  }

  // PowerShell 更新脚本
  const psContent = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
$host.UI.RawUI.WindowTitle = 'ESP32 USB Meter - Updating'
Write-Host '============================================'
Write-Host ' ESP32 USB Meter - Portable Update'
Write-Host '============================================'
Write-Host ''
Write-Host "New    : ${exePath}"
Write-Host "Target : ${originalExe}"
Write-Host ''
Write-Host 'Waiting for app to exit...'
Start-Sleep -Seconds 2

$retry = 0
while ($retry -lt 5) {
    $retry++
    Write-Host "Attempt $retry - Replacing..."
    try {
        Move-Item -Path "${exePath}" -Destination "${originalExe}" -Force -ErrorAction Stop
        Write-Host 'Update complete! Starting new version...'
        Start-Process -FilePath "${originalExe}"
        Remove-Item -LiteralPath "${scriptFile}" -Force -ErrorAction SilentlyContinue
        exit 0
    } catch {
        Write-Host "Failed: $_"
        if ($retry -lt 5) {
            Write-Host 'Retrying in 2s...'
            Start-Sleep -Seconds 2
        }
    }
}
Write-Host 'Update FAILED after 5 attempts!'
Write-Host "New exe is at: ${exePath}"
Read-Host 'Press Enter to exit'
`

  fs.writeFileSync(scriptFile, '\ufeff' + psContent, 'utf8')
  console.log(`[UPDATE] PowerShell 脚本已生成: ${scriptFile}`)

  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.DOWNLOAD_COMPLETE, {
      appFormat: 'portable',
      scriptFile
    })
  }
}

// ==================== IPC 注册 ====================

function registerUpdateIPC() {
  console.log('[UPDATE] 注册 IPC 处理器...')

  // 渲染进程触发：开始下载更新
  ipcMain.handle('start-update', async () => {
    console.log('[UPDATE] IPC: start-update 被调用')
    const releaseInfo = await fetchLatestRelease()
    if (!releaseInfo || !releaseInfo.hasUpdate) {
      console.log('[UPDATE] IPC: 无可用更新')
      return { success: false, error: '无可用更新' }
    }

    const appFormat = detectAppFormat()
    const asset = selectAsset(releaseInfo.assets, appFormat)
    if (!asset) {
      console.log(`[UPDATE] IPC: 未找到匹配资产 (format=${appFormat})`)
      return { success: false, error: `未找到匹配的更新包 (${appFormat})` }
    }

    console.log(`[UPDATE] IPC: 开始异步下载 ${asset.name}`)
    // 异步执行下载，不阻塞 IPC 返回
    doDownloadAndReplace(asset, appFormat)
    return { success: true }
  })

  // 渲染进程触发：取消下载
  ipcMain.handle('cancel-update', async () => {
    console.log('[UPDATE] IPC: cancel-update 被调用')
    cancelDownload = true
    if (activeDownloadRequest) {
      activeDownloadRequest.abort()
      activeDownloadRequest = null
    }
    return { success: true }
  })

  // 渲染进程触发：重启应用
  ipcMain.handle('restart-app', async () => {
    console.log('[UPDATE] IPC: restart-app 被调用')
    // 查找可用的更新脚本（PowerShell .ps1）
    const scriptFiles = [
      path.join(os.tmpdir(), 'esp32_meter_updater.ps1'),
      path.join(os.tmpdir(), 'esp32_meter_portable_updater.ps1')
    ]
    const scriptFile = scriptFiles.find(f => fs.existsSync(f))

    if (scriptFile) {
      console.log(`[UPDATE] 执行更新脚本: ${scriptFile}`)
      // 分离进程启动脚本，然后立即退出应用
      const child = exec(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`,
        { detached: true, windowsHide: false },
        (err) => { if (err) console.error('[UPDATE] 脚本启动错误:', err.message) }
      )
      child.unref()
      // 立即退出，不等待脚本完成
      setImmediate(() => app.exit(0))
    } else {
      console.log('[UPDATE] 更新脚本不存在，直接重启')
      app.relaunch()
      app.exit(0)
    }
  })

  // 渲染进程触发：打开文件夹
  ipcMain.handle('open-update-folder', async (event, filePath) => {
    console.log(`[UPDATE] IPC: 打开文件夹 ${filePath}`)
    shell.showItemInFolder(filePath)
  })

  // 渲染进程触发：打开 GitHub 发布页
  ipcMain.handle('open-release-page', async () => {
    console.log('[UPDATE] IPC: 打开发布页')
    const releaseInfo = await fetchLatestRelease()
    if (releaseInfo && releaseInfo.htmlUrl) {
      shell.openExternal(releaseInfo.htmlUrl)
    } else {
      shell.openExternal(`https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`)
    }
  })

  console.log('[UPDATE] IPC 处理器注册完成')
}

// ==================== 导出接口 ====================

async function checkForUpdatesSilently() {
  console.log('[UPDATE] 正在检查更新...')
  const releaseInfo = await fetchLatestRelease()

  if (!releaseInfo) {
    console.log('[UPDATE] 检查更新失败或网络不可用')
    return
  }

  if (!releaseInfo.hasUpdate) {
    console.log(`[UPDATE] 当前已是最新版本 v${app.getVersion()}`)
    return
  }

  console.log(`[UPDATE] ===== 发现新版本 v${releaseInfo.version} =====`)
  console.log(`[UPDATE] 更新日志:\n${releaseInfo.body}`)

  const appFormat = detectAppFormat()
  console.log(`[UPDATE] 当前应用格式: ${appFormat}`)

  const asset = selectAsset(releaseInfo.assets, appFormat)
  console.log(`[UPDATE] 选中资产: ${asset ? asset.name : '无'}`)

  if (!asset) {
    console.error('[UPDATE] 未找到匹配的下载资产')
    return
  }

  console.log(`[UPDATE] 发送 update-available IPC 到渲染进程...`)

  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.UPDATE_AVAILABLE, {
      currentVersion: app.getVersion(),
      version: releaseInfo.version,
      body: releaseInfo.body,
      htmlUrl: releaseInfo.htmlUrl,
      appFormat,
      assetName: asset.name,
      assetSize: formatSize(asset.size)
    })
    console.log('[UPDATE] IPC 已发送')
  } else {
    console.log('[UPDATE] 警告: 未找到主窗口')
  }
}

async function checkForUpdatesManually() {
  console.log('[UPDATE] ===== 手动检查更新 =====')
  const releaseInfo = await fetchLatestRelease()

  if (!releaseInfo) {
    console.log('[UPDATE] 手动检查失败')
    dialog.showErrorBox('检查更新失败', '无法连接到 GitHub，请检查网络后重试。')
    return
  }

  if (!releaseInfo.hasUpdate) {
    console.log(`[UPDATE] 手动检查: 已是最新版本 v${app.getVersion()}`)
    await dialog.showMessageBox({
      type: 'info',
      title: '检查更新',
      message: '当前已是最新版本',
      detail: `版本: v${app.getVersion()}\n无需更新。`,
      buttons: ['确定'],
      noLink: true
    })
    return
  }

  console.log(`[UPDATE] 手动检查: 发现 v${releaseInfo.version}`)

  const appFormat = detectAppFormat()
  const asset = selectAsset(releaseInfo.assets, appFormat)

  if (!asset) {
    console.error(`[UPDATE] 未找到匹配资产 (format=${appFormat})`)
    dialog.showErrorBox('更新失败', `未找到适合当前版本的更新包。\n当前格式: ${appFormat}`)
    return
  }

  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.UPDATE_AVAILABLE, {
      currentVersion: app.getVersion(),
      version: releaseInfo.version,
      body: releaseInfo.body,
      htmlUrl: releaseInfo.htmlUrl,
      appFormat,
      assetName: asset.name,
      assetSize: formatSize(asset.size)
    })
  }
}

function scheduleStartupCheck() {
  console.log(`[UPDATE] 将在 ${CHECK_DELAY_MS / 1000} 秒后自动检查更新...`)
  setTimeout(() => {
    console.log('[UPDATE] 开始自动检查更新')
    checkForUpdatesSilently()
  }, CHECK_DELAY_MS)
}

module.exports = {
  registerUpdateIPC,
  checkForUpdatesSilently,
  checkForUpdatesManually,
  scheduleStartupCheck,
  detectAppFormat
}
