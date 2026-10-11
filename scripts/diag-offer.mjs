#!/usr/bin/env node
// LocalShare 协议级诊断：绕开界面，直接向对端发一条最小 OFFER，观察对端是否处理。
//
// 用途：定位「发送方选了文件，对端不弹接收确认框」这类问题到底是发送侧还是接收侧。
//   对端弹框  → 接收侧正常，问题在发起端的应用内（目标地址/清单构造/界面）
//   对端无反应 → 接收侧没有处理这条 OFFER（未在监听 / 不是本地 LocalShare / 界面拿不到事件）
//   连接被拒/超时 → 网络或端口问题
//
// 用法：node scripts/diag-offer.mjs <对端IP> [端口=45556]
// 注意：若对端弹出确认框，请点「拒绝」——本脚本只发清单、不发数据，接受会等到无数据超时。

import net from 'node:net'

const host = process.argv[2]
const port = Number(process.argv[3] ?? 45556)
if (!host) {
  console.error('用法：node scripts/diag-offer.mjs <对端IP> [端口=45556]')
  process.exit(1)
}

const transferId = 'diag-' + Date.now()
const offer = {
  type: 'OFFER',
  transferId,
  senderId: 'diag-probe',
  senderName: 'DIAG-PROBE',
  fileCount: 1,
  totalBytes: 5,
  files: [{ type: 'file', path: 'diag-probe.txt', size: 5 }]
}

const payload = Buffer.from(JSON.stringify(offer), 'utf8')
const header = Buffer.alloc(8)
header.write('LS1\0', 0, 'latin1') // 4 字节魔数
header.writeUInt32BE(payload.length, 4) // 4 字节大端长度

console.log(`→ 连接 ${host}:${port} …`)
const sock = net.createConnection({ host, port })
let buf = Buffer.alloc(0)
let replied = false

const done = (msg) => {
  console.log(msg)
  sock.destroy()
  process.exit(0)
}

sock.on('connect', () => {
  console.log(`→ 已连接，发送 OFFER（transferId=${transferId}，文件 diag-probe.txt，5 字节）`)
  console.log('  请观察对端屏幕：是否弹出「文件接收确认」框？')
  sock.write(Buffer.concat([header, payload]))
})

sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  while (buf.length >= 8) {
    if (buf.subarray(0, 4).toString('latin1') !== 'LS1\0') return done('✗ 对端返回的数据不是本协议帧')
    const len = buf.readUInt32BE(4)
    if (buf.length < 8 + len) return
    const msg = buf.subarray(8, 8 + len).toString('utf8')
    buf = buf.subarray(8 + len)
    replied = true
    console.log(`← 收到对端回应：${msg}`)
    if (/ACCEPT|REJECT/.test(msg)) return done('（实验结束，可关闭本窗口）')
  }
})

sock.on('error', (e) => done(`✗ 连接错误：${e.message}`))
sock.on('close', () => {
  if (!replied) done('✗ 连接被对端关闭，且未收到任何回应')
})

setTimeout(() => {
  console.log('')
  console.log('⏱ 10 秒内未收到任何协议回应。')
  console.log('   若对端屏幕也**没有**弹出确认框 → 对端没有处理这条 OFFER（接收侧问题）。')
  console.log('   若对端**弹出了**确认框 → 接收侧正常，问题在发起端的应用内。')
  sock.destroy()
  process.exit(0)
}, 10000)
