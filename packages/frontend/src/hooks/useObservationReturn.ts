import { useEffect, useRef, type RefObject } from 'react'

interface ReturnPosition {
  readonly scope: string
  readonly taskId: string
  readonly mainTop: number
  readonly mainLeft: number
  readonly windowX: number
  readonly windowY: number
  readonly dialogTop: number | null
  readonly dialogLeft: number | null
  readonly dialogContainer: string | null
}

/** A task route temporarily unmounts its source table and contribution Dialog. */
export function useObservationReturn(
  scope: string,
  task: string | undefined,
  pageRef: RefObject<HTMLDivElement | null>,
  ready: boolean,
) {
  const position = useRef<ReturnPosition | null>(null)
  useEffect(() => {
    const saved = position.current
    if (!saved) return
    if (saved.scope !== scope) {
      position.current = null
      return
    }
    if (task || !ready) return
    let secondFrame = 0
    // Let the shared Dialog finish its initial focus/scroll-lock effects first.
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (position.current !== saved) return
        position.current = null
        const main = pageRef.current?.closest<HTMLElement>('main')
        const body =
          saved.dialogTop === null
            ? null
            : (saved.dialogContainer === null
                ? document.querySelector('[data-observation-runtime-contributions]')
                : Array.from(
                    document.querySelectorAll<HTMLElement>('[data-observation-contributions]'),
                  ).find((node) => node.dataset.observationContributions === saved.dialogContainer)
              )?.closest<HTMLElement>('.dialog__body')
        const container = saved.dialogTop === null ? pageRef.current : body
        const target = Array.from(
          container?.querySelectorAll<HTMLElement>('[data-observation-task]') ?? [],
        ).find((button) => button.dataset.observationTask === saved.taskId)
        const fallback = body?.closest<HTMLElement>('[role="dialog"]') ?? main
        ;(target ?? fallback)?.focus({ preventScroll: true })
        if (main) {
          main.scrollTop = saved.mainTop
          main.scrollLeft = saved.mainLeft
        }
        if (window.scrollX !== saved.windowX || window.scrollY !== saved.windowY) {
          window.scrollTo(saved.windowX, saved.windowY)
        }
        if (body) {
          body.scrollTop = saved.dialogTop ?? 0
          body.scrollLeft = saved.dialogLeft ?? 0
        }
      })
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [scope, task, ready, pageRef])

  return (taskId: string, trigger?: HTMLElement) => {
    const main = pageRef.current?.closest<HTMLElement>('main')
    const contributions = trigger?.closest<HTMLElement>(
      '[data-observation-contributions], [data-observation-runtime-contributions]',
    )
    const body = contributions?.closest<HTMLElement>('.dialog__body')
    position.current = {
      scope,
      taskId,
      mainTop: main?.scrollTop ?? 0,
      mainLeft: main?.scrollLeft ?? 0,
      windowX: window.scrollX,
      windowY: window.scrollY,
      dialogTop: body?.scrollTop ?? null,
      dialogLeft: body?.scrollLeft ?? null,
      dialogContainer: contributions?.dataset.observationContributions ?? null,
    }
  }
}
