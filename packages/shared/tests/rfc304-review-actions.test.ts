// RFC-304 T19 — the three batch-review actions in the code-host registry.
//
// The registry's own rule is "state the real asymmetry, do not pretend the two
// hosts are the same" (RFC-269 header). These three actions are the sharpest
// case of it so far, and the tests exist to stop a future simplification:
//
//   GitLab  builds draft notes one request at a time, then bulk-publishes.
//           There IS a window where drafts exist unpublished.
//   GitHub  takes the entire review — overview plus every line comment — in a
//           single request. That window does not exist, and there is no draft
//           resource to create.
//
// The tempting simplification is one `review.publish` action mapped to both. It
// cannot work: on GitHub it would have to invent a draft concept, and on GitLab
// it would silently post only the overview. So each host declares `unsupported`
// for the shape it does not have — which is information, not a gap.

import { describe, expect, test } from 'bun:test'
import {
  CODE_HOST_ACTION_DEFS,
  CODE_HOST_ACTIONS,
  type CodeHostAction,
} from '../src/codeHost/actions'

const def = (action: CodeHostAction) => CODE_HOST_ACTION_DEFS[action]

describe('RFC-304 T19 — the review actions are registered', () => {
  test('all three exist in the closed action list', () => {
    for (const action of [
      'review.draft-create',
      'review.draft-publish',
      'review.submit',
    ] as const) {
      expect(CODE_HOST_ACTIONS).toContain(action)
      expect(def(action)).toBeDefined()
    }
  })

  test('they are grouped with the other comment actions', () => {
    // The Inspector groups its dropdown by `group`; a review action filed under
    // `custom` would be findable only by someone who already knew it existed.
    for (const action of [
      'review.draft-create',
      'review.draft-publish',
      'review.submit',
    ] as const) {
      expect(def(action).group).toBe('comment')
    }
  })
})

describe('RFC-304 T19 — GitLab: drafts then bulk publish', () => {
  test('draft-create posts one draft note', () => {
    const binding = def('review.draft-create').bindings.gitlab
    expect('unsupported' in binding).toBe(false)
    if ('unsupported' in binding) return
    expect(binding.method).toBe('POST')
    expect(binding.path).toContain('/draft_notes')
    // GitLab's draft note field is `note`, not `body` — the platform's own
    // field name is normalized, the API's is not.
    expect(binding.body?.map((b) => b.api)).toContain('note')
    expect(binding.body?.map((b) => b.api)).toContain('position')
  })

  test('draft-publish is a bodyless bulk call', () => {
    const binding = def('review.draft-publish').bindings.gitlab
    if ('unsupported' in binding) throw new Error('gitlab must support bulk publish')
    expect(binding.path).toContain('bulk_publish')
    // Everything to publish was already staged by the draft calls; sending a
    // body here would imply a second source of truth for what goes out.
    expect(binding.body).toEqual([])
  })

  test('GitLab does NOT support single-request submit, and says why', () => {
    // Faking a mapping here would silently post only the overview and drop
    // every line comment — the worst kind of "supported".
    const binding = def('review.submit').bindings.gitlab
    expect('unsupported' in binding && binding.unsupported).toBe(true)
    expect('unsupported' in binding && binding.reasonKey).toBe('useDraftNotes')
  })
})

describe('RFC-304 T19 — GitHub: one request, no drafts', () => {
  test('submit carries the overview AND the line comments in one call', () => {
    const binding = def('review.submit').bindings.github
    if ('unsupported' in binding) throw new Error('github must support submit')
    expect(binding.method).toBe('POST')
    expect(binding.path).toContain('/pulls/{mr}/reviews')
    const apis = binding.body?.map((b) => b.api) ?? []
    // All three together is what makes the request atomic — the property the
    // whole GitHub path depends on.
    expect(apis).toContain('body')
    expect(apis).toContain('comments')
    expect(apis).toContain('event')
  })

  test('GitHub has no draft resource, and both draft actions say so', () => {
    for (const action of ['review.draft-create', 'review.draft-publish'] as const) {
      const binding = def(action).bindings.github
      expect('unsupported' in binding && binding.unsupported).toBe(true)
      expect('unsupported' in binding && binding.reasonKey).toBe('singleRequestReview')
    }
  })

  test('the review event defaults to comment-only, and is GitHub-only', () => {
    // Product boundary: the platform posts OPINIONS. Pressing approve on a
    // person's behalf is outside what it is allowed to do, so APPROVE exists
    // for custom flows but is never the default.
    const field = def('review.submit').fields.find((f) => f.name === 'review_event')
    expect(field?.options).toEqual(['COMMENT', 'APPROVE', 'REQUEST_CHANGES'])
    expect(field?.options?.[0]).toBe('COMMENT')
    expect(field?.requiredFor).toEqual([])
    expect(field?.onlyFor).toEqual(['github'])
  })
})

describe('RFC-304 T19 — the asymmetry is exactly complementary', () => {
  test('every review action is supported by exactly one host', () => {
    // This is the property that makes the trio correct: between them they cover
    // both hosts, and neither host is asked to fake a shape it lacks. If a
    // future change makes one action supported by both — or by neither — that
    // is a design change worth noticing, not a detail.
    for (const action of [
      'review.draft-create',
      'review.draft-publish',
      'review.submit',
    ] as const) {
      const { gitlab, github } = def(action).bindings
      const supported = [gitlab, github].filter((b) => !('unsupported' in b))
      expect(supported).toHaveLength(1)
    }
  })

  test('the two hosts each own one side of the split', () => {
    const gitlabOwns = (['review.draft-create', 'review.draft-publish'] as const).every(
      (a) => !('unsupported' in def(a).bindings.gitlab),
    )
    const githubOwns = !('unsupported' in def('review.submit').bindings.github)
    expect(gitlabOwns).toBe(true)
    expect(githubOwns).toBe(true)
  })
})
