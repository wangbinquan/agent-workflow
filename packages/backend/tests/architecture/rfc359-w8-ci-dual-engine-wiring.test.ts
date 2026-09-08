// RFC-359 W8 —— CI 的双引擎接线本身也要被钉住。
//
// `describeEachProvider`（`tests/helpers/eachProvider.ts`）把「双引擎」做成了缺省，而且缺
// PostgreSQL URL 是 **fail 不是 skip** —— 那条设计是对的，`design/dual-provider-parity-audit-2026-09-04.md`
// 里 12 条 P0 全部是靠「无库则跳过」穿过验收的。
//
// 但那份 harness 保护不了自己：`AW_TEST_PROVIDERS=sqlite` 是它唯一的收窄开关，而**开关握在
// CI 配置手里**。往 ubuntu 那条 backend lane 的 env 里加一行 `AW_TEST_PROVIDERS: sqlite`，
// 全仓每一条双引擎用例的 PostgreSQL 半边就此静默消失 —— 没有一条用例会红，没有一个数字会变，
// 整个 RFC-359 的验证面当场归零而 CI 全绿。本文件精确登记没有 PostgreSQL 服务的原生平台 lane。
//
// 判据面刻意只有四条，且都锚在**语义**而不是行号 / 文本：
//   ① backend 分片作业在 ubuntu 上确实起了 postgres 服务容器；
//   ② ubuntu 那一步确实把 `AW_TEST_POSTGRESQL_URL` 交给了 `bun test`；
//   ③ 全部 workflow / job / step 的 env 块里，仅允许已登记的两处 SQLite 收窄；
//   ④ macOS 步骤明确排除 ubuntu，Windows platform 作业固定 Windows runner 且没有 PostgreSQL 服务。
//
// ③④ 同时锁位置和运行条件；更改 runner 或再加一处收窄都需要更新判据。

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'

const WORKFLOWS = resolve(import.meta.dir, '..', '..', '..', '..', '.github', 'workflows')

interface ProviderOverride {
  readonly workflow: string
  readonly job: string
  readonly step: string
  readonly scope: 'workflow' | 'job' | 'step'
  readonly runner: unknown
  readonly value: string
  /** 该步骤的 `if:` 条件；没有就是空串。 */
  readonly condition: string
}

interface WorkflowStep {
  readonly name?: unknown
  readonly if?: unknown
  readonly env?: unknown
  readonly run?: unknown
}

interface WorkflowJob {
  readonly env?: unknown
  readonly 'runs-on'?: unknown
  readonly services?: unknown
  readonly steps?: unknown
}

function jobsOf(doc: unknown): ReadonlyArray<readonly [string, WorkflowJob]> {
  if (typeof doc !== 'object' || doc === null) return []
  const jobs = (doc as { jobs?: unknown }).jobs
  if (typeof jobs !== 'object' || jobs === null) return []
  return Object.entries(jobs as Record<string, WorkflowJob>)
}

function stepsOf(job: WorkflowJob): readonly WorkflowStep[] {
  return Array.isArray(job.steps) ? (job.steps as WorkflowStep[]) : []
}

function envOf(step: { readonly env?: unknown }): Record<string, unknown> {
  return typeof step.env === 'object' && step.env !== null
    ? (step.env as Record<string, unknown>)
    : {}
}

/** 扫全部 workflow，收集 workflow、job 和 step 三层 env 的每一处收窄。 */
export function providerOverrides(
  files: ReadonlyArray<readonly [string, string]>,
): ProviderOverride[] {
  const found: ProviderOverride[] = []
  for (const [workflow, text] of files) {
    const document = parse(text) as unknown
    const workflowEnv =
      typeof document === 'object' && document !== null
        ? envOf(document as { readonly env?: unknown })
        : {}
    const workflowValue = workflowEnv['AW_TEST_PROVIDERS']
    if (workflowValue !== undefined) {
      found.push({
        workflow,
        job: '(workflow)',
        step: '(workflow)',
        scope: 'workflow',
        runner: undefined,
        value: String(workflowValue),
        condition: '',
      })
    }
    for (const [job, definition] of jobsOf(document)) {
      const jobValue = envOf(definition)['AW_TEST_PROVIDERS']
      if (jobValue !== undefined) {
        found.push({
          workflow,
          job,
          step: '(job)',
          scope: 'job',
          runner: definition['runs-on'],
          value: String(jobValue),
          condition: '',
        })
      }
      for (const step of stepsOf(definition)) {
        const value = envOf(step)['AW_TEST_PROVIDERS']
        if (value === undefined) continue
        found.push({
          workflow,
          job,
          step: typeof step.name === 'string' ? step.name : '(unnamed)',
          scope: 'step',
          runner: definition['runs-on'],
          value: String(value),
          condition: typeof step.if === 'string' ? step.if : '',
        })
      }
    }
  }
  return found
}

