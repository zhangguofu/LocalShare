import { it, expect } from 'vitest'
import net from 'node:net'
import { Readable } from 'node:stream'
import type { ReadStream } from 'node:fs'
import { pipeFile } from '../../src/main/network/sender'

// 真实套接字上的预读验证：对端「接受连接后不再读取」→ 制造真实 TCP 背压。
// 与 tests/unit/sender-readahead.test.ts 的假套接字版本互补：这里验证的是
// 真实套接字的 writableLength / 写入回调语义下，预读同样成立（旧实现只会读 1 块）。

class PullSource extends Readable {
  pulls = 0
  private emitted = 0
  constructor(
    private readonly chunk: number,
    private readonly total: number
  ) {
    super()
  }
  _read(): void {
    this.pulls++
    if (this.emitted >= this.total) {
      this.push(null)
      return
    }
    this.emitted++
    this.push(Buffer.alloc(this.chunk, 3))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

it('真实套接字背压下：发送端预读多块后才停（旧实现只读 1 块）', { timeout: 15000 }, async () => {
  const conns: net.Socket[] = []
  const srv = net.createServer((s) => {
    conns.push(s)
    s.pause() // 接受后永不读取 → 真实 TCP 背压
  })
  let cli: net.Socket | null = null
  try {
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as net.AddressInfo).port
    cli = net.createConnection({ host: '127.0.0.1', port })
    const sock = cli
    await new Promise<void>((r) => sock.once('connect', () => r()))

    const src = new PullSource(1024 * 1024, 128) // 128 MB 可读，远超预读上限
    void pipeFile(sock, src as unknown as ReadStream, () => {})

    // 等预读稳定：连续 3 次采样「已读块数」不再增长
    let lastPulls = -1
    let stable = 0
    for (let i = 0; i < 120 && stable < 3; i++) {
      await sleep(25)
      if (src.pulls === lastPulls && src.pulls > 1) stable++
      else stable = 0
      lastPulls = src.pulls
    }

    // 旧实现：写第一块即 pause → 1 块；新实现：预读到约 8 MB 上限才停
    expect(src.pulls, `预读块数=${src.pulls}`).toBeGreaterThan(3)
    expect(sock.writableLength, `积压=${sock.writableLength}`).toBeGreaterThan(2 * 1024 * 1024)
  } finally {
    cli?.destroy()
    for (const c of conns) c.destroy()
    await new Promise<void>((r) => srv.close(() => r()))
  }
})
