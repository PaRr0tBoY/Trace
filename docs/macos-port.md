# Trace macOS 移植计划

> 状态：规划中（2026-08-12）。目标：让 Trace 在 macOS 上跑通同等功能集（剪贴板捕获、边缘 hover 面板、任务层、原生拖拽）。
> 范围外的：Linux（Wayland 拿不到全局指针/前台窗口，X11 会话可另行评估）。

## 1. 现状：平台耦合在哪

架构底子是好的——renderer 与 shared 层**零平台代码**（唯一例外是 i18n 文案里的 Ctrl+C 提示），所有系统能力都收敛在 main 进程背后、走 `shared/ipc.ts` 契约。跨平台工作量集中在 main 进程的 9 个 koffi 文件 + 7 个 PowerShell/WinRT 文件（74 处 Windows API 引用）。

关键洞察：**koffi 本身跨平台**（可加载 macOS dylib），现有的"koffi glue 加载原生函数"模式可以原样搬到 macOS——原生桥不需要 node-gyp，写 Swift/ObjC 编译成 dylib 再用 koffi 调即可。

## 2. 平台耦合点清单（逐文件）

### 2.1 必须重写的（Windows 专属实现）

| 文件 | Windows 依赖 | macOS 方案 | 工作量 |
|---|---|---|---|
| `electron/main/foreground.ts` | koffi `GetForegroundWindow`/`GetWindowThreadProcessId`/`GetWindowTextW`/`QueryFullProcessImageNameW`，500ms 轮询 | `NSWorkspace.sharedWorkspace.activeApplication` 拿前台应用（进程名/路径，**无需权限**）；窗口标题需 AXUIElement（辅助功能权限） | 中 |
| `electron/main/focus.ts` | koffi `GetWindowLongPtrW`/`SetWindowLongPtrW` + `WS_EX_NOACTIVATE` 激活桥（t21 整套） | Electron 无 nonactivatingPanel 支持 → Swift dylib 桥（`NSPanel` styleMask `.nonactivatingPanel` + `makeKeyAndOrderFront`），或用 `win.setVisibleOnAllWorkspaces` + `setIgnoreMouseEvents` 组合降级 | 高 |
| `electron/main/window.ts` | `enforceNoActivate`（koffi user32）、`alwaysOnTop('screen-saver')`、`setSkipTaskbar` | 置顶：macOS 最高为 floating 级，全屏空间压过需 `NSWindowCollectionBehaviorCanJoinAllSpaces`（Swift 桥）；`setSkipTaskbar` 无意义（dock 图标由 `LSUIElement` 控制）；`setIgnoreMouseEvents` 跨平台 ✓ | 中 |
| `electron/main/fullscreen.ts` | koffi `SHQueryUserNotificationState`（Direct3D 全屏检测） | `NSWorkspace` 的 `fullScreenApplicationsDidChangeNotification`（全屏空间通知，简单可靠） | 小 |
| `electron/clipboard/formats.ts` | koffi `GetClipboardSequenceNumber`；`FileNameW` 走 PowerShell `GetFileDropList`；`isIgnoredFormat` 按 Windows 剪贴板格式名过滤隐私 | `NSPasteboard.changeCount` 轮询（现有 600ms 轮询机制直接可用）；文件列表：`NSPasteboardTypeFileURL` 直接读 URL（**比 Windows 简单**，无单文件限制问题）；隐私过滤改判 `NSPasteboard` types | 中 |
| `electron/main/ocr.ts` | koffi 前台窗口矩形 + PowerShell WinRT `Windows.Media.Ocr` | Vision framework `VNRecognizeTextRequest`（中文 ✓）；截图 `CGWindowListCreateImage`（**需屏幕录制权限**）；Swift dylib 桥 | 中 |
| `electron/main/windowSwitch.ts` | koffi `SetForegroundWindow` 前台锁 workaround（ShowWindow/AttachThreadInput/SwitchToThisWindow） | `NSWorkspace.openApplication`（启动/激活应用级）；切到指定窗口需 AXUIElement（辅助功能权限） | 中 |
| `electron/main/powershell.ts` | 常驻 PowerShell 会话（三用途：文件列表、Ctrl+V 模拟、WinRT OCR） | **整个文件删除**，拆成三个平台服务（见 2.2） | 小（删） |
| `electron/main/pathValidation.ts` | 32767 长度上限、`*?<>\|"` 非法字符（Windows 路径规则） | macOS 规则不同（禁 `:` 与 `/`，允许 `*?<>\|"`）——校验逻辑参数化 | 小 |
| `electron/main/ipc.ts`（paste 部分） | `simulatePaste`：PowerShell SendKeys `SendWait('^v')` | AppleScript `tell application "System Events" to keystroke "v" using command down`（**需辅助功能权限**） | 小 |

