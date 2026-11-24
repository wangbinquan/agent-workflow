// RFC-559 (RFC-294 S9 step 14): Task Execution's own port for asking memory to distill a settled agent run. The assembly
// root hands memory's distill commands, which satisfy it structurally; Task Execution no longer takes memory's public.
export interface TaskMemoryDistillPort {
  enqueue(input: {
    readonly sourceKind: 'agent-run'
    readonly sourceEventId: string
    readonly taskId: string
    readonly nodeId: string
  }): Promise<unknown>
}
