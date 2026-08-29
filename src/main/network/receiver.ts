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
import { runPool } from './pool'

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
  totalBytes: number // 本次传输累计已收字节
}

const NO_DATA_TIMEOUT_MS = 30_000 // 接受后 30 秒无数据到达 → 判定传输挂死（设计 5.8）

// 接收管线（方案 2）：收包与落盘解耦。网络线程只入队，写盘循环顺序消费。
// 水位背压（滞回）：积压超 HIGH 暂停网络（TCP 零窗口，发送方自动停发），
// 消费到 LOW 以下恢复。磁盘毫秒级抖动被队列吸收，不再传导为网络停顿。
const HIGH_WATER_BYTES = 384 * 1024 * 1024
const LOW_WATER_BYTES = 128 * 1024 * 1024

// 写盘队列项：data 携带所属 sink（入队后 this.current 可能已指向下一文件）
type WriteItem =
  | { kind: 'data'; sink: AtomicSink; buf: Buffer }
  | { kind: 'file-done'; sink: AtomicSink; path: string; bytesWritten: number; size: number }
  | { kind: 'transfer-done' }

type SessionCallbacks = {
  onOffer: (offer: OfferSummary) => void
  onProgress: (p: ReceiveProgress) => void
  onComplete: (transferId: string, saveDir: string) => void
  onError: (transferId: string, err: Error) => void
  sinkWriteDelayMs?: number // 测试用：写盘延迟注入（模拟慢磁盘）
}

