// RFC-611: an unrelated external outage must not block a source commit, while
// local references and changed-document external failures must remain visible.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import {
  checkDesignLinks,
  designLinkArguments,
  designLinkRange,
  designMarkdownPaths,
  selectDesignLinkFiles,
  type GitResult,
  type LinkCheckGit,
} from '../../../scripts/ci/check-design-links'

const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const payload = { before: base, after: head }
const docs = ['design/a.md', 'design/new name.md', 'design/unchanged.md']
const ok = (stdout = ''): GitResult => ({ status: 0, stdout, stderr: '' })
const failed: GitResult = { status: 1, stdout: '', stderr: 'unavailable' }

function repository(
  options: {
    files?: readonly string[]
    changed?: readonly string[]
    missing?: readonly string[]
    fetchFails?: boolean
    diffFails?: boolean
  } = {},
): { git: LinkCheckGit; calls: string[][] } {
  const available = new Set([base, head].filter((sha) => !options.missing?.includes(sha)))
  const calls: string[][] = []
  return {
    calls,
    git(args) {
      calls.push([...args])
      if (args[0] === 'ls-files') return ok((options.files ?? docs).join('\0') + '\0')
      if (args[0] === 'cat-file') return available.has(args[2]!.slice(0, 40)) ? ok() : failed
      if (args[0] === 'fetch') {
        if (options.fetchFails) return failed
        available.add(args[args.length - 1]!)
        return ok()
      }
      if (args[0] === 'diff')
        return options.diffFails
          ? failed
          : ok((options.changed ?? ['design/a.md']).join('\0') + '\0')
      throw new Error(`Unexpected Git call: ${JSON.stringify(args)}`)
    },
  }
}

