import type { Message } from './protocol'

export interface DeviceInfo {
  id: string
  name: string
  platform: string
  version: string
  host: string // 来自 UDP 报文源地址 rinfo.address
  tcpPort: number
  lastSeen: number
}

export type DeviceUpdate = { kind: 'added' | 'updated' | 'removed'; device: DeviceInfo }

// 应用一条发现消息到设备表，返回变更；无变更返回 null（纯函数，可单测）
export function applyPacket(
  devices: Map<string, DeviceInfo>,
  selfId: string,
  msg: Message,
  now: number,
  host: string
): DeviceUpdate | null {
  if (msg.type === 'HELLO') {
    if (msg.deviceId === selfId) return null
    const existing = devices.get(msg.deviceId)
    devices.set(msg.deviceId, {
      id: msg.deviceId,
      name: msg.deviceName,
      platform: msg.platform,
      version: msg.version,
      host,
      tcpPort: msg.tcpPort,
      lastSeen: now
    })
    return { kind: existing ? 'updated' : 'added', device: devices.get(msg.deviceId)! }
  }
  if (msg.type === 'BYE') {
    const existing = devices.get(msg.deviceId)
    if (!existing) return null
    devices.delete(msg.deviceId)
    return { kind: 'removed', device: existing }
  }
  return null
}

// 剔除超过超时阈值的设备，返回被移除列表
export function reapDevices(devices: Map<string, DeviceInfo>, now: number, timeoutMs: number): DeviceInfo[] {
  const removed: DeviceInfo[] = []
  for (const [id, device] of devices) {
    if (now - device.lastSeen > timeoutMs) {
      devices.delete(id)
      removed.push(device)
    }
  }
  return removed
}
