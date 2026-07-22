// RFC-033: Batch import of remote Git URLs into the cached-repos store.
//
// Wire types for `POST /api/cached-repos/batch-import`, the WS push channel
// `/ws/repo-imports/{batchId}`, and the per-row retry endpoint. The backend
// keeps in-memory batch state — clients reconcile via `BatchImportSnapshot`
// snapshots (initial + GET) and incremental `RepoImportWsMessage` events.

import { z } from 'zod'
import { hasQueryCredential } from '../git-url'

export const BATCH_IMPORT_MAX_URLS = 100

// RFC-204 impl-gate: reject query-string credentials at every URL entry point.
// Such a URL would slug its token into cached_repos.local_path (on the wire) and
// url_hash; the userinfo form is fine (sealing covers it). Mirrors the launch
// gate in schemas/task.ts. Shared refinement so batch-import + retry stay in sync.
const noQueryCredentialUrl = (url: string): boolean => !hasQueryCredential(url)
const QUERY_CREDENTIAL_MSG = 'repo-url-query-credential'

export const BatchImportRowStatusSchema = z.enum(['queued', 'cloning', 'done', 'failed'])
export type BatchImportRowStatus = z.infer<typeof BatchImportRowStatusSchema>

export const BatchImportRowSchema = z.object({
  /** ULID assigned by the backend; stable across status transitions and retries. */
  rowId: z.string(),
  /** Always already-redacted before crossing the process boundary. */
  inputUrl: z.string(),
  inputUrlRedacted: z.string(),
  status: BatchImportRowStatusSchema,
  /** `cold` is meaningful only when status === 'done': true when this row triggered a fresh clone. */
  cold: z.boolean().nullable(),
  /** `fetchOk` is meaningful only on warm-path `done` rows. */
  fetchOk: z.boolean().nullable(),
  /** cached_repos.id once the row finishes successfully. */
  cachedRepoId: z.string().nullable(),
  /** Stable error code on `failed` rows; null otherwise. */
  errorCode: z.string().nullable(),
  /** Human-readable, already redacted, ≤400 chars. */
  message: z.string().nullable(),
  /** ISO timestamps. `startedAt` / `finishedAt` set as the row transitions. */
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})
export type BatchImportRow = z.infer<typeof BatchImportRowSchema>

export const BatchImportStateSchema = z.enum(['running', 'completed'])
export type BatchImportState = z.infer<typeof BatchImportStateSchema>

export const BatchImportSnapshotSchema = z.object({
  batchId: z.string(),
  state: BatchImportStateSchema,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  rows: z.array(BatchImportRowSchema),
})
export type BatchImportSnapshot = z.infer<typeof BatchImportSnapshotSchema>

export const StartBatchImportRequestSchema = z.object({
  urls: z
    .array(z.string().min(1).refine(noQueryCredentialUrl, { message: QUERY_CREDENTIAL_MSG }))
    .min(1)
    .max(BATCH_IMPORT_MAX_URLS),
})
export type StartBatchImportRequest = z.infer<typeof StartBatchImportRequestSchema>

export const RetryBatchImportRowRequestSchema = z.object({
  /** Optional URL override; when present the row's `inputUrl` is replaced before re-queueing. */
  url: z.string().min(1).refine(noQueryCredentialUrl, { message: QUERY_CREDENTIAL_MSG }).optional(),
})
export type RetryBatchImportRowRequest = z.infer<typeof RetryBatchImportRowRequestSchema>
