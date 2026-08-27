# LocalShare 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个 Windows/macOS 双平台的 Electron 局域网文件分享应用：UDP 广播自动发现设备，TCP 逐文件流式传输，接收方确认后落盘，支持同名冲突的覆盖/换目录处理。

**Architecture:** 单进程 Electron。主进程承载全部网络逻辑（自研 UDP 发现 + TCP 传输协议，仅用 Node 内置 `dgram`/`net`），渲染进程用 Vue 3 + Element Plus 展示设备列表、拖拽发送、传输队列与确认对话框，经 preload 的 `contextBridge` 窄 API 与主进程通信。核心协议与存储逻辑为纯函数模块，可完全单元测试；网络层用回环地址做集成测试。

**Tech Stack:** Electron + electron-vite + electron-builder；Vue 3 + TypeScript + Pinia + Element Plus；Vitest（单元 + 集成）；Node 内置 `dgram`/`net`/`fs`；`.npmrc` 已配置 npmmirror 国内镜像。

**规格依据:** `docs/2026-08-27-localshare-design.md`（设计文档，用户已确认）。

---

## 文件结构

```
localshare/
├── .npmrc                            # 国内镜像（registry + electron 二进制）
├── package.json                      # 依赖与脚本（主进程零运行时依赖）
├── electron.vite.config.ts           # main/preload/renderer 三段构建
├── vitest.config.ts                  # 测试配置（node 环境）
├── tsconfig.node.json                # 主进程/preload/测试 typecheck
├── tsconfig.web.json                 # 渲染进程 typecheck
├── electron-builder.yml              # 打包配置（Task 9）
├── src/
│   ├── main/
│   │   ├── index.ts                  # 入口：窗口、服务组装、IPC handlers
│   │   ├── config.ts                 # 设置与设备 ID 持久化（JSON，userData 下）
│   │   ├── network/
│   │   │   ├── protocol.ts           # 帧编解码、9+2 种消息类型、路径清洗、FrameParser
│   │   │   ├── tree.ts               # 目录树遍历生成 OFFER 清单（跳过符号链接）
│   │   │   ├── deviceTable.ts        # 设备表纯逻辑（HELLO 添加/BYE 删除/超时剔除）
│   │   │   ├── discovery.ts          # UDP 广播/监听、心跳定时器
│   │   │   ├── sender.ts             # 发送方：OFFER→ACCEPT→逐文件→DONE→ACK
│   │   │   └── receiver.ts           # 接收方：监听、确认流程、CTRL/DATA 状态机
│   │   └── storage.ts                # 保存目录、冲突检测、AtomicSink（.part 原子写）
│   ├── preload/
│   │   └── index.ts                  # contextBridge 窄 API
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.ts               # Vue 挂载（Pinia + Element Plus）
│           ├── App.vue               # 布局骨架
│           ├── stores/device.ts      # Pinia：设备列表
│           ├── stores/transfer.ts    # Pinia：传输队列
│           ├── components/
│           │   ├── DeviceList.vue    # 左侧在线设备
│           │   ├── DropZone.vue      # 拖拽/选择发送区
│           │   ├── TransferList.vue  # 传输队列与进度
│           │   └── TransferConfirmDialog.vue  # 接收确认（冲突三选一）
│           └── api.d.ts              # window.api 类型声明
├── tests/
│   ├── unit/
│   │   ├── protocol.test.ts
│   │   ├── tree.test.ts
│   │   ├── storage.test.ts
│   │   └── deviceTable.test.ts
│   └── integration/
│       ├── discovery.test.ts
│       └── transfer.test.ts
└── docs/2026-08-27-localshare-design.md
```

**规格偏差说明（1 处）**：设计文档 8.1 的持久化方案 `electron-store` 改为手写 JSON 配置模块（`config.ts`）。理由：electron-store v10 起为纯 ESM，会迫使主进程放弃默认 CJS 输出并处理 sandbox 下 preload 的兼容问题，而本项目配置项仅设备 ID + 几个设置项，手写 JSON 读写约 30 行、功能完全等价。此调整在 Task 0 落地，后续任务不再提及 electron-store。

---

## Task 0: 项目脚手架

**Files:**
- Create: `.npmrc`
- Create: `package.json`
- Create: `electron.vite.config.ts`
- Create: `vitest.config.ts`
- Create: `tsconfig.node.json`
- Create: `tsconfig.web.json`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/src/main.ts`
- Create: `src/renderer/src/App.vue`

- [ ] **Step 0.1: 创建 `.npmrc`（国内镜像固化）**

```ini
registry=https://registry.npmmirror.com
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
```

- [ ] **Step 0.2: 创建 `package.json`**

```json
{
  "name": "localshare",
  "version": "0.1.0",
  "description": "LAN file and folder sharing between Windows and macOS",
  "main": "out/main/index.js",
  "author": "LocalShare",
  "license": "MIT",
  "scripts": {
    "dev": "electron-vite dev",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && vue-tsc --noEmit -p tsconfig.web.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "electron-vite build",
    "build:mac": "electron-vite build && electron-builder --mac",
    "build:win": "electron-vite build && electron-builder --win"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.0.4",
    "electron": "^29.1.0",
    "electron-builder": "^24.13.3",
    "electron-vite": "^2.2.0",
    "element-plus": "^2.7.2",
    "pinia": "^2.1.7",
    "typescript": "^5.4.5",
    "vite": "^5.2.11",
    "vitest": "^1.6.0",
    "vue": "^3.4.27",
    "vue-tsc": "^2.0.19"
  }
}
```

说明：`dependencies` 有意留空——渲染层依赖（vue/pinia/element-plus）在构建时被打进 bundle，主进程只用 Node 内置模块，故无需运行时依赖，打包产物更干净。

- [ ] **Step 0.3: 创建 `electron.vite.config.ts`**

```ts
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [vue()]
  }
})
```

- [ ] **Step 0.4: 创建 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
})
```

- [ ] **Step 0.5: 创建 `tsconfig.node.json`**（主进程 / preload / 测试）

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "types": ["node"],
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["electron.vite.config.ts", "src/main/**/*.ts", "src/preload/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 0.6: 创建 `tsconfig.web.json`**（渲染进程）

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/renderer/src/**/*.ts", "src/renderer/src/**/*.vue"]
}
```

- [ ] **Step 0.7: 创建主进程最小入口 `src/main/index.ts`**

```ts
import { app, BrowserWindow } from 'electron'
import path from 'node:path'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    title: 'LocalShare',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 0.8: 创建最小 preload `src/preload/index.ts`**

```ts
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('api', {
  ping: (): string => 'pong'
})
```

- [ ] **Step 0.9: 创建渲染进程骨架**

`src/renderer/index.html`:

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>LocalShare</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`src/renderer/src/main.ts`:

```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'

createApp(App).use(createPinia()).use(ElementPlus).mount('#app')
```

`src/renderer/src/App.vue`:

```vue
<template>
  <el-container class="app-root">
    <el-main>
      <h1>LocalShare</h1>
      <p>脚手架验证：{{ pingResult }}</p>
    </el-main>
  </el-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const pingResult = ref('...')
onMounted(async () => {
  pingResult.value = await window.api.ping()
})
</script>

<style>
.app-root {
  height: 100vh;
}
</style>
```

- [ ] **Step 0.10: 安装依赖并验证**

Run: `npm install`
Expected: 依赖安装完成（走 npmmirror 镜像，Electron 二进制从镜像下载，无 GitHub 直连）

Run: `npm run typecheck`
Expected: 两个 tsc 命令均无错误输出，exit 0

Run: `npm run dev`
Expected: 应用窗口出现，页面显示 "脚手架验证：pong"（需手动确认窗口；dev 模式为热重载，随后 Ctrl+C 退出）

Run: `npm test`
Expected: "No test files found" 退出码 1 属正常（尚未有测试，Task 1 起出现用例）

- [ ] **Step 0.11: Commit**

```bash
git add .npmrc package.json electron.vite.config.ts vitest.config.ts tsconfig.node.json tsconfig.web.json src/
git commit -m "chore: bootstrap electron-vite + vue3 + element-plus scaffold with china mirrors"
```

---

## Task 1: Protocol 核心（帧编解码 + 消息类型 + 路径清洗）

**Files:**
- Create: `src/main/network/protocol.ts`
- Create: `tests/unit/protocol.test.ts`

- [ ] **Step 1.1: 写失败的测试 `tests/unit/protocol.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import {
  encodeFrame,
  decodeFrame,
  FrameParser,
  sanitizePath,
  MAGIC,
  HEADER_LENGTH,
  MAX_FRAME_LENGTH,
  type AcceptMessage,
  type HelloMessage
} from '../src/main/network/protocol'

describe('encodeFrame / decodeFrame', () => {
  it('往返编解码 ACCEPT', () => {
    const msg: AcceptMessage = { type: 'ACCEPT', transferId: 'abc-123' }
    const frame = encodeFrame(msg)
    expect(frame.subarray(0, 4).equals(MAGIC)).toBe(true)
    expect(frame.readUInt32BE(4)).toBe(frame.length - HEADER_LENGTH)
    expect(decodeFrame(frame)).toEqual(msg)
  })

  it('magic 错误抛出', () => {
    const bad = Buffer.from('XXXX')
    expect(() => decodeFrame(Buffer.concat([bad, Buffer.from('1234')]))).toThrow(/magic/)
  })

  it('帧长度不匹配抛出', () => {
    const msg: AcceptMessage = { type: 'ACCEPT', transferId: 'abc' }
    const frame = encodeFrame(msg)
    expect(() => decodeFrame(frame.subarray(0, frame.length - 1))).toThrow(/length/)
  })

  it('载荷超过上限抛出', () => {
    const big = { type: 'OFFER' as const, transferId: 'x', senderId: 's', senderName: 'n', fileCount: 1, totalBytes: 0, files: [{ type: 'file' as const, path: 'a'.repeat(1024 * 1024), size: 1 }] }
    expect(() => encodeFrame(big, 1024)).toThrow(/too large/)
  })
})

describe('FrameParser（粘包/拆包）', () => {
  const mkFrame = (type: string, id: string): Buffer => encodeFrame({ type, transferId: id } as never)

  it('拆包：分两次 push', () => {
    const frame = mkFrame('ACCEPT', 'id-1')
    const parser = new FrameParser()
    expect(parser.push(frame.subarray(0, 5))).toEqual([])
    expect(parser.push(frame.subarray(5))).toHaveLength(1)
  })

  it('粘包：一次 push 两帧', () => {
    const parser = new FrameParser()
    const out = parser.push(Buffer.concat([mkFrame('ACCEPT', 'a'), mkFrame('REJECT', 'b')]))
    expect(out).toHaveLength(2)
    expect((out[0] as { transferId: string }).transferId).toBe('a')
    expect((out[1] as { transferId: string }).transferId).toBe('b')
  })

  it('畸形 magic 帧抛错', () => {
    const parser = new FrameParser()
    expect(() => parser.push(Buffer.concat([Buffer.from('BADM'), Buffer.from([0, 0, 0, 1]), Buffer.from('{}')]))).toThrow(/magic/)
  })
})

describe('sanitizePath', () => {
  it('正常相对路径通过', () => {
    expect(sanitizePath('docs/a.txt')).toBe('docs/a.txt')
  })
  it('尾部斜杠的目录条目归一化', () => {
    expect(sanitizePath('docs/empty/')).toBe('docs/empty')
  })
  it('连续斜杠合并', () => {
    expect(sanitizePath('a//b')).toBe('a/b')
  })
  it('拒绝 .. 穿越', () => {
    expect(sanitizePath('../evil')).toBeNull()
    expect(sanitizePath('a/../../b')).toBeNull()
  })
  it('拒绝绝对路径', () => {
    expect(sanitizePath('/abs')).toBeNull()
    expect(sanitizePath('\\abs')).toBeNull()
  })
  it('拒绝盘符路径', () => {
    expect(sanitizePath('C:/x')).toBeNull()
    expect(sanitizePath('C:\\x')).toBeNull()
  })
  it('拒绝非法字符', () => {
    expect(sanitizePath('a/b?.txt')).toBeNull()
    expect(sanitizePath('a:b.txt')).toBeNull()
    expect(sanitizePath('a*b.txt')).toBeNull()
    expect(sanitizePath('a<b.txt')).toBeNull()
  })
  it('拒绝 Windows 保留名', () => {
    expect(sanitizePath('CON')).toBeNull()
    expect(sanitizePath('dir/nul')).toBeNull()
  })
  it('拒绝空路径与纯点段', () => {
    expect(sanitizePath('')).toBeNull()
    expect(sanitizePath('./x')).toBeNull()
  })
  it('拒绝空载荷 JSON 的 HELLO 大小上限（1 KiB 由 discovery 层限制，这里验证 sanitize 不越权）', () => {
    expect(sanitizePath('a.txt')).toBe('a.txt')
  })
})
```

