import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface WalkEntry {
  type: 'file' | 'dir'
  relPath: string // 协议相对路径（/ 分隔，dir 条目带尾斜杠）
  absPath: string // 本机绝对路径（读取文件用）
  size: number
}

export interface WalkResult {
  entries: WalkEntry[]
  totalBytes: number
}

export async function walkPaths(inputPaths: string[]): Promise<WalkResult> {
  const entries: WalkEntry[] = []
  let totalBytes = 0
  for (const input of inputPaths) {
    const stat = await fs.lstat(input)
    if (stat.isSymbolicLink()) continue
    const abs = path.resolve(input)
    const base = path.basename(abs)
    if (stat.isDirectory()) {
      await walkDir(abs, base, entries, (n) => (totalBytes += n))
    } else if (stat.isFile()) {
      entries.push({ type: 'file', relPath: base, absPath: abs, size: stat.size })
      totalBytes += stat.size
    }
  }
  return { entries, totalBytes }
}

async function walkDir(
  dirAbs: string,
  dirRel: string,
  entries: WalkEntry[],
  addBytes: (n: number) => void
): Promise<void> {
  const dirents = await fs.readdir(dirAbs, { withFileTypes: true })
  if (dirents.length === 0) {
    entries.push({ type: 'dir', relPath: dirRel + '/', absPath: dirAbs, size: 0 })
    return
  }
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue
    const childRel = dirRel + '/' + d.name
    const childAbs = path.join(dirAbs, d.name)
    if (d.isDirectory()) {
      await walkDir(childAbs, childRel, entries, addBytes)
    } else if (d.isFile()) {
      const st = await fs.stat(childAbs)
      entries.push({ type: 'file', relPath: childRel, absPath: childAbs, size: st.size })
      addBytes(st.size)
    }
  }
}
