# DSH 能力扩展体系：#skill 与工具系统# 中文入门精读

> 素材来源：`@deepseek-ai/dsh` 仓库下 13 个包的中文 README（`README.zh.md`）原文档。聚焦 skill 体系与工具系统二大主题。
> 目标读者：懂技术但新手。以下内容全部从真实文档提炼，不做推测。

---

## 主题全景

DSH（DeepSeek Harness）的能力扩展体系由两个正交的观念组成：**skill**（技能）和 **tool**（工具）。两者常常被混为一谈，但它们的本质完全不同。

### tool（工具）= 内置能力，一段可执行的代码

- **tool 是 agent（智能体）能调用的一个具体操作**。每个工具是一段注册在 `ctx.tools` 上的代码，带一个 JSON Schema（参数描述）、一个执行器 `execute()`，以及一个输出声明 `output { schema, render }`。
- 工具按**名称**暴露给模型，模型通过函数调用（原生 Function Calling）或 Code Mode 的方式去调用它。工具决定"**agent 能做什么**"（读文件、跑命令、搜网页、问用户）。
- 工具由**插件**提供。一个工具插件（如 `dsh-tool-bash`）本质是一个 Cordis 插件，调用 `ctx.tools.register()` 把工具注册进运行时。
- 工具的 schema、参数校验、执行、结果渲染、超时、并发安全都由工具定义承载；DSH 提供一套完整的"工具执行流水线"（`tools/pre-execute` → guards → `tools/execute` → `tools/post-execute` → `finalizeContent` → `tools/result`）。

### skill（技能）= 可复用指令包，一段给模型的文本

- **skill 是"什么时候该怎么做"的说明文档**。它的主体是 Markdown 格式的指令文本（body），再加上一项 frontmatter 元数据（`name`、`description`、`whenToUse`、调用策略等）。
- skill **没有可执行代码**——它只是告诉模型在匹配到某个场景时应按照哪套流程去做。skill 决定"**agent 遇到这种情况该怎么想、怎么做**"。
- skill 由**提供方（provider）**扫描发现，并在会话开头以 `skill-catalog` 目录（`<available_skills>` 列表）的形式注入模型上下文。模型"读到摘要→判断匹配→调用 `skill` 工具把完整指令加载进来→按指令执行"。
- skill **加载**通过 `skill` 工具完成：工具返回 `<skill_content>`（含 `name`、`resourceBase`、正文）。目录只放摘要（`name` + 描述，有长度上限），正文绝不放进目录。

### 一句话对比

> **tool 是"手"**——执行动作、改变世界（读文件、跑命令）；**skill 是"脑中的操作规程"**——只在匹配场景时被"读"进上下文，指导模型如何行、何时该用哪个 tool。

| 维度 | tool（工具） | skill（技能） |
|---|---|---|
| 本质 | 可执行代码（schema + execute） | 指令文本（frontmatter + body） |
| 注入点 | 作为函数定义给模型 | 先目录摘要，再按需加载全文 |
| 作用 | 让 agent 能执行某种操作 | 让 agent 知道特定任务怎么做 |
| 是否有代码 | 有（TypeScript 写的执行器） | 无（纯 Markdown 说明） |
| 注册机制 | `ctx.tools.register()` | `ctx.skills.registerProvider()` / `ctx.skills.register()` |
| 谁来加载 | 模型按名直接调用 | 模型先看目录，再经 `skill` 工具提全文 |
| 典型包 | dsh-tool-bash、dsh-tool-fs 等 | dsh-skill、dsh-skill-filesystem、dsh-tool-skill |

### skill 的定义与加载链路（一条完整链路四个包）

