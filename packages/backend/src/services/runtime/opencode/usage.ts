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
function opencode(
  raw: JsonObject,
  c: RuntimeUsageContext,
  diagnostics: string[],
): ObservationMeasurement[] {
  if (raw.type !== 'step_finish') return []
  const part = object(raw.part),
    tokens = object(part?.tokens)
  const id = nativeId(part?.id)
  if (!id) {
    diagnostics.push('missing-step-identity')
    return []
  }
  if (
    (raw.sessionID !== undefined && raw.sessionID !== c.sessionId) ||
    (part?.sessionID !== undefined && part.sessionID !== c.sessionId)
  ) {
    diagnostics.push('step-session-mismatch')
    return []
  }
  const cache = object(tokens?.cache)
  const usage = readUsage(
    {
      input: tokens?.input,
      output: tokens?.output,
      cacheRead: cache?.read,
      cacheWrite: cache?.write,
    },
    diagnostics,
  )
  // OpenCode subtracts reasoning from native output; the canonical output bucket
  // includes both. Missing reasoning remains unknown, never an assumed zero.
  const reasoning = readUsage(
    { input: 0, output: tokens?.reasoning, cacheRead: 0, cacheWrite: 0 },
    diagnostics,
  ).output
  usage.output =
    usage.output === null || reasoning === null
      ? null
      : readUsage(
          {
            input: 0,
            output: (BigInt(usage.output) + BigInt(reasoning)).toString(),
            cacheRead: 0,
            cacheWrite: 0,
          },
          diagnostics,
        ).output
  return [
    {
      ...common(c, raw),
      recordId: 'opencode:step:' + id,
      adapterVersion: 'opencode-step-finish/1.15.5-1.18.31@2',
      reporting: 'delta',
      inclusion: 'self',
      model: model(c, c.actualModel),
      coverage: TOKEN_BUCKETS.every((b) => usage[b] !== null) ? 'complete' : 'partial',
      validity: 'valid',
      basis: { kind: 'invocation' },
      usage,
      scope: scope(c, 'request'),
    },
  ]
}

/** Numeric evidence only; vendor currency estimates are deliberately ignored. */
export function normalizeUsage(raw: unknown, context: RuntimeUsageContext): RuntimeUsageFrame {
  return normalizeUsageFrame(raw, context, opencode)
}
