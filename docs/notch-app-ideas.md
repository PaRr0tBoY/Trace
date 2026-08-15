# 灵动岛（Notch）软件功能 Idea 库

> 来源：ChatGPT 对话整理（2026-08-14），原始记录在 `~/Downloads/chrome/macOS-灵动岛软件排名.md`。
> 用途：Trace 新功能 Idea 参考库。竞品是 macOS Notch / Dynamic Island 应用，功能空间与 Trace（Windows 边缘面板）高度重叠，可平移借鉴。

## 一、竞品全景（10 个产品）

排名口径：人气 = GitHub Star / Setapp / App Store 评价 / 社区讨论 / 搜索声量；功能完整度 = 媒体、文件、剪贴板、通知、日历、HUD、计时器、AI/语音、通话等能力综合。

| 排名 | 产品 | 人气 | 功能完整度 | 定位 |
|---:|---|:---:|:---:|---|
| 1 | NotchNook | ★★★★★ | ★★★★★ | 最成熟的商业全能型 |
| 2 | Boring Notch | ★★★★★ | ★★★★☆ | 开源、社区型全能方案 |
| 3 | DynamicLake | ★★★★☆ | ★★★★★ | 功能堆得最满的工具型 |
| 4 | Alcove | ★★★★★ | ★★★☆☆ | 最 Apple、最精致 |
| 5 | seam | ★★★★☆ | ★★★★☆ | 生产力型灵动岛 |
| 6 | NotchBay | ★★☆☆☆ | ★★★★★ | 新一代 AI/生产力型 |
| 7 | Crest | ★★☆☆☆ | ★★★★☆ | 新兴全能型 |
| 8 | NotchDrop | ★★★☆☆ | ★★★☆☆ | 文件/剪贴板/AI 工作台 |
| 9 | Atoll | ★★☆☆☆ | ★★☆☆☆ | 开源轻量型 |
| 10 | Notchy | ★★☆☆☆ | ★★★☆☆ | 免费轻量型 |

### 1. NotchNook —— 综合第一

最成熟的商业产品，优势是整体系统完整而非某个杀手功能。

- Now Playing / 音乐控制、文件 Shelf / 临时文件托盘、Clipboard、Calendar、Battery、AirPods、AirDrop、Volume / Brightness HUD、Widgets、大量视觉/布局/动画定制、无刘海 Mac 的 Island 模式
- 缺点：功能多导致复杂度高；有睡眠/唤醒异常、CPU/电池消耗报告；没有明显的 AI / Agent 定位

### 2. Boring Notch —— 开源王者

免费 + 开源 + 社区规模大（GitHub ~9.4k Stars / 747 Forks，全品类最突出）。

- 音乐控制、Music Visualizer、Calendar、Reminders、File Shelf、AirDrop、Pomodoro、Battery、macOS HUD、Webcam Mirror、Lock Screen Widgets、Bluetooth 状态、自定义布局、Extension System（roadmap）
- README 很多项目仍是 roadmap，不能当已完成
- 架构参考价值高：Notch → Now Playing / Live Activity / Shelf / HUD / Widget / Calendar / Extension
- 缺点：UI polish 不如商业产品；unsigned 需绕 Gatekeeper；sleep/wake、媒体检测偶发问题

### 3. DynamicLake —— 功能怪兽

"把各种东西都塞进灵动岛里的工具箱"，Reddit 用户评价 "probably the most feature-complete"。

- Notifications、Music、Calendar、Weather、Timer、Drag & Drop、AirDrop、Calls、Unit Converter、Currency Converter、系统状态、大量自定义
- DynaDrop / DynaClip 是文件侧最激进的一套：文件管理、压缩、Quick Look、转换、AirDrop、分享链接
- DynaKeys 专门做系统按键/HUD 反馈；DynaSwitcher 做键盘切换 + App Preview
- 问题：容易变成功能很多的工具箱，而不是克制的系统组件

### 4. Alcove —— UI/UX 第一

"哪个最像 Apple 自己做的？"——最 native / 最 Apple-like。

