// RFC-295 — total active-template projection for CodeHostCall.
//
// Persisted workflow inventory intentionally keeps every string so migration
// and diff never erase inactive values. Authoring, validation and execution
// preflight must instead inspect only the fields the selected action/provider
// can execute. This pure projection is the shared boundary for those consumers.

import type { CodeHostProvider } from '../schemas/webhook'
import {
  codeHostActionFields,
  codeHostActionSupported,
  isCodeHostAction,
  type CodeHostAction,
  type CodeHostField,
} from './actions'

export type CodeHostActiveTemplateSink =
  | 'http-param'
  | 'http-path'
  | 'http-query'
  | 'http-json-body'

export interface CodeHostActiveTemplateValue {
  readonly sink: CodeHostActiveTemplateSink
  /** JSON-pointer suffix below the code-host node. */
  readonly pointer: string
  readonly key: string
  readonly text: string
}

export type CodeHostTemplateProjection =
  | {
      readonly kind: 'valid-preset'
      readonly provider: CodeHostProvider
      readonly action: Exclude<CodeHostAction, 'custom'>
      readonly active: readonly CodeHostActiveTemplateValue[]
      readonly activeFields: readonly CodeHostField[]
    }
  | {
      readonly kind: 'valid-custom'
      readonly provider: CodeHostProvider
      readonly action: 'custom'
      readonly active: readonly CodeHostActiveTemplateValue[]
      readonly activeFields: readonly []
    }
  | {
      readonly kind: 'unsupported'
      readonly provider: CodeHostProvider
      readonly action: CodeHostAction
      readonly active: readonly []
      readonly activeFields: readonly []
    }
  | {
      readonly kind: 'invalid-action'
      readonly provider: CodeHostProvider | null
      readonly action: string | null
      readonly active: readonly []
      readonly activeFields: readonly []
    }
  | {
      readonly kind: 'invalid-provider'
      readonly provider: string | null
      readonly action: string | null
      readonly active: readonly []
      readonly activeFields: readonly []
    }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function pointerPart(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

function readProvider(value: unknown): CodeHostProvider | null {
  return value === 'gitlab' || value === 'github' ? value : null
}

function readParams(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(record(value))) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}

function customValues(value: unknown): CodeHostActiveTemplateValue[] {
  const request = record(value)
  const out: CodeHostActiveTemplateValue[] = []
  if (typeof request.path === 'string') {
    out.push({
      sink: 'http-path',
      pointer: '/request/path',
      key: 'request:path',
      text: request.path,
    })
  }
  const query = record(request.query)
  for (const [key, text] of Object.entries(query)) {
    if (typeof text !== 'string') continue
    out.push({
      sink: 'http-query',
      pointer: `/request/query/${pointerPart(key)}`,
      key: `request:query:${key}`,
      text,
    })
  }
  if (typeof request.body === 'string') {
    out.push({
      sink: 'http-json-body',
      pointer: '/request/body',
      key: 'request:body',
      text: request.body,
    })
  }
  return out
}

/**
 * Project any structurally CodeHostCall-like object (WorkflowNode or runtime
 * CodeHostCallSpec). Invalid/unsupported discriminators are total results with
 * an empty active set so callers can report the action error before scanning
 * hidden values.
 */
export function projectCodeHostTemplates(value: unknown): CodeHostTemplateProjection {
  const rec = record(value)
  const rawProvider = typeof rec.provider === 'string' ? rec.provider : null
  const rawAction = typeof rec.action === 'string' ? rec.action : null
  const provider = readProvider(rawProvider)
  if (provider === null) {
    return {
      kind: 'invalid-provider',
      provider: rawProvider,
      action: rawAction,
      active: [],
      activeFields: [],
    }
  }
  if (!isCodeHostAction(rawAction)) {
    return {
      kind: 'invalid-action',
      provider,
      action: rawAction,
      active: [],
      activeFields: [],
    }
  }
  if (!codeHostActionSupported(rawAction, provider)) {
    return { kind: 'unsupported', provider, action: rawAction, active: [], activeFields: [] }
  }
  if (rawAction === 'custom') {
    return {
      kind: 'valid-custom',
      provider,
      action: rawAction,
      active: customValues(rec.request),
      activeFields: [],
    }
  }

  const params = readParams(rec.params)
  const fields = codeHostActionFields(rawAction, provider)
  return {
    kind: 'valid-preset',
    provider,
    action: rawAction,
    activeFields: fields.map((field) => field.name),
    active: fields.flatMap((field) => {
      const text = params[field.name]
      return text === undefined
        ? []
        : [
            {
              sink: 'http-param' as const,
              pointer: `/params/${pointerPart(field.name)}`,
              key: `param:${field.name}`,
              text,
            },
          ]
    }),
  }
}