export class Receiver extends EventEmitter {
  private server: net.Server | null = null
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly opts: {
      port: number
      saveDir: () => string
      noDataTimeoutMs?: number
      sinkWriteDelayMs?: number // 测试用：注入写盘延迟，模拟慢磁盘/磁盘抖动
    }
  ) {
    super()
  }

  // 事件：'listening' / 'offer' (OfferSummary) / 'progress' / 'complete' / 'transferError' / 'error'
  start(): void {
    if (this.server) return
    const server = net.createServer((socket) => {
      const session = new Session(socket, this.opts.saveDir(), this.opts.noDataTimeoutMs ?? NO_DATA_TIMEOUT_MS, {
        sinkWriteDelayMs: this.opts.sinkWriteDelayMs ?? 0,
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

  // 二次冲突检测：用户指定了新目标目录后，检查该目录下是否有与传输清单重名的文件/目录
  // （设计 6.3：新位置仍有冲突则再次呈现选择，避免意外覆盖）
  async checkTargetDirConflicts(transferId: string, dir: string): Promise<boolean> {
    const session = this.sessions.get(transferId)
    if (!session) return false
    return session.checkConflicts(dir)
  }

  // 传输中取消（设计 5.3：任意一方可主动取消）：发 CANCEL 并断开，清理 .part
  cancelTransfer(transferId: string): void {
    const session = this.sessions.get(transferId)
    if (!session) return
    session.cancel('user_cancelled')
  }
}

class Session extends EventEmitter {
  transferId = 'pending'
  private state: 'CTRL' | 'DATA' = 'CTRL'
  private ctrlBuf = Buffer.alloc(0)
  private current: { header: FileHeaderMessage; sink: AtomicSink; written: number } | null = null
  private targetDir: string | null = null
  private dirEntries: string[] = [] // OFFER 中的 type:'dir' 条目（sanitize 后的路径）
  private offerFiles: { type: 'file' | 'dir'; path: string }[] = [] // 完整清单（二次冲突检测用）
  private closed = false
  private completed = false // 传输已正常完成（TRANSFER_DONE 处理过）
  private msgChain: Promise<void> = Promise.resolve() // 串行化 async 消息处理（非数据帧）
  private receivedBytes = 0 // 本次传输累计已收字节
  private lastProgressAt = 0
  private lastDataAt = 0 // 最近一次收到网络数据的时间（无数据超时检查）
  private lastWriteAt = 0 // 最近一次写盘块完成时间：水位背压 pause 期间网络无数据，
  // 但写盘在消费就是健康状态——超时基准取两者较近者，避免把“自暂停”误判为挂死
  private idleTimer: NodeJS.Timeout | null = null
  // 写盘队列（方案 2）
  private writeQueue: WriteItem[] = []
  private queuedBytes = 0 // 队列内未落盘字节
  private writeLoopRunning = false
  private writeIdle: (() => void) | null = null // 队列空时挂起等待的唤醒信号
  private netPaused = false // 水位背压状态（socket 是否处于 pause）
  private keepaliveTimer: NodeJS.Timeout | null = null // 水位 pause 期间的心跳（防发送方 idle 超时误判）

  constructor(
    private readonly socket: net.Socket,
    private readonly defaultDir: string,
    private readonly noDataTimeoutMs: number,
    private readonly ev: SessionCallbacks
  ) {
    super()
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer | string) => {
      this.lastDataAt = Date.now()
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      try {
        this.onData(buf)
      } catch (err) {
        this.fail(err as Error)
      }
    })
    socket.on('error', (err) => this.fail(err))
    // 对端 FIN（优雅关闭 = 取消）：若传输未完成则立即失败，不再等 30s 无数据超时
    // 语义：FIN → "对方已取消"；RST/超时 → "连接断开"
    socket.on('end', () => {
      if (!this.closed && !this.completed && this.transferId !== 'pending') {
        this.fail(new Error('对端已取消传输'))
      }
    })
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

  // 同步消费文件数据（方案 2 改造）：入队而不写盘；写满 size 后回 CTRL，剩余字节递归回帧解析。
  // 水位背压：积压超 HIGH 暂停网络（零窗口），写盘循环消费到 LOW 以下恢复。
  private consumeData(chunk: Buffer): void {
    const cur = this.current!
    const need = cur.header.size - cur.written
    const take = Math.min(chunk.length, need)
    // socket data 的 chunk 每次都是新 Buffer，subarray 视图安全（不会被复用覆盖）
    this.writeQueue.push({ kind: 'data', sink: cur.sink, buf: chunk.subarray(0, take) })
    this.queuedBytes += take
    cur.written += take
    this.receivedBytes += take
    this.emitProgress(cur.header.path)
    if (cur.written === cur.header.size) this.state = 'CTRL'
    if (this.queuedBytes > HIGH_WATER_BYTES && !this.netPaused && !this.closed) {
      this.netPaused = true
      this.socket.pause()
    }
    this.kickWriteLoop()
    if (chunk.length > take) this.onData(chunk.subarray(take))
  }

  // 唤醒写盘循环：未运行则启动；已运行且在等数据则唤醒（writeIdle 回调）
  private kickWriteLoop(): void {
    if (this.closed) return
    this.writeIdle?.()
    if (this.writeLoopRunning) return
    this.writeLoopRunning = true
    void this.writeLoop().finally(() => {
      this.writeLoopRunning = false
    })
  }

  // 写盘循环：顺序消费队列。data → 写 .part（await drain，慢盘在此减速）；
  // file-done → flush+rename（原子落盘）；transfer-done → 全部落盘完成，回 TRANSFER_ACK。
  private async writeLoop(): Promise<void> {
    for (;;) {
      if (this.closed) {
        this.writeQueue = []
        this.queuedBytes = 0
        return
      }
      const item = this.writeQueue.shift()
      if (!item) {
        // 队列空：若因水位暂停则恢复网络（空队列必然低于低水位）
        if (this.netPaused && !this.closed) {
          this.netPaused = false
          this.socket.resume()
        }
        await new Promise<void>((r) => {
          this.writeIdle = r
        })
        this.writeIdle = null
        continue
      }
      try {
        if (item.kind === 'data') {
          await this.writeToDisk(item.sink, item.buf)
          this.queuedBytes -= item.buf.length
          if (this.netPaused && this.queuedBytes < LOW_WATER_BYTES && !this.closed) {
            this.netPaused = false
            this.socket.resume()
          }
        } else if (item.kind === 'file-done') {
          await item.sink.commit() // flush + rename 原子落盘
          this.ev.onProgress({
            transferId: this.transferId,
            fileName: item.path,
            totalBytes: this.receivedBytes
          })
        } else {
          // transfer-done：队列在此项之前的所有 data/file-done 均已消费 → 全部落盘完成
          this.completed = true
          if (!this.closed) this.socket.write(encodeFrame({ type: 'TRANSFER_ACK', transferId: this.transferId }))
          this.ev.onComplete(this.transferId, this.targetDir ?? this.defaultDir)
          if (!this.closed) this.socket.end()
          this.cleanup()
          return
        }
      } catch (err) {
        // 落盘失败（磁盘满/权限/rename 失败）：发 ERROR 帧，发送方显示具体原因（设计 7）
        this.sendError('write_failed', (err as Error).message)
        this.fail(err as Error)
        return
      }
    }
  }

  private async writeToDisk(sink: AtomicSink, buf: Buffer): Promise<void> {
    // 测试注入：模拟慢磁盘（每块写前延迟；网络侧不受影响，仅写盘循环减速）
    const delayMs = this.ev.sinkWriteDelayMs ?? 0
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs))
    }
    await new Promise<void>((resolve, reject) => {
      const stream = sink.stream
      if (!stream) return resolve()
      const onErr = (err: Error): void => {
        stream.off('drain', onDrain)
        reject(err)
      }
      const onDrain = (): void => {
        stream.off('error', onErr)
        resolve()
      }
      stream.once('error', onErr)
      if (sink.write(buf)) {
        stream.off('error', onErr)
        resolve()
      } else {
        stream.once('drain', onDrain)
      }
    })
    // 写盘块完成：更新活动基准（水位 pause 期间证明传输链路仍健康）
    this.lastWriteAt = Date.now()
  }

  // 进度节流：至少 50ms 上报一次，避免高频 IPC
  private emitProgress(fileName: string): void {
    const now = Date.now()
    if (now - this.lastProgressAt < 50) return
    this.lastProgressAt = now
    this.ev.onProgress({ transferId: this.transferId, fileName, totalBytes: this.receivedBytes })
  }

  // 传输期心跳（ACCEPT 后启动，TRANSFER_ACK/cleanup 停止）：每 10 秒发 KEEPALIVE，
// 发送方存活检测收到任何帧即续命。不再仅在 netPaused 时发——TRANSFER_DONE 后接收方
// 排空剩余积压期间（可能分钟级），发送方无写无 drain，只有心跳能防止 30s 超时误杀。
  private startKeepalive(): void {
    if (this.keepaliveTimer) return
    this.keepaliveTimer = setInterval(() => {
      if (this.closed || this.completed) {
        this.stopKeepalive()
        return
      }
      try {
        this.socket.write(encodeFrame({ type: 'KEEPALIVE', transferId: this.transferId }))
      } catch {
        // 对端可能已断开，忽略
      }
    }, 10_000)
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
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
        this.fail(new Error('对方已取消传输'))
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
    this.offerFiles = files.map((f) => ({ type: f.type, path: f.path }))
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
    // 为 OFFER 中的空目录条目创建目录（type:'dir' 不产生文件流）；并发化防大量空目录串行拖慢
    await runPool(this.dirEntries, 16, async (rel) => {
      await fs.mkdir(path.join(this.targetDir as string, rel), { recursive: true })
    })
    if (!this.closed) this.socket.write(encodeFrame({ type: 'ACCEPT', transferId: this.transferId }))
    this.startIdleCheck() // 接受后启用无数据超时：30 秒无数据则判定挂死
    this.startKeepalive() // 传输全程心跳：防发送方存活检测在背压/排空静默期误杀
  }

  // 检查指定目录下是否存在与传输清单重名的文件/目录
  async checkConflicts(dir: string): Promise<boolean> {
    return detectConflicts(this.offerFiles, dir)
  }

  reject(reason: string): void {
    if (!this.closed) this.socket.write(encodeFrame({ type: 'REJECT', transferId: this.transferId, reason }))
    this.socket.end()
    this.cleanup()
  }

  // 传输中取消：发 CANCEL（尽力）→ FIN → 短延迟强制关闭连接 → 本地清理 .part
  // 对端语义：收到 FIN（end 事件）视为对方已取消，RST/超时视为连接断开
  cancel(reason: string): void {
    if (this.closed) return
    this.closed = true // 取消后立即置位：后续在途数据/消息全部忽略，防止 write after end
    try {
      this.socket.write(encodeFrame({ type: 'CANCEL', transferId: this.transferId, reason }))
    } catch {
      // 对端可能已断开，忽略
    }
    this.socket.end() // FIN：TCP 层可靠送达
    this.cleanup() // 本地 .part 立即清理
    // CANCEL 已 flush（毫秒级）后强制关闭连接，避免半开连接挂住 server.close/资源
    setTimeout(() => {
      if (!this.socket.destroyed) this.socket.destroy()
    }, 100)
  }

  // 立即断开连接（Receiver.stop 调用），触发 close 清理
  dispose(): void {
    if (!this.closed) this.socket.destroy()
  }

  // 无数据超时：接受后启动周期检查。判定基准 = max(网络数据, 写盘活动)：
  // - 水位背压 pause 期间：无网络数据但写盘在消费 → 不超时（修复 v0.1.16 误杀）
  // - 发送方死亡（连接静默）：两者均停 → 正确超时兑底
  private startIdleCheck(): void {
    if (this.idleTimer) return
    this.lastDataAt = Date.now()
    const interval = Math.min(10_000, Math.max(50, Math.floor(this.noDataTimeoutMs / 4)))
    this.idleTimer = setInterval(() => {
      const lastActive = Math.max(this.lastDataAt, this.lastWriteAt)
      if (!this.closed && Date.now() - lastActive > this.noDataTimeoutMs) {
        this.fail(new Error(`传输超时：${Math.round(this.noDataTimeoutMs / 1000)} 秒无数据`))
      }
    }, interval)
  }

  private onFileDoneSync(msg: FileDoneMessage): void {
    // 同步校验文件完成：current 必须匹配、字节数一致；commit 改由写盘循环在队列序执行
    if (!this.current || this.current.header.path !== msg.path) {
      throw new Error('protocol error: FILE_DONE without matching file')
    }
    if (msg.bytesWritten !== this.current.header.size) {
      throw new Error(`protocol error: bytesWritten ${msg.bytesWritten} != size ${this.current.header.size}`)
    }
    const cur = this.current
    this.current = null
    // 入队 file-done（携带 sink 快照：入队后 this.current 可能已指向下一文件）
    this.writeQueue.push({
      kind: 'file-done',
      sink: cur.sink,
      path: msg.path,
      bytesWritten: msg.bytesWritten,
      size: cur.header.size
    })
    this.kickWriteLoop()
    // FILE_ACK：文件数据全部入队即回（不等落盘）——发送方可提前显示“已送达”。
    // 数据已在本机内存，后续落盘由本机写盘循环保证；旧版发送方不认识此帧会忽略。
    if (!this.closed) {
      try {
        this.socket.write(encodeFrame({ type: 'FILE_ACK', transferId: this.transferId, path: msg.path }))
      } catch {
        // 对端可能已断开，忽略
      }
    }
  }

  private async onTransferDone(_msg: Message): Promise<void> {
    if (this.current) {
      throw new Error('protocol error: TRANSFER_DONE during file transfer')
    }
    // 数据已全部到达：停用无数据超时（剩余是本地落盘排空，不再是“连接挂死”信号）
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    // 入队 transfer-done：写盘循环消费到它时，之前所有 data/file-done 均已落盘 →
    // TRANSFER_ACK 在“全部落盘”后发出（安全语义不变），发送方动态超时兼容排空时长
    this.writeQueue.push({ kind: 'transfer-done' })
    this.kickWriteLoop()
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

  private cleanup(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    this.stopKeepalive()
    // 方案 2：清空写盘队列，abort 所有未落盘 sink（data 项与 current 去重）
    const sinks = new Set<AtomicSink>()
    for (const item of this.writeQueue) {
      if (item.kind !== 'transfer-done') sinks.add(item.sink)
    }
    this.writeQueue = []
    this.queuedBytes = 0
    if (this.current) {
      sinks.add(this.current.sink)
      this.current = null
    }
    for (const s of sinks) void s.abort()
    // 唤醒挂起的写循环（队列已空 + closed，循环会在下轮自行退出）
    this.writeIdle?.()
    this.netPaused = false
    this.state = 'CTRL'
  }

  private fail(err: Error): void {
    if (this.closed) return
    this.ev.onError(this.transferId, err)
    this.socket.destroy()
    this.cleanup()
  }
}
