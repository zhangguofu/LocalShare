import type { DeviceInfo } from '../../../main/network/deviceTable'

// 平台标识 → 徽标类型。注意判断顺序：'darwin' 包含子串 'win'（dar-win），
// 必须先判 darwin，否则 macOS 会被误判为 Windows（曾因此出过 bug，有单测防回归）。
export function platformOf(d: DeviceInfo): 'win' | 'mac' | 'linux' {
  const p = d.platform.toLowerCase()
  if (p.includes('darwin') || p.includes('mac')) return 'mac'
  if (p.includes('win')) return 'win'
  return 'linux'
}

export function platformLabel(d: DeviceInfo): string {
  return { win: 'Win', mac: 'Mac', linux: 'Linux' }[platformOf(d)]
}
