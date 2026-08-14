import { describe, expect, it, vi } from 'vitest'
import { useStore } from '../src/store/appStore'
import { dropOnSaveZone, saveZoneContext, saveZoneCopy } from '../src/components/tasks/dropActions'
import type { DragRequest } from '../shared/types'

/** Save-zone routing (T5): external content enters the station, internal
 * clipboard/station drags are labelled no-ops. */
describe('saveZoneContext', () => {
  it('external drags classify as external regardless of ids', () => {
    expect(saveZoneContext(true, undefined, [])).toBe('external')
    expect(saveZoneContext(true, 'st-1', ['st-1'])).toBe('external')
  })

  it('internal station entries classify as station', () => {
    expect(saveZoneContext(false, 'st-1', ['st-1', 'st-2'])).toBe('station')
  })

  it('internal clipboard items classify as clipboard', () => {
    expect(saveZoneContext(false, 'it-1', ['st-1'])).toBe('clipboard')
    expect(saveZoneContext(false, undefined, ['st-1'])).toBe('clipboard')
  })
})

describe('saveZoneCopy', () => {
  it('maps every context to its i18n keys', () => {
    expect(saveZoneCopy('external')).toEqual({
      title: 'tasks.saveZoneExternal',
      hint: 'tasks.saveZoneExternalHint'
    })
    expect(saveZoneCopy('clipboard')).toEqual({ title: 'tasks.saveZoneClipboard' })
    expect(saveZoneCopy('station')).toEqual({ title: 'tasks.saveZoneStation' })
  })
})

describe('dropOnSaveZone', () => {
  it('external file paths enter the station', async () => {
    const enter = vi.fn()
    useStore.setState({ stationEnter: enter })
    await dropOnSaveZone(null, ['C:\\a.txt', 'D:\\b.png'])
    expect(enter).toHaveBeenCalledWith(['C:\\a.txt', 'D:\\b.png'])
  })

  it('internal drags are no-ops', async () => {
    const enter = vi.fn()
    useStore.setState({ stationEnter: enter })
    await dropOnSaveZone({ id: 'it-1' } as DragRequest)
    await dropOnSaveZone({ id: 'st-1', paths: ['C:\\a.txt'] } as DragRequest)
    expect(enter).not.toHaveBeenCalled()
  })
})