- [ ] **Step 1.2: 运行测试确认失败**

Run: `npx vitest run tests/unit/protocol.test.ts`
Expected: FAIL，报模块不存在（`Cannot find module '../src/main/network/protocol'`）

- [ ] **Step 1.3: 实现 `src/main/network/protocol.ts`**

```ts
// 帧格式：4B magic "LS1\0" + 4B uint32 BE length + JSON payload（UTF-8）
export const MAGIC = Buffer.from([0x4c, 0x53, 0x31, 0x00]) // "LS1\0"
export const HEADER_LENGTH = 8
export const MAX_FRAME_LENGTH = 16 * 1024 * 1024
export const MAX_DISCOVERY_LENGTH = 1024

// ---- 消息类型（协议 5.3 + 发现消息 4.3） ----
export interface FileEntry {
  type: 'file' | 'dir'
  path: string
  size?: number
}

export interface HelloMessage {
  type: 'HELLO'
  deviceId: string
  deviceName: string
  platform: string
  version: string
  tcpPort: number
  timestamp: number
}
export interface ByeMessage {
  type: 'BYE'
  deviceId: string
}
export interface OfferMessage {
  type: 'OFFER'
  transferId: string
  senderId: string
  senderName: string
  fileCount: number
  totalBytes: number
  files: FileEntry[]
}
export interface AcceptMessage {
  type: 'ACCEPT'
  transferId: string
}
export interface RejectMessage {
  type: 'REJECT'
  transferId: string
  reason: string
}
export interface FileHeaderMessage {
  type: 'FILE_HEADER'
  transferId: string
  path: string
  size: number
}
export interface FileDoneMessage {
  type: 'FILE_DONE'
  transferId: string
  path: string
  bytesWritten: number
}
export interface TransferDoneMessage {
  type: 'TRANSFER_DONE'
  transferId: string
}
export interface TransferAckMessage {
  type: 'TRANSFER_ACK'
  transferId: string
}
export interface CancelMessage {
  type: 'CANCEL'
  transferId: string
  reason: string
}
export interface ErrorMessage {
  type: 'ERROR'
  transferId: string
  code: string
  message: string
}

export type Message =
  | HelloMessage
  | ByeMessage
  | OfferMessage
  | AcceptMessage
  | RejectMessage
  | FileHeaderMessage
  | FileDoneMessage
  | TransferDoneMessage
  | TransferAckMessage
  | CancelMessage
  | ErrorMessage

// ---- 帧编解码 ----
export function encodeFrame(msg: Message, maxLen: number = MAX_FRAME_LENGTH): Buffer {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8')
  if (payload.length > maxLen) {
    throw new Error(`frame payload too large: ${payload.length} > ${maxLen}`)
  }
  const header = Buffer.alloc(HEADER_LENGTH)
  MAGIC.copy(header, 0)
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

export function decodeFrame(buf: Buffer): Message {
  if (buf.length < HEADER_LENGTH) throw new Error('frame too short')
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('bad magic')
  const length = buf.readUInt32BE(4)
  if (length > MAX_FRAME_LENGTH) throw new Error('frame too large')
  if (buf.length !== HEADER_LENGTH + length) throw new Error('frame length mismatch')
  let msg: unknown
  try {
    msg = JSON.parse(buf.subarray(HEADER_LENGTH).toString('utf8'))
  } catch {
    throw new Error('invalid json')
  }
  if (typeof msg !== 'object' || msg === null || typeof (msg as { type?: unknown }).type !== 'string') {
    throw new Error('invalid message')
  }
  return msg as Message
}

// ---- 增量帧解析（粘包/拆包） ----
export class FrameParser {
  private buf = Buffer.alloc(0)

  push(chunk: Buffer): Message[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: Message[] = []
    for (;;) {
      if (this.buf.length < HEADER_LENGTH) break
      const length = this.buf.readUInt32BE(4)
      if (length > MAX_FRAME_LENGTH) throw new Error('frame too large')
      if (this.buf.length < HEADER_LENGTH + length) break
      out.push(decodeFrame(this.buf.subarray(0, HEADER_LENGTH + length)))
      this.buf = this.buf.subarray(HEADER_LENGTH + length)
    }
    return out
  }
}

// ---- 路径清洗（协议 5.6） ----
const INVALID_CHARS = /[\\/:*?"<>|\u0000-\u001f]/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function sanitizePath(p: string): string | null {
  if (!p || p.length === 0) return null
  if (p.includes('..')) return null
  if (p.startsWith('/') || p.startsWith('\\')) return null
  if (/^[a-zA-Z]:/.test(p)) return null
  if (p.startsWith('~')) return null
  const parts = p.split('/').filter((s) => s.length > 0)
  if (parts.length === 0) return null
  for (const part of parts) {
    if (part === '.') return null
    if (INVALID_CHARS.test(part)) return null
    if (WINDOWS_RESERVED.test(part)) return null
  }
  return parts.join('/')
}
```

- [ ] **Step 1.4: 运行测试确认通过**

Run: `npx vitest run tests/unit/protocol.test.ts`
Expected: 全部 PASS（约 15 个用例）

- [ ] **Step 1.5: Commit**

```bash
git add src/main/network/protocol.ts tests/unit/protocol.test.ts
git commit -m "feat(protocol): frame codec, message types, FrameParser, path sanitization"
```

---

## Task 2: 目录树遍历（生成 OFFER 清单）

**Files:**
- Create: `src/main/network/tree.ts`
- Create: `tests/unit/tree.test.ts`

- [ ] **Step 2.1: 写失败的测试 `tests/unit/tree.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { walkPaths } from '../src/main/network/tree'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'localshare-tree-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('walkPaths', () => {
  it('遍历嵌套目录并统计总字节', async () => {
    await fs.mkdir(path.join(root, 'sub', 'empty'), { recursive: true })
    await fs.writeFile(path.join(root, 'a.txt'), Buffer.alloc(10))
    await fs.writeFile(path.join(root, 'sub', 'b.txt'), Buffer.alloc(20))
    const { entries, totalBytes } = await walkPaths([root])
    expect(totalBytes).toBe(30)
    expect(entries).toContainEqual({ type: 'file', relPath: 'a.txt', absPath: path.join(root, 'a.txt'), size: 10 })
    expect(entries).toContainEqual({ type: 'file', relPath: 'sub/b.txt', absPath: path.join(root, 'sub', 'b.txt'), size: 20 })
    expect(entries).toContainEqual({ type: 'dir', relPath: 'sub/empty/', absPath: path.join(root, 'sub', 'empty'), size: 0 })
    expect(entries.filter((e) => e.type === 'dir')).toHaveLength(1)
  })

  it('多输入路径合并为一个清单', async () => {
    await fs.writeFile(path.join(root, 'x.txt'), Buffer.alloc(5))
    const extra = await fs.mkdtemp(path.join(os.tmpdir(), 'localshare-extra-'))
    await fs.writeFile(path.join(extra, 'y.txt'), Buffer.alloc(7))
    try {
      const { entries, totalBytes } = await walkPaths([root, extra])
      expect(totalBytes).toBe(12)
      expect(entries).toHaveLength(2)
    } finally {
      await fs.rm(extra, { recursive: true, force: true })
    }
  })

  it('跳过符号链接（防循环）', { skip: process.platform === 'win32' }, async () => {
    await fs.writeFile(path.join(root, 'real.txt'), Buffer.alloc(3))
    await fs.symlink(path.join(root, 'real.txt'), path.join(root, 'link.txt'))
    const { entries } = await walkPaths([root])
    expect(entries.map((e) => e.relPath)).not.toContain('link.txt')
  })

  it('空文件夹条目带尾斜杠', async () => {
    await fs.mkdir(path.join(root, 'only-empty'), { recursive: true })
    const { entries } = await walkPaths([root])
    expect(entries).toEqual([{ type: 'dir', relPath: 'only-empty/', absPath: path.join(root, 'only-empty'), size: 0 }])
  })
})
```

- [ ] **Step 2.2: 运行测试确认失败**

Run: `npx vitest run tests/unit/tree.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 2.3: 实现 `src/main/network/tree.ts`**

```ts
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface WalkEntry {
  type: 'file' | 'dir'
  relPath: string // 协议相对路径（/ 分隔，dir 条目带尾斜杠）
  absPath: string // 本机绝对路径（读取文件用）
  size: number
}

export interface WalkResult {
  entries: WalkEntry[]
  totalBytes: number
}

export async function walkPaths(inputPaths: string[]): Promise<WalkResult> {
  const entries: WalkEntry[] = []
  let totalBytes = 0
  for (const input of inputPaths) {
    const stat = await fs.lstat(input)
    if (stat.isSymbolicLink()) continue
    const abs = path.resolve(input)
    const base = path.basename(abs)
    if (stat.isDirectory()) {
      await walkDir(abs, base, entries, (n) => (totalBytes += n))
    } else if (stat.isFile()) {
      entries.push({ type: 'file', relPath: base, absPath: abs, size: stat.size })
      totalBytes += stat.size
    }
  }
  return { entries, totalBytes }
}

