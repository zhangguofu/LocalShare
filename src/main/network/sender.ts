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
const ACK_TIMEOUT_BASE_MS = 30_000 // TRANSFER_DONE 后等 ACK：基础 30 秒
const ACK_DRAIN_RATE_BYTES = 20 * 1024 * 1024 // 接收方队列排空估算速率（保守值）：动态超时 = 基础 + 发送量/速率
const NO_DATA_TIMEOUT_MS = 30_000 // 传输中无数据流动（写方向无进展）：30 秒

// 连接重试间隔（Apple TN3179《Understanding local network privacy》要求）：
// 首次本地网络操作可能在用户回答授权提示**之前**就被系统直接拒绝（macOS 上表现为
// EHOSTUNREACH / "No route to host"），官方要求为这种情况加入适当的重试逻辑——
// 否则用户即便点了「允许」，本次传输也已经失败。首次立即尝试，之后按下面间隔重试。
const CONNECT_RETRY_DELAYS_MS = [1500, 3000, 5000] // 共 4 次尝试，约 9.5 秒预算

// 发送侧预读水位（衔接）：「提前准备下一块」，让读盘与发送在时间上重叠。
// 依据（docs/large-file-throughput-analysis-2026-10-11.md §5 P2）：
//   恢复读盘时的剩余积压 ≥ 最坏读盘延迟 × 链路速率
// 判定发生在「某一块刚交给内核」之后，粒度为一整块，故低水位再让出一个块。
// 默认值覆盖：链路 ≤ 100 MB/s（千兆实际水平）× 单次读盘停顿 ≤ 30 ms（机械盘/网络盘）；
// 上限只约束本机内存（每连接 ~8 MB），不影响对端。
const READ_AHEAD_LOW_BYTES = 4 * 1024 * 1024
const READ_AHEAD_HIGH_BYTES = 8 * 1024 * 1024

// 动态 ACK 超时：接收方收包与落盘解耦后，“发完 ≠ 写完”——队列排空需要时间。
// 只放宽不收紧，避免大文件 + 慢盘被固定 30 秒误杀（设计文档 §5）
function ackTimeoutMs(totalBytes: number): number {
  return ACK_TIMEOUT_BASE_MS + Math.ceil(totalBytes / ACK_DRAIN_RATE_BYTES) * 1000
}

