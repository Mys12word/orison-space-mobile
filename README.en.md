<div align="center">

<img src="docs/assets/logo.png" width="96" alt="Orison Space" />

# Orison Space · Mobile (Android)

**The AI novel-writing IDE, as an installable Android APK — not a web page, not a PWA.**

[![Release](https://img.shields.io/badge/release-0.3.0--mobile.11-2ea44f)](../../releases/latest)
[![Platform](https://img.shields.io/badge/Android-8.0%2B%20%C2%B7%20arm64-3ddc84?logo=android&logoColor=white)](../../releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[⬇️ Download APK](../../releases/latest) · [中文说明](README.md)

<sub>by [@Mys12word](https://github.com/Mys12word) · DeepSeek</sub>

</div>

---

[Orison Space](https://github.com/LumenStorm/OrisonSpace) is an open-source, local-first AI novel-writing
IDE (Electron + React + TypeScript): projects, outlines, manuscript, asset library, AI agent, and a Git-based
writing timeline. It only shipped a desktop build — this repository brings it to Android.

The APK bundles a Node runtime, boots a local HTTP/WebSocket host on `127.0.0.1` at launch, and points a
WebView at it. Same React UI, same main-process code, fully offline; your manuscripts never leave the device.

## Install

1. Grab `OrisonSpace-0.3.0-mobile.11.apk` (~38 MB) from [Releases](../../releases/latest).
2. Allow "install from unknown sources" if your ROM asks for it.
3. First launch unpacks the bundled runtime (~120 MB, one time, 5–15 s).

Requires **arm64-v8a** and **Android 8.0+**. The APK is self-signed, so upgrades must be installed over the
same signature.

## How it works

```
WebView  ← same React UI, switches to the mobile layout at ≤760px
   ↑↓  http://127.0.0.1:<random port>/   RPC + WebSocket, per-process token
Node host (bundled node 26 subprocess, unpacked from assets on first run)
   ├─ upstream main-process code (apps/desktop/client/shell/main/**)
   ├─ BFF / model gateway / agent runtime / story-sync / Git timeline
   ├─ SQLite via node:sqlite (replaces the native better-sqlite3 build)
   └─ electron shim: app / ipcMain / BrowserWindow / dialog / shell / …
```

| Desktop capability | Android implementation |
| --- | --- |
| Electron IPC | `POST /rpc` + WebSocket `/events`, one shared `createDesktopApi()` for preload and the mobile bridge |
| `better-sqlite3` | `node:sqlite` adapter with identical prepare/run/get/all/transaction semantics |
| `safeStorage` | app-local AES-256-GCM key |
| `orison-file://` protocol | `GET /orison-file/<abs path>` |
| Native file dialogs | in-app directory browser |

`targetSdk` is pinned to 28 because Android 10+ refuses to `exec` binaries from app-private storage.

## Build from source

Everything runs on-device (Termux + Node/pnpm; no Android Studio, no NDK):

```bash
pnpm install --ignore-scripts
cd apps/mobile && node scripts/build.mjs && cd ../..
node tools/apk/fetch-toolchain.mjs   # JDK17 / aapt / d8 / apksigner / android.jar (~270 MB, once)
node tools/apk/build-apk.mjs         # javac → d8 → aapt → zipalign → apksigner
```

## Known limitations

- Editor body does not yet honor the "reading font / weight / size" appearance options (line-height does).
- arm64 only; projects are stored under `Android/data/com.orison.mobile/files/OrisonSpace/`.
- No OS share-sheet import, no self-update, no foreground service (background lifetime follows battery policy).

## Author & License

Android port by **[@Mys12word](https://github.com/Mys12word)** with **DeepSeek** (AI pair programming).

Unofficial Android port of [LumenStorm/OrisonSpace](https://github.com/LumenStorm/OrisonSpace), licensed under
**Apache-2.0** — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Upstream docs live in
[README.upstream.md](README.upstream.md) / [README.upstream.en.md](README.upstream.en.md).
