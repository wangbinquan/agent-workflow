// RFC-611: check every local reference separately from changed-document external links.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export interface GitResult {
  status: number
  stdout: string
  stderr: string
}

export type LinkCheckGit = (args: readonly string[]) => GitResult

export interface DesignLinkRange {
  base: string
  head: string
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function commit(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value) && !/^0+$/.test(value)
}

/** Use the event's immutable endpoints, never a moving branch name or guessed parent. */
export function designLinkRange(
  eventName: string,
  payload: unknown,
  options?: { baseShaOverride?: string; headSha?: string },
): DesignLinkRange | null {
  const event = record(payload)
  const override = options?.baseShaOverride
  if (override !== undefined && override !== '') {
    if (!commit(override)) throw new Error(`Invalid AW_DESIGN_LINKS_BASE_SHA: ${override}`)
    let head: unknown
    if (eventName === 'pull_request') {
      // Never use GitHub's synthetic merge commit (`GITHUB_SHA`) on pull_request events.
      head = record(record(event.pull_request).head).sha
    } else if (eventName === 'push') {
      head = commit(event.after) ? event.after : options?.headSha
    } else if (eventName === 'workflow_dispatch') {
      head = options?.headSha
    }
    return commit(head) ? { base: override, head } : null
  }
  let base: unknown
  let head: unknown
  if (eventName === 'push') {
    base = event.before
    head = event.after
  } else if (eventName === 'pull_request') {
    const pr = record(event.pull_request)
    base = record(pr.base).sha
    head = record(pr.head).sha
  }
  return commit(base) && commit(head) ? { base, head } : null
}

/** Git's NUL output preserves whitespace, quotes, newlines and shell metacharacters. */
export function designMarkdownPaths(nulPaths: string): string[] {
  return [
    ...new Set(
      nulPaths
        .split('\0')
        .filter(
          (path) =>
            path.startsWith('design/') &&
            path.endsWith('.md') &&
            !path.split('/').some((part) => part === '.' || part === '..'),
        ),
    ),
  ].sort()
}

function ensureCommit(git: LinkCheckGit, sha: string): boolean {
  const probe = ['cat-file', '-e', `${sha}^{commit}`]
  if (git(probe).status === 0) return true
  // A shallow checkout may omit the push's previous head or the PR endpoints.
  // Failure to fetch does not narrow coverage: the caller falls back to all docs.
  if (git(['fetch', '--no-tags', '--depth=1', 'origin', sha]).status !== 0) return false
  return git(probe).status === 0
}

export function selectDesignLinkFiles(options: {
  eventName: string
  payload: unknown
  all?: boolean
  baseShaOverride?: string
  headSha?: string
  git: LinkCheckGit
}): { files: string[]; reason: string } {
  const listed = options.git(['ls-files', '-z', '--', 'design'])
  if (listed.status !== 0) throw new Error(`Cannot list design Markdown: ${listed.stderr}`)
  const allFiles = designMarkdownPaths(listed.stdout)
  if (allFiles.length === 0) throw new Error('No tracked design Markdown found')
  if (options.all) return { files: allFiles, reason: 'explicit full external check' }
  if (options.baseShaOverride === 'ALL')
    return {
      files: allFiles,
      reason: 'fallback full external check (AW_DESIGN_LINKS_BASE_SHA=ALL)',
    }
  const range = designLinkRange(options.eventName, options.payload, {
    baseShaOverride: options.baseShaOverride,
    headSha: options.headSha,
  })
  if (!range) return { files: allFiles, reason: 'event has no complete immutable comparison' }
  if (!ensureCommit(options.git, range.base) || !ensureCommit(options.git, range.head))
    return { files: allFiles, reason: 'comparison commit unavailable; checking all docs' }
  const diff = options.git([
    'diff',
    '--name-only',
    '--find-renames',
    '--diff-filter=ACMRT',
    '-z',
    range.base,
    range.head,
    '--',
    'design',
  ])
  if (diff.status !== 0) return { files: allFiles, reason: 'comparison failed; checking all docs' }
  // The current checkout supplies the actual inputs. Removed/renamed old paths
  // must never become missing-file errors or escape the documented scope.
  const existing = new Set(allFiles)
  return {
    files: designMarkdownPaths(diff.stdout).filter((path) => existing.has(path)),
    reason: `changed design Markdown between ${range.base} and ${range.head}`,
  }
}

export function designLinkArguments(repository: string, files: readonly string[]): string[] {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error('GITHUB_REPOSITORY must be an owner/repository name')
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
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
    `^https://github\\.com/${escapedRepository}/actions/runs/`,
    '--',
    ...files,
  ]
}

export async function checkDesignLinks(options: {
  eventName: string
  payload: unknown
  repository: string
  all?: boolean
  baseShaOverride?: string
  headSha?: string
  git: LinkCheckGit
  run: (args: readonly string[]) => Promise<number>
}): Promise<{ files: string[]; reason: string }> {
  const selection = selectDesignLinkFiles(options)
  if (selection.files.length === 0) return selection
  const status = await options.run(designLinkArguments(options.repository, selection.files))
  if (status !== 0) throw new Error(`External design link check failed (exit ${status})`)
  return selection
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2)
    if (args.some((arg) => arg !== '--all') || args.length > 1)
      throw new Error('Usage: bun scripts/ci/check-design-links.ts [--all]')
    const eventPath = process.env.GITHUB_EVENT_PATH
    const result = await checkDesignLinks({
      eventName: process.env.GITHUB_EVENT_NAME ?? '',
      payload: eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : {},
      repository: process.env.GITHUB_REPOSITORY ?? '',
      all: args.includes('--all'),
      baseShaOverride: process.env.AW_DESIGN_LINKS_BASE_SHA,
      headSha: process.env.GITHUB_SHA,
      git(command) {
        const result = spawnSync('git', [...command], {
          encoding: 'utf8',
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
        })
        return {
          status: result.status ?? 1,
          stdout: result.stdout ?? '',
          stderr: result.error?.message ?? result.stderr ?? '',
        }
      },
      async run(command) {
        console.log(
          `Checking external links in ${command.length - command.indexOf('--') - 1} design files`,
        )
        const child = Bun.spawn(['lychee', ...command], {
          stdin: 'ignore',
          stdout: 'inherit',
          stderr: 'inherit',
        })
        return await child.exited
      },
    })
    console.log(`External link selection: ${result.reason}; ${result.files.length} files`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
