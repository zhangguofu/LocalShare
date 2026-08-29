// 诊断：进度事件的真实到达间隔（接收方视角）
// 分别测：小文件批次、单个大文件 —— 统计 progress 事件间隔分布
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Sender } from '../src/main/network/sender'
import { Receiver, type OfferSummary, type ReceiveProgress } from '../src/main/network/receiver'
import type { WalkEntry } from '../src/main/network/tree'

const TCP_PORT = 45730

async function run(scene: 'big' | 'many', sinkWriteDelayMs: number): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-prog-'))
  const recvDir = path.join(root, 'recv')
  await fs.mkdir(recvDir)
  const entries: WalkEntry[] = []
  let totalBytes = 0
  if (scene === 'big') {
    const p = path.join(root, 'big.bin')
    const buf = Buffer.alloc(8 * 1024 * 1024, 1)
    const fd = await fs.open(p, 'w')
    for (let w = 0; w < 512 * 1024 * 1024; w += buf.length) await fd.write(buf) // 512MB
    await fd.close()
    const st = await fs.stat(p)
    entries.push({ relPath: 'big.bin', absPath: p, type: 'file', size: st.size })
    totalBytes = st.size
  } else {
    const buf = Buffer.alloc(256 * 1024, 2)
    for (let i = 0; i < 200; i++) {
      const p = path.join(root, `f${i}.bin`)
      await fs.writeFile(p, buf)
      entries.push({ relPath: `f${i}.bin`, absPath: p, type: 'file', size: buf.length })
    }
    totalBytes = 200 * 256 * 1024
  }

  const r = new Receiver({ port: TCP_PORT, saveDir: () => recvDir, sinkWriteDelayMs })
  const gaps: number[] = []
  let last = 0
  r.on('progress', (p: ReceiveProgress) => {
    const now = Date.now()
    if (last > 0) gaps.push(now - last)
    last = now
  })
  r.on('offer', (o: OfferSummary) => r.respond(o.transferId, 'accept'))
  r.start()
  await new Promise<void>((res) => r.once('listening', res))

  const sender = new Sender({ senderId: 'me', senderName: 'Me' })
  const t0 = Date.now()
  await sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-prog', entries, totalBytes)
  const totalMs = Date.now() - t0

  gaps.sort((a, b) => a - b)
  const sum = gaps.reduce((s, g) => s + g, 0)
  console.log(`\n[${scene}${sinkWriteDelayMs > 0 ? ` 慢盘${sinkWriteDelayMs}ms/块` : ''}] 总 ${totalMs}ms，progress 事件 ${gaps.length + 1} 次，平均速度 ${(totalBytes / 1048576 / (totalMs / 1000)).toFixed(1)} MB/s`)
  console.log(`  事件间隔：中位 ${gaps[Math.floor(gaps.length / 2)]}ms，P90 ${gaps[Math.floor(gaps.length * 0.9)]}ms，最大 ${gaps[gaps.length - 1]}ms，≥500ms 的间隔数 ${gaps.filter((g) => g >= 500).length}`)
  const bigs = gaps.filter((g) => g >= 500)
  if (bigs.length > 0) console.log(`  ≥500ms 间隔明细: ${bigs.slice(0, 20).join(', ')}ms`)

  await new Promise<void>((res) => r.stop(() => res()))
  await fs.rm(root, { recursive: true, force: true })
}

async function main(): Promise<void> {
  await run('big', 0)
  await run('many', 0)
  await run('big', 15) // 模拟慢盘：观察水位 pause 是否造成进度冻结
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
