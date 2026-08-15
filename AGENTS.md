# AGENTS.md

只放每次任务都需要的核心约束；子系统细节、历史决策、验证方法按需加载（见「文档树」）。

## 项目身份

**Trace** — 仅 Windows 的剪贴板管理器（原 Edge-Drop，已 rebrand）：悬停屏幕左边缘、hover 展开的零点击面板，原生 OLE 拖拽到任意桌面应用，带任务层与 AI 建议管道。技术栈：Electron 34 · React 18 · TypeScript 5 · Framer Motion 11 · Zustand 4 · electron-vite · vitest；koffi（全屏检测、剪贴板格式读取，upstream 引入）。

## 常用命令

| 命令                       | 作用                                                                   |
| ------------------------ | -------------------------------------------------------------------- |
| `npm run dev`            | Electron + Vite HMR 开发模式                                             |
| `npm run typecheck`      | 全量类型检查（node + web 两个 tsconfig；`typecheck:web` 只查 `src/` + `shared/`） |
| `npm run typecheck:node` | 仅 `electron/` + `shared/`                                            |
| `npm run build`          | 生产构建到 `out/`                                                         |
| `npm run package`        | 构建 + Windows NSIS 安装包到 `dist/`                                       |
| `npm test`               | vitest（44 文件 / 896 用例）                                               |
| `npm run preview`        | 预览构建产物                                                               |

- 没有 lint 脚本。验收 = `npm run typecheck` + `npm test`；UI 改动按 `docs/ui-verification.md` 走无头渲染器预览，`npm run dev` 只作最终抽查。
- `npm run dev` 会自动把本机 Chrome/Edge 里的 React DevTools 加载进 dev session（`electron/main/devtools.ts`，零依赖、仅非打包模式、失败静默降级）。**调试 renderer 优先用 F12 → React 面板**（组件树 props 直读、Hooks/Zustand 检查、Profiler 找无谓重渲染），别全靠 console.log。启动日志出现 `[DevTools] React DevTools loaded from ...` 即已加载；面板不出现 → 先确认 Chrome 装了 React DevTools 扩展。
- npm ≥ 11 默认拦截 postinstall 脚本：装完依赖先 `npm approve-scripts electron esbuild koffi`，否则 esbuild/electron 二进制缺失。
- 打包 `EBUSY` → `taskkill /F /IM electron.exe /T` 后重试。
- `npm run package` = `build:github`：无 `GH_TOKEN` 时 dist/ 产物照常生成、upload 阶段报错退出；本地验收看 dist/ 即可。
- 本环境（pi）裸 `git` 输出被干扰（显示旧状态），用 `/cmd/git` 或 `/mingw64/bin/git`。
- 涉及到设计任务，请使用 /design 技能

## 核心不变量

### 三进程 + 状态流

| 层        | 目录                          | 运行时     | 职责                                             |
| -------- | --------------------------- | ------- | ---------------------------------------------- |
| Main     | `electron/main/`            | Node.js | 剪贴板、文件 I/O、OLE 拖拽、窗口/托盘、状态中枢                   |
| Preload  | `electron/preload/index.ts` | 沙箱      | `contextBridge.exposeInMainWorld('edge', api)` |
| Renderer | `src/`                      | 浏览器     | React UI、动画、交互                                 |

- Renderer 无 Node 权限（`sandbox: true`），一切系统能力走 `window.edge`；preload 在捕获阶段全局拦截 `dragover`/`drop`，用 `webUtils.getPathForFile` 处理文件拖入（contextBridge 无法序列化 File 对象）。
- **Main 是唯一真实来源**：`electron/main/state.ts` 是运行时中枢，每次变更经 `state:items` 推送完整 `ClipboardItemDto[]`；renderer 的 Zustand store（`src/store/appStore.ts`）只是这份推送的视图缓存，动作一律经 `window.edge.*` 委托 main。不要反转：renderer 不做持久化决策，乐观更新后以 main 推送为准。

### IPC 四文件契约

新增通道必须同时改四个文件，漏一个就类型或运行时报错：

1. `shared/ipc.ts` — 契约：InvokeMap / EventMap / SendMap 之一
2. `shared/bridge.ts` — EdgeApi 接口方法签名
3. `electron/preload/index.ts` — 实现
4. `electron/main/ipc.ts` — handler 注册

typecheck 只校验签名，「声明了没注册」查不出——新增通道后确认 `handle('channel'` 存在。通道清单、领域模型与教训见 `docs/ipc-contract.md`。

## 文档树（按需加载）

- `docs/ipc-contract.md` — IPC 通道契约、任务/AI 通道清单、handler 丢失教训
- `docs/architecture.md` — 关键子系统（边缘触发器、剪贴板、ItemStore、拖拽、Alt+Tab 切换器、决策/记忆管道、设置、渲染层）+ 行为陷阱（输入框焦点 t21、userData、搜索框样式、better-sqlite3 依赖陷阱等）+ 动效/性能经验（motionLevel 动画档位、切换器 pinned/搜索模式、appIcons 磁盘缓存与预取）
- `docs/ui-verification.md` — UI 改动验证：无头渲染器预览 + `window.edge` 模拟桥（勿动真机）
- `docs/history.md` — 仓库/分支状态与历史决策（upstream 合并、已删除路径、tutorial 死链清理）
- `docs/distribution.md` — 分发体系（GitHub Releases / npm 跳板 / winget / scoop / chocolatey）+ 发版自动化与一次性上架设置