1. **`dsh-skill`** — skill 注册表（`ctx.skills`）本身。它不关心 skill 来自哪里，只是管理"哪个 cwd/scope 下有哪些 skill"。从 root 支持注册多来源。
2. **`dsh-skill-filesystem`** — 本地文件系统**提供方**。扫描各 skill 根目录，解析 `SKILL.md`，把发现结果注册进 `ctx.skills`。它同时负责**文件系统 watcher**（监视 skill 目录变化并触发失效刷新）。
3. **`dsh-tool-skill`** — 面向模型的"目录 + 加载器"。它在每次 `agent/pre-step` 把 skill 摘要渲染成 `skill-catalog` 目录放进会话；并提供 `skill` 工具，模型调用它把某 skill 的完整 `<skill_content>` 加载进来。
4. **`dsh-tools`** — 工具注册表/执行流水线。skill 的加载最终也是通过这个 `skill` 工具跑在这套流水线上。它是所有工具（含 skill 加载器）的运行时底盘。

### 常见工具职责清单（本主题精读包）

| 工具 | 提供包 | 一句话职责 | 关键参数 |
|---|---|---|---|
| `bash` | dsh-tool-bash | 前台执行 shell 命令；支持后台任务、沙箱升权 | `command`、`workdir`、`timeoutMs`、`run_in_background`、`sandbox_permissions` |
| `bash` | dsh-tool-bash-persistent | 复用一个按 agent 隔离的持久 PTY shell，状态跨命令保留 | `command`（复用同一个 shell） |
| `read`/`write`/`edit`/`read_image` | dsh-tool-fs | 带行号读取、整文件写、字面量替换编辑、读图 | `file_path`、`offset`、`limit`、`replace_all` |
| `glob`/`grep` | dsh-tool-fs-search | 用内置 ripgrep 按路径模式/正则发现文件 | `pattern`、`path`、`include` |
| `web_search`/`web_fetch` | dsh-tool-web | 联网搜索与抓取 URL 内容 | `query`、`url` |
| `str_replace_editor` | dsh-tool-str-replace-editor | 另一套基于 `ctx.fs` 的编辑器：view/create/str_replace/insert | 绝对路径、字面量 |
| `todo_write` | dsh-tool-todo | agent 的完整任务列表（整体替换，无部分更新） | `todos[{content,status}]` |
| `ask_user_question` | dsh-tool-ask-user | 向用户提出简洁问题并收集回答 | `questions[]`、`id`、`options` |
| `skill` | dsh-tool-skill | 加载一个 skill 的完整指令正文 | `name` |
| `cordis_inspect`/`cordis_define`/`cordis_run`/`cordis_stop`/`cordis_undefine` | dsh-tool-cordis | 自引用操作当前 DSH 进程里的实时 Cordis 运行时，热注册/运行/停掉一个动态包 | `name`、`what`、`code`、`client` |

---

## 逐包要点

### 1. `dsh-skill` — skill 注册表（`ctx.skills`）

**职责一句话**：skill 的"中央登记处"，管理各来源 skill 的发现、合并、胜出与运行时的嵌入式注册。

**核心概念/文件**：
- 提供方通过 `ctx.skills.registerProvider()` 注册来源；`ctx.skills.register()` 注册"运行时嵌入式 skill"（无外部文件）。
- **宿主 + scope 分层**：skill 落进调用方所在 scope 层；读取时合并全局层与观察 scope 链，**最近层直接赢得重名**，rank 只在单层内裁决重名。
- 4 组公开 API：`registerProvider`、`snapshot`、`list`、`get`；`register` 注册运行时 skill。事件 `skills/change` 是失效通知（不带目录/diff，消费方自行重取）。
- 关键概念 **调用策略 invocation**：正向布尔 `modelInvocable` / `userInvocable`，四个组合分别决定该 skill 是否能被模型目录/工具、用户命令或受信内部调用方访问。
- `renderSkillContent()`：把 skill 渲染成规范的 `<skill_content>` 块，是两条加载路径（tool 结果 / 用户显式手势注入）的唯一真源。
- 已知限制：**无 TTL、失效由提供方驱动**；提供方被**依次**查询（一个慢会拖累后面的）；**不保留不完整观测**；重名采用先到先得。

**二开提示**：写一个新的 skill **来源**（比如从 HTTP 拉取）时，实现一个 provider 工厂并回调 `control.invalidate()` 通知变更；提供方是"数据源"，不碰模型接口。