- Dynamic Island 风格动画、Live Activities、Now Playing、Waveform、Seek Bar、Notifications、Calendar、Lock Screen、Island mode、原生 SwiftUI
- 故意不做太多东西。产品哲学：Notch → Dynamic Island（而非 mini desktop / toolbox）

### 5. seam —— 工作流入口

把 notch 从"显示系统状态"变成"工作流入口"，最有产品思路的新一代方案之一。

- Music、Calendar、Pomodoro、本地 Voice-to-Text、Voice Translation、Drag & Drop / File Stash、Volume / Brightness HUD、AirPods、Weather、AirDrop、Island Mode
- 亮点：直接在 notch 上本地语音 → 当前应用输入；文件暂存做成 notch shelf
- 方向：Notch → Universal Interaction Surface → Voice / File / Calendar / Music / Focus

### 6. NotchBay —— 功能激进的新兴者

功能完整度可排第一，人气还没到顶流。

- Live Activities、Music、Calendar、Zoom / Google Meet 控制（mute/camera/leave）、Clipboard + OCR、On-device Dictation、Camera / Mic Privacy、AirPods、Timer、浏览器 App 状态、Claude Code / Codex 状态、AI 使用量、Google Drive 分享
- Clipboard 管线：复制 → 自动进 Tray → OCR → 搜索 → 按类型分类 → 固定
- 对开发者工作流价值很高

### 7. Crest —— 新兴全能型

Full-featured notch hub，但尽量低资源（$19.99 买断，有免费基础层）。

- Now Playing、File Shelf、Clipboard、Home glance、Live Activities、多种模式、AI / Claude Copilot、Developer-oriented modules、GitHub、Claude Code、Battery-aware behavior
- 差异点：针对开发者 + AI 工作流做产品

### 8. NotchDrop —— Notch 工作台

把 notch 做成一个小型工作台（注意与 App Store 旧版同名纯文件暂存工具区分）。

- File Drop、Clipboard、Music、AI Chat、AI Notes、AI transcription、Screen Recording、Camera、Local File Sharing、Todo、Terminal Commands、Screenshot、Screen Draw、Notch Pet
- 官网支持自带 API Key 接 AI
- 成熟度、社区规模还不及第一梯队

### 9. Atoll —— 开源轻量派

GitHub ~1.9k Stars，GPL-3.0，2026-03 还在发版。受 Boring Notch 启发，功能范围小得多。研究 notch UI 实现时与 Boring Notch 的代码都值得看。

### 10. Notchy —— 免费轻量路线

- Now Playing、Clipboard History、Pomodoro、File Stash、Command Palette、AI Usage Tracker、Claude / Codex / Cursor 状态、SwiftUI、macOS 13+
- AI usage tracker 是独特卖点；还有 Teleprompter、Camera Mirror、全局 Mic Mute、Keystroke HUD、Window Snapping、Hide-the-Notch

### 容易混淆的三个

- **MediaMate**：不是 Dynamic Island，是 macOS HUD replacement（Volume / Brightness / Keyboard backlight / Now Playing）
- **TopNotch**：反过来——隐藏 notch（顶部黑色区域 + 动态壁纸 + 多显示器 + 圆角）
- **NotchDrop 撞名**：旧版 App Store 是纯"文件暂存 + AirDrop"开源隐私工具；`notchdrop.com` 是 AI + 文件 + 剪贴板 + 录屏工作台

## 二、去重后的功能地图（122 项，15 大类）

同一能力只保留一次（如"音乐控制 / Now Playing / DynaMusic"归为一个功能族）。

### 1. 媒体与娱乐

1. **Now Playing 音乐控制** — 播放/暂停、上一首/下一首、进度条拖动、专辑封面、播放状态、Apple Music / Spotify / 浏览器媒体
2. **音乐可视化** — Waveform、音频频谱、动态专辑封面效果
3. **歌词** — 实时歌词、Karaoke / 时间同步歌词
4. **媒体队列** — 查看播放队列、调整下一首歌曲
5. **音频输出控制** — 音量、音频设备切换

