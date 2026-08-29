import { describe, it, expect } from 'vitest'
import dgram from 'node:dgram'
import { DiscoveryService } from '../../src/main/network/discovery'
import { encodeFrame } from '../../src/main/network/protocol'
import type { HelloMessage, ByeMessage } from '../../src/main/network/protocol'

// 测试专用端口，与生产默认 45555 隔离
const PORT = 45599

// 注：macOS 上多个 socket 复用同一 UDP 端口时，数据包只投递给其中一个绑定者
// （SO_REUSEADDR 不保证广播分发给所有监听者），故本测试采用"单实例 + 定向单播"验证接收方向；
// 广播发送的真实可达性由 Task 9 真机冒烟覆盖（设计文档 9.4）。
describe('DiscoveryService 集成（真实 UDP，回环）', () => {
  it('收到 HELLO 收录设备，收到 BYE 移除设备', async () => {
    const service = new DiscoveryService({
      port: PORT,
      deviceId: 'self',
      deviceName: 'Me',
      platform: process.platform,
      version: '0.1.0',
      tcpPort: 45600,
      broadcastAddress: '127.0.0.1',
      helloIntervalMs: 60000 // 长间隔，避免测试期间自身广播干扰断言
    })
    const sender = dgram.createSocket('udp4')
    service.start()
    try {
      await new Promise<void>((resolve) => service.once('listening', () => resolve()))

      const hello: HelloMessage = {
        type: 'HELLO', deviceId: 'peer-1', deviceName: 'Peer',
        platform: 'linux', version: '0.1.0', tcpPort: 45001, timestamp: Date.now()
      }
      sender.send(encodeFrame(hello), PORT, '127.0.0.1')
      await new Promise((r) => setTimeout(r, 200))
      expect(service.getDevices().map((d) => d.name)).toContain('Peer')
      expect(service.getDevices()[0].host).toBe('127.0.0.1')

      const bye: ByeMessage = { type: 'BYE', deviceId: 'peer-1' }
      sender.send(encodeFrame(bye), PORT, '127.0.0.1')
      await new Promise((r) => setTimeout(r, 200))
      expect(service.getDevices()).toHaveLength(0)
    } finally {
      sender.close()
      await new Promise<void>((resolve) => service.stop(() => resolve()))
    }
  })

  it('端口被占时触发 error 事件（规格 4.2：严格端口，报错退出）', async () => {
    const a = new DiscoveryService({
      port: PORT, deviceId: 'a', deviceName: 'A',
      platform: process.platform, version: '0.1.0', tcpPort: 45600,
      broadcastAddress: '127.0.0.1', helloIntervalMs: 60000
    })
    const b = new DiscoveryService({
      port: PORT, deviceId: 'b', deviceName: 'B',
      platform: process.platform, version: '0.1.0', tcpPort: 45601,
      broadcastAddress: '127.0.0.1', helloIntervalMs: 60000
    })
    a.start()
    try {
      await new Promise<void>((resolve) => a.once('listening', () => resolve()))
      const errP = new Promise<Error>((resolve) => b.once('error', (e: Error) => resolve(e)))
      b.start()
      const err = await errP
      expect(err.message).toMatch(/EADDRINUSE/)
    } finally {
      await Promise.all([
        new Promise<void>((r) => a.stop(() => r())),
        new Promise<void>((r) => b.stop(() => r()))
      ])
    }
  })
})
