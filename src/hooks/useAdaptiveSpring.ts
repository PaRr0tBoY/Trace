import { useMemo } from 'react'
import type { Transition } from 'framer-motion'

/**
 * Returns Framer Motion spring presets calibrated to the current display.
 *
 * Goals:
 *  - Critically damped (ratio ≥ 1.0) — settles without overshoot or ring.
 *  - restDelta / restSpeed at 0.05 px: sub-pixel to the eye (0.05 px is far
 *    below a device pixel) yet loose enough that the spring exits the
 *    animation loop ~30% sooner than 0.001, freeing the main thread for the
 *    next interaction.
 *  - Hi-DPI: stiffer + heavier damping because sub-pixel overshoot is
 *    more visible at 2× and the GPU fill-rate budget is tighter on 4K.
 */
export function useAdaptiveSpring() {
  return useMemo(() => {
    const dpr = window.devicePixelRatio || 1

    if (dpr >= 1.75) {
      // Hi-DPI (2×+): Apple fluid spring curve
      return {
        type: 'spring',
        stiffness: 320,
        damping: 30,
        mass: 0.8,
        restDelta: 0.05,
        restSpeed: 0.05
      } as const
    }

    // Standard DPI: smooth fluid spring curve
    return {
      type: 'spring',
      stiffness: 300,
      damping: 28,
      mass: 0.8,
      restDelta: 0.05,
      restSpeed: 0.05
    } as const
  }, [])
}

/**
 * The blade's open transition — a Dynamic-Island-style settle on the
 * background layer (.blade-bg in Panel.tsx): the black shape pokes ~2% of
 * the blade width (5.4px at 270px) past the rest edge and settles back while
 * the clip reveal opens. Content in .blade never scales — only the shape
 * moves.
 *
 * Keyframe shape (times relative to the 0.42s total, keyframes [1, 1.02, 1]):
 *   1 → 1.02  0–150ms  exceed, expo-out — starts the instant the panel opens,
 *                      peaking exactly as the clip-path reveal reaches the
 *                      blade's full width (the clip's right edge passes 270px
 *                      at ~145ms of its 0.3s ease-out; the rest of the clip
 *                      animation just extends the crop box past the element
 *                      and does not affect visibility). No hold, no gap —
 *                      the poke hands off from the reveal like a relay.
 *   1.02 → 1  150–420ms pull-back, ease-in-out cubic — launches softly from
 *                      the peak, fastest at the midpoint, settles gradually.
 *
 * Why keyframes and not a spring: a single under-damped spring overshoots at
 * ~108ms — still inside the clip reveal, which keeps growing and masks the
 * overshoot entirely (that was the first attempt). framer-motion does not
 * support per-segment spring transitions (getValueTransition spreads a
 * transition array into numbered keys), so the exceed and pull-back are
 * beziers shaped like a spring's trajectory, not a spring itself.
 *
 * Deliberately NOT gated on the OS prefers-reduced-motion flag: the blade
 * reveal is the app's core orientation feedback, and gating it on the OS
 * setting silently disabled every animation on machines with "Show
 * animations" off (the author's own setup — verified via Chromium
 * matchMedia). Motion level is the user's in-app choice instead: the bounce
 * plays only under 'extended'; 'standard' keeps the plain clip reveal.
 */
export function useOpenBounce(): Transition {
  return useMemo<Transition>(() => {
    return {
      duration: 0.42,
      times: [0, 0.357, 1],
      ease: [
        [0.22, 1, 0.36, 1],
        [0.65, 0, 0.35, 1]
      ]
    }
  }, [])
}

/**
 * A gentler spring for secondary surfaces (flyout content, settings panes).
 * Slightly slower stiffness so it doesn't feel abrupt against the blade motion.
 */
export function useSubtleSpring() {
  return useMemo(() => {
    return {
      type: 'spring',
      stiffness: 340,
      damping: 34,
      mass: 0.65,
      restDelta: 0.05,
      restSpeed: 0.05
    } as const
  }, [])
}
