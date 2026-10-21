// RFC-383: both providers drain legacy work through the same application decisions.
import type { Logger } from '@/util/log'
import type { RecoveryReport } from './missionRecovery'

/** Only read/refresh cross the module boundary; activation belongs to employee bootstrap. */
export interface DevelopmentWriterCutover {
  read(): Promise<{ readonly mode: string; readonly legacyAdmissionsEnabled: boolean }>
  refresh(): Promise<{ readonly mode: string; readonly legacyAdmissionsEnabled: boolean }>
}

export async function sweepWakesWhileDraining(input: {
  readonly writerCutover: DevelopmentWriterCutover
  readonly automation: { sweepWakes(): Promise<{ readonly reconciled: number }> }
  readonly log: Pick<Logger, 'warn'>
}): Promise<void> {
  let writer: Awaited<ReturnType<DevelopmentWriterCutover['refresh']>>
  try {
    writer = await input.writerCutover.refresh()
  } catch (err) {
    input.log.warn('development writer refresh failed', {
      err: err instanceof Error ? err.message : String(err),
    })
    return
  }
  if (writer.mode === 'os-active' && !writer.legacyAdmissionsEnabled) return
  try {
    await input.automation.sweepWakes()
  } catch (err) {
    input.log.warn('development wake sweep failed', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function recoverWhileDraining(input: {
  readonly writerCutover: DevelopmentWriterCutover
  readonly automation: {
    recover(): Promise<Pick<RecoveryReport, 'settledFences' | 'invalidatedEffects' | 'firedWakes'>>
  }
  readonly log: Pick<Logger, 'info'>
}): Promise<void> {
  const writer = await input.writerCutover.read()
  if (writer.mode !== 'legacy-draining' && !writer.legacyAdmissionsEnabled) return
  const recovered = await input.automation.recover()
  if (recovered.settledFences > 0 || recovered.invalidatedEffects > 0 || recovered.firedWakes > 0) {
    input.log.info('draining legacy development mission recovery on boot', { ...recovered })
  }
}
