import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { walkPaths } from '../../src/main/network/tree'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'localshare-tree-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('walkPaths', () => {
  it('遍历嵌套目录并统计总字节（relPath 以输入目录名为根）', async () => {
    const proj = path.join(root, 'proj')
    await fs.mkdir(path.join(proj, 'sub', 'empty'), { recursive: true })
    await fs.writeFile(path.join(proj, 'a.txt'), Buffer.alloc(10))
    await fs.writeFile(path.join(proj, 'sub', 'b.txt'), Buffer.alloc(20))
    const { entries, totalBytes } = await walkPaths([proj])
    expect(totalBytes).toBe(30)
    expect(entries).toContainEqual({ type: 'file', relPath: 'proj/a.txt', absPath: path.join(proj, 'a.txt'), size: 10 })
    expect(entries).toContainEqual({ type: 'file', relPath: 'proj/sub/b.txt', absPath: path.join(proj, 'sub', 'b.txt'), size: 20 })
    expect(entries).toContainEqual({ type: 'dir', relPath: 'proj/sub/empty/', absPath: path.join(proj, 'sub', 'empty'), size: 0 })
    expect(entries.filter((e) => e.type === 'dir')).toHaveLength(1)
  })

  it('单文件输入：relPath 为文件名本身', async () => {
    const file = path.join(root, 'single.txt')
    await fs.writeFile(file, Buffer.alloc(7))
    const { entries, totalBytes } = await walkPaths([file])
    expect(entries).toEqual([{ type: 'file', relPath: 'single.txt', absPath: file, size: 7 }])
    expect(totalBytes).toBe(7)
  })

  it('多输入路径合并为一个清单', async () => {
    const proj = path.join(root, 'proj')
    await fs.mkdir(proj, { recursive: true })
    await fs.writeFile(path.join(proj, 'x.txt'), Buffer.alloc(5))
    const file = path.join(root, 'y.txt')
    await fs.writeFile(file, Buffer.alloc(7))
    const { entries, totalBytes } = await walkPaths([proj, file])
    expect(totalBytes).toBe(12)
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.relPath).sort()).toEqual(['proj/x.txt', 'y.txt'])
  })

  it('跳过符号链接（防循环）', { skip: process.platform === 'win32' }, async () => {
    const proj = path.join(root, 'proj')
    await fs.mkdir(proj, { recursive: true })
    await fs.writeFile(path.join(proj, 'real.txt'), Buffer.alloc(3))
    await fs.symlink(path.join(proj, 'real.txt'), path.join(proj, 'link.txt'))
    const { entries } = await walkPaths([proj])
    expect(entries.map((e) => e.relPath)).not.toContain('proj/link.txt')
  })

  it('空文件夹条目带尾斜杠', async () => {
    const proj = path.join(root, 'proj')
    await fs.mkdir(path.join(proj, 'only-empty'), { recursive: true })
    const { entries } = await walkPaths([proj])
    expect(entries).toEqual([{ type: 'dir', relPath: 'proj/only-empty/', absPath: path.join(proj, 'only-empty'), size: 0 }])
  })
})
