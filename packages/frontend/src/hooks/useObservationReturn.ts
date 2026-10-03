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
  options?: { readonly retainNested: boolean; readonly resetScope: string },
) {
  const position = useRef<ReturnPosition | null>(null)
  const nested = useRef(new Map<string, ReturnPosition>())
  const resetScope = options?.resetScope,
    retainNested = options?.retainNested ?? false
  const previousReset = useRef(resetScope)
  useEffect(() => {
    if (previousReset.current !== resetScope) {
      nested.current.clear()
      previousReset.current = resetScope
    }
    const saved = retainNested ? nested.current.get(scope) : position.current
    if (!saved) return
    if (saved.scope !== scope) {
      if (!retainNested) position.current = null
      return
    }
    if (task || !ready) return
    let firstFrame = 0,
      secondFrame = 0
    // Let the shared Dialog finish its initial focus/scroll-lock effects first.
    const restore = () => {
      if ((retainNested ? nested.current.get(scope) : position.current) !== saved) return
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
      // Portal/table mounting can finish after the parent query becomes ready.
      // Keep the saved position until the actual source row has returned.
      if (!target?.isConnected) return
      if (retainNested) nested.current.delete(scope)
      else position.current = null
      observer.disconnect()
      target.focus({ preventScroll: true })
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
    }
    const schedule = () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(restore)
      })
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    schedule()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [scope, task, ready, pageRef, retainNested, resetScope])

  return (taskId: string, trigger?: HTMLElement) => {
    const main = pageRef.current?.closest<HTMLElement>('main')
    const contributions = trigger?.closest<HTMLElement>(
      '[data-observation-contributions], [data-observation-runtime-contributions]',
    )
    const body = contributions?.closest<HTMLElement>('.dialog__body')
    const saved: ReturnPosition = {
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
    if (retainNested) nested.current.set(scope, saved)
    else position.current = saved
  }
}
