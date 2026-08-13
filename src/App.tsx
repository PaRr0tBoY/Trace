/**
 * App — root component.
 *
 * Wires up:
 *   - hydration (load items + settings on mount)
 *   - main->renderer event subscriptions (items/settings pushed from main)
 *   - theme application (accent + reduce-motion)
 *   - the edge-hover controller (open/close the blade)
 *   - the Panel itself
 */
import { useEffect } from 'react'
import { Panel } from './components/Panel'
import { CopyIndicatorCurve } from './components/CopyIndicatorCurve'
import { PreviewFlyout } from './components/PreviewFlyout'
import { IndicatorStyleFlyout } from './components/IndicatorStyleFlyout'
import { useStore } from './store/appStore'
import { edge } from './lib/edge'
import { applyReduceMotion, applyTheme } from './lib/theme'
import { useEdgeHover } from './hooks/useEdgeHover'

export default function App() {
  const hydrate = useStore((s) => s.hydrate)
  const setItems = useStore((s) => s.setItems)
  const setTasks = useStore((s) => s.setTasks)
  const setSuggestions = useStore((s) => s.setSuggestions)
  const setSettings = useStore((s) => s.setSettings)
  const pushToast = useStore((s) => s.pushToast)
  const settings = useStore((s) => s.settings)

  // Drive the edge open/close behavior.
  useEdgeHover()

  // Hydrate once + subscribe to pushed updates.
  useEffect(() => {
    void hydrate()
    const offItems = edge.onItems((items) => setItems(items))
    const offTasks = edge.onTasks((tasks) => setTasks(tasks))
    const offSuggestions = edge.onSuggestions((suggestions) => setSuggestions(suggestions))
    const offSettings = edge.onSettings((next) => setSettings(next))
    const offToast = edge.onToast((t) => pushToast(t))
    const offToggle = edge.onToggle((forceOpen) => {
      const next = forceOpen !== undefined ? forceOpen : !useStore.getState().open
      if (!next) {
        const state = useStore.getState()
        // If the indicator style flyout is open, let its exit spring play first
        // before collapsing the main panel — same sequencing as useEdgeHover's
        // closePanel(). Without this, both animate simultaneously and it looks broken.
        if (state.styleFlyoutOpen) {
          state.setStyleFlyoutOpen(false)
          window.setTimeout(() => {
            const s = useStore.getState()
            if (s.previewItemId) {
              s.setPreviewItemId(null)
              edge.setInteractive(false)
              window.setTimeout(() => { useStore.getState().setOpen(false) }, 240)
            } else {
              s.setOpen(false)
              edge.setInteractive(false)
            }
          }, 300)
        } else if (state.previewItemId) {
          state.setPreviewItemId(null)
          edge.setInteractive(false)
          window.setTimeout(() => {
            useStore.getState().setOpen(false)
          }, 240)
        } else {
          state.setOpen(false)
          edge.setInteractive(false)
        }
      } else {
        useStore.getState().setOpen(next)
        edge.setInteractive(next)
      }
    })
    const offOpenSettings = edge.onOpenSettings(() => {
      useStore.getState().setOpen(true)
      useStore.getState().setSettingsOpen(true)
      edge.setInteractive(true)
    })
    return () => {
      offItems()
      offTasks()
      offSuggestions()
      offSettings()
      offToast()
      offToggle()
      offOpenSettings()
    }
  }, [hydrate, setItems, setSettings, pushToast])

  // The panel window is created focusable:false (upstream legacy), so clicking
  // Keyboard-focus bridge (ticket 21): the panel is created with the OS style
  // pinned to WS_EX_NOACTIVATE so it never pops the taskbar or steals the
  // foreground on its own. Chromium, however, drops element.focus() and key
  // events for such a window, so whenever an editable element gains focus we
  // ask main to truly activate the window (setFocusable(true) + focus(),
  // focus.ts) — keystrokes then land here. main debounces the release, and
  // only restores NOACTIVATE once the panel closes, so focus juggling between
  // inputs (input <-> textarea) never flickers the window. Mounted only in
  // App — the onboarding window is a normal focusable window and needs none
  // of this.
  useEffect(() => {
    const isEditable = (target: EventTarget | null): target is HTMLElement =>
      target instanceof HTMLElement && target.matches('input, textarea, [contenteditable]')
    // True when the most recent pointerdown was NOT on an editable element.
    // Chromium replays a focusin to the previously focused input when the
    // window regains activation after a click — that replay is NOT a user
    // intent to type, so it must not re-arm the activation bridge (it would
    // fight the drop-activation request we just sent for the non-input click).
    let lastPointerOnNonInput = false
    const onFocusIn = (e: FocusEvent) => {
      if (isEditable(e.target) && !lastPointerOnNonInput) edge.requestInputFocus()
    }
    // NOTE: no focusout handler — activation is session-held while an input
    // is focused (switching between inputs must not flicker the window).
    // Dropping activation on non-input clicks happens in onPointerDown.`
    // Deadlock breaker: in an inactive document (window never activated yet)
    // Chromium silently drops element.focus() — activeElement stays put and
    // NO focusin is dispatched, so the focusin->activate chain above can
    // never start. pointerdown is delivered regardless of activation state,
    // so activate the window from the mouse-down on an editable element; the
    // browser then performs the real focus and focusin fires normally.
    const onPointerDown = (e: PointerEvent) => {
      if (isEditable(e.target)) {
        lastPointerOnNonInput = false
        edge.requestInputFocus()
      } else {
        // Click on a non-editable surface (card/button/chip): Chromium
        // activates the window on any click (focusable:true windows do this
        // internally, WS_EX_NOACTIVATE cannot stop it — verified). We do NOT
        // drop activation here anymore: blurring on every non-input click
        // made each click flip the window active<->inactive, which flickers
        // the transparent panel (layered-window re-synth). Keeping the
        // activation lets subsequent clicks be no-ops, and the user's
        // keyboard flow resumes naturally when they click back into their
        // own app. The flag below still blocks the focusin-replay misread.
        lastPointerOnNonInput = true
      }
    }
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [])

  // Apply theme whenever settings change.
  useEffect(() => {
    applyReduceMotion(settings.reduceMotion)
    applyTheme(settings.themeColor ?? 'graphite')
    const scale = settings.fontSizeScale ?? 1.0
    document.documentElement.style.setProperty('--font-scale', String(scale))
  }, [settings.reduceMotion, settings.fontSizeScale, settings.themeColor])

  return (
    <>
      <Panel />
      <CopyIndicatorCurve />
      <PreviewFlyout isRight={settings.stickPosition === 'right'} />
      <IndicatorStyleFlyout isRight={settings.stickPosition === 'right'} />
    </>
  )
}
