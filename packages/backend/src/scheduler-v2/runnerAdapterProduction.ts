// RFC-061 PR-B T9 (final) — production RunnerAdapter.
//
// Bridges scheduler-v2 SpawnRequest API to runOpencodeAttempt (runner-v2)
// + writeEvents bridge. On spawn:
//   1. Resolve agent + skills via existing services
//   2. Run opencode via runOpencodeAttempt (event-driven, no node_runs)
//   3. Translate RunOpencodeAttemptResult → RFC-061 events
//   4. writeEvents the result (triggers actor wake via eventApplierWakeBridge)
//
// Cancel: look up attempt's pid from projection, SIGTERM, let the
// in-flight spawn promise produce the attempt-canceled event on exit.

import { eq } from 'drizzle-orm'

import type { DbClient } from '../db/client'
import { attempts } from '../db/schema'
import type { Agent, Mcp, Plugin } from '@agent-workflow/shared'
import { getAgent } from '../services/agent'
import { listMcps } from '../services/mcp'
import { listPlugins } from '../services/plugin'
import type { ResolvedSkill } from './runnerUtils'
import { writeEvents, type NewEvent } from '../services/writeEvents'

import type { RunnerAdapter, WakeProducer } from './runnerAdapter'
import type { SpawnRequest } from './taskActorTick'
import { runOpencodeAttempt, type RunOpencodeAttemptResult } from './runnerV2'
import { wakeForEvents } from './eventApplierWakeBridge'
import type { Event } from '@agent-workflow/shared'

export interface ProductionRunnerAdapterOptions {
  db: DbClient
  taskId: string
  worktreePath: string
  appHome: string
  wakeProducer: WakeProducer
  /**
   * Per-attempt skill resolver. Launcher passes a closure that resolves
   * skills for a given agent (typically a thin wrapper around the legacy
   * resolveSkills helper in services/scheduler — moved to a shared
   * location by T10 cutover so this stays grounded after the deletion).
   * Defaults to () => [] when omitted (used in tests).
   */
  resolveSkills?: (agent: Agent) => Promise<ResolvedSkill[]>
  /** Override the opencode CLI head (tests inject stubOpencode). */
  opencodeCmd?: readonly string[]
}

export class ProductionRunnerAdapter implements RunnerAdapter {
  constructor(public readonly opts: ProductionRunnerAdapterOptions) {}

  async spawn(req: SpawnRequest): Promise<void> {
    // Fire-and-forget: returns immediately; the actor's loop awaits the
    // attempt-exit wake reason this method enqueues on completion.
    void this.runAndPublish(req).catch((err) => {
      // Defensive: if the run itself blew up (not just envelope-fail),
      // emit an attempt-finished-crash event so the actor unblocks.
      void this.emitCrashEvent(req, err)
    })
  }

  async cancel(attemptId: string, reason: string): Promise<void> {
    const row = this.opts.db
      .select({ pid: attempts.pid })
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .limit(1)
      .all()[0]
    void reason
    if (row?.pid !== null && row?.pid !== undefined) {
      try {
        process.kill(row.pid, 'SIGTERM')
      } catch {
        // already dead
      }
    }
  }

  private async runAndPublish(req: SpawnRequest): Promise<void> {
    const agent = await getAgent(this.opts.db, req.agentName)
    if (agent === null) {
      await this.emitCrashEvent(req, new Error(`agent ${req.agentName} not found`))
      return
    }
    const skills = this.opts.resolveSkills ? await this.opts.resolveSkills(agent) : []
    const mcps: Mcp[] = await listMcps(this.opts.db)
    const plugins: Plugin[] = await listPlugins(this.opts.db)

    const result = await runOpencodeAttempt({
      appHome: this.opts.appHome,
      taskId: this.opts.taskId,
      attemptId: req.attemptId,
      scope: req.scope,
      worktreePath: this.opts.worktreePath,
      agent,
      mcps,
      plugins,
      skills,
      prompt: req.prompt,
      ...(this.opts.opencodeCmd !== undefined ? { opencodeCmd: this.opts.opencodeCmd } : {}),
    })

    const events = this.resultToEvents(req, result)
    if (events.length === 0) return
    const written = await writeEvents(this.opts.db, events)
    wakeForEvents(written)
  }

