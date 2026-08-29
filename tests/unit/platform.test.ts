import { describe, it, expect } from 'vitest'
import { platformOf, platformLabel } from '../../src/renderer/src/utils/platform'
import type { DeviceInfo } from '../../src/main/network/deviceTable'

function dev(platform: string): DeviceInfo {
  return { id: 'x', name: 'X', platform, version: '0', host: '127.0.0.1', tcpPort: 1, lastSeen: 0 }
}

describe('platformOf（平台徽标判定）', () => {
  it('macOS：darwin → mac（darwin 含子串 win，必须先判 darwin，防回归）', () => {
    expect(platformOf(dev('darwin'))).toBe('mac')
    expect(platformOf(dev('DARWIN'))).toBe('mac')
  })

  it('Windows：win32 / windows → win', () => {
    expect(platformOf(dev('win32'))).toBe('win')
    expect(platformOf(dev('Windows'))).toBe('win')
  })

  it('Linux：linux → linux', () => {
    expect(platformOf(dev('linux'))).toBe('linux')
  })

  it('其他/未知标识归为 linux 徽标（不崩溃）', () => {
    expect(platformOf(dev('unknown'))).toBe('linux')
  })

  it('platformLabel 文案', () => {
    expect(platformLabel(dev('darwin'))).toBe('Mac')
    expect(platformLabel(dev('win32'))).toBe('Win')
    expect(platformLabel(dev('linux'))).toBe('Linux')
  })
})
