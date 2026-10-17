import type { CodeHostEvent } from '@agent-workflow/shared'

export type HeaderBag = Readonly<Record<string, string | undefined>>
export type NormalizeResult =
  | { ok: true; event: CodeHostEvent }
  | { ok: false; reason: 'unsupported-event' | 'parse-failed'; detail: string }
