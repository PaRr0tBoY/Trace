# DeepSeek Harness（DSH）安全与环境模型——中文入门指南

> 面向「懂技术但新手」的读者。本报告内容全部从 DSH 源码仓库中各包的 `README.md`（本项目所有目标包均 **没有** `README.zh.md`，故按规则读取同目录 `README.md`）提炼，不臆测。
> 所读包：(按阅读顺序) dsh-sandbox、dsh-sandbox-local、dsh-fs-sandbox、dsh-bash-sandbox、dsh-sandbox-policy、dsh-sandbox-windows-acl、dsh-pwsh-sandbox、dsh-pwsh-local、dsh-fs-observation-policy、dsh-permission-presets、dsh-user-approval、dsh-credentials、dsh-credentials-local、dsh-mcp-client、dsh-subprocess、dsh-subprocess-local、dsh-terminal、dsh-token-meter、dsh-persona、dsh-fs、dsh-storage；补充 dsh-tool-bash、dsh-tool-fs、dsh-fs-local、dsh-shell（用于讲清 escalation/批准/文件观察的真实体现）。

---

## 主题全景

DSH 把「agent 的执行世界」拆成若干**能力缝（capability seam）**：每个能力（文件系统 `ctx.fs`、shell 执行 `ctx.shell`、子进程 `ctx.subprocess`、终端 `ctx.terminals`、凭证 `ctx.credentials`）都有一个**服务定义包**（只定义「接口契约 + 统一词汇表」，不碰实现）和若干**服务提供者包**（具体后端）。安全策略以「分层、可插拔」的方式叠在这些缝上，而不是写死在某个实现里。

### 安全/环境的总骨架

**1. 沙箱（sandbox）——文件效果的三档模式**

所有沙箱共享同一个 `SandboxMode` 词汇表，且**只管「文件效果」**（file effects only），不管网络/进程可见性/syscall/设备/凭证：

| 模式 | 文件效果 | 说明 |
|---|---|---|
| `read-only` | 任何地方都不可写（/dev 只放行 `/dev/null`，`>/dev/null` 仍可用） | **默认、fail-safe** |
| `workspace-write` | 只允许在 `workspaceRoot` 工作区根 + 平台临时目录下写 | 每个 session 一个不可变的 `cwd` 根 |
| `danger-full-access` | 不设防，直接透传 | 是「显式无沙箱模式」，不是更宽的沙箱 profile |

「同世界 confinement」：沙箱后端共享宿主机的文件系统与内核（Linux 用 bwrap / Landlock，macOS 用 Seatbelt `sandbox-exec`，Windows 用 ACL 受限令牌），**不是容器/microVM/远端执行器**；容器等属于替换整个能力缝，而不是在此加一个 provider。策略是**每调用（per-call）**随调用携带的，不是 provider 持有的——两个消费者可以在同一时刻用不同模式 confound，一次被批准升级（escalation）也只是用更宽 policy 再调一次。若无可用后端，`confine()` 直接抛 `SANDBOX_UNAVAILABLE`（fail-closed，绝不静默无沙箱运行）。

**2. 权限分级与用户批准（approval）**

- `ctx.sandboxPolicy` 是**唯一的策略裁决者**：部署默认 `mode` + 兜底工作区根，加上每个 session **持久、不可变**的 `cwd` 根与**可切换的 mode 覆盖**。生效顺序：`显式批准的 mode（本次调用） > 本 session 最近一次 sandbox/mode 事件 > 部署默认`。mode 切换就是追加一条 log-only 的 `sandbox/mode` 事件（`setSandboxMode` 是唯一的写路径）。
- `ctx.approval` 是**一次性、channel 无关**的批准缝：`request()` 只返回 `allowed-once / rejected / cancelled / unavailable`，缺 answerer 时 fail-closed，批准只作用于请求的那一个动作。`ApprovalPolicy` 只有 `'ask'` 与 `'never'`；`'never'` 在交互分发前直接拒绝。批准事件 `approval/asked`/`approval/decided` 只进审计日志，模型只看到「被批准的消费者」的结果。
- `dsh-permission-presets` 把 `sandbox/mode` 与 `approval/policy` 打包成人可见的预设：`workspace-write`（= mode + `ask`）与 `danger-full-access`（= mode + `never`）。`set(session, name)` 只在有效值变化时调用各旋钮的 setter。session 创建时把这些钉进 session，之后改动不影响已存在的 session。

