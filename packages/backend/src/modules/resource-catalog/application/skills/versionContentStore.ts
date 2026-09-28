import type { SkillTreeFiles } from './creationContentStore'

/** Physical changes selected by AW's editor, restore or import workflow. */
export type SkillVersionContentChange =
  | { readonly kind: 'retain' }
  | { readonly kind: 'write-main'; readonly content: string }
  | { readonly kind: 'write-file'; readonly path: string; readonly content: string }
  | { readonly kind: 'delete-file'; readonly path: string }
  | { readonly kind: 'restore-version'; readonly version: number }
  | ({ readonly kind: 'replace-files' } & SkillTreeFiles)

/** Opaque durable storage references; only the selected adapter interprets them. */
export interface SkillVersionPublication {
  readonly skillId: string
  readonly version: number
  readonly publicationId: string
  readonly liveRef: string
  readonly stagingRef: string
  readonly versionRef: string
}

export interface SkillVersionContentPlan extends SkillVersionPublication {
  readonly stagingJournalRef: string
  readonly versionJournalRef: string
}

/**
 * AW owns operation phases, no-op decisions and the database transaction.
 * Planning has no effects; each awaited method completes its named storage step.
 * A failed step leaves its operation-scoped references available for compensation
 * or recovery. Content hash uses the existing canonical skill-tree algorithm.
 */
export interface SkillVersionContentStore {
  plan(input: {
    readonly skillId: string
    readonly version: number
    readonly publicationId: string
  }): SkillVersionContentPlan
  stage(
    publication: SkillVersionPublication,
    change: SkillVersionContentChange,
    compareLive: boolean,
  ):
    | { readonly contentHash: string; readonly matchesLive: boolean }
    | Promise<{ readonly contentHash: string; readonly matchesLive: boolean }>
  discardStage(publication: SkillVersionPublication): void | Promise<void>
  captureVersion(publication: SkillVersionPublication): void | Promise<void>
  publish(publication: SkillVersionPublication, contentHash: string): void | Promise<void>
  abort(publication: SkillVersionPublication): void | Promise<void>
}
