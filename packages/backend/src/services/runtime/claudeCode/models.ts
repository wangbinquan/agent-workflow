// RFC-111 PR-B — Claude Code model list (D9).
//
// Claude Code has no `models` subcommand, so this is a curated static list of
// the family aliases plus current full IDs. The ModelSelect component already
// accepts custom free-text values, so a model not listed here (a future release,
// a dated snapshot) can still be typed in. Update on release.

import type { RuntimeModel } from '../types'

const CLAUDE_MODELS: RuntimeModel[] = [
  // Aliases (resolve to the latest of each family) — the ergonomic default.
  { id: 'opus', provider: 'anthropic', name: 'Opus (alias → latest)' },
  { id: 'sonnet', provider: 'anthropic', name: 'Sonnet (alias → latest)' },
  { id: 'haiku', provider: 'anthropic', name: 'Haiku (alias → latest)' },
  { id: 'fable', provider: 'anthropic', name: 'Fable (alias → latest)' },
  // Current full IDs (pin a specific model).
  { id: 'claude-opus-4-8', provider: 'anthropic', name: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-4-6', provider: 'anthropic', name: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', provider: 'anthropic', name: 'Claude Haiku 4.5' },
  { id: 'claude-fable-5', provider: 'anthropic', name: 'Claude Fable 5' },
]

/** Static claude model list (cloned so callers can't mutate the module state). */
export function listClaudeModels(): RuntimeModel[] {
  return CLAUDE_MODELS.map((m) => ({ ...m }))
}
