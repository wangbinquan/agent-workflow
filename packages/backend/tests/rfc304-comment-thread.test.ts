// RFC-304 §6.2 `collect-thread` — reading a reviewer's point out of a thread.
//
// Two hosts, two genuinely different shapes, and the differences are not
// cosmetic: GitLab returns discussions with a `notes[]` array and the position
// on the first note; GitHub returns a flat list where a "thread" is whatever
// chains back to a root comment through `in_reply_to_id`. A parser that handled
// one and half-handled the other would produce a plausible-looking thread with
// the replies missing — and an agent handed only the first message answers a
// question the reviewer already refined twice.
//
// The anchor matters as much as the messages. "What line is this about" is the
// single most useful fact the agent gets, and getting it wrong points the fix
// at the wrong code.

import { describe, expect, test } from 'bun:test'
import {
  parseThread,
  renderThreadForPrompt,
} from '../src/modules/code-capability/domain/commentThread'

const gitlabListing = JSON.stringify([
  {
    id: 'disc-other',
    notes: [{ id: 1, body: 'unrelated', author: { username: 'zoe' } }],
  },
  {
    id: 'disc-1',
    notes: [
      {
        id: 10,
        body: 'this allocates on every call',
        author: { username: 'ann' },
        created_at: '2026-08-01T10:00:00Z',
        position: { new_path: 'src/a.ts', new_line: '42', old_path: 'src/a.ts' },
      },
      {
        id: 11,
        body: 'actually just hoist it',
        author: { username: 'ann' },
        created_at: '2026-08-01T10:05:00Z',
      },
      { id: 12, body: 'changed the description', system: true, author: { username: 'ann' } },
    ],
  },
])

const githubListing = JSON.stringify([
  { id: 900, body: 'unrelated', user: { login: 'zoe' }, path: 'src/z.ts', line: 1 },
  {
    id: 500,
    body: 'this allocates on every call',
    user: { login: 'ann' },
    path: 'src/a.ts',
    line: 42,
    created_at: '2026-08-01T10:00:00Z',
  },
  {
    id: 501,
    in_reply_to_id: 500,
    body: 'actually just hoist it',
    user: { login: 'ann' },
    path: 'src/a.ts',
    line: 42,
  },
])

describe('RFC-304 — collecting a GitLab discussion', () => {
  test('every human note in the thread is collected, in order', () => {
    // The reply chain IS the point. "Just hoist it" alone tells the agent
    // nothing about what `it` is.
    const out = parseThread('gitlab', gitlabListing, 'disc-1')

    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error(out.reason)
    expect(out.thread.messages.map((m) => m.body)).toEqual([
      'this allocates on every call',
      'actually just hoist it',
    ])
  })

  test('system notes are dropped', () => {
    // "changed the description", "added 1 commit" — bookkeeping that buries the
    // human's actual point when it reaches the prompt.
    const out = parseThread('gitlab', gitlabListing, 'disc-1')
    expect(out.ok && out.thread.messages.some((m) => m.body.includes('description'))).toBe(false)
  })

  test('the anchor comes from the first note that has a position', () => {
    const out = parseThread('gitlab', gitlabListing, 'disc-1')
    expect(out.ok && out.anchor).toEqual({ path: 'src/a.ts', line: 42 })
  })

  test('another discussion in the same listing is not collected', () => {
    const out = parseThread('gitlab', gitlabListing, 'disc-1')
    expect(out.ok && out.thread.messages.some((m) => m.body === 'unrelated')).toBe(false)
  })

  test('a missing discussion is reported, not empty', () => {
    // An empty thread would reach the agent as "fix this: (nothing)".
    const out = parseThread('gitlab', gitlabListing, 'disc-nope')
    expect(out.ok).toBe(false)
    expect(!out.ok && out.reason).toContain('disc-nope')
  })
})

describe('RFC-304 — collecting a GitHub review thread', () => {
  test('the root and its replies are collected; other comments are not', () => {
    const out = parseThread('github', githubListing, '500')

    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error(out.reason)
    expect(out.thread.messages.map((m) => m.body)).toEqual([
      'this allocates on every call',
      'actually just hoist it',
    ])
    expect(out.anchor).toEqual({ path: 'src/a.ts', line: 42 })
  })

  test('the author reads from `user.login`, not `author.username`', () => {
    // The two hosts name the same field differently. Reading the wrong one
    // gives every message the author "unknown", which the agent then quotes.
    const out = parseThread('github', githubListing, '500')
    expect(out.ok && out.thread.messages[0]?.author).toBe('ann')
  })

  test('a comment with no usable line anchors to the file alone', () => {
    // Null rather than NaN: NaN reaches the prompt as "line NaN" and the agent
    // tries to reason about it.
    const listing = JSON.stringify([
      { id: 700, body: 'outdated remark', user: { login: 'ann' }, path: 'src/a.ts', line: null },
    ])
    const out = parseThread('github', listing, '700')
    expect(out.ok && out.anchor).toEqual({ path: 'src/a.ts', line: null })
  })

  test('a missing comment is reported', () => {
    expect(parseThread('github', githubListing, '404').ok).toBe(false)
  })
})

describe('RFC-304 — malformed listings', () => {
  test('a non-JSON body is reported rather than thrown', () => {
    const out = parseThread('gitlab', '<html>gateway timeout</html>', 'disc-1')
    expect(out.ok).toBe(false)
    expect(!out.ok && out.reason).toContain('not JSON')
  })

  test('a JSON object that is not a list is reported', () => {
    expect(parseThread('gitlab', '{"error":"forbidden"}', 'disc-1').ok).toBe(false)
  })
})

describe('RFC-304 — rendering the thread for the fixer', () => {
  test('the anchor is stated first, in plain words', () => {
    // The most useful fact the agent gets. Buried inside a serialised structure
    // it is easy to miss; stated first it frames everything after it.
    const out = parseThread('gitlab', gitlabListing, 'disc-1')
    if (!out.ok) throw new Error(out.reason)
    const rendered = renderThreadForPrompt(out.thread, out.anchor)

    expect(rendered.startsWith('This discussion is about `src/a.ts` line 42.')).toBe(true)
    expect(rendered).toContain('ann:')
    expect(rendered).toContain('actually just hoist it')
  })

  test('an MR-level thread says so rather than inventing a location', () => {
    const rendered = renderThreadForPrompt(
      {
        threadId: 't',
        messages: [{ author: 'ann', body: 'rebase please', noteId: null, createdAt: null }],
        resolved: false,
      },
      null,
    )
    expect(rendered).toContain('on the merge request as a whole')
  })

  test('a file-level thread with no line says the file', () => {
    const rendered = renderThreadForPrompt(
      {
        threadId: 't',
        messages: [{ author: 'ann', body: 'x', noteId: null, createdAt: null }],
        resolved: false,
      },
      { path: 'src/a.ts', line: null },
    )
    expect(rendered).toContain('about `src/a.ts`')
    expect(rendered).not.toContain('line')
  })
})
