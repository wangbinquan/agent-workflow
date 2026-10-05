import type { NativeUsageCapture } from '@/modules/runtime-management/public/participants'
import type { ObservationInvocationParticipant } from '@/modules/run-observability/public/participants'

/** Read, project and repair to actual EOF. Packet sizes never bound task population. */
export async function finalizeNativeUsageInvocation(input: {
  readonly capture: NativeUsageCapture
  readonly observations: ObservationInvocationParticipant
  readonly invocationId: string
  readonly nodeRunId: string
  readonly rootSessionId: string | null
}): Promise<void> {
  if (!input.capture.finishDurable) return
  let failed: unknown
  try {
    await input.capture.finishDurable(input.rootSessionId)
  } catch (error) {
    failed = error
  }
  const project = async () => {
    if (!input.observations.reconcile)
      throw new Error('Original native numeric projection is unavailable')
    while ((await input.observations.reconcile(input.nodeRunId)) !== 0) {
      /* actual source EOF */
    }
  }
  // Already committed partial pages must remain visible even if the later read failed.
  await project()
  if (failed !== undefined) throw failed
  if (!input.observations.reconcileNativeHistory)
    throw new Error('Original native history writer is unavailable')
  for (;;) {
    const progress = await input.observations.reconcileNativeHistory(input.invocationId)
    if (!progress) throw new Error('Original native completion has not projected')
    if (progress.state !== 'walking') break
  }
  await input.capture.sealDurable?.()
  await project()
}
