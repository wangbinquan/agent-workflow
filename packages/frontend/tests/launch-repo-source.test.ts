// RFC-024 T6 — pure-function tests for the launcher's repo-source helpers.
// Locks `buildLaunchBody` body shape, `validateRepoUrl` outcomes, and the
// source-level wiring in tasks.new.tsx (the wizard) + RepoSourceRow.
//
// RFC-165: the local-path mode is retired — RepoSource is URL-only and the
// path-mode fixtures were deleted with it. The "RFC-165 retirement" describe
// below locks the absence of the old path plumbing in RepoSourceRow.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { CachedRepo } from '@agent-workflow/shared'
import {
  buildLaunchBody,
  resolveUrlRepoPath,
  validateRepoUrl,
  type RepoSource,
} from '@/lib/launch-repo-source'
import { buildWorkflowStartFormData } from '@/lib/task-wizard'

describe('buildLaunchBody (RFC-024)', () => {
  test('emits workflowId/repoUrl/inputs (no baseBranch, no ref when blank)', () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@github.com:foo/bar.git', ref: '' }
    const body = buildLaunchBody(src, { workflowId: 'wf-1', name: 'fixture-task', inputs: {} })
    expect(body).toEqual({
      workflowId: 'wf-1',
      name: 'fixture-task',
      repoUrl: 'git@github.com:foo/bar.git',
      inputs: {},
    })
    expect('baseBranch' in body).toBe(false)
    expect('ref' in body).toBe(false)
  })

  test('keeps non-empty ref (trimmed)', () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@h:o/r.git', ref: '  feature/x  ' }
    const body = buildLaunchBody(src, { workflowId: 'wf-1', name: 'fixture-task', inputs: {} })
    expect(body.ref).toBe('feature/x')
  })

  test('RFC-165: body never carries the retired path-mode keys', () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@h:o/r.git', ref: 'main' }
    const body = buildLaunchBody(src, { workflowId: 'wf-1', name: 't', inputs: {} })
    expect('repoPath' in body).toBe(false)
    expect('fetchBeforeLaunch' in body).toBe(false)
  })
})

describe('validateRepoUrl (RFC-024)', () => {
  test('empty → empty', () => {
    expect(validateRepoUrl('')).toBe('empty')
    expect(validateRepoUrl('   ')).toBe('empty')
  })

  test('plausible SSH / HTTPS → null', () => {
    expect(validateRepoUrl('git@github.com:foo/bar.git')).toBeNull()
    expect(validateRepoUrl('https://github.com/foo/bar.git')).toBeNull()
    expect(validateRepoUrl('ssh://git@host/x/y')).toBeNull()
  })

  test('malformed → invalid', () => {
    expect(validateRepoUrl('/some/path')).toBe('invalid')
    expect(validateRepoUrl('not a url')).toBe('invalid')
  })
})

describe('buildWorkflowStartFormData (RFC-024 → RFC-165)', () => {
  test('embeds JSON payload for URL mode + files for each upload key', async () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@h:o/r.git', ref: '' }
    const f1 = new File(['hello'], 'a.txt', { type: 'text/plain' })
    const f2 = new File(['world'], 'b.txt', { type: 'text/plain' })
    const fd = buildWorkflowStartFormData(
      { kind: 'remote', repos: [src] },
      { workflowId: 'wf-1', name: 'fixture-task', inputs: { topic: 'orders' } },
      { docs: [f1, f2] },
    )
    // payload field is a Blob with the JSON body.
    const payloadBlob = fd.get('payload') as Blob
    expect(payloadBlob).toBeInstanceOf(Blob)
    const txt = await payloadBlob.text()
    const parsed = JSON.parse(txt)
    expect(parsed.repoUrl).toBe('git@h:o/r.git')
    expect('repoPath' in parsed).toBe(false)
    // Files appear under files[<key>][].
    const files = fd.getAll('files[docs][]')
    expect(files.length).toBe(2)
  })
})

describe('tasks.new.tsx wiring (RFC-024 source-level)', () => {
  const SRC = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.new.tsx'),
    'utf-8',
  )

  test('imports RepoSourceList (RFC-066: multi-repo container)', () => {
    expect(SRC).toContain('RepoSourceList')
  })

  test('uses the wizard body builders (not an inline payload)', () => {
    expect(SRC).toContain('buildWorkflowStartBody')
    // The legacy inline `payload = { workflowId: id, repoPath, baseBranch, inputs }` block is gone.
    expect(SRC).not.toMatch(/payload = \{ workflowId: id, repoPath, baseBranch, inputs \}/)
  })

  test('canSubmit gate validates every row via validateRepoUrl', () => {
    expect(SRC).toContain('validateRepoUrl')
  })

  test('renders the cloning hint while POST is pending', () => {
    expect(SRC).toContain('launch.repoSource.cloningHint')
    expect(SRC).toContain('data-testid="wizard-cloning-hint"')
  })
})

