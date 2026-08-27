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
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<AppConfig>
    return { ...def, ...raw }
  } catch {
    // 首次运行：生成默认配置并持久化
    mkdirSync(path.dirname(configPath()), { recursive: true })
    writeFileSync(configPath(), JSON.stringify(def, null, 2), 'utf8')
    return def
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
