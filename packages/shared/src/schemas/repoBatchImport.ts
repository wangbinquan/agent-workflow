// RFC-033: Batch import of remote Git URLs into the cached-repos store.
//
// Wire types for `POST /api/cached-repos/batch-import`, the WS push channel
// `/ws/repo-imports/{batchId}`, and the per-row retry endpoint. The backend
// keeps in-memory batch state — clients reconcile via `BatchImportSnapshot`
// snapshots (initial + GET) and incremental `RepoImportWsMessage` events.

import { z } from 'zod'
import { hasQueryCredential, isFileSchemeUrl } from '../git-url'

export const BATCH_IMPORT_MAX_URLS = 100

// RFC-204 impl-gate: reject query-string credentials at every URL entry point.
// Such a URL would slug its token into cached_repos.local_path (on the wire) and
// url_hash; the userinfo form is fine (sealing covers it). Mirrors the launch
// gate in schemas/task.ts. Shared refinement so batch-import + retry stay in sync.
const noQueryCredentialUrl = (url: string): boolean => !hasQueryCredential(url)
const QUERY_CREDENTIAL_MSG = 'repo-url-query-credential'

// RFC-287 G5 / T14 实现门：批量导入必须和启动面同样拒 `file://`。
//
// 漏掉这里等于 G5 完全形同虚设：导入是**公共**接口，`file:///srv/private/repo`
// 会被真的克隆进缓存（repoBatchImport.ts 的 clone 分支），拿到 cachedRepoId 之后
// 再 `POST /api/tasks` 走 cachedRepoId 分支，启动面那道 refine 只看 `repoUrl`、
// 根本不会被触发——两步就绕过去了。同一个 cachedRepoId 放进仓库组、或被
// `sourceTaskId` 重放，同样会在启动时被转回 cache spec。
const noFileSchemeUrl = (url: string): boolean => !isFileSchemeUrl(url)
const FILE_SCHEME_MSG = 'repo-url-file-scheme-unsupported'

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
    .array(
      z
        .string()
        .min(1)
        .refine(noQueryCredentialUrl, { message: QUERY_CREDENTIAL_MSG })
        .refine(noFileSchemeUrl, { message: FILE_SCHEME_MSG }),
    )
    .min(1)
    .max(BATCH_IMPORT_MAX_URLS),
})
export type StartBatchImportRequest = z.infer<typeof StartBatchImportRequestSchema>

export const RetryBatchImportRowRequestSchema = z.object({
  /** Optional URL override; when present the row's `inputUrl` is replaced before re-queueing. */
  url: z
    .string()
    .min(1)
    .refine(noQueryCredentialUrl, { message: QUERY_CREDENTIAL_MSG })
    .refine(noFileSchemeUrl, { message: FILE_SCHEME_MSG })
    .optional(),
})
export type RetryBatchImportRowRequest = z.infer<typeof RetryBatchImportRowRequestSchema>
