// 帧格式：4B magic "LS1\0" + 4B uint32 BE length + JSON payload（UTF-8）
export const MAGIC = Buffer.from([0x4c, 0x53, 0x31, 0x00]) // "LS1\0"
export const HEADER_LENGTH = 8
export const MAX_FRAME_LENGTH = 16 * 1024 * 1024
export const MAX_DISCOVERY_LENGTH = 1024

// ---- 消息类型（协议 5.3 + 发现消息 4.3） ----
export interface FileEntry {
  type: 'file' | 'dir'
  path: string
  size?: number
}

export interface HelloMessage {
  type: 'HELLO'
  deviceId: string
  deviceName: string
  platform: string
  version: string
  tcpPort: number
  timestamp: number
}
export interface ByeMessage {
  type: 'BYE'
  deviceId: string
}
export interface OfferMessage {
  type: 'OFFER'
  transferId: string
  senderId: string
  senderName: string
  fileCount: number
  totalBytes: number
  files: FileEntry[]
}
export interface AcceptMessage {
  type: 'ACCEPT'
  transferId: string
}
export interface RejectMessage {
  type: 'REJECT'
  transferId: string
  reason: string
}
export interface FileHeaderMessage {
  type: 'FILE_HEADER'
  transferId: string
  path: string
  size: number
}
export interface FileDoneMessage {
  type: 'FILE_DONE'
  transferId: string
  path: string
  bytesWritten: number
}
// 分阶段确认（接收管线优化）：文件数据全部入接收方内存队列即回，
// 不等落盘。发送方据此显示“已送达”；TRANSFER_ACK（全部落盘）仍是最终安全终点。
// 兼容性：旧版发送方不认识此帧会忽略（未知类型 default 跳过）
export interface FileAckMessage {
  type: 'FILE_ACK'
  transferId: string
  path: string
}
// 水位背压心跳：接收方 pause 网络期间周期发送，告知发送方“我活着，只是在排空磁盘”。
// 发送方 socket idle 超时收到任何数据即重置——避免合法背压静默被误判连接死。
export interface KeepaliveMessage {
  type: 'KEEPALIVE'
  transferId: string
}
// 接收进度回传：接收方传输期间每 100ms 回发已收字节，发送方以此作为真实进度显示。
// 动机：发送方本地 sent 含“已入本机发送缓冲但未经网络确认”的字节，读流脉冲导致
// 进度台阶状；对端已收字节经 TCP 平滑是真实连续的，两端显示同一真实数字。
export interface ReceiveProgressMessage {
  type: 'RECV_PROGRESS'
  transferId: string
  bytes: number // 接收方已收到的累计字节（含内存队列中尚未落盘部分）
}
export interface TransferDoneMessage {
  type: 'TRANSFER_DONE'
  transferId: string
}
export interface TransferAckMessage {
  type: 'TRANSFER_ACK'
  transferId: string
}
export interface CancelMessage {
  type: 'CANCEL'
  transferId: string
  reason: string
}
export interface ErrorMessage {
  type: 'ERROR'
  transferId: string
  code: string
  message: string
}

export type Message =
  | HelloMessage
  | ByeMessage
  | OfferMessage
  | AcceptMessage
  | RejectMessage
  | FileHeaderMessage
  | FileDoneMessage
  | FileAckMessage
  | KeepaliveMessage
  | ReceiveProgressMessage
  | TransferDoneMessage
  | TransferAckMessage
  | CancelMessage
  | ErrorMessage

// ---- 帧编解码 ----
export function encodeFrame(msg: Message, maxLen: number = MAX_FRAME_LENGTH): Buffer {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8')
  if (payload.length > maxLen) {
    throw new Error(`frame payload too large: ${payload.length} > ${maxLen}`)
  }
  const header = Buffer.alloc(HEADER_LENGTH)
  MAGIC.copy(header, 0)
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

export function decodeFrame(buf: Buffer): Message {
  if (buf.length < HEADER_LENGTH) throw new Error('frame too short')
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('bad magic')
  const length = buf.readUInt32BE(4)
  if (length > MAX_FRAME_LENGTH) throw new Error('frame too large')
  if (buf.length !== HEADER_LENGTH + length) throw new Error('frame length mismatch')
  let msg: unknown
  try {
    msg = JSON.parse(buf.subarray(HEADER_LENGTH).toString('utf8'))
  } catch {
    throw new Error('invalid json')
  }
  if (typeof msg !== 'object' || msg === null || typeof (msg as { type?: unknown }).type !== 'string') {
    throw new Error('invalid message')
  }
  return msg as Message
}

// ---- 增量帧解析（粘包/拆包） ----
export class FrameParser {
  private buf = Buffer.alloc(0)

  push(chunk: Buffer): Message[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: Message[] = []
    for (;;) {
      if (this.buf.length < HEADER_LENGTH) break
      const length = this.buf.readUInt32BE(4)
      if (length > MAX_FRAME_LENGTH) throw new Error('frame too large')
      if (this.buf.length < HEADER_LENGTH + length) break
      out.push(decodeFrame(this.buf.subarray(0, HEADER_LENGTH + length)))
      this.buf = this.buf.subarray(HEADER_LENGTH + length)
    }
    return out
  }
}

// ---- 路径清洗（协议 5.6） ----
const INVALID_CHARS = /[\\/:*?"<>|\u0000-\u001f]/
// Windows 保留名（含带扩展名形式，如 CON.txt、dir/NUL.log）
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export function sanitizePath(p: string): string | null {
  if (!p || p.length === 0) return null
  if (p.startsWith('/') || p.startsWith('\\')) return null
  if (/^[a-zA-Z]:/.test(p)) return null
  if (p.startsWith('~')) return null
  const parts = p.split('/').filter((s) => s.length > 0)
  if (parts.length === 0) return null
  for (const part of parts) {
    if (part === '.' || part === '..') return null // 按段检查，避免误拒 a..b 等合法名
    if (INVALID_CHARS.test(part)) return null
    if (WINDOWS_RESERVED.test(part)) return null
  }
  return parts.join('/')
}
