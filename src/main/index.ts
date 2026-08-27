import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
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
let discovery: DiscoveryService | null = null
let receiver: Receiver | null = null
const senders = new Map<string, Sender>()

// 本机多实例验证/调试：LOCALSHARE_USER_DATA 隔离配置（deviceId/端口/设备名独立）
if (process.env.LOCALSHARE_USER_DATA) {
  app.setPath('userData', process.env.LOCALSHARE_USER_DATA)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 900,
    height: 640,
    title: 'LocalShare',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
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

function stopServices(): void {
  discovery?.stop()
  discovery = null
  receiver?.stop()
  receiver = null
}

function restartServices(): void {
  stopServices()
  startServices()
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
  receiver.on('complete', (id) => win?.webContents.send('transfer:update', { kind: 'complete', transferId: id }))
  receiver.on('transferError', (e: { transferId: string; error: Error }) =>
    win?.webContents.send('transfer:update', { kind: 'error', transferId: e.transferId, reason: e.error.message })
  )
  receiver.start()
}

function registerIpc(): void {
  ipcMain.handle('ping', () => 'pong')
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
    return { transferId }
  })

  ipcMain.handle('shell:open-path', async (_e, p: string) => {
    if (!p) return '路径为空'
    return shell.openPath(p)
  })

  ipcMain.on('transfer:cancel', (_e, transferId: string) => {
    senders.get(transferId)?.cancel()
  })

  ipcMain.on('transfer:respond', (_e, transferId: string, decision: 'accept' | 'reject', targetDir?: string) => {
    receiver?.respond(transferId, decision, targetDir)
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  startServices()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  discovery?.stop()
  receiver?.stop()
})