async function walkDir(
  dirAbs: string,
  dirRel: string,
  entries: WalkEntry[],
  addBytes: (n: number) => void
): Promise<void> {
  const dirents = await fs.readdir(dirAbs, { withFileTypes: true })
  if (dirents.length === 0) {
    entries.push({ type: 'dir', relPath: dirRel + '/', absPath: dirAbs, size: 0 })
    return
  }
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue
    const childRel = dirRel + '/' + d.name
    const childAbs = path.join(dirAbs, d.name)
    if (d.isDirectory()) {
      await walkDir(childAbs, childRel, entries, addBytes)
    } else if (d.isFile()) {
      const st = await fs.stat(childAbs)
      entries.push({ type: 'file', relPath: childRel, absPath: childAbs, size: st.size })
      addBytes(st.size)
    }
  }
}
```

- [ ] **Step 2.4: 运行测试确认通过**

Run: `npx vitest run tests/unit/tree.test.ts`
Expected: 全部 PASS

- [ ] **Step 2.5: Commit**

```bash
git add src/main/network/tree.ts tests/unit/tree.test.ts
git commit -m "feat(tree): walk directories into OFFER entries, skip symlinks"
```

---

## Task 3: Storage（保存目录、冲突检测、原子落盘）

**Files:**
- Create: `src/main/storage.ts`
- Create: `tests/unit/storage.test.ts`

- [ ] **Step 3.1: 写失败的测试 `tests/unit/storage.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AtomicSink, detectConflicts, defaultSaveDir } from '../src/main/storage'
import type { FileEntry } from '../src/main/network/protocol'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localshare-store-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('defaultSaveDir', () => {
  it('返回用户目录下 LocalShare', () => {
    expect(defaultSaveDir()).toBe(path.join(os.homedir(), 'LocalShare'))
  })
})

describe('detectConflicts', () => {
  const entries = (ps: string[]): FileEntry[] => ps.map((p) => ({ type: 'file' as const, path: p, size: 1 }))

  it('无冲突返回 false', async () => {
    expect(await detectConflicts(entries(['a.txt']), dir)).toBe(false)
  })
  it('同名文件存在返回 true', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'x')
    expect(await detectConflicts(entries(['a.txt']), dir)).toBe(true)
  })
  it('同名目录存在返回 true', async () => {
    await fs.mkdir(path.join(dir, 'docs'))
    expect(await detectConflicts(entries(['docs/x.txt']), dir)).toBe(true)
  })
  it('目录条目（尾斜杠）同样参与冲突检测', async () => {
    await fs.mkdir(path.join(dir, 'empty'))
    expect(await detectConflicts([{ type: 'dir', path: 'empty/' }], dir)).toBe(true)
  })
})

describe('AtomicSink', () => {
  it('写入后 commit 生成目标文件且无 .part 残留', async () => {
    const sink = new AtomicSink(path.join(dir, 'out.bin'))
    await sink.open()
    sink.write(Buffer.from('hello'))
    await sink.commit()
    expect(await fs.readFile(path.join(dir, 'out.bin'), 'utf8')).toBe('hello')
    await expect(fs.access(path.join(dir, 'out.bin.part'))).rejects.toThrow()
  })

  it('嵌套目录自动创建', async () => {
    const sink = new AtomicSink(path.join(dir, 'deep', 'nested', 'f.txt'))
    await sink.open()
    sink.write(Buffer.from('x'))
    await sink.commit()
    expect(await fs.readFile(path.join(dir, 'deep', 'nested', 'f.txt'), 'utf8')).toBe('x')
  })

  it('覆盖已有文件（rename 覆盖语义）', async () => {
    await fs.writeFile(path.join(dir, 'f.txt'), 'old')
    const sink = new AtomicSink(path.join(dir, 'f.txt'))
    await sink.open()
    sink.write(Buffer.from('new'))
    await sink.commit()
    expect(await fs.readFile(path.join(dir, 'f.txt'), 'utf8')).toBe('new')
  })

  it('abort 清理 .part 且不产生目标文件', async () => {
    const sink = new AtomicSink(path.join(dir, 'g.txt'))
    await sink.open()
    sink.write(Buffer.from('partial'))
    await sink.abort()
    await expect(fs.access(path.join(dir, 'g.txt'))).rejects.toThrow()
    await expect(fs.access(path.join(dir, 'g.txt.part'))).rejects.toThrow()
  })
})
```

- [ ] **Step 3.2: 运行测试确认失败**

Run: `npx vitest run tests/unit/storage.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3.3: 实现 `src/main/storage.ts`**

```ts
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { FileEntry } from './network/protocol'
import { sanitizePath } from './network/protocol'

export function defaultSaveDir(): string {
  return path.join(os.homedir(), 'LocalShare')
}

// 冲突检测：任一条目的目标路径已存在即为冲突
export async function detectConflicts(entries: FileEntry[], dir: string): Promise<boolean> {
  for (const e of entries) {
    const safe = sanitizePath(e.path)
    if (!safe) continue // 防御：非法路径由接收方在更早阶段拒绝
    const target = path.join(dir, safe)
    try {
      await fs.access(target)
      return true
    } catch {
      // 不存在，继续
    }
  }
  return false
}

// 原子落盘：写 .part → commit 时 rename 到目标（覆盖语义由 rename 提供）
export class AtomicSink {
  private readonly partPath: string
  stream?: fs.WriteStream

  constructor(private readonly targetPath: string) {
    this.partPath = targetPath + '.part'
  }

  async open(): Promise<void> {
    await fs.mkdir(path.dirname(this.targetPath), { recursive: true })
    this.stream = fs.createWriteStream(this.partPath, { flags: 'w' })
  }

  write(chunk: Buffer): boolean {
    if (!this.stream) throw new Error('AtomicSink not open')
    return this.stream.write(chunk)
  }

  async commit(): Promise<void> {
    if (!this.stream) throw new Error('AtomicSink not open')
    await new Promise<void>((resolve, reject) => {
      const s = this.stream as fs.WriteStream
      s.on('error', reject)
      s.end(() => resolve())
    })
    await fs.rename(this.partPath, this.targetPath)
  }

  async abort(): Promise<void> {
    if (this.stream) this.stream.destroy()
    await fs.rm(this.partPath, { force: true })
  }
}
```

- [ ] **Step 3.4: 运行测试确认通过**

Run: `npx vitest run tests/unit/storage.test.ts`
Expected: 全部 PASS（Windows 上覆盖用例依赖 `fs.rename` 的 MoveFileExW 覆盖语义，如失败需在该平台复查）

- [ ] **Step 3.5: Commit**

```bash
git add src/main/storage.ts tests/unit/storage.test.ts
git commit -m "feat(storage): save dir, conflict detection, atomic .part writes"
```

---

## Task 4: Discovery（设备表纯逻辑 + UDP 发现服务）

**Files:**
- Create: `src/main/network/deviceTable.ts`
- Create: `src/main/network/discovery.ts`
- Create: `tests/unit/deviceTable.test.ts`
- Create: `tests/integration/discovery.test.ts`

- [ ] **Step 4.1: 写失败的单元测试 `tests/unit/deviceTable.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { applyPacket, reapDevices, type DeviceInfo } from '../src/main/network/deviceTable'
import type { HelloMessage, ByeMessage } from '../src/main/network/protocol'

const hello = (id: string, over: Partial<HelloMessage> = {}): HelloMessage => ({
  type: 'HELLO',
  deviceId: id,
  deviceName: 'dev',
  platform: 'darwin',
  version: '0.1.0',
  tcpPort: 45556,
  timestamp: 0,
  ...over
})

describe('applyPacket', () => {
  it('HELLO 新增设备并记录最后活跃时间与来源地址', () => {
    const devices = new Map<string, DeviceInfo>()
    const upd = applyPacket(devices, 'self', hello('peer-1'), 1000, '192.168.1.5')
    expect(upd?.kind).toBe('added')
    expect(devices.size).toBe(1)
    expect(devices.get('peer-1')?.lastSeen).toBe(1000)
    expect(devices.get('peer-1')?.host).toBe('192.168.1.5')
  })

  it('HELLO 更新已有设备（刷新名称与活跃时间）', () => {
    const devices = new Map<string, DeviceInfo>()
    applyPacket(devices, 'self', hello('peer-1'), 1000, '192.168.1.5')
    const upd = applyPacket(devices, 'self', hello('peer-1', { deviceName: 'new-name' }), 4000, '192.168.1.5')
    expect(upd?.kind).toBe('updated')
    expect(devices.get('peer-1')?.name).toBe('new-name')
    expect(devices.get('peer-1')?.lastSeen).toBe(4000)
  })

  it('忽略自己的 HELLO', () => {
    const devices = new Map<string, DeviceInfo>()
    applyPacket(devices, 'self', hello('self'), 1000, '127.0.0.1')
    expect(devices.size).toBe(0)
  })

  it('BYE 移除设备', () => {
    const devices = new Map<string, DeviceInfo>()
    applyPacket(devices, 'self', hello('peer-1'), 1000, '192.168.1.5')
    const bye: ByeMessage = { type: 'BYE', deviceId: 'peer-1' }
    expect(applyPacket(devices, 'self', bye, 2000, '192.168.1.5')?.kind).toBe('removed')
    expect(devices.size).toBe(0)
  })

  it('未知设备 BYE 无变化', () => {
    const devices = new Map<string, DeviceInfo>()
    const bye: ByeMessage = { type: 'BYE', deviceId: 'nobody' }
    expect(applyPacket(devices, 'self', bye, 1000, '127.0.0.1')).toBeNull()
  })

  it('非发现消息无变化', () => {
    const devices = new Map<string, DeviceInfo>()
    expect(applyPacket(devices, 'self', { type: 'ACCEPT', transferId: 'x' }, 1000, '127.0.0.1')).toBeNull()
  })
})

describe('reapDevices', () => {
  it('仅剔除超过超时阈值的设备', () => {
    const devices = new Map<string, DeviceInfo>()
    applyPacket(devices, 'self', hello('a'), 1000, '192.168.1.2')
    applyPacket(devices, 'self', hello('b'), 9000, '192.168.1.3')
    const removed = reapDevices(devices, 10000, 5000)
    expect(removed.map((d) => d.id)).toEqual(['a'])
    expect(devices.has('b')).toBe(true)
  })
})
```

- [ ] **Step 4.2: 实现 `src/main/network/deviceTable.ts`**