describe('design link scope', () => {
  test('uses push endpoints and PR base/head commits rather than a branch or synthetic merge parent', () => {
    expect(designLinkRange('push', payload)).toEqual({ base, head })
    expect(
      designLinkRange('pull_request', {
        before: head,
        after: base,
        pull_request: { base: { sha: base }, head: { sha: head } },
      }),
    ).toEqual({ base, head })
    for (const event of [
      {},
      { before: '0'.repeat(40), after: head },
      { before: '--all', after: head },
    ])
      expect(designLinkRange('push', event)).toBeNull()
    expect(designLinkRange('workflow_dispatch', payload)).toBeNull()

    // RFC-627: explicit baseShaOverride uses event-specific immutable head commits,
    // never GitHub's synthetic pull_request merge commit (`headSha`).
    const overrideBase = 'c'.repeat(40)
    const syntheticMergeSha = 'd'.repeat(40)
    expect(
      designLinkRange('push', payload, {
        baseShaOverride: overrideBase,
        headSha: syntheticMergeSha,
      }),
    ).toEqual({ base: overrideBase, head })
    expect(designLinkRange('push', {}, { baseShaOverride: overrideBase, headSha: head })).toEqual({
      base: overrideBase,
      head,
    })
    expect(
      designLinkRange(
        'pull_request',
        { pull_request: { base: { sha: base }, head: { sha: head } } },
        { baseShaOverride: overrideBase, headSha: syntheticMergeSha },
      ),
    ).toEqual({ base: overrideBase, head })
    expect(
      designLinkRange('pull_request', {}, { baseShaOverride: overrideBase, headSha: head }),
    ).toBeNull()
    expect(
      designLinkRange('workflow_dispatch', {}, { baseShaOverride: overrideBase, headSha: head }),
    ).toEqual({ base: overrideBase, head })
    expect(
      designLinkRange('schedule', payload, { baseShaOverride: overrideBase, headSha: head }),
    ).toBeNull()
    for (const badOverride of ['not-a-sha', '0'.repeat(40), '--all', 'short']) {
      expect(() =>
        designLinkRange('push', payload, { baseShaOverride: badOverride, headSha: head }),
      ).toThrow('Invalid AW_DESIGN_LINKS_BASE_SHA')
    }
  })

  test('AW_DESIGN_LINKS_BASE_SHA=ALL forces a complete sweep without git diff, while valid SHA overrides compare from it', () => {
    const allRepo = repository()
    const allSelection = selectDesignLinkFiles({
      eventName: 'push',
      payload,
      baseShaOverride: 'ALL',
      headSha: head,
      git: allRepo.git,
    })
    expect(allSelection.files).toEqual(docs)
    expect(allSelection.reason).toContain('AW_DESIGN_LINKS_BASE_SHA=ALL')
    expect(allRepo.calls).toHaveLength(1)

    const overrideBase = 'c'.repeat(40)
    const prRepo = repository({ changed: ['design/a.md'] })
    const prSelection = selectDesignLinkFiles({
      eventName: 'pull_request',
      payload: { pull_request: { base: { sha: base }, head: { sha: head } } },
      baseShaOverride: overrideBase,
      headSha: 'd'.repeat(40),
      git: prRepo.git,
    })
    expect(prSelection.files).toEqual(['design/a.md'])
    expect(prRepo.calls).toContainEqual([
      'diff',
      '--name-only',
      '--find-renames',
      '--diff-filter=ACMRT',
      '-z',
      overrideBase,
      head,
      '--',
      'design',
    ])
  })

  test('checks surviving changed Markdown, including rename destinations, and excludes deletions and other scopes', () => {
    const repo = repository({
      changed: [
        'design/new name.md',
        'design/deleted.md',
        'docs/a.md',
        'design/file.ts',
        'design/a.md',
      ],
    })
    expect(selectDesignLinkFiles({ eventName: 'push', payload, git: repo.git }).files).toEqual([
      'design/a.md',
      'design/new name.md',
    ])
    expect(repo.calls).toContainEqual([
      'diff',
      '--name-only',
      '--find-renames',
      '--diff-filter=ACMRT',
      '-z',
      base,
      head,
      '--',
      'design',
    ])
  })

  test('a shallow checkout fetches only the missing immutable commit before comparison', () => {
    const repo = repository({ missing: [base] })
    expect(selectDesignLinkFiles({ eventName: 'push', payload, git: repo.git }).files).toEqual([
      'design/a.md',
    ])
    expect(repo.calls.filter((args) => args[0] === 'fetch')).toEqual([
      ['fetch', '--no-tags', '--depth=1', 'origin', base],
    ])
  })

  test('missing event bases, dispatch, inaccessible commits, and failed diffs conservatively check all docs', () => {
    for (const eventName of ['workflow_dispatch', 'schedule', 'unknown']) {
      const repo = repository()
      expect(selectDesignLinkFiles({ eventName, payload, git: repo.git }).files).toEqual(docs)
      expect(repo.calls).toHaveLength(1)
    }
    for (const options of [{ missing: [base], fetchFails: true }, { diffFails: true }]) {
      const repo = repository(options)
      expect(selectDesignLinkFiles({ eventName: 'push', payload, git: repo.git }).files).toEqual(
        docs,
      )
    }
    const repo = repository()
    expect(selectDesignLinkFiles({ eventName: 'push', payload: {}, git: repo.git }).files).toEqual(
      docs,
    )
    expect(
      selectDesignLinkFiles({ eventName: 'push', payload, git: repo.git, all: true }).files,
    ).toEqual(docs)
  })

  test('preserves shell syntax and newlines as literal filenames in separate argv entries', async () => {
    const special = "design/$(touch sentinel); 'quoted'\nfile.md"
    const repo = repository({ files: [special], changed: [special] })
    const commands: string[][] = []
    await checkDesignLinks({
      eventName: 'push',
      payload,
      repository: 'owner/repo',
      git: repo.git,
      run: async (args) => {
        commands.push([...args])
        return 0
      },
    })
    expect(commands).toHaveLength(1)
    expect(commands[0]!.slice(commands[0]!.indexOf('--') + 1)).toEqual([special])
    expect(designMarkdownPaths('design/a.md\0design/a.md\0design/../bad.md\0other.md\0')).toEqual([
      'design/a.md',
    ])
  })

  test('retains status, retry, timeout and evidence-link policies without accepting server errors', () => {
    expect(designLinkArguments('owner.name/repo', ['design/a.md'])).toEqual([
      '--no-progress',
      '--verbose',
      '--host-stats',
      '--max-concurrency',
      '4',
      '--accept',
      '200,206,403,429',
      '--max-retries',
      '5',
      '--retry-wait-time',
      '5',
      '--timeout',
      '30',
      '--exclude',
      '^https://github\\.com/owner\\.name/repo/actions/runs/',
      '--',
      'design/a.md',
    ])
    expect(() => designLinkArguments('owner/repo;touch bad', docs)).toThrow('owner/repository')
  })

  test('runs no external request for an unrelated commit, propagates link failure, and rejects absent input', async () => {
    const repo = repository({ changed: [] })
    let calls = 0
    const options = {
      eventName: 'push',
      payload,
      repository: 'owner/repo',
      git: repo.git,
      run: async () => {
        calls++
        return 2
      },
    }
    expect((await checkDesignLinks(options)).files).toEqual([])
    expect(calls).toBe(0)
    await expect(checkDesignLinks({ ...options, all: true })).rejects.toThrow('exit 2')
    expect(calls).toBe(1)
    expect(() => selectDesignLinkFiles({ eventName: 'push', payload, git: () => failed })).toThrow(
      'Cannot list',
    )
    expect(() =>
      selectDesignLinkFiles({ eventName: 'push', payload, git: repository({ files: [] }).git }),
    ).toThrow('No tracked')
  })
})

