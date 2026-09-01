/** Runtime protocol identity shared by provider-neutral module contracts. */
export type RuntimeKind = 'opencode' | 'claude-code'

/** Durable marker emitted when a distillation runtime transcript cannot be captured. */
export const DISTILL_CAPTURE_FAILED_KIND = 'rfc043/distill-capture-failed'
