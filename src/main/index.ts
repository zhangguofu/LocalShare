import { app, BrowserWindow, dialog, ipcMain, shell, Notification, Menu, Tray, nativeImage, type NativeImage } from 'electron'
import path from 'node:path'
import os from 'node:os'
import dgram from 'node:dgram'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { getConfig, updateConfig, type AppConfig } from './config'
import { DiscoveryService } from './network/discovery'
import { Receiver } from './network/receiver'
import { Sender } from './network/sender'
import { walkPaths } from './network/tree'
import type { OfferSummary } from './network/receiver'
import type { TransferTarget } from '../preload'

let win: BrowserWindow | null = null
let tray: Tray | null = null // Windows 系统托盘（关窗后驻留，右键退出）
let discovery: DiscoveryService | null = null
let receiver: Receiver | null = null
const senders = new Map<string, Sender>()
let isQuitting = false // 真正退出时置位，放行窗口关闭

// 本机多实例验证/调试：LOCALSHARE_USER_DATA 隔离配置（deviceId/端口/设备名独立）
if (process.env.LOCALSHARE_USER_DATA) {
  app.setPath('userData', process.env.LOCALSHARE_USER_DATA)
}

app.on('before-quit', () => {
  isQuitting = true
})

function createWindow(): void {
  win = new BrowserWindow({
    width: 900,
    height: 640,
    title: 'LocalShare',
    autoHideMenuBar: true, // 菜单栏默认不可见（Windows/Linux），按 Alt 临时唤起；macOS 顶栏不受此选项影响
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // 关窗行为（同类驻留软件惯例）：关闭窗口 = 后台驻留，进程继续接收。
  // macOS 最小化到 Dock；Windows 隐藏到托盘（点托盘图标恢复）。
  // 彻底退出：macOS Cmd+Q；Windows 托盘右键「退出」或设置页「退出应用」（isQuitting 放行）
  win.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    if (process.platform === 'darwin') {
      win?.minimize()
    } else {
      win?.hide()
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  win.on('closed', () => {
    win = null
  })
}

// 端口被占：报错退出（规格 4.2）
function fatalPort(kind: string, port: number, err: Error): void {
  dialog.showErrorBox(
    'LocalShare 启动失败',
    `${kind}端口 ${port} 无法监听：${err.message}\n\n请在设置中修改端口后重试。`
  )
  app.exit(1)
}

// 探测端口是否空闲（设置页保存前调用，避免保存后启动失败进入死循环）
function assertUdpPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4')
    s.once('error', (e) => {
      s.close()
      reject(new Error(`UDP 端口 ${port} 已被占用：${e.message}`))
    })
    s.bind(port, () => {
      s.close()
      resolve()
    })
  })
}

function assertTcpPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', (e) => reject(new Error(`TCP 端口 ${port} 已被占用：${e.message}`)))
    srv.listen(port, () => srv.close(() => resolve()))
  })
}

// 停止全部网络服务；discovery.stop / receiver.stop 为异步（延迟关 socket 让 BYE flush），
// 通过回调让调用方（配置重启 / 退出）同步等待。
function stopServices(cb?: () => void): void {
  let remaining = 0
  const done = (): void => {
    remaining--
    if (remaining <= 0) cb?.()
  }
  if (discovery) {
    remaining++
    discovery.stop(done)
    discovery = null
  }
  if (receiver) {
    remaining++
    receiver.stop(done)
    receiver = null
  }
  if (remaining === 0) cb?.()
}

function restartServices(): void {
  // 等旧 socket 关闭（BYE flush）后再启动新服务，避免同端口 EADDRINUSE
  stopServices(() => startServices())
}

