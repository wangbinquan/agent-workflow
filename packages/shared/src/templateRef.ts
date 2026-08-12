// RFC-292 — the single scanner/parser for workflow and webhook template refs.

import type { WebhookTemplateVar } from './schemas/webhook'
import { isWebhookTriggerField } from './triggerContext'

export type TemplateRefIssue =
  | 'empty-ref'
  | 'nested-ref'
  | 'control-character'
  | 'malformed-local-ref'
  | 'legacy-trigger-ref'
  | 'unknown-trigger-source'
  | 'unknown-trigger-field'
  | 'malformed-trigger-path'
  | 'unclosed-trigger-ref'
  | 'invalid-escape'

export interface TemplateSpan {
  /** Inclusive UTF-16 code-unit offset. */
  readonly start: number
  /** Exclusive UTF-16 code-unit offset. */
  readonly end: number
}

export type ValidTemplateRef =
  | {
      readonly kind: 'local'
      readonly name: string
      readonly raw: string
      readonly span: TemplateSpan
    }
  | {
      readonly kind: 'trigger'
      readonly source: 'webhook'
      readonly field: WebhookTemplateVar
      readonly raw: string
      readonly span: TemplateSpan
    }

export type InvalidTemplateRef = {
  readonly kind: 'invalid'
  readonly raw: string
  readonly reason: TemplateRefIssue
  readonly span: TemplateSpan
}

export type TemplateRef = ValidTemplateRef | InvalidTemplateRef

export type TemplateSegment =
  | { readonly kind: 'text'; readonly value: string; readonly span: TemplateSpan }
  | { readonly kind: 'ref'; readonly ref: ValidTemplateRef; readonly span: TemplateSpan }
  | { readonly kind: 'literal-ref'; readonly value: string; readonly span: TemplateSpan }
  | (InvalidTemplateRef & { readonly kind: 'invalid' })

const LOCAL_SEGMENT_RE = /^\w+$/

function hasForbiddenControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      return true
    }
  }
  return false
}

export function webhookTriggerRef(
  field: WebhookTemplateVar,
): `trigger.webhook.${WebhookTemplateVar}` {
  return `trigger.webhook.${field}`
}

export function webhookTriggerToken(
  field: WebhookTemplateVar,
): `{{trigger.webhook.${WebhookTemplateVar}}}` {
  return `{{${webhookTriggerRef(field)}}}`
}

function invalid(raw: string, reason: TemplateRefIssue, span: TemplateSpan): InvalidTemplateRef {
  return { kind: 'invalid', raw, reason, span }
}

function classifyRef(raw: string, span: TemplateSpan): TemplateRef {
  if (raw.length === 0) return invalid(raw, 'empty-ref', span)
  if (hasForbiddenControlCharacter(raw) || raw.includes('\n') || raw.includes('\r')) {
    return invalid(raw, 'control-character', span)
  }
  if (raw.includes('{{') || raw.includes('}}')) return invalid(raw, 'nested-ref', span)

  const parts = raw.split('.')
  if (parts[0] === 'trigger') {
    if (parts.length === 2) {
      return invalid(
        raw,
        parts[1] === 'webhook' ? 'malformed-trigger-path' : 'legacy-trigger-ref',
        span,
      )
    }
    if (parts.length < 3 || parts.length > 3) {
      return invalid(raw, 'malformed-trigger-path', span)
    }
    if (parts[1] !== 'webhook') return invalid(raw, 'unknown-trigger-source', span)
    const field = parts[2]!
    if (!isWebhookTriggerField(field)) return invalid(raw, 'unknown-trigger-field', span)
    return { kind: 'trigger', source: 'webhook', field, raw, span }
  }

  if (parts.length <= 2 && parts.every((part) => LOCAL_SEGMENT_RE.test(part))) {
    return { kind: 'local', name: raw, raw, span }
  }
  return invalid(raw, 'malformed-local-ref', span)
}

