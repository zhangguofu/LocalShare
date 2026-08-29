import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppConfig } from '../main/config'
import type { DeviceInfo, DeviceUpdate } from '../main/network/deviceTable'
import type { OfferSummary, ReceiveProgress } from '../main/network/receiver'
import type { TransferProgress } from '../main/network/sender'

export type TransferTarget = { deviceId: string } | { host: string; port: number }

export interface TransferUpdate {
  kind: 'progress' | 'complete' | 'failed' | 'error' | 'receive-progress' | 'file-ack'
  transferId: string
  fileName?: string
  totalBytes?: number
  reason?: string
  saveDir?: string // 接收方完成时携带实际保存目录
  path?: string // file-ack：已送达对端的文件路径
}

export interface Api {
  ping: () => Promise<string>
  getVersion: () => Promise<string>
  getConfig: () => Promise<AppConfig>
  updateConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>
  getDevices: () => Promise<DeviceInfo[]>
  onDeviceChange: (cb: (upd: DeviceUpdate) => void) => () => void
  pickPaths: (kind: 'file' | 'dir') => Promise<string[]>
  pickDirectory: () => Promise<string | null>
  openPath: (p: string) => Promise<string>
  sendTransfer: (target: TransferTarget, paths: string[]) => Promise<{ transferId: string; name: string; totalBytes: number; fileCount: number; skippedSymlinks: number }>
  cancelTransfer: (transferId: string) => void
  onTransferUpdate: (cb: (u: TransferUpdate) => void) => () => void
  onOffer: (cb: (offer: OfferSummary) => void) => () => void
  checkDirConflicts: (transferId: string, dir: string) => Promise<{ conflicts: boolean; error?: string }>
  respondTransfer: (
    transferId: string,
    decision: 'accept' | 'reject',
    targetDir?: string,
    force?: boolean
  ) => Promise<{ ok: boolean; conflicts?: boolean; error?: string }>
  getPathForFile: (file: File) => string
}

const api: Api = {
  ping: () => ipcRenderer.invoke('ping'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),
  getDevices: () => ipcRenderer.invoke('devices:list'),
  onDeviceChange: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, upd: DeviceUpdate) => cb(upd)
    ipcRenderer.on('devices:changed', listener)
    return () => ipcRenderer.removeListener('devices:changed', listener)
  },
  pickPaths: (kind) => ipcRenderer.invoke('dialog:pick-paths', kind),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  sendTransfer: (target, paths) => ipcRenderer.invoke('transfer:send', target, paths),
  cancelTransfer: (transferId) => ipcRenderer.send('transfer:cancel', transferId),
  onTransferUpdate: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, u: TransferUpdate) => cb(u)
    ipcRenderer.on('transfer:update', listener)
    return () => ipcRenderer.removeListener('transfer:update', listener)
  },
  onOffer: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, offer: OfferSummary) => cb(offer)
    ipcRenderer.on('transfer:offer', listener)
    return () => ipcRenderer.removeListener('transfer:offer', listener)
  },
  respondTransfer: (transferId, decision, targetDir, force = false) =>
    ipcRenderer.invoke('transfer:respond', transferId, decision, targetDir, force),
  checkDirConflicts: (transferId, dir) => ipcRenderer.invoke('transfer:check-dir-conflicts', transferId, dir),
  getPathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('api', api)
