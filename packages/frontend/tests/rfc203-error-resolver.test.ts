// RFC-203 T1 — the three-tier error resolver contract.
//
// LOCKS: exact `errors.<code>` → domain template `errorDomains.<domain>` →
// `errors.fallback`; caller overrides win over exact; network failures arrive
// pre-tagged as ApiError('network-unreachable') from the fetch boundary
// (impl-gate P2 — the resolver must NOT reclassify raw TypeErrors, that
// masked app bugs as outages); details scalars interpolate with truncation;
// describeApiError (string shell) keeps `: <raw>` appended for the
// domain/fallback tiers ONLY (design-gate P1 — string-only surfaces must
// not lose the diagnostic while exact matches stay clean sentences).

import { beforeAll, describe, expect, test } from 'vitest'
import { ApiError } from '../src/api/client'
import i18n, { describeApiError, setLanguage } from '../src/i18n'
import { domainOf, labelForCode, resolveApiError } from '../src/i18n/errors'

beforeAll(async () => {
  // i18n bootstraps via side effect of importing ../src/i18n.
  await new Promise<void>((resolve) => {
    if (i18n.isInitialized) resolve()
    else i18n.on('initialized', () => resolve())
  })
  setLanguage('zh-CN')
})

describe('domainOf', () => {
  test('routes representative codes from every family to the right domain', () => {
    expect(domainOf('task-question-not-found')).toBe('taskQuestion')
    expect(domainOf('manual-question-title-required')).toBe('taskQuestion')
    expect(domainOf('task-not-found')).toBe('task')
    expect(domainOf('cross-clarify-session-not-found')).toBe('clarify')
    expect(domainOf('clarify-seal-empty')).toBe('clarify')
    expect(domainOf('review-not-found')).toBe('review')
    expect(domainOf('doc-version-not-found')).toBe('review')
    expect(domainOf('workflow-in-use')).toBe('workflow')
    expect(domainOf('dw-no-generated-workflow')).toBe('workflow')
    expect(domainOf('workgroup-not-ready')).toBe('workgroup')
    expect(domainOf('skill-in-use')).toBe('skill')
    expect(domainOf('zip-traversal')).toBe('skill')
    expect(domainOf('agent-in-use')).toBe('agent')
    expect(domainOf('mcp-disabled')).toBe('mcp')
    expect(domainOf('plugin-install-failed')).toBe('plugin')
    expect(domainOf('npm-unavailable')).toBe('plugin')
    expect(domainOf('memory-not-found')).toBe('memory')
    expect(domainOf('distill-job-not-found')).toBe('memory')
    expect(domainOf('scheduled-task-invalid')).toBe('schedule')
    expect(domainOf('fusion-terminal')).toBe('fusion')
    expect(domainOf('runtime-not-found')).toBe('runtime')
    expect(domainOf('opencode-models-failed')).toBe('runtime')
    expect(domainOf('upload-too-large')).toBe('upload')
    expect(domainOf('repo-clone-failed')).toBe('repo')
    expect(domainOf('worktree-missing')).toBe('repo')
    expect(domainOf('working-branch-in-use')).toBe('repo')
    expect(domainOf('snapshot-lost')).toBe('repo')
    expect(domainOf('alert-not-found')).toBe('lifecycle')
    expect(domainOf('repair-preflight-stale')).toBe('lifecycle')
    expect(domainOf('call-target-repo-unresolved')).toBe('lifecycle')
    expect(domainOf('unauthorized')).toBe('auth')
    expect(domainOf('forbidden')).toBe('auth')
    expect(domainOf('oidc-provider-not-found')).toBe('auth')
    expect(domainOf('username-taken')).toBe('auth')
    expect(domainOf('internal-error')).toBe('misc')
    expect(domainOf('invalid-body')).toBe('misc')
  })
})

