#!/usr/bin/env node
// LocalShare 发版打包脚本
// 用法：
//   npm run release                 # patch +1（0.1.0 → 0.1.1）并打包当前平台
//   npm run release -- --minor      # minor +1（0.1.0 → 0.2.0）
//   npm run release -- --major      # major +1（0.1.0 → 1.0.0）
//   npm run release -- --version=1.2.3   # 指定版本
//   npm run release -- --no-sign    # mac 跳过签名（无证书/沙箱环境）
//   npm run release -- --arch=x64   # 指定架构：x64 | arm64 | universal | both
//                                  #   mac 默认按本机架构；universal/both 打多架构
//                                  #   win 默认 x64，可用 arm64
// 平台自适应：macOS → .dmg；Windows → .exe
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(root, 'package.json')
const HOST_ARCH = os.arch() // x64 / arm64（真实内核架构，避免 Rosetta 干扰）

// ---- 参数解析 ----
const args = process.argv.slice(2)
const opts = { minor: false, major: false, explicit: null, noSign: false, arch: null }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--minor') opts.minor = true
  else if (a === '--major') opts.major = true
  else if (a === '--no-sign') opts.noSign = true
  else if (a === '--arch') opts.arch = args[++i]
  else if (a.startsWith('--arch=')) opts.arch = a.slice('--arch='.length)
  else if (a === '--version') opts.explicit = args[++i]
  else if (a.startsWith('--version=')) opts.explicit = a.slice('--version='.length)
}

// ---- 计算并写入新版本 ----
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
let next
if (opts.explicit) {
  if (!/^\d+\.\d+\.\d+$/.test(opts.explicit)) {
    console.error(`无效版本号：${opts.explicit}（应为 x.y.z）`)
    process.exit(1)
  }
  next = opts.explicit
} else {
  const [maj, min, patch] = pkg.version.split('.').map(Number)
  if (opts.major) next = `${maj + 1}.0.0`
  else if (opts.minor) next = `${maj}.${min + 1}.0`
  else next = `${maj}.${min}.${patch + 1}`
}
pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`版本号：${pkg.version} → ${next}`)

// ---- 构建 + 平台打包 ----
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' })

console.log('▶ 构建...')
run('npm run build')

// macOS：区分 Intel(x64) / Apple Silicon(arm64)，支持 universal（通用二进制）与 both（两个独立包）
if (process.platform === 'darwin') {
  const sign = opts.noSign ? ' -c.mac.identity=null' : ''
  const arch = opts.arch ?? HOST_ARCH
  let target
  if (arch === 'universal') {
    target = '--mac --universal'
  } else if (arch === 'both') {
    console.log(`▶ 打包 macOS 双架构（x64 + arm64）...`)
    run(`npx electron-builder --mac --x64${sign}`)
    run(`npx electron-builder --mac --arm64${sign}`)
    console.log(`\n✅ 打包完成：v${next}（darwin x64 + arm64）`)
    console.log('   产物目录：dist/')
    process.exit(0)
  } else if (arch === 'x64' || arch === 'arm64') {
    target = `--mac --${arch}`
  } else {
    console.error(`无效架构：${arch}（mac 支持 x64 | arm64 | universal | both）`)
    process.exit(1)
  }
  console.log(`▶ 打包 macOS .dmg（${arch}，本机=${HOST_ARCH}）...`)
  run(`npx electron-builder ${target}${sign}`)
  console.log(`\n✅ 打包完成：v${next}（darwin ${arch}）`)
  console.log('   产物目录：dist/')
} else if (process.platform === 'win32') {
  const arch = opts.arch ?? 'x64'
  if (arch !== 'x64' && arch !== 'arm64') {
    console.error(`无效架构：${arch}（win 支持 x64 | arm64）`)
    process.exit(1)
  }
  console.log(`▶ 打包 Windows .exe（${arch}）...`)
  run(`npx electron-builder --win --${arch}`)
  console.log(`\n✅ 打包完成：v${next}（win32 ${arch}）`)
  console.log('   产物目录：dist/')
} else {
  console.error(`不支持的平台：${process.platform}（仅支持 darwin / win32）`)
  process.exit(1)
}
