// RFC-616 §9.3 — one model call of a text-theme analysis. Task execution owns
// system agent runs and implements this; the composition root binds it.

export interface InsightRunRequest {
  readonly analysisId: string
  /** 1 for the first call, 2 for the one retry after an unreadable answer. */
  readonly attempt: number
  readonly prompt: string
  /** Who asked; null for a scheduled analysis. */
  readonly ownerUserId: string | null
  readonly subjectName: string
}

export type InsightRunResult =
  | { readonly ok: true; readonly answer: string }
  | { readonly ok: false; readonly code: string; readonly message: string }

export interface InsightRunner {
  run(request: InsightRunRequest): Promise<InsightRunResult>
}