```ts
import type { Message } from './protocol'

export interface DeviceInfo {
  id: string
  name: string
  platform: string
  version: string
  host: string // 来自 UDP 报文源地址 rinfo.address
  tcpPort: number
  lastSeen: number
}

export type DeviceUpdate = { kind: 'added' | 'updated' | 'removed'; device: DeviceInfo }

// 应用一条发现消息到设备表，返回变更；无变更返回 null（纯函数，可单测）
export function applyPacket(
  devices: Map<string, DeviceInfo>,
  selfId: string,
  msg: Message,
  now: number,
  host: string
): DeviceUpdate | null {
  if (msg.type === 'HELLO') {
    if (msg.deviceId === selfId) return null
    const existing = devices.get(msg.deviceId)
    devices.set(msg.deviceId, {
      id: msg.deviceId,
      name: msg.deviceName,
      platform: msg.platform,
      version: msg.version,
      host,
      tcpPort: msg.tcpPort,
      lastSeen: now
    })
    return { kind: existing ? 'updated' : 'added', device: devices.get(msg.deviceId)! }
  }
  if (msg.type === 'BYE') {
    const existing = devices.get(msg.deviceId)
    if (!existing) return null
    devices.delete(msg.deviceId)
    return { kind: 'removed', device: existing }
  }
  return null
}

// 剔除超过超时阈值的设备，返回被移除列表
export function reapDevices(devices: Map<string, DeviceInfo>, now: number, timeoutMs: number): DeviceInfo[] {
  const removed: DeviceInfo[] = []
  for (const [id, device] of devices) {
    if (now - device.lastSeen > timeoutMs) {
      devices.delete(id)
      removed.push(device)
    }
  }
  return removed
}
```

- [ ] **Step 4.3: 运行单元测试确认通过**

Run: `npx vitest run tests/unit/deviceTable.test.ts`
Expected: 全部 PASS

- [ ] **Step 4.4: 写失败的集成测试 `tests/integration/discovery.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { DiscoveryService } from '../src/main/network/discovery'

// 测试专用端口，与生产默认 45555 隔离
const PORT = 45599

describe('DiscoveryService 集成（真实 UDP，回环）', () => {
  it('两个实例互发现对方', async () => {
    const a = new DiscoveryService({
      port: PORT, deviceId: 'a', deviceName: 'Alpha',
      platform: process.platform, version: '0.1.0', tcpPort: 40001,
      broadcastAddress: '127.0.0.1', helloIntervalMs: 100
    })
    const b = new DiscoveryService({
      port: PORT, deviceId: 'b', deviceName: 'Beta',
      platform: process.platform, version: '0.1.0', tcpPort: 40002,
      broadcastAddress: '127.0.0.1', helloIntervalMs: 100
    })
    a.start()
    b.start()
    try {
      await new Promise((r) => setTimeout(r, 500))
      expect(b.getDevices().map((d) => d.name)).toContain('Alpha')
      expect(a.getDevices().map((d) => d.name)).toContain('Beta')
    } finally {
      a.stop()
      b.stop()
    }
  })
})
```

注：该用例依赖 `reuseAddr` 多 socket 绑定同一端口的能力，macOS/Linux 通过；Windows 上若失败，执行时改用辅助单播通道（见 Task 4 备注）。

- [ ] **Step 4.5: 运行集成测试确认失败**

Run: `npx vitest run tests/integration/discovery.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 4.6: 实现 `src/main/network/discovery.ts`**

```ts
import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import { encodeFrame, decodeFrame, MAX_DISCOVERY_LENGTH, type Message } from './protocol'
import { applyPacket, reapDevices, type DeviceInfo, type DeviceUpdate } from './deviceTable'

export const HELLO_INTERVAL_MS = 3000
export const OFFLINE_TIMEOUT_MS = 12000

export interface DiscoveryOptions {
  port: number
  deviceId: string
  deviceName: string
  platform: string
  version: string
  tcpPort: number
  broadcastAddress?: string
  helloIntervalMs?: number
  offlineTimeoutMs?: number
}

export class DiscoveryService extends EventEmitter {
  private socket: dgram.Socket | null = null
  private readonly devices = new Map<string, DeviceInfo>()
  private helloInterval: NodeJS.Timeout | null = null
  private reapInterval: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly opts: DiscoveryOptions) {}

  getDevices(): DeviceInfo[] {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  start(): void {
    if (this.running) return
    this.running = true
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('message', (msg, rinfo) => {
      try {
        const parsed = decodeFrame(msg) as Message
        const upd: DeviceUpdate | null = applyPacket(this.devices, this.opts.deviceId, parsed, Date.now(), rinfo.address)
        if (upd) this.emit('deviceChange', upd)
      } catch {
        // 非本协议报文（magic 不符 / JSON 非法）：静默忽略
      }
    })
    socket.on('error', (err) => {
      // 端口被占等启动错误：上报，由主进程报错退出（规格 4.2）
      this.emit('error', err)
    })
    socket.bind(this.opts.port, () => {
      socket.setBroadcast(true)
      this.sendHello()
      const interval = this.opts.helloIntervalMs ?? HELLO_INTERVAL_MS
      this.helloInterval = setInterval(() => this.sendHello(), interval)
      this.reapInterval = setInterval(() => this.reap(), interval)
    })
  }

  sendHello(): void {
    this.broadcast({
      type: 'HELLO',
      deviceId: this.opts.deviceId,
      deviceName: this.opts.deviceName,
      platform: this.opts.platform,
      version: this.opts.version,
      tcpPort: this.opts.tcpPort,
      timestamp: Date.now()
    })
  }

  sendBye(): void {
    this.broadcast({ type: 'BYE', deviceId: this.opts.deviceId })
  }

  private broadcast(msg: Message): void {
    if (!this.socket || !this.running) return
    let frame: Buffer
    try {
      frame = encodeFrame(msg, MAX_DISCOVERY_LENGTH)
    } catch {
      return
    }
    const address = this.opts.broadcastAddress ?? '255.255.255.255'
    this.socket.send(frame, this.opts.port, address)
  }

  private reap(): void {
    const removed = reapDevices(this.devices, Date.now(), this.opts.offlineTimeoutMs ?? OFFLINE_TIMEOUT_MS)
    for (const device of removed) this.emit('deviceChange', { kind: 'removed', device })
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.sendBye()
    if (this.helloInterval) clearInterval(this.helloInterval)
    if (this.reapInterval) clearInterval(this.reapInterval)
    this.helloInterval = null
    this.reapInterval = null
    this.socket?.close()
    this.socket = null
    this.devices.clear()
  }
}
```

- [ ] **Step 4.7: 运行集成测试确认通过**

Run: `npx vitest run tests/integration/discovery.test.ts`
Expected: 全部 PASS

- [ ] **Step 4.8: Commit**

```bash
git add src/main/network/deviceTable.ts src/main/network/discovery.ts tests/unit/deviceTable.test.ts tests/integration/discovery.test.ts
git commit -m "feat(discovery): UDP broadcast HELLO/BYE with device table (self-built, no deps)"
```

---

## Task 5: Transfer 发送方（Sender）

**Files:**
- Create: `src/main/network/sender.ts`

> 说明：Sender 与 Receiver（Task 6）互为对端，运行时验证在 Task 6 的集成测试中统一进行（对端必须同时存在才能跑通完整流程）。本任务验证手段为 `npm run typecheck` 通过；Task 6 末尾跑全部传输集成测试。

- [ ] **Step 5.1: 实现 `src/main/network/sender.ts`**

```ts
import net from 'node:net'
import { createReadStream } from 'node:fs'
import { EventEmitter } from 'node:events'
import { encodeFrame, FrameParser, type Message } from './protocol'
import type { WalkEntry } from './tree'

export interface TransferProgress {
  transferId: string
  fileName: string
  fileBytes: number
  fileSize: number
  totalBytes: number
  done: boolean
}

const OFFER_TIMEOUT_MS = 60_000

function onceConnect(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
}

function waitFor(em: EventEmitter, event: string, timeoutMs: number, timeoutMsg: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMsg)), timeoutMs)
    em.once(event, (v) => {
      clearTimeout(timer)
      resolve(v)
    })
    em.once('failed', (info: { reason: string }) => {
      clearTimeout(timer)
      reject(new Error(info.reason))
    })
  })
}

function pipeFile(socket: net.Socket, absPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(absPath)
    stream.on('error', reject)
    socket.on('error', reject)
    stream.on('data', (chunk: Buffer) => {
      if (!socket.write(chunk)) stream.pause()
    })
    socket.on('drain', () => stream.resume())
    stream.on('end', resolve)
  })
}

export class Sender extends EventEmitter {
  private socket: net.Socket | null = null
  private parser = new FrameParser()
  private transferId: string | null = null

  constructor(private readonly opts: { senderId: string; senderName: string }) {}

  // 发起一次传输：OFFER → ACCEPT → 逐文件 → TRANSFER_DONE → TRANSFER_ACK
  // entries 由 walkPaths 产出（WalkEntry：relPath 发协议，absPath 读文件）
  // 事件：'progress' (TransferProgress) / 'complete' ({transferId}) / 'failed' ({transferId, reason})
  async start(
    target: { host: string; port: number },
    transferId: string,
    entries: WalkEntry[],
    totalBytes: number
  ): Promise<void> {
    this.transferId = transferId
    const socket = net.createConnection(target)
    this.socket = socket
    socket.setNoDelay(true)
    socket.on('data', (chunk) => {
      try {
        for (const msg of this.parser.push(chunk)) this.onMessage(msg)
      } catch (err) {
        this.fail(err as Error)
      }
    })
    socket.on('error', (err) => this.fail(err))
    socket.on('close', () => {
      if (this.transferId) this.fail(new Error('connection closed'))
    })

    try {
      await onceConnect(socket)

      socket.write(
        encodeFrame({
          type: 'OFFER',
          transferId,
          senderId: this.opts.senderId,
          senderName: this.opts.senderName,
          fileCount: entries.length,
          totalBytes,
          files: entries.map((e) => ({ type: e.type, path: e.relPath, size: e.size }))
        })
      )

      const result = (await waitFor(this, 'offer-result', OFFER_TIMEOUT_MS, 'offer timeout: 对方无响应')) as {
        ok: boolean
        reason?: string
      }
      if (!result.ok) throw new Error(result.reason ?? 'rejected')

      let sent = 0
      for (const entry of entries) {
        if (entry.type === 'dir') continue // 空目录条目无需传输数据
        socket.write(encodeFrame({ type: 'FILE_HEADER', transferId, path: entry.relPath, size: entry.size }))
        if (entry.size > 0) await pipeFile(socket, entry.absPath)
        sent += entry.size
        this.emit('progress', {
          transferId,
          fileName: entry.relPath,
          fileBytes: entry.size,
          fileSize: entry.size,
          totalBytes: sent,
          done: false
        } satisfies TransferProgress)
        socket.write(encodeFrame({ type: 'FILE_DONE', transferId, path: entry.relPath, bytesWritten: entry.size }))
      }

      socket.write(encodeFrame({ type: 'TRANSFER_DONE', transferId }))
      await waitFor(this, 'transfer-ack', OFFER_TIMEOUT_MS, 'ack timeout')
      this.emit('complete', { transferId })
      socket.end()
      this.transferId = null
    } catch (err) {
      this.fail(err as Error)
      throw err
    }
  }

  cancel(reason = 'user_cancelled'): void {
    if (!this.socket || !this.transferId) return
    this.socket.write(encodeFrame({ type: 'CANCEL', transferId: this.transferId, reason }))
    this.fail(new Error('cancelled'))
  }