### 2.2 跨平台可用的（验证为主，改动小）

| 文件 | 说明 |
|---|---|
| `electron/clipboard/ClipboardWatcher.ts` | 轮询 + signature + 250ms 稳定性窗口，纯逻辑 ✓ 原样可用；仅 `readClipboard` 的平台分支要接 2.1 的新实现 |
| `electron/main/drag.ts` | `webContents.startDrag` 跨平台 ✓；文本拖出的 temp .txt hack 在 macOS 可换 `filePromise`（Electron 支持，拖文本语义更好）；图标渲染 `@resvg/resvg-js` 跨平台 ✓ |
| `electron/main/tray.ts` | Electron `Tray` 跨平台 ✓；macOS 是菜单栏图标，图标需模板样式（黑白色自适应） |
| `electron/main/appIcons.ts` / `appIconCore.ts` | `app.getFileIcon` 跨平台 ✓（macOS 从 .app 提取） |
| `electron/main/imageProtocol.ts` | 纯文件读取 + `nativeImage` ✓ |
| `electron/main/state.ts`、`ipc.ts`（其余）、`suggestionEngine.ts`、`clusterer.ts`、`attributor.ts`、`provider.ts`、`aiLog.ts`、`eventBus.ts`、`ignored.ts`、`appOptions.ts`、`suggestionDrop.ts`、`onboardingWindow.ts`、`config.ts`、`store/*` | 纯逻辑，零平台依赖 ✓ 原样可用 |
| renderer 全部 + `shared/*` | 零平台代码 ✓；仅 i18n 30 语言的 Ctrl+C 文案要加 Cmd+C 变体，`SearchBar.tsx` 的 `e.ctrlKey` 检查要认 `metaKey` |

## 3. 迁移架构

```
shared/ipc.ts（契约，不动）
        ↓
electron/main/platform/            ← 新目录，接口层
  adapter.ts        PlatformAdapter 接口（见下）
  win32/*.ts        现有实现搬入（git 历史保留，不做兼容）
  darwin/*.ts       新实现（Electron API + Swift dylib 桥）
        ↓
electron/main/*.ts  通过注入的 adapter 使用平台能力
```

```ts
// adapter.ts — 需要平台化的能力面
interface PlatformAdapter {
  // 前台窗口
  foreground(): Promise<{ appName: string; exePath?: string; title?: string; pid?: number } | null>
  foregroundRect(): ScreenRect | null            // OCR 截图用
  // 窗口激活
  pinNonActivatable(win: BrowserWindow): void    // 面板永不抢焦点
  grantInputFocus(win: BrowserWindow): void      // 输入框聚焦时激活
  releaseInputFocus(win: BrowserWindow): void    // 面板关闭时还原
  // 全屏
  isFullscreenAppActive(): boolean
  onFullscreenChange(fn: () => void): () => void
  // 剪贴板
  clipboardFormatProbe(): ClipboardFormatProbe   // 隐私格式检测
  readFileList(): string[] | null                // 替代 PowerShell FileNameW
  // 动作
  simulatePaste(): Promise<void>                 // 替代 SendKeys
  activateAppWindow(app: AppRef): Promise<{ ok: boolean; method: 'window' | 'launch' }>
  ocrFromForeground(): Promise<string | null>
  // 打包/运行时
  windowBehavior: { alwaysOnTopLevel: 'floating' | 'screen-saver' }  // 能力声明
}
```

