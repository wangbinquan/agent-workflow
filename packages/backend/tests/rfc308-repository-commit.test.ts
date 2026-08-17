import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inspectOutgoingHistory,
  prepareRepositoryCommit,
  readRepositoryCommitPreview,
} from '../src/modules/source-control/application/repositoryCommit'
import { runGit } from '../src/util/git'
import { bindRepositoryCommitParticipant } from '../src/modules/source-control/composition'

const roots: string[] = []

async function fixture(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'aw-rfc308-commit-'))
  roots.push(repo)
  await runGit(repo, ['init', '-q', '-b', 'main'])
  await runGit(repo, ['config', 'user.name', 'RFC308'])
  await runGit(repo, ['config', 'user.email', 'rfc308@example.test'])
  writeFileSync(join(repo, 'keep.txt'), 'base\n')
  writeFileSync(join(repo, 'old.txt'), 'old\n')
  writeFileSync(join(repo, 'tracked.tmp'), 'base\n')
  await runGit(repo, ['add', '-A'])
  await runGit(repo, ['commit', '-q', '-m', 'base'])
  return repo
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-308 shared repository commit engine', () => {
  test('strictly removes tracked, untracked, hard-root, newline, and whole rename groups', async () => {
    const repo = await fixture()
    writeFileSync(join(repo, 'keep.txt'), 'changed\n')
    writeFileSync(join(repo, 'tracked.tmp'), 'secret\n')
    await runGit(repo, ['mv', 'old.txt', 'renamed.trace'])
    writeFileSync(join(repo, 'line\nbreak.trace'), 'odd\n')
    mkdirSync(join(repo, '.agent-workflow', 'runs'), { recursive: true })
    writeFileSync(join(repo, '.agent-workflow', 'runs', 'result.json'), '{}\n')

    const prepared = await prepareRepositoryCommit({
      repoPath: repo,
      configuredPatterns: ['tracked.tmp', '*.trace', '!keep.trace', '!/.agent-workflow/**'],
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.receipt.excludedPaths).toEqual([
      '.agent-workflow/runs/result.json',
      'line\nbreak.trace',
      'old.txt',
      'renamed.trace',
      'tracked.tmp',
    ])

    const staged = await runGit(repo, ['diff', '--cached', '--name-only', '-z'])
    expect(staged.stdout.split('\0').filter(Boolean)).toEqual(['keep.txt'])
    const status = await runGit(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    expect(status.stdout).toContain('tracked.tmp')
    expect(status.stdout).toContain('.agent-workflow/runs/result.json')
  })

  test('preview uses the same selection and leaves the live index byte-equivalent', async () => {
    const repo = await fixture()
    writeFileSync(join(repo, 'keep.txt'), 'visible\n')
    writeFileSync(join(repo, 'tracked.tmp'), 'hidden\n')
    await runGit(repo, ['add', 'tracked.tmp'])
    const before = await runGit(repo, ['diff', '--cached', '--raw', '-z'])

    const preview = await readRepositoryCommitPreview({
      repoPath: repo,
      configuredPatterns: ['*.tmp'],
    })
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.diff).toContain('keep.txt')
    expect(preview.diff).not.toContain('tracked.tmp')

    const after = await runGit(repo, ['diff', '--cached', '--raw', '-z'])
    expect(after.stdout).toBe(before.stdout)
  })

  test('blocks an excluded path even when a later local commit removes it again', async () => {
    const repo = await fixture()
    const base = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()
    writeFileSync(join(repo, 'leak.trace'), 'secret\n')
    await runGit(repo, ['add', '-A'])
    await runGit(repo, ['commit', '-q', '-m', 'introduce leak'])
    await runGit(repo, ['rm', '-q', 'leak.trace'])
    await runGit(repo, ['commit', '-q', '-m', 'remove leak'])
    const tip = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()

    const result = await inspectOutgoingHistory({
      repoPath: repo,
      baseSha: base,
      tipSha: tip,
      configuredPatterns: ['*.trace'],
    })
    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'excluded-history') {
      expect(result.excludedPaths).toEqual(['leak.trace'])
    }
  })

  test('bound path classification honors the repository core.ignoreCase policy', async () => {
    const repo = await fixture()
    await runGit(repo, ['config', 'core.ignoreCase', 'true'])
    const classified = await bindRepositoryCommitParticipant({
      repoPath: repo,
      configuredPatterns: ['/VENDOR/'],
    }).classifyPath({ path: 'vendor', directory: true })
    expect(classified.excluded).toBe(true)
  })
})
