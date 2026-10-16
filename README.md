# M3u8Down

基于 **Electron** 的 Windows 桌面应用，用于下载 M3U8（HLS）流媒体视频，并通过内嵌的 **FFmpeg** 将 TS 分片无损合并为 MP4。多线程分片下载、断点续传、AES-128 解密、自动合并、边下边播，开箱即用，无需自行安装 FFmpeg 或配置环境变量。

## 功能特性

- **多线程分片下载**：可配置并发数（默认 8），支持重定向、超时与失败自动重试。
- **M3U8 解析**：支持 master playlist 自动选择最高码率、相对路径、AES-128 加密流解密。
- **断点续传**：任务进度持久化，重启应用后可继续；对分片做 MPEG-TS 合法性校验，自动剔除并重下残缺/错误页/解密失败的坏片。
- **自动合并 MP4**：新增下载时可勾选“下载完成后自动合并”，可自定义 MP4 文件名与输出目录。
- **手动合并**：在“合并”页选择任意包含 `.ts` 分片的目录或多选文件即可合成 MP4，不依赖下载任务。
- **视频播放**：内置独立播放窗口，未合并时用 FFmpeg 将已下载分片实时 remux 为临时 MP4 播放，支持全屏、双击切换、刷新到最新下载进度。
- **内嵌 FFmpeg**：通过 [ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static) 打包 FFmpeg（`extraResources`），目标机器无需安装 FFmpeg、无需配置 PATH。
- **设置持久化**：保存目录、输出目录、线程数、自动合并偏好、自定义 FFmpeg 路径均保存在用户数据目录，重启自动恢复。
- **自建标题栏**：无边框窗口，自定义最小化 / 最大化 / 关闭；播放窗口与主窗口相互独立，可单独唤回。
- **任务管理**：暂停、继续、删除（可选择是否同时删除文件）、打开目录、打开已生成的 MP4。

## 技术栈

| 分类 | 技术 |
| --- | --- |
| 应用框架 | Electron 31（主进程 + 渲染进程 + Preload 安全桥接） |
| 界面 | 原生 HTML / CSS / JavaScript（无前端框架） |
| 视频处理 | FFmpeg（ffmpeg-static，concat demuxer + `-c copy` 无损合并） |
| 网络/加密 | Node.js `https`/`http`、`crypto`（AES-128-CBC） |
| 打包 | electron-builder（NSIS 安装包 + portable 便携版，x64） |

## 目录结构

```
M3u8Down/
├── main.js              # 主进程：窗口、IPC、自动合并编排、生命周期
├── preload.js           # 安全暴露 window.api（contextIsolation）
├── src/
│   ├── downloadManager.js  # M3U8 解析、多线程下载、解密、断点续传、任务持久化
│   ├── merger.js           # FFmpeg 路径解析、TS 校验、合并与播放预览
│   ├── protocols.js        # 自定义 seg:// 文件读取协议（供播放器读取本地文件）
│   └── store.js            # 设置与任务索引持久化（settings.json）
├── renderer/
│   ├── index.html        # 主界面（下载 / 合并 / 设置）
│   ├── app.js            # 主界面逻辑
│   ├── styles.css        # 界面样式
│   ├── player.html       # 独立播放窗口
│   └── player.js         # 播放逻辑（MP4 / 实时 remux）
├── build/
│   └── icon.ico          # 应用图标（多尺寸）
├── make-icon.js          # 由 PNG 生成多尺寸 icon.ico 的脚本
└── package.json
```

## 环境要求