/** 该步骤是否**明确排除**了 ubuntu（即：只在 macOS 之类的 runner 上跑）。 */
export function excludesUbuntu(condition: string): boolean {
  return /matrix\.os\s*!=\s*'ubuntu-latest'/.test(condition)
}

export function isWindowsPlatformOverride(row: ProviderOverride): boolean {
  return (
    row.workflow === 'windows-platform.yml' &&
    row.job === 'platform' &&
    row.scope === 'job' &&
    row.runner === 'windows-latest'
  )
}

function readWorkflows(): ReadonlyArray<readonly [string, string]> {
  return readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => [name, readFileSync(join(WORKFLOWS, name), 'utf8')] as const)
}

describe('RFC-359 W8 —— CI 的双引擎接线', () => {
  const files = readWorkflows()
  const ci = parse(readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8')) as unknown
  const backend = jobsOf(ci).find(([name]) => name === 'test-backend')?.[1]

  test('语料非空：确实读到了 workflow 目录（读成 0 个文件此刻零预言力）', () => {
    expect(files.length).toBeGreaterThanOrEqual(1)
    expect(backend, '`ci.yml` 里找不到 `test-backend` 作业——作业改名了就来更新本判据').toBeDefined()
  })

  test('① backend 分片在 ubuntu 上起了 postgres 服务容器', () => {
    const services = backend?.services
    expect(
      typeof services === 'object' && services !== null && 'postgres' in services,
      '`test-backend` 不再声明 postgres 服务容器——双引擎用例的 PostgreSQL 半边将无库可连',
    ).toBe(true)
  })

  test('② ubuntu 那一步把 AW_TEST_POSTGRESQL_URL 交给了 bun test', () => {
    const ubuntu = stepsOf(backend ?? {}).filter(
      (step) =>
        typeof step.run === 'string' &&
        step.run.includes('bun test') &&
        envOf(step)['AW_TEST_POSTGRESQL_URL'] !== undefined,
    )
    expect(
      ubuntu.length,
      '没有任何一步在带着 `AW_TEST_POSTGRESQL_URL` 跑 `bun test`——' +
        '`describeEachProvider` 会因缺 URL 而红（这是设计），但更可能的是有人顺手把它删了',
    ).toBeGreaterThanOrEqual(1)
  })

  test('③④ AW_TEST_PROVIDERS 仅用于 macOS backend 步骤与 Windows platform 作业', () => {
    const overrides = providerOverrides(files)
    expect(
      overrides
        .map((row) => `${row.workflow}:${row.job}:${row.scope}:${row.step}=${row.value}`)
        .sort(),
      '`AW_TEST_PROVIDERS` 是 `describeEachProvider` 唯一的收窄开关。多出一处 = ' +
        '有一整条 lane 的 PostgreSQL 验证被静默关掉，而**不会有任何用例变红**。' +
        '要新增只有一种情况：又出现一个起不了服务容器的 runner——那就连同理由一起更新本判据。',
    ).toEqual([
      'ci.yml:test-backend:step:Test backend (macOS shard — no coverage)=sqlite',
      'windows-platform.yml:platform:job:(job)=sqlite',
    ])

    for (const row of overrides) {
      expect(
        isWindowsPlatformOverride(row) || (row.scope === 'step' && excludesUbuntu(row.condition)),
        `${row.workflow}:${row.job}:${row.step} 关掉了 PostgreSQL，但它的 \`if\` 没有明确排除 ` +
          `ubuntu（当前条件：${row.condition || '(无)'}）。ubuntu 是唯一带 postgres 服务容器的 ` +
          `runner，在那里关掉双引擎等于把 RFC-359 的验证面归零。`,
      ).toBe(true)
      expect(row.value, `${row.step} 的 AW_TEST_PROVIDERS 值意外`).toBe('sqlite')
    }

    const windows = parse(readFileSync(join(WORKFLOWS, 'windows-platform.yml'), 'utf8')) as unknown
    const platform = jobsOf(windows).find(([name]) => name === 'platform')?.[1]
    expect(platform?.['runs-on']).toBe('windows-latest')
    expect(platform?.services).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 负 fixture：判据自己要能被证伪
// ---------------------------------------------------------------------------

const FIXTURE_UBUNTU_OVERRIDE = `
jobs:
  test-backend:
    steps:
      - name: Test backend (ubuntu shard)
        if: matrix.os == 'ubuntu-latest'
        run: bun test
        env:
          AW_TEST_PROVIDERS: sqlite
`

const FIXTURE_NO_OVERRIDE = `
jobs:
  test-backend:
    steps:
      - name: Test backend (ubuntu shard)
        run: bun test
        env:
          AW_TEST_POSTGRESQL_URL: postgresql://x/y
`

describe('RFC-359 W8 —— 上面那条判据的负 fixture', () => {
  test('往 ubuntu 步骤里塞 AW_TEST_PROVIDERS：抓得到，且判定它没有排除 ubuntu', () => {
    const rows = providerOverrides([['fixture.yml', FIXTURE_UBUNTU_OVERRIDE]])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.job).toBe('test-backend')
    expect(excludesUbuntu(rows[0]?.condition ?? '')).toBe(false)
  })

  test('没有 override 时不误报', () => {
    expect(providerOverrides([['fixture.yml', FIXTURE_NO_OVERRIDE]])).toEqual([])
  })

  test('`if` 明确排除 ubuntu 时才认', () => {
    expect(excludesUbuntu("matrix.os != 'ubuntu-latest'")).toBe(true)
    expect(excludesUbuntu("matrix.os == 'macos-latest'")).toBe(false)
    expect(excludesUbuntu('')).toBe(false)
  })

  test('job 与 workflow 层收窄也可见，不能绕过仅有的两个平台例外', () => {
    const rows = providerOverrides([
      [
        'fixture.yml',
        `env:
  AW_TEST_PROVIDERS: sqlite
jobs:
  test-backend:
    runs-on: ubuntu-latest
    env:
      AW_TEST_PROVIDERS: sqlite
    steps:
      - run: bun test
`,
      ],
    ])
    expect(rows.map((row) => row.scope)).toEqual(['workflow', 'job'])
    for (const row of rows) {
      expect(isWindowsPlatformOverride(row)).toBe(false)
      expect(excludesUbuntu(row.condition)).toBe(false)
    }
  })

  test('Windows 例外同时匹配工作流、作业、env 层级和固定 runner', () => {
    const rows = providerOverrides([
      [
        'windows-platform.yml',
        `jobs:
  platform:
    runs-on: windows-latest
    env:
      AW_TEST_PROVIDERS: sqlite
    steps:
      - run: bun test
`,
      ],
    ])
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(isWindowsPlatformOverride(row)).toBe(true)
    expect(isWindowsPlatformOverride({ ...row, workflow: 'ci.yml' })).toBe(false)
    expect(isWindowsPlatformOverride({ ...row, job: 'test-backend' })).toBe(false)
    expect(isWindowsPlatformOverride({ ...row, scope: 'workflow' })).toBe(false)
    expect(isWindowsPlatformOverride({ ...row, scope: 'step' })).toBe(false)
    expect(isWindowsPlatformOverride({ ...row, runner: 'ubuntu-latest' })).toBe(false)
    expect(isWindowsPlatformOverride({ ...row, runner: '${{ matrix.os }}' })).toBe(false)
  })
})
