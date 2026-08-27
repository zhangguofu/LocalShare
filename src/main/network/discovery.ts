import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import { encodeFrame, decodeFrame, MAX_DISCOVERY_LENGTH, type Message } from './protocol'
import { applyPacket, reapDevices, type DeviceInfo, type DeviceUpdate } from './deviceTable'

export const HELLO_INTERVAL_MS = 3000
export const OFFLINE_TIMEOUT_MS = 12000

export interface DiscoveryOptions {
  port: number
  deviceId: string
  deviceName: string
  platform: string
  version: string
  tcpPort: number
  broadcastAddress?: string
  helloIntervalMs?: number
  offlineTimeoutMs?: number
}

export class DiscoveryService extends EventEmitter {
  private socket: dgram.Socket | null = null
  private readonly devices = new Map<string, DeviceInfo>()
  private helloInterval: NodeJS.Timeout | null = null
  private reapInterval: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly opts: DiscoveryOptions) {
    super()
  }

  getDevices(): DeviceInfo[] {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  start(): void {
    if (this.running) return
    this.running = true
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('message', (msg, rinfo) => {
      try {
        const parsed = decodeFrame(msg) as Message
        const upd: DeviceUpdate | null = applyPacket(this.devices, this.opts.deviceId, parsed, Date.now(), rinfo.address)
        if (upd) this.emit('deviceChange', upd)
      } catch {
        // 非本协议报文（magic 不符 / JSON 非法）：静默忽略
      }
    })
    socket.on('error', (err) => {
      // 端口被占等启动错误：上报，由主进程报错退出（规格 4.2）
      this.emit('error', err)
    })
    socket.bind(this.opts.port, () => {
      socket.setBroadcast(true)
      this.sendHello()
      this.emit('listening')
      const interval = this.opts.helloIntervalMs ?? HELLO_INTERVAL_MS
      this.helloInterval = setInterval(() => this.sendHello(), interval)
      this.reapInterval = setInterval(() => this.reap(), interval)
    })
  }

  sendHello(): void {
    this.broadcast({
      type: 'HELLO',
      deviceId: this.opts.deviceId,
      deviceName: this.opts.deviceName,
      platform: this.opts.platform,
      version: this.opts.version,
      tcpPort: this.opts.tcpPort,
      timestamp: Date.now()
    })
  }

  sendBye(): void {
    this.broadcast({ type: 'BYE', deviceId: this.opts.deviceId })
  }

  private broadcast(msg: Message): void {
    if (!this.socket || !this.running) return
    let frame: Buffer
    try {
      frame = encodeFrame(msg, MAX_DISCOVERY_LENGTH)
    } catch {
      return
    }
    const address = this.opts.broadcastAddress ?? '255.255.255.255'
    this.socket.send(frame, this.opts.port, address)
  }

  private reap(): void {
    const removed = reapDevices(this.devices, Date.now(), this.opts.offlineTimeoutMs ?? OFFLINE_TIMEOUT_MS)
    for (const device of removed) this.emit('deviceChange', { kind: 'removed', device })
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.sendBye()
    if (this.helloInterval) clearInterval(this.helloInterval)
    if (this.reapInterval) clearInterval(this.reapInterval)
    this.helloInterval = null
    this.reapInterval = null
    this.socket?.close()
    this.socket = null
    this.devices.clear()
  }
}