  private onMessage(msg: Message): void {
    if (msg.transferId !== this.transferId) return
    if (msg.type === 'ACCEPT') {
      this.emit('offer-result', { ok: true })
    } else if (msg.type === 'REJECT') {
      this.emit('offer-result', { ok: false, reason: msg.reason })
    } else if (msg.type === 'CANCEL') {
      this.fail(new Error('cancelled by peer: ' + msg.reason))
    } else if (msg.type === 'ERROR') {
      this.fail(new Error(`${msg.code}: ${msg.message}`))
    } else if (msg.type === 'TRANSFER_ACK') {
      this.emit('transfer-ack')
    }
  }

  private fail(err: Error): void {
    if (!this.transferId && this.socket === null) return
    const id = this.transferId
    this.transferId = null
    this.socket?.destroy()
    this.socket = null
    this.emit('failed', { transferId: id, reason: err.message })
  }
}
```

- [ ] **Step 5.2: 验证类型检查**

Run: `npm run typecheck`
Expected: 无错误输出，exit 0

- [ ] **Step 5.3: Commit**

```bash
git add src/main/network/sender.ts
git commit -m "feat(sender): TCP transfer sender (OFFER/ACCEPT/files/DONE/ACK)"
```

---

## Task 6: Transfer 接收方（Receiver）+ 端到端集成测试

**Files:**
- Create: `src/main/network/receiver.ts`
- Create: `tests/integration/transfer.test.ts`

- [ ] **Step 6.1: 实现 `src/main/network/receiver.ts`**

```ts
import net from 'node:net'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import {
  encodeFrame,
  FrameParser,
  sanitizePath,
  type Message,
  type OfferMessage,
  type FileHeaderMessage,
  type FileDoneMessage
} from './protocol'
import { AtomicSink, detectConflicts } from '../storage'

export interface OfferSummary {
  transferId: string
  senderId: string
  senderName: string
  fileCount: number
  totalBytes: number
  files: { type: 'file' | 'dir'; path: string; size: number }[]
  conflicts: boolean
}

export interface ReceiveProgress {
  transferId: string
  fileName: string
  totalBytes: number
}

type SessionCallbacks = {
  onOffer: (offer: OfferSummary) => void
  onProgress: (p: ReceiveProgress) => void
  onComplete: (transferId: string) => void
  onError: (transferId: string, err: Error) => void
}

export class Receiver extends EventEmitter {
  private server: net.Server | null = null
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly opts: { port: number; saveDir: () => string }) {}

  // 事件：'listening' / 'offer' (OfferSummary) / 'progress' / 'complete' / 'transferError' / 'error'
  start(): void {
    if (this.server) return
    const server = net.createServer((socket) => {
      const session = new Session(socket, this.opts.saveDir(), {
        onOffer: (offer) => {
          this.sessions.delete('pending')
          this.sessions.set(offer.transferId, session)
          this.emit('offer', offer)
        },
        onProgress: (p) => this.emit('progress', p),
        onComplete: (id) => this.emit('complete', id),
        onError: (id, err) => this.emit('transferError', { transferId: id, error: err })
      })
      this.sessions.set('pending', session)
      session.on('closed', () => this.sessions.delete(session.transferId))
    })
    server.on('error', (err) => this.emit('error', err))
    server.listen(this.opts.port, () => this.emit('listening'))
    this.server = server
  }

  stop(cb?: () => void): void {
    this.server?.close(() => {
      this.server = null
      cb?.()
    })
    this.sessions.clear()
  }

  // UI 决策入口（经 IPC 调用）：accept（可带本次目标目录）/ reject
  respond(transferId: string, decision: 'accept' | 'reject', targetDir?: string): void {
    const session = this.sessions.get(transferId)
    if (!session) return
    if (decision === 'reject') session.reject('user_declined')
    else void session.accept(targetDir)
  }
}

class Session extends EventEmitter {
  transferId = 'pending'
  private state: 'CTRL' | 'DATA' = 'CTRL'
  private parser = new FrameParser()
  private current: { header: FileHeaderMessage; sink: AtomicSink; written: number } | null = null
  private targetDir: string | null = null
  private closed = false

  constructor(
    private readonly socket: net.Socket,
    private readonly defaultDir: string,
    private readonly ev: SessionCallbacks
  ) {
    super()
    socket.setNoDelay(true)
    socket.on('data', (chunk) => {
      try {
        this.onData(chunk)
      } catch (err) {
        this.fail(err as Error)
      }
    })
    socket.on('error', (err) => this.fail(err))
    socket.on('close', () => {
      this.closed = true
      this.cleanup()
      this.emit('closed')
    })
  }

  private onData(chunk: Buffer): void {
    if (this.state === 'CTRL') {
      for (const msg of this.parser.push(chunk)) void this.onMessage(msg)
      return
    }
    const cur = this.current!
    const need = cur.header.size - cur.written
    if (chunk.length <= need) {
      cur.sink.write(chunk)
      cur.written += chunk.length
      if (cur.written === cur.header.size) this.state = 'CTRL'
      return
    }
    cur.sink.write(chunk.subarray(0, need))
    cur.written = cur.header.size
    this.state = 'CTRL'
    this.onData(chunk.subarray(need))
  }

  private async onMessage(msg: Message): Promise<void> {
    switch (msg.type) {
      case 'OFFER':
        await this.onOffer(msg)
        break
      case 'FILE_HEADER':
        await this.onFileHeader(msg)
        break
      case 'FILE_DONE':
        await this.onFileDone(msg)
        break
      case 'TRANSFER_DONE':
        await this.onTransferDone(msg)
        break
      case 'CANCEL':
        this.fail(new Error('cancelled by peer: ' + msg.reason))
        break
      case 'ERROR':
        this.fail(new Error(`${msg.code}: ${msg.message}`))
        break
      default:
        break
    }
  }

  private async onOffer(msg: OfferMessage): Promise<void> {
    // 先对全部路径做清洗校验，任何一条非法即协议错误断开（规格 5.6）
    const files: OfferSummary['files'] = []
    for (const e of msg.files) {
      const safe = sanitizePath(e.path)
      if (!safe) throw new Error('protocol error: unsafe path ' + e.path)
      files.push({ type: e.type, path: safe, size: e.size ?? 0 })
    }
    this.transferId = msg.transferId
    this.parser = new FrameParser()
    this.ev.onOffer({
      transferId: msg.transferId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      fileCount: msg.fileCount,
      totalBytes: msg.totalBytes,
      files,
      conflicts: await detectConflicts(files.map((f) => ({ type: f.type, path: f.path })), this.defaultDir)
    })
  }

  async accept(targetDir?: string): Promise<void> {
    this.targetDir = targetDir ?? this.defaultDir
    if (!this.closed) this.socket.write(encodeFrame({ type: 'ACCEPT', transferId: this.transferId }))
  }

  reject(reason: string): void {
    if (!this.closed) this.socket.write(encodeFrame({ type: 'REJECT', transferId: this.transferId, reason }))
    this.socket.end()
    this.cleanup()
  }

  private async onFileHeader(msg: FileHeaderMessage): Promise<void> {
    const safe = sanitizePath(msg.path)
    if (!safe) throw new Error('protocol error: unsafe path ' + msg.path)
    const target = path.join(this.targetDir ?? this.defaultDir, safe)
    const sink = new AtomicSink(target)
    await sink.open()
    this.current = { header: { ...msg, path: safe }, sink, written: 0 }
    if (msg.size > 0) this.state = 'DATA'
  }

  private async onFileDone(msg: FileDoneMessage): Promise<void> {
    if (!this.current || this.current.header.path !== msg.path) {
      throw new Error('protocol error: FILE_DONE without matching file')
    }
    if (msg.bytesWritten !== this.current.header.size) {
      throw new Error(`protocol error: bytesWritten ${msg.bytesWritten} != size ${this.current.header.size}`)
    }
    const cur = this.current
    this.current = null
    await cur.sink.commit()
    this.ev.onProgress({ transferId: this.transferId, fileName: msg.path, totalBytes: cur.header.size })
  }

  private async onTransferDone(_msg: Message): Promise<void> {
    this.socket.write(encodeFrame({ type: 'TRANSFER_ACK', transferId: this.transferId }))
    this.ev.onComplete(this.transferId)
    this.socket.end()
    this.cleanup()
  }

  private cleanup(): void {
    if (this.current) {
      void this.current.sink.abort()
      this.current = null
    }
    this.state = 'CTRL'
  }

  private fail(err: Error): void {
    if (this.closed) return
    this.ev.onError(this.transferId, err)
    this.socket.destroy()
    this.cleanup()
  }
}
```

- [ ] **Step 6.2: 写集成测试 `tests/integration/transfer.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Sender } from '../src/main/network/sender'
import { Receiver, type OfferSummary } from '../src/main/network/receiver'
import type { WalkEntry } from '../src/main/network/tree'

const TCP_PORT = 45600

let root: string
let recvDir: string
let receiver: Receiver | null

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'localshare-xfer-'))
  recvDir = path.join(root, 'recv')
  await fs.mkdir(recvDir)
  receiver = null
})

afterEach(async () => {
  if (receiver) {
    await new Promise<void>((resolve) => receiver!.stop(resolve))
  }
  await fs.rm(root, { recursive: true, force: true })
})

const waitOffer = (r: Receiver): Promise<OfferSummary> =>
  new Promise((resolve) => r.once('offer', resolve))

const startReceiver = async (): Promise<Receiver> => {
  const r = new Receiver({ port: TCP_PORT, saveDir: () => recvDir })
  receiver = r
  r.start()
  await new Promise<void>((res) => r.once('listening', res))
  return r
}

