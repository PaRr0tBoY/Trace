import { describe, expect, it } from 'vitest'

import {
  DEFAULT_POLICY,
  EvidenceLevel,
  aiAllowed,
  captureAllowed,
  memoryAllowed,
  normalizeExePath,
  type PrivacyPolicy
} from '../electron/store/privacyGate'

/** 固定时刻（本地时区墙钟）：10:00 与 22:00。用本地构造，任何时区下 getHours() 恒等于该小时。 */
const T10 = new Date(2026, 7, 13, 10, 0, 0, 0).getTime()
const T22 = new Date(2026, 7, 13, 22, 0, 0, 0).getTime()

const ALL_ACCESS = ['prefill', 'tasks', 'activities', 'clipboard', 'memories', 'ocr'] as const

function policy(overrides: Partial<PrivacyPolicy>): PrivacyPolicy {
  return { ...DEFAULT_POLICY, ...overrides }
}

describe('DEFAULT_POLICY — 默认全开显式可见', () => {
  it('五维全开、无拒绝清单、无时间限制', () => {
    expect(DEFAULT_POLICY).toEqual({
      aiEnabled: true,
      deniedApps: [],
      allowedContentTypes: ['text', 'image', 'files'],
      clipboardAccess: true,
      memoryAccess: true,
      memoryEnabled: true
    })
    expect(DEFAULT_POLICY.aiTimeRangeHours).toBeUndefined()
  })

  it('全开政策下 aiAllowed 对任何 AI 维度放行', () => {
    for (const access of ALL_ACCESS) {
      expect(aiAllowed(DEFAULT_POLICY, { access, now: T10 }).allowed).toBe(true)
    }
  })
})

describe('captureAllowed — 采集三开关（现有语义不变）', () => {
  it('三开关全开时放行', () => {
    expect(
      captureAllowed(DEFAULT_POLICY, { captureEnabled: true, l0Enabled: true, incognito: false })
    ).toEqual({ allowed: true })
  })

  it('采集主开关（taskCaptureEnabled）关闭时拒绝并带原因', () => {
    const d = captureAllowed(DEFAULT_POLICY, { captureEnabled: false, l0Enabled: true, incognito: false })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBeTruthy()
  })

  it('L0 开关（l0CaptureEnabled）关闭时拒绝并带原因', () => {
    const d = captureAllowed(DEFAULT_POLICY, { captureEnabled: true, l0Enabled: false, incognito: false })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBeTruthy()
  })

  it('隐身模式（incognito）拒绝', () => {
    const d = captureAllowed(DEFAULT_POLICY, { captureEnabled: true, l0Enabled: true, incognito: true })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBeTruthy()
  })

  it('开关缺省时保守拒绝（fail-closed）', () => {
    expect(captureAllowed(DEFAULT_POLICY, {}).allowed).toBe(false)
  })
})

describe('aiAllowed — 总开关', () => {
  it('aiEnabled=false 拒绝一切 AI 维度并带原因', () => {
    const p = policy({ aiEnabled: false })
    for (const access of ALL_ACCESS) {
      const d = aiAllowed(p, { access, now: T10 })
      expect(d.allowed).toBe(false)
      expect(d.reason).toBeTruthy()
    }
  })
})

describe('aiAllowed — 拒绝清单（exePath 归一化匹配）', () => {
  it('命中拒绝清单拒绝并带原因', () => {
    const p = policy({ deniedApps: ['c:/windows/system32/notepad.exe'] })
    const d = aiAllowed(p, { appExePath: 'C:\\Windows\\System32\\Notepad.exe', access: 'prefill', now: T10 })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/denied/i)
  })

  it('未命中拒绝清单放行', () => {
    const p = policy({ deniedApps: ['c:/windows/system32/notepad.exe'] })
    expect(aiAllowed(p, { appExePath: 'c:/program files/vscode/code.exe', access: 'prefill', now: T10 }).allowed).toBe(true)
  })

  it('无 exePath 时不应用应用检查', () => {
    expect(aiAllowed(policy({ deniedApps: ['x.exe'] }), { access: 'prefill', now: T10 }).allowed).toBe(true)
  })
})

describe('aiAllowed — 内容类型', () => {
  it('类型被排除时拒绝并带原因', () => {
    const p = policy({ allowedContentTypes: ['text', 'files'] })
    const d = aiAllowed(p, { contentType: 'image', access: 'clipboard', now: T10 })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/content type/i)
  })

  it('类型允许时放行', () => {
    expect(aiAllowed(policy({ allowedContentTypes: ['text'] }), { contentType: 'text', access: 'clipboard', now: T10 }).allowed).toBe(true)
  })

  it('无内容类型时不应用类型检查', () => {
    expect(aiAllowed(policy({ allowedContentTypes: ['text'] }), { access: 'tasks', now: T10 }).allowed).toBe(true)
  })
})