Swift 桥策略：写一个 `TraceNative.swift`（NSPanel 激活、Vision OCR、CGWindow 截图、AXUIElement 窗口切换），`swiftc -emit-library` 编译 dylib，koffi 加载——与现有 Windows koffi 模式对称，不引入 node-gyp 原生模块。

## 4. 分阶段实施

| 阶段 | 内容 | 验证标准 |
|---|---|---|
| **P0 骨架** | electron-builder mac 目标（dmg）；`LSUIElement`（无 dock 图标）；`npm run dev` mac 跑通；确认 `setAppUserModelId` 非 Windows no-op 安全性 | 面板出现、hover 展开、剪贴板捕获基础文本 |
| **P1 适配层** | `platform/` 目录 + 接口；win32 实现搬入（行为不变，跑 Windows 全量测试回归） | Windows 上 424 测试全绿（纯重构） |
| **P2 捕获** | macOS 剪贴板（changeCount + NSPasteboardTypeFileURL + 隐私过滤）；`NSWorkspace` 前台应用 | 文本/图片/文件捕获、去重、隐私过滤；前台应用记录正确 |
| **P3 窗口行为** | Swift 桥：NSPanel 非激活面板 + 输入框激活策略；置顶与全屏空间；点击穿透；边缘 hover | 焦点桥等效 t21 行为（输入框可打字、点击不抢焦点、无任务栏闪烁）；hover 手感一致 |
| **P4 任务层** | AXUIElement 窗口标题 + `app:open-linked-window`；Vision OCR（截屏权限引导）；AppleScript 粘贴模拟 | 候选任务聚类、窗口切换、OCR 上下文、粘贴动作可用 |
| **P5 打磨** | 拖出行为（filePromise）、i18n Cmd/Ctrl 文案、`SearchBar` metaKey、菜单栏图标模板、notarization | 全功能可用；`npm run package` 出已公证 dmg |

每阶段独立可交付、可回退；P2 结束即可日常使用（剪贴板管理器主功能），任务层是增量。

## 5. macOS 特有风险

1. **权限（最大 UX 风险）**：辅助功能（前台窗口标题/窗口切换/粘贴模拟/AXUIElement）、屏幕录制（OCR 截屏）、自动化（AppleScript）。用户拒绝授权时任务层要优雅降级——需要权限引导 UI + 状态说明（Windows 没有这个问题）。
2. **"永不抢焦点"哲学**：t21 的整套激活策略是 WS_EX_NOACTIVATE 语义。macOS 的正确形态是 `NSPanel`（nonactivating），但 Electron 的 BrowserWindow 不是 NSPanel——桥的可靠性要实测，必要时接受"输入框聚焦会激活窗口"的轻微行为差异。
3. **Electron 跨平台 API 的隐藏差异**：`setIgnoreMouseEvents` 的 `forward` 参数、`alwaysOnTop` 级别、`screen.getCursorScreenPoint()` 在 macOS 的 Retina 坐标（物理 vs 逻辑像素）都要真机验证。
4. **公证**：分发 dmg 需要 Apple Developer 账号（$99/年）+ notarization；不公证则用户要右键打开 + 关 Gatekeeper。
5. **测试**：现有 vitest 全是纯逻辑，跨平台 ✓；但窗口行为（P3/P4）无法自动化，靠真机清单。

## 6. 参考

- 上游 Edge-Drop 无 mac 支持；本计划与上游无关，纯 Trace fork 内工作。
- 平台行为决策记录在 `docs/adr/`（本计划落地后按阶段补 ADR）。
