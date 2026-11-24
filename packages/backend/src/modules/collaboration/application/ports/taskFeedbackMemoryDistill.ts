// RFC-559 (RFC-294 S9 step 14): Collaboration's own port for asking memory to distill a task feedback or an answered
// self clarify round. The assembly root
// hands memory's distill commands, which satisfy it structurally; Collaboration no longer takes memory's public.
export interface CollaborationMemoryDistillPort {
  /** `null` means memory declined the event (its admission gate); the feedback is then simply not distilled. */
  enqueue(input: {
    readonly sourceKind: 'feedback' | 'clarify'
    readonly sourceEventId: string
    readonly taskId: string | null
  }): Promise<{ readonly jobId: string } | null>
}
