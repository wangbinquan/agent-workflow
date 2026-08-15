// RFC-304 T24b — placing a fork's CI event, and T31's opt-in bot-MR skip.
//
// ## Why a CI event needs placing at all
//
// A pipeline event from a FORK does not carry the merge request. GitHub's
// `pull_requests[]` arrives empty because the pipeline ran in the fork's own
// repository; GitLab's pipeline hook carries the fork's project. The only
// reliable link is the commit, so the mapping runs backwards: head sha → open
// merge request.
//
// ## Why only a unique match may wake
//
// One commit can head several open MRs — a shared branch, or a stack of chained
// MRs. Reviewing on a guess means posting a review on somebody else's merge
// request, in their name, for a change they did not submit. Not reacting to a
// CI event is a missing feature; reacting on the wrong MR is the platform doing
// something nobody asked for.
//
// ## Why the bot skip is opt-in
//
// The user's decision E2 (design §11.1) is that bot-authored MRs are supervised
// BY DEFAULT — a machine's code is not more trustworthy than a person's. So the
// switch exists for teams whose bots open MRs a review has nothing useful to say
// about, and it takes two deliberate steps: turn it on AND name the accounts.

import { describe, expect, test } from 'bun:test'
import {
  botAuthorsOf,
  judgeWake,
  resolveCiEventMr,
  skipsBotAuthoredMr,
  type WakeableCell,
} from '../src/modules/code-capability/domain/capabilityWake'
import { lookupCiEventMr, parseOpenMrs } from '../src/services/codeCiEventTarget'
import type {
  CodeHostPort,
  CodeHostResult,
} from '../src/modules/code-capability/ports/codeHostPort'

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('RFC-304 — mapping a commit to an open merge request', () => {
  test('exactly one match is placed', async () => {
    expect(resolveCiEventMr([{ mrIid: '412', headSha: HEAD }], HEAD)).toEqual({
      kind: 'unique',
      mrIid: '412',
    })
  })

  test('no match is "none", not an error', async () => {
    // A branch build, a closed MR, or a pipeline for a commit nobody proposed.
    expect(resolveCiEventMr([{ mrIid: '412', headSha: OTHER }], HEAD)).toEqual({ kind: 'none' })
  })

  test('SEVERAL matches refuse to guess', async () => {
    // The case that matters. A shared branch or a stack of chained MRs puts one
    // commit at the head of more than one; picking one reviews a merge request
    // whose author triggered nothing.
    const verdict = resolveCiEventMr(
      [
        { mrIid: '412', headSha: HEAD },
        { mrIid: '77', headSha: HEAD },
      ],
      HEAD,
    )
    expect(verdict.kind).toBe('ambiguous')
    expect(verdict.kind === 'ambiguous' && verdict.mrIids).toEqual(['412', '77'])
  })

  test('an empty commit matches nothing', async () => {
    // Otherwise a payload with no sha would match every MR whose sha failed to
    // parse, which is the worst possible way to pick one.
    expect(resolveCiEventMr([{ mrIid: '412', headSha: '' }], '')).toEqual({ kind: 'none' })
  })
})

describe('RFC-304 — reading each host’s open merge requests', () => {
  test('GitLab reports the head at `sha`', async () => {
    expect(parseOpenMrs('gitlab', JSON.stringify([{ iid: 412, sha: HEAD }]))).toEqual([
      { mrIid: '412', headSha: HEAD },
    ])
  })

  test('GitHub nests it under `head.sha`', async () => {
    // Reading GitLab's shape on GitHub yields no matches at all — which looks
    // exactly like "this commit belongs to no open MR". A silent no-op, not an
    // error, which is why both shapes are pinned.
    expect(parseOpenMrs('github', JSON.stringify([{ number: 412, head: { sha: HEAD } }]))).toEqual([
      { mrIid: '412', headSha: HEAD },
    ])
  })

  test('an entry missing its head is skipped rather than matched as empty', async () => {
    expect(parseOpenMrs('gitlab', JSON.stringify([{ iid: 412 }]))).toEqual([])
  })

  test('an unreadable body yields nothing', async () => {
    expect(parseOpenMrs('gitlab', 'not json')).toEqual([])
  })
})

