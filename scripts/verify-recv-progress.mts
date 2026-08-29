// 验证方案 A：经限速中继（模拟真实慢网络）传输，发送方 progress 的数值来源与平滑度。
// 断言：发送方显示字节 = 对端已收（连续增长），而非本地 sent（台阶状）。
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { Sender } from '../src/main/network/sender'
import { Receiver } from '../src/main/network/receiver'

const PROXY_PORT = 45770 // sender 连这里
const RECV_PORT = 45771 // 代理转发到这里
const RATE_LIMIT_BPS = 30 * 1024 * 1024 // 30MB/s（模拟千兆 Wi-Fi 实际速率）

// 简单令牌桶限速中继：每 tick 补充令牌，按令牌量放行字节
function startRateLimitedProxy(): void {
  const server = net.createServer((client) => {
    const upstream = net.createConnection({ host: '127.0.0.1', port: RECV_PORT })
    let tokens = RATE_LIMIT_BPS / 20 // 50ms tick
    let upBuf: Buffer[] = []
    let upBytes = 0
    const HIGH = 4 * 1024 * 1024 // 有界缓冲（模拟端到端流控）：超限 pause 客户端
    const LOW = 1 * 1024 * 1024
    let clientPaused = false
    const pump = (): void => {
      while (tokens > 0 && upBuf.length > 0) {
        const chunk = upBuf[0]
        const take = Math.min(tokens, chunk.length)
        const piece = chunk.subarray(0, take)
        const rest = chunk.subarray(take)
        if (rest.length > 0) upBuf[0] = rest
        else upBuf.shift()
        upBytes -= take
        upstream.write(piece)
        tokens -= take
      }
      if (clientPaused && upBytes < LOW) {
        clientPaused = false
        client.resume()
      }
    }
    const cap = RATE_LIMIT_BPS / 20
    // 令牌只在 50ms tick 补充（在 pump 里补会被 data 事件高频触发，限速失效）
    const timer = setInterval(() => {
      tokens = Math.min(cap, tokens + cap)
      pump()
    }, 50)
    // 回程：upstream → client（ACK/RECV_PROGRESS/KEEPALIVE 等控制帧）
    upstream.on('data', (d: Buffer) => client.write(d))
    upstream.on('error', () => upstream.destroy())
    client.on('data', (d: Buffer) => {
      upBuf.push(d)
      upBytes += d.length
      if (upBytes > HIGH && !clientPaused) {
        clientPaused = true
        client.pause()
      }
      pump()
    })
    client.on('close', () => {
      clearInterval(timer)
      upstream.end()
    })
    client.on('error', () => client.destroy())
  })
  server.listen(PROXY_PORT)
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-slownet-'))
  const recvDir = path.join(root, 'recv')
  await fs.mkdir(recvDir)
  const srcFile = path.join(root, 'big.bin')
  const size = 256 * 1024 * 1024
  const fd = await fs.open(srcFile, 'w')
  const buf = Buffer.alloc(8 * 1024 * 1024, 1)
  for (let w = 0; w < size; w += buf.length) await fd.write(buf)
  await fd.close()

  const r = new Receiver({ port: RECV_PORT, saveDir: () => recvDir })
  r.on('offer', (o) => r.respond(o.transferId, 'accept'))
  r.start()
  await new Promise<void>((res) => r.once('listening', res))
  startRateLimitedProxy()
  await new Promise((res) => setTimeout(res, 200))

  const sender = new Sender({ senderId: 'me', senderName: 'Me' })
  const samples: { t: number; bytes: number }[] = []
  const t0 = Date.now()
  sender.on('progress', (p) => samples.push({ t: Date.now() - t0, bytes: p.totalBytes }))
  await sender.start(
    { host: '127.0.0.1', port: PROXY_PORT },
    't-slow',
    [{ relPath: 'big.bin', absPath: srcFile, type: 'file', size }],
    size
  )
  const totalMs = Date.now() - t0

  // 分析：显示字节的增量分布（真实进度应为近似线性增长，无长平台）
  const gaps: number[] = []
  let stuckRuns = 0
  let maxRun = 0
  let run = 0
  for (let i = 1; i < samples.length; i++) {
    const delta = samples[i].bytes - samples[i - 1].bytes
    gaps.push(delta)
    if (delta === 0) {
      run++
      maxRun = Math.max(maxRun, run)
    } else {
      if (run >= 5) stuckRuns++ // 连续 ≥5 个采样（500ms）不动 = 台阶
      run = 0
    }
  }
  console.log(`限速 ${RATE_LIMIT_BPS / 1048576}MB/s，256MB 总耗时 ${(totalMs / 1000).toFixed(1)}s（理论 ${(size / RATE_LIMIT_BPS).toFixed(1)}s）`)
  console.log(`发送方显示进度采样 ${samples.length} 个`)
  console.log(`采样增量中位 ${(gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] / 1024).toFixed(0)}KB`)
  console.log(`连续 ≥500ms 不动的平台数：${stuckRuns}（旧机制会大量出现）`)
  const finalBytes = samples[samples.length - 1].bytes
  console.log(`最后显示字节 ${finalBytes} / ${size}（一致: ${finalBytes === size}）`)

  await new Promise<void>((res) => r.stop(() => res()))
  await fs.rm(root, { recursive: true, force: true })
  process.exit(0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
