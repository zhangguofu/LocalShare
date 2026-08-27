import net from 'node:net'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import {
  encodeFrame,
  decodeFrame,
  sanitizePath,
  HEADER_LENGTH,
  MAX_FRAME_LENGTH,
  type Message,
  type OfferMessage,
  type FileHeaderMessage,
  type FileDoneMessage
} from './protocol'
import { AtomicSink, detectConflicts } from '../storage'

export interface OfferSummary {
  transferId: string
  senderId: string
  senderName: string
  fileCount: number
  totalBytes: number
  files: { type: 'file' | 'dir'; path: string; size: number }[]
  conflicts: boolean
}

export interface ReceiveProgress {
  transferId: string
  fileName: string
  totalBytes: number
}

type SessionCallbacks = {
  onOffer: (offer: OfferSummary) => void
  onProgress: (p: ReceiveProgress) => void
  onComplete: (transferId: string, saveDir: string) => void
  onError: (transferId: string, err: Error) => void
}

export class Receiver extends EventEmitter {
  private server: net.Server | null = null
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly opts: { port: number; saveDir: () => string }) {
    super()
  }

  // 事件：'listening' / 'offer' (OfferSummary) / 'progress' / 'complete' / 'transferError' / 'error'
  start(): void {
    if (this.server) return
    const server = net.createServer((socket) => {
      const session = new Session(socket, this.opts.saveDir(), {
        onOffer: (offer) => {
          this.sessions.delete('pending')
          this.sessions.set(offer.transferId, session)
          this.emit('offer', offer)
        },
        onProgress: (p) => this.emit('progress', p),
        onComplete: (id, saveDir) => this.emit('complete', id, saveDir),
        onError: (id, err) => this.emit('transferError', { transferId: id, error: err })
      })
      this.sessions.set('pending', session)
      session.on('closed', () => this.sessions.delete(session.transferId))
    })
    server.on('error', (err) => this.emit('error', err))
    server.listen(this.opts.port, () => this.emit('listening'))
    this.server = server
  }

  stop(cb?: () => void): void {
    // 断开所有活动会话（模拟退出/中断），触发各 Session 的 close → 清理 .part
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
    if (this.server) {
      const server = this.server
      this.server = null
      server.close(() => cb?.()) // 幂等：重复 stop 直接回调
    } else {
      cb?.()
    }
  }

  // UI 决策入口（经 IPC 调用）：accept（可带本次目标目录）/ reject
  respond(transferId: string, decision: 'accept' | 'reject', targetDir?: string): void {
    const session = this.sessions.get(transferId)
    if (!session) return
    if (decision === 'reject') session.reject('user_declined')
    else
      void session.accept(targetDir).catch((err: Error) => {
        // mkdir 失败（只读卷/目标为文件）：上报，避免 unhandledRejection 崩溃主进程
        this.emit('transferError', { transferId, error: err })
      })
  }
}

class Session extends EventEmitter {
  transferId = 'pending'
  private state: 'CTRL' | 'DATA' = 'CTRL'
  private ctrlBuf = Buffer.alloc(0)
  private current: { header: FileHeaderMessage; sink: AtomicSink; written: number } | null = null
  private targetDir: string | null = null
  private dirEntries: string[] = [] // OFFER 中的 type:'dir' 条目（sanitize 后的路径）
  private closed = false
  private msgChain: Promise<void> = Promise.resolve() // 串行化 async 消息处理（非数据帧）

