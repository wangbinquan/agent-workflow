import { encodeMigrationKey } from '@/platform/persistence/migration/conversion/migrationKey'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  RESOLUTION_CODES,
  type JsonValue,
  type RowDisposition,
  type TargetRef,
} from '@/platform/persistence/migration/conversion/types'
import type {
  FinalizeDisposition,
  MigrationTraceResult,
  MigrationUnit,
  MigrationUnitSource,
  TraceInput,
} from '@/platform/persistence/migration/run/types'
import { FINALIZE_REFERENCE_CODE } from '@/platform/persistence/migration/target/dangling'
import type {
  MigrationMetaReadPort,
  TraceReplayPort,
  TraceSourceProbePort,
} from '../ports/epochSwitch'

export function createMigrationTraceQuery(deps: {
  meta: MigrationMetaReadPort
  sourceProbe?: TraceSourceProbePort
  replay?: TraceReplayPort
}): (input: TraceInput) => Promise<MigrationTraceResult> {
  return async (input) => {
    const run = input.runId
      ? await deps.meta.migrationRun(input.runId)
      : (await deps.meta.runs(input.operationId)).at(-1)
    if (!run || run.operationId !== input.operationId) throw new Error('v3-trace-run-not-found')
    const sourcePhase = input.phase ?? 'current'
    const sourceKey = encodeMigrationKey(input.table, input.key)
    const source = { sourceTable: input.table, sourcePhase, sourceKey }
    const dispositions: RowDisposition[] = []
    for await (const row of deps.meta.dispositions({ runId: run.runId, source }))
      dispositions.push(row)
    const ranges = await deps.meta.unitSources({
      runId: run.runId,
      sourceTable: input.table,
      sourcePhase,
    })
    const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
    const includes = (range: MigrationUnitSource) =>
      range.firstKey !== null &&
      range.lastKey !== null &&
      compare(sourceKey, range.firstKey) >= 0 &&
      compare(sourceKey, range.lastKey) <= 0
    const units: MigrationUnit[] = []
    for await (const unit of deps.meta.units(run.runId)) units.push(unit)
    let matched: MigrationUnitSource | undefined
    let proof: MigrationTraceResult['proof'] = 'not-found'
    if (dispositions.length) {
      proof = 'row-disposition'
      for (const range of ranges) {
        for await (const row of deps.meta.dispositions({
          runId: run.runId,
          unitId: range.unitId,
          source,
        })) {
          if (valueDigest(row) === valueDigest(dispositions[0])) {
            matched = range
            break
          }
        }
        if (matched) break
      }
    } else {
      const chunks = ranges.filter((range) => range.unit.kind !== 'group' && includes(range))
      if (chunks.length === 1) {
        matched = chunks[0]
        proof = 'unit-range'
      }
      if (!matched && deps.sourceProbe) {
        const groups: MigrationUnitSource[] = []
        for (const range of ranges) {
          if (range.unit.kind !== 'group') continue
          const keys = await deps.sourceProbe.groupKeys({ ...source, run, unit: range.unit })
          if (
            keys.some(
              (key) =>
                range.unit.kind === 'group' &&
                range.unit.firstGroup !== null &&
                range.unit.lastGroup !== null &&
                compare(key, range.unit.firstGroup) >= 0 &&
                compare(key, range.unit.lastGroup) <= 0,
            )
          )
            groups.push(range)
        }
        if (groups.length === 1) {
          matched = groups[0]
          proof = 'group-unit'
        }
      }
    }
    const unit = units.find((unit) => unit.unitId === matched?.unitId)
    // RFC-626: two kinds of decision records explain a row beyond its unit receipt — what
    // ending its task rewrote on it, and what finalizing the target did to the rows it became.
    const finalized: FinalizeDisposition[] = []
    let settlement: MigrationTraceResult['settlement']
    for await (const record of deps.meta.records(run.runId)) {
      if (record.kind !== 'decision') continue
      const payload =
        record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
          ? (record.payload as { readonly [key: string]: JsonValue })
          : null
      if (!payload) continue
      if (record.code === FINALIZE_REFERENCE_CODE) {
        const entry = payload as unknown as FinalizeDisposition
        finalized.push({
          targetTable: entry.targetTable,
          targetKey: entry.targetKey,
          foreignKey: entry.foreignKey,
          references: entry.references,
          action: entry.action,
          archive: entry.archive,
        })
      } else if (
        record.code === RESOLUTION_CODES.taskSettled &&
        payload.sourceTable === input.table &&
        payload.sourceKey === sourceKey &&
        payload.sourcePhase === sourcePhase
      )
        settlement = {
          taskId: String(payload.taskId),
          cause: String(payload.cause),
          columns: payload.columns ?? null,
        }
    }
    const finalizedFor = (target: TargetRef) =>
      finalized.filter(
        (entry) => entry.targetTable === target.table && entry.targetKey === target.key,
      )
    const explained = (result: MigrationTraceResult): MigrationTraceResult =>
      !finalized.length && !settlement
        ? result
        : {
            ...result,
            targets: result.targets.map((target) => {
              const applied = finalizedFor(target)
              return applied.length ? { ...target, finalized: applied } : target
            }),
            ...(settlement ? { settlement } : {}),
          }
    const blockRecords = await deps.meta.blocks({ runId: run.runId })
    const exactLoadBlock = blockRecords.some(
      ({ origin, unitId, block }) =>
        origin === 'load' &&
        unitId === matched?.unitId &&
        block.sourceTable === input.table &&
        block.sourceKey === sourceKey &&
        (block.sourcePhase ?? 'current') === sourcePhase,
    )
    let recorded = false
    if (!dispositions.length && unit?.outcome === 'committed')
      for await (const record of deps.meta.records(run.runId)) {
        const evidence =
          record.kind === 'source-journal'
            ? record.entries
            : record.kind === 'source-generation'
              ? record.evidence
              : record.kind === 'source-metadata' || record.kind === 'family-cutover-source'
                ? record.payload
                : null
        if (
          evidence &&
          typeof evidence === 'object' &&
          'sourceTable' in evidence &&
          'sourceKey' in evidence &&
          evidence.sourceTable === input.table &&
          evidence.sourceKey === sourceKey &&
          ('sourcePhase' in evidence ? evidence.sourcePhase : 'current') === sourcePhase
        )
          recorded = true
      }
    const targetRefs: TargetRef[] = dispositions.flatMap((row) => [...row.targets])
    if (!dispositions.length && unit?.outcome === 'committed')
      for (const table of unit.receipt.targets)
        targetRefs.push({ table: table.table, key: encodeMigrationKey(table.table, input.key) })
    const targets: MigrationTraceResult['targets'][number][] = []
    for (const target of targetRefs) {
      if (targets.some((entry) => entry.table === target.table && entry.key === target.key))
        continue
      const present = await deps.meta.probeTarget(target)
      // A row finalize moved to the archive is no longer there, and is still this row's target.
      if (dispositions.length || present || finalizedFor(target).length)
        targets.push({ ...target, probed: true, present })
    }
    // RFC-626 §3.3: guessing targets from the source key finds only the rows that keep it. A
    // row of a rule that derives other keys (a run and its input rows) may have lost one of
    // those to finalize while the row itself is still there, so when the run has finalize
    // dispositions only rows kept as they are take the short way; the rest are replayed for
    // their complete set of targets.
    // Rows of this unit that carry a disposition of their own (set aside, blocked) are not on
    // this path. Of the rest, only a unit without converted rows holds nothing but rows kept
    // as they are.
    const keptAsIs = matched !== undefined && matched.counts.converted === 0
    if (
      finalized.length &&
      !dispositions.length &&
      matched &&
      unit?.outcome === 'committed' &&
      !keptAsIs
    ) {
      if (!deps.replay) throw new Error('v3-trace-replay-required')
      return explained(await deps.replay.replay({ ...input, run }))
    }
    // Membership needs exact evidence; an interval also contains keys absent from the source.
    if (
      !dispositions.length &&
      !targets.length &&
      !(recorded && unit?.receipt.targets.length === 0) &&
      !exactLoadBlock &&
      !(
        proof === 'group-unit' &&
        (unit?.outcome === 'load-blocked' || unit?.receipt.targets.length === 0)
      )
    ) {
      if (matched) {
        if (!deps.replay) throw new Error('v3-trace-replay-required')
        const replayed = await deps.replay.replay({ ...input, run })
        if (replayed.proof === 'not-found' || unit?.outcome !== 'load-blocked')
          return explained(replayed)
        return explained({
          ...replayed,
          class: 'blocked',
          targets: [],
          blocks: blockRecords
            .filter(({ unitId }) => unitId === matched!.unitId)
            .map(({ block }) => block),
        })
      }
      proof = 'not-found'
    }
    if (proof === 'not-found' && input.replay && deps.replay)
      return explained(await deps.replay.replay({ ...input, run }))
    const artifacts = []
    if (matched)
      for await (const artifact of deps.meta.artifacts({
        runId: run.runId,
        sourceTable: input.table,
        sourceKey,
        unitId: matched.unitId,
      }))
        artifacts.push(artifact)
    const restrictions = (await deps.meta.restrictions({ runId: run.runId }))
      .filter(
        (row) =>
          row.sourceTable === input.table &&
          row.sourceKey === sourceKey &&
          row.sourcePhase === sourcePhase,
      )
      .map((row) => row.history)
    const blocks = blockRecords
      .filter(
        ({ unitId, block }) =>
          (!unitId || unitId === matched?.unitId) &&
          (!block.sourceTable || block.sourceTable === input.table) &&
          (!block.sourceKey || block.sourceKey === sourceKey) &&
          (!block.sourcePhase || block.sourcePhase === sourcePhase),
      )
      .map((row) => row.block)
    const classes = matched
      ? (Object.entries(matched.counts)
          .filter(([, count]) => count > 0)
          .map(([kind]) => kind) as NonNullable<MigrationTraceResult['class']>[])
      : []
    const classification =
      dispositions.find((row) => row.class === 'blocked')?.class ??
      dispositions[0]?.class ??
      (unit?.outcome === 'load-blocked' && matched
        ? 'blocked'
        : proof !== 'not-found' && classes.length === 1
          ? classes[0]!
          : null)
    return explained({
      runId: run.runId,
      ...source,
      proof,
      class: classification,
      dispositions,
      unit: matched
        ? {
            unitId: matched.unitId,
            rule: matched.rule,
            receiptDigest: matched.receiptDigest,
            range:
              matched.firstKey && matched.lastKey
                ? { firstKey: matched.firstKey, lastKey: matched.lastKey }
                : null,
            groups:
              matched.unit.kind === 'group'
                ? { first: matched.unit.firstGroup, last: matched.unit.lastGroup }
                : null,
          }
        : null,
      targets,
      artifacts,
      restrictions,
      blocks,
      archive: dispositions.find((row) => row.archive)?.archive ?? null,
    })
  }
}
