// RFC-395 II-b O3 — owners supply one bounded DELETE; platform owns cursor progression.
export interface RetentionSweepPhase {
  readonly name:
    | 'distill-events'
    | 'intent-turn-events'
    | 'mcp-runtime-test-events'
    | 'webhook-trigger-fires'
  readonly counter:
    | 'distillEvents'
    | 'intentTurnEvents'
    | 'mcpRuntimeTestEvents'
    | 'webhookTriggerFires'
  deleteBatch(cutoff: number | null, batchSize: number): Promise<number>
}
