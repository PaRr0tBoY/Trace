# 30 — OCR 管道（Windows 原生，借鉴 screenpipe）

**What to build:** Windows.Media.Ocr（WinRT，系统自带、离线、中文识别）作为 OCR 引擎，通过现有 PowerShell 通道调用（powershell.ts 已有 WinRT 互操作先例）。产物 = 窗口截图/剪贴板图片的文字，作为 segment 上下文喂给 LLM 任务建议（AI 资料，不进 UI）。

**Blocked by:** 无

**Status:** open

- [ ] 调研确认 screenpipe 的 Windows OCR 方案（git 历史 MIT 版，许可结论见参考），提取可借鉴点：OCR 引擎选择、截图来源、语言识别（zh 优先）
- [ ] OCR 引擎：PowerShell 脚本加载 `Windows.Media.Ocr` + `Windows.Graphics.Imaging`，await IAsyncOperation（PS 5.1 WinRT await helper），输出文本 + 置信度；失败静默降级
- [ ] 截图来源：前台窗口截图（PowerShell System.Drawing CopyFromScreen 或按窗口 rect BitBlt）与剪贴板图片（已有 imageId → 本地 PNG 路径）
- [ ] segment 上下文扩展：suggestionEngine 触发分析时，对当前前台窗口（及可选剪贴板图片）OCR，文本拼入 LLM prompt 的 windowTitles 同级上下文（字段如 ocrContext）；OCR 失败不影响任务系统
- [ ] 性能护栏：OCR 仅分析触发时跑（非轮询）；单次超时放弃；结果限长（如 2KB）；结果不持久化（或按用户意见进 memoryContext 类字段）
- [ ] 隐私：OCR 内容同样遵守现有隐私三开关（incognito/L0/总开关）
- [ ] typecheck + npm test 全绿；真机：切中文窗口 60s 触发建议，LLM 收到 OCR 上下文（日志可证），无 AI 配置时一切照常

## 参考

screenpipe 许可结论（2026-08-11 调研）：MIT 锚点 81e412ff5^（2026-06-10 前），可 fork 商用二开但排除 ee/ 目录；Windows OCR 方案借鉴。CONTEXT.md OCR 内容条目：只作 AI 资料，不进 UI。
