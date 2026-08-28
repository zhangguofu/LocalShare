import net from 'node:net'
import { createReadStream, type ReadStream } from 'node:fs'
import { EventEmitter } from 'node:events'
import { encodeFrame, FrameParser, type Message } from './protocol'
import type { WalkEntry } from './tree'

export interface TransferProgress {
  transferId: string
  fileName: string
  fileBytes: number
  fileSize: number
  totalBytes: number
  done: boolean
}

const OFFER_TIMEOUT_MS = 180_000 // OFFER 等待确认：3 分钟（用户可能离开确认框）
const ACK_TIMEOUT_MS = 30_000 // TRANSFER_DONE 后等 ACK：30 秒
const NO_DATA_TIMEOUT_MS = 30_000 // 传输中无数据流动（写方向无进展）：30 秒

function onceConnect(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
}

function waitFor(em: EventEmitter, event: string, timeoutMs: number, timeoutMsg: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMsg)), timeoutMs)
    em.once(event, (v) => {
      clearTimeout(timer)
      resolve(v)
    })
    em.once('failed', (info: { reason: string }) => {
      clearTimeout(timer)
      reject(new Error(info.reason))
    })
  })
}

function pipeFile(socket: net.Socket, stream: ReadStream, onBytes: (n: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on('error', reject)
    socket.on('error', reject)
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      onBytes(buf.length)
      if (!socket.write(buf)) stream.pause()
    })
    socket.on('drain', () => stream.resume())
    stream.on('end', resolve)
  })
}

export class Sender extends EventEmitter {
  private socket: net.Socket | null = null
  private parser = new FrameParser()
  private transferId: string | null = null
  private currentStream: ReadStream | null = null // 当前文件读流（fail 时需销毁，防挂起）

  constructor(private readonly opts: { senderId: string; senderName: string }) {
    super()
  }

  // 发起一次传输：OFFER → ACCEPT → 逐文件 → TRANSFER_DONE → TRANSFER_ACK
  // entries 由 walkPaths 产出（WalkEntry：relPath 发协议，absPath 读文件）
  // 事件：'progress' (TransferProgress) / 'complete' ({transferId}) / 'failed' ({transferId, reason})
  async start(
    target: { host: string; port: number },
    transferId: string,
    entries: WalkEntry[],
    totalBytes: number
  ): Promise<void> {
    this.transferId = transferId
    const socket = net.createConnection(target)
    this.socket = socket
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      try {
        for (const msg of this.parser.push(buf)) this.onMessage(msg)
      } catch (err) {
        this.fail(err as Error)
      }
    })
    socket.on('error', (err) => this.fail(err))
    socket.on('close', () => {
      if (this.transferId) this.fail(new Error('connection closed'))
    })
    // 传输阶段无数据超时：socket 读写活动 30 秒无进展 → 判定连接死（设计 5.8）
    socket.on('timeout', () => this.fail(new Error('传输超时：30 秒无数据流动')))
    socket.setTimeout(0) // OFFER 等待阶段禁用（由 OFFER_TIMEOUT_MS 3 分钟控制）

    try {
      await onceConnect(socket)

      socket.write(
        encodeFrame({
          type: 'OFFER',
          transferId,
          senderId: this.opts.senderId,
          senderName: this.opts.senderName,
          fileCount: entries.length,
          totalBytes,
          files: entries.map((e) => ({ type: e.type, path: e.relPath, size: e.size }))
        })
      )

      const result = (await waitFor(this, 'offer-result', OFFER_TIMEOUT_MS, 'offer timeout: 对方无响应')) as {
        ok: boolean
        reason?: string
      }
      if (!result.ok) throw new Error(result.reason ?? 'rejected')

      // 进入传输阶段：启用无数据超时（30 秒无读写活动则失败）
      socket.setTimeout(NO_DATA_TIMEOUT_MS)

      let sent = 0
      let lastEmit = 0
      // 节流：至少 50ms 上报一次，避免高频 IPC；force 用于文件边界/结束时强制上报
      const emitProgress = (fileName: string, fileSize: number, force = false): void => {
        const now = Date.now()
        if (!force && now - lastEmit < 50) return
        lastEmit = now
        this.emit('progress', {
          transferId,
          fileName,
          fileBytes: sent % (fileSize || 1),
          fileSize,
          totalBytes: sent,
          done: false
        } satisfies TransferProgress)
      }
      for (const entry of entries) {
        if (entry.type === 'dir') continue // 空目录条目无需传输数据
        const size = entry.size
        socket.write(encodeFrame({ type: 'FILE_HEADER', transferId, path: entry.relPath, size }))
        if (size > 0) {
          // 大块读取（1MB）减少 data 事件与背压 pause/resume 抖动，显著提升真实网络吞吐
          const stream = createReadStream(entry.absPath, { highWaterMark: 1024 * 1024 })
          this.currentStream = stream
          await pipeFile(socket, stream, (n) => {
            sent += n
            emitProgress(entry.relPath, size)
          })
          this.currentStream = null
        }
        socket.write(encodeFrame({ type: 'FILE_DONE', transferId, path: entry.relPath, bytesWritten: size }))
        emitProgress(entry.relPath, size, true)
      }
      emitProgress('', 0, true)

      socket.write(encodeFrame({ type: 'TRANSFER_DONE', transferId }))
      await waitFor(this, 'transfer-ack', ACK_TIMEOUT_MS, 'ack timeout')
      this.emit('complete', { transferId })
      socket.end()
      this.transferId = null
    } catch (err) {
      this.fail(err as Error)
      throw err
    }
  }

  cancel(reason = 'user_cancelled'): void {
    if (!this.socket || !this.transferId) return
    const id = this.transferId
    this.transferId = null // 阻止 close 事件重复 fail
    this.socket.write(encodeFrame({ type: 'CANCEL', transferId: id, reason }))
    this.emit('failed', { transferId: id, reason: 'cancelled' })
    this.socket.end() // flush 缓冲后再 FIN，确保 CANCEL 帧送达
    this.socket = null
  }

  private onMessage(msg: Message): void {
    if (!('transferId' in msg) || msg.transferId !== this.transferId) return
    if (msg.type === 'ACCEPT') {
      this.emit('offer-result', { ok: true })
    } else if (msg.type === 'REJECT') {
      this.emit('offer-result', { ok: false, reason: msg.reason })
    } else if (msg.type === 'CANCEL') {
      this.fail(new Error('cancelled by peer: ' + msg.reason))
    } else if (msg.type === 'ERROR') {
      this.fail(new Error(`${msg.code}: ${msg.message}`))
    } else if (msg.type === 'TRANSFER_ACK') {
      this.emit('transfer-ack')
    }
  }

  private fail(err: Error): void {
    if (!this.transferId && this.socket === null) return
    const id = this.transferId
    this.transferId = null
    // 销毁当前读流：防止 socket 已毁后读流 pause 永无 drain → pipeFile 挂起
    if (this.currentStream) {
      this.currentStream.destroy(new Error('transfer aborted'))
      this.currentStream = null
    }
    this.socket?.destroy()
    this.socket = null
    this.emit('failed', { transferId: id, reason: err.message })
  }
}
