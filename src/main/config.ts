import os from 'node:os'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { promises as fs, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { app } from 'electron'

export interface AppConfig {
  deviceId: string
  deviceName: string
  udpPort: number
  tcpPort: number
  saveDir: string
}

// 环境变量覆盖（本机多实例验证/调试）：LOCALSHARE_USER_DATA / LOCALSHARE_UDP_PORT /
// LOCALSHARE_TCP_PORT / LOCALSHARE_DEVICE_NAME / LOCALSHARE_SAVE_DIR
function envNumber(name: string): number | undefined {
  const v = process.env[name]
  if (!v) return undefined
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

let cached: AppConfig | null = null

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

function load(): AppConfig {
  const def: AppConfig = {
    deviceId: randomUUID(),
    deviceName: os.hostname(),
    udpPort: 45555,
    tcpPort: 45556,
    saveDir: path.join(os.homedir(), 'LocalShare')
  }
  // 环境变量优先于持久化配置
  const env: Partial<AppConfig> = {}
  const envUdp = envNumber('LOCALSHARE_UDP_PORT')
  const envTcp = envNumber('LOCALSHARE_TCP_PORT')
  if (envUdp) env.udpPort = envUdp
  if (envTcp) env.tcpPort = envTcp
  if (process.env.LOCALSHARE_DEVICE_NAME) env.deviceName = process.env.LOCALSHARE_DEVICE_NAME
  if (process.env.LOCALSHARE_SAVE_DIR) env.saveDir = process.env.LOCALSHARE_SAVE_DIR
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<AppConfig>
    return { ...def, ...raw, ...env }
  } catch {
    // 首次运行：生成默认配置并持久化
    const merged = { ...def, ...env }
    mkdirSync(path.dirname(configPath()), { recursive: true })
    writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf8')
    return merged
  }
}

export function getConfig(): AppConfig {
  if (!cached) cached = load()
  return cached
}

export async function updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const next: AppConfig = { ...getConfig(), ...patch }
  await fs.mkdir(path.dirname(configPath()), { recursive: true })
  await fs.writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8')
  cached = next
  return next
}
