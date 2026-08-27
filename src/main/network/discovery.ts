import dgram from 'node:dgram'
import os from 'node:os'
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

// 计算 IPv4 子网定向广播地址（ip & netmask | ~netmask）
function calcBroadcast(ip: string, netmask: string): string | null {
  const ipParts = ip.split('.').map(Number)
  const maskParts = netmask.split('.').map(Number)
  if (ipParts.length !== 4 || maskParts.length !== 4) return null
  if ([...ipParts, ...maskParts].some((n) => Number.isNaN(n))) return null
  const b = ipParts.map((n, i) => (n & maskParts[i]) | (255 & ~maskParts[i]))
  return b.join('.')
}

// 枚举本机所有非回环 IPv4 接口的子网广播地址
function getBroadcastAddresses(): string[] {
  const addrs: string[] = []
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const addr of ifaces ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && addr.address && addr.netmask) {
        const bcast = calcBroadcast(addr.address, addr.netmask)
        if (bcast) addrs.push(bcast)
      }
    }
  }
  return [...new Set(addrs)]
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
        if (upd) {
          if (upd.kind === 'added') console.log(`[discovery] 设备上线: ${upd.device.name} (${upd.device.host}:${upd.device.tcpPort})`)
          else if (upd.kind === 'removed') console.log(`[discovery] 设备离线: ${upd.device.name}`)
          this.emit('deviceChange', upd)
        }
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
      console.log(`[discovery] 监听 UDP ${this.opts.port}，广播目标: ${this.broadcastTargets().join(', ')}`)
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

  // 广播目标：测试/手动指定时用指定地址；否则向本机每个接口的子网广播地址发送
  private broadcastTargets(): string[] {
    if (this.opts.broadcastAddress) return [this.opts.broadcastAddress]
    const targets = getBroadcastAddresses()
    return targets.length > 0 ? targets : ['255.255.255.255']
  }

  private broadcast(msg: Message): void {
    if (!this.socket || !this.running) return
    let frame: Buffer
    try {
      frame = encodeFrame(msg, MAX_DISCOVERY_LENGTH)
    } catch {
      return
    }
    for (const address of this.broadcastTargets()) {
      this.socket.send(frame, this.opts.port, address, (err) => {
        if (err) console.warn('[discovery] send failed to', address, ':', err.message)
      })
    }
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