  private async emitCrashEvent(req: SpawnRequest, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err)
    const newEvents: NewEvent[] = [
      {
        taskId: this.opts.taskId,
        kind: 'attempt-finished-crash',
        nodeId: req.scope.nodeId,
        loopIter: req.scope.loopIter,
        shardKey: req.scope.shardKey,
        iter: req.scope.iter,
        attemptId: req.attemptId,
        actor: 'system',
        payload: { errorMessage: msg },
      },
    ]
    const written = await writeEvents(this.opts.db, newEvents)
    wakeForEvents(written)
  }

  private resultToEvents(req: SpawnRequest, result: RunOpencodeAttemptResult): NewEvent[] {
    const scopeFields = {
      nodeId: req.scope.nodeId,
      loopIter: req.scope.loopIter,
      shardKey: req.scope.shardKey,
      iter: req.scope.iter,
    }
    const events: NewEvent[] = []

    // attempt-subagent-* events (telemetry) — flushed first.
    for (const t of result.subagentToolUses) {
      events.push({
        taskId: this.opts.taskId,
        kind: 'attempt-subagent-tool-use',
        ...scopeFields,
        attemptId: req.attemptId,
        actor: `opencode:${t.sessionId}`,
        payload: { toolName: t.toolName, sessionId: t.sessionId, detail: t.detail },
      })
    }
    for (const s of result.subagentOutputs) {
      events.push({
        taskId: this.opts.taskId,
        kind: 'attempt-subagent-output',
        ...scopeFields,
        attemptId: req.attemptId,
        actor: `opencode:${s.sessionId}`,
        payload: { sessionId: s.sessionId, content: s.content },
      })
    }

    if (result.outcome === 'success') {
      // Captured port outputs.
      for (const [portName, content] of Object.entries(result.outputs)) {
        events.push({
          taskId: this.opts.taskId,
          kind: 'attempt-output-captured',
          ...scopeFields,
          attemptId: req.attemptId,
          actor: 'system',
          payload: { portName, content },
        })
      }
      events.push({
        taskId: this.opts.taskId,
        kind: 'attempt-finished-success',
        ...scopeFields,
        attemptId: req.attemptId,
        actor: 'system',
        payload: {},
      })
    } else if (result.outcome === 'envelope-fail') {
      events.push({
        taskId: this.opts.taskId,
        kind: 'attempt-finished-envelope-fail',
        ...scopeFields,
        attemptId: req.attemptId,
        actor: 'system',
        payload: { reason: result.errorMessage ?? 'unknown envelope failure' },
      })
    } else if (result.outcome === 'crash') {
      events.push({
        taskId: this.opts.taskId,
        kind: 'attempt-finished-crash',
        ...scopeFields,
        attemptId: req.attemptId,
        actor: 'system',
        payload: {
          ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
          ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
        },
      })
    } else if (result.outcome === 'timeout') {
      events.push({
        taskId: this.opts.taskId,
        kind: 'attempt-finished-timeout',
        ...scopeFields,
        attemptId: req.attemptId,
        actor: 'system',
        payload: { timeoutMs: 600_000 },
      })
    } else if (result.outcome === 'canceled') {
      events.push({
        taskId: this.opts.taskId,
        kind: 'attempt-canceled',
        ...scopeFields,
        attemptId: req.attemptId,
        actor: 'system',
        payload: {},
      })
    }
    return events
  }
}

export function createProductionRunnerAdapter(
  opts: ProductionRunnerAdapterOptions,
): ProductionRunnerAdapter {
  return new ProductionRunnerAdapter(opts)
}

// Re-export for tests that need it.
export type { Event }