function onceConnect(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// 本机侧「不可达」错误：macOS 本地网络权限未授予时，连接会被系统直接拒绝并返回
// EHOSTUNREACH（ENETUNREACH/EHOSTDOWN 同属这一类）。这类错误值得重试——授权提示
// 可能正在屏幕上等用户点击；而 ECONNREFUSED（对方未在监听）重试无意义。
export function isLocalNetworkBlocked(err: NodeJS.ErrnoException | null | undefined): boolean {
  return err?.code === 'EHOSTUNREACH' || err?.code === 'ENETUNREACH' || err?.code === 'EHOSTDOWN'
}

// 把底层 errno 翻译成用户能照做的中文提示（不应把一行英文错误码直接丢给用户）
export function describeConnectError(err: NodeJS.ErrnoException, host: string, port: number): string {
  if (isLocalNetworkBlocked(err)) {
    return (
      `无法连接 ${host}:${port}（${err.code}）：通常是 macOS 未允许本应用访问本地网络。` +
      '请在「系统设置 → 隐私与安全性 → 本地网络」中允许 LocalShare；' +
      '若已允许仍失败，请退出应用后把它移动到其他位置再打开（该授权与程序身份绑定）。'
    )
  }
  if (err.code === 'ECONNREFUSED') {
    return `无法连接 ${host}:${port}：对方未在运行，或端口与对方设置不一致。`
  }
  if (err.code === 'ETIMEDOUT') {
    return `连接 ${host}:${port} 超时：请确认两台设备在同一局域网，且未被防火墙拦截。`
  }
  return err.message
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

// P1：返回实际发送字节数（文件传输中被截断时与清单 size 不符，供调用方校验）；
// P2：监听器用完即清，不随文件累积（曾因 socket.on('drain') 每文件挂一组且从不摘除，
// 多文件传输时 MaxListenersExceededWarning + 无效回调累积）；
// onAlive：写缓冲推进（数据块交给内核，即对端在消费）时上报——发送方存活检测信号之一
// 导出仅为单元测试直接验证发送侧预读衔接行为（tests/unit/sender-readahead.test.ts）
export function pipeFile(
  socket: net.Socket,
  stream: ReadStream,
  onBytes: (n: number) => void,
  onAlive?: () => void
): Promise<{ written: number }> {
  return new Promise((resolve, reject) => {
    let written = 0
    let settled = false
    const onStreamErr = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    const onSocketErr = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      written += buf.length
      onBytes(buf.length)
      // 写入回调 = 该块已交给内核的时点。积压一旦回落到低水位就立刻继续读盘，
      // 而不是等 drain（积压归零）——等归零意味着内核里已无数据可发，
      // 链路必然空转一个「重新读盘」的来回（旧实现在 26.6 s 抓包里留下 4.72 s 这类空洞）。
      socket.write(buf, () => {
        if (settled || stream.destroyed) return
        if (socket.writableLength < READ_AHEAD_LOW_BYTES) stream.resume()
        onAlive?.() // 数据已交给内核且被持续消费：存活信号（对端停读则回调停止）
      })
      // 预读上限：超出即暂停读流，保证内存有界（对端慢时最多积压到这里）
      if (socket.writableLength >= READ_AHEAD_HIGH_BYTES) stream.pause()
    }
    const onEnd = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ written })
    }
    // 声明在使用前：TDZ 安全（回调仅在事件触发时执行，但保持声明顺序清晰）
    const cleanup = (): void => {
      stream.off('error', onStreamErr)
      socket.off('error', onSocketErr)
      stream.off('data', onData)
      stream.off('end', onEnd)
      // settle 后 Sender.fail/cancel 仍可能 stream.destroy(err)（唤醒机制依赖 error 事件）；
      // 此时上面的监听器已摘除，不挂吞错处理器会变成 uncaught exception（旧实现靠泄漏的监听器兑底）
      stream.on('error', () => {})
    }
    stream.on('error', onStreamErr)
    socket.on('error', onSocketErr)
    stream.on('data', onData)
    stream.on('end', onEnd)
  })
}

export class Sender extends EventEmitter {
  private socket: net.Socket | null = null
  private parser = new FrameParser()
  private transferId: string | null = null
  private currentStream: ReadStream | null = null // 当前文件读流（fail 时需销毁，防挂起）
  // 存活检测（应用层，替代 socket.setTimeout——后者收到数据不重置，背压场景误杀）：
  // 活着 = 收到对端任何帧（KEEPALIVE/ACK…）或写缓冲推进（write 全入/drain，对端在收）
  private lastAliveAt = 0
  private aliveTimer: NodeJS.Timeout | null = null
  // 真实进度源：对端 RECV_PROGRESS 帧报告的已收字节。优于本地 sent（sent 含
  // 已入本机发送缓冲但未经网络确认的部分，读流脉冲导致台阶状）。旧版对端不回发 → 回退 sent。
  private peerBytes = 0
  private transferStartedAt = 0

  constructor(
    private readonly opts: {
      senderId: string
      senderName: string
      // 测试用：覆盖连接重试间隔，避免用例真的等 9.5 秒（与 Receiver.sinkWriteDelayMs 同一约定）
      connectRetryDelaysMs?: number[]
    }
  ) {
    super()
  }

