/**
 * Privacy gate — pure module (no Electron imports; vitest-direct).
 *
 * Spec 实现决策 7（隐私门）. Three permission planes: Capture / AI / Memory,
 * each exposed as a pure function that maps a policy + a moment's facts to
 * `{ allowed, reason }` — a denial always carries a reason for the trace /
 * diagnostic log ("已被隐私政策过滤").
 *
 * Orthogonality: evidence depth (EvidenceLevel L0–L4) and privacy sensitivity
 * are two independent axes. Depth is a *property of the data* carried in the
 * context; the policy judges by (app, content type, time range, tool) and
 * never reads depth — a screenshot can be L3 depth yet privacy-denied.
 *
 * Semantics decisions (locked here, consumed by tickets 44/45):
 * - captureAllowed mirrors the existing three switches verbatim
 *   (taskCaptureEnabled && l0CaptureEnabled && !incognito, same rule as
 *   ocr.ts isOcrAllowed). The spec-fixed PrivacyPolicy has no capture
 *   dimensions, so the collector injects the switches via the context.
 *   Switches missing from the context fail closed (privacy module default).
 * - aiTimeRangeHours = daily AI window end hour, 00:00-based (0–24);
 *   hourOfDay(now) < aiTimeRangeHours ⇒ allowed; undefined = all day.
 *   Computed from the epoch directly, so it is timezone-independent — callers
 *   pass the wall-clock moment as an epoch ms.
 * - Evaluation order (first hit wins, deterministic reasons for tests):
 *   master switch → denied-app list → content type → time range → tool switch.
 * - OCR (spec story 37) is the double gate: captureAllowed AND
 *   aiAllowed({ access: 'ocr' }); wiring lives in ticket 44.
 */
export type ContentType = 'text' | 'image' | 'files'

/** Evidence depth of a piece of data — orthogonal to privacy sensitivity. */
export enum EvidenceLevel {
  /** 元数据：应用名、窗口标题、时间戳 */
  L0 = 0,
  /** 结构化：聚类活动、应用集、时长 */
  L1 = 1,
  /** 语义：剪贴板文本、标题、理由 */
  L2 = 2,
  /** 视觉：截图、OCR 内容 */
  L3 = 3,
  /** 历史：证据时间线检索、长期记忆 */
  L4 = 4
}

/** The requested AI permission-plane dimension (tool / phase). */
export type AiAccess =
  | 'prefill' // 决策预填（含已匹配记忆 → 需 memoryAccess）
  | 'tasks' // search_tasks 工具
  | 'activities' // search_activities 工具
  | 'clipboard' // search_clipboard 工具（需 clipboardAccess）
  | 'memories' // search_memories 工具（需 memoryAccess）
  | 'ocr' // OCR 文本（AI 关闭时不跑）

export interface PrivacyPolicy {
  /** AI 总开关（决策预填 + 全部工具 + OCR 都过它）。 */
  aiEnabled: boolean
  /** 拒绝应用清单，exePath 归一化（小写 + 正斜杠，与 attributor 键空间同规则）。 */
  deniedApps: string[]
  /** 允许进 AI 的内容类型（剪贴板条目 / 关联材料）。 */
  allowedContentTypes: ContentType[]
  /** 每日 AI 可用截止小时（00:00 起算，0–24）；undefined = 全天不限。 */
  aiTimeRangeHours?: number
  /** search_clipboard 总开关（剪贴板预览访问）。 */
  clipboardAccess: boolean
  /** search_memories / 预填记忆 总开关。 */
  memoryAccess: boolean
  /** 记忆写入主开关（时段整理落库）。 */
  memoryEnabled: boolean
}

/** The facts of the moment for one judgement call. */
export interface PrivacyContext {
  /** 涉及的应用 exePath（归一化键，与 AppRef.id 同源）；AI 判定查拒绝清单。 */
  appExePath?: string
  /** 内容类型（剪贴板条目 / 关联材料）。 */
  contentType?: ContentType
  /** 当前时刻（Unix epoch ms）；缺省 = 判定时刻。 */
  now?: number
  /** 请求的 AI 权限面维度（工具/阶段）——aiAllowed 专属。 */
  access?: AiAccess
  /** 证据深度——数据的属性；政策不读它（正交维度，仅随判定上下文记录）。 */
  evidenceLevel?: EvidenceLevel
  /** 采集三开关（现有设置语义，由采集器注入）——captureAllowed 专属。 */
  captureEnabled?: boolean
  l0Enabled?: boolean
  incognito?: boolean
}

