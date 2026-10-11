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
const { execFileSync } = require('node:child_process')

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

/** 判断是否为 Mach-O（含 fat）：只看魔数，避免依赖外部 file 命令。 */
function isMachO(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const b = Buffer.alloc(4)
    if (fs.readSync(fd, b, 0, 4, 0) < 4) return false
    const m = b.readUInt32LE(0)
    return [
      0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, // thin（32/64 位，两种字节序）
      0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca // fat
    ].includes(m)
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** 递归收集目录下的文件（按路径深度从深到浅，保证内层先处理）。 */
function collectFilesDeepestFirst(dir) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.push(p)
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)
}

/**
 * 对 .app 做 ad-hoc 签名（免证书、免开发者账号）。
 *
 * 依据 Apple TN3179：本地网络权限「用代码签名来跟踪程序身份」。未签名时系统在
 * UserEventAgent 里报 `Failed to get the signing identifier ... Invalid argument`，
 * 因而无法记录用户的选择——实测表现为：不弹授权提示、局域网连接被静默拒绝
 * （connect EHOSTUNREACH），对端界面毫无提示。ad-hoc 签名即可提供该标识
 * （codesign 显示 Identifier=com.apple.<bundle id>、Signature=adhoc）。
 *
 * 顺序必须是「由内到外」：先所有裸 Mach-O（框架内的 dylib/helper 可执行文件），
 * 再 Helper .app，再框架，最后 app 本体——否则 codesign 会因内层未签名而失败。
 * 若将来配置了 Developer ID 证书，electron-builder 会在本钩子之后重新签名，覆盖这里的 ad-hoc 签名。
 */
function adHocSign(appPath, log = () => {}) {
  const sign = (p) => {
    execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', p], { stdio: 'pipe' })
  }
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks')

  // 1) 框架/Helper 内的所有裸 Mach-O（最深的先签）
  let bare = 0
  for (const f of collectFilesDeepestFirst(frameworksDir)) {
    if (!isMachO(f)) continue
    sign(f)
    bare++
  }
  // 2) Helper .app 包
  const helpers = fs.existsSync(frameworksDir)
    ? fs.readdirSync(frameworksDir).filter((n) => n.endsWith('.app'))
    : []
  for (const h of helpers) sign(path.join(frameworksDir, h))
  // 3) 框架
  const frameworks = fs.existsSync(frameworksDir)
    ? fs.readdirSync(frameworksDir).filter((n) => n.endsWith('.framework'))
    : []
  for (const fw of frameworks) sign(path.join(frameworksDir, fw))
  // 4) app 本体
  sign(appPath)

  log(`  • ad-hoc 签名完成：裸 Mach-O ${bare} 个、Helper ${helpers.length} 个、框架 ${frameworks.length} 个、app 本体 1 个`)
}

/** electron-builder 钩子入口。 */
async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  const exePath = path.join(appPath, 'Contents', 'MacOS', appName)
  if (!fs.existsSync(exePath)) {
    throw new Error(`after-pack：找不到主可执行文件 ${exePath}`)
  }
  // 顺序要紧：先改写 UUID，再签名——签名必须覆盖改写后的二进制
  const r = patchMachOUuid(exePath, APP_UUID)
  console.log(
    `  • 主可执行文件 UUID  ${r.from} → ${r.to}${r.changed ? '' : '（已经是目标值）'}\n` +
      `    ${appName}（Apple TN3179：UUID 必须存在且唯一）`
  )
  adHocSign(appPath, (m) => console.log(m))
}

module.exports = afterPack
module.exports.default = afterPack
module.exports.patchMachOUuid = patchMachOUuid
module.exports.adHocSign = adHocSign
module.exports.APP_UUID = APP_UUID
