// CI workflow path-filter lock (RFC-451, 2026-11-05).
//
// Why this exists: a workflow's `on.push.paths` / `on.pull_request.paths` only fires when a changed file matches one
// of its entries, so an entry naming a file that no longer exists silently stops the workflow from running on the
// commits it was written to catch — nothing goes red, the suite just falls back to its cron. RFC-451 moved
// `services/gitRepoCache.ts` and `services/repoBatchImport.ts` into source-control while `git-protocols-e2e.yml`
// still listed the old paths, which would have decoupled the git protocol suite from every later change to the
// repository mirror cache (the same silent gap RFC-287 T14 hit when `task.ts` was missing from that list). Every
// literal entry must exist; every glob entry must keep an existing directory prefix.
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const WORKFLOWS = join(ROOT, '.github', 'workflows')
const TRIGGERS = ['push', 'pull_request', 'pull_request_target'] as const
const FILTERS = ['paths', 'paths-ignore'] as const
const GLOB = /[*?[]/

/** Every path-filter entry of every workflow trigger that names nothing in the repository. */
export function stalePathFilters(
  workflows: Readonly<Record<string, unknown>>,
  exists: (relativePath: string) => boolean,
): string[] {
  const stale: string[] = []
  for (const [file, workflow] of Object.entries(workflows)) {
    const on = (workflow as { on?: unknown }).on
    if (on === null || typeof on !== 'object' || Array.isArray(on)) continue
    for (const trigger of TRIGGERS) {
      const config = (on as Record<string, unknown>)[trigger]
      if (config === null || typeof config !== 'object') continue
      for (const filter of FILTERS) {
        const entries = (config as Record<string, unknown>)[filter]
        if (!Array.isArray(entries)) continue
        for (const raw of entries) {
          const entry = String(raw).replace(/^!/, '')
          const glob = GLOB.exec(entry)
          // A glob is checked through the directory in front of its first wildcard; a bare glob (`**.md`) names
          // no directory and is skipped.
          const target =
            glob === null ? entry : entry.slice(0, entry.lastIndexOf('/', glob.index) + 1)
          if (target !== '' && !exists(target))
            stale.push(`${file} on.${trigger}.${filter}: ${String(raw)}`)
        }
      }
    }
  }
  return stale
}

function loadWorkflows(): Record<string, unknown> {
  return Object.fromEntries(
    readdirSync(WORKFLOWS)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map((name) => [name, parse(readFileSync(join(WORKFLOWS, name), 'utf8')) as unknown]),
  )
}

describe('CI workflow path filters', () => {
  test('every path filter names a file or directory that exists', () => {
    expect(stalePathFilters(loadWorkflows(), (path) => existsSync(join(ROOT, path)))).toEqual([])
  })

  test('the git protocol suite re-runs when the repository mirror cache changes (RFC-451)', () => {
    const workflow = loadWorkflows()['git-protocols-e2e.yml'] as {
      readonly on: Record<string, { readonly paths?: readonly string[] }>
    }
    for (const trigger of ['push', 'pull_request']) {
      expect(workflow.on[trigger]?.paths ?? []).toEqual(
        expect.arrayContaining([
          'packages/backend/src/modules/source-control/infrastructure/local/repositoryMirrorCache.ts',
          'packages/backend/src/modules/source-control/infrastructure/local/repositoryBatchImport.ts',
          'packages/backend/src/platform/workspace/local/submoduleParams.ts',
        ]),
      )
    }
  })

  test('negative control: stale literals, negations and glob prefixes are reported; live entries are not', () => {
    const live = new Set(['a/live.ts', 'dir/'])
    const workflows = {
      'x.yml': {
        on: {
          push: {
            paths: ['a/live.ts', 'a/gone.ts', 'dir/**', 'gone/**', '**.md', '!a/gone-too.ts'],
          },
          pull_request: { 'paths-ignore': ['docs/**'] },
          schedule: [{ cron: '0 8 * * *' }],
        },
      },
      'y.yml': { on: 'push' },
      'z.yml': { on: ['push', 'pull_request'] },
    }
    expect(stalePathFilters(workflows, (path) => live.has(path))).toEqual([
      'x.yml on.push.paths: a/gone.ts',
      'x.yml on.push.paths: gone/**',
      'x.yml on.push.paths: !a/gone-too.ts',
      'x.yml on.pull_request.paths-ignore: docs/**',
    ])
  })
})