### 2. `dsh-skill-filesystem` — 本地文件系统 skill 提供方

**职责一句话**：扫描本地各个 skill 根目录、解析 `SKILL.md`，把发现结果喂进 `ctx.skills`，并用 watcher 监视变更。

**核心概念/文件**：
- **skill 两种形态**：目录 bundle `<name>/SKILL.md`，或平铺文件 `<name>.md`。**刻意不支持**发现嵌套的 `**/SKILL.md`。
- **Frontmatter 字段**：必填 `name`（须 kebab-case）和 `description`；可选 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`。
- **调用策略键的坑**：`disable-model-invocation: true` 从模型侧排除；`user-invocable: false` 从用户命令排除。省略则默认允许。**若是驼峰拼写或非布尔值 → 整个 skill 被踢出发现结果**（默认拒绝原则）。
- **根目录 rank 顺序**：project `.dsh/skills`(100) → project `.agents/skills`(200) → 自定义 `customSkillDirs`(300) → user `~/.dsh/skills`(400) → user `~/.agents/skills`(500)。`includeDefaultRoots: false` 可隔离成只看自定义根。
- **watcher**：Chokidar 监视现有根；缺失路径段用 `fs.watchFile` 逐段轮询探测；第一方 fs 工具(write/edit)会通过 `fs/observed` 同步失效（让模型下一步立刻看到自己刚写的变更）；`watch` 默认 `true`。
- **目录与正文生命周期分离**：发现读 frontmatter 造摘要；正文在每次 `skill(name)` 加载时**重新读取当前文件**，无需 hash/缓存失效。

**二开提示**：写第一个 skill 就是在这个包的约定里加文件——在项目根建 `.dsh/skills/<name>/SKILL.md` 或 `.agents/skills/<name>.md`，填好 name/description，重启或用 watcher 让它出现。名字务必 kebab-case、frontmatter 布尔值要规范。

### 3. `dsh-tool-skill` — 面向模型的 skill 目录 + `skill` 工具

**职责一句话**：把 skill 摘要作为「目录」放进会话开头，并提供 `skill` 工具让模型按需取回完整的 skill 指令正文。

**核心概念/文件**：
- **目录生命周期**：每次 `agent/pre-step` 调 `ctx.skills.snapshot()`。首次非空时注入持久 `<system-reminder>` 含 `<available_skills>` 列表（只含 `name` 与规范化的 `description`，有 `catalogDescriptionMaxLength` 上限，默认 500）。摘要变化时追加完整**替换**目录；全空时追加空信封以显式停用旧名。
- **skill 工具**：带必填 `name`。成功返回 `{ name, provider, resourceBase?, content }`，Native 渲染器生成 `<skill_content name="">` + `<skill_resources>` + `<skill_instructions>`。resourceBase 未必是文件路径——本地提供方可给目录，远程可给 URL 或不透明指引。
- **用户显式调用**：用户消息里指名某个 `user-invocable` 的 skill 的 `/name` token，会把该 skill 的完整内容作为 `user` 角色指令注入。对 `disable-model-invocation` 的 skill，这是唯一入口。
- **目录结尾固定一句话**：告诉模型"目录只有摘要，先 call `skill` 工具加载全文，别在没加载前就照着摘要执行"。
- 三个精确错误：`invalid skill name`、`skill unknown or no longer available`、`skill not available for model invocation`。

**二开提示**：一般**不用**动这个包——它按协议消费 `ctx.skills`。你只需要写 SKILL.md，目录和加载器会自动工作。此包也说明了为什么 skill 正文不重复注入（加载结果已作为工具历史保留，模型下一步即可见）。

### 4. `dsh-tools` — 工具注册表与执行流水线（所有工具的底盘）

**职责一句话**：`ctx.tools`，工具从 schema→执行→结果呈现的运行时；决定工具如何向模型呈现（Native Function Calling vs Code Mode）。

**核心概念/文件**：
- **两种呈现 mode**：`native`（默认，函数定义）、`code`（保留 `run_code` 传输 + 生成 SDK）、`both`。`ctx.tools.presentAs()` 可为单个 agent 覆盖。
- **执行流水线**：`tools/pre-execute`（允许/拒绝/询问门禁）→ 单调 guards → `tools/execute`（超时/重试/指标包装层）→ `tools/post-execute`（可改内容/值/加上下文）→ `finalizeContent`（只改 content）→ 观测性 `tools/result`。
- **定义工具的写法**：`ctx.tools.register(defineTool({ name, description, parameters, output:{ schema, render }, execute }))`。`defineTool` 自动做类型推导与参数校验。
- **输出声明 is mandatory**：每个工具必须声明 `output.schema`。
- **取消**是协作式：工具通过 `exec.signal`（AbortSignal）配合。
- **并行**：`isConcurrencySafe(args)` 精确 `true` 才允许并行；其余独占（构成顺序屏障）。
- **UI 呈现意图**：工具用 `presentCall`/`presentResult` 返回 `card: 'terminal'`/`'diff'`/`'search'`/`'read'`/`'web'` 等，UI 无需为每个工具写死逻辑。
- **类型化参数 schema DSL**：`ParameterSchemaSpec`/`ValueSchemaSpec`、`json`、`oneOf`、`enum`/`const`；`additionalProperties` 语义明确。

**二开提示**：写自己的工具（工具插件）就是 `defineTool(...)` + 注册。参考实现是 `dsh-tool-bash` 与 `dsh-tool-fs`。schema 自动流入组装结果，无需手写提示词。注意输出必须先声明。

### 5. `dsh-tool-bash` — 模型侧 `bash` 工具（一次性执行）

**职责一句话**：通过 `bash -c` 跑命令；**调用之间不保留状态**，前台执行 + `run_in_background` 后台任务 + 沙箱升权。

**核心概念/文件**：
- 关键参数：`command`、`description`（必填，仅 UI）、`timeoutMs`、`workdir`（默认会话 cwd）、`run_in_background`、`sandbox_permissions`（与 `justification` 成对）。
- **状态语义**：默认不保留状态 → 文档明确"请使用 `workdir`，不要使用 `cd`"。
- **托管环境**：每次调用注入一组可信 `DSH_*` 环境变量（`DSH_HOME`、`DSH_SHELL=1`、`DSH_SESSION_ID`…）；执行器先清除继承的 `DSH_*` 再合并，不污染 `process.env`。
- 退出语义：非零退出码是**模型解释的结果，不是 isError**；`[exit code: N]` 标记附在每个结果里，系统提示词要求模型"发现失败先调查再继续"。
- 结果含 stdout、可选 `[stderr]`、以及 `[sandbox: …]`/`[timed out]`/`[killed by signal]`/`[exit code]`/`[output truncated; full output: …]` 等标记。
- 升权：需要更宽沙箱时走 `ctx.approval`；**绝不能预先推测升权**，禁用/拒绝审批即最终结果。

### 6. `dsh-tool-bash-persistent` — 持久 `bash`（复用 shell）

**职责一句话**：暴露同名的 `bash` 工具，但底层复用**按 agent 隔离**的持久 PTY shell，状态（cwd、环境变量、已激活环境、函数、后台任务）**跨命令保留**。

**核心概念/文件**：
- 配置：`backendType`（PTY 后端）、`timeoutMs`（默认 300000）、`maxOutputChars`（16000）、`description`（默认描述可覆盖，运行环境事实应写进这里）。
- 结果语义：命令非零退出追加 `[exit code: N]`；若 shell 先退出则 `[shell exited: code N]`/`[shell killed by signal: SIG]`/`[shell exited]`，随后**重置** shell —— 下次调用从新 shell 开始。
- 超时会关闭 shell；显式 `exit`、超时、取消都会**丢弃 shell 状态**。
- 与一次性 `bash` 的取舍：要用"持久工作区/已激活的 venv/导出的变量"时才有意义；否则用一次性 `bash` 更可预期。

### 7. `dsh-tool-fs` — 文件系统工具（read/write/edit/read_image）

**职责一句话**：`ctx.fs` 上面的模型层：读（带行号窗口）、写（整文件替换）、编辑（字面量替换）、读图。

**核心概念/文件**：
- 四个工具：`read`（`file_path`, `offset`(从1), `limit`(默认/上限 2000)）、`read_image`、`write`、`edit`（`old_string`/`new_string`/`replace_all`）。参数用 **snake_case**，与 Claude Code 一致。
- **观察策略（observation policy）是一个独立插件**（`dsh-fs-observation-policy`）：加载后，"覆盖现有文件前必须先 `read` 过""编辑前必须 `read` 且文件未变"；省略则无条件执行。工具通过 `fs/observed` 事件同步观察。这就是为什么系统提示词「write 前先 read、尽量用 edit」。
- 读取上限默认值：`readLimit=2000`、`readMaxLineLength=2000`、`readMaxBytes=51200`、`readStreamMinSize=10485760`（大文件流式读）。
- `read_image` 只在持久附件服务（`ctx.attachments`）挂载时才注册；且要求路由到的模型声明支持 `image` 输入。
- 结果有明确的模板与 footer（如 `(End of file - total N lines)`、`(Output capped. Showing lines L-R…)`）。
- 已知限制：read 只处理 **UTF-8** 文本；**没有面向模型的目录列表工具**（`listDir` 只服务提供方代码；发现性搜索用同级 `dsh-tool-fs-search`）；read/write/edit **没有超时参数**。

### 8. `dsh-tool-fs-search` — 文件搜索工具（glob/grep）

**职责一句话**：用**打包的 ripgrep 二进制**（`@vscode/ripgrep`，无需宿主 rg）提供 `glob`（按路径模式找文件）与 `grep`（按正则搜内容）。

**核心概念/文件**：
- `glob`：底层 `rg --files --glob <pattern> --sort=modified --no-ignore --hidden`，排除 VCS 元数据目录。无 `/` 的模式匹配任意深度 basename，所以 `*` 匹配整棵树。只返回**文件**（不见目录）。
- `grep`：按行解析 `rg --json`，`pattern` 是正则；`include` 是正向 glob 过滤器；按文件分组返回 `Line N: <preview>`。
- 上限默认值：`globMaxResults=100`、`grepMaxMatches=250`、`grepMaxLineBytes=2000`、`timeoutMs=30000`。超上限结果可经可选 spill 后端完整保存并给定位符。
- `sampleOverCapGlobResults` **必填**（决定超限 glob 页的排序/采样策略），`true` 跨顶层条目采样、`false` 保留按修改时间排序前部。
- 引入管道：每次调用经 `ctx.subprocess` seam spawn 二进制，前面固定加 `--no-config` 防注入。
- 提示词指导：`Use the glob tool — not shell find —`；`Use the grep tool — not shell grep or rg —`。找文件用 glob、找内容用 grep，别用 shell 命令。

### 9. `dsh-tool-web` — web 工具（web_search/web_fetch）

**职责一句话**：联网搜索与抓取，构建在 `ctx.web` 能力 seam 之上。

**核心概念/文件**：
- `web_search(query)`：返回可选答案 + `Sources:` 列表（`[title](url)` + 可选摘要/日期），`searchMaxResults` 上限默认 8（是配置，**不是**模型参数）。结尾提示模型把 URL 作为 markdown 链接引用。
- `web_fetch(url)`：抓取 URL，HTML 转 markdown（turndown + GFM 表格），文本原样通过，非 2xx 状态**报告而不报错**。
- `web_fetch` 只接受 `url`（暂无 format/prompt/摘要模式，列为未来涉项）；`max_results` 不是模型参数。
- 配置可分别禁用 `{ search:false }`/`{ fetch:false }`。超时是部署策略（`dsh-tool-call-timeout-policy`），不暴露给模型。
- 描述性指引（各选取一段）：搜索 `Use the web_search tool to discover current information...`；抓取 `Use the web_fetch tool to retrieve the content of a specific HTTP(S) URL...`。

### 10. `dsh-tool-str-replace-editor` — 另一套文件编辑器

**职责一句话**：基于 `ctx.fs`、自包含的 `str_replace_editor`（编辑器的四动词），可与持久/一次性 bash 组合。

**核心概念/文件**：
- 四个操作：`view`（带 1-based 行号查看、保留制表符）、`create`、`str_replace`（**字面量唯一匹配**，拒绝零/多匹配，**没有 replace_all**）、`insert`（按零基边界，不隐式补换行）。
- 目录查看忽略隐藏、依赖与 Python 缓存条目，下探两层。
- `maxOutputChars=16000` 控制查看结果前缀；`description` 可覆盖。
- 与 dsh-tool-fs 的 `edit` 的区别：`edit` 强调"先 read 再改、支持 replace_all"；这里 `str_replace` 严格唯一匹配，没有 replace_all。二者都走 `fs/write-intent`/`fs/edit-intent` 与各自沙箱策略。选型看你想要哪种编辑语义。

### 11. `dsh-tool-todo` — 任务列表 `todo_write`

**职责一句话**：agent 的完整任务清单工具；**每次调用整体替换**，无部分更新/单项编辑。

**核心概念/文件**：
- 参数 `todos: [{ content, status }]`，`status` ∈ `pending|in_progress|completed`。模型每次全量提交。
- **整表替换是唯一操作**、没有回读工具 → 模型每次都要重发完整列表；`todo/write` 会话事件就是完整快照（后写覆盖先写）。
- **单一所有者 scope**：列表属于调用它的唯一 agent 会话；subagent/共享/swarm 非本工具范围；非 agent 调用方（没有 `exec.agent`）被拒绝。
- 配置 `allowParallelInProgress` **必填**：`true` 允许多个 `in_progress`，`false` 强制单活跃项并拒绝更多（`Error: invalid todos: at most one task may be in_progress`）。
- 验证严格：拒绝空/重复 content；content/status 之外的任何键都报错（防模型投喂 id/嵌套被静默压平）。
- 结果：`Updated todo list: N pending, N in progress, N completed.` 现役计划在 `turn/start` 清零（计划只对当前轮次有效）。

### 12. `dsh-tool-ask-user` — 提问 `ask_user_question`

**职责一句话**：模型在需要确认、选择或缺失信息时，向用户提出简洁问题并收集答案。

**核心概念/文件**：
- 参数：`questions[]`，每项 `id`（必填稳定 id，原样回显）、`question`（必填）、`header`（可选标题）、`options`（label+description；推荐项放首位并在 label 后加 `(Recommended)`）、`multi_select`。
- 结果：规范 `{ answers: [{ id, selected, custom? }] }`；模型侧渲染为紧凑 JSON。
- **职责边界**：本包是用户交互 seam 的 Consumer——不渲染 UI、不懂收集方式，只做"模型参数 → 请求 → 返回用户回答"。
- 限制：待处理问题**阻塞**调用直到用户作答（无 timeout-policy）；归属于其他 agent 的 subagent **不能**向用户提问（`DELEGATED_CALLER` 拒绝），需把未决问题/决策放进最终结果。

### 13. `dsh-tool-cordis` — 自引用 Cordis 工具集

**职责一句话**：五个面向模型的工具，用来在**当前 DSH 进程运行时**里热注册、运行、停止、卸载一个动态 Cordis 包（host 半 + 浏览器半）。

**核心概念/文件**：
- `cordis_inspect`：只读报告当前运行时（服务、存活插件 fiber、已注册工具、本会话动态包、api/events/client 槽面）。
- `cordis_define`：登记一个包（`name`、`purpose`、host `code` 和/或浏览器 `client`），**先不运行**，用户可在会话卡片里点启动；铸出 `dyn-<n>` 标识。
- `cordis_run`：在沙箱中求值 host 半并把浏览器半投递给每个打开页面。
- `cordis_stop`：dispose host 半并撤回浏览器半，定义存续可再跑。
- `cordis_undefine`：先停再忘掉定义，卡片作为已卸载记录留下。
- **只存在于内存**：动态包跨轮次可活、可影响同进程其他会话，但 `stop`/`undefine`/工具集卸载/DSH 重启后消失；**不写插件文件、不改 cordis.yml、不能自动转正式插件**。想保留要按常规流程写本地/项目/仓库插件。
- **信任立场**：沙箱隔离全局变量但**不是安全边界**——可逃逸触达 Node，应像授予 bash 一样慎重。每次动词以会话为界（只在定义它的那个会话里可见可控）。

---

## 新手易漏点

1. **把 skill 和 tool 混为一谈。** skill 是"指令文档"（给模型看的文本，无代码），tool 是"可执行操作"（有 execute 代码）。你给 agent"加技能"要做的是写 `SKILL.md`（配 frontmatter），不是写个工具插件；只有当你想要"新的可执行操作"时才去 `defineTool` 写工具。关键词是：skill = 加"该怎么做"的方法论，tool = 加"能做什么"的行动力。

2. **写 skill 时 frontmatter 的"坑"，尤其调用策略字段。**
   - `name` 必须 **kebab-case**，否则被拒出发现。
   - `disable-model-invocation`/`user-invocable` 若用**驼峰拼写**或给**非布尔值**，不只丢掉字段——**整个 skill 会被踢出发现结果**（默认拒绝原则），因为忽略无效字段可能把 skill 暴露在已禁用的接口上。宁可不写这两个键（默认允许两个接口调用）。
   
3. **skill 目录里只有摘要，正文需要模型主动 `skill` 工具去加载。** 系统提示词、目录模板都反复强调：目录只有 `name` + 有长度上限（默认 500）的描述；模型必须先 call `skill` 工具拿到 `<skill_content>` 全文再照做，**不能凭没有加载的摘要就推断并执行**。

4. **skill 的"刷新"是 watcher 与文件分离的生命周期，不是缓存。** 发现（摘要）由 watcher/`fs/observed` 触发失效；但**正文（body）每次加载都重新读当前文件**，不存在 hash/缓存。所以：① 你用第一方 write/edit 工具改动 skill 文件，模型下一步就能看见（`fs/observed` 快速路径）；② 只改正文不会改变目录 digest，也不通知模型——已加载的结果是历史事实，不会被改写。

5. **file 工具相关的默认行为边界。** 加载了 observation-policy 后，`write` 覆盖已有文件 / `edit` 修改**都要求先 `read` 过**（新文件 create 不需要；edit 要求文件读后未变）。`read` 只认 UTF-8 文本、只按行号窗口读；**没有目录列表工具**——找文件/搜内容要用 `glob`/`grep`（提示词指导"别用 shell find / grep / rg"）。还有 `bash` 一次性命令**不保留状态**（要用持久 shell 才保状态）、非零退出码不算报错只是结果标记。

6. **（进阶）scope 与「只对当前会话/唯一所有者」的边界。** 工具不是全局无差别生效的：skill 按 scope 层合并、同名最近层遮蔽更远层；`todo_write` 只属于单一 agent 会话；`cordis_*` 动态包只在定义它的会话可见且只驻内存；`ask_user_question` 不允许"别的 agent 的子 agent"代问。新手容易以为工具/技能对谁都能用——实际很多是按 agent/会话隔离的。

---

### 附：新手"给 agent 加技能"的推荐路径

- **纯技能**（最常见）：在项目建 `.dsh/skills/<name>/SKILL.md`（或 `.agents/skills/<name>.md`），写 kebab-case `name`、`description`（推荐一并写 `whenToUse` 触发时机），正文给模型实际的步骤指令。重启或等 watcher 之后，会话开头的 `<available_skills>` 目录就会出现它。
- **要新行动能力**：写一个工具插件，用 `defineTool({ name, description, parameters, output, execute })` 注册进 `ctx.tools`，参考 `dsh-tool-fs`。
- **要探索运行时**：用 `dsh-tool-cordis` 在会话里即兴 `cordis_define`+`cordis_run` 一个动态包（纯内存，别当持久方案）。
- 判断口诀：**"教 agent 一套做法"→ 写 SKILL.md；"给 agent 一把新工具"→ 写工具插件。**
