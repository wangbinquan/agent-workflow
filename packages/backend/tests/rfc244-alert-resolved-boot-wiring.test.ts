// RFC-244 — daemon assembly lock for lifecycle-alert resolution dirty truth.
//
// Service-level tests prove that reconciliation emits one onResolved callback
// per affected task. Route tests prove the additive WS frame shape. This file
// guards the remaining production seam: every background reconciler started by
// cli/start.ts must receive the same broadcaster callback.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const START_SOURCE = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf8')
const WORKER_SOURCE = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'platform', 'background', 'maintenanceJobRunner.ts'),
  'utf8',
)
const MAINTENANCE_SOURCE = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'platform', 'background', 'maintenanceService.ts'),
  'utf8',
)
const TASK_PROVIDER_RUNTIME_SOURCE = readFileSync(
  resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'providerRuntime.ts',
  ),
  'utf8',
)
const TASK_PROVIDER_BACKGROUND_SOURCE = readFileSync(
  resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'providerBackground.ts',
  ),
  'utf8',
)

function assemblySlice(startMarker: string, endMarker: string): string {
  const start = START_SOURCE.indexOf(startMarker)
  const end = START_SOURCE.indexOf(endMarker, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return START_SOURCE.slice(start, end)
}

describe('RFC-244 lifecycle alert resolution boot wiring', () => {
  test('defines one tasks-list resolved broadcaster with the strict additive frame', () => {
    const helper = assemblySlice('const broadcastResolved =', 'const gateContinuationDeps =')
    expect(helper).toContain('tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL')
    expect(helper).toContain("type: 'lifecycle.alert.resolved'")
    expect(helper).toContain('taskId,')
  })

  test('threads the same callback through Worker deltas and the direct auto-repair loop', () => {
    expect(
      WORKER_SOURCE.match(/onResolved: \(?taskId\)? => resolvedTaskIds\.push\(taskId\)/g),
    ).toHaveLength(2)
    expect(
      WORKER_SOURCE.match(/delta: \{ kind: 'lifecycle-alerts', alerts, resolvedTaskIds \}/g),
    ).toHaveLength(2)
    expect(MAINTENANCE_SOURCE).toContain(
      "if (delta.kind === 'lifecycle-alerts') options.onLifecycleDelta?.(delta)",
    )
    const workerConsumer = assemblySlice('onLifecycleDelta: (delta) => {', 'onIntentQueued:')
    expect(workerConsumer).toContain('for (const taskId of delta.resolvedTaskIds)')
    expect(workerConsumer).toContain('broadcastResolved(taskId)')
    // RFC-349 moved the timer into the selected-provider TaskExecution
    // background participant. Bootstrap still injects the one broadcaster;
    // both SQLite and PostgreSQL runtime factories bind it to the real repair
    // command, and the background loop invokes that command.
    expect(START_SOURCE).toContain('onResolved: broadcastResolved')
    expect(
      TASK_PROVIDER_RUNTIME_SOURCE.match(
        /const lifecycleRepair = create(?:Sqlite|Postgresql)TaskLifecycleAutoRepairCommand/g,
      ),
    ).toHaveLength(2)
    expect(TASK_PROVIDER_BACKGROUND_SOURCE).toContain('await runtime.lifecycleRepair.run({')
  })
})
