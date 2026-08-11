import { describe, expect, it } from 'vitest'

import { mergeAppOptions } from '../electron/main/appOptions'
import type { AppSwitchEvent, ClipboardItem, UsageEvent } from '../shared/types'

const ev = (overrides: Partial<AppSwitchEvent> = {}): UsageEvent => ({
  type: 'app-switch',
  appName: 'Code',
  exePath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  pid: 1,
  windowTitle: '',
  ts: 1_000_000,
  ...overrides
})

const item = (id: string, sourceApp?: ClipboardItem['sourceApp']): ClipboardItem => ({
  id,
  data: { kind: 'text', text: 'x', isUrl: false },
  capturedAt: 1,
  hitCount: 1,
  pinned: false,
  sourceApp
})

describe('mergeAppOptions', () => {
  it('unions event-bus apps and clipboard sourceApps, deduped by identity key', () => {
    const options = mergeAppOptions(
      [
        ev({ appName: 'Chrome', exePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }),
        ev({ appName: 'Code', exePath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe' })
      ],
      [item('a', { name: 'Chrome', exePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' })]
    )
    expect(options).toHaveLength(2)
    expect(options.map((o) => o.id).sort()).toEqual([
      'c:/program files/google/chrome/application/chrome.exe',
      'c:/program files/microsoft vs code/code.exe'
    ])
  })

  it('keeps apps seen only by the event bus (no clipboard items) and vice versa', () => {
    const busOnly = mergeAppOptions([ev({ appName: 'Explorer', exePath: 'C:\\Windows\\explorer.exe' })], [])
    expect(busOnly.map((o) => o.name)).toEqual(['Explorer'])

    const clipOnly = mergeAppOptions([], [item('a', { name: 'Notepad', exePath: 'C:\\Windows\\notepad.exe' })])
    expect(clipOnly.map((o) => o.name)).toEqual(['Notepad'])
  })

  it('falls back to the process name as the id when no exePath is known', () => {
    const options = mergeAppOptions([ev({ appName: 'Paint', exePath: '' })], [item('a', { name: 'Paint' })])
    expect(options).toHaveLength(1)
    expect(options[0].id).toBe('paint')
  })

  it('skips empty identities and sorts by name', () => {
    const options = mergeAppOptions(
      [
        ev({ appName: 'Zed', exePath: 'C:\\Zed.exe' }),
        ev({ appName: '', exePath: '' }),
        ev({ appName: 'Alpha', exePath: 'C:\\Alpha.exe' })
      ],
      []
    )
    expect(options.map((o) => o.name)).toEqual(['Alpha', 'Zed'])
  })
})