### 2. 文件工作流

6. **File Shelf / File Stash** — 把文件拖进 Notch 暂存、再拖出去、临时文件篮
7. **Drag & Drop 工作流** — 文件拖入后触发操作、多文件拖入、文件预览
8. **AirDrop** — 快速 AirDrop、文件分享
9. **文件管理** — 移动、删除、压缩、Quick Look、文件夹之间移动、iCloud Drive、分享
10. **文件转换** — DOCX → PDF / Text、图片格式转换、PDF 转换、其他格式转换
11. **快速分享链接** — 文件 → Shareable Link
12. **下载状态** — 下载进度、下载完成提示

### 3. 剪贴板

13. **Clipboard History** — 剪贴板历史、浏览之前复制的内容、快速重新粘贴
14. **Clipboard Shelf** — 类似文件 Shelf 的视觉化剪贴板
15. **Clipboard 搜索** — 搜索文本、搜索文件名、OCR 内容搜索
16. **Clipboard OCR** — 从截图 / 图片复制文字、OCR 后进入剪贴板
17. **Clipboard 智能操作** — 根据内容类型提供操作、URL / Email / Color 等快捷动作
18. **Clipboard Pin** — 固定常用剪贴板内容
19. **Clipboard AI** — AI 总结、AI 改写 / 优化、对复制内容进行 AI 处理

### 4. 输入与 AI

20. **系统级语音输入** — Voice → Text、在当前 App 直接输入、不需要切换窗口
21. **本地语音识别** — On-device transcription
22. **实时翻译** — 说 A 语言 → 输出 B 语言
23. **AI Chat** — 在 Notch 直接聊天、不离开当前工作流
24. **AI Notes** — 语音记录、自动转录、AI 总结
25. **AI Clipboard** — 对剪贴板内容调用 AI
26. **AI Usage Monitor** — Claude Code / Codex / Cursor / Copilot / Gemini / DeepSeek / ChatGPT 等，Token / quota / usage
27. **AI / Agent 状态** — Claude Code 当前状态、Agent session 状态、AI 工作流进行中提示

### 5. 日历与时间管理

28. **Calendar** — 今日 / 即将到来的事件、Upcoming Events、Calendar Preview
29. **会议倒计时** — 距离下一场会议还有多久
30. **会议提醒** — Meeting Alert
31. **一键加入会议** — Zoom、Google Meet、Microsoft Teams
32. **Pomodoro** — 专注倒计时、Break、Session chaining
33. **Focus Timer** — 通用倒计时、Stopwatch
34. **Focus / Do Not Disturb 状态** — 当前 Focus Mode、DND 状态
35. **Focus 统计** — 专注次数、Streak、7-day chart

### 6. 系统状态

36. **Battery** — Mac 电量、充电状态、电量百分比
37. **外设电量** — AirPods、Magic Mouse、Keyboard、Trackpad
38. **充电 Live Activity** — Charging、充电进度
39. **Bluetooth** — 连接、断开、外设状态
40. **AirPods 管理** — 左右耳电量、充电盒电量、一键连接
41. **CPU / GPU Monitor**
42. **Memory Monitor** — RAM 使用量
43. **Network Monitor** — 网络状态 / 使用量
44. **Disk Monitor** — 磁盘状态 / 使用量
45. **系统温度** — CPU Temperature、SMC 数据

### 7. 系统 HUD

46. **Volume HUD** — 音量变化
47. **Brightness HUD** — 屏幕亮度变化
48. **Keyboard Backlight HUD** — 键盘背光
49. **外接显示器亮度** — External Display brightness
50. **系统按键反馈** — 系统快捷键状态

### 8. 通知与通信

51. **macOS Notifications** — 系统通知
52. **消息通知** — iMessage、WhatsApp、Telegram、Slack、Email 等
53. **通知交互** — 展开、查看详情、快速操作
54. **Quick Reply** — 直接回复消息
55. **电话 / FaceTime** — 来电、通话状态
56. **通话控制** — 接听、挂断、通话状态
57. **会议状态** — Zoom / Meet 等会议状态

