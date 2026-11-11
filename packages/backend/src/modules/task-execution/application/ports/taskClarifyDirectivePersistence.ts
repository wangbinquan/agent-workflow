import type { ClarifyDirective } from '@agent-workflow/shared'

/** Complete persisted directive facts needed by the collaboration archive section. */
export interface TaskClarifyDirectiveArchiveRow {
  readonly taskId: string
  readonly nodeId: string
  readonly shardKey: string
  readonly directive: ClarifyDirective
  readonly setBy: string | null
  readonly updatedAt: number
}

/**
 * RFC-482 — the directive read the engine takes at dispatch. Task Execution owns the directive table (RFC-395 A7), so the
 * engine reads it from its own persistence bundle rather than through collaboration's runtime mechanics.
 */
export interface TaskClarifyDirectiveReads {
  get(
    taskId: string,
    nodeId: string,
    shardKey?: string | null,
  ): Promise<ClarifyDirective | undefined>
}

/** 同一会话的澄清覆盖；set 保留原事务包装，setInTx 参加绑定的调用方事务。 */
export interface TaskClarifyDirectivePersistence extends TaskClarifyDirectiveReads {
  /** Complete archive rows in the bound caller transaction, without an added sort. */
  archiveRows(taskIds: readonly string[]): Promise<TaskClarifyDirectiveArchiveRow[]>
  getRow(
    taskId: string,
    nodeId: string,
    shardKey?: string | null,
  ): Promise<{ directive: ClarifyDirective; updatedAt: number } | undefined>
  list(taskId: string): Promise<Record<string, ClarifyDirective>>
  listWorkgroupStops(taskId: string): Promise<
    {
      nodeId: string
      shardKey: string
      directive: ClarifyDirective
    }[]
  >
  set(
    taskId: string,
    nodeId: string,
    directive: ClarifyDirective,
    setBy: string | null,
    shardKey?: string | null,
    now?: number,
  ): Promise<void>
  setInTx(
    taskId: string,
    nodeId: string,
    directive: ClarifyDirective,
    setBy: string | null,
    shardKey: string | null,
    now: number,
  ): Promise<void>
}
