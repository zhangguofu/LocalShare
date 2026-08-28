#!/usr/bin/env node
// LocalShare 发版打包脚本
// 用法：
//   npm run release                 # patch +1（0.1.0 → 0.1.1）并打包当前平台
//   npm run release -- --minor      # minor +1（0.1.0 → 0.2.0）
//   npm run release -- --major      # major +1（0.1.0 → 1.0.0）
//   npm run release -- --version=1.2.3   # 指定版本
//   npm run release -- --no-sign    # mac 跳过签名（无证书/沙箱环境）
// 平台自适应：macOS → .dmg；Windows → .exe
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(root, 'package.json')

// ---- 参数解析 ----
const args = process.argv.slice(2)
const opts = { minor: false, major: false, explicit: null, noSign: false }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--minor') opts.minor = true
  else if (a === '--major') opts.major = true
  else if (a === '--no-sign') opts.noSign = true
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

if (process.platform === 'darwin') {
  console.log('▶ 打包 macOS .dmg ...')
  const sign = opts.noSign ? ' -c.mac.identity=null' : ''
  run(`npx electron-builder --mac${sign}`)
} else if (process.platform === 'win32') {
  console.log('▶ 打包 Windows .exe ...')
  run('npx electron-builder --win')
} else {
  console.error(`不支持的平台：${process.platform}（仅支持 darwin / win32）`)
  process.exit(1)
}

console.log(`\n✅ 打包完成：v${next}（${process.platform}）`)
console.log('   产物目录：dist/')