describe('RFC-304 — the lookup against a host', () => {
  const host = (result: CodeHostResult): CodeHostPort => ({
    async call() {
      return result
    },
  })
  const ok = (body: unknown): CodeHostResult => ({
    ok: true,
    status: 200,
    body: JSON.stringify(body),
    truncated: false,
  })
  const target = {
    provider: 'gitlab' as const,
    stableProjectId: '41823',
    meta: { repoPath: 'group/project' },
  }

  test('places the event when one open MR heads the commit', async () => {
    const out = await lookupCiEventMr({
      codeHost: host(ok([{ iid: 412, sha: HEAD }])),
      target,
      headSha: HEAD,
    })
    expect(out.ok && out.target).toEqual({ kind: 'unique', mrIid: '412' })
  })

  test('a host that cannot be read is a FAILED lookup, not "none"', async () => {
    // "We could not look" and "there is nothing there" lead to different
    // actions; collapsing them would silently drop CI events during an outage.
    const out = await lookupCiEventMr({
      codeHost: host({ ok: false, code: 'code-host-forbidden', message: 'no' }),
      target,
      headSha: HEAD,
    })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.message).toContain('could not list open merge requests')
  })

  test('only OPEN merge requests are considered', async () => {
    // A closed MR's head still matches its commit forever; reviewing it would
    // comment on a merge request nobody is looking at.
    const calls: Array<Record<string, string>> = []
    const spy: CodeHostPort = {
      async call(call) {
        calls.push({ ...call.params })
        return ok([])
      },
    }
    await lookupCiEventMr({ codeHost: spy, target, headSha: HEAD })
    expect(calls[0]?.mr_state).toBe('open')
  })

  test('the scan is bounded', async () => {
    const calls: Array<Record<string, string>> = []
    const spy: CodeHostPort = {
      async call(call) {
        calls.push({ ...call.params })
        return ok([])
      },
    }
    await lookupCiEventMr({ codeHost: spy, target, headSha: HEAD })
    expect(Number(calls[0]?.per_page)).toBeGreaterThan(0)
    expect(Number.isFinite(Number(calls[0]?.per_page))).toBe(true)
  })
})

describe('RFC-304 — bot-authored merge requests are reviewed by default (E2)', () => {
  const cell = (triggerConfig: Record<string, unknown> = {}): WakeableCell => ({
    capability: 'mr-review',
    enabled: true,
    readiness: 'ready',
    triggerConfig,
  })
  const event = { eventType: 'mr_opened', mrIid: '412', authorUsername: 'renovate' }

  test('a machine’s MR is reviewed when nothing is configured', async () => {
    // The recorded product decision. A machine's code is not more trustworthy
    // than a person's, and defaulting this off would quietly stop reviewing a
    // whole class of change.
    expect(judgeWake(cell(), event)).toEqual({ wake: true })
  })

  test('turning the switch on alone does NOT skip anything', async () => {
    // Two deliberate steps. A team that flips a switch without naming accounts
    // has not told the platform which author is a machine, and guessing from a
    // username would stop reviewing a person called `alice-bot`.
    expect(judgeWake(cell({ skipBotAuthoredMr: true }), event)).toEqual({ wake: true })
  })

  test('naming the account alone does not either', async () => {
    expect(judgeWake(cell({ botAuthors: ['renovate'] }), event)).toEqual({ wake: true })
  })

  test('both together skip it, by name', async () => {
    expect(judgeWake(cell({ skipBotAuthoredMr: true, botAuthors: ['renovate'] }), event)).toEqual({
      wake: false,
      reason: 'bot-authored-mr',
    })
  })

  test('a human is still reviewed on a cell that skips bots', async () => {
    expect(
      judgeWake(cell({ skipBotAuthoredMr: true, botAuthors: ['renovate'] }), {
        ...event,
        authorUsername: 'a-human',
      }),
    ).toEqual({ wake: true })
  })

  test('the configured accounts are read as a list of names', async () => {
    expect(botAuthorsOf(cell({ botAuthors: ['renovate', '', 42] }))).toEqual(['renovate'])
    expect(skipsBotAuthoredMr(cell({ skipBotAuthoredMr: 'yes' }))).toBe(false)
  })
})
