import { describe, it, expect, afterEach, vi } from 'vitest'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Sender, isLocalNetworkBlocked, describeConnectError } from '../../src/main/network/sender'
import { Receiver } from '../../src/main/network/receiver'

const PORT = 45911

// 依据 Apple TN3179《Understanding local network privacy》：
//   首次本地网络操作可能在用户回答授权提示**之前**就被系统直接拒绝（macOS 表现为
//   EHOSTUNREACH / "No route to host"），官方要求为这种情况加入适当的重试逻辑。
// 本文件验证我们确实按该要求实现：被拒绝后重试，用户点了「允许」本次传输照样成功。

/** 造一个"连接就被系统拒绝"的假 socket（模拟本地网络权限未授予时的 EHOSTUNREACH）。 */
function refusingSocket(code: string): net.Socket {
  const fake = Object.assign(new EventEmitter(), { destroy: (): void => {} })
  setImmediate(() => {
    const err = Object.assign(new Error(`connect ${code} 127.0.0.1:${PORT}`), { code })
    fake.emit('error', err)
  })
  return fake as unknown as net.Socket
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('发送端连接重试（Apple TN3179 要求）', () => {
  it('errno 判定与用户可读提示', () => {
    expect(isLocalNetworkBlocked({ code: 'EHOSTUNREACH' } as NodeJS.ErrnoException)).toBe(true)
    expect(isLocalNetworkBlocked({ code: 'ENETUNREACH' } as NodeJS.ErrnoException)).toBe(true)
    expect(isLocalNetworkBlocked({ code: 'ECONNREFUSED' } as NodeJS.ErrnoException)).toBe(false)

    const msg = describeConnectError({ code: 'EHOSTUNREACH' } as NodeJS.ErrnoException, '192.168.1.4', 45556)
    expect(msg).toContain('本地网络') // 提示必须包含可操作的指引，而不是一行英文 errno
    expect(msg).toContain('192.168.1.4:45556')
    const refused = describeConnectError({ code: 'ECONNREFUSED' } as NodeJS.ErrnoException, 'a', 1)
    expect(refused).toContain('对方未在运行')
  })

  it('始终被拒绝：按 1 + N 次尝试后报出可操作错误', { timeout: 15000 }, async () => {
    const spy = vi.spyOn(net, 'createConnection').mockImplementation(() => refusingSocket('EHOSTUNREACH'))
    const sender = new Sender({ senderId: 'me', senderName: 'Me', connectRetryDelaysMs: [1, 1, 1] })
    let reason = ''
    sender.on('failed', (f: { reason: string }) => (reason = f.reason))

    await sender.start({ host: '127.0.0.1', port: PORT }, 'retry-1', [
      { relPath: 'x.txt', absPath: '/tmp/x.txt', type: 'file', size: 1 }
    ], 1).catch(() => {})

    expect(spy).toHaveBeenCalledTimes(4) // 1 次首次 + 3 次重试
    expect(reason).toContain('本地网络')
  })

  it('首次被拒绝、重试后成功：本次传输照常完成（官方要求的场景）', { timeout: 20000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-retry-'))
    const recvDir = path.join(root, 'recv')
    await fs.mkdir(recvDir)
    const src = path.join(root, 'a.txt')
    await fs.writeFile(src, 'retry works')

    const r = new Receiver({ port: PORT, saveDir: () => recvDir })
    r.on('offer', (o) => r.respond(o.transferId, 'accept'))
    r.start()
    await new Promise<void>((res) => r.once('listening', res))

    // 第一次连接被系统拒绝，之后走真实实现
    const real = net.createConnection.bind(net)
    vi.spyOn(net, 'createConnection')
      .mockImplementationOnce(() => refusingSocket('EHOSTUNREACH') as never)
      .mockImplementation(real as never)

    const sender = new Sender({ senderId: 'me', senderName: 'Me', connectRetryDelaysMs: [1, 1, 1] })
    const failed: string[] = []
    sender.on('failed', (f: { reason: string }) => failed.push(f.reason))
    await sender
      .start(
        { host: '127.0.0.1', port: PORT },
        'retry-2',
        [{ relPath: 'a.txt', absPath: src, type: 'file', size: 11 }],
        11
      )
      .catch(() => {})

    expect(failed).toEqual([]) // 没有被判失败：重试成功
    expect(await fs.readFile(path.join(recvDir, 'a.txt'), 'utf8')).toBe('retry works')
    await new Promise<void>((res) => r.stop(res))
    await fs.rm(root, { recursive: true, force: true })
  })
})
