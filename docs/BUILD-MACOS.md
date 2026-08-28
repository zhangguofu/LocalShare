# LocalShare — macOS 环境搭建与打包

> 在 macOS 上开发、测试与打包 LocalShare（局域网文件分享，Electron + Vue3）。
> Windows 环境见 `BUILD-WINDOWS.md`。

## 环境要求

- **Node.js LTS（20 或 22）**——项目在 Node 22 下开发；electron-vite 要求 ≥18
- **Git**（macOS 自带，或 `brew install git`）
- **Homebrew**（可选，装工具用）

## 第一步：安装 Node.js

```bash
# 推荐 nvm（版本管理）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 22
nvm use 22

# 或 Homebrew
brew install node@22
```

## 第二步：拉取代码并安装依赖

```bash
git clone <仓库地址>
cd localshare
npm install
```

依赖经**项目内置 `.npmrc`** 走 npmmirror 镜像（registry + Electron 二进制 + electron-builder 工具链），国内网络无需额外配置。

### 已知坑：npm 缓存目录权限

若本机 `~/.npm` 部分目录属 root（历史用 sudo 跑过 npm），`npm install` 会报 `EACCES`：

```bash
sudo chown -R $(id -u):$(id -g) ~/.npm   # 一次性修复
```

临时规避可用独立缓存：`npm install --cache ~/npm-cache-localshare`。

## 第三步：开发运行

```bash
npm run dev
```

- 出现应用窗口；`Ctrl+C` 结束
- **macOS 行为**：点窗口关闭按钮 = 隐藏窗口（驻留 Dock，界面状态保留），`Cmd+Q` 或 Dock 右键才真正退出
- **首次运行**：会弹「本地网络」权限框（发现机制需要），必须点**允许**；误拒后在「系统设置 → 隐私与安全性 → 本地网络」中开启

## 第四步：测试

```bash
npm test          # 49+ 单元与集成测试（UDP/TCP 回环）
npm run typecheck # 类型检查
```

集成测试绑定测试端口（45599/45600），运行前确保未被占用。

### 本机双实例验证（无需两台机器）

两个实例端口/配置必须隔离（发现协议要求同一 UDP 端口，本机双实例**只能验证手动直连传输**，广播发现需真机）：

```bash
# 终端 1 —— 实例 A（默认端口 45555/45556）
npm run dev

# 终端 2 —— 实例 B（独立 userData/端口/设备名）
LOCALSHARE_USER_DATA=~/localshare-test-b \
LOCALSHARE_UDP_PORT=45655 \
LOCALSHARE_TCP_PORT=45656 \
LOCALSHARE_DEVICE_NAME=MacB npm run dev
```

互传：A 左侧输入 `127.0.0.1:45656` 设置目标 → 拖文件 → B 确认框接受。B→A 用 `127.0.0.1:45556`。

## 第五步：打包 mac 应用

```bash
npm run build:mac
```

产物：`dist/LocalShare-0.1.0.dmg`。

### 代码签名说明

- **本机有开发者证书**（钥匙串）：electron-builder 自动检测并签名，直接 `npm run build:mac` 即可
- **无证书 / CI / 沙箱受限**（`codesign` 报 `errSecInternalComponent`）：禁用签名
  ```bash
  npx electron-builder --mac -c.mac.identity=null
  ```
- 未签名应用首次打开被 Gatekeeper 拦截：
  ```bash
  xattr -cr /Applications/LocalShare.app
  ```
  或 Finder 右键 → 打开 → 确认

### 应用图标

当前使用 Electron 默认图标。自定义图标：提供 `build/icon.icns`（macOS 格式）后重新打包。

## 常见问题

1. **npm 缓存 EACCES**：见上文"已知坑"。
2. **广播发现失效（真机双机）**：按序检查——① 两机同一子网；② macOS「本地网络」权限已允许；③ Windows 防火墙放行（专用网络）；④ 对端应用在运行。仍不行看终端日志 `[discovery]` 输出（监听端口/广播目标/设备上线离线）。
3. **端口被占用**：应用启动报错退出（设计行为）。改端口：应用内「设置 → UDP/TCP 端口」（保存前自动检测端口可用性，冲突会拒绝保存）。
4. **发现协议注意**：UDP 端口是所有设备共用的全局约定，修改后其他设备无法发现本机（除非对方同样修改）；TCP 端口每机独立，改后对方 ≤3 秒自动感知（HELLO 携带新端口）。
5. **打包失败 `errSecInternalComponent`**：沙箱或钥匙串不可访问导致签名失败，用 `-c.mac.identity=null` 跳过签名（见上文）。

## 冒烟清单（真机双机）

- [ ] 两台机器互相出现在设备列表（12 秒内出现/消失）
- [ ] 互传文件/文件夹，目录结构完整（含空目录、中文文件名、零字节文件）
- [ ] 同名冲突：默认目录与新选目录的覆盖/换位置，覆盖前均有提示
- [ ] 1GB 大文件传输：进度条平滑（百分比两位小数），传输中关闭对方 `.part` 无残留
- [ ] 传输中断/拒绝/对方离线均有明确提示
- [ ] 设置页：修改保存目录/设备名/端口（含端口占用拒绝）后即时生效
