import { promises as fs } from 'node:fs'
import path from 'node:path'
import { runPool } from './pool'

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

const FILE_STAT_CONCURRENCY = 64
const DIR_WALK_CONCURRENCY = 8

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
  const files: { name: string }[] = []
  const dirs: { name: string }[] = []
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue
    if (d.isDirectory()) dirs.push(d)
    else if (d.isFile()) files.push(d)
  }
  // 文件：并发 stat（大目录下显著提速）；目录：并发递归（限并发防 fd 爆炸）
  await runPool(files, FILE_STAT_CONCURRENCY, async (d) => {
    const childAbs = path.join(dirAbs, d.name)
    const st = await fs.stat(childAbs)
    entries.push({ type: 'file', relPath: dirRel + '/' + d.name, absPath: childAbs, size: st.size })
    addBytes(st.size)
  })
  await runPool(dirs, DIR_WALK_CONCURRENCY, (d) =>
    walkDir(path.join(dirAbs, d.name), dirRel + '/' + d.name, entries, addBytes)
  )
}