- 操作系统：Windows 10 / 11（x64）
- 开发环境：[Node.js](https://nodejs.org/) 16+（推荐 18 LTS 或更高）、npm

## 快速开始

```bash
# 1. 安装依赖（会自动下载内置 ffmpeg 二进制）
npm install

# 2. 开发模式运行（数据写入项目内 .appdata，便于调试）
npm run dev

# 3. 正常运行（数据写入系统用户数据目录）
npm start
```

> 说明：`ffmpeg-static` 在 `npm install` 阶段会下载 FFmpeg 可执行文件。若网络受限，可设置镜像后再安装：
>
> ```bash
> # PowerShell
> $env:NODE_TLS_REJECT_UNAUTHORIZED='0'
> npm install
> # 或使用 HTTPS 代理 / 切换网络
> ```

## 使用说明

1. 打开应用，在「下载」页点击 **＋ 新增下载**。
2. 在弹窗中粘贴 M3U8 地址，按需设置：
   - 保存名称、下载线程数
   - 分片保存目录
   - 是否在下载完成后自动合并，以及 MP4 的文件名与输出目录
3. 下载过程中可暂停 / 继续 / 播放 / 删除；下载完成后按设置自动合并，或前往「合并」页手动选择 TS 片段合并。
4. 「设置」页可查看内置 FFmpeg 状态，或在特殊情况下手动指定 `ffmpeg.exe`。
5. 任务记录与偏好会自动保存，关闭重开应用后自动恢复。

## 打包发布

```bash
# 生成 NSIS 安装包 + 便携版（输出到 dist/）
npm run dist

# 仅生成免安装的 win-unpacked 目录（调试打包更快）
npm run dist:dir
```

产物位于 `dist/`：

| 文件 | 说明 |
| --- | --- |
| `M3u8Down-Setup.exe` | NSIS 安装包，可选安装目录、创建桌面/开始菜单快捷方式 |
| `M3u8Down-portable.exe` | 便携单文件版，双击即用 |
| `win-unpacked/M3u8Down.exe` | 解压即用的绿色程序目录 |

打包时会自动将 FFmpeg 复制到 `resources/bin/ffmpeg.exe`，运行时优先使用该内置副本。

> 国内网络下如遇 Electron / NSIS 二进制下载失败，可设置镜像：
>
> ```powershell
> $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
> $env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
> npm run dist
> ```

### 发布 GitHub Release

```bash
# 1. 升版本（同步更新 package.json 与 package-lock.json）
npm version patch --no-git-tag-version
git commit -am "chore: bump version"
git push

# 2. 打包产物
npm run dist

# 3. 创建 Release 并上传 dist/ 产物（tag 由当前版本号自动生成）
npm run release

# 预演：只打印将要执行的操作，不发任何写请求
node scripts/release.js --dry-run
```

`scripts/release.js` 说明：

- 版本号取自 `package.json`，生成 tag `v<version>`；仓库从 `git remote get-url origin` 自动解析。
- Token 优先取环境变量 `GITHUB_TOKEN` / `GH_TOKEN`，否则用 `git credential fill` 复用 git 已缓存的凭据。
- 默认上传 `dist/M3u8Down-Setup.exe` 与 `dist/M3u8Down-portable.exe`，可用 `--assets a.exe,b.exe` 指定。
- 常用参数：`--notes <file>`（用文件作为 Release 描述）、`--draft`、`--prerelease`、`--overwrite`（先删同名资产再上传）。
- 更新已存在的 Release 时，若不传 `--notes`，会保留原有描述，避免清掉手工编辑的内容。

> **关于中文乱码**：不要用 PowerShell 的 `Invoke-RestMethod -Body <字符串>` 发送含中文的 JSON —— Windows PowerShell 5.1 会按本地代码页编码，导致描述里的中文整体变成 `?`。本脚本用 Node `fetch`（默认 UTF-8）规避该问题。若必须用命令行工具，请改用「UTF-8 文件 + `curl --ssl-no-revoke --data-binary "@file"`」发送。

### 应用图标

仓库已包含 `build/icon.ico`。如需替换图标，将源图片命名为 `图标.png`（建议 ≥ 256×256 的正方形 PNG）放在项目根目录后执行：

```bash
npm run icon
```

## 数据与配置位置

- **默认**：`%AppData%/M3u8Down/`（开发模式 `npm run dev` 为项目内 `.appdata/`）
  - `settings.json`：应用设置与任务索引
  - `downloads/`：默认分片保存目录
- 下载分片、合并后的 MP4 实际位置以新增任务时选择的目录为准。

## 常见问题

**Q：合并提示 “Impossible to open / Invalid data”？**
A：通常是某个分片不是合法 TS（下载残缺、服务器返回错误页或加密流解密失败）。应用会在下载与合并前校验 TS 同步字节（`0x47`）并自动跳过/重下坏片；可在任务卡片点击「重新校验并合并」补下坏片。

**Q：安装版提示未检测到 FFmpeg？**
A：旧版本可能误读了 asar 内不可执行的 FFmpeg 路径。当前版本已优先使用 `resources/bin/ffmpeg.exe`，请使用最新安装包；必要时可在「设置」页手动指定。

**Q：支持哪些加密？**
A：支持常见的 HLS AES-128（METHOD=AES-128，含 IV 与按序号生成 IV）。SAMPLE-AES 等 DRM 方案不支持。

## 许可证

本项目依据仓库中的 [LICENSE](./LICENSE) 发布。所内嵌的 FFmpeg 来自 `ffmpeg-static`（GPL 构建），其许可证随安装目录一并提供。
