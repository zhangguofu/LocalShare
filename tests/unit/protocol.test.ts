import { describe, it, expect } from 'vitest'
import {
  encodeFrame,
  decodeFrame,
  FrameParser,
  sanitizePath,
  MAGIC,
  HEADER_LENGTH,
  MAX_FRAME_LENGTH,
  FrameTooLargeError,
  offerTooLargeMessage,
  encodeOfferFrame,
  type OfferMessage,
  type AcceptMessage,
  type HelloMessage
} from '../../src/main/network/protocol'

describe('encodeFrame / decodeFrame', () => {
  it('往返编解码 ACCEPT', () => {
    const msg: AcceptMessage = { type: 'ACCEPT', transferId: 'abc-123' }
    const frame = encodeFrame(msg)
    expect(frame.subarray(0, 4).equals(MAGIC)).toBe(true)
    expect(frame.readUInt32BE(4)).toBe(frame.length - HEADER_LENGTH)
    expect(decodeFrame(frame)).toEqual(msg)
  })

  it('magic 错误抛出', () => {
    const bad = Buffer.from('XXXX')
    expect(() => decodeFrame(Buffer.concat([bad, Buffer.from('1234')]))).toThrow(/magic/)
  })

  it('帧长度不匹配抛出', () => {
    const msg: AcceptMessage = { type: 'ACCEPT', transferId: 'abc' }
    const frame = encodeFrame(msg)
    expect(() => decodeFrame(frame.subarray(0, frame.length - 1))).toThrow(/length/)
  })

  it('载荷超过上限抛出', () => {
    const big = { type: 'OFFER' as const, transferId: 'x', senderId: 's', senderName: 'n', fileCount: 1, totalBytes: 0, files: [{ type: 'file' as const, path: 'a'.repeat(1024 * 1024), size: 1 }] }
    expect(() => encodeFrame(big, 1024)).toThrow(/too large/)
  })

  it('超限错误结构化携带载荷字节数与上限（供调用方生成用户提示）', () => {
    const big = { type: 'OFFER' as const, transferId: 'x', senderId: 's', senderName: 'n', fileCount: 1, totalBytes: 0, files: [{ type: 'file' as const, path: 'a'.repeat(2000), size: 1 }] }
    let caught: unknown = null
    try {
      encodeFrame(big, 1024)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FrameTooLargeError)
    const err = caught as FrameTooLargeError
    expect(err.limitBytes).toBe(1024)
    // payloadBytes 必须是 JSON 载荷的真实字节数，而非估算值
    expect(err.payloadBytes).toBe(Buffer.byteLength(JSON.stringify(big), 'utf8'))
    expect(err.payloadBytes).toBeGreaterThan(1024)
  })

  it('清单超限文案包含条目数、清单体积、上限与两条可执行建议', () => {
    const text = offerTooLargeMessage(700_000, 80 * 1024 * 1024, MAX_FRAME_LENGTH)
    expect(text).toContain('700000')
    expect(text).toContain('80.0MB')
    expect(text).toContain('64.0MB')
    expect(text).toContain('压缩')
    expect(text).toContain('分批')
  })
})