export interface PrivacyDecision {
  allowed: boolean
  /** 拒绝必带原因，供 trace / 诊断日志记录。 */
  reason?: string
}

/** 默认全开，显式可见：所有开关 true、三类内容全开、无拒绝清单、无时间限制。 */
export const DEFAULT_POLICY: PrivacyPolicy = {
  aiEnabled: true,
  deniedApps: [],
  allowedContentTypes: ['text', 'image', 'files'],
  clipboardAccess: true,
  memoryAccess: true,
  memoryEnabled: true
}

/** exePath 归一化（小写 + 正斜杠 + 去空白；与 attributor 键空间同规则）。 */
export function normalizeExePath(p: string): string {
  return p.trim().toLowerCase().replace(/\\/g, '/')
}

function allow(): PrivacyDecision {
  return { allowed: true }
}

function deny(reason: string): PrivacyDecision {
  return { allowed: false, reason }
}

/**
 * 采集许可。与现有三开关行为一致（taskCaptureEnabled && l0CaptureEnabled &&
 * !incognito）；开关缺省时 fail-closed。policy 当前没有采集维度，参数仅为
 * 三函数统一签名保留。
 */
export function captureAllowed(_policy: PrivacyPolicy, ctx: PrivacyContext): PrivacyDecision {
  if (ctx.captureEnabled !== true) {
    return deny('capture disabled (taskCaptureEnabled)')
  }
  if (ctx.l0Enabled !== true) {
    return deny('capture disabled (l0CaptureEnabled)')
  }
  if (ctx.incognito === true) {
    return deny('incognito mode active')
  }
  return allow()
}

/**
 * AI 访问许可。判定顺序（首个命中即返回）：总开关 → 拒绝清单（exePath
 * 归一化匹配）→ 内容类型 → 时间范围 → 工具开关。被拒数据绝不进 Agent——
 * 决策预填同样过门（预填含已匹配记忆，故 'prefill' 需 memoryAccess）。
 */
export function aiAllowed(policy: PrivacyPolicy, ctx: PrivacyContext): PrivacyDecision {
  if (!policy.aiEnabled) {
    return deny('ai disabled')
  }
  const app = ctx.appExePath
  if (app !== undefined && app.trim().length > 0) {
    const key = normalizeExePath(app)
    if (policy.deniedApps.some((d) => normalizeExePath(d) === key)) {
      return deny(`app on denied list: ${key}`)
    }
  }
  const ct = ctx.contentType
  if (ct !== undefined && !policy.allowedContentTypes.includes(ct)) {
    return deny(`content type not allowed: ${ct}`)
  }
  const hours = policy.aiTimeRangeHours
  if (hours !== undefined) {
    // 本地时区墙钟小时（epoch % 24 是 UTC，会把 UTC+8 用户的 18:00 截止推迟到本地 22:00）。
    const hourOfDay = new Date(ctx.now ?? Date.now()).getHours()
    if (hourOfDay >= hours) {
      return deny(`outside ai time range (hour ${hourOfDay.toFixed(1)} >= ${hours})`)
    }
  }
  const access = ctx.access
  if (access === 'clipboard' && !policy.clipboardAccess) {
    return deny('clipboard access disabled')
  }
  if ((access === 'memories' || access === 'prefill') && !policy.memoryAccess) {
    return deny('memory access disabled')
  }
  return allow()
}

/**
 * 记忆写入许可。主开关为 memoryEnabled（时段整理落库的闸门）；被拒原因供
 * trace 记录。ctx 当前无记忆写入维度，参数仅为三函数统一签名保留。
 */
export function memoryAllowed(policy: PrivacyPolicy, _ctx: PrivacyContext): PrivacyDecision {
  if (!policy.memoryEnabled) {
    return deny('memory writes disabled')
  }
  return allow()
}
