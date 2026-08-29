import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { Sender } from '../../src/main/network/sender'
import { Receiver, type OfferSummary } from '../../src/main/network/receiver'
import { encodeFrame, type OfferMessage } from '../../src/main/network/protocol'
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

  it('接受后无数据到达：按无数据超时失败并清理 .part', async () => {
    // 用小超时加速测试
    const r = new Receiver({ port: TCP_PORT, saveDir: () => recvDir, noDataTimeoutMs: 300 })
    receiver = r
    r.start()
    await new Promise<void>((res) => r.once('listening', res))

    // 原始 socket 发送合法 OFFER，接受后不再发送任何数据
    const sock = net.createConnection({ host: '127.0.0.1', port: TCP_PORT })
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', resolve)
      sock.once('error', reject)
    })
    const offer: OfferMessage = {
      type: 'OFFER', transferId: 't-idle', senderId: 'me', senderName: 'Me',
      fileCount: 1, totalBytes: 10,
      files: [{ type: 'file', path: 'a.txt', size: 10 }]
    }
    sock.write(encodeFrame(offer))

    const offerSum = await new Promise<OfferSummary>((res) => r.once('offer', res))
    r.respond(offerSum.transferId, 'accept')

    const { error } = await new Promise<{ transferId: string; error: Error }>((res) =>
      r.once('transferError', (e) => res(e))
    )
    expect(error.message).toMatch(/无数据/)
    sock.destroy()
    await new Promise((res) => setTimeout(res, 100))
    await expect(fs.access(path.join(recvDir, 'a.txt.part'))).rejects.toThrow()
  })

  it('文件传输中被截断：发送方按实际字节校验失败，报错而非错位继续（P1 回归）', { timeout: 15000 }, async () => {
    const srcFile = path.join(root, 'shrink.bin')
    const initial = Buffer.alloc(2 * 1024 * 1024, 7) // 2MB：保证读流未结束时有机会截断
    await fs.writeFile(srcFile, initial)
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start(
      { host: '127.0.0.1', port: TCP_PORT },
      't-shrink',
      [{ relPath: 'shrink.bin', absPath: srcFile, type: 'file', size: initial.length }],
      initial.length
    )
    const offer = await offerP
    r.respond(offer.transferId, 'accept')
    // 发送进行中把文件截断为 1MB：读流提前 end，实际发送 1MB < 清单 2MB
    await fs.truncate(srcFile, 1024 * 1024)
    await expect(sendP).rejects.toThrow(/传输中被修改/)
    // 接收侧：无完整落盘文件（.part 被失败清理）
    await new Promise((res) => setTimeout(res, 300))
    const leftovers = await fs.readdir(recvDir)
    expect(leftovers).toEqual([])
  })

  it('发送方传输中取消：接收方快速感知失败（不等 30s 超时）且 .part 无残留', { timeout: 15000 }, async () => {
    const srcFile = path.join(root, 'big.bin')
    await fs.writeFile(srcFile, Buffer.alloc(32 * 1024 * 1024, 7))
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-y', [{ relPath: 'big.bin', absPath: srcFile, type: 'file', size: 32 * 1024 * 1024 }], 32 * 1024 * 1024)
    const offer = await offerP
    r.respond(offer.transferId, 'accept')
    await new Promise((res) => setTimeout(res, 10))
    // 监听先于 cancel 挂上：transferError 在 cancel 后瞬间发出（FIN → end → fail），
    // 挂晚了会错过事件（新接收管线下早于 sendP reject）
    const errP = new Promise<{ transferId: string; error: Error }>((res) =>
      r.once('transferError', (e) => res(e))
    )
    sender.cancel()
    // 发送方失败
    await expect(sendP).rejects.toThrow()
    // 接收方应通过 end 事件快速感知（FIN → fail），而非等 30s 无数据超时
    const { error } = await errP
    expect(error.message).toMatch(/取消/)
    await new Promise((res) => setTimeout(res, 200)) // 等异步 .part 清理完成
    await expect(fs.access(path.join(recvDir, 'big.bin.part'))).rejects.toThrow()
  })

  it('慢磁盘（注入写盘延迟）：收包与落盘解耦，传输仍正确完成且内容一致（方案 2 回归）', { timeout: 30000 }, async () => {
    // 每块写盘延迟 15ms：写盘循环明显慢于网络（回环上数据瞬间到达）。
    // 预期：网络全速入队、写盘慢慢消费、队列水位受控、全部落盘后 TRANSFER_ACK，
    // 发送方动态 ACK 超时不误杀；最终内容逐字节一致。
    const files: WalkEntry[] = []
    const contents = new Map<string, Buffer>()
    for (let i = 0; i < 20; i++) {
      const p = path.join(root, `slow${i}.bin`)
      const buf = Buffer.alloc(64 * 1024, i)
      await fs.writeFile(p, buf)
      contents.set(`slow${i}.bin`, buf)
      files.push({ relPath: `slow${i}.bin`, absPath: p, type: 'file', size: buf.length })
    }
    const totalBytes = 20 * 64 * 1024
    const r = new Receiver({ port: TCP_PORT, saveDir: () => recvDir, sinkWriteDelayMs: 15 })
    receiver = r
    r.start()
    await new Promise<void>((res) => r.once('listening', res))
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-slow', files, totalBytes)
    const offer = await offerP
    r.respond(offer.transferId, 'accept')
    await sendP // 动态 ACK 超时（30s + totalBytes/20MB/s）容许排空时长
    // 逐字节校验
    for (const [name, buf] of contents) {
      const got = await fs.readFile(path.join(recvDir, name))
      expect(got.equals(buf)).toBe(true)
    }
    expect(await fs.readdir(recvDir)).toHaveLength(20)
  })

  it('接收方传输中取消：发送方收到取消提示且 .part 无残留', { timeout: 15000 }, async () => {
    const srcFile = path.join(root, 'big.bin')
    await fs.writeFile(srcFile, Buffer.alloc(32 * 1024 * 1024, 7))
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-x', [{ relPath: 'big.bin', absPath: srcFile, type: 'file', size: 32 * 1024 * 1024 }], 32 * 1024 * 1024)
    const offer = await offerP
    r.respond(offer.transferId, 'accept')
    // 传输进行中，接收方取消
    await new Promise((res) => setTimeout(res, 10))
    r.cancelTransfer(offer.transferId)
    // 发送方 UI 收到的 failed 事件应为对方已取消传输；sendP 仅断言失败（底层错误消息无关）
    const failedP = new Promise<string>((res) => sender.once('failed', (f: { reason: string }) => res(f.reason)))
    await expect(sendP).rejects.toThrow()
    expect(await failedP).toMatch(/取消/)
    await new Promise((res) => setTimeout(res, 200))
    await expect(fs.access(path.join(recvDir, 'big.bin.part'))).rejects.toThrow()
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
