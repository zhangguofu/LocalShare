'use strict'
// electron-builder 打包后钩子（仅 macOS 生效）。
//
// 依据 Apple TN3179《Understanding local network privacy》：
//   "Local network privacy uses your main executable UUID as part of its implementation.
//    If your main executable has no UUID, or shares a UUID with other programs,
//    local network privacy may behave weirdly. To fix that, make sure your main
//    executable has a UUID and that it's unique."
//
// Electron 打包出的主可执行文件会沿用 Electron 框架模板的 LC_UUID，因此所有用同一
// Electron 版本打包的应用都共用同一个 UUID（实测 LocalShare 与模板完全相同：
// 4C4C441E-5555-3144-A14D-A7622D2077FB）。这会让本地网络权限（按代码签名 + 主可执行
// 文件 UUID 跟踪程序身份）判定到错误的程序上，表现为「系统设置里开关是开的却不生效」。
//
// 本钩子把 LC_UUID 改写为本应用专属的固定 UUID：与其他应用互不相同，且跨版本保持
// 稳定（绝不能随版本变化，否则每次构建都变成新身份）。
//
// 同时这一步是官方要求的一部分，因此找不到 LC_UUID 时**让构建失败**，避免静默发出
// 一个不符合平台要求、又难以排查问题的安装包。

const fs = require('node:fs')
const path = require('node:path')

/** 本应用专属 UUID：固定不变，修改它等于更换程序身份（本地网络授权会重新走一遍）。 */
const APP_UUID = 'D3B2C2EB-2CC9-47B9-85C3-E5CE44FE1A67'

const LC_UUID = 0x1b // load command: uuid_command { uint32 cmd; uint32 cmdsize; uuid_t uuid }
const MH_MAGIC_64 = 0xfeedfacf

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`非法 UUID：${uuid}`)
  return Buffer.from(hex, 'hex')
}

function readUuid(buf, uuidOffset) {
  const h = buf.subarray(uuidOffset, uuidOffset + 16).toString('hex').toUpperCase()
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * 把 Mach-O（64 位、thin）主可执行文件的 LC_UUID 改写为指定 UUID。
 * @returns {{changed: boolean, from: string, to: string}}
 */
function patchMachOUuid(file, uuid) {
  const buf = fs.readFileSync(file)
  if (buf.length < 32) throw new Error(`${file} 太小，不是 Mach-O`)
  const magic = buf.readUInt32LE(0)
  if (magic !== MH_MAGIC_64) {
    // 说明：CI 用 electron-builder --mac --x64 --arm64 分别产出两个 thin 架构的包，
    // 因此这里期望 64 位 thin Mach-O；若将来改为 universal 包需扩展本函数。
    throw new Error(
      `${file} 不是 64 位 thin Mach-O（magic=0x${magic.toString(16)}）：` +
        '若为 universal 包，需要扩展 after-pack 处理 fat 头'
    )
  }
  const ncmds = buf.readUInt32LE(16)
  let off = 32 // mach_header_64 固定 32 字节，随后是 load commands
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off)
    const cmdsize = buf.readUInt32LE(off + 4)
    if (cmdsize <= 0) throw new Error(`${file} 的 load commands 解析异常（cmdsize=${cmdsize}）`)
    if (cmd === LC_UUID) {
      const from = readUuid(buf, off + 8)
      uuidToBytes(uuid).copy(buf, off + 8)
      fs.writeFileSync(file, buf)
      return { changed: from.toUpperCase() !== uuid.toUpperCase(), from, to: uuid.toUpperCase() }
    }
    off += cmdsize
  }
  throw new Error(`${file} 中找不到 LC_UUID —— 无法满足 Apple 对主可执行文件 UUID 的要求`)
}

/** electron-builder 钩子入口。 */
async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const exePath = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'MacOS', appName)
  if (!fs.existsSync(exePath)) {
    throw new Error(`after-pack：找不到主可执行文件 ${exePath}`)
  }
  const r = patchMachOUuid(exePath, APP_UUID)
  console.log(
    `  • 主可执行文件 UUID  ${r.from} → ${r.to}${r.changed ? '' : '（已经是目标值）'}\n` +
      `    ${appName}（Apple TN3179：UUID 必须存在且唯一）`
  )
}

module.exports = afterPack
module.exports.default = afterPack
module.exports.patchMachOUuid = patchMachOUuid
module.exports.APP_UUID = APP_UUID