function startServices(): void {
  const cfg = getConfig()

  discovery = new DiscoveryService({
    port: cfg.udpPort,
    deviceId: cfg.deviceId,
    deviceName: cfg.deviceName,
    platform: os.platform(),
    version: app.getVersion(),
    tcpPort: cfg.tcpPort
  })
  discovery.on('deviceChange', (upd) => win?.webContents.send('devices:changed', upd))
  discovery.on('error', (err) => fatalPort('UDP 发现', cfg.udpPort, err))
  discovery.start()

  receiver = new Receiver({ port: cfg.tcpPort, saveDir: () => getConfig().saveDir })
  receiver.on('error', (err) => fatalPort('TCP 传输', cfg.tcpPort, err))
  receiver.on('offer', (offer: OfferSummary) => win?.webContents.send('transfer:offer', offer))
  receiver.on('progress', (p) => win?.webContents.send('transfer:update', { kind: 'receive-progress', ...p }))
  receiver.on('complete', (id: string, saveDir: string) => {
    win?.webContents.send('transfer:update', { kind: 'complete', transferId: id, saveDir })
    // 系统通知：点击直达目标目录（应用在后台也能快速跳转）
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'LocalShare 接收完成',
        body: `已保存到：${saveDir}`
      })
      n.on('click', () => {
        void shell.openPath(saveDir)
      })
      n.show()
    }
  })
  receiver.on('transferError', (e: { transferId: string; error: Error }) =>
    win?.webContents.send('transfer:update', { kind: 'error', transferId: e.transferId, reason: e.error.message })
  )
  receiver.start()
}

function registerIpc(): void {
  ipcMain.handle('ping', () => 'pong')
  ipcMain.handle('app:version', () => app.getVersion())
  // 设置页「退出应用」：完全退出机制的兑底入口（托盘图标可能被系统折叠）
  ipcMain.on('app:quit', () => app.quit())
  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:update', async (_e, patch: Partial<AppConfig>) => {
    // 端口变更前探测可用性，避免保存后服务启动失败（应用退出后仍读新端口 → 死循环）
    const cur = getConfig()
    if (patch.udpPort !== undefined && patch.udpPort !== cur.udpPort) {
      await assertUdpPortFree(patch.udpPort)
    }
    if (patch.tcpPort !== undefined && patch.tcpPort !== cur.tcpPort) {
      await assertTcpPortFree(patch.tcpPort)
    }
    const next = await updateConfig(patch)
    // 端口或设备名变更：动态重启服务（无需重启应用）；仅保存目录变更不重启（动态读）
    const needsRestart =
      patch.udpPort !== undefined || patch.tcpPort !== undefined || patch.deviceName !== undefined
    if (needsRestart) restartServices()
    return next
  })

  ipcMain.handle('devices:list', () => discovery?.getDevices() ?? [])

  ipcMain.handle('dialog:pick-paths', async () => {
    if (!win) return []
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'openDirectory', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('dialog:pick-directory', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('transfer:send', async (_e, target: TransferTarget, paths: string[]) => {
    let host: string
    let port: number
    if ('deviceId' in target) {
      const device = discovery?.getDevices().find((d) => d.id === target.deviceId)
      if (!device) throw new Error('设备不在线')
      host = device.host
      port = device.tcpPort
    } else {
      host = target.host
      port = target.port
    }
    const { entries, totalBytes } = await walkPaths(paths)
    if (entries.length === 0) throw new Error('没有可发送的内容（空选择或仅符号链接）')
    const name = entries.length === 1 ? entries[0].relPath : `${entries.length} 项`
    const transferId = randomUUID()
    const sender = new Sender({ senderId: getConfig().deviceId, senderName: getConfig().deviceName })
    senders.set(transferId, sender)
    sender.on('progress', (p) => win?.webContents.send('transfer:update', { kind: 'progress', ...p }))
    sender.on('complete', (c) => {
      win?.webContents.send('transfer:update', { kind: 'complete', ...c })
      senders.delete(transferId)
    })
    sender.on('failed', (f) => {
      win?.webContents.send('transfer:update', { kind: 'failed', ...f })
      senders.delete(transferId)
    })
    void sender.start({ host, port }, transferId, entries, totalBytes).catch(() => {
      // 失败已通过 'failed' 事件上报 UI
    })
    return { transferId, name, totalBytes, fileCount: entries.length }
  })

  ipcMain.handle('shell:open-path', async (_e, p: string) => {
    if (!p) return '路径为空'
    return shell.openPath(p)
  })

  ipcMain.on('transfer:cancel', (_e, transferId: string) => {
    const sender = senders.get(transferId)
    if (sender) {
      sender.cancel()
      return
    }
    receiver?.cancelTransfer(transferId)
    // 接收方主动取消：立即反馈 UI（本地状态不再等对端）
    win?.webContents.send('transfer:update', { kind: 'failed', transferId, reason: 'cancelled' })
  })

  ipcMain.handle('transfer:check-dir-conflicts', async (_e, transferId: string, dir: string) => {
    if (!receiver) return { conflicts: false, error: '接收服务未运行' }
    const conflicts = await receiver.checkTargetDirConflicts(transferId, dir)
    return { conflicts }
  })

  ipcMain.handle('transfer:respond', async (_e, transferId: string, decision: 'accept' | 'reject', targetDir?: string, force = false) => {
    if (!receiver) return { ok: false, error: '接收服务未运行' }
    if (decision === 'reject') {
      receiver.respond(transferId, 'reject')
      return { ok: true }
    }
    // 用户指定了新目录：先做二次冲突检测，冲突且未确认覆盖则返回提示，由 UI 再次询问（设计 6.3）
    if (targetDir) {
      const conflicts = await receiver.checkTargetDirConflicts(transferId, targetDir)
      if (conflicts && !force) return { conflicts: true, ok: false }
    }
    receiver.respond(transferId, 'accept', targetDir)
    return { ok: true }
  })
}

// 生成托盘图标：优先从应用自身可执行文件提取（Windows 上 process.execPath = 应用 exe，
// 托盘图标与程序图标一致，当前均为 Electron 默认图标；将来更换应用图标后托盘自动跟随）。
// 提取失败（如 Linux 可执行文件无图标）时回退内嵌 16×16 蓝色 PNG。
// 提取托盘图标：1) createFromPath 快速路径（支持 exe/ico）；2) app.getFileIcon 走 Windows Shell
// 提取 exe 内嵌图标（推荐路径，与应用图标一致）；3) 最后回退内嵌蓝色 PNG。
async function createTrayIcon(): Promise<NativeImage> {
  const fromExec = nativeImage.createFromPath(process.execPath)
  if (!fromExec.isEmpty()) return fromExec
  try {
    const fromShell = await app.getFileIcon(process.execPath, { size: 'normal' })
    if (!fromShell.isEmpty()) return fromShell
  } catch {
    // getFileIcon 失败继续回退
  }
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGNw6P/ynxLMMGrAqAGjBgwXAwAXB8Ifq/d2QQAAAABJRU5ErkJggg=='
  return nativeImage.createFromDataURL('data:image/png;base64,' + b64)
}

// macOS 应用菜单：退出走系统菜单（Cmd+Q），符合平台惯例
function setupAppMenu(): void {
  if (process.platform !== 'darwin') return
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'LocalShare', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { role: 'windowMenu' }
    ])
  )
}

