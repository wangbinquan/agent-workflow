// RFC-371 v2 §4 — protocol-neutral usage metering. Each RuntimeDriver parses its
// own stdout protocol into one replaceable per-invocation snapshot split by the
// model the runtime actually reported; callers never branch on protocol names.

export interface RuntimeUsageModel {
  /** Actual reported model; '' when the runtime did not attribute it. */
  readonly model: string
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** Includes reasoning. */
  readonly output: number
  /** Known subset of output. */
  readonly reasoning: number
}

export interface RuntimeUsageSnapshot {
  /** complete: covers everything this invocation used so far; partial: a lower bound. */
  readonly state: 'partial' | 'complete'
  readonly models: readonly RuntimeUsageModel[]
}

export interface RuntimeUsageMeter {
  /** Feed one parsed stdout event; true when the snapshot changed. */
  observe(event: Readonly<Record<string, unknown>>): boolean
  snapshot(): RuntimeUsageSnapshot
  /**
   * After the process drained: a bounded authoritative summary (e.g. a native
   * store read that includes delegated sub-agents), or null to keep the stream
   * snapshot. Never throws.
   */
  finish?(): RuntimeUsageSnapshot | null
}

export interface RuntimeUsageMeterInput {
  /** This invocation resumes an existing native session. */
  readonly resumed: boolean
  /** The model the platform asked for, when explicit. */
  readonly configuredModel: string | null
}

export type JsonObject = Record<string, unknown>

export const objectOf = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined

/** A reported token count; anything else (missing, negative, unsafe) contributes nothing. */
export const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0

export function modelKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 300) : ''
}

/** Mutable per-model accumulator behind a meter. */
export class UsageAccumulator {
  private readonly rows = new Map<string, RuntimeUsageModel>()

  add(model: string, delta: Omit<RuntimeUsageModel, 'model'>): void {
    const previous = this.rows.get(model)
    this.rows.set(model, {
      model,
      input: (previous?.input ?? 0) + delta.input,
      cacheRead: (previous?.cacheRead ?? 0) + delta.cacheRead,
      cacheWrite: (previous?.cacheWrite ?? 0) + delta.cacheWrite,
      output: (previous?.output ?? 0) + delta.output,
      reasoning: (previous?.reasoning ?? 0) + delta.reasoning,
    })
  }

  replace(rows: readonly RuntimeUsageModel[]): void {
    this.rows.clear()
    for (const row of rows) this.add(row.model, row)
  }

  snapshot(state: RuntimeUsageSnapshot['state']): RuntimeUsageSnapshot {
    return {
      state,
      models: [...this.rows.values()].sort((a, b) => a.model.localeCompare(b.model)),
    }
  }
}
