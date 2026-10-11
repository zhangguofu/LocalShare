import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type net from 'node:net'
import type { ReadStream } from 'node:fs'
import { pipeFile } from '../../src/main/network/sender'

// 发送侧预读（衔接）机制的行为验证。
//
// 需求：发送端必须「提前准备下一块」，让读盘与发送在时间上重叠，链路上不留无人供数的空档。
// 旧实现 `if (!socket.write(buf)) stream.pause()` + 仅 `drain` 恢复 → 每写一块就停，
// 且恢复时机是「积压归零」，内核里已无数据可发，链路必然空转一个读盘来回。

const SOCKET_HWM = 64 * 1024 // 模拟真实套接字的写水位：远小于一个数据块

/** 可控的假套接字：write 只入队不落盘，由测试显式“收走”，以便精确复现背压。 */
class FakeSocket extends EventEmitter {
  private pendingBytes = 0
  private queue: { n: number; cb: () => void }[] = []
  writeCalls = 0

  get writableLength(): number {
    return this.pendingBytes
  }

  write(buf: Buffer, cb?: (err?: Error) => void): boolean {
    this.writeCalls++
    this.pendingBytes += buf.length
    this.queue.push({ n: buf.length, cb: () => cb?.() })
    return this.pendingBytes < SOCKET_HWM
  }

  /** 模拟内核按块收走 k 块（每块收走即触发该块的写入回调）。 */
  acceptChunks(k: number): void {
    while (k-- > 0) {
      const head = this.queue.shift()
      if (!head) return
      this.pendingBytes -= head.n
      head.cb()
    }
    // 保真：真实套接字在写队列清空时会发出 drain
    if (this.pendingBytes === 0) this.emit('drain')
  }
}

/** 拉取式数据源：每次 _read 才吐一块，因此「拉了几块」= 发送端真正预读了多少。 */
class PullSource extends Readable {
  pulls = 0
  private emitted = 0
  pendingAtPull: number[] = []

  constructor(
    private readonly chunkSize: number,
    private readonly totalChunks: number,
    private readonly sock: FakeSocket
  ) {
    super()
  }

  _read(): void {
    this.pulls++
    this.pendingAtPull.push(this.sock.writableLength)
    if (this.emitted >= this.totalChunks) {
      this.push(null) // 结束
      return
    }
    this.emitted++
    this.push(Buffer.alloc(this.chunkSize, 7))
  }
}

const asSocket = (f: FakeSocket): net.Socket => f as unknown as net.Socket
// 只用到 Readable 的 data/pause/resume/end/error 面，无需真实文件读流
const asStream = (s: Readable): ReadStream => s as unknown as ReadStream
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('发送侧预读衔接（pipeFile）', () => {
  it('套接字积压不释放时，读流仍继续预读多块（旧实现写一块就停）', async () => {
    const sock = new FakeSocket()
    const src = new PullSource(1024 * 1024, 64, sock)
    void pipeFile(asSocket(sock), asStream(src), () => {})
    await tick()

    // 旧实现：第一块 write 返回 false 即 pause → pulls === 1、积压只有 1 MB
    expect(src.pulls).toBeGreaterThan(1)
    expect(sock.writableLength).toBeGreaterThan(4 * 1024 * 1024)
    // 预读上限生效：不会一路读到文件尾（内存有界）
    expect(sock.writableLength).toBeLessThanOrEqual(16 * 1024 * 1024)
    expect(src.pulls).toBeLessThanOrEqual(16)
  })

  it('积压降到低水位就恢复读盘，不必等到归零（不依赖 drain）', async () => {
    const sock = new FakeSocket()
    const CHUNK = 256 * 1024
    const src = new PullSource(CHUNK, 200, sock)
    let alive = 0
    void pipeFile(asSocket(sock), asStream(src), () => {}, () => alive++)
    await tick()

    const pullsAtPause = src.pulls
    expect(pullsAtPause).toBeGreaterThan(1)

    // 收走一部分：积压仍明显大于 0，但已低于低水位 → 应立刻补货
    sock.acceptChunks(18) // 8MB - 4.5MB = 3.5MB 仍在内核/写队列中
    await tick()
    expect(sock.writableLength).toBeGreaterThan(0)
    expect(src.pulls).toBeGreaterThan(pullsAtPause)

    // 恢复发生在“仍有积压”时，即内核里始终有数据可发
    const resumedWithBacklog = src.pendingAtPull.slice(pullsAtPause).some((v) => v > 0)
    expect(resumedWithBacklog).toBe(true)
    // 写入回调同时充当存活信号
    expect(alive).toBeGreaterThan(0)
  })

  it('数据源结束后按实际发送字节 resolve', async () => {
    const sock = new FakeSocket()
    sock.acceptChunks(0)
    const src = new PullSource(1024 * 1024, 3, sock)
    // 每读一块就立刻收走，模拟对端持续消费
    const pump = setInterval(() => sock.acceptChunks(1), 1)
    const r = await pipeFile(asSocket(sock), asStream(src), () => {})
    clearInterval(pump)
    expect(r.written).toBe(3 * 1024 * 1024)
  })
})
