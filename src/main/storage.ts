import { promises as fs, mkdirSync, createWriteStream, type WriteStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { FileEntry } from './network/protocol'
import { sanitizePath } from './network/protocol'
import { runPool } from './network/pool'

export function defaultSaveDir(): string {
  return path.join(os.homedir(), 'LocalShare')
}

// 冲突检测：任一条目的路径组件（含各级目录与最终文件）已存在即为冲突。
// 并发检查 + 短路（大清单如数万文件时避免串行 fs.access 拖慢 OFFER 处理）
export async function detectConflicts(entries: FileEntry[], dir: string): Promise<boolean> {
  const probes: string[] = []
  for (const e of entries) {
    const safe = sanitizePath(e.path)
    if (!safe) continue // 防御：非法路径由接收方在更早阶段拒绝
    const parts = safe.split('/')
    let cur = dir
    for (const part of parts) {
      cur = path.join(cur, part)
      probes.push(cur)
    }
  }
  let found = false
  await runPool(probes, 64, async (p) => {
    if (found) return // 短路：已发现冲突，剩余探测跳过
    try {
      await fs.access(p)
      found = true
    } catch {
      // 该级不存在，继续
    }
  })
  return found
}

// 原子落盘：写 .part → commit 时 rename 到目标（覆盖语义由 rename 提供）
// open 为同步操作（mkdirSync + createWriteStream），保证数据到达时流已就绪
export class AtomicSink {
  private readonly partPath: string
  stream?: WriteStream

  constructor(private readonly targetPath: string) {
    this.partPath = targetPath + '.part'
  }

  open(): void {
    mkdirSync(path.dirname(this.targetPath), { recursive: true })
    // 1MB 写入缓冲：小块（默认 16KB）在真实网络下增加系统调用与背压抖动，降低吞吐
    this.stream = createWriteStream(this.partPath, { flags: 'w', highWaterMark: 1024 * 1024 })
  }

  write(chunk: Buffer): boolean {
    if (!this.stream) throw new Error('AtomicSink not open')
    return this.stream.write(chunk)
  }

  async commit(): Promise<void> {
    if (!this.stream) throw new Error('AtomicSink not open')
    await new Promise<void>((resolve, reject) => {
      const s = this.stream as WriteStream
      s.on('error', reject)
      s.end(() => resolve())
    })
    await fs.rename(this.partPath, this.targetPath)
  }

  async abort(): Promise<void> {
    if (this.stream) this.stream.destroy()
    await fs.rm(this.partPath, { force: true })
  }
}
