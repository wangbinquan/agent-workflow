// RFC-370 §10 V16 — the one task-image operation behind hosted code-review
// reads, shared by the control-plane adapter and the volume handler.
import type {
  RepositoryPresence,
  RevisionChangeEntry,
  RevisionFileRead,
} from '../../application/ports/repositoryRevisionContent'

export const CODE_REVIEW_OPERATION = 'code-review'
/** Results above this size travel as a volume file (the outcome file holds
 * at most 1 MiB of control data, see `WORKSPACE_RESULT_MAX_BYTES`). */
export const CODE_REVIEW_INLINE_BYTES = 256 * 1024
/** Volume directory of those result files (control-plane volume path). */
export const CODE_REVIEW_SCRATCH = '/work/tmp/code-review'
/** A result file nobody released within this long is pruned by the next command. */
export const CODE_REVIEW_SCRATCH_TTL_MS = 15 * 60_000

export type CodeReviewVolumeRequest =
  | { readonly method: 'presence'; readonly path: string }
  | {
      readonly method: 'changes'
      readonly path: string
      readonly from: string
      readonly to?: string
      readonly lineStats?: boolean
    }
  | {
      readonly method: 'read-revision'
      readonly path: string
      readonly rev: string
      readonly paths: readonly string[]
      readonly maxBytes: number
    }
  | { readonly method: 'grep'; readonly path: string; readonly patterns: readonly string[] }
  | { readonly method: 'class-index'; readonly path: string }
  | { readonly method: 'snapshot-digest'; readonly path: string }
  | { readonly method: 'release'; readonly file: string }

/** JSON forms of the port's answers (maps travel as entry lists). */
export interface CodeReviewVolumeResults {
  readonly presence: RepositoryPresence
  readonly changes: {
    readonly entries: readonly RevisionChangeEntry[]
    readonly lineStats?: readonly (readonly [string, number, number])[]
  }
  readonly 'read-revision': readonly (readonly [string, RevisionFileRead])[]
  readonly grep: readonly string[]
  readonly 'class-index': readonly (readonly [string, readonly string[]])[]
  readonly 'snapshot-digest': string
}

export type CodeReviewOutcome =
  | { readonly value: unknown; readonly resultFile?: undefined }
  | { readonly value?: undefined; readonly resultFile: string }