describe('design link workflow wiring', () => {
  test('main docs, docs-fast-gate and nightly all enforce local links and expected external link scopes', () => {
    const root = resolve(import.meta.dir, '../../..')
    const entry = parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'))
    const main = parse(readFileSync(resolve(root, '.github/workflows/ci-work.yml'), 'utf8'))
    const nightly = parse(
      readFileSync(resolve(root, '.github/workflows/design-links-nightly.yml'), 'utf8'),
    )
    for (const [job, all, expectedBaseEnv] of [
      [main.jobs.docs, false, '${{ inputs.links_base_sha }}'],
      [
        entry.jobs['docs-fast-gate'],
        false,
        "${{ needs['detect-changes'].outputs.links_base_sha }}",
      ],
      [nightly.jobs['design-links'], true, undefined],
    ] as const) {
      const localIndex = job.steps.findIndex(
        (step: { uses?: string }) => step.uses === 'lycheeverse/lychee-action@v2',
      )
      const local = job.steps[localIndex]
      expect(local.with).toMatchObject({
        lycheeVersion: 'v0.24.2',
        args: "--offline --no-progress --verbose 'design/**/*.md'",
        fail: true,
      })
      expect(local.if).toBeUndefined()
      const externalIndex = job.steps.findIndex(
        (step: { run?: string }) =>
          step.run === `bun scripts/ci/check-design-links.ts${all ? ' --all' : ''}`,
      )
      expect(externalIndex).toBeGreaterThan(localIndex)
      expect(job.steps[externalIndex].env.GITHUB_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}')
      if (expectedBaseEnv !== undefined) {
        expect(job.steps[externalIndex].env.AW_DESIGN_LINKS_BASE_SHA).toBe(expectedBaseEnv)
      }
      expect(job.steps[externalIndex]['continue-on-error']).toBeUndefined()
      expect(job['continue-on-error']).toBeUndefined()
    }
    expect(nightly.on.schedule).toEqual([{ cron: '17 10 * * *' }])
    expect(nightly.on).toHaveProperty('workflow_dispatch')
  })
})