### 9. 摄像头与会议

58. **Camera Mirror** — 实时摄像头预览、视频会议前检查形象
59. **Webcam Preview**
60. **Zoom Teleprompter** — 提词器、摄像头附近显示脚本
61. **Screen Recording** — 开始录屏、录屏状态
62. **Privacy Indicator** — Camera / Microphone / Screen Recording 正在使用
63. **System-wide Mic Mute** — 全局麦克风静音

### 10. 快速工具

64. **Quick Notes** — 快速记笔记、不打开完整 Notes App
65. **Bookmarks** — 快速访问收藏
66. **App Launcher** — 固定常用 App、一键启动
67. **Command Palette** — 键盘搜索所有操作、快捷执行功能
68. **Apple Shortcuts** — 从 Notch 运行 Shortcut
69. **Color Picker** — 吸取屏幕颜色、Hex / RGB
70. **Screenshot** — 截图、截图直接进入 Clipboard / Shelf
71. **Screenshot OCR** — 截图 → OCR → Clipboard
72. **Screenshot Markup** — 截图后标注
73. **Image Converter** — HEIC / JPG / PNG 等转换
74. **Zip / Unzip** — 压缩、解压
75. **Currency Converter**
76. **Unit Converter**
77. **Weather** — 当前天气、天气预览
78. **Stock / Market Ticker**
79. **Keep Awake / Caffeine** — 防止睡眠
80. **Built-in Terminal** — 在 Notch 内打开终端、执行命令

### 11. 窗口与桌面管理

81. **Window Snapping** — 把窗口拖到 Notch、自动排列 / 平铺
82. **App Switcher** — 类似 ⌥Tab、快速切换应用
83. **App Preview** — 查看当前打开的 App
84. **Tab Detach** — 将 Tab 拆到独立 Popover
85. **Menu Bar Popover**
86. **External Display Support** — 外接显示器显示 Island
87. **Multi-Monitor Support**

### 12. Lock Screen

88. **Lock Screen Widgets** — Media、Timer、Charging、Bluetooth、Weather 等
89. **Lock Screen Live Activity**
90. **Lock Screen Position / Layout**

### 13. Notch 本身的交互

91. **Hover-to-Expand**
92. **Click-to-Expand**
93. **自动展开 / 收缩**
94. **Dynamic Island Animation** — Morph、Spring animation、Fluid expansion
95. **Gesture Control** — Swipe、Media gesture、Two-finger gesture
96. **Keyboard Shortcut** — 快捷键打开
97. **Modifier-key Knock** — 双击修饰键唤出
98. **自定义触发方式**
99. **自定义 Notch 尺寸**
100. **自定义布局**
101. **自定义动画**
102. **自定义 Hover 行为**
103. **Minimal Mode** — 极简模式
104. **Notchless Mac Floating Island** — 没有实体 Notch 的 Mac 也显示成浮动 Pill

### 14. Notch 隐藏与视觉功能

105. **Hide Notch**
106. **Wallpaper Mask** — 将顶部壁纸变黑、视觉上隐藏刘海
107. **圆角 / 外观定制**
108. **Island Position**
109. **Panel Position**
110. **动画风格**
111. **主题 / 外观定制**

### 15. 个性化 / 娱乐

112. **Notch Pet**
113. **Mini Game**
114. **Infinity Run 等小游戏**
115. **视觉彩蛋**
116. **音乐可视化娱乐效果**

### 16. 开发者专属能力

117. **AI Coding Session 状态** — Claude Code、Codex、Cursor 等
118. **AI Token / Usage Monitor**
119. **Terminal**
120. **Keystroke HUD** — 展示键盘输入、适合录屏 / Demo / 教学
121. **开发环境状态**
122. **快捷命令执行**

## 三、25 个一级功能模块（语义聚合）

