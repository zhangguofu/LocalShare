# LocalShare 开发文档

> 面向开发与维护者。最终用户使用说明见 `README.md`。

## 技术栈

- Electron + Vue 3 + TypeScript + Vite + Pinia + Element Plus
- **网络层从零自研**（仅 Node 内置 `dgram`/`net`）：UDP 发现协议 + TCP 传输协议（帧格式/状态机详见[设计文档](2026-08-27-localshare-design.md)）
- 国内镜像固化（`.npmrc` → npmmirror），依赖安装开箱即用

## 目录结构

```
src/
  main/            # 主进程：网络层（protocol/tree/discovery/sender/receiver）、存储、配置、IPC
  preload/         # contextBridge 窄 API
  renderer/        # Vue3 UI：设备列表、拖放区、传输队列、确认对话框、设置
tests/             # 单元 + 集成测试（真实 UDP/TCP 回环）
scripts/           # 双节点验证（verify-transfer）、吞吐基准（bench-transfer）、发版（release）
docs/              # 设计文档、环境搭建指南
```

## 本地开发与测试

环境搭建（Node.js 20/22）详见 **[BUILD-WINDOWS.md](BUILD-WINDOWS.md)** 与 **[BUILD-MACOS.md](BUILD-MACOS.md)**。

```bash
npm install        # 安装依赖（走 npmmirror 镜像）
npm run dev        # 开发模式（热重载）
npm test           # 单元 + 集成测试（UDP/TCP 回环）
npm run typecheck  # 类型检查
```

## 本地打包（release.mjs）

```bash
npm run release                # patch +1（0.1.0 → 0.1.1），按本机平台打包
npm run release -- --minor     # minor +1
npm run release -- --major     # major +1
npm run release -- --version=1.2.3   # 指定版本
npm run release -- --sign      # macOS 显式启用代码签名（默认不签名，需本机开发者证书）
npm run release -- --arch=x64  # 指定架构
```

- **架构（macOS）**：默认按本机芯片（Intel → x64，Apple Silicon → arm64）；`--arch=universal` 通用二进制；`--arch=both` 产出 x64 + arm64 两个包
- **架构（Windows）**：`x64`（默认）| `arm64`
- 脚本逻辑：读 `package.json` → 递增版本尾号（或指定）→ 写回 → `npm run build` → 按当前平台打包（darwin → `.dmg`，win32 → `.exe`）
- 产物文件名带架构：`LocalShare-0.1.3-x64.dmg` / `-arm64.dmg` / `-x64.exe`

## 版本号管理

版本号**唯一来源是 `package.json` 的 `version` 字段**，改一处即全局生效（安装包文件名、设置页「版本 vX.Y.Z」、设备列表对端版本）。

## GitHub Actions 自动构建发布

仓库含 `.github/workflows/build.yml`：

- **push 到 main / 手动触发**：typecheck + 测试 + 打包，产物上传为 Artifact（Actions 页面下载）
- **打标签 `v1.2.3`**：打包并发布到 **GitHub Release**（macOS x64 + arm64 两个 `.dmg` 与 Windows `.exe`）

> GitHub 已移除 Intel macOS runner，macOS 双架构由 Apple Silicon runner 交叉打包生成。

**正式发版流程**：

```bash
npm run release                    # 本地：版本号 +1 并验证本机打包（可选）
git add package.json && git commit -m "release: v1.2.3"
git tag v1.2.3 && git push origin main --tags   # 触发 CI 发布
```

**代码签名**（可选，正式分发建议）：将 macOS（`.p12`）与 Windows 证书 Base64 存入 GitHub Secrets：`MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` / `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`。未配置时 CI 自动跳过签名（`CSC_IDENTITY_AUTO_DISCOVERY=false`）。CI 使用 `npm ci`（依赖锁定 `package-lock.json`）。

## 文档索引

- [设计文档](2026-08-27-localshare-design.md)——需求基线、架构、协议规格（帧格式/消息/状态机）、测试策略
- [Windows 环境搭建与打包](BUILD-WINDOWS.md) / [macOS 环境搭建与打包](BUILD-MACOS.md)
