import { canonicalJson } from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import type { CustomEventSourceDraft } from './customEventSource'

export function cursorValue(cursorJson: string | null): unknown | null {
  return cursorJson === null ? null : (JSON.parse(cursorJson) as unknown)
}

export function normalizedCursor(value: unknown | null): string | null {
  if (value === null) return null
  const json = canonicalJson(value)
  if (json.length > 64 * 1024) throw new Error('observer cursor exceeds 64KB')
  return json
}

export function dedupeKey(input: {
  readonly ingestionMode: CustomEventSourceDraft['ingestionMode']
  readonly eventKey: string
  readonly subjectRef: string
  readonly sourceEventKey: string
  readonly sourceEventRevision: string
}): string {
  return sha256Hex(canonicalJson(input))
}