function isUnclosedTriggerLooking(body: string): boolean {
  const trimmed = body.trimStart()
  return trimmed.startsWith('trigger') || trimmed.startsWith('!trigger')
}

/** Left-to-right, single-pass scanner. Replacement text is never reparsed. */
export function parseTemplate(text: string): TemplateSegment[] {
  const out: TemplateSegment[] = []
  let cursor = 0

  while (cursor < text.length) {
    const open = text.indexOf('{{', cursor)
    if (open < 0) {
      out.push({
        kind: 'text',
        value: text.slice(cursor),
        span: { start: cursor, end: text.length },
      })
      break
    }
    if (open > cursor) {
      out.push({
        kind: 'text',
        value: text.slice(cursor, open),
        span: { start: cursor, end: open },
      })
    }

    const close = text.indexOf('}}', open + 2)
    if (close < 0) {
      const tail = text.slice(open)
      if (isUnclosedTriggerLooking(text.slice(open + 2))) {
        out.push(invalid(tail, 'unclosed-trigger-ref', { start: open, end: text.length }))
      } else {
        out.push({ kind: 'text', value: tail, span: { start: open, end: text.length } })
      }
      break
    }

    const end = close + 2
    const body = text.slice(open + 2, close)
    const trimmed = body.trim()
    const span = { start: open, end }

    if (body.includes('{{')) {
      out.push(invalid(trimmed, 'nested-ref', span))
    } else if (trimmed.startsWith('!')) {
      const bangAt = body.indexOf('!')
      const escapedBody = body.slice(0, bangAt) + body.slice(bangAt + 1)
      const escapedTrimmed = trimmed.slice(1)
      if (
        escapedTrimmed.length === 0 ||
        escapedTrimmed.includes('{{') ||
        escapedTrimmed.includes('}}') ||
        hasForbiddenControlCharacter(escapedTrimmed) ||
        escapedTrimmed.includes('\n') ||
        escapedTrimmed.includes('\r')
      ) {
        out.push(invalid(trimmed, 'invalid-escape', span))
      } else {
        out.push({ kind: 'literal-ref', value: `{{${escapedBody}}}`, span })
      }
    } else {
      const ref = classifyRef(trimmed, span)
      out.push(ref.kind === 'invalid' ? ref : { kind: 'ref', ref, span })
    }
    cursor = end
  }

  return out
}

/** First occurrence of each semantic ref/issue, in source order. */
export function extractTemplateRefs(text: string): TemplateRef[] {
  const seen = new Set<string>()
  const out: TemplateRef[] = []
  for (const segment of parseTemplate(text)) {
    const ref = segment.kind === 'ref' ? segment.ref : segment.kind === 'invalid' ? segment : null
    if (ref === null) continue
    const key =
      ref.kind === 'local'
        ? `local:${ref.name}`
        : ref.kind === 'trigger'
          ? `trigger:${ref.source}:${ref.field}`
          : `invalid:${ref.reason}:${ref.raw}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

export interface RenderTemplateRefsResult {
  readonly value: string
  readonly invalid: readonly InvalidTemplateRef[]
}

/**
 * Render valid refs through a sink callback. Invalid segments stay byte-for-byte
 * visible in `value` and are also returned so callers can fail closed.
 */
export function renderTemplateRefs(
  text: string,
  resolve: (ref: ValidTemplateRef) => string,
): RenderTemplateRefsResult {
  const invalidRefs: InvalidTemplateRef[] = []
  let value = ''
  for (const segment of parseTemplate(text)) {
    switch (segment.kind) {
      case 'text':
      case 'literal-ref':
        value += segment.value
        break
      case 'ref':
        value += resolve(segment.ref)
        break
      case 'invalid':
        invalidRefs.push(segment)
        value += text.slice(segment.span.start, segment.span.end)
        break
    }
  }
  return { value, invalid: invalidRefs }
}