  constructor(
    private readonly socket: net.Socket,
    private readonly defaultDir: string,
    private readonly ev: SessionCallbacks
  ) {
    super()
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      try {
        this.onData(buf)
      } catch (err) {
        this.fail(err as Error)
      }
    })
    socket.on('error', (err) => this.fail(err))
    socket.on('close', () => {
      this.closed = true
      this.cleanup()
      this.emit('closed')
    })
  }

  // 同步状态机：CTRL 逐帧解析；FILE_HEADER 后紧跟裸数据，立即切 DATA 消费；FILE_DONE 同步校验
  private onData(chunk: Buffer): void {
    if (this.state === 'DATA') {
      this.consumeData(chunk)
      return
    }
    this.ctrlBuf = Buffer.concat([this.ctrlBuf, chunk])
    while (this.ctrlBuf.length >= HEADER_LENGTH) {
      const length = this.ctrlBuf.readUInt32BE(4)
      if (length > MAX_FRAME_LENGTH) throw new Error('frame too large')
      if (this.ctrlBuf.length < HEADER_LENGTH + length) return // 帧不完整，等待更多数据
      const frame = this.ctrlBuf.subarray(0, HEADER_LENGTH + length)
      this.ctrlBuf = this.ctrlBuf.subarray(HEADER_LENGTH + length)
      const msg = decodeFrame(frame) // magic/长度/JSON 校验，非法即抛错
      if (msg.type === 'FILE_HEADER') {
        this.beginFile(msg)
        const rest = this.ctrlBuf
        this.ctrlBuf = Buffer.alloc(0)
        if (msg.size > 0) {
          this.consumeData(rest) // 剩余字节全部属于文件数据
          return
        }
        this.onData(rest) // 零字节文件：剩余是后续帧，继续解析
        return
      }
      if (msg.type === 'FILE_DONE') {
        this.onFileDoneSync(msg)
        continue
      }
      this.msgChain = this.msgChain.then(() => this.onMessage(msg)).catch((err: Error) => this.fail(err))
    }
  }

  // 同步开始一个文件：开 sink（同步）并切 DATA
  private beginFile(msg: FileHeaderMessage): void {
    const safe = sanitizePath(msg.path)
    if (!safe) throw new Error('protocol error: unsafe path ' + msg.path)
    if (!Number.isFinite(msg.size) || msg.size < 0) throw new Error('protocol error: invalid size ' + msg.size)
    const target = path.join(this.targetDir ?? this.defaultDir, safe)
    const sink = new AtomicSink(target)
    sink.open()
    // 写盘错误（磁盘满/权限）：发 ERROR 帧并断开（设计 7）
    sink.stream?.on('error', (err: Error) => {
      this.sendError('write_failed', err.message)
      this.fail(err)
    })
    this.current = { header: { ...msg, path: safe }, sink, written: 0 }
    if (msg.size > 0) this.state = 'DATA'
  }

  // 同步消费文件数据；写满 size 后回 CTRL，剩余字节递归回到帧解析。带背压：
  // sink 缓冲写满（write 返回 false）时暂停 socket，待 drain 后恢复（设计 5.4 内存恒定）
  private consumeData(chunk: Buffer): void {
    const cur = this.current!
    const need = cur.header.size - cur.written
    if (chunk.length <= need) {
      if (!cur.sink.write(chunk)) this.pauseForDrain(cur)
      cur.written += chunk.length
      if (cur.written === cur.header.size) this.state = 'CTRL'
      return
    }
    if (!cur.sink.write(chunk.subarray(0, need))) this.pauseForDrain(cur)
    cur.written = cur.header.size
    this.state = 'CTRL'
    this.onData(chunk.subarray(need))
  }

  private pauseForDrain(cur: { sink: AtomicSink }): void {
    this.socket.pause()
    cur.sink.stream?.once('drain', () => {
      if (!this.closed) this.socket.resume()
    })
  }

  private async onMessage(msg: Message): Promise<void> {
    switch (msg.type) {
      case 'OFFER':
        await this.onOffer(msg)
        break
      // FILE_HEADER / FILE_DONE 已在 onData 同步处理，不会进入此链
      case 'TRANSFER_DONE':
        await this.onTransferDone(msg)
        break
      case 'CANCEL':
        this.fail(new Error('cancelled by peer: ' + msg.reason))
        break
      case 'ERROR':
        this.fail(new Error(`${msg.code}: ${msg.message}`))
        break
      default:
        break
    }
  }

  private async onOffer(msg: OfferMessage): Promise<void> {
    // 先对全部路径做清洗校验，任何一条非法即协议错误断开（规格 5.6）
    const files: OfferSummary['files'] = []
    for (const e of msg.files) {
      const safe = sanitizePath(e.path)
      if (!safe) throw new Error('protocol error: unsafe path ' + e.path)
      files.push({ type: e.type, path: safe, size: e.size ?? 0 })
    }
    this.transferId = msg.transferId
    this.dirEntries = files.filter((f) => f.type === 'dir').map((f) => f.path)
    this.ev.onOffer({
      transferId: msg.transferId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      fileCount: msg.fileCount,
      totalBytes: msg.totalBytes,
      files,
      conflicts: await detectConflicts(files.map((f) => ({ type: f.type, path: f.path })), this.defaultDir)
    })
  }

  async accept(targetDir?: string): Promise<void> {
    this.targetDir = targetDir ?? this.defaultDir
    // 为 OFFER 中的空目录条目创建目录（type:'dir' 不产生文件流）
    for (const rel of this.dirEntries) {
      await fs.mkdir(path.join(this.targetDir, rel), { recursive: true })
    }
    if (!this.closed) this.socket.write(encodeFrame({ type: 'ACCEPT', transferId: this.transferId }))
  }

  reject(reason: string): void {
    if (!this.closed) this.socket.write(encodeFrame({ type: 'REJECT', transferId: this.transferId, reason }))
    this.socket.end()
    this.cleanup()
  }

  // 立即断开连接（Receiver.stop 调用），触发 close 清理
  dispose(): void {
    if (!this.closed) this.socket.destroy()
  }

  private async onFileDone(msg: FileDoneMessage): Promise<void> {
    // 同步路径已在 onData 处理（onFileDoneSync）；此处仅兜底（不应触发）
    this.onFileDoneSync(msg)
  }

  // 同步校验文件完成：current 必须匹配、字节数一致；commit 异步入链
  private onFileDoneSync(msg: FileDoneMessage): void {
    if (!this.current || this.current.header.path !== msg.path) {
      throw new Error('protocol error: FILE_DONE without matching file')
    }
    if (msg.bytesWritten !== this.current.header.size) {
      throw new Error(`protocol error: bytesWritten ${msg.bytesWritten} != size ${this.current.header.size}`)
    }
    const cur = this.current
    this.current = null
    this.msgChain = this.msgChain
      .then(() => cur.sink.commit())
      .catch((err: Error) => {
        // 落盘失败（磁盘满/权限/rename 失败）：发 ERROR 帧，发送方显示具体原因（设计 7）
        this.sendError('write_failed', err.message)
        this.fail(err)
      })
    this.ev.onProgress({ transferId: this.transferId, fileName: msg.path, totalBytes: cur.header.size })
  }

  // 发送 ERROR 帧（本地资源错误时；协议违规/对端主动行为不发送）
  private sendError(code: string, message: string): void {
    if (this.closed || this.transferId === 'pending') return
    try {
      this.socket.write(encodeFrame({ type: 'ERROR', transferId: this.transferId, code, message }))
    } catch {
      // 对端可能已断开，忽略
    }
  }

  private async onTransferDone(_msg: Message): Promise<void> {
    if (this.current) {
      throw new Error('protocol error: TRANSFER_DONE during file transfer')
    }
    this.socket.write(encodeFrame({ type: 'TRANSFER_ACK', transferId: this.transferId }))
    this.ev.onComplete(this.transferId, this.targetDir ?? this.defaultDir)
    this.socket.end()
    this.cleanup()
  }

  private cleanup(): void {
    if (this.current) {
      void this.current.sink.abort()
      this.current = null
    }
    this.state = 'CTRL'
  }

  private fail(err: Error): void {
    if (this.closed) return
    this.ev.onError(this.transferId, err)
    this.socket.destroy()
    this.cleanup()
  }
}
