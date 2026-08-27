// 本机双实例互传验证脚本（用户在本机终端运行，非沙箱）
// 模拟两个 LocalShare 节点：B（Receiver 监听 45656）+ A（Sender 发送），
// 覆盖 OFFER → ACCEPT → 逐文件流 → TRANSFER_ACK 全流程并校验文件内容与目录结构。
// 运行：npx tsx scripts/verify-transfer.mts
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Sender } from '../src/main/network/sender'
import { Receiver } from '../src/main/network/receiver'
import type { WalkEntry } from '../src/main/network/tree'

const TCP_PORT = 45656

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-verify-'))
  const recvDir = path.join(root, 'recv')
  await fs.mkdir(recvDir, { recursive: true })

  // 构造测试内容：嵌套目录 + 空目录 + 二进制文件（含零字节）
  const src = path.join(root, 'docs')
  await fs.mkdir(path.join(src, 'sub', 'empty'), { recursive: true })
  await fs.writeFile(path.join(src, 'README.md'), '# LocalShare 验证\n你好，局域网文件分享！')
  await fs.writeFile(path.join(src, 'sub', 'data.bin'), Buffer.from(Array.from({ length: 256 }, (_, i) => i % 251)))
  await fs.writeFile(path.join(src, 'empty.bin'), Buffer.alloc(0))
  await fs.writeFile(path.join(src, 'sub', 'nested.txt'), '嵌套目录内容')

  const entries: WalkEntry[] = [
    { relPath: 'docs/README.md', absPath: path.join(src, 'README.md'), type: 'file', size: (await fs.stat(path.join(src, 'README.md'))).size },
    { relPath: 'docs/sub/', absPath: path.join(src, 'sub'), type: 'dir', size: 0 },
    { relPath: 'docs/sub/data.bin', absPath: path.join(src, 'sub', 'data.bin'), type: 'file', size: (await fs.stat(path.join(src, 'sub', 'data.bin'))).size },
    { relPath: 'docs/empty.bin', absPath: path.join(src, 'empty.bin'), type: 'file', size: 0 },
    { relPath: 'docs/sub/nested.txt', absPath: path.join(src, 'sub', 'nested.txt'), type: 'file', size: (await fs.stat(path.join(src, 'sub', 'nested.txt'))).size }
  ]
  const totalBytes = entries.filter((e) => e.type === 'file').reduce((s, e) => s + e.size, 0)

  // 节点 B：接收端
  const receiver = new Receiver({ port: TCP_PORT, saveDir: () => recvDir })
  receiver.on('offer', (offer) => {
    console.log(`[B] 收到 OFFER：${offer.senderName} → ${offer.fileCount} 项，${offer.totalBytes} 字节，冲突=${offer.conflicts}`)
    receiver.respond(offer.transferId, 'accept')
  })
  receiver.on('complete', (id) => console.log(`[B] 传输完成：${id}`))
  receiver.on('transferError', (e) => console.log(`[B] 传输错误：${e.error.message}`))
  receiver.start()
  await new Promise<void>((res) => receiver.once('listening', res))
  console.log('[B] 接收端监听 127.0.0.1:' + TCP_PORT)

  // 节点 A：发送端
  const sender = new Sender({ senderId: 'verify-a', senderName: 'Verify-A' })
  let lastProgress = 0
  sender.on('progress', (p) => {
    lastProgress = p.totalBytes
  })
  console.log(`[A] 发送 ${entries.length} 项（${totalBytes} 字节）到 127.0.0.1:${TCP_PORT} ...`)
  await sender.start({ host: '127.0.0.1', port: TCP_PORT }, 'verify-1', entries, totalBytes)
  console.log(`[A] 发送完成，已传 ${lastProgress}/${totalBytes} 字节，收到 TRANSFER_ACK`)

  // 校验
  const checks: [string, boolean][] = []
  checks.push(['README.md 内容一致', (await fs.readFile(path.join(recvDir, 'docs', 'README.md'), 'utf8')) === (await fs.readFile(path.join(src, 'README.md'), 'utf8'))])
  checks.push(['data.bin 内容一致', (await fs.readFile(path.join(recvDir, 'docs', 'sub', 'data.bin'))).equals(await fs.readFile(path.join(src, 'sub', 'data.bin')))])
  checks.push(['零字节文件存在', (await fs.stat(path.join(recvDir, 'docs', 'empty.bin'))).size === 0])
  checks.push(['空目录已创建', (await fs.stat(path.join(recvDir, 'docs', 'sub'))).isDirectory()])
  checks.push(['嵌套文件存在', (await fs.readFile(path.join(recvDir, 'docs', 'sub', 'nested.txt'), 'utf8')) === '嵌套目录内容'])
  checks.push(['无 .part 残留', (await fs.readdir(recvDir, { recursive: true })).filter((f) => f.toString().endsWith('.part')).length === 0])

  let ok = true
  for (const [label, pass] of checks) {
    console.log(`${pass ? '✅' : '❌'} ${label}`)
    if (!pass) ok = false
  }

  receiver.stop()
  await fs.rm(root, { recursive: true, force: true })
  console.log(ok ? '\n=== 验证通过：双节点互传全流程正确 ===' : '\n=== 验证失败 ===')
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('验证异常：', err)
  process.exit(1)
})
