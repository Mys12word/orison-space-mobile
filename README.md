<div align="center">

<img src="docs/assets/logo.png" width="96" alt="Orison Space" />

# Orison Space · 手机版

**把 AI 小说创作 IDE 装进 Android 手机 —— 一个可以直接双击安装的 APK。**

[![Release](https://img.shields.io/badge/release-0.3.0--mobile.11-2ea44f)](../../releases/latest)
[![Platform](https://img.shields.io/badge/Android-8.0%2B%20%C2%B7%20arm64-3ddc84?logo=android&logoColor=white)](../../releases/latest)
[![Offline](https://img.shields.io/badge/local--first-offline-orange)]()
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[⬇️ 下载 APK](../../releases/latest) · [从源码构建](#从源码构建) · [已知限制](#已知限制) · [相对上游的改动](#相对上游的改动)

<sub>作者：[@Mys12word](https://github.com/Mys12word) · DeepSeek</sub>

</div>

---

[Orison Space](https://github.com/LumenStorm/OrisonSpace) 是一个开源的 AI 小说创作 IDE（Electron + React + TypeScript）：
项目管理、大纲、正文、素材库、AI Agent、Git 写作时间线，一条龙。但它只有桌面版。

这个仓库把它搬到了手机上，**不是网页版、也不是 PWA**：APK 里内置了 Node 运行时，
启动时在手机本地起一台服务，WebView 打开同一套界面 —— 装好即用，断网照写，数据只放在手机里。

| | |
| --- | --- |
| 📴 **完全离线** | 小说、素材、版本历史都在本机；联网只用于你自己配置的 AI 模型 |
| 📱 **为手机重做布局** | 底部 6 标签 + 侧滑文件抽屉 + 全屏 Agent，不是把桌面界面缩小 |
| 🧩 **桌面逻辑原样保留** | 项目 IPC、SQLite 注册表、模型网关、Agent 编排、Git 时间线全部沿用上游代码 |

## 安装

1. 打开 [Releases](../../releases/latest)，下载 `OrisonSpace-0.3.0-mobile.11.apk`（约 38 MB）。
2. 用文件管理器点开安装；系统提示「安装未知来源应用」时允许即可。
3. 首次启动会解压内置运行时（约 120 MB，一次性，5～15 秒），之后每次都是秒开。

要求：**arm64-v8a**（近几年的手机都是）+ **Android 8.0 及以上**。

> APK 是自签名，升级必须覆盖安装同一签名的包。桌面版 `orison` 项目目录不通用，
> 手机上的作品默认保存在 `Android/data/com.orison.mobile/files/OrisonSpace/`。

## 它是怎么在手机上跑起来的

上游是 Electron 应用，Android 上没有 Electron 运行时。所以这里没有重写业务代码，
只是把 **Electron 外壳**换成了「Node 子进程 + WebView」：

```
┌──────────────────────────────  Android APK  ──────────────────────────────┐
│  WebView  ← 与桌面版同一套 React UI（≤760px 自动切手机布局）               │
│      ↑↓  http://127.0.0.1:<随机端口>/   RPC + WebSocket，进程级 token       │
│  Node 主机（APK 内置 node 26 子进程，首次启动从 assets 解包）               │
│   ├─ 上游主进程代码  apps/desktop/client/shell/main/**                     │
│   ├─ 本地 BFF / 模型网关 / Agent / story-sync / Git 时间线                 │
│   ├─ SQLite（node:sqlite 适配，替代需要 NDK 编译的 better-sqlite3）         │
│   └─ electron 垫片：app / ipcMain / BrowserWindow / dialog / shell / …     │
└───────────────────────────────────────────────────────────────────────────┘
```

桌面能力在 Android 上的替代实现：

| 桌面能力 | 手机版实现 |
| --- | --- |
| Electron IPC | `POST /rpc` + WebSocket `/events`；`window.orisonDesktop` 由 `createDesktopApi()` 统一生成，preload 与手机桥共用同一份接口定义 |
| `better-sqlite3` 原生模块 | `node:sqlite` 适配层，保持 prepare / run / get / all / transaction 语义 |
| `safeStorage` | 应用本地 AES-256-GCM（密钥在应用私有目录） |
| `orison-file://` 协议 | `GET /orison-file/<绝对路径>`，UI 侧统一走 `fileUrl()` |
| 系统文件/目录对话框 | 应用内目录浏览器（双向 `pick-request` → `pick-result`） |
| 窗口控制、自动更新 | 无操作 / 手动下载 Release |

几个踩过的坑也写在这里，省得下一个人再踩：`targetSdk` 固定 28（Android 10+ 禁止从应用私有目录
`exec` 二进制）；内置的 Termux 版 Node 把 `OPENSSLDIR` 编死在了 Termux 路径，所以 `openssl.cnf`、
`cert.pem`、`ossl-modules` 会一起打包并用 `OPENSSL_CONF` 指过去。

## 手机布局

宽度 ≤760px 时自动切换，桌面/平板保持原来的多栏 IDE：

- 底部 6 个标签：目录 / 总览 / 大纲 / 写作 / 资产库 / Agent
- 文件树、搜索、时间线 → 侧滑抽屉
- Agent → 全屏面板，带「收起」条；输入框 Enter 换行、`Ctrl/⌘+Enter` 发送，可「撤回上一条」
- 悬浮层统一 Portal 到 `body`，避免被顶栏层叠上下文压住；安全区、`100dvh` 均已处理

## 从源码构建

全流程都在手机上就能跑（一台 Android 设备 + Termux 里的 Node/PNPM，不需要 Android Studio / NDK）：

```bash
# 1) Web + 主机 bundle
pnpm install --ignore-scripts
cd apps/mobile && node scripts/build.mjs && cd ../..

# 2) 取工具链：JDK17 / aapt / d8 / apksigner / android.jar（首次约 270 MB）
node tools/apk/fetch-toolchain.mjs

# 3) 打 APK：javac → d8 → aapt → zipalign → apksigner
node tools/apk/build-apk.mjs
# 产物：dist/OrisonSpace-<version>.apk
```

- 需要 Termux 的 arm64 `node`（`$PREFIX/bin/node`）及其 `lib/` 下的共享库，构建时一并塞进 `assets/runtime/`；
- `android.jar` 用的是 Robolectric 的 `android-all`，`aapt` 以系统的 `framework-res.apk` 作为资源包；
- 签名密钥在 `apk/keystore.jks`（不入库，首次构建自动生成）。

宿主层冒烟测试（建项目、读写、字数、注册表、Git 时间线、WebSocket、文件协议、目录选择器、PWA 资源）：

```bash
cd apps/mobile && node scripts/smoke.mjs http://127.0.0.1:3210/
```

## 目录结构

```
apps/mobile/        手机主机 + electron/sqlite 垫片 + 手机渲染入口 + 构建与冒烟脚本
apps/desktop/…      上游桌面代码（仅 preload/api.ts、pathGuard.ts 与少量 UI 有改动）
apk/                Android 壳：MainActivity / NodeRuntime / HostBridge / Manifest / 图标
tools/apk/          工具链抓取与 APK 打包脚本
```

## 已知限制

- 外观设置里的「阅读字体 / 字重 / 字号」对编辑器正文暂未生效（预览块正常，行高已生效）。
- 仅支持 arm64-v8a（内置 arm64 Node）。
- 应用内目录选择器只能浏览 App 有权限的目录；作品默认落在
  `Android/data/com.orison.mobile/files/OrisonSpace/`。
- 暂不支持从系统文件管理器拖拽 / 分享文件进 App。
- APK 自签名，不会自动更新，升级靠手动装新 Release。
- 持续后台运行会受系统省电策略影响（没有做前台服务常驻）。

## 相对上游的改动

<details>
<summary>展开：改动文件清单</summary>

| 文件 | 改动 |
| --- | --- |
| `apps/mobile/**` | 新增：主机入口、electron / better-sqlite3 / electron-updater 垫片、HTTP+WS 桥、手机渲染入口、目录选择器、构建脚本、冒烟测试 |
| `apps/desktop/client/shell/preload/api.ts` | 抽出 `createDesktopApi(adapter, env)`，桌面 preload 与手机桥共用 |
| `apps/desktop/client/shell/preload/index.ts` | 改为使用上面的工厂（对外行为不变） |
| `apps/desktop/client/ui/src/widgets/layout/MobileWorkspaceLayout.tsx` | 新增手机外壳 |
| `apps/desktop/client/ui/src/widgets/layout/WorkspaceLayout.tsx` | 增加 `useIsMobile()` 分支 |
| `apps/desktop/client/ui/src/shared/hooks/useIsMobile.ts` | 新增 |
| `apps/desktop/client/ui/src/shared/utils/fileUrl.ts` | 新增：`orison-file://` ↔ `/orison-file/` |
| `apps/desktop/client/shell/main/ipc/pathGuard.ts` | 支持 `ORISON_PROJECTS_ROOT` |
| `pnpm-workspace.yaml` | 加入 `apps/mobile` |
| `apk/`、`tools/apk/` | 新增 Android 壳与工具链 |

除上表外，其余为上游原样代码。

</details>

## 作者与许可

移植：**[@Mys12word](https://github.com/Mys12word)** 与 **DeepSeek**（AI 协作完成）。

本仓库是 [LumenStorm/OrisonSpace](https://github.com/LumenStorm/OrisonSpace) 的非官方 Android 移植版，
遵循上游的 **Apache-2.0**，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。上游原始说明保留在
[README.upstream.md](README.upstream.md)。

问题请提到本仓库的 Issues；上游功能本身的缺陷请反馈给上游。