describe('端到端传输（回环 TCP）', () => {
  it('单文件全流程：内容一致落盘', async () => {
    const srcFile = path.join(root, 'a.txt')
    await fs.writeFile(srcFile, 'hello localshare')
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const completeP = new Promise<void>((resolve, reject) => {
      sender.once('complete', () => resolve())
      sender.once('failed', (i: { reason: string }) => reject(new Error(i.reason)))
    })
    const sendP = sender.start(
      { host: '127.0.0.1', port: TCP_PORT },
      't-1',
      [{ relPath: 'a.txt', absPath: srcFile, type: 'file', size: 16 }],
      16
    )
    const offer = await offerP
    expect(offer.files).toEqual([{ type: 'file', path: 'a.txt', size: 16 }])
    expect(offer.conflicts).toBe(false)
    r.respond(offer.transferId, 'accept')
    await sendP
    await completeP
    expect(await fs.readFile(path.join(recvDir, 'a.txt'), 'utf8')).toBe('hello localshare')
  })

  it('多文件 + 目录结构 + 空目录全部落盘', async () => {
    await fs.writeFile(path.join(root, 'top.txt'), 'top')
    await fs.mkdir(path.join(root, 'sub', 'empty'), { recursive: true })
    await fs.writeFile(path.join(root, 'sub', 'b.txt'), 'b-content')
    const entries: WalkEntry[] = [
      { relPath: 'top.txt', absPath: path.join(root, 'top.txt'), type: 'file', size: 3 },
      { relPath: 'sub/empty/', absPath: '', type: 'dir', size: 0 },
      { relPath: 'sub/b.txt', absPath: path.join(root, 'sub', 'b.txt'), type: 'file', size: 9 }
    ]
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-2', entries, 12)
    const offer = await offerP
    r.respond(offer.transferId, 'accept')
    await sendP
    expect(await fs.readFile(path.join(recvDir, 'top.txt'), 'utf8')).toBe('top')
    expect(await fs.readFile(path.join(recvDir, 'sub', 'b.txt'), 'utf8')).toBe('b-content')
    expect((await fs.stat(path.join(recvDir, 'sub', 'empty'))).isDirectory()).toBe(true)
  })

  it('零字节文件正常落盘', async () => {
    const srcFile = path.join(root, 'empty.bin')
    await fs.writeFile(srcFile, Buffer.alloc(0))
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-3', [{ relPath: 'empty.bin', absPath: srcFile, type: 'file', size: 0 }], 0)
    const offer = await offerP
    r.respond(offer.transferId, 'accept')
    await sendP
    expect((await fs.stat(path.join(recvDir, 'empty.bin'))).size).toBe(0)
  })

  it('接收方拒绝：发送方报错且不落盘', async () => {
    const srcFile = path.join(root, 'x.txt')
    await fs.writeFile(srcFile, 'data')
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-4', [{ relPath: 'x.txt', absPath: srcFile, type: 'file', size: 4 }], 4)
    const offer = await offerP
    r.respond(offer.transferId, 'reject')
    await expect(sendP).rejects.toThrow(/rejected/)
    await expect(fs.access(path.join(recvDir, 'x.txt'))).rejects.toThrow()
  })

  it('冲突检测：目标已存在时 offer.conflicts 为 true，覆盖生效', async () => {
    await fs.writeFile(path.join(recvDir, 'a.txt'), 'old')
    const srcFile = path.join(root, 'a.txt')
    await fs.writeFile(srcFile, 'new')
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-5', [{ relPath: 'a.txt', absPath: srcFile, type: 'file', size: 3 }], 3)
    const offer = await offerP
    expect(offer.conflicts).toBe(true)
    r.respond(offer.transferId, 'accept')
    await sendP
    expect(await fs.readFile(path.join(recvDir, 'a.txt'), 'utf8')).toBe('new')
  })

  it('指定目标目录（换位置）：写入所选目录', async () => {
    const srcFile = path.join(root, 'a.txt')
    await fs.writeFile(srcFile, 'elsewhere')
    const altDir = path.join(root, 'alt')
    await fs.mkdir(altDir)
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-6', [{ relPath: 'a.txt', absPath: srcFile, type: 'file', size: 9 }], 9)
    const offer = await offerP
    r.respond(offer.transferId, 'accept', altDir)
    await sendP
    expect(await fs.readFile(path.join(altDir, 'a.txt'), 'utf8')).toBe('elsewhere')
  })

  it('传输中断：接收方清理 .part 不残留', async () => {
    const srcFile = path.join(root, 'big.bin')
    await fs.writeFile(srcFile, Buffer.alloc(1024 * 1024, 7))
    const r = await startReceiver()
    const offerP = waitOffer(r)
    const sender = new Sender({ senderId: 'me', senderName: 'Me' })
    const sendP = sender.start({ host: '127.0.0.1', port: TCP_PORT }, 't-7', [{ relPath: 'big.bin', absPath: srcFile, type: 'file', size: 1024 * 1024 }], 1024 * 1024)
    const offer = await offerP
    r.respond(offer.transferId, 'accept')
    // 数据到达前立刻断开接收方，模拟中断
    setTimeout(() => r.stop(), 50)
    await expect(sendP).rejects.toThrow()
    await new Promise((res) => setTimeout(res, 200))
    await expect(fs.access(path.join(recvDir, 'big.bin.part'))).rejects.toThrow()
  })
})
```

- [ ] **Step 6.3: 运行集成测试确认失败**

Run: `npx vitest run tests/integration/transfer.test.ts`
Expected: FAIL，模块不存在（`../src/main/network/receiver`）

- [ ] **Step 6.4: 运行集成测试确认通过**

Run: `npx vitest run tests/integration/transfer.test.ts`
Expected: 全部 PASS（7 个用例）

- [ ] **Step 6.5: 全量测试 + 类型检查**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS；typecheck 无错误

- [ ] **Step 6.6: Commit**

```bash
git add src/main/network/receiver.ts tests/integration/transfer.test.ts
git commit -m "feat(receiver): TCP transfer receiver with CTRL/DATA state machine, conflict detection"
```

---

## Task 7: 配置持久化 + IPC 桥 + 主进程组装

**Files:**
- Create: `src/main/config.ts`
- Create: `src/preload/index.ts`（覆盖 Task 0 最小版）
- Modify: `src/main/index.ts`（覆盖 Task 0 最小版，组装全部服务）
- Create: `src/renderer/src/api.d.ts`

> 规格偏差执行：设计文档 8.1 的 `electron-store` 改为手写 JSON（`config.ts`），理由见计划头部"规格偏差说明"。config 为薄封装，不做单测（主进程集成验证覆盖）。

- [ ] **Step 7.1: 实现 `src/main/config.ts`**

```ts
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { app } from 'electron'

export interface AppConfig {
  deviceId: string
  deviceName: string
  udpPort: number
  tcpPort: number
  saveDir: string
}

let cached: AppConfig | null = null

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

function load(): AppConfig {
  const def: AppConfig = {
    deviceId: randomUUID(),
    deviceName: os.hostname(),
    udpPort: 45555,
    tcpPort: 45556,
    saveDir: path.join(os.homedir(), 'LocalShare')
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<AppConfig>
    return { ...def, ...raw }
  } catch {
    // 首次运行：生成默认配置并持久化
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(def, null, 2), 'utf8')
    return def
  }
}

export function getConfig(): AppConfig {
  if (!cached) cached = load()
  return cached
}

export async function updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const next: AppConfig = { ...getConfig(), ...patch }
  await fs.mkdir(path.dirname(configPath()), { recursive: true })
  await fs.writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8')
  cached = next
  return next
}
```

- [ ] **Step 7.2: 实现完整 preload `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppConfig } from '../main/config'
import type { DeviceInfo, DeviceUpdate } from '../main/network/deviceTable'
import type { OfferSummary, ReceiveProgress } from '../main/network/receiver'
import type { TransferProgress } from '../main/network/sender'

export interface TransferUpdate {
  kind: 'progress' | 'complete' | 'failed' | 'error' | 'receive-progress'
  transferId: string
  fileName?: string
  totalBytes?: number
  reason?: string
}

export interface Api {
  ping: () => Promise<string>
  getConfig: () => Promise<AppConfig>
  updateConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>
  getDevices: () => Promise<DeviceInfo[]>
  onDeviceChange: (cb: (upd: DeviceUpdate) => void) => () => void
  pickPaths: () => Promise<string[]>
  pickDirectory: () => Promise<string | null>
  sendTransfer: (deviceId: string, paths: string[]) => Promise<{ transferId: string }>
  cancelTransfer: (transferId: string) => void
  onTransferUpdate: (cb: (u: TransferUpdate) => void) => () => void
  onOffer: (cb: (offer: OfferSummary) => void) => () => void
  respondTransfer: (transferId: string, decision: 'accept' | 'reject', targetDir?: string) => void
  getPathForFile: (file: File) => string
}

const api: Api = {
  ping: () => ipcRenderer.invoke('ping'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),
  getDevices: () => ipcRenderer.invoke('devices:list'),
  onDeviceChange: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, upd: DeviceUpdate) => cb(upd)
    ipcRenderer.on('devices:changed', listener)
    return () => ipcRenderer.removeListener('devices:changed', listener)
  },
  pickPaths: () => ipcRenderer.invoke('dialog:pick-paths'),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  sendTransfer: (deviceId, paths) => ipcRenderer.invoke('transfer:send', deviceId, paths),
  cancelTransfer: (transferId) => ipcRenderer.send('transfer:cancel', transferId),
  onTransferUpdate: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, u: TransferUpdate) => cb(u)
    ipcRenderer.on('transfer:update', listener)
    return () => ipcRenderer.removeListener('transfer:update', listener)
  },
  onOffer: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, offer: OfferSummary) => cb(offer)
    ipcRenderer.on('transfer:offer', listener)
    return () => ipcRenderer.removeListener('transfer:offer', listener)
  },
  respondTransfer: (transferId, decision, targetDir) =>
    ipcRenderer.send('transfer:respond', transferId, decision, targetDir),
  getPathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('api', api)
```

- [ ] **Step 7.3: 重写主进程入口 `src/main/index.ts`（服务组装 + IPC）**

```ts
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { getConfig, updateConfig } from './config'
import { DiscoveryService } from './network/discovery'
import { Receiver } from './network/receiver'
import { Sender } from './network/sender'
import { walkPaths } from './network/tree'
import type { OfferSummary } from './network/receiver'

let win: BrowserWindow | null = null
let discovery: DiscoveryService | null = null
let receiver: Receiver | null = null
const senders = new Map<string, Sender>()

