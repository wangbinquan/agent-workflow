import type { ObservationMeasurement } from '@agent-workflow/shared'
import {
  TOKEN_BUCKETS,
  object,
  nativeId,
  readUsage,
  common,
  model,
  scope,
  normalizeUsageFrame,
  type JsonObject,
  type RuntimeUsageContext,
  type RuntimeUsageFrame,
} from '../usage'
function claude(
  raw: JsonObject,
  c: RuntimeUsageContext,
  diagnostics: string[],
): ObservationMeasurement[] {
  if (raw.type !== 'assistant' && raw.type !== 'result') return []
  // A sidechain frame cannot inherit the root's attribution without its owner mapping.
  if ((raw.parent_tool_use_id != null || raw.isSidechain === true) && c.parentSessionId === null) {
    diagnostics.push('unmapped-child-session')
    return []
  }
  const message = object(raw.message)
  if (raw.type === 'assistant') {
    const id = nativeId(message?.id)
    if (!id) {
      diagnostics.push('missing-message-identity')
      return []
    }
    const u = object(message?.usage)
    const usage = readUsage(
      {
        input: u?.input_tokens,
        output: null,
        cacheRead: u?.cache_read_input_tokens,
        cacheWrite: u?.cache_creation_input_tokens,
      },
      diagnostics,
    )
    return [
      {
        ...common(c, raw),
        recordId: 'claude:message:' + id,
        adapterVersion: 'claude-stream-json/cost-contract@1',
        reporting: 'delta',
        inclusion: 'self',
        model: model(c, nativeId(message?.model)),
        coverage: 'partial',
        validity: 'valid',
        basis: { kind: 'invocation' },
        usage,
        scope: scope(c, 'request'),
      },
    ]
  }
  const models = object(raw.modelUsage)
  const entries = models
    ? Object.entries(models).filter(([id, value]) => nativeId(id) && object(value))
    : []
  if (entries.length)
    return entries.map(([id, value]) => {
      const u = object(value)!
      const usage = readUsage(
        {
          input: u.inputTokens,
          output: u.outputTokens,
          cacheRead: u.cacheReadInputTokens,
          cacheWrite: u.cacheCreationInputTokens,
        },
        diagnostics,
      )
      const invalid =
        raw.subtype === 'error_during_execution' && TOKEN_BUCKETS.every((b) => usage[b] === '0')
      return {
        ...common(c, raw),
        recordId: 'claude:tree:' + c.sessionId + ':' + id,
        adapterVersion: 'claude-stream-json/cost-contract@1',
        reporting: 'cumulative',
        inclusion: 'includes-descendants',
        model: model(c, id),
        coverage: TOKEN_BUCKETS.every((b) => usage[b] !== null) ? 'complete' : 'partial',
        validity: invalid ? 'invalid-final' : 'valid',
        coveredThroughTurn: c.turnIndex,
        usage,
        basis:
          c.cumulative.kind === 'invocation'
            ? { kind: 'invocation' }
            : {
                kind: 'native-session',
                lineageKey: c.cumulative.lineageKey,
                baseline: c.cumulative.modelBaselines?.[id] ?? null,
              },
        scope: scope(c, 'tree-total'),
      }
    })
  const u = object(raw.usage),
    resultId = nativeId(raw.uuid)
  if (!resultId) {
    diagnostics.push('missing-result-identity')
    return []
  }
  const usage = readUsage(
    {
      input: u?.input_tokens,
      output: u?.output_tokens,
      cacheRead: u?.cache_read_input_tokens,
      cacheWrite: u?.cache_creation_input_tokens,
    },
    diagnostics,
  )
  const invalid =
    raw.subtype === 'error_during_execution' && TOKEN_BUCKETS.every((b) => usage[b] === '0')
  return [
    {
      ...common(c, raw),
      recordId: 'claude:main:' + c.sessionId + ':' + c.turnId,
      adapterVersion: 'claude-stream-json/cost-contract@1',
      reporting: 'cumulative',
      inclusion: 'self',
      // Main-loop totals can contain several models; never assign the configured model.
      model: null,
      coverage: TOKEN_BUCKETS.every((b) => usage[b] !== null) ? 'complete' : 'partial',
      validity: invalid ? 'invalid-final' : 'valid',
      coveredThroughTurn: c.turnIndex,
      basis: { kind: 'invocation' },
      usage,
      scope: scope(c, 'self-total'),
    },
  ]
}

/** Numeric evidence only; vendor currency estimates are deliberately ignored. */
export function normalizeUsage(raw: unknown, context: RuntimeUsageContext): RuntimeUsageFrame {
  return normalizeUsageFrame(raw, context, claude)
}
