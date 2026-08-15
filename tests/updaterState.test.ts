/**
 * Renderer update state machine (appStore): manual check lifecycle, event
 * ingestion from main (app:update-available/downloaded), dismiss + install.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const edgeMock = {
  checkForUpdatesManual: vi.fn(),
  startUpdateDownload: vi.fn(),
  installUpdate: vi.fn()
}
vi.stubGlobal('window', { edge: edgeMock })

import { useStore } from '../src/store/appStore'

describe('appStore update state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useStore.setState({ updateInfo: null, manualCheckState: { status: 'idle' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('window', { edge: edgeMock })
  })

  it('manual check: available drives the banner state', async () => {
    edgeMock.checkForUpdatesManual.mockResolvedValue({ status: 'available', version: '2026.8.13' })
    await useStore.getState().startManualCheck()
    const s = useStore.getState()
    expect(s.manualCheckState).toEqual({ status: 'available', version: '2026.8.13' })
    expect(s.updateInfo).toEqual({ hasUpdate: true, latestVersion: '2026.8.13', downloaded: false })
  })

  it('manual check: up-to-date keeps the banner hidden', async () => {
    edgeMock.checkForUpdatesManual.mockResolvedValue({ status: 'up-to-date', version: '2026.8.12' })
    await useStore.getState().startManualCheck()
    const s = useStore.getState()
    expect(s.manualCheckState).toEqual({ status: 'up-to-date', version: '2026.8.12' })
    expect(s.updateInfo).toBeNull()
  })

  it('manual check: error surfaces a retryable state', async () => {
    edgeMock.checkForUpdatesManual.mockResolvedValue({ status: 'error', error: 'boom' })
    await useStore.getState().startManualCheck()
    expect(useStore.getState().manualCheckState).toEqual({ status: 'error', error: 'boom' })
  })

  it('manual check: rejected promise maps to error', async () => {
    edgeMock.checkForUpdatesManual.mockRejectedValue(new Error('net down'))
    await useStore.getState().startManualCheck()
    expect(useStore.getState().manualCheckState).toEqual({ status: 'error', error: 'net down' })
  })

  it('manual download: flips to downloading and calls the bridge', async () => {
    edgeMock.startUpdateDownload.mockResolvedValue(undefined)
    const p = useStore.getState().startManualDownload()
    expect(useStore.getState().manualCheckState.status).toBe('downloading')
    await p
    expect(edgeMock.startUpdateDownload).toHaveBeenCalledOnce()
  })

  it('background event: update-available sets the banner (downloaded=false)', () => {
    useStore.getState().setUpdateAvailable({ version: '2026.8.13' })
    expect(useStore.getState().updateInfo).toEqual({ hasUpdate: true, latestVersion: '2026.8.13', downloaded: false })
  })

  it('background event: update-downloaded flips the banner to ready-to-install', () => {
    useStore.getState().setUpdateAvailable({ version: '2026.8.13' })
    useStore.getState().setUpdateDownloaded({ version: '2026.8.13' })
    const s = useStore.getState()
    expect(s.updateInfo).toEqual({ hasUpdate: true, latestVersion: '2026.8.13', downloaded: true })
    expect(s.manualCheckState.status).toBe('idle')
  })

  it('dismiss clears the banner and resets the check state', () => {
    useStore.getState().setUpdateAvailable({ version: '2026.8.13' })
    useStore.getState().dismissUpdate()
    expect(useStore.getState().updateInfo).toBeNull()
    expect(useStore.getState().manualCheckState.status).toBe('idle')
  })

  it('installUpdate delegates to the bridge', async () => {
    edgeMock.installUpdate.mockResolvedValue(undefined)
    await useStore.getState().installUpdate()
    expect(edgeMock.installUpdate).toHaveBeenCalledOnce()
  })
})
