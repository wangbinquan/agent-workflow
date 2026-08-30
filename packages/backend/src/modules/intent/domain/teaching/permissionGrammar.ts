// RFC-348 D5d — the agent `permission` grammar the intent doc teaches, derived
// from the shared opencode permission roster (schemas/agent.ts) so a new key or
// action reaches the model without anyone re-typing prose.

import {
  OPENCODE_PERMISSION_ACTIONS,
  OPENCODE_PERMISSION_KEYS,
  OPENCODE_PERMISSION_WILDCARD_KEY,
} from '@agent-workflow/shared'

export function renderPermissionGrammar(): string {
  const keys = OPENCODE_PERMISSION_KEYS.map((key) => `\`${key}\``).join(' | ')
  const actions = OPENCODE_PERMISSION_ACTIONS.map((action) => `'${action}'`).join(' | ')
  return (
    `Keys: '${OPENCODE_PERMISSION_WILDCARD_KEY}' (baseline for every key) or one of ${keys}; ` +
    `each value is ${actions} or a {pattern: action} map. ` +
    `In headless runs 'ask' is treated as 'deny'; unknown keys grant nothing.`
  )
}
