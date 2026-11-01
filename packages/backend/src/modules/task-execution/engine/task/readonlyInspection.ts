// RFC-412 — the read-only member inspection at the task's terminal settlement (RFC-248 D11), moved from
// services/scheduler.ts: a read-only member is never committed or pushed, but a modification is recorded and warned.
import type { Logger } from '../../application/ports/executionKernel'
import type { ReadonlyInspectionPorts } from '../../application/ports/readonlyInspection'

export async function inspectReadonlyRepos(
  ports: ReadonlyInspectionPorts,
  log: Logger,
): Promise<void> {
  for (const repo of ports.repos) {
    if (!repo.readonly) continue
    const status = await ports.statusPorcelain(repo)
    const changed = status.stdout.trim() === '' ? [] : status.stdout.trim().split('\n')
    await ports.recordReadonlyDirty({
      taskId: ports.taskId,
      repoIndex: repo.ordinal,
      changedCount: changed.length,
      ...(ports.execution === undefined ? {} : { execution: ports.execution }),
      now: Date.now(),
    })
    if (changed.length > 0) {
      log.warn('[rfc248/readonly-dirty] read-only repo was modified; NOT committed or pushed', {
        taskId: ports.taskId,
        mountPath: repo.mountPath === '' ? '<root>' : repo.mountPath,
        changedCount: changed.length,
        changedSample: changed.slice(0, 20),
      })
    }
  }
}
