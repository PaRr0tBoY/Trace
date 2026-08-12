/**
 * SearchBar — on-demand search (user request): hidden by default, revealed
 * the moment the user starts typing while the panel is open. The first
 * printable keystroke focuses the input and lands the character; the bar
 * hides again on blur only when the query is empty (a non-empty query keeps
 * it visible so the user can return and keep typing). The panel being
 * collapsed hides it unconditionally.
 *
 * The component only mounts for the clipboard and files views (Panel), so
 * keystrokes in the tasks view or the settings sheet never trigger it.
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store/appStore'
import { SearchIcon } from './icons'

export function SearchBar() {
  const query = useStore((s) => s.query)
  const setQuery = useStore((s) => s.setQuery)
  const open = useStore((s) => s.open)
  // Restored queries (restore mechanism / view switches) keep the bar up.
  const [visible, setVisible] = useState(() => query.length > 0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      setVisible(false)
      return
    }
    const onKeyDown = (e: KeyboardEvent) => {
      // Only a bare printable character counts as "start typing": skip
      // modifier combos, IME composition (e.key === 'Process' or composing)
      // and whitespace (space is a content key, not a reveal trigger).
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Process' || e.isComposing) return
      if (e.key.length !== 1 || e.key === ' ') return
      const el = document.activeElement
      if (el instanceof HTMLElement && el.matches('input, textarea, [contenteditable]')) return
      e.preventDefault()
      setVisible(true)
      setQuery(useStore.getState().query + e.key)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
    // Hide when the user clicks away with an empty query. Mouse events reach
    // the panel even when the window is not keyboard-activated, while
    // focusout is NOT dispatched while the document is unfocused (measured:
    // focusable:false windows never have document focus, so blur() changes
    // activeElement without firing any event). Click is the reliable path.
    const onClick = () => {
      const st = useStore.getState()
      if (st.query === '' && document.activeElement !== inputRef.current) setVisible(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('click', onClick, true)
    }
  }, [open, setQuery])

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          key="search"
          className="search"
          initial={{ opacity: 0, height: 0, marginBottom: 0 }}
          animate={{ opacity: 1, height: 42, marginBottom: 6 }}
          exit={{ opacity: 0, height: 0, marginBottom: 0 }}
          transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          style={{ overflow: 'hidden' }}
        >
          <SearchIcon className="search-icon" width={14} height={14} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search clipboard…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onBlur={() => {
              // Empty query + focus loss = done searching; keep the bar
              // around while there is something to return to. (In
              // focusable:false windows this never fires — the click
              // listener above is the reliable hide path.)
              if (useStore.getState().query.trim() === '') setVisible(false)
            }}
            spellCheck={false}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
