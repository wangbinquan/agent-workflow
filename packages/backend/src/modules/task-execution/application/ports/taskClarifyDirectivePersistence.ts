import type { ClarifyDirective } from '@agent-workflow/shared'

/** 同一会话的澄清覆盖；set 保留原事务包装，setInTx 参加绑定的调用方事务。 */
export interface TaskClarifyDirectivePersistence {
  get(
    taskId: string,
    nodeId: string,
    shardKey?: string | null,
  ): Promise<ClarifyDirective | undefined>
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
