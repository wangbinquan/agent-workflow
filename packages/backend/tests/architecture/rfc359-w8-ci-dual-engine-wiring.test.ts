// RFC-359 W8 / RFC-627 —— CI 的双引擎接线本身也要被钉住。
//
// `describeEachProvider`（`tests/helpers/eachProvider.ts`）把「双引擎」做成了缺省，而且缺
// PostgreSQL URL 是 **fail 不是 skip** —— 那条设计是对的，`design/dual-provider-parity-audit-2026-09-04.md`
// 里 12 条 P0 全部是靠「无库则跳过」穿过验收的。
//
// 但那份 harness 保护不了自己：`AW_TEST_PROVIDERS=sqlite` 是它唯一的收窄开关，而**开关握在
// CI 配置手里**。RFC-627 将每提交常规后端拆为 16 片 SQLite 核心 + 16 文件真 PostgreSQL 双引擎门禁
// (`test-backend-postgresql`) + 条件 28 片真 PostgreSQL 迁移双引擎 (`test-backend-migration`) +
// 每日 44 片全量双引擎 (`backend-full-nightly.yml`)，同时新增纯文档快速通道 `docs-fast-gate`。
//
// 判据面锚在**语义**而不是行号 / 文本：
//   ① 三条 Ubuntu 真 PostgreSQL 作业（`ci-work.yml:test-backend-postgresql`、`ci-work.yml:test-backend-migration`、
//      `backend-full-nightly.yml:test-backend-full`）均完整接线 checkout / postgres 启动 / SQL probe /
//      双引擎测试 / always 清理，且各自带着对应的 `AW_TEST_POSTGRESQL_URL`；
//   ② 全部 workflow / job / step 的 env 块里，仅允许已显式登记的四处 SQLite 收窄：
//      - `backend-macos-nightly.yml:test-backend-macos`（无 PG 服务容器的 macOS 原生 lane）
//      - `windows-platform.yml:platform`（无 PG 服务容器的 Windows 原生 lane）
//      - `ci-work.yml:test-backend`（RFC-627 每提交 SQLite 核心分片；真 PG 由同 workflow 另外两条作业与 nightly 承担）
//      - `ci.yml:docs-fast-gate`（RFC-627 纯文档快速通道的文档契约测试步骤）
//   ③ 任何未登记的 Ubuntu `AW_TEST_PROVIDERS: sqlite` 收窄都会当场报红。

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
  readonly id?: unknown
  readonly uses?: unknown
  readonly shell?: unknown
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

