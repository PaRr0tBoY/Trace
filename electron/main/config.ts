/** App-wide constants and environment flags for the main process. */

/** Mutable runtime flags (kept separate from the frozen config object). */
export const runtime = {
  /** Set true only while the app is genuinely quitting (tray -> Quit). */
  quitting: false
}

export const APP_CONFIG = {
  appName: 'Trace',
  /** Custom protocol used to serve local image files to the renderer securely. */
  imageProtocol: 'tracelocal',
  is: {
    get dev(): boolean {
      return !!process.env.ELECTRON_RENDERER_URL || process.env.NODE_ENV === 'development'
    }
  }
} as const
