// 传输间隙探测：回环传输 N 个文件，记录每个数据块写出的精确时间戳，
// 分析"突发-空闲"模式：文件间隙分布、最大间隙、占空比。
// 用法：npx tsx scripts/probe-gap.mts [场景 big|small]
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { Sender } from '../src/main/network/sender'
import { Receiver } from '../src/main/network/receiver'
import { encodeFrame } from '../src/main/network/protocol'
import type { WalkEntry } from '../src/main/network/tree'

const TCP_PORT = 45710

// 内联 mini-sender：复制 Sender 核心循环，但在每个数据块写出时打时间戳
async function probeSend(
  target: { host: string; port: number },
  entries: WalkEntry[],
  onChunk: (t: number, n: number) => void,
  onFileBoundary: (t: number, label: string) => void
): Promise<void> {
  const socket = net.createConnection(target)
  socket.setNoDelay(true)
  await new Promise<void>((res, rej) => {
    socket.once('connect', res)
    socket.once('error', rej)
  })
  const waitMsg = (type: string): Promise<unknown> =>
    new Promise((res) => {
      const onData = (buf: Buffer): void => {
        // 简化：回环上每帧独立到达，直接解码
        try {
          const payload = JSON.parse(buf.subarray(8, 8 + buf.readUInt32BE(4)).toString())
          if (payload.type === type) {
            socket.off('data', onData)
            res(payload)
          }
        } catch { /* 忽略非完整帧 */ }
      }
      socket.on('data', onData)
    })

  socket.write(
    encodeFrame({
      type: 'OFFER', transferId: 'probe', senderId: 'probe', senderName: 'probe',
      fileCount: entries.length, totalBytes: entries.reduce((s, e) => s + e.size, 0),
      files: entries.map((e) => ({ type: e.type, path: e.relPath, size: e.size }))
    })
  )
  await waitMsg('ACCEPT')

  for (const entry of entries) {
    if (entry.type === 'dir') continue
    onFileBoundary(Date.now(), `start ${entry.relPath}`)
    socket.write(encodeFrame({ type: 'FILE_HEADER', transferId: 'probe', path: entry.relPath, size: entry.size }))
    if (entry.size > 0) {
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(entry.absPath, { highWaterMark: 1024 * 1024 })
        stream.on('error', reject)
        socket.on('error', reject)
        stream.on('data', (chunk: Buffer) => {
          onChunk(Date.now(), chunk.length)
          if (!socket.write(chunk)) stream.pause()
        })
        socket.on('drain', () => stream.resume())
        stream.on('end', resolve)
      })
    }
    socket.write(encodeFrame({ type: 'FILE_DONE', transferId: 'probe', path: entry.relPath, bytesWritten: entry.size }))
    onFileBoundary(Date.now(), `end ${entry.relPath}`)
  }
  socket.write(encodeFrame({ type: 'TRANSFER_DONE', transferId: 'probe' }))
  await waitMsg('TRANSFER_ACK')
  socket.end()
}

async function main(): Promise<void> {
  const scene = process.argv[2] ?? 'small'
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-gap-'))
  const recvDir = path.join(root, 'recv')
  await fs.mkdir(recvDir, { recursive: true })

  // 场景：big=单文件 256MB（连续流验证）；small=400 个 64KB（间隙验证）
  const entries: WalkEntry[] = []
  if (scene === 'big') {
    const p = path.join(root, 'big.bin')
    const fd = await fs.open(p, 'w')
    const buf = Buffer.alloc(8 * 1024 * 1024, 1)
    for (let w = 0; w < 256 * 1024 * 1024; w += buf.length) await fd.write(buf)
    await fd.close()
    entries.push({ type: 'file', relPath: 'big.bin', absPath: p, size: 256 * 1024 * 1024 })
  } else {
    const buf = Buffer.alloc(64 * 1024, 2)
    for (let i = 0; i < 400; i++) {
      const p = path.join(root, `f${i}.bin`)
      await fs.writeFile(p, buf)
      entries.push({ type: 'file', relPath: `f${i}.bin`, absPath: p, size: buf.length })
    }
  }
  const totalBytes = entries.reduce((s, e) => s + e.size, 0)

  const r = new Receiver({ port: TCP_PORT, saveDir: () => recvDir })
  r.on('offer', (offer) => r.respond(offer.transferId, 'accept'))
  r.start()
  await new Promise<void>((res) => r.once('listening', res))

  // 记录：每个数据块时间戳；文件边界时间戳
  const chunks: { t: number; n: number }[] = []
  const bounds: { t: number; label: string }[] = []
  const t0 = Date.now()
  await probeSend({ host: '127.0.0.1', port: TCP_PORT }, entries, (t, n) => chunks.push({ t, n }), (t, label) => bounds.push({ t, label }))
  const totalMs = Date.now() - t0

  // 分析
  console.log(`\n=== 场景 ${scene}：${entries.length} 个文件，共 ${(totalBytes / 1048576).toFixed(1)} MB，总耗时 ${totalMs} ms ===`)
  console.log(`数据块数 ${chunks.length}，总数据时间 ${(chunks.reduce((s, c) => s + c.n, 0) / 1048576).toFixed(1)} MB`)
  console.log(`平均吞吐 ${(totalBytes / 1048576 / (totalMs / 1000)).toFixed(1)} MB/s`)

  // 块间隙：>5ms 的都算"空档"（回环上正常块间隙 <1ms）
  const gaps: number[] = []
  for (let i = 1; i < chunks.length; i++) gaps.push(chunks[i].t - chunks[i - 1].t)
  gaps.sort((a, b) => a - b)
  const big = gaps.filter((g) => g >= 5)
  const gapMs = gaps.reduce((s, g) => s + g, 0)
  console.log(`块间隙：中位 ${gaps[Math.floor(gaps.length / 2)]}ms，P95 ${gaps[Math.floor(gaps.length * 0.95)]}ms，最大 ${gaps[gaps.length - 1]}ms`)
  console.log(`空档（≥5ms）次数 ${big.length}，累计 ${big.reduce((s, g) => s + g, 0)}ms，占总耗时 ${((big.reduce((s, g) => s + g, 0) / totalMs) * 100).toFixed(1)}%`)
  console.log(`发送方视角"纯数据推进"时间占比 ${(((totalMs - gapMs) / totalMs) * 100).toFixed(1)}%`)

  // 文件间空档：上一个文件 end 到下一个文件 start 的差
  if (bounds.length > 2) {
    const fgaps: number[] = []
    for (let i = 3; i < bounds.length - 1; i += 2) {
      if (bounds[i].label.startsWith('end') && bounds[i + 1].label.startsWith('start')) {
        fgaps.push(bounds[i + 1].t - bounds[i].t)
      }
    }
    if (fgaps.length > 0) {
      fgaps.sort((a, b) => a - b)
      console.log(`文件边界间隙（end→下个 start）：中位 ${fgaps[Math.floor(fgaps.length / 2)]}ms，最大 ${fgaps[fgaps.length - 1]}ms`)
    }
  }

  r.stop()
  await fs.rm(root, { recursive: true, force: true })
  process.exit(0)
}

// 引用 Sender/Receiver 类型以保持依赖真实实现（probeSend 的循环复制自 Sender.start 核心）
void Sender

main().catch((err) => {
  console.error('探测异常：', err)
  process.exit(1)
})
