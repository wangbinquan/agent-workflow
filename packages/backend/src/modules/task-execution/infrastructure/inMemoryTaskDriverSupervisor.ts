// RFC-303 — process-local adapter for TaskDriverSupervisor.
// Admission remains owned by task-execution application code so it can share
// the canonical per-task lifecycle coordinator with terminal fencing.
import type { TaskStopCause } from '@/modules/task-execution/domain/sourceTermination'
import type {
  TaskDriverStopResult,
  TaskDriverStopTicket,
} from '@/modules/task-execution/ports/taskDriverSupervisor'

type Entry = {
  controller: AbortController
  generation: number
  stopped: Promise<TaskDriverStopResult>
  resolveStopped: (result: TaskDriverStopResult) => void
}

export class InMemoryTaskDriverSupervisor {
  private readonly entries = new Map<string, Entry>()
  private readonly completed = new Map<string, Promise<TaskDriverStopResult>>()
  private nextGeneration = 1

  tryAttach(taskId: string, controller: AbortController): boolean {
    if (this.entries.has(taskId)) return false
    let resolveStopped: (result: TaskDriverStopResult) => void = () => {}
    const stopped = new Promise<TaskDriverStopResult>((resolve) => {
      resolveStopped = resolve
    })
    const generation = this.nextGeneration++
    this.entries.set(taskId, { controller, generation, stopped, resolveStopped })
    this.completed.delete(this.ticketKey({ taskId, generation }))
    return true
  }

  has(taskId: string): boolean {
    return this.entries.has(taskId)
  }

  controllerOf(taskId: string): AbortController | undefined {
    return this.entries.get(taskId)?.controller
  }

  requestStop(taskId: string, cause: TaskStopCause): TaskDriverStopTicket | 'no-active-owner' {
    const entry = this.entries.get(taskId)
    if (entry === undefined) return 'no-active-owner'
    entry.controller.abort(cause)
    return { taskId, generation: entry.generation }
  }

  awaitStopped(ticket: TaskDriverStopTicket): Promise<TaskDriverStopResult> {
    const entry = this.entries.get(ticket.taskId)
    if (entry?.generation === ticket.generation) return entry.stopped
    return this.completed.get(this.ticketKey(ticket)) ?? Promise.resolve({ kind: 'released' })
  }

  release(
    taskId: string,
    controller: AbortController,
    result: TaskDriverStopResult = { kind: 'released' },
  ): boolean {
    const entry = this.entries.get(taskId)
    if (entry === undefined || entry.controller !== controller) return false
    this.entries.delete(taskId)
    const key = this.ticketKey({ taskId, generation: entry.generation })
    this.completed.set(key, Promise.resolve(result))
    entry.resolveStopped(result)
    // A ticket only needs to bridge the requestStop→finally interval.  Keeping
    // one completed generation per task also makes a late waiter deterministic
    // without turning this process-local registry into an audit store.
    for (const completedKey of this.completed.keys()) {
      if (completedKey.startsWith(`${taskId}:`) && completedKey !== key) {
        this.completed.delete(completedKey)
      }
    }
    return true
  }

  deleteIfOwned(taskId: string, controller: AbortController): boolean {
    return this.release(taskId, controller)
  }

  abortAll(cause?: unknown): string[] {
    const ids = [...this.entries.keys()]
    for (const id of ids) this.entries.get(id)?.controller.abort(cause)
    return ids
  }

  clearForTesting(): void {
    for (const [taskId, entry] of this.entries) {
      this.release(taskId, entry.controller)
    }
    this.entries.clear()
    this.completed.clear()
  }

  private ticketKey(ticket: TaskDriverStopTicket): string {
    return `${ticket.taskId}:${ticket.generation}`
  }
}
