import { describe, it, expect } from 'vitest'
import { applyPacket, reapDevices, type DeviceInfo } from '../../src/main/network/deviceTable'
import type { HelloMessage, ByeMessage } from '../../src/main/network/protocol'

const hello = (id: string, over: Partial<HelloMessage> = {}): HelloMessage => ({
  type: 'HELLO',
  deviceId: id,
  deviceName: 'dev',
  platform: 'darwin',
  version: '0.1.0',
  tcpPort: 45556,
  timestamp: 0,
  ...over
})

describe('applyPacket', () => {
  it('HELLO 新增设备并记录最后活跃时间与来源地址', () => {
    const devices = new Map<string, DeviceInfo>()
    const upd = applyPacket(devices, 'self', hello('peer-1'), 1000, '192.168.1.5')
    expect(upd?.kind).toBe('added')
    expect(devices.size).toBe(1)
    expect(devices.get('peer-1')?.lastSeen).toBe(1000)
    expect(devices.get('peer-1')?.host).toBe('192.168.1.5')
  })

  it('HELLO 更新已有设备（刷新名称与活跃时间）', () => {
    const devices = new Map<string, DeviceInfo>()
    applyPacket(devices, 'self', hello('peer-1'), 1000, '192.168.1.5')
    const upd = applyPacket(devices, 'self', hello('peer-1', { deviceName: 'new-name' }), 4000, '192.168.1.5')
    expect(upd?.kind).toBe('updated')
    expect(devices.get('peer-1')?.name).toBe('new-name')
    expect(devices.get('peer-1')?.lastSeen).toBe(4000)
  })

  it('忽略自己的 HELLO', () => {
    const devices = new Map<string, DeviceInfo>()
    applyPacket(devices, 'self', hello('self'), 1000, '127.0.0.1')
    expect(devices.size).toBe(0)
  })

  it('BYE 移除设备', () => {
    const devices = new Map<string, DeviceInfo>()
    applyPacket(devices, 'self', hello('peer-1'), 1000, '192.168.1.5')
    const bye: ByeMessage = { type: 'BYE', deviceId: 'peer-1' }
    expect(applyPacket(devices, 'self', bye, 2000, '192.168.1.5')?.kind).toBe('removed')
    expect(devices.size).toBe(0)
  })

  it('未知设备 BYE 无变化', () => {
    const devices = new Map<string, DeviceInfo>()
    const bye: ByeMessage = { type: 'BYE', deviceId: 'nobody' }
    expect(applyPacket(devices, 'self', bye, 1000, '127.0.0.1')).toBeNull()
  })

  it('非发现消息无变化', () => {
    const devices = new Map<string, DeviceInfo>()
    expect(applyPacket(devices, 'self', { type: 'ACCEPT', transferId: 'x' }, 1000, '127.0.0.1')).toBeNull()
  })
})

describe('reapDevices', () => {
  it('仅剔除超过超时阈值的设备', () => {
    const devices = new Map<string, DeviceInfo>()
    applyPacket(devices, 'self', hello('a'), 1000, '192.168.1.2')
    applyPacket(devices, 'self', hello('b'), 9000, '192.168.1.3')
    const removed = reapDevices(devices, 10000, 5000)
    expect(removed.map((d) => d.id)).toEqual(['a'])
    expect(devices.has('b')).toBe(true)
  })
})