  // 发起一次传输：OFFER → ACCEPT → 逐文件 → TRANSFER_DONE → TRANSFER_ACK
  // entries 由 walkPaths 产出（WalkEntry：relPath 发协议，absPath 读文件）
  // 事件：'progress' (TransferProgress) / 'complete' ({transferId}) / 'failed' ({transferId, reason})
  async start(
    target: { host: string; port: number },
    transferId: string,
    entries: WalkEntry[],
    totalBytes: number,
    // 已编码的 OFFER 帧：调用方已完成清单大小预检并复用其编码结果，避免对同一份清单
    // 重复序列化。省略时按 entries 现编码（保持 Sender 可独立使用）。
    offerFrame?: Buffer
  ): Promise<void> {
    this.transferId = transferId
    let progressTimer: NodeJS.Timeout | null = null // 作用域提升：finally 里统一清理（成功/失败/取消）

    try {
      // 连接（含官方要求的重试）：见 connectWithRetry 注释
      const socket = await this.connectWithRetry(target)
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
      // 无数据超时（应用层实现，替代 socket.setTimeout：后者对“收到数据”不重置计时器，
      // 接收方水位背压静默期间靠 KEEPALIVE 帧保活，实测 socket.setTimeout 仍会误杀）
      this.lastAliveAt = Date.now()
      this.aliveTimer = setInterval(() => {
        if (!this.transferId) return
        if (Date.now() - this.lastAliveAt > NO_DATA_TIMEOUT_MS) {
          this.fail(new Error(`传输超时：${Math.round(NO_DATA_TIMEOUT_MS / 1000)} 秒无数据流动`))
        }
      }, Math.min(5000, NO_DATA_TIMEOUT_MS / 4))

      socket.write(
        offerFrame ??
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

      this.lastAliveAt = Date.now() // 进入传输阶段重置（OFFER 等待期间可能久候）
      this.transferStartedAt = Date.now()
      this.peerBytes = 0

      let sent = 0
      // 当前文件名/大小（定时上报用；读流事件只更新它们，不再直接触发上报）
      let curName = ''
      let curSize = 0
      // 进度上报：定时器驱动（100ms 匀速）+ 真实进度源优先（方案 A）：
      // 新版对端每 100ms 回发 RECV_PROGRESS（已收字节，TCP 平滑后连续）→ 显示它；
      // 旧版对端不回发（启动 2s 后仍为 0）→ 回退本地 sent（台阶状但不差于旧体验）。
      // min 防 peerBytes 异常超过 sent。
      const progressTimerInner = setInterval(() => {
        // 数据源选择（单一源，杜绝运行中切换导致的数值跳变/回退）：
      // - 新版对端：显示 peerBytes（第一个 RECV_PROGRESS 到达前为 0——诚实：对端尚未确认任何字节）
      // - 旧版对端：启动 2s 仍无 RECV_PROGRESS → 判定后切 sent（一次向上跳，无回退）
      // min 防御异常对端报告超出发送量的值
      const peerSilent = Date.now() - this.transferStartedAt > 2000 && this.peerBytes === 0
      const showBytes = peerSilent ? sent : Math.min(this.peerBytes, sent)
        this.emit('progress', {
          transferId,
          fileName: curName,
          fileBytes: curSize > 0 ? showBytes % curSize : 0,
          fileSize: curSize,
          totalBytes: showBytes,
          done: false
        } satisfies TransferProgress)
      }, 100)
      progressTimer = progressTimerInner
      const emitProgress = (fileName: string, fileSize: number): void => {
        curName = fileName
        curSize = fileSize
      }
      for (const entry of entries) {
        if (entry.type === 'dir') continue // 空目录条目无需传输数据
        const size = entry.size
        socket.write(encodeFrame({ type: 'FILE_HEADER', transferId, path: entry.relPath, size }))
        let written = 0
        if (size > 0) {
          // 大块读取（1MB）减少 data 事件与背压 pause/resume 抖动，显著提升真实网络吞吐
          const stream = createReadStream(entry.absPath, { highWaterMark: 1024 * 1024 })
          this.currentStream = stream
          const r = await pipeFile(
            socket,
            stream,
            (n) => {
              written += n
              sent += n
              emitProgress(entry.relPath, size)
            },
            () => {
              this.lastAliveAt = Date.now()
            }
          )
          written = r.written
          this.currentStream = null
        }
        // P1：报实际发送字节（而非清单值）。若文件在传输中被截断，实际值 < 声明值，
        // 接收方 FILE_DONE 校验（bytesWritten != size）会真正生效并断开——避免后续帧被误当数据错位落盘
        if (written !== size) {
          throw new Error(`文件在传输中被修改（${entry.relPath}）：发送 ${written} 字节，清单 ${size} 字节`)
        }
        socket.write(encodeFrame({ type: 'FILE_DONE', transferId, path: entry.relPath, bytesWritten: written }))
        emitProgress(entry.relPath, size)
      }
      clearInterval(progressTimerInner) // 数据全部发完：停定时器，最后一帧由 complete 事件呈现

      socket.write(encodeFrame({ type: 'TRANSFER_DONE', transferId }))
      await waitFor(this, 'transfer-ack', ackTimeoutMs(totalBytes), 'ack timeout')
      this.emit('complete', { transferId })
      socket.end()
      this.transferId = null
      this.stopAliveTimer()
    } catch (err) {
      this.fail(err as Error)
      throw err
    } finally {
      if (progressTimer) clearInterval(progressTimer) // 异常/取消路径同样清理，防幽灵定时器持续发 progress 事件
    }
  }

  // 取消：停数据流 → 尽力发 CANCEL（对端若在 CTRL 模式可识别为取消；被数据吞掉由 FIN 兜底）→ FIN → 短延迟强制关闭
  // 对端语义：收到 FIN（end 事件）视为对方已取消，RST/超时视为连接断开
  cancel(reason = 'user_cancelled'): void {
    // 只要求 transferId：连接/重试阶段 this.socket 可能暂时为 null，用户取消仍必须生效
    if (!this.transferId) return
    const id = this.transferId
    this.transferId = null
    if (this.currentStream) {
      this.currentStream.destroy(new Error('transfer aborted'))
      this.currentStream = null
    }
    const sock = this.socket
    this.socket = null
    if (sock) {
      try {
        sock.write(encodeFrame({ type: 'CANCEL', transferId: id, reason }))
      } catch {
        // 对端可能已断开，忽略
      }
    }
    this.emit('failed', { transferId: id, reason: 'cancelled' })
    if (!sock) return // 尚未连上：没有需要收尾的连接
    sock.end() // FIN：TCP 层可靠送达
    // CANCEL 已 flush（毫秒级）后强制关闭连接，避免半开连接挂住对端/本端资源
    setTimeout(() => {
      if (!sock.destroyed) sock.destroy()
    }, 100)
  }

  // 建立连接，含 Apple 官方要求（TN3179）的重试：首次本地网络操作可能在用户回答授权
  // 提示之前就被系统直接拒绝（EHOSTUNREACH 等），此时重试能让用户点了「允许」之后本次
  // 传输照常进行，而不是当场失败。只对「本机侧不可达」类错误重试（对方未监听等无意义）。
  private async connectWithRetry(target: { host: string; port: number }): Promise<net.Socket> {
    const delays = this.opts.connectRetryDelaysMs ?? CONNECT_RETRY_DELAYS_MS
    let lastErr: NodeJS.ErrnoException | null = null
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) {
        await sleep(delays[attempt - 1])
        if (!this.transferId) throw new Error('cancelled') // 重试等待期间被取消
      }
      const socket = net.createConnection(target)
      this.socket = socket // 让 cancel()/fail() 在连接阶段也能立即销毁本次尝试
      try {
        await onceConnect(socket)
        return socket
      } catch (err) {
        lastErr = err as NodeJS.ErrnoException
        socket.destroy()
        this.socket = null
        // 非「本机侧不可达」不重试；已取消也不再继续
        if (!isLocalNetworkBlocked(lastErr) || !this.transferId) break
      }
    }
    if (lastErr) throw new Error(describeConnectError(lastErr, target.host, target.port))
    throw new Error('connect failed')
  }

  private onMessage(msg: Message): void {
    if (!('transferId' in msg) || msg.transferId !== this.transferId) return
    this.lastAliveAt = Date.now() // 对端任何帧 = 存活信号（含 KEEPALIVE）
    if (msg.type === 'ACCEPT') {
      this.emit('offer-result', { ok: true })
    } else if (msg.type === 'REJECT') {
      this.emit('offer-result', { ok: false, reason: msg.reason })
    } else if (msg.type === 'CANCEL') {
      this.fail(new Error('对方已取消传输'))
    } else if (msg.type === 'ERROR') {
      this.fail(new Error(`${msg.code}: ${msg.message}`))
    } else if (msg.type === 'TRANSFER_ACK') {
      this.emit('transfer-ack')
    } else if (msg.type === 'FILE_ACK') {
      // 分阶段确认：文件已送达对端内存（未落盘）。仅作进度观测，不影响传输推进
      this.emit('file-ack', { transferId: msg.transferId, path: msg.path })
    } else if (msg.type === 'RECV_PROGRESS') {
      // 真实进度：对端已收字节（单调取 max，防御乱序回退）
      this.peerBytes = Math.max(this.peerBytes, msg.bytes)
    }
  }

  private stopAliveTimer(): void {
    if (this.aliveTimer) {
      clearInterval(this.aliveTimer)
      this.aliveTimer = null
    }
  }

  private fail(err: Error): void {
    this.stopAliveTimer()
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
