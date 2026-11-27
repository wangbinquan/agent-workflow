// RFC-616 §4.1 — from ledger rows to executions with a cause.
//
// The exhaustive rerun-cause table lives in shared (`processCause.ts`). This
// file adds the rules a table cannot express:
//
//  1. A manual retry leaves a placeholder row (`retry-node`, status failed,
//     never started) and the real re-execution follows as `revival`. The
//     placeholder is not an execution — counting it would invent a failure —
//     but each one is exactly one manual retry. The one exception is
//     repository preparation, whose `retry-node` row *is* the re-execution.
//  2. A rerun can act on a wrapper as a whole: a review sends back the output a
//     loop exposes, a person retries a fan-out. The reason is then written on
//     the wrapper's own row, and the rows inside the new invocation are minted
//     as first executions again (they have no earlier row in it). Rows inside
//     an invocation therefore take the invocation's cause: the reason it was
//     re-invoked when one is recorded, "another run nobody asked for by name"
//     (cascade) when the invocation is simply not the first of its frame, and
//     whatever the enclosing invocation says for a first invocation nested in
//     a re-invoked one.
//  3. A placeholder on a wrapper's slot is one manual retry too, and is not an
//     invocation of the wrapper.
//  4. A row without a recorded cause counts as a first execution and is tallied
//     so the page can say how many there were.

import { MANUAL_RETRY_RERUN_CAUSE, processCauseOf, type ProcessCause } from '@agent-workflow/shared'
import type { ProcessExecution, ProcessFailureCode } from './model'

const REPO_PREP_STAGE = 'system:repo-prep'

export interface WrapperFrameRow {
  readonly runId: string
  readonly nodeId: string
  /** The invocation's own enclosing frame. */
  readonly containerRunId: string | null
  readonly iteration: number
  readonly seq: number
  /** The cause the wrapper's own row was minted with. */
  readonly rerunCause: string | null
}

export interface WrapperJudgement {
  /** Real invocations, each with the cause a first-time row inside it takes. */
  readonly innerCause: ReadonlyMap<string, ProcessCause>
  /** Manual retries aimed at a wrapper: one per `retry-node` placeholder on its slot. */
  readonly manualRetries: number
}

export const NO_WRAPPERS: WrapperJudgement = { innerCause: new Map(), manualRetries: 0 }

/** Judge the wrapper rows of one unit: which are invocations, and what a run inside each one is. */
export function judgeWrapperInvocations(wrappers: readonly WrapperFrameRow[]): WrapperJudgement {
  let manualRetries = 0
  const own = new Map<string, ProcessCause>()
  const invocations: WrapperFrameRow[] = []
  for (const wrapper of wrappers) {
    const cause = processCauseOf(wrapper.rerunCause)
    if (cause === null) {
      // A placeholder (or a park row) on the wrapper's slot: nothing ran.
      if (wrapper.rerunCause === MANUAL_RETRY_RERUN_CAUSE) manualRetries++
      continue
    }
    own.set(wrapper.runId, cause)
    invocations.push(wrapper)
  }
  const firstOfFrame = new Map<string, WrapperFrameRow>()
  for (const wrapper of invocations) {
    const frame = `${wrapper.nodeId}\u0000${wrapper.containerRunId ?? ''}\u0000${wrapper.iteration}`
    const first = firstOfFrame.get(frame)
    if (first === undefined || wrapper.seq < first.seq) firstOfFrame.set(frame, wrapper)
  }
  const firsts = new Set([...firstOfFrame.values()].map((wrapper) => wrapper.runId))
  const byId = new Map(invocations.map((wrapper) => [wrapper.runId, wrapper]))
  const innerCause = new Map<string, ProcessCause>()
  const resolve = (runId: string): ProcessCause => {
    const known = innerCause.get(runId)
    if (known !== undefined) return known
    const wrapper = byId.get(runId)
    if (wrapper === undefined) return 'first'
    // Guard against a malformed self-referencing chain: settle the entry while visiting.
    innerCause.set(runId, 'first')
    const stated = own.get(runId)!
    const cause: ProcessCause =
      stated !== 'first'
        ? stated
        : !firsts.has(runId)
          ? 'cascade'
          : wrapper.containerRunId === null
            ? 'first'
            : resolve(wrapper.containerRunId)
    innerCause.set(runId, cause)
    return cause
  }
  for (const wrapper of invocations) resolve(wrapper.runId)
  return { innerCause, manualRetries }
}

export interface CauseJudgement {
  /** null: the row is not an execution. */
  readonly cause: ProcessCause | null
  /** The row is one manual retry. */
  readonly manualRetry: boolean
  /** The row carried no cause. */
  readonly withoutCause: boolean
}

