import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Apple TN3179《Understanding local network privacy》对 macOS 应用的两条硬性要求：
//   1) 访问本地网络的应用必须在 Info.plist 声明 NSLocalNetworkUsageDescription；
//   2) 主可执行文件必须带 UUID，且必须唯一（否则本地网络权限会判到别的程序上）。
// 这些是"打包配置"，最容易被后续改动悄悄破坏，所以用测试锁住。

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')

const afterPack = require(path.join(repoRoot, 'scripts/after-pack.cjs')) as {
  patchMachOUuid: (file: string, uuid: string) => { changed: boolean; from: string; to: string }
  adHocSign: (appPath: string, log?: (m: string) => void) => void
  APP_UUID: string
}

describe('macOS 打包合规（Apple TN3179）', () => {
  it('Info.plist 声明了 NSLocalNetworkUsageDescription', () => {
    const yml = readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8')
    const m = yml.match(/NSLocalNetworkUsageDescription:\s*(.+)/)
    expect(m, '缺少 NSLocalNetworkUsageDescription：系统将无法展示本地网络授权提示').toBeTruthy()
    expect((m?.[1] ?? '').trim().length).toBeGreaterThan(0) // 用途说明不能为空
  })

  it('配置了打包后 UUID 处理钩子', () => {
    const yml = readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/afterPack:\s*scripts\/after-pack\.cjs/)
  })

  it('打包钩子里先改写 UUID 再 ad-hoc 签名（签名须覆盖改写后的二进制）', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/after-pack.cjs'), 'utf8')
    const iUuid = src.indexOf('patchMachOUuid(exePath, APP_UUID)')
    const iSign = src.indexOf('adHocSign(appPath, (m)') // 调用处（函数定义在更前面，不能匹配定义）
    expect(iUuid).toBeGreaterThan(-1)
    expect(iSign).toBeGreaterThan(iUuid)
  })

  // ad-hoc 签名（免证书）提供本地网络权限所依赖的「签名标识」：
  // 未签名时系统日志报 Failed to get the signing identifier，授权无法记录 → 静默拒绝。
  it.skipIf(process.platform !== 'darwin')('ad-hoc 签名产出签名标识与校验通过', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ls-fakeapp-'))
    const app = path.join(dir, 'Fake.app')
    mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true })
    copyFileSync('/usr/bin/true', path.join(app, 'Contents/MacOS', 'Fake'))
    writeFileSync(
      path.join(app, 'Contents/Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
        '<key>CFBundleIdentifier</key><string>com.localshare.testfake</string>' +
        '<key>CFBundleExecutable</key><string>Fake</string></dict></plist>'
    )
    afterPack.adHocSign(app)
    const r = spawnSync('codesign', ['-dv', app], { encoding: 'utf8' })
    const out = `${r.stdout}${r.stderr}`
    expect(out).toContain('Identifier=com.localshare.testfake')
    expect(out).toContain('Signature=adhoc')
    expect(spawnSync('codesign', ['--verify', app], { encoding: 'utf8' }).status).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('非 Mach-O 文件必须报错（不能让构建静默放过）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ls-uuid-'))
    const f = path.join(dir, 'not-macho')
    writeFileSync(f, 'hello localshare')
    expect(() => afterPack.patchMachOUuid(f, afterPack.APP_UUID)).toThrow(/Mach-O/)
    rmSync(dir, { recursive: true, force: true })
  })

  // 用仓库里自带的 Electron 主可执行文件做真实样本：它正是打包时会沿用的模板
  const template = path.join(
    repoRoot,
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  )

  it.skipIf(!existsSync(template))('主可执行文件的 LC_UUID 被改写为本应用专属值', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ls-uuid-'))
    const copy = path.join(dir, 'LocalShare')
    copyFileSync(template, copy)

    const first = afterPack.patchMachOUuid(copy, afterPack.APP_UUID)
    expect(first.to).toBe(afterPack.APP_UUID)
    // 模板 UUID 与本应用不同：这正是「所有同版本 Electron 应用共用同一 UUID」的现场证据
    expect(first.from.toUpperCase()).not.toBe(afterPack.APP_UUID)
    expect(first.changed).toBe(true)

    // 幂等：再次处理不应再改动（跨版本固定同一个 UUID，身份才稳定）
    const second = afterPack.patchMachOUuid(copy, afterPack.APP_UUID)
    expect(second.changed).toBe(false)
    expect(second.from.toUpperCase()).toBe(afterPack.APP_UUID)

    rmSync(dir, { recursive: true, force: true })
  })
})
