import net from 'node:net'
import { createReadStream } from 'node:fs'
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

const OFFER_TIMEOUT_MS = 60_000

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

function pipeFile(socket: net.Socket, absPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(absPath)
    stream.on('error', reject)
    socket.on('error', reject)
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
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

      let sent = 0
      for (const entry of entries) {
        if (entry.type === 'dir') continue // 空目录条目无需传输数据
        socket.write(encodeFrame({ type: 'FILE_HEADER', transferId, path: entry.relPath, size: entry.size }))
        if (entry.size > 0) await pipeFile(socket, entry.absPath)
        sent += entry.size
        this.emit('progress', {
          transferId,
          fileName: entry.relPath,
          fileBytes: entry.size,
          fileSize: entry.size,
          totalBytes: sent,
          done: false
        } satisfies TransferProgress)
        socket.write(encodeFrame({ type: 'FILE_DONE', transferId, path: entry.relPath, bytesWritten: entry.size }))
      }

      socket.write(encodeFrame({ type: 'TRANSFER_DONE', transferId }))
      await waitFor(this, 'transfer-ack', OFFER_TIMEOUT_MS, 'ack timeout')
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
    this.socket.write(encodeFrame({ type: 'CANCEL', transferId: this.transferId, reason }))
    this.fail(new Error('cancelled'))
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
    this.socket?.destroy()
    this.socket = null
    this.emit('failed', { transferId: id, reason: err.message })
  }
}