// -----------------------------------------------------------------------------
// RFC-165 — path-mode retirement locks for the row component. The RFC-068
// fetch-before-launch switch, the localStorage pref and the recent-repos
// picker all left with the path tab; only the URL auto-sync hint survives.
// -----------------------------------------------------------------------------

describe('RepoSourceRow RFC-165 retirement (source-level)', () => {
  const SRC = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'components', 'launch', 'RepoSourceRow.tsx'),
    'utf-8',
  )

  test('renders URL-mode auto-sync hint', () => {
    expect(SRC).toContain('launch.repoSource.urlAutoSync')
  })

  test('the RFC-068 path-fetch switch + pref are gone', () => {
    expect(SRC).not.toContain('launch.pathFetch')
    expect(SRC).not.toContain('agent-workflow.launcher.pathFetch')
    expect(SRC).not.toContain('fetchBeforeLaunch')
  })

  test('the recent-repos picker + path/url TabBar are gone', () => {
    expect(SRC).not.toContain('repos/recent')
    expect(SRC).not.toContain('<TabBar')
    expect(SRC).not.toContain('repoPath')
  })
})

// -----------------------------------------------------------------------------
// RFC-110 — resolveUrlRepoPath: pickers enumerate the matched cached clone;
// cross-protocol / miss / unparseable → '' (text fallback upstream).
// -----------------------------------------------------------------------------

function cachedRepo(url: string, localPath: string): CachedRepo {
  return {
    id: `id-${localPath}`,
    url,
    urlRedacted: url,
    localPath,
    defaultBranch: 'main',
    lastFetchedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    referencingTaskCount: 0,
    hasSubmodules: null,
    lastSubmoduleSyncOk: null,
    lastSubmoduleSyncError: null,
  }
}

describe('resolveUrlRepoPath (RFC-110)', () => {
  test('hit → cached localPath, robust to .git / trailing slash', () => {
    const list = [cachedRepo('https://github.com/foo/bar.git', '/cache/bar')]
    expect(
      resolveUrlRepoPath({ kind: 'url', repoUrl: 'https://github.com/foo/bar', ref: '' }, list),
    ).toBe('/cache/bar')
    expect(
      resolveUrlRepoPath({ kind: 'url', repoUrl: 'https://github.com/foo/bar/', ref: '' }, list),
    ).toBe('/cache/bar')
    expect(
      resolveUrlRepoPath(
        { kind: 'url', repoUrl: 'https://user:tok@github.com/foo/bar.git', ref: '' },
        list,
      ),
    ).toBe('/cache/bar')
  })

  test('cross-protocol → no match (SSH cache, HTTPS typed)', () => {
    const list = [cachedRepo('git@github.com:foo/bar.git', '/cache/ssh')]
    expect(
      resolveUrlRepoPath({ kind: 'url', repoUrl: 'https://github.com/foo/bar', ref: '' }, list),
    ).toBe('')
  })

  test('miss / unparseable / empty cache → ""', () => {
    const list = [cachedRepo('https://github.com/foo/bar', '/cache/bar')]
    expect(
      resolveUrlRepoPath({ kind: 'url', repoUrl: 'https://github.com/foo/other', ref: '' }, list),
    ).toBe('')
    expect(resolveUrlRepoPath({ kind: 'url', repoUrl: 'not a url', ref: '' }, list)).toBe('')
    expect(
      resolveUrlRepoPath({ kind: 'url', repoUrl: 'https://github.com/foo/bar', ref: '' }, []),
    ).toBe('')
  })
})

describe('tasks.new.tsx wiring (RFC-110 source-level)', () => {
  const SRC = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.new.tsx'),
    'utf-8',
  )

  test('resolves the picker repoPath via resolveUrlRepoPath (not a hardcode)', () => {
    expect(SRC).toContain('resolveUrlRepoPath')
  })

  test('threads sourceKind into the dynamic input so pickers can fall back', () => {
    expect(SRC).toContain('sourceKind="url"')
  })

  test('queries cached-repos so pickers can resolve a localPath', () => {
    expect(SRC).toContain("queryKey: ['cached-repos']")
  })
})