```
Mac Notch / Dynamic Island
│
├── 01 媒体        Now Playing / Music Visualizer / Lyrics / Media Queue
├── 02 文件        File Shelf / Drag & Drop / AirDrop / File Manager / File Converter / Share Link
├── 03 剪贴板      History / Search / OCR / Pin / AI
├── 04 AI / 输入    Dictation / Translation / AI Chat / AI Notes / AI Clipboard / AI Usage & Agent Status
├── 05 时间        Calendar / Meeting / Timer / Pomodoro / Focus
├── 06 通知        System Notifications / IM / Quick Reply / Calls / Meetings
├── 07 系统状态    Battery / AirPods / Bluetooth / CPU/GPU/RAM / Network / Disk / Temperature
├── 08 HUD         Volume / Brightness / Keyboard Backlight / Device Controls
├── 09 摄像头/隐私  Camera Mirror / Teleprompter / Screen Recording / Camera/Mic Indicator / Global Mic Mute
├── 10 快速工具    Notes / Launcher / Command Palette / Shortcuts / Color Picker / Screenshot / Converter / Weather / Caffeine / Terminal
├── 11 窗口        App Switcher / App Preview / Window Snap / Tab Detach / Multi-Monitor
├── 12 Lock Screen Widgets / Live Activities
├── 13 交互层      Hover / Click / Gesture / Shortcut / Auto Expand
├── 14 外观        Layout / Animation / Size / Theme / Hide Notch
└── 15 娱乐        Notch Pet / Mini Games / Visual Effects
```

## 四、产品分层与演化

### 4 条产品路线

| 路线 | 代表产品 | 核心思想 |
|---|---|---|
| Dynamic Island Clone | Alcove | 把 Mac notch 做成 iPhone Dynamic Island |
| System Hub | NotchNook / DynamicLake | 把 notch 变成系统控制中心 |
| Productivity Surface | seam / NotchBay / Crest | 把 notch 变成工作流入口 |
| Open Source Platform | Boring Notch / Atoll | 把 notch 做成可扩展开发平台 |

### 4 代演化

```
第一代  Notch = Music Player
第二代  Notch = Dynamic Island
第三代  Notch = System Hub
第四代  Notch = Personal Interaction Surface
```

seam / NotchBay / NotchDrop / Crest 已经在往第四代走：文件 → 剪贴板 → AI → 语音 → Agent → 当前 App 上下文，天然适合放在"始终在视觉附近、但平时不占空间"的交互表面里。

### 3 个功能层级

| 层级 | 功能 | 典型产品 |
|---|---|---|
| 基础层 | 音乐、Battery、HUD、Calendar、AirDrop | 几乎所有产品 |
| 效率层 | File Shelf、Clipboard、Pomodoro、OCR、Launcher、Terminal | NotchNook / DynamicLake / Notchy |
| 工作流层 | Dictation、AI、Agent 状态、会议、Quick Reply、Window 操作 | seam / NotchBay / NotchDrop / Notchy |

值得注意的现象：功能越完整不一定产品越好（Alcove 是反例）；Notch 正从"状态展示器"变成"上下文操作面板"。

## 五、与 Trace 的对照

对照依据：`docs/architecture.md`（2026-08-14）。✔ = 已有；○ = 部分相关；空白 = 机会点。未确认项不标已有。