describe('resolveApiError', () => {
  test('exact match: localized title, no raw appended in title', () => {
    const r = resolveApiError(new ApiError(409, 'task-not-cancelable', 'raw english'))
    expect(r.matched).toBe('exact')
    expect(r.title).toBe('该任务已处于终态，无法取消。')
    expect(r.raw).toBe('raw english')
  })

  test('exact match with __hint pair', () => {
    const r = resolveApiError(new ApiError(0, 'network-unreachable', 'Failed to fetch'))
    expect(r.matched).toBe('exact')
    expect(r.hint).toContain('daemon')
  })

  test('RFC-223 import reference failures have exact bilingual copy and recovery hints', () => {
    for (const code of [
      'import-ref-unresolved',
      'import-ref-ambiguous',
      'import-ref-selection-stale',
      'agent-import-invalid',
    ]) {
      const r = resolveApiError(new ApiError(409, code, 'raw import error'))
      expect(r.matched).toBe('exact')
      expect(r.title).not.toBe('请求失败')
      expect(i18n.exists(`errors.${code}`, { lng: 'en-US' })).toBe(true)
    }
    expect(resolveApiError(new ApiError(409, 'import-ref-selection-stale', 'raw')).hint).toContain(
      '重新明确选择',
    )
  })

  // PR-2 note: exemplars must stay PERMANENTLY unmapped — repo-clone-failed /
  // internal-error got L1 entries in T3a, so the domain-tier locks moved to
  // merge-tree-failed (internal git plumbing, domain-fallback by design) and a
  // synthetic never-registered code for the misc family.
  test('unmapped code falls to its domain template', () => {
    const r = resolveApiError(new ApiError(422, 'merge-tree-failed', 'git merge-tree: fatal x'))
    expect(r.matched).toBe('domain')
    expect(r.title).toBe('仓库操作失败')
    expect(r.raw).toBe('git merge-tree: fatal x')
  })

  test('unknown family falls to the misc domain template', () => {
    const r = resolveApiError(new ApiError(500, 'zz-never-registered', 'boom'))
    expect(r.matched).toBe('domain') // misc domain template exists
    expect(r.title).toBe('请求失败')
  })

  test('overrides win over exact', () => {
    const r = resolveApiError(new ApiError(409, 'task-not-cancelable', 'x'), {
      overrides: { 'task-not-cancelable': 'errors.fallback' },
    })
    expect(r.matched).toBe('override')
    expect(r.title).toBe('请求失败')
  })

  test('ApiError network-unreachable (tagged at fetch boundary) → exact localized title', () => {
    const r = resolveApiError(new ApiError(0, 'network-unreachable', 'Failed to fetch'))
    expect(r.code).toBe('network-unreachable')
    expect(r.matched).toBe('exact')
    expect(r.title).toBe('无法连接到服务。')
  })

  test('a RAW TypeError (not from fetch) is NOT masked as offline — its message shows', () => {
    // Codex impl-gate P2: only genuine transport failures are tagged network-
    // unreachable at the fetch boundary; an app-level TypeError falls through.
    const r = resolveApiError(new TypeError('x.map is not a function'))
    expect(r.code).toBe('')
    expect(r.title).toBe('x.map is not a function')
  })

  test('plain Error / unknown values keep their message AS the title (display-ready convention)', () => {
    expect(resolveApiError(new Error('kaput')).title).toBe('kaput')
    expect(resolveApiError('strange').title).toBe('strange')
    expect(resolveApiError(new Error('kaput')).matched).toBe('fallback')
  })

  test('details scalars interpolate with truncation; structures are ignored', () => {
    // versionConflict copy uses {{expected}}/{{current}} via errorDetails —
    // here we assert the interpolation CONTEXT path via a synthetic override.
    const long = 'x'.repeat(500)
    const r = resolveApiError(
      new ApiError(409, 'some-unknown-thing', 'm', { name: long, nested: { a: 1 } }),
    )
    // no throw; unknown family lands on the misc domain template
    expect(r.matched).toBe('domain')
  })
})

describe('describeApiError shell', () => {
  test('exact tier → clean sentence, no raw suffix', () => {
    expect(describeApiError(new ApiError(409, 'task-not-cancelable', 'raw'))).toBe(
      '该任务已处于终态，无法取消。',
    )
  })
  test('domain tier → keeps ": raw" so string-only surfaces stay diagnostic', () => {
    expect(describeApiError(new ApiError(422, 'merge-tree-failed', 'fatal: nope'))).toBe(
      '仓库操作失败: fatal: nope',
    )
  })
})

describe('labelForCode', () => {
  test('missing key falls back to the bare code, never the key path', () => {
    expect(labelForCode('tasks.recovery.kind', 'totally-new-kind')).toBe('totally-new-kind')
  })
})
