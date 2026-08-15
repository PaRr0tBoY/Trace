/**
 * Renderer-side access to the preload bridge.
 *
 * `window.edge` is injected by the preload script via contextBridge. We type it
 * from the shared `EdgeApi` contract so the rest of the renderer code gets full
 * autocomplete and type-safety without importing anything Electron-specific.
 */
import type { EdgeApi } from '../../shared/bridge'

declare global {
  interface Window {
    edge: EdgeApi
  }
}

export const edge: EdgeApi = new Proxy({} as EdgeApi, {
  get(_target, prop) {
    // The bridge may be absent entirely, or present but partial (a mock or
    // extension stub). EdgeApi members are all functions, so any non-function
    // value means "unavailable" — no-op instead of leaking undefined through.
    if (typeof prop !== 'string') return () => {}
    // globalThis isn't indexed in the node tsconfig; the renderer's window
    // only exists in a browser/Electron context, so narrow before reading.
    const g: object = globalThis
    const win: Window | undefined = 'window' in g ? (g.window as Window) : undefined
    const targetApi = win?.edge
    const val = targetApi?.[prop as keyof EdgeApi]
    if (typeof val === 'function') return val.bind(targetApi)
    // Every on* member returns an unsubscribe function, so its no-op must be
    // callable twice: edge.onX(cb) → () => {}. Plain members return undefined
    // (callers guard or fire-and-forget).
    return prop.startsWith('on') ? () => () => {} : () => {}
  }
})