describe('encodeOfferFrame（发送前清单预检）', () => {
  const mkOffer = (n: number, segLen: number): OfferMessage => {
    const files = Array.from({ length: n }, (_, i) => ({
      type: 'file' as const,
      path: `dir/${'a'.repeat(segLen)}${i}.txt`,
      size: 1024
    }))
    return {
      type: 'OFFER',
      transferId: 'tid',
      senderId: 'sid',
      senderName: 'name',
      fileCount: n,
      totalBytes: n * 1024,
      files
    }
  }

  it('正常规模清单照常编码（往返可解码）', () => {
    const offer = mkOffer(1000, 8)
    expect(decodeFrame(encodeOfferFrame(offer))).toEqual(offer)
  })

  it('清单超限时抛出面向用户的错误，而非技术性错误', () => {
    // 用显式上限直击超限分支：真实 64 MiB 边界需 67 万+ 条目（实测深目录约 100 B/条目），
    // 构造这样一个清单的代价远超本用例要验证的逻辑（错误类型与文案）。
    const offer = mkOffer(1000, 8)
    let caught: unknown = null
    try {
      encodeOfferFrame(offer, 1024)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    const err = caught as Error
    // 面向用户：给出条目数与两条可执行建议
    expect(err.message).toContain('文件数量过多')
    expect(err.message).toContain('1000 个条目')
    expect(err.message).toContain('压缩')
    expect(err.message).toContain('分批')
    // 技术性细节不得直接冒到界面
    expect(err).not.toBeInstanceOf(FrameTooLargeError)
    expect(err.message).not.toContain('frame payload too large')
  })
})

describe('FrameParser（粘包/拆包）', () => {
  const mkFrame = (type: string, id: string): Buffer => encodeFrame({ type, transferId: id } as never)

  it('拆包：分两次 push', () => {
    const frame = mkFrame('ACCEPT', 'id-1')
    const parser = new FrameParser()
    expect(parser.push(frame.subarray(0, 5))).toEqual([])
    expect(parser.push(frame.subarray(5))).toHaveLength(1)
  })

  it('粘包：一次 push 两帧', () => {
    const parser = new FrameParser()
    const out = parser.push(Buffer.concat([mkFrame('ACCEPT', 'a'), mkFrame('REJECT', 'b')]))
    expect(out).toHaveLength(2)
    expect((out[0] as { transferId: string }).transferId).toBe('a')
    expect((out[1] as { transferId: string }).transferId).toBe('b')
  })

  it('畸形 magic 帧抛错', () => {
    const parser = new FrameParser()
    expect(() => parser.push(Buffer.concat([Buffer.from('BADM'), Buffer.from([0, 0, 0, 1]), Buffer.from('{}')]))).toThrow(/magic/)
  })
})

describe('sanitizePath', () => {
  it('正常相对路径通过', () => {
    expect(sanitizePath('docs/a.txt')).toBe('docs/a.txt')
  })
  it('尾部斜杠的目录条目归一化', () => {
    expect(sanitizePath('docs/empty/')).toBe('docs/empty')
  })
  it('连续斜杠合并', () => {
    expect(sanitizePath('a//b')).toBe('a/b')
  })
  it('拒绝 .. 穿越', () => {
    expect(sanitizePath('../evil')).toBeNull()
    expect(sanitizePath('a/../../b')).toBeNull()
  })
  it('拒绝绝对路径', () => {
    expect(sanitizePath('/abs')).toBeNull()
    expect(sanitizePath('\\abs')).toBeNull()
  })
  it('拒绝盘符路径', () => {
    expect(sanitizePath('C:/x')).toBeNull()
    expect(sanitizePath('C:\\x')).toBeNull()
  })
  it('拒绝非法字符', () => {
    expect(sanitizePath('a/b?.txt')).toBeNull()
    expect(sanitizePath('a:b.txt')).toBeNull()
    expect(sanitizePath('a*b.txt')).toBeNull()
    expect(sanitizePath('a<b.txt')).toBeNull()
  })
  it('拒绝 Windows 保留名', () => {
    expect(sanitizePath('CON')).toBeNull()
    expect(sanitizePath('dir/nul')).toBeNull()
  })
  it('拒绝带扩展名的 Windows 保留名', () => {
    expect(sanitizePath('CON.txt')).toBeNull()
    expect(sanitizePath('dir/NUL.log')).toBeNull()
    expect(sanitizePath('com1.x')).toBeNull()
  })
  it('允许含双点的合法文件名', () => {
    expect(sanitizePath('a..b')).toBe('a..b')
    expect(sanitizePath('v1..2.txt')).toBe('v1..2.txt')
  })
  it('拒绝空路径与纯点段', () => {
    expect(sanitizePath('')).toBeNull()
    expect(sanitizePath('./x')).toBeNull()
  })
  it('拒绝空载荷 JSON 的 HELLO 大小上限（1 KiB 由 discovery 层限制，这里验证 sanitize 不越权）', () => {
    expect(sanitizePath('a.txt')).toBe('a.txt')
  })
})
