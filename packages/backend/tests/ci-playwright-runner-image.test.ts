// CI Playwright runner-image lock (2026-11-05).
//
// Why this exists: GitHub moved `ubuntu-latest` to ubuntu-26.04 on 2026-11-03. The Playwright in bun.lock (1.60.0)
// cannot install Chromium, WebKit or their system dependencies there ("Playwright does not support chromium on
// ubuntu26.04-x64"), so e2e-full-nightly, git-protocols-e2e and e2e-webkit-nightly failed every night from then on,
// and the main CI Linux browser leg only passed while its browser cache hit (its `install-deps` printed the same
// refusal). Every workflow job that installs Playwright browsers on Linux therefore runs on an explicitly versioned
// Ubuntu image that the installed Playwright supports; moving the image means moving Playwright with it.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const WORKFLOWS = join(ROOT, '.github', 'workflows')
const PLAYWRIGHT_INSTALL = /\bplaywright install(?:-deps)?\b/

interface WorkflowJob {
  readonly 'runs-on'?: unknown
  readonly strategy?: { readonly matrix?: { readonly os?: unknown; readonly include?: unknown } }
  readonly steps?: readonly { readonly run?: unknown }[]
}

/** The runner labels a job runs on: a literal `runs-on`, or the `matrix.os` values it expands to. */
function runnerLabels(job: WorkflowJob): string[] {
  const runsOn = job['runs-on']
  if (typeof runsOn !== 'string')
    throw new Error(`unsupported runs-on shape: ${JSON.stringify(runsOn)}`)
  if (!runsOn.includes('${{')) return [runsOn]
  if (runsOn.replace(/\s+/g, '') !== '${{matrix.os}}')
    throw new Error(`unrecognized runs-on ${runsOn}`)
  const matrix = job.strategy?.matrix
  const labels = Array.isArray(matrix?.os) ? matrix.os.map(String) : []
  if (Array.isArray(matrix?.include))
    for (const entry of matrix.include as { os?: unknown }[])
      if (typeof entry.os === 'string') labels.push(entry.os)
  return labels
}

/** `ubuntu-24.04` -> `ubuntu24.04-x64`, `ubuntu-24.04-arm` -> `ubuntu24.04-arm64`; null for a non-versioned label. */
function playwrightHost(label: string): string | null {
  const match = /^ubuntu-(\d{2}\.\d{2})(-arm)?$/.exec(label)
  return match === null ? null : `ubuntu${match[1]}-${match[2] === undefined ? 'x64' : 'arm64'}`
}

/** Every Linux runner of a job that installs Playwright browsers must be a versioned image Playwright supports. */
export function playwrightRunnerIssues(
  workflows: Readonly<Record<string, unknown>>,
  supportsHost: (host: string) => boolean,
): string[] {
  const issues: string[] = []
  for (const [file, workflow] of Object.entries(workflows)) {
    const jobs = (workflow as { jobs?: Record<string, WorkflowJob> }).jobs ?? {}
    for (const [id, job] of Object.entries(jobs)) {
      const installs = (job.steps ?? []).some(
        (step) => typeof step.run === 'string' && PLAYWRIGHT_INSTALL.test(step.run),
      )
      if (!installs) continue
      for (const label of runnerLabels(job)) {
        if (!label.startsWith('ubuntu')) continue
        const host = playwrightHost(label)
        if (host === null) issues.push(`${file}#${id}: ${label} is not a versioned Ubuntu image`)
        else if (!supportsHost(host))
          issues.push(`${file}#${id}: the installed Playwright does not support ${host}`)
      }
    }
  }
  return issues
}

function realWorkflows(): Record<string, unknown> {
  return Object.fromEntries(
    readdirSync(WORKFLOWS)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, parse(readFileSync(join(WORKFLOWS, name), 'utf8'))]),
  )
}

/** The hosts the installed playwright-core lists (resolved the way `@playwright/test` resolves it). */
function installedPlaywrightHosts(): string {
  const test = Bun.resolveSync('@playwright/test/package.json', ROOT)
  const playwright = Bun.resolveSync('playwright/package.json', dirname(test))
  const core = dirname(Bun.resolveSync('playwright-core/package.json', dirname(playwright)))
  const sources: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.js')) sources.push(readFileSync(path, 'utf8'))
    }
  }
  walk(join(core, 'lib'))
  return sources.join('\n')
}

describe('CI Playwright runner images', () => {
  test('every Linux job that installs Playwright browsers runs on a versioned image the installed Playwright supports', () => {
    const hosts = installedPlaywrightHosts()
    const workflows = realWorkflows()
    expect(
      playwrightRunnerIssues(
        workflows,
        (host) => hosts.includes(`'${host}'`) || hosts.includes(`"${host}"`),
      ),
    ).toEqual([])
    // The scan sees the jobs it guards (main CI Linux leg, full tier, git protocols, webkit, visual regression).
    const guarded = Object.entries(workflows).flatMap(([file, workflow]) =>
      Object.entries((workflow as { jobs?: Record<string, WorkflowJob> }).jobs ?? {})
        .filter(([, job]) =>
          (job.steps ?? []).some(
            (step) => typeof step.run === 'string' && PLAYWRIGHT_INSTALL.test(step.run),
          ),
        )
        .map(([id]) => `${file}#${id}`),
    )
    for (const job of [
      'ci.yml#e2e',
      'e2e-full-nightly.yml#e2e-full',
      'git-protocols-e2e.yml#git-protocols',
      'e2e-webkit-nightly.yml#e2e-webkit',
      'visual-regression-nightly.yml#visual-regression',
    ])
      expect(guarded).toContain(job)
  })

  test('negative control: ubuntu-latest, an unversioned label and an unsupported image are all reported', () => {
    const install = { steps: [{ run: 'bunx playwright install --with-deps chromium' }] }
    const issues = playwrightRunnerIssues(
      {
        'a.yml': { jobs: { latest: { ...install, 'runs-on': 'ubuntu-latest' } } },
        'b.yml': {
          jobs: {
            matrix: {
              steps: [{ run: 'bunx playwright install-deps chromium' }],
              'runs-on': '${{ matrix.os }}',
              strategy: { matrix: { os: ['ubuntu-26.04', 'macos-latest'] } },
            },
          },
        },
        'c.yml': { jobs: { ok: { ...install, 'runs-on': 'ubuntu-24.04' } } },
        'd.yml': {
          jobs: { noBrowsers: { steps: [{ run: 'bun test' }], 'runs-on': 'ubuntu-latest' } },
        },
      },
      (host) => host === 'ubuntu24.04-x64',
    )
    expect(issues).toEqual([
      'a.yml#latest: ubuntu-latest is not a versioned Ubuntu image',
      'b.yml#matrix: the installed Playwright does not support ubuntu26.04-x64',
    ])
  })
})
