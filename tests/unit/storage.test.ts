import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AtomicSink, detectConflicts, defaultSaveDir } from '../../src/main/storage'
import type { FileEntry } from '../../src/main/network/protocol'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localshare-store-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('defaultSaveDir', () => {
  it('返回用户目录下 LocalShare', () => {
    expect(defaultSaveDir()).toBe(path.join(os.homedir(), 'LocalShare'))
  })
})

describe('detectConflicts', () => {
  const entries = (ps: string[]): FileEntry[] => ps.map((p) => ({ type: 'file' as const, path: p, size: 1 }))

  it('无冲突返回 false', async () => {
    expect(await detectConflicts(entries(['a.txt']), dir)).toBe(false)
  })
  it('同名文件存在返回 true', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'x')
    expect(await detectConflicts(entries(['a.txt']), dir)).toBe(true)
  })
  it('同名目录存在返回 true', async () => {
    await fs.mkdir(path.join(dir, 'docs'))
    expect(await detectConflicts(entries(['docs/x.txt']), dir)).toBe(true)
  })
  it('目录条目（尾斜杠）同样参与冲突检测', async () => {
    await fs.mkdir(path.join(dir, 'empty'))
    expect(await detectConflicts([{ type: 'dir', path: 'empty/' }], dir)).toBe(true)
  })
})

describe('AtomicSink', () => {
  it('写入后 commit 生成目标文件且无 .part 残留', async () => {
    const sink = new AtomicSink(path.join(dir, 'out.bin'))
    await sink.open()
    sink.write(Buffer.from('hello'))
    await sink.commit()
    expect(await fs.readFile(path.join(dir, 'out.bin'), 'utf8')).toBe('hello')
    await expect(fs.access(path.join(dir, 'out.bin.part'))).rejects.toThrow()
  })

  it('嵌套目录自动创建', async () => {
    const sink = new AtomicSink(path.join(dir, 'deep', 'nested', 'f.txt'))
    await sink.open()
    sink.write(Buffer.from('x'))
    await sink.commit()
    expect(await fs.readFile(path.join(dir, 'deep', 'nested', 'f.txt'), 'utf8')).toBe('x')
  })

  it('覆盖已有文件（rename 覆盖语义）', async () => {
    await fs.writeFile(path.join(dir, 'f.txt'), 'old')
    const sink = new AtomicSink(path.join(dir, 'f.txt'))
    await sink.open()
    sink.write(Buffer.from('new'))
    await sink.commit()
    expect(await fs.readFile(path.join(dir, 'f.txt'), 'utf8')).toBe('new')
  })

  it('abort 清理 .part 且不产生目标文件', async () => {
    const sink = new AtomicSink(path.join(dir, 'g.txt'))
    await sink.open()
    sink.write(Buffer.from('partial'))
    await sink.abort()
    await expect(fs.access(path.join(dir, 'g.txt'))).rejects.toThrow()
    await expect(fs.access(path.join(dir, 'g.txt.part'))).rejects.toThrow()
  })
})
