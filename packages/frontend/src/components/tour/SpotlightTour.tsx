// RFC-211 §12 — hand-holding spotlight tour.
//
// The user asked for a walk-through that guides a newcomer through the REAL
// interface step by step, not a page where you press "build it for me". That
// deliberately overrides RFC-199's "no tutorial overlay" stance (user decision,
// 2026-07-21).
//
// How it works: a persistent provider (mounted in the app shell, so it survives
// route changes) holds "which tour, which step". A portaled overlay dims the
// page, cuts a hole around the step's anchor element (found by a `data-tour`
// attribute), and floats a bubble next to it with the instruction and the
// controls. A step either advances when the user lands on a target route
// (`advanceOnRoute`) or when they press Next — so the tour follows the user as
// they actually operate the product, and never traps them (Skip is always one
// key away).
//
// Anchors live on the real components (nav items, form fields, buttons) as
// `data-tour="…"`; the tour script (tourScript.ts) references them by name.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { getTour, isTourId, type TourId, type TourStep } from './tourScript'

interface TourState {
  tourId: TourId
  stepIndex: number
}

interface TourContextValue {
  active: TourState | null
  start: (tourId: TourId) => void
  stop: () => void
  next: () => void
  back: () => void
}

const TourContext = createContext<TourContextValue | null>(null)

/** Per-browser persistence — the tour is UI progress, not server state. */
const STORAGE_KEY = 'aw-tour'
/** Sticky flag: set the first time any tour starts, so the homepage stops
 *  inviting a user who has already taken (or dismissed) the tour. */
const TOUR_SEEN_KEY = 'aw-tour-seen'

/** True once the user has started a tour at least once (per browser). */
export function hasSeenTour(): boolean {
  try {
    return window.localStorage.getItem(TOUR_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

function loadState(): TourState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as TourState
    // Impl-gate P1-2: domain-check, not just shape-check. Persisted state
    // outlives tour-script edits (renamed tour, shortened steps) and can be
    // hand-mangled (NaN passes `typeof === 'number'`); an out-of-domain value
    // used to crash the overlay on EVERY load with no in-product recovery.
    // Bad state self-heals: drop it and start clean.
    if (
      typeof parsed?.tourId === 'string' &&
      isTourId(parsed.tourId) &&
      typeof parsed?.stepIndex === 'number' &&
      Number.isInteger(parsed.stepIndex) &&
      parsed.stepIndex >= 0 &&
      parsed.stepIndex < getTour(parsed.tourId).steps.length
    )
      return parsed
    window.localStorage.removeItem(STORAGE_KEY)
    return null
  } catch {
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore — private mode etc.; a null return is already safe
    }
    return null
  }
}

function saveState(s: TourState | null): void {
  try {
    if (s === null) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* private mode / disabled storage — the tour just won't persist */
  }
}

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext)
  if (ctx === null) throw new Error('useTour must be used inside <TourProvider>')
  return ctx
}

/**
 * Mounts the tour state + overlay. Place high in the tree (app shell) so a step
 * can span routes without the overlay unmounting between pages.
 */