// Windows 系统托盘：关窗后驻留，点击恢复窗口，右键菜单退出
async function setupTray(): Promise<void> {
  if (process.platform === 'darwin' || tray) return
  const icon = await createTrayIcon()
  if (icon.isEmpty()) {
    console.warn('[tray] 托盘图标为空图像，跳过托盘创建')
    return
  }
  try {
    tray = new Tray(icon)
    tray.setImage(icon) // Windows 部分版本需要创建后重新 setImage 图标才出现（Electron 已知 workaround）
    console.log('[tray] 托盘图标已创建')
    tray.setToolTip('LocalShare')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开 LocalShare', click: () => { win?.show(); win?.focus() } },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() }
      ])
    )
    tray.on('click', () => {
      win?.show()
      win?.focus()
    })
  } catch (err) {
    // 托盘创建失败不拖垮主流程（关窗驻留/接收不受影响）
    console.warn('[tray] 托盘创建失败：', err)
  }
}

app.whenReady().then(async () => {
  registerIpc()
  createWindow()
  setupAppMenu()
  await setupTray()
  startServices()
  app.on('activate', () => {
    // 点击 Dock（macOS）：从最小化恢复窗口；窗口被销毁（极少见）则重建
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      if (win?.isMinimized()) win.restore()
      win?.show()
    }
  })
})

app.on('window-all-closed', () => {
  // 正常情况窗口不会全部关闭（关窗被拦截为最小化），走到这里说明是真正退出流程
  app.quit()
})

let quitFlushScheduled = false // 防止 will-quit 重入重复调度

app.on('will-quit', (e) => {
  tray?.destroy()
  tray = null
  // 清理进行中的发送传输：Sender 的 TCP 连接若不关闭会阻止进程退出（任务管理器残留）
  for (const sender of senders.values()) sender.cancel('app_quit')
  senders.clear()
  stopServices() // 内部发送 BYE（UDP 广播），socket 延迟关闭给 sendto 留 flush 时间
  // 推迟进程退出：确保 BYE 报文已进内核并发出，其他端点才能立即感知本设备下线
  if (!quitFlushScheduled) {
    quitFlushScheduled = true
    e.preventDefault()
    setTimeout(() => app.exit(0), 300)
  }
})
