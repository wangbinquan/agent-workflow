// RFC-191 (T1) — shared coarse clock for <RelativeTime>.
//
// One module-level interval fans out to every subscriber, so static list
// pages (/workflows, /workgroups, /repos have neither a refetch interval nor
// a WS subscription) still advance their relative-time labels while open.
// 30 s granularity is enough for minute-level copy; the interval stops when
// the last subscriber unmounts.

import { useSyncExternalStore } from 'react'

const TICK_MS = 30_000

let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
const subscribers = new Set<() => void>()

function subscribe(onChange: () => void): () => void {
  if (subscribers.size === 0) {
    // First subscriber (re)starts the clock from a fresh reading so a page
    // mounted long after the previous one unmounted never sees a stale tick.
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const fn of subscribers) fn()
    }, TICK_MS)
  }
  subscribers.add(onChange)
  return () => {
    subscribers.delete(onChange)
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

function getSnapshot(): number {
  return now
}

/** Current time, updated at most every 30 s (shared across all mounts). */
export function useNowTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
