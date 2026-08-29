// 诊断：传输速率随时间的变化（分段统计）+ 水位 pause 行为
// 模拟慢盘接收大文件，观察：每秒接收字节是否递减、pause/resume 模式、内存占用
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Sender } from '../src/main/network/sender'
import { Receiver, type OfferSummary, type ReceiveProgress } from '../src/main/network/receiver'

const TCP_PORT = 45740

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-degrade-'))
  const recvDir = path.join(root, 'recv')
  await fs.mkdir(recvDir)
  const srcFile = path.join(root, 'big.bin')
  const size = 1024 * 1024 * 1024 // 1GB
  console.log('生成 1GB 测试文件...')
  const fd = await fs.open(srcFile, 'w')
  const buf = Buffer.alloc(8 * 1024 * 1024, 1)
  for (let w = 0; w < size; w += buf.length) await fd.write(buf)
  await fd.close()

  // sinkWriteDelayMs=8：模拟约 30-60MB/s 的慢盘（每 64KB 块延迟 8ms）
  const r = new Receiver({ port: TCP_PORT, saveDir: () => recvDir, sinkWriteDelayMs: 8 })
  let lastBytes = 0
  let lastTime = Date.now()
  let lastEmitBytes = 0
  r.on('progress', (p: ReceiveProgress) => {
    const now = Date.now()
    if (now - lastTime >= 1000) {
      const rate = (p.totalBytes - lastBytes) / 1048576 / ((now - lastTime) / 1000)
      const emitRate = (p.totalBytes - lastEmitBytes) > 0 ? '' : ' (停滞)'
      console.log(
        `t=${(now - T0) / 1000 | 0}s  收 ${p.totalBytes / 1048576 | 0}MB  段速率 ${rate.toFixed(1)} MB/s${emitRate}`
      )
      lastBytes = p.totalBytes
      lastTime = now
    }
    lastEmitBytes = p.totalBytes
  })
  r.on('offer', (o: OfferSummary) => r.respond(o.transferId, 'accept'))
  r.on('transferError', (e) => console.log('transferError:', e.error.message))
  r.start()
  await new Promise<void>((res) => r.once('listening', res))

  const sender = new Sender({ senderId: 'me', senderName: 'Me' })
  const T0 = Date.now()
  void sender
    .start({ host: '127.0.0.1', port: TCP_PORT }, 't-deg', [
      { relPath: 'big.bin', absPath: srcFile, type: 'file', size }
    ], size)
    .then(() => console.log('发送方完成'))
    .catch((e) => console.log('发送方失败:', e.message))

  // 每 5 秒输出内存
  const memTimer = setInterval(() => {
    const m = process.memoryUsage()
    console.log(`  [mem] rss ${(m.rss / 1048576).toFixed(0)}MB heapUsed ${(m.heapUsed / 1048576).toFixed(0)}MB external ${(m.external / 1048576).toFixed(0)}MB`)
  }, 5000)

  await new Promise((res) => setTimeout(res, 120_000)) // 观察最多 2 分钟
  clearInterval(memTimer)
  await new Promise<void>((res) => r.stop(() => res()))
  await fs.rm(root, { recursive: true, force: true })
  process.exit(0)
}

// T0 提升作用域
let T0 = Date.now()
void T0

main().catch((e) => { console.error(e); process.exit(1) })