export function TourProvider({ pathname, children }: { pathname: string; children: ReactNode }) {
  const [active, setActive] = useState<TourState | null>(() => loadState())

  const commit = useCallback((s: TourState | null) => {
    setActive(s)
    saveState(s)
  }, [])

  const start = useCallback(
    (tourId: TourId) => {
      try {
        window.localStorage.setItem(TOUR_SEEN_KEY, '1')
      } catch {
        /* storage disabled — the homepage nudge just keeps showing */
      }
      commit({ tourId, stepIndex: 0 })
    },
    [commit],
  )
  const stop = useCallback(() => commit(null), [commit])

  const next = useCallback(() => {
    setActive((prev) => {
      if (prev === null) return null
      const tour = getTour(prev.tourId)
      if (prev.stepIndex + 1 >= tour.steps.length) {
        saveState(null)
        return null
      }
      const nextState = { ...prev, stepIndex: prev.stepIndex + 1 }
      saveState(nextState)
      return nextState
    })
  }, [])

  const back = useCallback(() => {
    setActive((prev) => {
      if (prev === null || prev.stepIndex === 0) return prev
      const nextState = { ...prev, stepIndex: prev.stepIndex - 1 }
      saveState(nextState)
      return nextState
    })
  }, [])

  const value = useMemo<TourContextValue>(
    () => ({ active, start, stop, next, back }),
    [active, start, stop, next, back],
  )

  return (
    <TourContext.Provider value={value}>
      {children}
      {active !== null && <SpotlightOverlay pathname={pathname} state={active} />}
    </TourContext.Provider>
  )
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

/**
 * Set a React-controlled input's value from outside React: the native setter
 * bypasses React's value tracker, and the dispatched input event makes onChange
 * fire so the component state actually updates.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * Poll the anchor's position. Elements move (layout, async render, scroll), and
 * the target may not exist yet when a step first activates because the user has
 * not navigated to its page — in that case we render a "go to X" prompt instead
 * of a hole over nothing.
 */
function useAnchorRect(selector: string, deps: unknown[]): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null)
  useLayoutEffect(() => {
    let raf = 0
    const measure = (): void => {
      const el = document.querySelector(selector)
      if (el === null) {
        setRect((prev) => (prev === null ? prev : null))
      } else {
        const r = el.getBoundingClientRect()
        // Impl-gate P2-3: compare before set — an unconditional fresh object
        // every frame re-rendered the whole overlay at 60fps for the entire
        // duration of every step.
        setRect((prev) =>
          prev !== null &&
          prev.top === r.top &&
          prev.left === r.left &&
          prev.width === r.width &&
          prev.height === r.height
            ? prev
            : { top: r.top, left: r.left, width: r.width, height: r.height },
        )
      }
      raf = window.requestAnimationFrame(measure)
    }
    measure()
    return () => window.cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return rect
}

function SpotlightOverlay({ pathname, state }: { pathname: string; state: TourState }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { next, back, stop } = useTour()
  const tour = getTour(state.tourId)
  const step: TourStep | undefined = tour.steps[state.stepIndex]
  const bubbleRef = useRef<HTMLDivElement | null>(null)

  const onRightPage =
    step?.route === undefined || pathname === step.route || pathname.startsWith(step.route)
  const rect = useAnchorRect(step?.anchor ?? '', [step?.anchor, pathname, state.stepIndex])

  // Impl-gate P2-2: "right page but the anchor never showed up" is a dead end
  // for a do-the-thing step (no Next by design, nothing to click). A missing
  // anchor is normal for a moment while the page renders — so only after it
  // stays missing do we offer an escape-hatch Next. Reset on every step/route
  // change and whenever the anchor appears.
  const anchorMissing = rect === null
  const [anchorStale, setAnchorStale] = useState(false)
  useEffect(() => {
    setAnchorStale(false)
    if (!onRightPage || !anchorMissing) return
    const id = window.setTimeout(() => setAnchorStale(true), 3000)
    return () => window.clearTimeout(id)
  }, [onRightPage, anchorMissing, state.stepIndex, pathname])

  // Prefill the step's field once it exists — the user watches the example
  // value land instead of typing it. Retries briefly because the form may still
  // be mounting when the step opens.
  useEffect(() => {
    const fill = step?.fill
    if (fill === undefined) return
    let tries = 0
    let done = false
    const id = window.setInterval(() => {
      tries += 1
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(fill.selector)
      if (el !== null) {
        if (el.value !== fill.value) setNativeValue(el, fill.value)
        done = true
      }
      if (done || tries > 20) window.clearInterval(id)
    }, 100)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.stepIndex, pathname])

  // Route-driven advance: the user did the thing (saved, launched) and the app
  // moved them; step forward automatically.
  //
  // Guard against `pathname === step.route`: a step whose advanceOnRoute is a
  // prefix of its OWN page would otherwise auto-complete the instant it opens,
  // before the user acts. Concretely, the "save the agent" step lives on
  // `/agents/new` and advances on `/agents/` (the detail page it lands on) — but
  // `/agents/new`.startsWith('/agents/') is true, so without this guard the step
  // fires immediately and skips the save. Only advance once the app has actually
  // moved the user OFF the step's page.
  useEffect(() => {
    if (
      step?.advanceOnRoute !== undefined &&
      pathname.startsWith(step.advanceOnRoute) &&
      pathname !== step.route
    ) {
      next()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, state.stepIndex])

  // Click-driven advance: the highlighted control must be clicked (e.g. to open
  // a tab) before the next step's target exists — there is no Next button for
  // these steps. Delegate from the document in the CAPTURE phase and match the
  // anchor by selector at click time rather than holding a node reference: the
  // real target (a React-managed tab button) is re-rendered/reconciled, so a
  // listener bound once to the node goes stale, and `closest()` also handles a
  // click that lands on a child (e.g. the tab's badge span).
  useEffect(() => {
    if (step?.advanceOnClick !== true) return
    const anchor = step.anchor
    const onDocClick = (e: MouseEvent): void => {
      const target = e.target
      if (target instanceof Element && target.closest(anchor) !== null) next()
    }
    document.addEventListener('click', onDocClick, true)
    return () => document.removeEventListener('click', onDocClick, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.stepIndex])

  // Keyboard: Esc = skip, ArrowRight/Left = next/back (when manual).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Impl-gate P1-1: never hijack keys aimed at an editable element. The
      // tour's own steps tell the user to TYPE (name / port fields) — an arrow
      // press there used to back()/next() mid-edit, after which the fill
      // effect overwrote what the user had typed; Escape killed the tour.
      const target = e.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      )
        return
      if (e.key === 'Escape') {
        // Impl-gate P2-1: an open modal owns Escape. Dialog closes itself via
        // its own window listener (sibling listeners still see the event), so
        // without this check one Esc on e.g. the quick-create dialog also
        // silently killed the whole tour. The bubble itself is role=dialog —
        // exclude it from the probe.
        if (
          document.querySelector('[role="dialog"]:not([data-testid="spotlight-tour-bubble"])') !==
          null
        )
          return
        stop()
      } else if (
        e.key === 'ArrowRight' &&
        step?.advanceOnRoute === undefined &&
        step?.advanceOnClick !== true
      )
        next()
      else if (e.key === 'ArrowLeft') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, back, stop, step?.advanceOnRoute, step?.advanceOnClick])

  useLayoutEffect(() => {
    bubbleRef.current?.focus()
  }, [state.stepIndex])

  if (step === undefined) return null

  const total = tour.steps.length
  const isLast = state.stepIndex === total - 1

  // Bubble placement: below the anchor if there's room, else above; centred when
  // the anchor is missing (off-page prompt). Both axes are clamped to the
  // viewport so an anchor near the right/bottom edge (e.g. the "add output port"
  // button) never pushes the bubble off screen.
  const PAD = 8
  const BUBBLE_W = Math.min(360, window.innerWidth - 2 * PAD)
  const BUBBLE_H = 200
  const clampLeft = (x: number): number =>
    Math.max(PAD, Math.min(x, window.innerWidth - BUBBLE_W - PAD))
  const clampTop = (y: number): number =>
    Math.max(PAD, Math.min(y, window.innerHeight - BUBBLE_H - PAD))
  const bubbleStyle: React.CSSProperties =
    rect === null
      ? { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
      : rect.top + rect.height + BUBBLE_H + PAD < window.innerHeight
        ? { top: clampTop(rect.top + rect.height + PAD), left: clampLeft(rect.left) }
        : { top: clampTop(rect.top - BUBBLE_H - PAD), left: clampLeft(rect.left) }

  const body = (
    <div className="spotlight-tour" data-testid="spotlight-tour">
      {/* The hole: a transparent box over the anchor with a huge spread shadow
          dims everything else, so the target stays fully interactive. */}
      {rect !== null && onRightPage && (
        <div
          className="spotlight-tour__hole"
          style={{
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8,
          }}
        />
      )}
      {(rect === null || !onRightPage) && <div className="spotlight-tour__scrim" />}

      <div
        className="spotlight-tour__bubble"
        style={bubbleStyle}
        role="dialog"
        aria-label={t('tour.ariaLabel')}
        tabIndex={-1}
        ref={bubbleRef}
        data-testid="spotlight-tour-bubble"
      >
        <div className="spotlight-tour__progress">
          {t('tour.progress', { current: state.stepIndex + 1, total })}
        </div>
        <h3 className="spotlight-tour__title">{t(step.titleKey)}</h3>
        <p className="spotlight-tour__body">{t(step.bodyKey)}</p>

        {!onRightPage && step.route !== undefined && (
          <button
            type="button"
            className="btn btn--primary btn--sm spotlight-tour__goto"
            data-testid="spotlight-tour-goto"
            onClick={() => void navigate({ to: step.route as never } as never)}
          >
            {t('tour.goToPage')}
          </button>
        )}

        <div className="spotlight-tour__actions">
          <button
            type="button"
            className="btn btn--xs"
            data-testid="spotlight-tour-skip"
            onClick={stop}
          >
            {t('tour.skip')}
          </button>
          <span className="spotlight-tour__spacer" />
          {state.stepIndex > 0 && (
            <button
              type="button"
              className="btn btn--sm"
              data-testid="spotlight-tour-back"
              onClick={back}
            >
              {t('tour.back')}
            </button>
          )}
          {/* A route-advance OR click-advance step has no Next — the user
              advances it by DOING the thing. Only manual/explanatory steps
              carry a Next button. Impl-gate P2-2 escape hatch: when the user
              is on the right page but the anchor has stayed missing (control
              gone — e.g. an action failed and the page moved on), the
              do-the-thing contract is unfulfillable, so offer Next rather
              than trapping them at Back/Skip. Delayed (anchorStale) so the
              normal render-in-progress window never flashes a Next. */}
          {((step.advanceOnRoute === undefined && step.advanceOnClick !== true) ||
            (onRightPage && rect === null && anchorStale)) && (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              data-testid="spotlight-tour-next"
              onClick={next}
            >
              {isLast ? t('tour.done') : t('tour.next')}
            </button>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(body, document.body)
}