| 功能族 | Trace 现状 | 备注 |
|---|---|---|
| Clipboard History | ✔ | 核心功能，600ms 轮询 + 去重 |
| Clipboard Pin | ✔ | 固定项不参与 trim |
| Clipboard 搜索（文本） | ✔ | 搜索框 |
| Clipboard OCR（图片取字） | | Trace 的 OCR 只识别前台窗口文字供 AI 上下文，不作用于剪贴板图片 |
| Clipboard AI | ○ | AI 标题/建议已有；总结/改写/翻译等"AI 处理剪贴板内容"没有 |
| Clipboard 智能操作（URL/Email/Color） | | 内容类型快捷动作未做 |
| Clipboard Shelf（视觉化） | ○ | 面板即视觉化历史，无独立 shelf 形态 |
| File Shelf / 文件栈 | ✔ | 文件视图 + 拖入拖出 |
| Drag & Drop 工作流 | ✔ | OLE 原生拖拽 + 拖到任务卡绑定 |
| 文件管理（压缩/转换/Quick Look） | | 只有浏览与拖出 |
| App Switcher | ✔ | Alt+Tab 切换器（ADR-0005） |
| App Preview | ○ | 窗口快照有标题/图标，无视觉预览 |
| Window Snapping | | |
| Hover-to-Expand | ✔ | 边缘 hover 是 Trace 的灵魂交互 |
| Click-to-Expand / 自动展开 | ✔ | 边缘触发滞回 |
| Dynamic Island Animation | ○ | Framer Motion 动画，无 morph 语义 |
| 自定义外观 | ✔ | 5 主题 + accent |
| Command Palette | ○ | 搜索框承担部分职能 |
| 任务层 / 建议 / 记忆 | ✔ | Trace 独有：TaskStore + suggestionEngine + MemoryStore + 决策管道，已是"工作流层"实现 |
| 前台应用 / 窗口上下文 | ✔ | foreground.ts + windowSwitch，比多数竞品深 |
| AI Usage Monitor | | ai-log.jsonl 有数据，无面向用户的 usage UI |
| AI / Agent 状态提示 | | |
| 系统级语音输入 / 翻译 | | |
| AI Chat / AI Notes | | |
| Calendar / 会议（倒计时/提醒/一键加入） | | |
| Pomodoro / Focus | | |
| 通知 / Quick Reply / 通话 | | |
| 系统状态（Battery/CPU/RAM/温度） | | |
| HUD（音量/亮度） | | Windows 有原生 HUD，替换需求弱 |
| 摄像头 / 隐私指示 / 全局静音 | | |
| 截图 / 截图标注 | | |
| 快速工具（Color Picker/转换/Zip/天气/Terminal） | | |
| Lock Screen | | |
| 娱乐（Notch Pet / 小游戏） | | |

## 六、给 Trace 的 Idea 提示

从"竞品已在做 / Trace 已有基础 / 差异点"三个维度看，值得考虑的方向（按与现有架构的复用度排序）：

1. **Clipboard OCR**：截图/图片文字进剪贴板历史并可搜索。Trace 已有 Windows.Media.Ocr 技术栈（ocr.ts），只需把处理对象从前台窗口换成剪贴板图片。直接补上"剪贴板 → OCR → 搜索"管线，是 NotchBay 的差异化卖点。
2. **Clipboard 智能操作**：按内容类型（URL / Email / 颜色 / 代码）给条目挂快捷动作。纯 renderer + 少量 IPC，成本低。
3. **AI 处理剪贴板内容**：AI 总结/翻译/改写，复用现成 ProviderChain（已处理 DeepSeek 降级、thinking、max_tokens 预算问题），无需新基建。
4. **Command Palette**：面板内统一命令入口，把搜索框升级成"搜索一切"（条目、任务、操作）。
5. **AI Usage Monitor**：ai-log.jsonl 已有全部数据，加一个 usage 视图（token/调用次数按 provider 统计）是低成本的开发者向卖点，Notchy/NotchBay/Crest 都在做。
6. **语音输入**：本地语音 → 当前应用输入（seam 的方向），Windows 有现成 WinRT SpeechRecognition，与 OCR 的 PowerShell/WinRT 模式对称。成本中高。
7. **AI/Agent 状态提示**：Trace 的任务/建议管道运行中给一个"正在分析"的轻提示，与决策管道现有日志事件衔接。
8. **窗口级能力**：App Preview（窗口缩略图）→ Alt+Tab 切换器升级；Window Snapping 可作为远期。
9. **系统状态模块**：Battery / CPU / RAM 是基础层标配，对剪贴板管理器属于"锦上添花"，优先级低于上面所有项。

原则参考（原文结论）：竞品功能取舍不该继续堆功能，而是按「系统事件 → 信息展示 → 用户输入 → 快速操作 → 跨应用动作 → Agent 自动执行」重新排列，看自己缺哪一层。Trace 的决策/任务管道已经覆盖了最后两层，这恰好是其他产品还没有的。
