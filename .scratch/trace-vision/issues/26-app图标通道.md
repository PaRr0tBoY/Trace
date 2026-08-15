# 26 — APP 图标通道

**What to build:** 从 exePath 提取 Windows 应用图标，供任务卡 / 备选卡 / 二级菜单显示。第一页（卡片页）只显示图标不显示名称；第二页（二级菜单）图标 + 名称。

**Blocked by:** 无

**Status:** open

- [ ] main 侧图标提取：`app.getFileIcon(exePath, { size: 'normal' })`（drag.ts 已有先例）+ 内存缓存（exePath → dataURL，LRU 或 Map+上限）；失败返回占位图标
- [ ] 传输：批量随 `state:tasks` / `state:suggestions` 推送（apps 数组带 iconUrl），或独立 `app:icons` 拉取通道（按 exePath 批量），实现时择一并说明理由
- [ ] renderer：任务卡 meta 行 = app 图标组（无文字）；备选卡第二行 = app 图标组；二级菜单 = 图标 + 名称
- [ ] 图标尺寸 16-20px，深色背景可视（透明度/描边处理）；i18n 不需要新文案（tooltip 用 app 名）
- [ ] typecheck + npm test 全绿；真机：真实 exe（Chrome/Code/资源管理器）图标显示正确，未知 exe 显示占位

## 参考

drag.ts:163 getFileIcon 用法、shared/types.ts AppRef（id=exePath 规范名）、TaskCard/TaskDetail/SuggestionCard 现状。