export interface PostgresWiringExpectation {
  readonly dbName: 'awtest' | 'rfc357'
  readonly matrixOs: boolean
  readonly urlScope: 'job' | 'step'
  readonly testCommandMarker: string
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

/** 读取当前显式启动链；SQL probe 和所有双引擎测试必须在可用服务之后。 */
export function hasUbuntuPostgresWiring(
  job: WorkflowJob,
  expectation: PostgresWiringExpectation = {
    dbName: 'awtest',
    matrixOs: true,
    urlScope: 'step',
    testCommandMarker: 'scripts/ci/run-backend-shard.ts --tier=migration',
  },
): boolean {
  const steps = stepsOf(job)
  if (steps.some((step) => typeof step !== 'object' || step === null || Array.isArray(step)))
    return false
  const ubuntuCondition = expectation.matrixOs ? "matrix.os == 'ubuntu-latest'" : undefined
  const helper = 'bash .github/scripts/ci-postgresql-service.sh'
  const url = `postgresql://postgres:postgres@127.0.0.1:5432/${expectation.dbName}`
  const jobUrl = envOf(job)['AW_TEST_POSTGRESQL_URL']
  if (expectation.urlScope === 'job' && jobUrl !== url) return false

  const effectiveUrl = (step: WorkflowStep): unknown =>
    envOf(step)['AW_TEST_POSTGRESQL_URL'] ?? (expectation.urlScope === 'job' ? jobUrl : undefined)

  const startIndex = steps.findIndex((step) => step.id === 'postgres')
  const start = steps[startIndex]
  if (
    !start ||
    steps.filter((step) => step.id === 'postgres').length !== 1 ||
    start.shell !== 'bash' ||
    start.if !== ubuntuCondition ||
    start.run !== `${helper} start ${expectation.dbName}`
  )
    return false
  const checkoutIndex = steps.findIndex(
    (step) => typeof step.uses === 'string' && /^actions\/checkout@/.test(step.uses),
  )
  if (checkoutIndex < 0 || checkoutIndex >= startIndex) return false
  const probeIndex = steps.findIndex(
    (step) =>
      step.shell === 'bash' &&
      step.if === ubuntuCondition &&
      effectiveUrl(step) === url &&
      typeof step.run === 'string' &&
      step.run.includes('select 1 as ok') &&
      step.run.includes('bun pg-probe.mjs'),
  )
  if (probeIndex <= startIndex) return false
  const tests = steps.flatMap((step, index) =>
    typeof step.run === 'string' &&
    step.run.includes(expectation.testCommandMarker) &&
    effectiveUrl(step) !== undefined
      ? [{ step, index }]
      : [],
  )
  if (
    !tests.length ||
    tests.some(
      ({ step, index }) =>
        index <= probeIndex || step.if !== ubuntuCondition || effectiveUrl(step) !== url,
    )
  )
    return false
  const expectedStopIf = expectation.matrixOs
    ? "always() && matrix.os == 'ubuntu-latest' && steps.postgres.outcome != '' && steps.postgres.outcome != 'skipped'"
    : "always() && steps.postgres.outcome != '' && steps.postgres.outcome != 'skipped'"
  const stops = steps.flatMap((step, index) =>
    step.run === `${helper} stop` ? [{ step, index }] : [],
  )
  const stop = stops[0]
  return (
    stops.length === 1 &&
    stop !== undefined &&
    stop.step.shell === 'bash' &&
    stop.step.if === expectedStopIf &&
    tests.every(({ index }) => stop.index > index)
  )
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

export function isMacosNightlyOverride(row: ProviderOverride): boolean {
  return (
    row.workflow === 'backend-macos-nightly.yml' &&
    row.job === 'test-backend-macos' &&
    row.scope === 'job' &&
    row.runner === 'macos-latest'
  )
}

export function isWindowsPlatformOverride(row: ProviderOverride): boolean {
  return (
    row.workflow === 'windows-platform.yml' &&
    row.job === 'platform' &&
    row.scope === 'job' &&
    row.runner === 'windows-latest'
  )
}

export function isCoreBackendTierOverride(row: ProviderOverride): boolean {
  return (
    row.workflow === 'ci-work.yml' &&
    row.job === 'test-backend' &&
    row.scope === 'job' &&
    row.runner === '${{ matrix.os }}'
  )
}

export function isDocsFastGateOverride(row: ProviderOverride): boolean {
  return (
    row.workflow === 'ci.yml' &&
    row.job === 'docs-fast-gate' &&
    row.scope === 'step' &&
    row.step === 'Run backend doc-contract tests' &&
    row.runner === 'ubuntu-latest'
  )
}

function readWorkflows(): ReadonlyArray<readonly [string, string]> {
  return readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => [name, readFileSync(join(WORKFLOWS, name), 'utf8')] as const)
}

describe('RFC-359 W8 / RFC-627 —— CI 的双引擎接线', () => {
  const files = readWorkflows()
  const ci = parse(readFileSync(join(WORKFLOWS, 'ci-work.yml'), 'utf8')) as unknown
  const nightlyFull = parse(
    readFileSync(join(WORKFLOWS, 'backend-full-nightly.yml'), 'utf8'),
  ) as unknown
  const backendPg = jobsOf(ci).find(([name]) => name === 'test-backend-postgresql')?.[1]
  const backendMigration = jobsOf(ci).find(([name]) => name === 'test-backend-migration')?.[1]
  const backendFull = jobsOf(nightlyFull).find(([name]) => name === 'test-backend-full')?.[1]

  test('语料非空：确实读到了 workflow 目录及全部三条 Ubuntu 双引擎作业', () => {
    expect(files.length).toBeGreaterThanOrEqual(1)
    expect(backendPg, '`ci-work.yml` 缺少 `test-backend-postgresql`').toBeDefined()
    expect(backendMigration, '`ci-work.yml` 缺少 `test-backend-migration`').toBeDefined()
    expect(backendFull, '`backend-full-nightly.yml` 缺少 `test-backend-full`').toBeDefined()
  })

  test('①② 三条 Ubuntu 真 PostgreSQL 作业完整接线启动、SQL probe、双引擎执行与 always 清理', () => {
    expect(
      hasUbuntuPostgresWiring(backendPg ?? {}, {
        dbName: 'rfc357',
        matrixOs: false,
        urlScope: 'job',
        testCommandMarker: 'scripts/ci/run-postgresql-gate.ts',
      }),
      '`test-backend-postgresql` 的 PostgreSQL 双引擎接线不完整',
    ).toBe(true)

    expect(
      hasUbuntuPostgresWiring(backendMigration ?? {}, {
        dbName: 'awtest',
        matrixOs: true,
        urlScope: 'step',
        testCommandMarker: 'scripts/ci/run-backend-shard.ts --tier=migration',
      }),
      '`test-backend-migration` 的 PostgreSQL 双引擎接线不完整',
    ).toBe(true)

    expect(
      hasUbuntuPostgresWiring(backendFull ?? {}, {
        dbName: 'awtest',
        matrixOs: false,
        urlScope: 'step',
        testCommandMarker: 'scripts/ci/run-backend-shard.ts --tier=all',
      }),
      '`backend-full-nightly.yml:test-backend-full` 的 PostgreSQL 双引擎接线不完整',
    ).toBe(true)
  })

  test('③④ AW_TEST_PROVIDERS 仅用于已批准的四处 SQLite 收窄，不能静默关掉三条双引擎作业', () => {
    const overrides = providerOverrides(files)
    expect(
      overrides
        .map((row) => `${row.workflow}:${row.job}:${row.scope}:${row.step}=${row.value}`)
        .sort(),
      '`AW_TEST_PROVIDERS` 是 `describeEachProvider` 唯一的收窄开关。多出一处 = ' +
        '有一整条 lane 的 PostgreSQL 验证被静默关掉，而**不会有任何用例变红**。',
    ).toEqual([
      'backend-macos-nightly.yml:test-backend-macos:job:(job)=sqlite',
      'ci-work.yml:test-backend:job:(job)=sqlite',
      'ci.yml:docs-fast-gate:step:Run backend doc-contract tests=sqlite',
      'windows-platform.yml:platform:job:(job)=sqlite',
    ])

    for (const row of overrides) {
      expect(
        isWindowsPlatformOverride(row) ||
          isMacosNightlyOverride(row) ||
          isCoreBackendTierOverride(row) ||
          isDocsFastGateOverride(row) ||
          (row.scope === 'step' && excludesUbuntu(row.condition)),
        `${row.workflow}:${row.job}:${row.step} 关掉了 PostgreSQL 且不在已批准的四处清单内`,
      ).toBe(true)
      expect(row.value, `${row.step} 的 AW_TEST_PROVIDERS 值意外`).toBe('sqlite')
    }

    const windows = parse(readFileSync(join(WORKFLOWS, 'windows-platform.yml'), 'utf8')) as unknown
    const platform = jobsOf(windows).find(([name]) => name === 'platform')?.[1]
    expect(platform?.['runs-on']).toBe('windows-latest')
    expect(platform?.services).toBeUndefined()

    const macosNightly = parse(
      readFileSync(join(WORKFLOWS, 'backend-macos-nightly.yml'), 'utf8'),
    ) as unknown
    const macos = jobsOf(macosNightly).find(([name]) => name === 'test-backend-macos')?.[1]
    expect(macos?.['runs-on']).toBe('macos-latest')
    expect(macos?.services).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 负 fixture：判据自己要能被证伪
// ---------------------------------------------------------------------------

const FIXTURE_UBUNTU_OVERRIDE = `
jobs:
  test-backend-migration:
    steps:
      - name: Test backend migration (ubuntu shard)
        if: matrix.os == 'ubuntu-latest'
        run: bun scripts/ci/run-backend-shard.ts --tier=migration
        env:
          AW_TEST_PROVIDERS: sqlite
`

const FIXTURE_NO_OVERRIDE = `
jobs:
  test-backend-migration:
    steps:
      - name: Test backend migration (ubuntu shard)
        run: bun scripts/ci/run-backend-shard.ts --tier=migration
        env:
          AW_TEST_POSTGRESQL_URL: postgresql://x/y
`

describe('RFC-359 W8 —— 上面那条判据的负 fixture', () => {
  test('往 ubuntu 迁移或全量步骤里塞 AW_TEST_PROVIDERS：抓得到，且判定它不在允许清单内', () => {
    const rows = providerOverrides([['ci-work.yml', FIXTURE_UBUNTU_OVERRIDE]])
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.job).toBe('test-backend-migration')
    expect(excludesUbuntu(row.condition)).toBe(false)
    expect(isCoreBackendTierOverride(row)).toBe(false)
    expect(isDocsFastGateOverride(row)).toBe(false)
    expect(isMacosNightlyOverride(row)).toBe(false)
    expect(isWindowsPlatformOverride(row)).toBe(false)
  })

  test('没有 override 时不误报', () => {
    expect(providerOverrides([['fixture.yml', FIXTURE_NO_OVERRIDE]])).toEqual([])
  })

  test('`if` 明确排除 ubuntu 时才认', () => {
    expect(excludesUbuntu("matrix.os != 'ubuntu-latest'")).toBe(true)
    expect(excludesUbuntu("matrix.os == 'macos-latest'")).toBe(false)
    expect(excludesUbuntu('')).toBe(false)
  })

  test('job 与 workflow 层收窄也可见，不能绕过已批准清单', () => {
    const rows = providerOverrides([
      [
        'backend-full-nightly.yml',
        `env:
  AW_TEST_PROVIDERS: sqlite
jobs:
  test-backend-full:
    runs-on: ubuntu-latest
    env:
      AW_TEST_PROVIDERS: sqlite
    steps:
      - run: bun scripts/ci/run-backend-shard.ts --tier=all
`,
      ],
    ])
    expect(rows.map((row) => row.scope)).toEqual(['workflow', 'job'])
    for (const row of rows) {
      expect(isWindowsPlatformOverride(row)).toBe(false)
      expect(isMacosNightlyOverride(row)).toBe(false)
      expect(isCoreBackendTierOverride(row)).toBe(false)
      expect(isDocsFastGateOverride(row)).toBe(false)
      expect(excludesUbuntu(row.condition)).toBe(false)
    }
  })

  test('macOS nightly 与 Windows 例外同时匹配工作流、作业、env 层级和固定 runner', () => {
    const macRows = providerOverrides([
      [
        'backend-macos-nightly.yml',
        `jobs:
  test-backend-macos:
    runs-on: macos-latest
    env:
      AW_TEST_PROVIDERS: sqlite
    steps:
      - run: bun test
`,
      ],
    ])
    expect(macRows).toHaveLength(1)
    const macRow = macRows[0]!
    expect(isMacosNightlyOverride(macRow)).toBe(true)
    expect(isWindowsPlatformOverride(macRow)).toBe(false)
    expect(isMacosNightlyOverride({ ...macRow, workflow: 'ci-work.yml' })).toBe(false)
    expect(isMacosNightlyOverride({ ...macRow, job: 'test-backend' })).toBe(false)
    expect(isMacosNightlyOverride({ ...macRow, scope: 'workflow' })).toBe(false)
    expect(isMacosNightlyOverride({ ...macRow, scope: 'step' })).toBe(false)
    expect(isMacosNightlyOverride({ ...macRow, runner: 'ubuntu-latest' })).toBe(false)
    expect(isMacosNightlyOverride({ ...macRow, runner: '${{ matrix.os }}' })).toBe(false)

    const winRows = providerOverrides([
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
    expect(winRows).toHaveLength(1)
    const winRow = winRows[0]!
    expect(isWindowsPlatformOverride(winRow)).toBe(true)
    expect(isWindowsPlatformOverride({ ...winRow, workflow: 'ci-work.yml' })).toBe(false)
    expect(isWindowsPlatformOverride({ ...winRow, job: 'test-backend' })).toBe(false)
    expect(isWindowsPlatformOverride({ ...winRow, scope: 'workflow' })).toBe(false)
    expect(isWindowsPlatformOverride({ ...winRow, scope: 'step' })).toBe(false)
    expect(isWindowsPlatformOverride({ ...winRow, runner: 'ubuntu-latest' })).toBe(false)
    expect(isWindowsPlatformOverride({ ...winRow, runner: '${{ matrix.os }}' })).toBe(false)
  })

  test('core 分片与 docs-fast-gate 例外同样精确锁定工作流、作业与步骤边界', () => {
    const coreRow: ProviderOverride = {
      workflow: 'ci-work.yml',
      job: 'test-backend',
      step: '(job)',
      scope: 'job',
      runner: '${{ matrix.os }}',
      value: 'sqlite',
      condition: '',
    }
    expect(isCoreBackendTierOverride(coreRow)).toBe(true)
    expect(isCoreBackendTierOverride({ ...coreRow, job: 'test-backend-migration' })).toBe(false)
    expect(isCoreBackendTierOverride({ ...coreRow, workflow: 'backend-full-nightly.yml' })).toBe(
      false,
    )
    expect(isCoreBackendTierOverride({ ...coreRow, scope: 'workflow' })).toBe(false)

    const docsRow: ProviderOverride = {
      workflow: 'ci.yml',
      job: 'docs-fast-gate',
      step: 'Run backend doc-contract tests',
      scope: 'step',
      runner: 'ubuntu-latest',
      value: 'sqlite',
      condition: '',
    }
    expect(isDocsFastGateOverride(docsRow)).toBe(true)
    expect(isDocsFastGateOverride({ ...docsRow, job: 'full-ci' })).toBe(false)
    expect(isDocsFastGateOverride({ ...docsRow, scope: 'job' })).toBe(false)
    expect(isDocsFastGateOverride({ ...docsRow, step: 'Other step' })).toBe(false)
  })

  test('显式 PostgreSQL 接线缺启动、错条件或数据库、错序和缺清理时不能通过', () => {
    const ci = parse(readFileSync(join(WORKFLOWS, 'ci-work.yml'), 'utf8')) as unknown
    const migration = jobsOf(ci).find(([name]) => name === 'test-backend-migration')?.[1] ?? {}
    const steps = stepsOf(migration)
    const startIndex = steps.findIndex((step) => step.id === 'postgres')
    const probeIndex = steps.findIndex(
      (step) => typeof step.run === 'string' && step.run.includes('bun pg-probe.mjs'),
    )
    const testIndex = steps.findIndex(
      (step) =>
        typeof step.run === 'string' &&
        step.run.includes('scripts/ci/run-backend-shard.ts --tier=migration') &&
        envOf(step)['AW_TEST_POSTGRESQL_URL'] !== undefined,
    )
    const stopIndex = steps.findIndex(
      (step) => step.run === 'bash .github/scripts/ci-postgresql-service.sh stop',
    )
    const change = (index: number, patch: Partial<WorkflowStep>): WorkflowJob => ({
      ...migration,
      steps: steps.map((step, position) => (position === index ? { ...step, ...patch } : step)),
    })
    const remove = (index: number): WorkflowJob => ({
      ...migration,
      steps: steps.filter((_, position) => position !== index),
    })
    const swap = (left: number, right: number): WorkflowJob => ({
      ...migration,
      steps: steps.map((step, index) =>
        index === left ? steps[right]! : index === right ? steps[left]! : step,
      ),
    })
    expect(hasUbuntuPostgresWiring(migration)).toBe(true)
    const broken: ReadonlyArray<readonly [string, WorkflowJob]> = [
      ['空步骤项', { ...migration, steps: [null, ...steps] }],
      ['非对象步骤项', { ...migration, steps: [17, ...steps] }],
      ['数组步骤项', { ...migration, steps: [[], ...steps] }],
      ['缺启动', remove(startIndex)],
      [
        '错误数据库',
        change(startIndex, { run: 'bash .github/scripts/ci-postgresql-service.sh start wrong' }),
      ],
      ['错误运行条件', change(startIndex, { if: "matrix.os != 'ubuntu-latest'" })],
      ['checkout 晚于启动', swap(0, startIndex)],
      ['启动晚于 SQL probe', swap(startIndex, probeIndex)],
      ['启动晚于双引擎测试', swap(startIndex, testIndex)],
      ['缺 SQL probe', remove(probeIndex)],
      ['清理早于双引擎测试', swap(testIndex, stopIndex)],
      ['缺清理', remove(stopIndex)],
      ['清理没有 always', change(stopIndex, { if: "matrix.os == 'ubuntu-latest'" })],
    ]
    for (const [name, job] of broken) expect(hasUbuntuPostgresWiring(job), name).toBe(false)

    // 同样证伪非 matrix 作业（test-backend-postgresql 与 backend-full-nightly）
    const pgJob = jobsOf(ci).find(([name]) => name === 'test-backend-postgresql')?.[1] ?? {}
    expect(
      hasUbuntuPostgresWiring(
        { ...pgJob, env: {} },
        {
          dbName: 'rfc357',
          matrixOs: false,
          urlScope: 'job',
          testCommandMarker: 'scripts/ci/run-postgresql-gate.ts',
        },
      ),
    ).toBe(false)
  })
})
