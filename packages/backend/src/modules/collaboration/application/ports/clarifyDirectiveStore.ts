import type { ClarifyDirective } from '@agent-workflow/shared'

export interface ClarifyDirectiveRow {
  readonly directive: ClarifyDirective
  readonly updatedAt: number
}

export interface ClarifyNodeDirective {
  readonly nodeId: string
  readonly directive: ClarifyDirective
}

/** Provider-neutral persistence for the per-task/node clarify override. */
export interface ClarifyDirectiveStore {
  get(input: {
    readonly taskId: string
    readonly nodeId: string
    readonly shardKey?: string | null
  }): Promise<ClarifyDirectiveRow | null>
  listNodeDirectives(taskId: string): Promise<readonly ClarifyNodeDirective[]>
  set(input: {
    readonly taskId: string
    readonly nodeId: string
    readonly directive: ClarifyDirective
    readonly setBy: string | null
    readonly shardKey?: string | null
    readonly now?: number
  }): Promise<void>
}
