// A code host that models what publishing a review actually does, for RFC-304.
//
// Shared rather than copied into each round test, because the sequence has real
// structure and five hand-rolled copies drift: GitLab stages drafts, publishes
// them in one call, and only THEN do the comments exist as discussions with
// their own ids — ids that differ from the draft ids, which is exactly why the
// publish path reads them back instead of reusing them. A fake that skipped
// that distinction would let a bug through where the ledger stores draft ids
// that `thread.resolve` rejects.
//
// It also means `comment.list` returns what was actually published, so the
// fingerprint read-back is exercised for real rather than stubbed.

import type {
  CodeHostCall,
  CodeHostPort,
  CodeHostResult,
} from '../../src/modules/code-capability/ports/codeHostPort'

export interface ReviewFakeOptions {
  provider?: 'gitlab' | 'github'
  /** MR body for `mr.get`. */
  mrBody?: unknown
  /** What `mr.diff` returns. */
  diff?: unknown
  /** Comments already on the MR before this round — a previous round's work. */
  existing?: Array<{ id: string; body: string }>
  /** Force a specific action to fail, for the failure-path tests. */
  failOn?: (call: CodeHostCall) => CodeHostResult | null
}

const okJson = (body: unknown): CodeHostResult => ({
  ok: true,
  status: 200,
  body: JSON.stringify(body),
  truncated: false,
})

export function createReviewHostFake(options: ReviewFakeOptions = {}) {
  const provider = options.provider ?? 'gitlab'
  const calls: CodeHostCall[] = []

  /** Staged but not yet published. Invisible to `comment.list` until publish. */
  const drafts = new Map<string, string>()
  /**
   * Published comments, keyed by DISCUSSION id, each carrying its own NOTE id.
   *
   * The two are deliberately different values, because the code depends on the
   * difference: `thread.resolve` addresses the discussion, `comment.update`
   * addresses the note, and GitLab 404s if they are swapped. A fake that used
   * one id for both would make that mistake untestable.
   */
  const published = new Map<string, { noteId: string; body: string }>(
    (options.existing ?? []).map(
      (c) => [c.id, { noteId: `note-of-${c.id}`, body: c.body }] as const,
    ),
  )
  let nextId = published.size

  const port: CodeHostPort = {
    async call(call) {
      calls.push(call)
      const forced = options.failOn?.(call)
      if (forced !== null && forced !== undefined) return forced

      switch (call.action) {
        case 'mr.get':
          return okJson(options.mrBody ?? {})
        case 'mr.diff':
          return okJson(options.diff ?? [])

        case 'review.draft-create': {
          nextId += 1
          const id = `draft-${nextId}`
          drafts.set(id, String(call.params.body ?? ''))
          return okJson({ id })
        }

        case 'review.draft-discard': {
          drafts.delete(String(call.params.draft ?? ''))
          return okJson({})
        }

        case 'review.draft-publish': {
          // The id changes here, deliberately. GitLab's bulk_publish turns a
          // draft note into an ordinary note in a NEW discussion, so anything
          // that reused the draft id would be storing a dead reference.
          for (const body of drafts.values()) {
            nextId += 1
            published.set(`disc-${nextId}`, { noteId: `note-${nextId}`, body })
          }
          drafts.clear()
          return okJson({})
        }

        // GitHub posts the whole review at once; the response carries the
        // review, not its comments, which is why the ids are read back.
        case 'review.submit': {
          const comments: unknown = JSON.parse(String(call.params.comments ?? '[]'))
          if (Array.isArray(comments)) {
            for (const comment of comments) {
              nextId += 1
              published.set(`${nextId}`, {
                noteId: `${nextId}`,
                body: String((comment as { body?: unknown }).body ?? ''),
              })
            }
          }
          return okJson({ id: nextId })
        }

        case 'comment.create-inline': {
          nextId += 1
          const id = `disc-${nextId}`
          published.set(id, { noteId: `note-${nextId}`, body: String(call.params.body ?? '') })
          return okJson({ id })
        }

        // The MR-level overview comment.
        case 'comment.create': {
          nextId += 1
          const id = `disc-${nextId}`
          published.set(id, { noteId: `note-${nextId}`, body: String(call.params.body ?? '') })
          return okJson({ id })
        }

        case 'comment.update': {
          // Addressed by NOTE id, which is how GitLab's notes endpoint works.
          // Looking it up by discussion id here would let a swapped-id bug pass.
          const wanted = String(call.params.comment ?? '')
          for (const [discussionId, entry] of published) {
            if (entry.noteId !== wanted) continue
            published.set(discussionId, { ...entry, body: String(call.params.body ?? '') })
            return okJson({ id: wanted })
          }
          return { ok: false, code: 'not-found', message: `no note ${wanted}` }
        }

        case 'comment.list':
          return okJson(
            provider === 'gitlab'
              ? [...published].map(([id, e]) => ({ id, notes: [{ id: e.noteId, body: e.body }] }))
              : [...published].map(([id, e]) => ({ id, body: e.body })),
          )

        default:
          nextId += 1
          return okJson({ id: `other-${nextId}` })
      }
    },
  }

  return {
    port,
    calls,
    /** Bodies of everything currently on the MR. */
    publishedBodies: () => [...published.values()].map((e) => e.body),
    /** Discussion ids — what `thread.resolve` addresses. */
    publishedIds: () => [...published.keys()],
    /** Note ids — what `comment.update` addresses. */
    noteIds: () => [...published.values()].map((e) => e.noteId),
    /** Staged and never withdrawn — the orphan case. */
    liveDrafts: () => [...drafts.keys()],
    /** How many line comments were staged, whatever became of them. */
    staged: () => calls.filter((c) => c.action === 'review.draft-create').length,
    discarded: () => calls.filter((c) => c.action === 'review.draft-discard').length,
    actions: () => calls.map((c) => c.action),
  }
}
