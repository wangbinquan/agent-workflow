// RFC-304 §6 — `resolve-target`, the first stage of every capability.
//
// Every failure mode here is "silently reviewed the wrong thing", so the tests
// are mostly about REFUSING rather than about the happy path. A round that
// starts with a defaulted target runs all the way to publish and posts
// somewhere — which is strictly worse than one that refuses to start, because
// the author sees a comment that looks deliberate.
//
// The identity rule is the sharpest of these: the key uses the STABLE project
// id, never the repo path. A path is mutable — rename or transfer the project
// and the same MR hashes to a different work item, detaching its ledger, its
// dedup chain and its supersede relation (design §2.1). So `project_id` missing
// is a refusal, not a fallback to `repo_path`.

import { describe, expect, test } from 'bun:test'
import type { WebhookTriggerFields } from '@agent-workflow/shared'
import { resolveTarget, workItemKeyOf } from '../src/modules/code-capability/domain/resolveTarget'

// No `as` anywhere in this fixture: the cast is what lets a field drift out of
// the canonical set unnoticed. An earlier draft said `event_type: 'merge_request'`
// — not one of this platform's event types (they are `mr_opened` / `mr_updated`
// / …) — and only the cast kept the compiler quiet about it.
const webhook = (over: Partial<WebhookTriggerFields> = {}): WebhookTriggerFields => ({
  event_type: 'mr_opened',
  provider: 'gitlab',
  project_id: '41823',
  mr_iid: '412',
  commit_sha: 'abc123',
  target_branch: 'main',
  mr_title: 'Add retry logic',
  mr_url: 'https://gitlab.example/g/p/-/merge_requests/412',
  repo_path: 'group/project',
  ...over,
})

describe('RFC-304 — resolving a review target', () => {
  test('a complete trigger context yields the full target', () => {
    const r = resolveTarget(webhook(), 'ep_7')
    expect(r.ok).toBe(true)
    expect(r.ok && r.target).toMatchObject({
      provider: 'gitlab',
      codeHostEndpointId: 'ep_7',
      stableProjectId: '41823',
      anchorKind: 'mr',
      anchorId: '412',
      headSha: 'abc123',
      targetBranch: 'main',
    })
  })

  test('display data is kept separate from identity', () => {
    // Title, URL and path all change over an MR's life. Keeping them under
    // `meta` is what stops a later reader from reaching for `repoPath` when
    // they need an identity.
    const r = resolveTarget(webhook(), 'ep_7')
    expect(r.ok && r.target.meta).toEqual({
      title: 'Add retry logic',
      url: 'https://gitlab.example/g/p/-/merge_requests/412',
      repoPath: 'group/project',
    })
  })

  test('GitHub resolves the same way', () => {
    const r = resolveTarget(webhook({ provider: 'github' }), 'ep_9')
    expect(r.ok && r.target.provider).toBe('github')
  })
})

describe('RFC-304 — what it refuses, and why', () => {
  test('no stable project id ⇒ refuse, do NOT fall back to the repo path', () => {
    // The path is right there in the payload and would "work". It is also
    // mutable: after a rename the same MR becomes a different work item, and
    // its ledger, dedup chain and supersede relation all detach silently.
    const r = resolveTarget(webhook({ project_id: undefined }), 'ep_7')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.missing).toContain('project_id')
    expect(!r.ok && r.message).not.toContain('group/project')
  })

  test('no MR number ⇒ refuse; there is nothing to publish to', () => {
    const r = resolveTarget(webhook({ mr_iid: undefined }), 'ep_7')
    expect(!r.ok && r.missing).toContain('mr_iid')
  })

  test('no head sha ⇒ refuse; the round would have no baseline', () => {
    // Without it, `awaiting` cannot tell a new push from the one it is waiting
    // on, and guard 1 of the work-item machine stops working.
    const r = resolveTarget(webhook({ commit_sha: undefined }), 'ep_7')
    expect(!r.ok && r.missing).toContain('commit_sha')
  })

  test('an unconfigured code host ⇒ refuse', () => {
    const r = resolveTarget(webhook(), '')
    expect(!r.ok && r.missing).toContain('codeHostEndpointId')
  })

  test('an unknown provider ⇒ refuse rather than guessing gitlab', () => {
    // The trigger context types `provider` as a plain string, so an unexpected
    // value is a runtime possibility, not a type error to be cast away.
    const r = resolveTarget(webhook({ provider: 'bitbucket' }), 'ep_7')
    expect(!r.ok && r.missing).toContain('provider')
  })

  test('empty strings count as missing, not as values', () => {
    // A trigger template that expanded to nothing produces '' rather than
    // undefined; treating it as present would publish to MR number "".
    const r = resolveTarget(webhook({ mr_iid: '', project_id: '' }), 'ep_7')
    expect(!r.ok && r.missing).toEqual(expect.arrayContaining(['project_id', 'mr_iid']))
  })

  test('ALL missing fields are named at once', () => {
    // Fixing a trigger config one round-trip per field is how a first-time
    // setup takes an afternoon.
    const r = resolveTarget(
      webhook({
        provider: undefined,
        project_id: undefined,
        mr_iid: undefined,
        commit_sha: undefined,
      }),
      '',
    )
    expect(!r.ok && r.missing.length).toBeGreaterThanOrEqual(4)
    expect(!r.ok && r.message).toContain('project_id')
    expect(!r.ok && r.message).toContain('mr_iid')
  })

  test('optional display fields do not block resolution', () => {
    // A title or URL missing is cosmetic; refusing over it would block a review
    // that could run perfectly well.
    const r = resolveTarget(
      webhook({ mr_title: undefined, mr_url: undefined, repo_path: undefined }),
      'ep_7',
    )
    expect(r.ok).toBe(true)
    expect(r.ok && r.target.meta.title).toBeNull()
  })

  test('a missing target branch resolves to null, not a refusal', () => {
    const r = resolveTarget(webhook({ target_branch: undefined }), 'ep_7')
    expect(r.ok && r.target.targetBranch).toBeNull()
  })
})

describe('RFC-304 §2.1 — one construction site for the identity key', () => {
  test('the key is built from stable parts only', () => {
    const r = resolveTarget(webhook(), 'ep_7')
    expect(r.ok && workItemKeyOf(r.target, 'mr-review')).toEqual({
      codeHostEndpointId: 'ep_7',
      stableProjectId: '41823',
      capability: 'mr-review',
      anchorKind: 'mr',
      anchorId: '412',
    })
  })

  test('the mutable display snapshot never reaches the key', () => {
    // The whole point: two rounds on the same MR before and after a rename must
    // produce the SAME key.
    const before = resolveTarget(webhook({ repo_path: 'group/old-name' }), 'ep_7')
    const after = resolveTarget(webhook({ repo_path: 'group/new-name' }), 'ep_7')
    if (!before.ok || !after.ok) throw new Error('expected both to resolve')
    expect(workItemKeyOf(before.target, 'mr-review')).toEqual(
      workItemKeyOf(after.target, 'mr-review'),
    )
  })

  test('two capabilities on one MR get distinct keys', () => {
    // `mr-review` and `mr-monitor` are separate work items sharing an anchor —
    // that separation is what the capability component provides.
    const r = resolveTarget(webhook(), 'ep_7')
    if (!r.ok) throw new Error('expected a resolved target')
    expect(workItemKeyOf(r.target, 'mr-review')).not.toEqual(workItemKeyOf(r.target, 'mr-monitor'))
  })
})