describe('aiAllowed — 时间范围（aiTimeRangeHours，00:00 起算的每日截止小时）', () => {
  it('undefined = 全天不限', () => {
    expect(aiAllowed(policy({ aiTimeRangeHours: undefined }), { access: 'prefill', now: T22 }).allowed).toBe(true)
  })

  it('窗口内放行', () => {
    expect(aiAllowed(policy({ aiTimeRangeHours: 18 }), { access: 'prefill', now: T10 }).allowed).toBe(true)
  })

  it('窗外拒绝并带原因', () => {
    const d = aiAllowed(policy({ aiTimeRangeHours: 18 }), { access: 'prefill', now: T22 })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/time range/i)
  })

  it('24 = 全天', () => {
    expect(aiAllowed(policy({ aiTimeRangeHours: 24 }), { access: 'prefill', now: T22 }).allowed).toBe(true)
  })

  it('0 = 任何时刻都拒绝', () => {
    expect(aiAllowed(policy({ aiTimeRangeHours: 0 }), { access: 'prefill', now: T10 }).allowed).toBe(false)
  })

  it('精确边界：hours=18 时本地 18:00:00.000 拒绝、17:59:59.999 放行', () => {
    const at18 = new Date(2026, 7, 13, 18, 0, 0, 0).getTime()
    const at1759 = new Date(2026, 7, 13, 17, 59, 59, 999).getTime()
    const p = policy({ aiTimeRangeHours: 18 })
    expect(aiAllowed(p, { access: 'prefill', now: at18 }).allowed).toBe(false)
    expect(aiAllowed(p, { access: 'prefill', now: at1759 }).allowed).toBe(true)
  })
})

describe('aiAllowed — 工具开关', () => {
  it('clipboardAccess=false 拒绝 search_clipboard', () => {
    const p = policy({ clipboardAccess: false })
    const d = aiAllowed(p, { access: 'clipboard', now: T10 })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/clipboard/i)
  })

  it('clipboardAccess=false 不影响非剪贴板工具', () => {
    const p = policy({ clipboardAccess: false })
    expect(aiAllowed(p, { access: 'tasks', now: T10 }).allowed).toBe(true)
    expect(aiAllowed(p, { access: 'prefill', now: T10 }).allowed).toBe(true)
  })

  it('memoryAccess=false 拒绝 search_memories 与预填（预填含已匹配记忆）', () => {
    const p = policy({ memoryAccess: false })
    expect(aiAllowed(p, { access: 'memories', now: T10 }).allowed).toBe(false)
    expect(aiAllowed(p, { access: 'prefill', now: T10 }).allowed).toBe(false)
  })

  it('memoryAccess=false 不影响非记忆工具', () => {
    const p = policy({ memoryAccess: false })
    expect(aiAllowed(p, { access: 'tasks', now: T10 }).allowed).toBe(true)
  })

  it('AI 关闭时 OCR 拒绝（AI 权限门）', () => {
    expect(aiAllowed(policy({ aiEnabled: false }), { access: 'ocr', now: T10 }).allowed).toBe(false)
  })
})

describe('memoryAllowed — 记忆写入主开关', () => {
  it('memoryEnabled=true 放行', () => {
    expect(memoryAllowed(DEFAULT_POLICY, {}).allowed).toBe(true)
  })

  it('memoryEnabled=false 拒绝并带原因', () => {
    const d = memoryAllowed(policy({ memoryEnabled: false }), {})
    expect(d.allowed).toBe(false)
    expect(d.reason).toBeTruthy()
  })
})

describe('证据深度 × 隐私敏感度 — 两维正交', () => {
  it('L3 深度 + 全开政策 → 放行（深度不是拒绝依据）', () => {
    expect(aiAllowed(DEFAULT_POLICY, { contentType: 'image', evidenceLevel: EvidenceLevel.L3, access: 'clipboard', now: T10 }).allowed).toBe(true)
  })

  it('L3 深度但图片类型被排除 → 按敏感度拒绝（"L3 深度但 denied"可表达）', () => {
    const p = policy({ allowedContentTypes: ['text', 'files'] })
    const d = aiAllowed(p, { contentType: 'image', evidenceLevel: EvidenceLevel.L3, access: 'clipboard', now: T10 })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/content type/i)
  })

  it('同一政策下 L0 与 L3 判定一致（政策不读深度）', () => {
    const p = policy({ allowedContentTypes: ['text'] })
    const low = aiAllowed(p, { contentType: 'image', evidenceLevel: EvidenceLevel.L0, access: 'clipboard', now: T10 })
    const high = aiAllowed(p, { contentType: 'image', evidenceLevel: EvidenceLevel.L3, access: 'clipboard', now: T10 })
    expect(low.allowed).toBe(false)
    expect(high.allowed).toBe(low.allowed)
  })
})

describe('判定顺序 — 首个命中原因优先', () => {
  it('拒绝清单优先于内容类型与工具开关', () => {
    const p = policy({ deniedApps: ['c:/apps/secrets.exe'], allowedContentTypes: ['text'] })
    const d = aiAllowed(p, {
      appExePath: 'c:/apps/secrets.exe',
      contentType: 'image',
      access: 'clipboard',
      now: T10
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/denied/i)
  })
})

describe('normalizeExePath — 与 attributor 键空间同规则', () => {
  it('小写 + 正斜杠 + 去空白', () => {
    expect(normalizeExePath('C:\\Program Files\\App.exe')).toBe('c:/program files/app.exe')
    expect(normalizeExePath(' C:/x.EXE ')).toBe('c:/x.exe')
  })
})
