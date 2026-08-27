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
  private bound = false // 绑定成功后置位，用于区分绑定错误与运行期错误

  constructor(private readonly opts: DiscoveryOptions) {
    super()
  }

  getDevices(): DeviceInfo[] {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  start(): void {
    if (this.running) return
    this.running = true
    // 不设 reuseAddr：端口被占必须报错退出（规格 4.2），UDP 无 TIME_WAIT，热重启不需要复用
    const socket = dgram.createSocket('udp4')
    this.socket = socket
    socket.on('message', (msg, rinfo) => {
      // 接收侧同样执行发现载荷上限（规格 4.6：≤ 1 KiB），超限忽略
      if (msg.length > MAX_DISCOVERY_LENGTH + 8) return
      try {
        const parsed = decodeFrame(msg) as Message
        const upd: DeviceUpdate | null = applyPacket(this.devices, this.opts.deviceId, parsed, Date.now(), rinfo.address)
        if (upd) this.emit('deviceChange', upd)
      } catch {
        // 非本协议报文（magic 不符 / JSON 非法）：静默忽略
      }
    })
    socket.on('error', (err) => {
      if (!this.bound) {
        // 绑定期错误（如 EADDRINUSE）：由主进程报错退出（规格 4.2）
        this.emit('error', err)
      } else {
        // 运行期错误（如瞬时 ENETUNREACH）：不应杀进程，仅记录
        console.warn('[discovery] runtime socket error:', err.message)
      }
    })
    socket.bind(this.opts.port, () => {
      this.bound = true
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
    this.socket.send(frame, this.opts.port, address, (err) => {
      if (err) console.warn('[discovery] send failed:', err.message)
    })
  }

  private reap(): void {
    const removed = reapDevices(this.devices, Date.now(), this.opts.offlineTimeoutMs ?? OFFLINE_TIMEOUT_MS)
    for (const device of removed) this.emit('deviceChange', { kind: 'removed', device })
  }

  stop(): void {
    if (!this.running) return
    this.sendBye() // 先广播 BYE（broadcast 依赖 running 守卫），再置位停止
    this.running = false
    if (this.helloInterval) clearInterval(this.helloInterval)
    if (this.reapInterval) clearInterval(this.reapInterval)
    this.helloInterval = null
    this.reapInterval = null
    this.socket?.close()
    this.socket = null
    this.bound = false
    this.devices.clear()
  }
}
