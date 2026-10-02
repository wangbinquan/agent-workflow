import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  inspectOutgoingHistory,
  prepareRepositoryCommit,
  readRepositoryCommitPreview,
  type RepositoryGit,
} from '../src/modules/source-control/application/repositoryCommit'
import { runGit } from '../src/util/git'
import { bindRepositoryCommitParticipant } from '../src/modules/source-control/composition'
import { createFileRepositoryPreviewIndexPort } from '../src/modules/source-control/infrastructure/local/fileRepositoryPreviewIndex'

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
      previewIndex: createFileRepositoryPreviewIndexPort({ repoPath: repo }),
    })
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.diff).toContain('keep.txt')
    expect(preview.diff).not.toContain('tracked.tmp')

    const after = await runGit(repo, ['diff', '--cached', '--raw', '-z'])
    expect(after.stdout).toBe(before.stdout)
  })

  test('local preview preserves options, isolates the index and reclaims it after literal exclusion', async () => {
    const repo = await fixture()
    writeFileSync(join(repo, 'bracket[1].tmp'), 'base\n')
    await runGit(repo, ['add', '-A'])
    await runGit(repo, ['commit', '-q', '-m', 'bracket path'])
    writeFileSync(join(repo, 'bracket[1].tmp'), 'excluded\n')
    writeFileSync(join(repo, 'keep.txt'), 'included\n')
    await runGit(repo, ['add', 'bracket[1].tmp'])
    const before = await runGit(repo, ['diff', '--cached', '--raw', '-z'])
    const controller = new AbortController()
    const calls: Array<{ args: string[]; options: Parameters<RepositoryGit>[2] }> = []
    const liveIndexOverride = join(repo, 'unused-index')
    const selectedGit: RepositoryGit = (cwd, args, options) => {
      expect(cwd).toBe(repo)
      expect(existsSync(dirname(options!.env!.GIT_INDEX_FILE!))).toBe(true)
      calls.push({ args: [...args], options })
      return runGit(cwd, args, options)
    }
    const preview = await bindRepositoryCommitParticipant({
      repoPath: repo,
      configuredPatterns: ['*.tmp'],
      runGit: selectedGit,
      gitOptions: {
        env: {
          AW_RFC370_PREVIEW_MARKER: 'retained',
          GIT_INDEX_FILE: liveIndexOverride,
          GIT_LITERAL_PATHSPECS: '0',
        },
        signal: controller.signal,
        timeoutMs: 3_000,
      },
    }).preview()
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.diff).toContain('keep.txt')
    expect(preview.diff).not.toContain('bracket[1].tmp')
    expect(preview.receipt.excludedPaths).toEqual(['bracket[1].tmp'])
    const index = calls[0]!.options!.env!.GIT_INDEX_FILE!
    expect(index).not.toBe(liveIndexOverride)
    for (const call of calls) {
      expect(call.options!.env!.GIT_INDEX_FILE).toBe(index)
      expect(call.options!.env!.AW_RFC370_PREVIEW_MARKER).toBe('retained')
      expect(call.options!.signal).toBe(controller.signal)
      expect(call.options!.timeoutMs).toBe(3_000)
      expect(call.options!.env!.GIT_LITERAL_PATHSPECS).toBe(call.args[0] === 'reset' ? '1' : '0')
    }
    expect(existsSync(dirname(index))).toBe(false)
    expect(existsSync(liveIndexOverride)).toBe(false)
    const after = await runGit(repo, ['diff', '--cached', '--raw', '-z'])
    expect(after.stdout).toBe(before.stdout)
  }, 15_000)

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
