// 传输吞吐基准：本地回环双节点传输大文件，输出耗时与平均速度
// 用法：npx tsx scripts/bench-transfer.mts [文件大小MB，默认1024]
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Sender } from '../src/main/network/sender'
import { Receiver } from '../src/main/network/receiver'
import type { WalkEntry } from '../src/main/network/tree'

const TCP_PORT = 45700

async function main(): Promise<void> {
  const sizeMB = Number(process.argv[2] ?? 1024)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-bench-'))
  const recvDir = path.join(root, 'recv')
  await fs.mkdir(recvDir, { recursive: true })
  const srcFile = path.join(root, 'big.bin')
  const size = sizeMB * 1024 * 1024

  console.log(`生成 ${sizeMB}MB 测试文件...`)
  const fd = await fs.open(srcFile, 'w')
  const chunk = Buffer.alloc(8 * 1024 * 1024, 7)
  let written = 0
  while (written < size) {
    const n = Math.min(chunk.length, size - written)
    await fd.write(chunk.subarray(0, n))
    written += n
  }
  await fd.close()

  const r = new Receiver({ port: TCP_PORT, saveDir: () => recvDir })
  r.on('offer', (offer) => {
    console.log(`OFFER：${offer.totalBytes} 字节`)
    r.respond(offer.transferId, 'accept')
  })
  r.start()
  await new Promise<void>((res) => r.once('listening', res))

  const entries: WalkEntry[] = [
    { relPath: 'big.bin', absPath: srcFile, type: 'file', size }
  ]
  const sender = new Sender({ senderId: 'bench', senderName: 'Bench' })
  const start = Date.now()
  await sender.start({ host: '127.0.0.1', port: TCP_PORT }, 'bench-1', entries, size)
  const elapsed = (Date.now() - start) / 1000

  const recvStat = await fs.stat(path.join(recvDir, 'big.bin'))
  console.log(`耗时 ${elapsed.toFixed(2)}s，平均速度 ${(size / elapsed / 1024 / 1024).toFixed(1)} MB/s，接收文件 ${recvStat.size} 字节（一致:${recvStat.size === size}）`)

  r.stop()
  await fs.rm(root, { recursive: true, force: true })
  process.exit(0)
}

main().catch((err) => {
  console.error('基准异常：', err)
  process.exit(1)
})