function createWindow(): void {
  win = new BrowserWindow({
    width: 900,
    height: 640,
    title: 'LocalShare',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  win.on('closed', () => {
    win = null
  })
}

// 端口被占：报错退出（规格 4.2）
function fatalPort(kind: string, port: number, err: Error): void {
  dialog.showErrorBox(
    'LocalShare 启动失败',
    `${kind}端口 ${port} 无法监听：${err.message}\n\n请在设置中修改端口后重试。`
  )
  app.exit(1)
}

function startServices(): void {
  const cfg = getConfig()

  discovery = new DiscoveryService({
    port: cfg.udpPort,
    deviceId: cfg.deviceId,
    deviceName: cfg.deviceName,
    platform: os.platform(),
    version: app.getVersion(),
    tcpPort: cfg.tcpPort
  })
  discovery.on('deviceChange', (upd) => win?.webContents.send('devices:changed', upd))
  discovery.on('error', (err) => fatalPort('UDP 发现', cfg.udpPort, err))
  discovery.start()

  receiver = new Receiver({ port: cfg.tcpPort, saveDir: () => getConfig().saveDir })
  receiver.on('error', (err) => fatalPort('TCP 传输', cfg.tcpPort, err))
  receiver.on('offer', (offer: OfferSummary) => win?.webContents.send('transfer:offer', offer))
  receiver.on('progress', (p) =>
    win?.webContents.send('transfer:update', { kind: 'receive-progress', ...p } satisfies object)
  )
  receiver.on('complete', (id) => win?.webContents.send('transfer:update', { kind: 'complete', transferId: id }))
  receiver.on('transferError', (e: { transferId: string; error: Error }) =>
    win?.webContents.send('transfer:update', { kind: 'error', transferId: e.transferId, reason: e.error.message })
  )
  receiver.start()
}

function registerIpc(): void {
  ipcMain.handle('ping', () => 'pong')
  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:update', (_e, patch: Partial<AppConfig>) => updateConfig(patch))

  ipcMain.handle('devices:list', () => discovery?.getDevices() ?? [])

  ipcMain.handle('dialog:pick-paths', async () => {
    if (!win) return []
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'openDirectory', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('dialog:pick-directory', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('transfer:send', async (_e, deviceId: string, paths: string[]) => {
    const device = discovery?.getDevices().find((d) => d.id === deviceId)
    if (!device) throw new Error('设备不在线')
    const { entries, totalBytes } = await walkPaths(paths)
    if (entries.length === 0) throw new Error('没有可发送的内容（空选择或仅符号链接）')
    const transferId = randomUUID()
    const sender = new Sender({ senderId: getConfig().deviceId, senderName: getConfig().deviceName })
    senders.set(transferId, sender)
    sender.on('progress', (p) => win?.webContents.send('transfer:update', { kind: 'progress', ...p }))
    sender.on('complete', (c) => {
      win?.webContents.send('transfer:update', { kind: 'complete', ...c })
      senders.delete(transferId)
    })
    sender.on('failed', (f) => {
      win?.webContents.send('transfer:update', { kind: 'failed', ...f })
      senders.delete(transferId)
    })
    void sender.start({ host: device.host, port: device.tcpPort }, transferId, entries, totalBytes).catch(() => {
      // 失败已通过 'failed' 事件上报 UI，这里仅吞掉未捕获的 rejection
    })
    return { transferId }
  })

  ipcMain.on('transfer:cancel', (_e, transferId: string) => {
    senders.get(transferId)?.cancel()
  })

  ipcMain.on('transfer:respond', (_e, transferId: string, decision: 'accept' | 'reject', targetDir?: string) => {
    receiver?.respond(transferId, decision, targetDir)
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  startServices()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  discovery?.stop()
  receiver?.stop()
})
```

- [ ] **Step 7.4: 创建渲染进程类型声明 `src/renderer/src/api.d.ts`**

```ts
import type { Api } from '../../preload'

declare global {
  interface Window {
    api: Api
  }
}

export {}
```

- [ ] **Step 7.5: 验证**

Run: `npm run typecheck`
Expected: 无错误（tsconfig.node.json 已包含 `src/main`、`src/preload`；tsconfig.web.json 含渲染进程）

Run: `npm run dev`
Expected: 窗口出现并显示 "LocalShare"；控制台无报错（服务已随窗口启动；UDP/TCP 监听成功）。若端口被占用，弹出错误框说明（符合端口策略）。手动 Ctrl+C 退出。

- [ ] **Step 7.6: Commit**

```bash
git add src/main/config.ts src/main/index.ts src/preload/index.ts src/renderer/src/api.d.ts
git commit -m "feat(main): config persistence, IPC bridge, service assembly with port-fatal policy"
```

---

## Task 8: Vue 3 UI（设备列表、拖放区、传输队列、确认对话框）

**Files:**
- Modify: `src/preload/index.ts`（sendTransfer 支持手动直连目标）
- Modify: `src/main/index.ts`（transfer:send 处理手动目标）
- Create: `src/renderer/src/stores/device.ts`
- Create: `src/renderer/src/stores/transfer.ts`
- Create: `src/renderer/src/components/DeviceList.vue`
- Create: `src/renderer/src/components/DropZone.vue`
- Create: `src/renderer/src/components/TransferList.vue`
- Create: `src/renderer/src/components/TransferConfirmDialog.vue`
- Modify: `src/renderer/src/App.vue`

> 手动直连（设计 4.1 的兜底）需要传输目标既支持"设备 ID"也支持"IP:端口"。Step 8.1 先改 IPC 面，UI 层随后使用。

- [ ] **Step 8.1: 修改 IPC 面支持手动直连目标**

`src/preload/index.ts` 中，将 `sendTransfer` 类型与实现替换为：

```ts
export type TransferTarget = { deviceId: string } | { host: string; port: number }
```

```ts
  sendTransfer: (target: TransferTarget, paths: string[]) =>
    ipcRenderer.invoke('transfer:send', target, paths),
```

（`Api` 接口中 `sendTransfer: (deviceId: string, paths: string[]) => ...` 同步改为 `(target: TransferTarget, paths: string[]) => ...`）

`src/main/index.ts` 中，将 `transfer:send` handler 替换为：

```ts
  ipcMain.handle('transfer:send', async (_e, target: TransferTarget, paths: string[]) => {
    let host: string
    let port: number
    if ('deviceId' in target) {
      const device = discovery?.getDevices().find((d) => d.id === target.deviceId)
      if (!device) throw new Error('设备不在线')
      host = device.host
      port = device.tcpPort
    } else {
      host = target.host
      port = target.port
    }
    const { entries, totalBytes } = await walkPaths(paths)
    if (entries.length === 0) throw new Error('没有可发送的内容（空选择或仅符号链接）')
    const transferId = randomUUID()
    const sender = new Sender({ senderId: getConfig().deviceId, senderName: getConfig().deviceName })
    senders.set(transferId, sender)
    sender.on('progress', (p) => win?.webContents.send('transfer:update', { kind: 'progress', ...p }))
    sender.on('complete', (c) => {
      win?.webContents.send('transfer:update', { kind: 'complete', ...c })
      senders.delete(transferId)
    })
    sender.on('failed', (f) => {
      win?.webContents.send('transfer:update', { kind: 'failed', ...f })
      senders.delete(transferId)
    })
    void sender.start({ host, port }, transferId, entries, totalBytes).catch(() => {
      // 失败已通过 'failed' 事件上报 UI
    })
    return { transferId }
  })
```

`src/main/index.ts` 顶部新增类型导入：

```ts
import type { TransferTarget } from '../preload'
```

- [ ] **Step 8.2: 实现 `src/renderer/src/stores/device.ts`**

```ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DeviceInfo, DeviceUpdate } from '../../main/network/deviceTable'

export const useDeviceStore = defineStore('device', () => {
  const devices = ref<DeviceInfo[]>([])
  const target = ref<DeviceInfo | null>(null)
  const loading = ref(false)

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      devices.value = await window.api.getDevices()
    } finally {
      loading.value = false
    }
  }

  function applyUpdate(upd: DeviceUpdate): void {
    const list = devices.value
    if (upd.kind === 'removed') {
      devices.value = list.filter((d) => d.id !== upd.device.id)
      if (target.value?.id === upd.device.id) target.value = null
      return
    }
    const i = list.findIndex((d) => d.id === upd.device.id)
    if (i >= 0) list.splice(i, 1, upd.device)
    else list.push(upd.device)
  }

  return { devices, target, loading, refresh, applyUpdate }
})
```

- [ ] **Step 8.3: 实现 `src/renderer/src/stores/transfer.ts`**

```ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { OfferSummary } from '../../main/network/receiver'
import type { TransferUpdate } from '../../preload'

export interface TransferItem {
  transferId: string
  kind: 'outgoing' | 'incoming'
  name: string
  state: 'waiting-confirm' | 'transferring' | 'complete' | 'failed' | 'rejected'
  totalBytes: number
  doneBytes: number
  reason?: string
}

export const useTransferStore = defineStore('transfer', () => {
  const items = ref<TransferItem[]>([])
  const pendingOffer = ref<OfferSummary | null>(null)

  function pushOffer(offer: OfferSummary): void {
    items.value.unshift({
      transferId: offer.transferId,
      kind: 'incoming',
      name: offer.files.length === 1 ? offer.files[0].path : `${offer.fileCount} 项`,
      state: 'waiting-confirm',
      totalBytes: offer.totalBytes,
      doneBytes: 0
    })
    pendingOffer.value = offer
  }

  function applyUpdate(u: TransferUpdate): void {
    const item = items.value.find((i) => i.transferId === u.transferId)
    if (!item) return
    if (u.kind === 'progress') {
      item.state = 'transferring'
      item.doneBytes = u.totalBytes ?? item.doneBytes
    } else if (u.kind === 'receive-progress') {
      item.state = 'transferring'
      item.doneBytes += u.totalBytes ?? 0
    } else if (u.kind === 'complete') {
      item.state = 'complete'
      item.doneBytes = item.totalBytes
    } else if (u.kind === 'failed' || u.kind === 'error') {
      item.state = 'failed'
      item.reason = u.reason
    }
  }

  function clearOffer(): void {
    pendingOffer.value = null
  }

  return { items, pendingOffer, pushOffer, applyUpdate, clearOffer }
})
```

- [ ] **Step 8.4: 实现 `src/renderer/src/components/DeviceList.vue`**

```vue
<template>
  <div class="device-panel">
    <h3>在线设备</h3>
    <el-empty v-if="deviceStore.devices.length === 0" description="未发现设备" :image-size="60" />
    <div v-else class="device-items">
      <div
        v-for="d in deviceStore.devices"
        :key="d.id"
        class="device-item"
        :class="{ active: deviceStore.target?.id === d.id }"
        @click="deviceStore.target = d"
      >
        <span class="device-name">{{ d.name }}</span>
        <span class="device-meta">{{ d.host }}:{{ d.tcpPort }}</span>
      </div>
    </div>
    <el-divider />
    <div class="manual">
      <el-input v-model="manualIp" placeholder="IP 或 IP:端口 手动直连" size="small" @keyup.enter="connectManual" />
      <el-button size="small" @click="connectManual">连接</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useDeviceStore } from '../stores/device'
import type { DeviceInfo } from '../../main/network/deviceTable'

const deviceStore = useDeviceStore()
const manualIp = ref('')

async function connectManual(): Promise<void> {
  if (!manualIp.value.trim()) return
  const [host, portStr] = manualIp.value.split(':')
  const port = portStr ? Number(portStr) : (await window.api.getConfig()).tcpPort
  deviceStore.target = {
    id: 'manual-' + host + '-' + port,
    name: host,
    platform: 'unknown',
    version: 'manual',
    host,
    tcpPort: port,
    lastSeen: Date.now()
  } as DeviceInfo
}
</script>

<style scoped>
.device-panel { padding: 12px; }
.device-items { display: flex; flex-direction: column; gap: 8px; }
.device-item {
  padding: 8px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
}
.device-item.active { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.device-meta { color: var(--el-text-color-secondary); font-size: 12px; }
.manual { display: flex; gap: 6px; }
</style>
```

- [ ] **Step 8.5: 实现 `src/renderer/src/components/DropZone.vue`**

```vue
<template>
  <div class="drop-zone" @dragover.prevent="over = true" @dragleave="over = false" @drop.prevent="onDrop">
    <el-empty :image-size="80" description="拖拽文件/文件夹到此处，或点击选择" />
    <el-button type="primary" @click="pick">选择文件/文件夹</el-button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useDeviceStore } from '../stores/device'

const over = ref(false)
const deviceStore = useDeviceStore()

async function onDrop(e: DragEvent): Promise<void> {
  over.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  const paths = files.map((f) => window.api.getPathForFile(f)).filter((p): p is string => Boolean(p))
  await send(paths)
}

async function pick(): Promise<void> {
  const paths = await window.api.pickPaths()
  if (paths.length > 0) await send(paths)
}

async function send(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  if (!deviceStore.target) {
    ElMessage.warning('请先在左侧选择目标设备（或手动输入 IP）')
    return
  }
  try {
    await window.api.sendTransfer(deviceStore.target, paths)
    ElMessage.success('已发起传输，等待对方确认')
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}
</script>

<style scoped>
.drop-zone {
  border: 2px dashed var(--el-border-color);
  border-radius: 8px;
  padding: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.drop-zone:hover { border-color: var(--el-color-primary); }
</style>
```

- [ ] **Step 8.6: 实现 `src/renderer/src/components/TransferList.vue`**

```vue
<template>
  <div class="transfer-list">
    <h3>传输队列</h3>
    <el-empty v-if="transferStore.items.length === 0" description="暂无传输" :image-size="60" />
    <el-card v-for="item in transferStore.items" :key="item.transferId" class="transfer-item" shadow="never">
      <div class="row">
        <span class="name">{{ item.name }}</span>
        <el-tag :type="tagType(item.state)" size="small">{{ stateText(item.state) }}</el-tag>
      </div>
      <el-progress
        v-if="item.state === 'transferring'"
        :percentage="percent(item)"
        :format="() => formatBytes(item.doneBytes) + ' / ' + formatBytes(item.totalBytes)"
      />
      <div v-if="item.reason" class="reason">{{ item.reason }}</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { useTransferStore, type TransferItem } from '../stores/transfer'

const transferStore = useTransferStore()

function percent(item: TransferItem): number {
  if (item.totalBytes === 0) return item.state === 'complete' ? 100 : 0
  return Math.min(100, Math.round((item.doneBytes / item.totalBytes) * 100))
}
function tagType(s: TransferItem['state']): 'success' | 'danger' | 'warning' | 'info' {
  if (s === 'complete') return 'success'
  if (s === 'failed' || s === 'rejected') return 'danger'
  if (s === 'transferring') return 'warning'
  return 'info'
}
function stateText(s: TransferItem['state']): string {
  return { 'waiting-confirm': '等待确认', transferring: '传输中', complete: '已完成', failed: '失败', rejected: '已拒绝' }[s]
}
function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}
</script>

<style scoped>
.transfer-list { display: flex; flex-direction: column; gap: 8px; }
.transfer-item .row { display: flex; justify-content: space-between; align-items: center; }
.reason { color: var(--el-color-danger); font-size: 12px; margin-top: 4px; }
</style>
```

- [ ] **Step 8.7: 实现 `src/renderer/src/components/TransferConfirmDialog.vue`**

```vue
<template>
  <el-dialog
    :model-value="!!offer"
    title="接收传输"
    width="480px"
    :close-on-click-modal="false"
    :show-close="false"
    @close="reject"
  >
    <template v-if="offer">
      <div class="offer-info">
        <p>发送者：<b>{{ offer.senderName }}</b></p>
        <p>
          内容：<b>{{ offer.files.length === 1 ? offer.files[0].path : offer.fileCount + ' 项' }}</b>
          （{{ formatBytes(offer.totalBytes) }}）
        </p>
        <p>保存到：{{ saveDir }}</p>
        <el-alert
          v-if="offer.conflicts"
          type="warning"
          :closable="false"
          title="保存位置已存在同名文件/文件夹"
        />
      </div>
    </template>
    <template #footer>
      <el-button @click="reject">拒绝</el-button>
      <el-button v-if="offer?.conflicts" @click="chooseOtherDir">选择其他位置</el-button>
      <el-button v-if="offer?.conflicts" type="warning" @click="accept">接受并覆盖</el-button>
      <el-button v-else type="primary" @click="accept">接受</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { useTransferStore } from '../stores/transfer'

const transferStore = useTransferStore()
const offer = computed(() => transferStore.pendingOffer)
const saveDir = ref('')

onMounted(async () => {
  saveDir.value = (await window.api.getConfig()).saveDir
})

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

function accept(): void {
  if (!offer.value) return
  window.api.respondTransfer(offer.value.transferId, 'accept')
  transferStore.clearOffer()
}

function reject(): void {
  if (!offer.value) return
  window.api.respondTransfer(offer.value.transferId, 'reject')
  transferStore.clearOffer()
}

async function chooseOtherDir(): Promise<void> {
  if (!offer.value) return
  const dir = await window.api.pickDirectory()
  if (!dir) return
  window.api.respondTransfer(offer.value.transferId, 'accept', dir)
  transferStore.clearOffer()
  ElMessage.success('已选择新位置接收')
}
</script>

<style scoped>
.offer-info p { margin: 6px 0; }
</style>
```

- [ ] **Step 8.8: 重写 `src/renderer/src/App.vue`**

```vue
<template>
  <el-container class="app-root">
    <el-aside width="280px" class="aside">
      <DeviceList />
    </el-aside>
    <el-container>
      <el-main class="main-area">
        <DropZone />
        <TransferList />
      </el-main>
    </el-container>
    <TransferConfirmDialog />
  </el-container>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import DeviceList from './components/DeviceList.vue'
import DropZone from './components/DropZone.vue'
import TransferList from './components/TransferList.vue'
import TransferConfirmDialog from './components/TransferConfirmDialog.vue'
import { useDeviceStore } from './stores/device'
import { useTransferStore } from './stores/transfer'

const deviceStore = useDeviceStore()
const transferStore = useTransferStore()

onMounted(() => {
  void deviceStore.refresh()
  window.api.onDeviceChange((upd) => deviceStore.applyUpdate(upd))
  window.api.onTransferUpdate((u) => transferStore.applyUpdate(u))
  window.api.onOffer((offer) => transferStore.pushOffer(offer))
})
</script>

<style>
.app-root { height: 100vh; }
.aside { border-right: 1px solid var(--el-border-color); }
.main-area { display: flex; flex-direction: column; gap: 16px; }
</style>
```

- [ ] **Step 8.9: 验证**

Run: `npm run typecheck`
Expected: 无错误

Run: `npm run dev`
Expected: 应用窗口显示三区域布局；左侧无设备（单机）；拖拽/选择文件后提示"请先选择目标设备"（预期，因无对端）；Ctrl+C 退出。**跨端真实互传验证在 Task 9 冒烟阶段进行。**

- [ ] **Step 8.10: Commit**

```bash
git add src/preload/index.ts src/main/index.ts src/renderer/src/
git commit -m "feat(ui): Vue3 device list, drop zone, transfer queue, confirm dialog with manual-IP target"
```

---

## Task 9: 打包配置 + 跨平台冒烟清单

**Files:**
- Create: `electron-builder.yml`

- [ ] **Step 9.1: 创建 `electron-builder.yml`**

```yaml
appId: com.localshare.app
productName: LocalShare
directories:
  output: dist
files:
  - out/**
  - package.json
mac:
  target:
    - dmg
  category: public.app-category.utilities
win:
  target:
    - nsis
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

- [ ] **Step 9.2: 构建本机安装包**

Run: `npm run build && npx electron-builder --mac`（macOS）或 `--win`（Windows）
Expected: `dist/` 下生成 `.dmg` 或 `.exe`；electron-builder 二进制经 npmmirror 镜像下载，不直连 GitHub

- [ ] **Step 9.3: 跨平台冒烟清单（手动，两台真机）**

逐项验证并在完成后勾选：

- [ ] macOS 与 Windows 各装一份 LocalShare，启动后 12 秒内互相出现在设备列表
- [ ] 关闭一端应用，另一端 12 秒内将其标记离线（或手动输入 IP 直连仍可发送）
- [ ] macOS → Windows 发送单个文件，接收方确认后内容一致
- [ ] Windows → macOS 发送含空子目录的文件夹，目录结构完整
- [ ] 重复发送同一目录：接收方确认框出现"已存在同名"警告，选"接受并覆盖"后内容为最新
- [ ] 再次发送，选"选择其他位置"：文件落入新目录
- [ ] 接收方点"拒绝"：发送方显示失败原因"已拒绝"
- [ ] 传输中关闭接收方应用：发送方提示失败，接收方无 `.part` 残留
- [ ] macOS 首次运行出现"本地网络"权限弹窗；Windows 首次运行防火墙弹窗选择"专用网络"
- [ ] 1GB 文件传输完成，千兆局域网速度正常，CPU 占用合理（无失控）

- [ ] **Step 9.4: 对照成功标准（设计文档 9.5）逐条确认**

- [ ] 设备列表 12 秒内出现/消失
- [ ] 拖拽 → 确认 → 完成，目录结构完整（含空目录）
- [ ] 冲突覆盖/换位置可用；拒绝/中断/离线均有清晰提示
- [ ] 1GB 传输可用，CPU 合理

- [ ] **Step 9.5: Commit**

```bash
git add electron-builder.yml
git commit -m "chore(build): electron-builder config for mac dmg and win nsis"
```

---

## 计划自审记录

**规格覆盖核对**（对设计文档逐节）：
- 需求基线 1-12 → Task 0（Electron/Vue3 脚手架）、Task 4（自研发现）、Task 5/6（接收方确认、逐文件流式）、Task 3/6（冲突覆盖/换位置）、Task 7（端口被占报错退出）
- 设计 4（发现协议：广播、HELLO/BYE、心跳、UUID、帧格式、端口策略、手动直连）→ Task 4 + Task 7/8（手动 IP）
- 设计 5（传输协议：9 种消息、两态状态机、路径清洗、超时）→ Task 1/5/6
- 设计 6（UI/UX、冲突三选一）→ Task 8
- 设计 7（错误处理清单）→ Task 6（中断/清理）、Task 7（端口致命）、Task 9（冒烟）
- 设计 8（技术栈、镜像）→ Task 0（.npmrc）、Task 7（config）、Task 9（electron-builder）
- 设计 9（测试策略）→ Task 1-6（单测/集成）、Task 9（冒烟）
- 非目标：断点续传、加密、文本传输、历史持久化、镜像删除、并发——**全部未实现** ✓

**类型一致性核对**：
- `WalkEntry{type,relPath,absPath,size}`（Task 2）→ Sender.start（Task 5）→ 集成测试（Task 6）字段一致 ✓
- `DeviceInfo{id,name,platform,version,host,tcpPort,lastSeen}`（Task 4）→ 主进程组装（Task 7）→ DeviceList 手动直连（Task 8）一致 ✓
- `OfferSummary.files` 含 `size`（Task 6 定义）→ 确认框展示（Task 8）一致 ✓
- `TransferUpdate.kind`（Task 7 preload）→ transfer store applyUpdate（Task 8）分支一致 ✓
- `Message` 联合类型包含 HELLO/BYE（Task 1）→ deviceTable/discovery 使用（Task 4）一致 ✓

**已知风险（执行时注意）**：
- Task 4 集成测试依赖 `reuseAddr` 同端口多绑定，Windows 上可能失败；失败时改用定向单播辅助测试通道
- Task 3 覆盖测试依赖 Windows `rename` 覆盖语义（MoveFileExW），异常时在该平台复查
- Task 6 集成测试共用固定 TCP 端口，测试串行执行（Vitest 默认串行），`stop(cb)` 确保端口释放
- 拖拽路径依赖 `webUtils.getPathForFile`（Electron 29+），渲染进程必须通过 preload 调用，不可直接访问 `File.path`
