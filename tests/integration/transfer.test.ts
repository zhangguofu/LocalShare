import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Sender } from '../../src/main/network/sender'
import { Receiver, type OfferSummary } from '../../src/main/network/receiver'
import type { WalkEntry } from '../../src/main/network/tree'

const TCP_PORT = 45600

let root: string
let recvDir: string
let receiver: Receiver | null

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'localshare-xfer-'))
  recvDir = path.join(root, 'recv')
  await fs.mkdir(recvDir)
  receiver = null
})

afterEach(async () => {
  if (receiver) {
    await new Promise<void>((resolve) => receiver!.stop(resolve))
  }
  await fs.rm(root, { recursive: true, force: true })
})

const waitOffer = (r: Receiver): Promise<OfferSummary> =>
  new Promise((resolve) => r.once('offer', resolve))

const startReceiver = async (): Promise<Receiver> => {
  const r = new Receiver({ port: TCP_PORT, saveDir: () => recvDir })
  receiver = r
  r.start()
  await new Promise<void>((res) => r.once('listening', res))
  return r
}

describe('端到端传输（回环 TCP）', () => {
  it('单文件全流程：内容一致落盘', async () => {
    const srcFile = path.join(root, 'a.txt')
    await fs.writeFile(srcFile, 'hello localshare')
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const completeP = new Promise<void>((resolve, reject) => {
      sender.once('complete', () => resolve())
      sender.once('failed', (i: { reason: string }) => reject(new Error(i.reason)))
    })
    const sendP = sender.start(
      { host: '127.0.0.1', port: TCP_PORT },
      't-1',
      [{ relPath: 'a.txt', absPath: srcFile, type: 'file', size: 16 }],
      16
    )
    const offer = await offerP
    expect(offer.files).toEqual([{ type: 'file', path: 'a.txt', size: 16 }])
    expect(offer.conflicts).toBe(false)
    r.respond(offer.transferId, 'accept')
    await sendP
    await completeP
    expect(await fs.readFile(path.join(recvDir, 'a.txt'), 'utf8')).toBe('hello localshare')
  })

  it('多文件 + 目录结构 + 空目录全部落盘', async () => {
    await fs.writeFile(path.join(root, 'top.txt'), 'top')
    await fs.mkdir(path.join(root, 'sub', 'empty'), { recursive: true })
    await fs.writeFile(path.join(root, 'sub', 'b.txt'), 'b-content')
    const entries: WalkEntry[] = [
      { relPath: 'top.txt', absPath: path.join(root, 'top.txt'), type: 'file', size: 3 },
      { relPath: 'sub/empty/', absPath: '', type: 'dir', size: 0 },
      { relPath: 'sub/b.txt', absPath: path.join(root, 'sub', 'b.txt'), type: 'file', size: 9 }
    ]
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-2', entries, 12)
    const offer = await offerP
    r.respond(offer.transferId, 'accept')
    await sendP
    expect(await fs.readFile(path.join(recvDir, 'top.txt'), 'utf8')).toBe('top')
    expect(await fs.readFile(path.join(recvDir, 'sub', 'b.txt'), 'utf8')).toBe('b-content')
    expect((await fs.stat(path.join(recvDir, 'sub', 'empty'))).isDirectory()).toBe(true)
  })

  it('零字节文件正常落盘', async () => {
    const srcFile = path.join(root, 'empty.bin')
    await fs.writeFile(srcFile, Buffer.alloc(0))
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-3', [{ relPath: 'empty.bin', absPath: srcFile, type: 'file', size: 0 }], 0)
    const offer = await offerP
    r.respond(offer.transferId, 'accept')
    await sendP
    expect((await fs.stat(path.join(recvDir, 'empty.bin'))).size).toBe(0)
  })

  it('接收方拒绝：发送方报错且不落盘', async () => {
    const srcFile = path.join(root, 'x.txt')
    await fs.writeFile(srcFile, 'data')
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-4', [{ relPath: 'x.txt', absPath: srcFile, type: 'file', size: 4 }], 4)
    const offer = await offerP
    r.respond(offer.transferId, 'reject')
    await expect(sendP).rejects.toThrow(/declined/)
    await expect(fs.access(path.join(recvDir, 'x.txt'))).rejects.toThrow()
  })

  it('冲突检测：目标已存在时 offer.conflicts 为 true，覆盖生效', async () => {
    await fs.writeFile(path.join(recvDir, 'a.txt'), 'old')
    const srcFile = path.join(root, 'a.txt')
    await fs.writeFile(srcFile, 'new')
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-5', [{ relPath: 'a.txt', absPath: srcFile, type: 'file', size: 3 }], 3)
    const offer = await offerP
    expect(offer.conflicts).toBe(true)
    r.respond(offer.transferId, 'accept')
    await sendP
    expect(await fs.readFile(path.join(recvDir, 'a.txt'), 'utf8')).toBe('new')
  })

  it('指定目标目录（换位置）：写入所选目录', async () => {
    const srcFile = path.join(root, 'a.txt')
    await fs.writeFile(srcFile, 'elsewhere')
    const altDir = path.join(root, 'alt')
    await fs.mkdir(altDir)
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-6', [{ relPath: 'a.txt', absPath: srcFile, type: 'file', size: 9 }], 9)
    const offer = await offerP
    r.respond(offer.transferId, 'accept', altDir)
    await sendP
    expect(await fs.readFile(path.join(altDir, 'a.txt'), 'utf8')).toBe('elsewhere')
  })

  it('指定目标目录存在同名文件时 checkTargetDirConflicts 返回 true，无冲突目录返回 false', async () => {
    const srcFile = path.join(root, 'a.txt')
    await fs.writeFile(srcFile, 'data')
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-c', [{ relPath: 'a.txt', absPath: srcFile, type: 'file', size: 4 }], 4)
    const offer = await offerP

    const conflictDir = path.join(root, 'alt')
    await fs.mkdir(conflictDir)
    await fs.writeFile(path.join(conflictDir, 'a.txt'), 'old')
    expect(await r.checkTargetDirConflicts(offer.transferId, conflictDir)).toBe(true)

    const cleanDir = path.join(root, 'clean')
    await fs.mkdir(cleanDir)
    expect(await r.checkTargetDirConflicts(offer.transferId, cleanDir)).toBe(false)

    // 收尾：拒绝，避免悬挂等待
    r.respond(offer.transferId, 'reject')
    await expect(sendP).rejects.toThrow(/declined/)
  })

  it('传输中断：接收方清理 .part 不残留', async () => {
    const srcFile = path.join(root, 'big.bin')
    await fs.writeFile(srcFile, Buffer.alloc(32 * 1024 * 1024, 7)) // 32MB，确保传输中
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-7', [{ relPath: 'big.bin', absPath: srcFile, type: 'file', size: 32 * 1024 * 1024 }], 32 * 1024 * 1024)
    const offer = await offerP
    r.respond(offer.transferId, 'accept')
    // 确认后立即断开接收方，模拟传输中中断
    await new Promise((res) => setTimeout(res, 10))
    r.stop()
    await expect(sendP).rejects.toThrow()
    await new Promise((res) => setTimeout(res, 200))
    await expect(fs.access(path.join(recvDir, 'big.bin.part'))).rejects.toThrow()
  })
})
