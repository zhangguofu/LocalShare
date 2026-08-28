# LocalShare — Windows 环境搭建与打包

> 在 Windows 上开发、测试与打包 LocalShare（局域网文件分享，Electron + Vue3）。
> macOS 环境见 `BUILD-MACOS.md`。

## 环境要求

- **Node.js LTS（20 或 22）**——项目在 Node 22 下开发；electron-vite 要求 ≥18
- **Git**（拉取代码）
- **不需要 Visual Studio / Python**——本项目零原生依赖（主进程只用 Node 内置模块，渲染层全打包进 bundle），electron-builder 打包不编译任何原生代码

## 第一步：安装 Node.js 与 Git

- 官网下载：<https://nodejs.org>（选 LTS，装完 `node -v` 验证）
- 或命令行：
  ```powershell
  winget install OpenJS.NodeJS.LTS
  winget install Git.Git
  ```

## 第二步：拉取代码并安装依赖

```powershell
git clone <仓库地址>
cd localshare
npm install
```

依赖经**项目内置 `.npmrc`** 走 npmmirror 镜像（registry + Electron 二进制 + electron-builder 工具链均从国内镜像下载），无需任何额外配置。Windows 上无 macOS 的 npm 缓存权限问题。

## 第三步：开发运行

```powershell
npm run dev
```

启动后出现应用窗口；`Ctrl+C` 结束。改代码热重载；改主进程/配置需重启。

## 第四步：测试

```powershell
npm test          # 49+ 单元与集成测试（UDP/TCP 回环）
npm run typecheck # 类型检查
```

集成测试会绑定测试端口（45599/45600），运行前确保未被占用。

## 第五步：打包 Windows 安装器

```powershell
npm run build:win
```

产物：`dist/LocalShare-0.1.0.exe`（NSIS 安装器）。electron-builder 自动下载 NSIS/winCodeSign 工具链（走镜像），无需手动安装。

### 可选：代码签名

不签名也能打包（SmartScreen 会提示"未知发布者"，内网自用无碍）。对外发布需 Windows 代码签名证书：

```powershell
$env:CSC_LINK = "C:\path\to\cert.pfx"
$env:CSC_KEY_PASSWORD = "证书密码"
npm run build:win
```

## 常见问题

1. **PowerShell 报"禁止运行脚本"**：npm 是 `.cmd` 脚本，PowerShell 默认策略拦截。
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```
   或改用 CMD（`cmd`）执行命令。

2. **长路径错误（MAX_PATH 260）**：`node_modules` 深层路径可能触发。clone 到短路径（如 `C:\dev\localshare`）；或启用系统长路径（注册表 `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1` 后重启）。

3. **杀毒软件拦截**：NSIS 安装器生成时可能被 Defender/第三方杀软误报，构建时把项目目录加入白名单。

4. **首次运行防火墙弹窗**：必须勾选**专用网络**（放行入站 UDP 45555 / TCP 45556），否则发现机制与传输不可用。若误选，在"Windows 安全中心 → 防火墙 → 允许应用通过"中修改。

## Windows 专项验证清单（打包后）

- [ ] 与另一台设备（Mac/Windows）互相出现在设备列表（广播发现，需同一子网）
- [ ] 互传文件/文件夹，目录结构完整（含空目录、中文文件名）
- [ ] 同名文件冲突：默认目录与新选目录的覆盖/换位置流程
- [ ] 覆盖已有文件（`fs.rename` 覆盖语义，Windows 实测）
- [ ] 路径安全：发送含 Windows 保留名（`CON`、`NUL.txt` 等）的文件应被拒绝而非报错
- [ ] 1GB 大文件传输 + 传输中关闭对方应用（`.part` 无残留）
- [ ] 设置页修改端口（含端口占用拒绝）、保存目录、设备名