/** Classify one ledger row (or one group of identical rows). */
export function judgeCause(
  row: {
    readonly rerunCause: string | null
    readonly stageKey: string
    readonly containerRunId: string | null
  },
  wrappers: WrapperJudgement,
): CauseJudgement {
  const withoutCause = row.rerunCause === null || row.rerunCause === ''
  const manualRetry = row.rerunCause === MANUAL_RETRY_RERUN_CAUSE
  if (manualRetry && row.stageKey === REPO_PREP_STAGE) {
    return { cause: 'recovery', manualRetry: true, withoutCause: false }
  }
  const cause = processCauseOf(row.rerunCause)
  // Only first executions are re-judged: a row that states its own reason keeps it.
  if (cause === 'first' && row.containerRunId !== null) {
    return {
      cause: wrappers.innerCause.get(row.containerRunId) ?? 'first',
      manualRetry,
      withoutCause,
    }
  }
  return { cause, manualRetry, withoutCause }
}

export interface ExecutionInput {
  readonly stageKey: string
  readonly rerunCause: string | null
  readonly containerRunId: string | null
  readonly round: number | null
  readonly runs: number
  readonly endedRuns: number
  readonly failedRuns: number
  readonly interruptedRuns: number
  readonly activeMs: number
}

export interface ClassifiedExecutions {
  readonly executions: ProcessExecution[]
  /** Placeholders of manual retries, on node slots and on wrapper slots. */
  readonly manualRetries: number
  readonly runsWithoutCause: number
}

/** Classify rows and merge them by (stage, cause, round). */
export function classifyExecutions(
  rows: readonly ExecutionInput[],
  wrappers: WrapperJudgement,
): ClassifiedExecutions {
  const merged = new Map<string, ProcessExecution>()
  let manualRetries = wrappers.manualRetries
  let runsWithoutCause = 0
  for (const row of rows) {
    const judgement = judgeCause(row, wrappers)
    if (judgement.manualRetry) manualRetries += row.runs
    if (judgement.cause === null) continue
    if (judgement.withoutCause) runsWithoutCause += row.runs
    const key = `${row.stageKey}\u0000${judgement.cause}\u0000${row.round ?? ''}`
    const previous = merged.get(key)
    merged.set(key, {
      stageKey: row.stageKey,
      cause: judgement.cause,
      round: row.round,
      runs: (previous?.runs ?? 0) + row.runs,
      endedRuns: (previous?.endedRuns ?? 0) + row.endedRuns,
      failedRuns: (previous?.failedRuns ?? 0) + row.failedRuns,
      interruptedRuns: (previous?.interruptedRuns ?? 0) + row.interruptedRuns,
      activeMs: (previous?.activeMs ?? 0) + row.activeMs,
    })
  }
  return { executions: [...merged.values()], manualRetries, runsWithoutCause }
}

/** One node run as an execution input. */
export function executionInputOfRun(run: {
  readonly stageKey: string
  readonly rerunCause: string | null
  readonly containerRunId: string | null
  readonly round: number | null
  readonly status: string
  readonly startedAt: number | null
  readonly finishedAt: number | null
}): ExecutionInput {
  const ended = run.startedAt !== null && run.finishedAt !== null
  return {
    stageKey: run.stageKey,
    rerunCause: run.rerunCause,
    containerRunId: run.containerRunId,
    round: run.round,
    runs: 1,
    endedRuns: ended ? 1 : 0,
    failedRuns: run.status === 'failed' ? 1 : 0,
    interruptedRuns: run.status === 'interrupted' ? 1 : 0,
    activeMs: ended ? Math.max(0, run.finishedAt! - run.startedAt!) : 0,
  }
}

/** Failure codes of real executions, merged by (stage, code); placeholder rows carry none. */
export function classifyFailureCodes(
  rows: readonly {
    readonly stageKey: string
    readonly rerunCause: string | null
    readonly code: string
    readonly runs: number
  }[],
): ProcessFailureCode[] {
  const merged = new Map<string, ProcessFailureCode>()
  for (const row of rows) {
    const judgement = judgeCause({ ...row, containerRunId: null }, NO_WRAPPERS)
    if (judgement.cause === null) continue
    const key = `${row.stageKey}\u0000${row.code}`
    const previous = merged.get(key)
    merged.set(key, {
      stageKey: row.stageKey,
      code: row.code,
      runs: (previous?.runs ?? 0) + row.runs,
    })
  }
  return [...merged.values()]
}
