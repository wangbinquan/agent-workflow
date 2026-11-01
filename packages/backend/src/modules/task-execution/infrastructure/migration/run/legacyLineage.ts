import { lookupKey, type LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import { nullableText } from './source'

/**
 * RFC-398 §11 (v0.18.18/v0.18.19 on PostgreSQL): those releases never filled
 * `node_runs.lineage_slot_path_json` — SQLite filled it with the 0210 trigger, and RFC-359 W6
 * (`application/buildNodeRunMintRecord.ts` `nodeRunLineageColumns`) only fixed new PostgreSQL
 * rows from v0.19.0. Their runtime read the NULL through `run ?? intent ?? task` and recorded that
 * path on every effect of the run's continuation slot. The current runtime lets a re-run inherit
 * the previous run's lineage and derives a node path only for an inherited NULL; that path opens a
 * second operation family whose generation 0 collides with the recorded effect on
 * `(task_id, operation_key, operation_generation)`, so the resumed task fails to prepare its
 * isolation. The conversion therefore records the path the old runtime actually used.
 */
export function legacyRunLineageSlotPath(
  recorded: string | null,
  effectSlotPaths: readonly string[] | undefined,
): string | null {
  if (recorded !== null) return recorded
  // Without a recorded effect there is no operation family to continue. One released runtime
  // records one path per slot, so disagreeing paths are not guessed between.
  return effectSlotPaths?.length === 1 ? effectSlotPaths[0]! : null
}

/** Continuation slot key -> distinct effect slot paths, for the task's NULL-lineage runs. */
export type LegacyEffectSlotPaths = Readonly<Record<string, readonly string[]>>

export const LEGACY_EFFECT_SLOT_PATHS = lookupKey<LegacyEffectSlotPaths>(
  'task-execution/run-legacy-effect-slot-paths',
  1,
)

export const legacyEffectSlotPaths: LookupBuilder<LegacyEffectSlotPaths> = {
  key: LEGACY_EFFECT_SLOT_PATHS,
  sources: ['node_runs', 'task_execution_effects'],
  dependsOn: [TASK_FACTS],
  build(staged, put, lookups) {
    for (const [taskId] of lookups(TASK_FACTS).entries()) {
      const slots = new Set<string>()
      for (const run of staged.group('node_runs', 'task_id', taskId)) {
        if (run.codecFailure || run.values.lineage_slot_path_json !== null) continue
        const slot = nullableText(run, 'continuation_slot_key')
        if (slot !== null) slots.add(slot)
      }
      if (!slots.size) continue
      const effects = staged
        .group('task_execution_effects', 'task_id', taskId)
        .filter((effect) => !effect.codecFailure)
      const paths: Record<string, string[]> = {}
      for (const slot of [...slots].sort()) {
        const found = new Set<string>()
        for (const effect of effects) {
          const operationKey = effect.values.operation_key
          const slotPath = effect.values.slot_path_json
          // Every effect key is `${continuationSlotKey}:${kind}:${ordinal}`.
          if (
            typeof operationKey === 'string' &&
            typeof slotPath === 'string' &&
            operationKey.startsWith(`${slot}:`)
          )
            found.add(slotPath)
        }
        if (found.size) paths[slot] = [...found].sort()
      }
      if (Object.keys(paths).length) put(taskId, paths)
    }
  },
}
