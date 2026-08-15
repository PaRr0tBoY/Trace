# 29 — AI Provider 配置布局

**What to build:** AIProviderSection 重排：模型名称独占一行不被按钮挤压；每个 provider 的测试/上移/下移/删除操作与状态独立成行；Ollama 检测状态单独完整显示，不再互相遮挡。

**Blocked by:** 无

**Status:** open

- [ ] provider 行拆两层：第一层 = 状态点 + 模型名称（独占一行，字号 13+，不截断到看不见）+ 上移/下移/删除图标按钮；第二层 = baseUrl（小字）+ 测试按钮 + 测试状态（✓/✗ 完整显示，不 maxWidth 截断）
- [ ] 展开态：baseUrl / apiKey / model 三个输入框各自独占一行（现状已是 label+input 纵向，检查被同行元素挤压的情况）
- [ ] detectOllama 检测结果独立一行完整显示（检测中/已找到 qwen3:8b/失败原因）；与测试状态互不遮挡
- [ ] i18n zh 必填；typecheck + npm test 全绿；真机：3 个 provider + 测试失败场景下所有文本可见

## 参考

Settings.tsx AIProviderSection（1135-1372 行）、settings.css。用户反馈（h）：模型名被测试/上下调整/关闭按钮卡住看不清；检测状态一行互相遮挡。