**3. 凭证（credentials）管理**

`ctx.credentials` 三大原则：**配置只存「对秘密的引用」、绝不存秘密**（配置里写 `apiKeyEnv: DEEPSEEK_API_KEY`，值存在凭证 provider）；**每次操作重新 resolve**、绝不跨操作缓存（所以改凭证下一次请求立刻生效，无需重启）；**空字符串 = 不存在**（resolve 跳过、describe 报未配置，空值永远不会伪装成已配置的秘密）。`credentials-local` 提供四层来源、一层诚实优先级：进程环境 `env`（只读、总是赢）> `$DSH_HOME/.credentials.yaml`（可写）> `<cwd>/.env`（project-env）> `$DSH_HOME/.env`（user-env）。文档权限 `0600`、目录 `0700`。

**4. MCP 接入外部工具**

`dsh-mcp-client` 既是 client 又是桥：连外部 [Model Context Protocol](https://modelcontextprotocol.io/) 服务器，把其工具注册到 `ctx.tools`，模型以 `mcp__<serverName>__<rawName>` 命名调用。支持 stdio 与 streamable-http 两种 transport，带自动重连重发现。只用工具（tools）能力；Resources/Prompts 暂无消费者。

---

## 逐包要点

### 沙箱体系

**@deepseek-ai/dsh-sandbox** — 进程沙箱的服务定义。
- 核心：持有 `ctx.sandbox.confine(argv, policy)` 契约与共享词汇表：`SandboxMode`（只谈文件效果）、`SandboxEnforcement`（`full`/`partial`，按内核 ABI）、`SandboxExecutionPolicy`（完整的每调用 mode + workspace 根）、`SandboxPolicy`（其受限子集）、fail-closed 的 `SANDBOX_UNAVAILABLE`。`confine()` 返回「要 spawn 的 argv」让你替掉自己的——被 wrap 的进程及其所有后代会受约束。
- 关键：**只依赖 cordis，绝不依赖后端**；如果无可用后端就抛错，绝不把 argv 无沙箱透传。
- 「同世界」边界：`workspaceRoot` 指真实托管目录；先解析 workspace 身份再做词法标准化（含 `symlink/..` 的 cwd 授予 chdir 实际落点，而非无关的词法父目录）。容器/microVM/远端执行器不是本缝的后端，它们替换 `ctx.shell`/`ctx.fs` 整条能力缝。
- 二开提示：若要新增一种平台沙箱机制，实现此缝的 provider；策略是每调用选择的，不要全局固定 backend。

**@deepseek-ai/dsh-sandbox-local** — 沙箱缝的本地实现。
- 核心：按平台选择并缓存一个 runner——Linux 偏好可用的 `bwrap` 再 Landlock，macOS 用 Seatbelt，Windows 用 ACL 受限令牌 runner。多候选按序探测。unsupported/不可用全部 fail-closed `SANDBOX_UNAVAILABLE`，绝不静默无沙箱运行。每次 wrap 带结构化 runner 失败规则，让消费者区分「沙箱坏了」与「命令失败」。
- Windows 细节：每个 workspace 保留一个确定性的写 SID 与常驻 ACE（复用缓存）；每个 live session/workspace 对则分配一个随机私有临时目录 + 独立 SID + 可撤销 ACE。崩溃残留既不能阻塞也不能授权续跑 session。
- 二开提示：选择机制按 provider 生命周期缓存——装卸或修复 runner 后必须重载插件才会重新选择。`runnerCommand` 是操作符断言，假定自定义 runner 诚实实现了 bwrap 兼容 profile。

**@deepseek-ai/dsh-fs-sandbox** — 施加沙箱的 fs 后端（`SandboxedFileSystem`）。
- 核心：继承 `LocalFileSystem` 的全部文本机制，只加一个**每调用的 MODE 围栏**在 `writeText`/`editText` 上；**读取一律放行（所有模式都可读）**。`read-only` 拒绝一切变更（结构化 `FS_SANDBOX_DENIED`）；`workspace-write` 只在目标规范化到可写根（工作区 + `/tmp`/`os.tmpdir()`）之下放行，且共享同一个 `writableRoots` 函数（与 Seatbelt profile 同源，防漂移）；`danger-full-access` 不做围栏。
- 威胁模型：这是**可信代码对模型控制路径做的一次策略检查（policy fence），不是内核边界**；残留 TOCTOU（换 symlink 祖先）靠写前立即再规范化来收窄。内核级隔离不可信代码仍是 `ctx.shell` 的活。
- 二开提示：`ctx.fs.sandboxMode` 报告 confining 时，write/edit 才暴露 `sandbox_permissions`/`justification` 升级字段并通过 `ctx.approval` 解析批准重试。

**@deepseek-ai/dsh-bash-sandbox** — 沙箱消费型的 shell executor（bash 侧）。
- 核心：用在 `-c` 命令前，把 `['bash', '-c', command]` 交给 `ctx.sandbox.confine()`。**拒绝是「结果事实」**：被拒运行会在结果上盖 `sandbox.denied: true`（按后端自己的 denial 方言从 stderr 尾保守推断：bwrap EROFS / Landlock EACCES / Seatbelt EPERM）；每次被 confound 的运行也带 mode 与 enforcement。运行前拒绝只有在「runner 路径或 syscall 命中特定 ENOENT/EACCES」才归属 runner。
- 部署回退：`ctx.sandboxPolicy` 为每个工具调用解析完整策略；被批准升级只改模式，session 根仍附着。能力事实 `ctx.shell.sandboxMode` 让工具层只在施加时广告升级。
- 模型看到的 marker：`[sandbox: file access denied under <mode> mode]`、`[sandbox: escalation available — retry this exact command once with sandbox_permissions …]`、`[sandbox: the sandbox runner itself failed …]`。
- 二开提示：**只防文件效果**——网络与进程可见性不设防；`danger-full-access` 故意绕过 `ctx.sandbox`。

**@deepseek-ai/dsh-pwsh-sandbox** — bash-sandbox 的 PowerShell 孪生。
- 核心：每条命令 `pwsh -NoLogo -NoProfile -NonInteractive -Command <command>` 都经 `ctx.sandbox` 施加。Windows 上解析到 ACL runner 链，Linux/macOS 上 bwrap/Landlock/Seatbelt。模式+工作区根**不是本包配置**，是每次调用从 `ctx.sandboxPolicy` 顺过来的。`danger-full-access` 走本地 executor，结果带 `sandbox: { mode, denied: false }`。
- 局限：Windows 读不受限（只有写被 restricte）；read-only 仍是 partial（令牌必须保留 Everyone）。

**@deepseek-ai/dsh-pwsh-local** — 本地 PowerShell provider。
- 核心：每次调用一个全新、无状态的 `pwsh -Command`；`-NoProfile` 确保无 profile/无 banner 干扰。命令串作为**单个 argv 元素**传给 `-Command`，PowerShell 自己解析，无 shell-quoting 层。注入 UTF-8 输出 preamble（`-Command` 域下 `param(...)`/`#requires`/`using` 有前导限制）。
- 安全相关：它**自身不设防**——总是以 harness 进程的完整权限运行；需要 confound 就换沙箱 executor。它的进程机制继承自子进程服务（凭证 scrub、kill 升级、spill）。
- 二开提示：可配 `pwshPath` 解析优先级（显式 > pwsh7 安装位 > PATH 里的 Store 安装 > pwsh5.1 兜底）。

**@deepseek-ai/dsh-sandbox-policy** — 沙箱策略的家（`ctx.sandboxPolicy`）。
- 核心：**唯一**的沙箱策略裁决者，防止 fs 工具 / 一次性 bash / 持久终端各自测出不同根而「漂移到分裂世界」。所有施加能力的后端消费同一个整体解析后的策略。
- 配置：`mode`（部署默认，默认 `read-only`，加载时校验，fail-safe）；`workspaceRoot`（agentless/无 cwd 调用时 `workspace-write` 可在其下写的兜底，默认 `process.cwd()`）。正常 agent 调用用 session header 里不可变的 `cwd`。
- 核心方法：`resolve({ session?, mode? })`（一次解析一条完整每调用策略）、`setSandboxMode(session, mode)`（唯一的模式写路径，追加一条 log-only 事件）、`effectiveSandboxMode(events)`、`defaultMode`/`workspaceRoot`。
- 模型看到的 `sandbox:policy` 运行时上下文：三种模式的确定性文案（read-only / workspace-write 带工作区根 / danger-full-access）。
- 二开提示：策略是 log-only 事件回放持久的（重启后靠重放恢复）；两个 session 互不看到对方状态。临时区域被刻意只做泛化描述（不同后端给不同平台临时区）。

**@deepseek-ai/dsh-sandbox-windows-acl** — Windows 写限制沙箱后端（koffi 移植自 POC）。
- 核心机制：把调用者令牌复制成 `WRITE_RESTRICTED` 令牌，其 restricting SID 携带独立的工作区与私密临时能力。Windows 只在「普通访问 AND restricting-SID 交集」都允许时才给写。workspace SID 从规范化工作区路径**确定性**推导（同一 machine 每 workspace 只 materialize 一次 ACE）；每个 live session/workspace 对则给随机临时目录 + 独立 SID（session 之间互不继承 temp 权限）。
- 这是 `enforcement: 'partial'` 的 rung，原因：令牌必须保留 Everyone（外部对象给 Everyone 写的对象仍可写）；NTFS 硬链接是「文件对象」别名而非路径别名。
- 已验证边界（受限令牌固有）：Everyone 那部分写是 ambient 权威；读、网络、进程可见性不受限（`WRITE_RESTRICTED` 只交截写）；无 console 隔离；`whoami`/token 检查 cmdlet 报错（诊断噪音）。`read-only` 无法单靠此机制表达，需配读侧策略。
- 二开提示：ACL 授权是**常驻目录变更**——进程中途死了也会留下（workspace ACE 故意常驻永不撤销，是复用缓存）；临时 ACE 由 `dispose()` 撤销。清理必须走本模块（POC 文档里的 `icacls /remove` 在此平台报 `ERROR_NONE_MAPPED`）。一个 sandbox 实例一个 workspace（写 SID 就是 allowlist 单位且就是 workspace 身份，复用会加宽两边授权）。FAT 卷无 ACL 支持、作为授权根会失败、作为外部目标则两者模式下都可写。
- 重要：受限令牌下 `stdio: 'pipe'` spawn 会 EPERM（命名管道默认 SD 模板问题）——被 confound 的进程**无法通过管道捕获孙子输出**；工具要捕获输出就不能 confound。
- PowerShell 语言模式分叉：`read-only` 下打不出 AppLocker probe 文件，pwsh 保守进 ConstrainedLanguage（`Add-Type`、非核心 .NET static、COM、反射失败）；`workspace-write` 有私密 temp 能力则 probe 完成、保持 FullLanguage。

### 观察策略与权限预设

**@deepseek-ai/dsh-fs-observation-policy** — 文件系统观察策略插件。
- 核心：在 `ctx.fs` 之上加「观察到的存在/缺失 + 先读后改 + 版本守护的写/改」——通过 `fs/*` **事件闸**传达，**不是**方法服务；它不注册任何 `ctx.fsPolicy` 服务。三件事：`fs/write-intent`（未见/观测缺失 → `createIfAbsent`；观测存在 → `replaceIfVersion`，带观测版本）、`fs/edit-intent`（未见 → `FS_NOT_OBSERVED`；观测缺失 → `FS_NOT_FOUND`；观测存在 → `{ version }` 作为 CAS 基础）、`fs/observed`（`WeakMap.set` 记录 present/absent，纯副作用）。
- 理念：观测状态是「上次观测记录」；**新鲜度靠 provider 的 CAS**。单槽、先注册先赢；不是可组合的授权链（分层授权/审计/沙箱拦截应放在 `tools/execute` 瀑布上）。移除插件 → 工具回落到裸 provider（无条件写/改）——事件闸的意义就是「能优雅加/删策略」。
- 二开提示：观测状态**不跨 session 持久**，resume 后要先重读再受守护的写/改；无 agent session 的动作永远不满足策略（写永远只会 `createIfAbsent`）；直接 `ctx.fs.read` 不发射 `fs/observed`。

**@deepseek-ai/dsh-permission-presets** — 面向用户的权限预设。
- 核心：`ctx.permissionPresets`，把 `sandbox/mode` 与 `approval/policy` 打包成命名预设，默认两个：`workspace-write`（+`ask`）与 `danger-full-access`（+`never`）。`set(session, name)` 记录 log-only 事件，再在有效值变化时调用各 setter（选择事件在旋钮事件之前，保留用户意图）。`current(events)` 优先仍匹配的记录选择，否则表格首项，否则 `custom`（客户端可显示 `custom` 但不能选择）。
- 需要 confining 的 `ctx.shell` executor 与 `ctx.approval`；表格项名为 `custom` 会在加载时抛错。
- 二开提示：预设表是**进程级**，改可用预设须重载插件；删除被引用的默认预设会导致 Settings 注册失败。只打包两个旋钮（mode+approval），不包 agent/profile 选择。

### 批准与凭证

**@deepseek-ai/dsh-user-approval** — 一次性批准缝。
- 核心：`ctx.approval.request(req)` → `allowed-once / rejected / cancelled / unavailable`。缺 answerer 或失败 fail-closed；grant 只作用于被请求的动作。每个请求必须属于一个打开的 agent turn；追加 `approval/asked` 与 `approval/decided` 审计对，模型只看到被批准的消费者结果。aborted → `cancelled`；审计追加失败在提交前拒绝（绝不返回未记录的决策）。
- `ApprovalPolicy` 是 `'ask'` 或 `'never'`；有效值是最后一条 `approval/policy` 事件，回退到 config；`'never'` 在交互分发前拒绝。answerer 是 `approval/request` 瀑布监听器，agent 作用域的监听器只看该 agent 的请求；每个部署只组合一个 terminal answerer（兄弟监听器顺序不是策略优先级机制）。`'ask'` 时配置的 answerer 可能被征询，缺可用 answerer 就 fail-closed。
- 二开提示：请求**不带工具参数**——answerer 看到工具名、理由、可选 call id；ACP 机器通道要 call id，无 call id 的请求被委派走。服务本身**从不**弹窗问人；headless/组合不全的部署 resolve `unavailable` 并 fail-closed。

**@deepseek-ai/dsh-credentials** — 凭证服务定义。
- 核心：三条教条（配置只引不存、每操作 resolve、空值即缺失）。`credentialRef(name)` 构造带 brand 的引用；`resolve(ref)` 返回 `{ value, source } | undefined`；`describe(ref)` 返回 `{ configured, source?, writable }` 永不含值；`set`/`unset`。set/unset 的 shadowing 规则（当只读源——进程环境——正供应此引用时，写会看似成功实则仍读 shadow 值，因此直接拒绝，fail-loud）。
- `credentials/updated` 在 provider 管理源提交变更后触发；环境变化不可观测、永不发事件。消费者不需要事件（每操作重 resolve），它只是给配置 UI 刷新 badge 用。
- 二开提示：引用是**环境变量形状**——一个扁平 POSIX 标识符命名空间；无 `list()`（配置面从 settings schema 学引用）。可留 keyring/helper-command/KMS provider 位置；远端 settings provider 不需要携带秘密。

**@deepseek-ai/dsh-credentials-local** — 文件型凭证 provider。
- 核心：四层来源、一层优先级（进程环境 `env` 只读总是赢 > `$DSH_HOME/.credentials.yaml` 可写 > project `.env` > user `.env`）。文档是「凭证引用→值」的裸 YAML mapping，**只许放凭证**：非 mapping 根、非 POSIX 标识符键、非字符串值、空串、重复键、畸形 YAML 全部 loud 拒绝（boot 时；热重载时 warn 并保留最后一个好快照）。写时先重读、原子提交（`0600` 文件/`0700` 目录），注释与未动条目格式保留。
- 安全边界：权限挡**其它 OS 用户，不是模型**——工具进程（bash、fs 工具）与 agent 同用户，`workspace-write` 文件策略只 confound 写不限读，所以能读此文件。harness 能守的更窄：**从不把文档的解析路径交给模型**，也**不把它加载进进程环境**——拿到值需要刻意读一个 agent 没被告知的路径。这是自愿（discretion）不是边界；要真防 agent，得靠「模型进程根本无法读」的 OS keychain provider（被推迟，与本地 provider 并列成兄弟包）。
- 二开提示：被 launch 环境冻结的环境快照（launch-environment）只有在产品 CLI 启动下才用；其它 embedder 组合只有继承环境。改环境来源凭证要重启（快照启动时冻结）。

### MCP / 子进程 / 终端 / 计量

**@deepseek-ai/dsh-mcp-client** — MCP client 桥。
- 核心：每台 MCP 服务器一个插件实例；连上后 `listTools()` 并把工具注册到 `ctx.tools`，模型见 `mcp__<serverName>__<rawName>`。transport 支持 `stdio` 与 `streamable-http`。公开名规范化到 DSH 函数名契约（64 字符 `[A-Za-z0-9_-]`），改名时追加确定性 12-hex 哈希防碰撞。名字是 `(serverName, rawName)` 的**纯函数**——连接顺序、重同步、其它服务器绝不会给工具改名。
- 行为：启动注册失败 `failOnStartupError: true` 时拒绝激活，否则无工具激活并打日志；`notifications/tools/list_changed` → 重同步；callTool 带 timeout+abort；断线/崩溃由 supervisor 指数退避重启并重发现（`reconnect.*`），`maxAttempts` 连续失败后卸载该服务器工具并停止重连，直到 HMR 重载或 host 重启。工具调用只把 raw 名字发到线上，公开名永不上传服务器。
- 二开提示：工具是唯一桥接的 MCP 能力（Resources/Prompts 暂无消费者）；文本块换行连接，image/audio/resource/不支持块在模型上下文里变占位符（原生多媒体是 lossy）。启动超时继承 MCP SDK 60 秒默认。

**@deepseek-ai/dsh-subprocess** — 子进程缝（`ctx.subprocess`）。
- 核心：抽象 `SubprocessRuntime`，暴露可执行查找、托管 spawn、一个终端进程原语。词汇覆盖 raw/collect 的 stdio、进程与终端句柄、退出事实、树/session 清理、托管 `DSH_*` 环境命名空间。`spawn()` 立即返回活句柄、`done` 在关闭时带退出事实结算（`SubprocessOutcome` 无输出、无 cause 分类）；spec 完全显式（argv 从不被 shell 解释——要 shell 自己传 `['bash','-c',...]`）。
- 终止是**树范围**（POSIX detach 组 / Windows `taskkill /T`）；`terminate()` 是唯一终止动词，SIGTERM→grace→SIGKILL 升级。`scrubbedParentEnv()` / `SENSITIVE_ENV_PATTERN` 是**唯一共享 scrub 定义**（去掉 `*KEY*/*PASSWORD*/*SECRET*/*TOKEN*` 与所有 `DSH_*` 名字；显式 env 在 scrub 后 merge）。
- 二开提示：SDK 管理的 spawn（自己内部 spawn）走不过本服务，但可 import `scrubbedParentEnv` 保证环境策略单源。teardown ladder 由消费者自己写（缝只给信号动词 + 树活性等待）。

**@deepseek-ai/dsh-subprocess-local** — 子进程缝本地实现。
- 核心：解析本地可执行文件、以显式 stdio spawn 分离进程树、通过 `node-pty` + 平台进程检查实现终端进程。无 config——所有 disposition/限额/终端尺寸/grace/目录都来自调用它的能力缝。collect 模式保留内存 TAIL 超 cap，全流可选追到私有临时文件（spill；`0600` 随机名 / `0700` 私密目录）。凭证 scrub + 显式 merge（如上）。
- 同步 host-exit 终结：Node `exit` 事件里强杀所有仍在 live 集的普通树与可观察终端 session（SIGKILL / `taskkill /T /F`），无 promise 无 timer，保留宿主退出码与诊断。
- 二开提示：崩溃/异常路径有死角——`process.exit()`、默认 uncaught exception/rejection 会 emit 同步 `exit`；**未经处理的 SIGTERM/SIGINT/SIGHUP 默认 OS 处置绕过该事件**（需装 handler）；SIGKILL、OOM、崩溃、断电等需要外部 supervisor。scrub 是名字启发；`*PASSPHRASE*` 之类会透传。完成的 spill 文件不删除，在 OS tmpdir 累积。

**@deepseek-ai/dsh-terminal** — 持有者作用域的持久 PTY 缝。
- 核心：`ctx.terminals`（`TerminalSessionService`），铸造不透明 session id，经命名后端（named backends）创建，每个操作都围栏到当前 live 的 `Agent` 拥有者，agent 或服务 dispose 时等后端 quiescence。一个 session 同一时刻最多一个 live send 操作；`kill()`/dispose 只在后端捕获的进程树 quiescent 后 resolve。`session_exit` 描述顶层 PTY 进程，不是任意前台命令。
- 缝里**没有** node-pty/sandbox/工具 schema/prompt/任务/终端渲染策略——实现自管终端机制，消费者自管模型呈现。
- 二开提示：session 进程级、harness 重启不恢复；跨 agent 共享刻意不存在。

**@deepseek-ai/dsh-token-meter** — 重放感知的 token 计量。
- 核心：单例 `ctx.tokenMeter`，从持久日志每 session 推进一个隔离 fold。**无设置**，用固定启发式：每 token 四个字符 + 结构开销（角色/块/请求 envelope）；任何 key 都拒收——精确容量属 LLM adapter（`ctx.llm.resolveModelInfo().context`）。`measure(session, requestHeader?)` 在某个已消费日志修订返回请求压力与当前定价表面；`estimateMessage(message)` 给一条消息定价。provider 用量只有当「最新成功调用的合法 envelope 匹配所测 envelope 且 total 不低于完整启发式锚点」才复用；否则全盘用启发式估算。
- 三种 session 投影（组合提供 `ctx.sessionProjections` 时）：`tokenUsage`（uncachedInput/output/cacheRead/cacheWrite）、`contextPressure`（pressureTokens + projectedTokens + contextWindow）、`contextBreakdown`（system/tools/message heuristic tokens）。**占用是刻意近似**，不是账单或门控输入——harness 里没有任何东西据此做决策，compaction 读 `measure()` 而非投影。
- 二开提示：`projectedTokens` 是「下一个请求的 prompt 会花多少」，用于补偿 compaction 对 `pressureTokens` 的遮蔽。CJK 文本与 JSON schema 在四字符一 token 下**低估严重**，只可作近似构成，不可当总数。

### Persona 与文件/存储抽象

**@deepseek-ai/dsh-persona** — agent 人格作为可组合的一行。
- 核心：可以 shadow（覆盖）部署人格，或 `complete: true` 时接管完整 system prompt。`text` = 人设散文，渲染成 `deployment:persona` 段（order 0）；`complete` 是「组装后把它恢复成唯一 system-prompt 段」（无任何身份/工具指导/监听器能再追加 prompt 文本）；`includeRuntimeContext` 默认 true，关闭则丢弃本作用域所有运行时上下文快照（sandbox policy、approval policy、delegation 等）。
- **仅限作用域内**：在 agent scope 外挂载会与注册表自己的 `deployment:persona` 撞车而 loud 失败（这是特性不是限制——部署人格已有拥有者；此行的意义就是替某个 agent shadow 它）。在 preset 组合内部挂载，preset 挂载供给 agent scope。
- 二开提示：对 agent 生命周期前缀稳定——挂载一次、文本不变；不同 preset 的两个 agent 从该段起建立不同前缀。`text` 是模板，`{{…}}` 组在渲染时（非组装时）严格对已注册 prompt 变量解析。

**@deepseek-ai/dsh-fs** — 文件系统服务定义（`ctx.fs`）。
- 核心：定义存储原语——resolve、canonical 进程路径与 file URI、测试包含（contains）、整段/流式文本、有界裸字节、列出/查 metadata、原子写、字面编辑——**不谈 HOW**。两次变更（`writeText`/`editText`）的版本守护是**可选**的，所以裸 `ctx.fs` 本身就是一个完整、无约束的存储缝。这个包还拥有 `fs/*` 策略事件词汇表。
- 十二个原语：`resolve / processPath / fileUrl / contains / stat / lstat / readText / streamText / readBytes / listDir / writeText / editText`。关键语义：`targetKey`/`version` 是**带 brand 的不透明 id**，消费者不得解析——只有 `displayPath` 给模型/UI 输出。写是原子的（temp 文件 + fsync + 发布）；守卫 `createIfAbsent` 用硬链 no-replace 发布；`editText` 的字面匹配是单临界区（版本守卫 + 字面匹配 + 原子重写必须一起）。
- 错误：`FsError`（extends `HarnessError`）带稳定 `FsErrorCode`（`FS_NOT_FOUND / FS_NOT_DIRECTORY / FS_NOT_TEXT / FS_NOT_REGULAR_FILE / FS_TOO_LARGE / FS_PERMISSION_DENIED / FS_IO_ERROR / FS_STALE_VERSION / FS_NOT_OBSERVED / FS_AMBIGUOUS_EDIT / FS_EDIT_NOT_FOUND / FS_ABORTED`）。
- 二开提示：只文本变更（二进制拒 `FS_NOT_TEXT`）；**无 delete/rename/move/copy/watch**（工具层的 glob/grep 在 `dsh-tool-fs-search`）；`fs/observed` 等事件只在工具/策略之间传词表 + 不透明 object actor，不带模型概念。

**@deepseek-ai/dsh-storage** — 非 session 数据的存储中枢（`ctx.storage`）。
- 核心：命名后端注册表 + 挂载的数据形态设施。中枢**不做 IO**——后端owned media，数据形态 owned semantics。`ctx.storage.backend`（name→backend 表，可并排挂 json/sqlite，哪个后端服务某消费者由消费者自己配置，不是 hub 全局选择）；`ctx.storage.mount(form, facility)` / `ctx.storage.form(form)`（数据形态可 merge；`domain` 形态达到 `ctx.storage.domain`）。`kv` 是当前唯一 facet。
- 二开提示：读取未挂载的形态会 `form-not-mounted` loud 失败；`kv` 目前只有一种数据形态要实现。

---

## 新手易漏点

1. **沙箱只管文件效果，绝不是通用安全沙箱。** `SandboxMode`（read-only/workspace-write/danger-full-access）只约束**写**；**读、网络、进程可见性、syscall、设备、凭证一律不设防**（`dsh-sandbox`、`dsh-bash-sandbox`、`dsh-sandbox-windows-acl` 都反复强调）。Windows 的 `WRITE_RESTRICTED` 令牌尤其只是「写限制」，`read-only` 无法单靠它表达、还因必须保留 Everyone 而实质是 `partial` 而非 full。想要网络策略/读限制/凭证隔离，得另外的机制。

2. **「同世界」约束 + fail-closed，容器不是沙箱 provider。** 所有本地沙箱共享宿主文件系统与内核，`workspaceRoot` 指真实主机目录；容器/microVM/远端执行器**不是** `dsh-sandbox` 的后端，而是整个替换 `ctx.shell`/`ctx.fs` 能力缝。无可用后端时 `confine()` 抛 `SANDBOX_UNAVAILABLE`，绝不静默无沙箱运行——但这也意味着有些环境没有前端沙箱可用，得靠 `danger-full-access` 或自备后端。

3. **批准是「一次性 + 升级（escalation）」模型，且只对拿到的具体动作成立。** `ctx.approval` 只有 `allowed-once`，**没有** `allow-always`/记住规则/撤销/授权存储；session 级策略只有 `ask`/`never`。被批准升级只改「这一次调用的 mode」，session 根仍附着、一个 turn 内只能把同一条命令重试一次。`'never'` 或 `unavailable`（缺 answerer）都 fail-closed。请求**不携带工具参数**，answerer 只看到工具名+理由——别指望在 approval 里做精细参数级授权。

4. **凭证的「引用/值分离」与「每操作 resolve」是新玩家最容易破坏的两条规矩。** 配置里只能写 `apiKeyEnv: DEEPSEEK_API_KEY` 这类引用、绝不写明文；值必须放 provider（本地是 `$DSH_HOME/.credentials.yaml`，`0600`）。每次操作都重新 `resolve`、绝不缓存——这就是「改 key 立即生效、不用重启」的机制。**空字符串 = 未配置**，所以文档里空值会被直接拒收（`unset` 删键，不是置空）。还要记住文件权限只挡其它 OS 用户、**挡不住模型**（agent 进程与工具同用户）。

5. **观察策略（read-before-edit）的「版本新鲜度」≠「看过整个文件」。** `dsh-fs-observation-policy` 用事件闸实现**先读后写/改**，但它授权的是「文件在观测版本未变」，任何窗口读都授权整文件覆盖——这是刻意的「弱于完整视图」。且观测状态不跨 session 持久（resume 后要重读）、无 agent session 的动作永远不满足策略。另一个容易漏的是：加/删这个策略插件是「优雅可逆」的——卸载它，工具就回落到**无条件的裸写/改**，所以别只靠它当唯一的写保护。
