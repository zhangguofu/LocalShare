import { promises as fs, createWriteStream, type WriteStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { FileEntry } from './network/protocol'
import { sanitizePath } from './network/protocol'

export function defaultSaveDir(): string {
  return path.join(os.homedir(), 'LocalShare')
}

// 冲突检测：任一条目的路径组件（含各级目录与最终文件）已存在即为冲突
export async function detectConflicts(entries: FileEntry[], dir: string): Promise<boolean> {
  for (const e of entries) {
    const safe = sanitizePath(e.path)
    if (!safe) continue // 防御：非法路径由接收方在更早阶段拒绝
    const parts = safe.split('/')
    let cur = dir
    for (const part of parts) {
      cur = path.join(cur, part)
      try {
        await fs.access(cur)
        return true
      } catch {
        // 该级不存在，继续检查下一级
      }
    }
  }
  return false
}

// 原子落盘：写 .part → commit 时 rename 到目标（覆盖语义由 rename 提供）
export class AtomicSink {
  private readonly partPath: string
  stream?: WriteStream

  constructor(private readonly targetPath: string) {
    this.partPath = targetPath + '.part'
  }

  async open(): Promise<void> {
    await fs.mkdir(path.dirname(this.targetPath), { recursive: true })
    this.stream = createWriteStream(this.partPath, { flags: 'w' })
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
