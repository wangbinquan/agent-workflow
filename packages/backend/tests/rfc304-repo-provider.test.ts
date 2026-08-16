// RFC-304 — deriving a repository's code host, and refusing to guess.
//
// Written after the GitHub e2e found that `PUT /api/code/matrix/:repoId`
// resolved its endpoint with a hardcoded `'gitlab'`: enabling ANY capability on
// a GitHub repository failed with "no enabled gitlab webhook endpoint is
// configured" — naming a provider the operator had never mentioned — and
// `gatherReadinessFacts` defaulted the same way, so even past that the cell
// reported `code-host-unconfigured` while its GitHub connection sat right there.
//
// The whole GitHub adapter was shipped, unit-tested and structurally unusable,
// because every unit test supplies the provider itself. Only an end-to-end run
// against a GitHub mock could show it.
//
// These cases pin the three answers this resolver is allowed to give, and in
// particular that "ambiguous" is a REFUSAL: keying a repository's findings to
// the wrong instance's ledger is silent, and surfaces only when somebody
// eventually asks why their merge request never got a review.

import { describe, expect, test } from 'bun:test'
import {
  resolveRepoProvider,
  type ConnectionCandidate,
} from '../src/modules/code-capability/domain/repoProvider'

const GITLAB: ConnectionCandidate = {
  provider: 'gitlab',
  baseUrl: 'https://gitlab.acme.com/api/v4',
  repositoryUrlPrefixes: [],
}
const GITHUB: ConnectionCandidate = {
  provider: 'github',
  baseUrl: 'https://api.github.com',
  repositoryUrlPrefixes: [],
}

describe('RFC-304 — which code host owns a repository', () => {
  test('the repository host decides when several hosts are configured', () => {
    // The case the hardcoded `'gitlab'` got wrong.
    expect(resolveRepoProvider('https://github.com/acme/app.git', [GITLAB, GITHUB])).toMatchObject({
      ok: true,
      provider: 'github',
      because: 'host-match',
    })

    expect(
      resolveRepoProvider('https://gitlab.acme.com/team/app.git', [GITLAB, GITHUB]),
    ).toMatchObject({ ok: true, provider: 'gitlab', because: 'host-match' })
  })

  test('api.github.com serves repositories that live on github.com', () => {
    // The one place the API host and the repository host legitimately differ.
    // Matching them literally would leave every github.com repository
    // unresolvable on a two-host deployment.
    expect(resolveRepoProvider('https://www.github.com/acme/app.git', [GITHUB])).toMatchObject({
      ok: true,
      provider: 'github',
    })
  })

  test('a self-hosted GitLab is matched by its configured repository prefixes', () => {
    // Vanity domains in front of an instance are ordinary. The prefixes exist
    // precisely so a repository URL that shares no host with the API root can
    // still be attributed.
    const vanity: ConnectionCandidate = {
      ...GITLAB,
      repositoryUrlPrefixes: ['https://code.acme.com/'],
    }
    expect(
      resolveRepoProvider('https://code.acme.com/team/app.git', [vanity, GITHUB]),
    ).toMatchObject({ ok: true, provider: 'gitlab' })
  })

  test('one configured host takes the repository however its URL is spelled', () => {
    // The overwhelmingly common deployment. An SSH alias, a mirror, or a
    // pull-through cache all produce URLs that match nothing; refusing there
    // would block the ordinary case to guard against a setup nobody has.
    expect(resolveRepoProvider('ssh://git@mirror.internal/team/app.git', [GITLAB])).toMatchObject({
      ok: true,
      provider: 'gitlab',
      because: 'only-connection',
    })
    expect(resolveRepoProvider(null, [GITHUB])).toMatchObject({
      ok: true,
      provider: 'github',
      because: 'only-connection',
    })
  })

  test('an unmatched repository on a MULTI-host deployment is refused, not guessed', () => {
    // The load-bearing refusal. With two hosts configured and no match, picking
    // either one keys the findings to an instance the repository does not live
    // on — and nothing errors, so it is discovered by absence.
    const verdict = resolveRepoProvider('ssh://git@elsewhere.invalid/team/app.git', [
      GITLAB,
      GITHUB,
    ])
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.message).toContain('does not match')
  })

  test('a host claimed by two connections is refused', () => {
    // Two instances behind one hostname is a misconfiguration, but a silent
    // wrong answer is worse than a loud refusal that names the ambiguity.
    const twin: ConnectionCandidate = {
      ...GITHUB,
      provider: 'gitlab',
      baseUrl: 'https://github.com/api/v4',
    }
    const verdict = resolveRepoProvider('https://github.com/acme/app.git', [GITHUB, twin])
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.message).toContain('matches 2')
  })

  test('no configured host at all says so, rather than blaming the repository', () => {
    const verdict = resolveRepoProvider('https://github.com/acme/app.git', [])
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.message).toContain('no code-host connection')
  })

  test('an unparsable repository URL still resolves on a single-host deployment', () => {
    // Garbage in the URL column must not make a working deployment unusable.
    expect(resolveRepoProvider('not a url', [GITLAB])).toMatchObject({
      ok: true,
      provider: 'gitlab',
    })
  })
})
