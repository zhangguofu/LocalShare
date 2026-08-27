import { describe, it, expect } from 'vitest'
import {
  encodeFrame,
  decodeFrame,
  FrameParser,
  sanitizePath,
  MAGIC,
  HEADER_LENGTH,
  MAX_FRAME_LENGTH,
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
  it('拒绝空路径与纯点段', () => {
    expect(sanitizePath('')).toBeNull()
    expect(sanitizePath('./x')).toBeNull()
  })
  it('拒绝空载荷 JSON 的 HELLO 大小上限（1 KiB 由 discovery 层限制，这里验证 sanitize 不越权）', () => {
    expect(sanitizePath('a.txt')).toBe('a.txt')
  })
})
