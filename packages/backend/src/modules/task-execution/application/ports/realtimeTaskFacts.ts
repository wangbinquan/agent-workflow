export interface RealtimeTaskFacts {
  taskAudience(
    taskId: string,
    userId: string,
  ): Promise<{
    readonly ownerUserId: string | null
    readonly member: boolean
  } | null>
  taskEventsSince(
    taskId: string,
    afterEventId: number,
  ): Promise<
    readonly {
      readonly id: number
      readonly nodeRunId: string
      readonly ts: number
      readonly kind:
        | 'tool_use'
        | 'text'
        | 'reasoning'
        | 'permission_asked'
        | 'error'
        | 'step_start'
        | 'step_finish'
        | 'stderr'
        | 'subagent_capture_failed'
      readonly payload: string
    }[]
  >
}
