// RFC-395 II-b W0: X implements; T/N/C/H/P consume; P also uses skill locations. Dormant.
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { ContentRef } from './contentRef'
import { decodeContentRefColumns, encodeContentRefColumns } from './contentRefCodec'

/** The sole column boundary, including inline bytes; no JSON-only ContentRef writer. */
export const contentRefColumns = Object.freeze({
  encode: encodeContentRefColumns,
  decode: decodeContentRefColumns,
})
export type ContentRefColumns = ReturnType<typeof encodeContentRefColumns>
export type ExternalContentKind = Exclude<ContentRef['kind'], 'inline'>
export interface ContentStoragePolicy {
  /** Byte count, inclusive. X supplies the profile's limit; W0 does not invent one. */
  readonly inlineMaxBytes: number
  readonly externalKind: ExternalContentKind
}
export interface ContentStorageFacts {
  readonly size: number
  readonly references: 'single' | 'shared'
}

/** Inline content has no catalog row. Shared or oversized content uses the profile's
 * external store and content_objects; database-bytes also writes content_bytes.
 */
export function contentStorageKind(
  policy: ContentStoragePolicy,
  facts: ContentStorageFacts,
): ContentRef['kind'] {
  if (!Number.isSafeInteger(policy.inlineMaxBytes) || policy.inlineMaxBytes < 0)
    throw new Error('content-inline-limit-invalid')
  if (!Number.isSafeInteger(facts.size) || facts.size < 0) throw new Error('content-size-invalid')
  return facts.references === 'single' && facts.size <= policy.inlineMaxBytes
    ? 'inline'
    : policy.externalKind
}

export interface ContentPublicationIdentity {
  readonly owner: string
  readonly logicalKey: string
}
export interface ContentPublicationFence extends ContentPublicationIdentity {
  readonly attempt: string
  readonly epoch: number
}
export interface ContentPublicationFacts extends ContentPublicationFence {
  readonly scope: string | null
  readonly sha256: string
  readonly size: number
}
interface ContentPublicationBase extends ContentPublicationFacts {
  readonly id: string
  readonly attempts: number
  readonly nextAttemptAt: number
  readonly createdAt: number
  readonly updatedAt: number
}
export type ContentPublication = ContentPublicationBase &
  (
    | {
        readonly state: 'pending'
        readonly contentId: string | null
        readonly sourceSealed: string | null
        readonly releasedAt: null
      }
    | {
        readonly state: 'ready'
        readonly contentId: string
        readonly sourceSealed: null
        readonly releasedAt: null
      }
    | {
        readonly state: 'releasing' | 'released'
        readonly contentId: string | null
        readonly sourceSealed: null
        readonly releasedAt: number
      }
  )
export type ReadyContentPublication = Extract<ContentPublication, { state: 'ready' }>
export interface ContentPublicationSelection {
  readonly owner: string
  readonly keys?: readonly string[]
  readonly scope?: string
  readonly keyPrefix?: string
}

/** Successor of hosted_object_publications, not an additional journal. The same
 * owner/logicalKey/attempt/epoch identifies a lifetime across retries. Transitions
 * compare the full fence; stale attempts and different immutable facts are refused.
 */
export interface ContentPublicationLedger {
  find(identity: ContentPublicationIdentity): Promise<ContentPublication | null>
  /** Exact release-key lookup in the caller's reference transaction, in storage order. */
  keysForContent(
    tx: PersistenceTx,
    selection: {
      readonly owner: string
      readonly scope: string
      readonly contentIds: readonly string[]
    },
  ): Promise<readonly string[]>
  begin(
    tx: PersistenceTx,
    input: ContentPublicationFacts & { readonly sourceSealed: string | null; readonly now: number },
  ): Promise<Extract<ContentPublication, { state: 'pending' | 'ready' }>>
  /** Called only after bytes are durable, in the owner's reference commit transaction. */
  ready(
    tx: PersistenceTx,
    input: ContentPublicationFence & { readonly contentId: string; readonly now: number },
  ): Promise<ReadyContentPublication>
  release(tx: PersistenceTx, selection: ContentPublicationSelection, now: number): Promise<number>
  /** Maintenance calls this after physical release, behind history/backup retention. */
  released(tx: PersistenceTx, fence: ContentPublicationFence, now: number): Promise<void>
  retry(
    tx: PersistenceTx,
    input: ContentPublicationFence & { readonly nextAttemptAt: number; readonly now: number },
  ): Promise<void>
  pending(page: {
    readonly now: number
    readonly limit: number
  }): Promise<readonly ContentPublication[]>
  scopes(
    owner: string,
    page: { readonly before: number; readonly after?: string; readonly limit: number },
  ): Promise<readonly string[]>
}

export type ContentSource =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | {
      readonly kind: 'stream'
      readonly sha256: string
      readonly size: number
      /** Reopen only if a retried publication still needs its bytes. */
      open(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
    }
  | { readonly kind: 'existing'; readonly ref: Exclude<ContentRef, { kind: 'inline' }> }

export interface ContentPutRequest {
  readonly publication: ContentPublicationFacts
  readonly source: ContentSource
  readonly contentVersion: number
  readonly mediaType: string | null
  readonly references: ContentStorageFacts['references']
}
export type ContentReferenceCommit = (tx: PersistenceTx, ref: ContentRef) => Promise<void>
export interface ContentReleaseRequest {
  readonly publication: ContentPublicationFence
  readonly ref: ContentRef
}

export interface ContentStore {
  readonly policy: ContentStoragePolicy
  readonly publications: ContentPublicationLedger
  /** Verify exact bytes/digest/size. Existing refs keep their external kind. Other
   * sources follow contentStorageKind. Transfer bytes outside retryable transactions;
   * commit() and ready() share one transaction after publication. Inline writes call
   * commit() without catalog/publication rows. The callback may be retried, so it
   * performs only transactional domain writes. A failed callback exposes no live ref.
   */
  put(request: ContentPutRequest, commit: ContentReferenceCommit): Promise<ContentRef>
  /** Return original bytes, including BOM, invalid UTF-8 and empty content. */
  read(ref: ContentRef): Promise<Uint8Array>
  /** Called with removal of the domain reference in the same transaction. Inline
   * release is a no-op. Physical release waits for all live/history/backup holders;
   * retry and owner cascade reconciliation use the same publication ledger.
   */
  release(tx: PersistenceTx, request: ContentReleaseRequest): Promise<void>
}

export type SkillContentTree =
  | { readonly kind: 'live' }
  | { readonly kind: 'version'; readonly version: number }
  | { readonly kind: 'staging'; readonly operationId: string }
  | { readonly kind: 'candidate'; readonly candidateId: string }
  | {
      readonly kind: 'trash'
      readonly operationId: string
      readonly original: Exclude<SkillContentTree, { kind: 'trash' }>
    }
export interface SkillContentPublicationLocation {
  readonly skillId: string
  readonly contentVersion: number
  readonly live: ContentRef | null
  /** Null remains a missing snapshot, never a fallback to live. */
  readonly snapshot: {
    readonly version: number
    readonly content: ContentRef
    readonly contentHash: string | null
  } | null
}
export interface SkillContentLocationQuery {
  locate(skillId: string, tree: SkillContentTree): Promise<ContentRef | null>
  /** P uses this for apply recovery: null means the skill was deleted; otherwise
   * compare contentVersion with version for current/superseded and inspect snapshot.
   * Decode both columns through contentRefColumns; never infer a database tree from
   * a shared path sentinel. Database locations retain explicit skillId and tree.
   */
  publication(skillId: string, version: number): Promise<SkillContentPublicationLocation | null>
}
