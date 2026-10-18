// RFC-376 T2/T6/T7: reproducible committed-source reporting, stable identities and corrected inventory denominators.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { sourceUnit, importEdges, type SourceUnit } from './census'
import {
  readReportSource,
  buildArchitectureReport,
  renderReportStatus,
  renderGateBaselines,
  stableJson,
  parseKnownViolations,
  targetContextFor,
  mutableSingletons,
  backgroundDefinitions,
  binaryEntries,
  workspaceExports,
  unconsumedPublicSymbols,
} from './architectureReport'
import {
  TASK_EXECUTION_DURABLE_TABLES,
  TASK_EFFECT_OBSERVER_CALLEES,
  classifyTaskExecutionAuthority,
  buildTaskExecutionAuthorityEntries,
  buildTaskExecutionControlGateways,
  buildTaskOwnedEffectEntries,
  buildCodeHostRecoveryBindingManifest,
  validateCodeHostRecoveryBindingManifest,
  declarationInitializer,
  dataLiteral,
} from './rfc328TaskExecutionLedger'
import { parseReportOptions, reportOutputPaths } from '../../../../scripts/architecture-report'
const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const PREFIX = 'packages/backend/src/'
const unit = (path: string, text: string): SourceUnit => sourceUnit(PREFIX + path, text)
const SOURCE = readReportSource(ROOT, 'HEAD')

function bindingFixture(): SourceUnit[] {
  return [
    unit(
      'modules/task-execution/domain/codeHostRecovery.ts',
      `
      const CODE_HOST_PROVIDERS = ['gitlab', 'github'] as const
      const CUSTOM_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
      const RECOVERY_BY_ACTION = { 'comment.update': 'R-EXACT', 'review.submit': 'R-ACTOR', custom: 'R-ACTOR' }
      const PROBE_BY_ACTION = { 'comment.update': 'exact-comment-body', 'review.submit': 'actor-replay', custom: 'actor-replay' }
    `,
    ),
    sourceUnit(
      'packages/shared/src/codeHost/actions.ts',
      `
      export const CODE_HOST_ACTIONS = ['comment.update', 'review.submit', 'custom'] as const
      export const CODE_HOST_ACTION_DEFS = {
        'comment.update': { bindings: { gitlab: { method: 'PUT', path: '/comments' }, github: { method: 'PATCH', path: '/comments', compatibilityFallbacks: [{ method: 'POST', path: '/fallback' }] } } },
        'review.submit': { bindings: { gitlab: { method: 'POST', path: '/approve' }, github: { unsupported: 'not available' } } },
        custom: { bindings: { gitlab: { method: 'GET', path: '/' }, github: { method: 'GET', path: '/' } } },
      } as const
    `,
    ),
  ]
}
describe('RFC-376 independent RFC-328 builders', () => {
  test('durable authority and control classifications preserve the original contract', () => {
    expect(TASK_EXECUTION_DURABLE_TABLES.has('nodeRuns')).toBe(true)
    expect(TASK_EFFECT_OBSERVER_CALLEES.has('runTaskLocalEffect')).toBe(true)
    expect(
      classifyTaskExecutionAuthority({
        file: PREFIX + 'modules/task-execution/infrastructure/crewstation/bootRecovery.ts',
        callable: 'recover',
      })?.authorityKind,
    ).toBe('recovery-proof')
    expect(
      classifyTaskExecutionAuthority({ file: 'fabricated/unknown.ts', callable: 'run' }),
    ).toBeNull()
    const source = unit(
      'modules/task-execution/infrastructure/crewstation/bootRecovery.ts',
      'export function recover() { tx.update(nodeRuns); tx.delete(tasks) }',
    )
    const authority = buildTaskExecutionAuthorityEntries([source])
    expect(authority.unknown).toEqual([])
    expect(authority.entries).toHaveLength(2)
    expect(authority.entries.map((entry) => entry.id)).toEqual(
      buildTaskExecutionAuthorityEntries([
        unit(
          'modules/task-execution/infrastructure/crewstation/bootRecovery.ts',
          '\n\n' + source.text,
        ),
      ]).entries.map((entry) => entry.id),
    )
    expect(
      buildTaskExecutionAuthorityEntries([
        unit('services/unknown.ts', 'function write() { tx.insert(tasks) }'),
      ]).unknown,
    ).toHaveLength(1)
    expect(buildTaskExecutionControlGateways([]).unknown).toHaveLength(6)
  })
  test('act-site registrations classify valid policies and expose unknown shapes', () => {
    const source = unit(
      'modules/task-execution/infrastructure/probe.ts',
      `
      export function act() {
        createProcessEffectAttemptObserver({ resourceKeys: keys });
        createCodeHostEffectAttemptObserver({ resourceKeys: keys });
        runTaskLocalEffect({ kind: 'git', resourceKeys: keys });
        runTaskLocalEffect(policy);
        runTaskLocalEffect({ kind });
        runTaskLocalEffect({ kind: 'git' });
      }
    `,
    )
    const effects = buildTaskOwnedEffectEntries([source])
    expect(effects.entries).toHaveLength(3)
    expect(effects.unknown).toHaveLength(3)
    expect(effects.entries.map((entry) => entry.id)).toEqual(
      buildTaskOwnedEffectEntries([
        unit('modules/task-execution/infrastructure/probe.ts', '\n' + source.text),
      ]).entries.map((entry) => entry.id),
    )
    expect(
      buildTaskOwnedEffectEntries([
        unit('modules/task-execution/application/coordinator.ts', source.text),
      ]).entries,
    ).toEqual([])
  })
  test('code-host matrix uses supplied source literals, candidate order and custom method profiles', () => {
    const units = bindingFixture(),
      entries = buildCodeHostRecoveryBindingManifest(units)
    expect(entries).toHaveLength(15)
    expect(validateCodeHostRecoveryBindingManifest(entries, units)).toEqual([])
    expect(entries.find((entry) => entry.id === 'custom:github:GET')?.recoveryClass).toBe('R-READ')
    expect(
      entries.find((entry) => entry.id === 'comment.update:github:c0')
        ?.compatibilityFallbackAvailable,
    ).toBe(true)
    expect(entries.find((entry) => entry.id === 'comment.update:github:c1')?.path).toBe('/fallback')
    expect(
      entries.find((entry) => entry.id === 'review.submit:github:unsupported')?.supported,
    ).toBe(false)
    expect(
      validateCodeHostRecoveryBindingManifest(entries.slice(1), units).some((error) =>
        error.startsWith('missing'),
      ),
    ).toBe(true)
    expect(validateCodeHostRecoveryBindingManifest([...entries, entries[0]!], units)).toContain(
      'duplicate code-host recovery binding id',
    )
    const mutated = entries.map((entry) => ({ ...entry, path: '/changed' }))
    expect(
      validateCodeHostRecoveryBindingManifest(mutated, units).some((error) =>
        error.startsWith('drifted'),
      ),
    ).toBe(true)
    expect(
      validateCodeHostRecoveryBindingManifest(
        [{ ...entries[0]!, id: 'fabricated', action: 'mr.approve', recoveryClass: 'R-EXACT' }],
        units,
      ).some((error) => error.startsWith('unknown')),
    ).toBe(true)
    expect(() => buildCodeHostRecoveryBindingManifest([])).toThrow('missing code-host source')
  })
})
describe('RFC-376 corrected report inventories', () => {
  test('unregistered owners are reportable, without weakening registered attribution', () => {
    expect(targetContextFor(PREFIX + 'services/fabricated-new-service.ts')).toBe('unregistered')
    expect(targetContextFor(PREFIX + 'services/scheduler.ts')).toBe('task-execution')
    expect(targetContextFor(PREFIX + 'platform/timer.ts')).toBe('platform')
    expect(targetContextFor(PREFIX + 'modules/new-context/domain/a.ts')).toBe('unregistered')
  })
  test('mutable singletons count definitions and top-level let, excluding route registration and bootstrap', () => {
    const text = `let current = null; const values = new Map(); const constant = 1;
      export function setCurrent(value) { current = value }
      export function resetForTests() { current = null }
      export function registerValue(value) { values.set(value.id, value) }
      export function configureNothing() { return constant }
      export function registerRoute() { current = route }
      export function registerBoundOperationHandler() { current = handler }
      function helper() { let local = 1; return local }
      registerRoute('GET', '/', handler)
    `
    const entries = mutableSingletons([
      unit('services/state.ts', text),
      unit('bootstrap/state.ts', text),
      unit('platform/background/maintenanceWorker.ts', text),
      unit('routes/registry.ts', text),
      unit('platform/operations/catalog.ts', text),
    ])
    expect(entries).toHaveLength(4)
    expect(entries.filter((entry) => entry.kind === 'top-level-let')).toHaveLength(1)
    expect(entries.map((entry) => entry.id)).toEqual(
      mutableSingletons([unit('services/state.ts', '\n\n' + text)]).map((entry) => entry.id),
    )
  })
  test('background definitions count handles, managed definitions and recurring timers only', () => {
    const text = `const WORKER_NAME = 'worker'; type Job = {}; const workerSchema = z.object({});
      function recoverHelper() { return 1 }
      const job = defineBackgroundJob({ id: 'job' });
      const worker = defineManagedWorker({ id: 'worker' });
      function start() { setInterval(tick, 1) }
      function loop() { setTimeout(loop, 1) }
      function again() { setTimeout(() => again(), 1) }
      function once() { setTimeout(() => finish(), 1) }
      const handle: DaemonProviderRuntimeHandleFactory = Object.freeze({ id: 'provider-session', start() {} });
      const poll = createPollingDaemonRuntimeHandleFactory({ id: 'poll', run() {} });
      const nested = [{ id: 'nested', start() {} }] satisfies readonly DaemonProviderRuntimeHandleFactory[];
      const ordinary = { id: 'not-a-provider-handle', stop() {}, state() {} };
      function assigned() { const timer = setTimeout(assigned, 1) }

    `
    const entries = backgroundDefinitions([unit('platform/background/jobs.ts', text)])
    expect(entries).toHaveLength(9)
    expect(entries.filter((entry) => entry.kind === 'self-rescheduling-timeout')).toHaveLength(3)
    expect(entries.map((entry) => entry.id)).toEqual(
      backgroundDefinitions([unit('platform/background/jobs.ts', '\n' + text)]).map(
        (entry) => entry.id,
      ),
    )
  })
  test('KNOWN_VIOLATIONS is parsed as data and rejects missing, malformed or executable definitions', () => {
    expect(parseKnownViolations('export const KNOWN_VIOLATIONS = [] as const')).toEqual([])
    expect(
      parseKnownViolations(
        "const B = 'packages/backend/src'; export const KNOWN_VIOLATIONS = [{ rule: 'x', from: `${B}/a.ts`, to: B + '/b.ts', why: 'fixture', removeWhen: 'RFC-376' }]",
      )[0]?.from,
    ).toBe('packages/backend/src/a.ts')
    expect(() => parseKnownViolations('const B = B; export const KNOWN_VIOLATIONS = [B]')).toThrow(
      'cyclic data declaration',
    )

    expect(
      parseKnownViolations(
        "export const KNOWN_VIOLATIONS = [{ rule: 'x', from: 'a', to: 'b', why: 'fixture', removeWhen: 'RFC-376' }]",
      ),
    ).toHaveLength(1)
    for (const text of [
      'export const something = []',
      'export const KNOWN_VIOLATIONS = build()',
      'export const KNOWN_VIOLATIONS = [{}]',
      'export const KNOWN_VIOLATIONS = {}',
    ])
      expect(() => parseKnownViolations(text)).toThrow()
    expect(
      parseKnownViolations(
        "const B = 'src'; export const KNOWN_VIOLATIONS = [...(['a', 'b'] as const).map((file) => ({ rule: 'probe', from: `${B}/${file}.ts`, to: 'target', why: 'fixture', removeWhen: 'RFC-376' }))]",
      ),
    ).toHaveLength(2)
    const scalar = sourceUnit(
      'fixture.ts',
      'const x = { a: true, b: false, c: null, d: 2, e: ["x"] }',
    )
    expect(dataLiteral(declarationInitializer(scalar, 'x'))).toEqual({
      a: true,
      b: false,
      c: null,
      d: 2,
      e: ['x'],
    })
    expect(() => dataLiteral(ts.factory.createIdentifier('executable'))).toThrow()
  })
  test('entry roots are read from the selected build script and workspace exports resolve', () => {
    expect(
      binaryEntries(
        "const mainEntry = join(backendSrc, 'main.ts'); const WORKER_ENTRIES = [join(backendSrc, 'worker.ts')]",
      ),
    ).toEqual([PREFIX + 'main.ts', PREFIX + 'worker.ts'])
    expect(() => binaryEntries('export const fixture = 1')).toThrow('main entry')
    expect(
      workspaceExports('{"exports":{"./tool":"./src/tool.ts",".":{"import":"./src/index.ts"}}}'),
    ).toEqual({ './tool': './src/tool.ts', '.': './src/index.ts' })
  })
})
describe('RFC-376 C7 report-only consumers', () => {
  test('only zero production, import and public-type consumers are reported', () => {
    expect(
      unconsumedPublicSymbols([
        { id: 'dead', consumerEdgeIds: [] },
        { id: 'edge', consumerEdgeIds: ['edge'] },
        { id: 'production', productionConsumers: ['consumer'] },
        { id: 'type', publicTypeConsumerIds: ['contract'] },
      ]).map((entry) => entry.id),
    ).toEqual(['dead'])
  })
  test('embedded assets stay in RFC-375 retention inventory, not executable roots', () => {
    expect(
      binaryEntries(
        "const mainEntry = join(backendSrc, 'main.ts'); const pluginsDir = join(backendSrc, 'services/runtime/opencode/plugin')",
      ),
    ).toEqual([PREFIX + 'main.ts'])
  })
})
describe('RFC-376 committed report contract', () => {
  test('two reads of the same committed source produce byte-identical reports despite working-tree changes', () => {
    const first = buildArchitectureReport(SOURCE)
    const second = buildArchitectureReport(readReportSource(ROOT, SOURCE.sourceSha))
    expect(stableJson(first)).toBe(stableJson(second))
    expect(renderReportStatus(first)).toBe(renderReportStatus(second))
    expect(renderGateBaselines(first)).toBe(renderGateBaselines(second))
    expect(first.sourceSha).toMatch(/^[a-f0-9]{40}$/)
    expect(first.metrics.backendProductionFiles).toBeGreaterThanOrEqual(1500)
    expect(
      first.moduleSymbolOwners.some((entry) => entry.file.startsWith('packages/system-mocks/')),
    ).toBe(false)
    expect(first.counts['node-runs-insert-sites']).toBe(1)
    expect(Object.keys(first.counts)).toHaveLength(21)
    const selected = spawnSync('git', ['show', `${SOURCE.sourceSha}:scripts/depcheck.ts`], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(selected.status).toBe(0)
    expect(first.knownViolations).toEqual(parseKnownViolations(selected.stdout))
    // Report/tests may be uncommitted; the reader still enumerates exactly Git's source paths.
    const listing = spawnSync(
      'git',
      ['ls-tree', '-r', '--name-only', SOURCE.sourceSha, '--', 'packages/backend/src'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    const paths = listing.stdout
      .trim()
      .split('\n')
      .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
      .sort()
    expect(
      SOURCE.units
        .filter((item) => item.path.startsWith(PREFIX))
        .map((item) => item.path)
        .sort(),
    ).toEqual(paths)
  }, 120_000)
  test('report modules import neither production modules nor the retired generator/depcheck executable', () => {
    const files = [
      'architectureReport.ts',
      'rfc328TaskExecutionLedger.ts',
      'rfc294Gates.ts',
      'rfc294Target.ts',
    ]
    for (const file of files) {
      const text = readFileSync(resolve(import.meta.dir, file), 'utf8')
      const edges = importEdges(sourceUnit(file, text))
      expect(
        edges.filter((edge) =>
          /rfc294Canonical|scripts\/depcheck|\/src\/|^@\//.test(edge.specifier),
        ),
      ).toEqual([])
    }
  })
  test('invalid revisions fail without consulting production files on disk', () => {
    expect(() => readReportSource(ROOT, 'rfc376-nonexistent-ref')).toThrow(
      'revision is unavailable',
    )
  })
})
describe('RFC-376 report command', () => {
  test('supported flags preserve defaults and explicit destinations', () => {
    expect(parseReportOptions([])).toEqual({
      sourceRef: 'HEAD',
      out: '.architecture-report/',
      gates: false,
    })
    expect(
      parseReportOptions([
        '--source-ref',
        'HEAD~1',
        '--out',
        '/tmp/probe',
        '--status',
        '/tmp/status.md',
        '--gates',
      ]),
    ).toEqual({ sourceRef: 'HEAD~1', out: '/tmp/probe', status: '/tmp/status.md', gates: true })
    expect(reportOutputPaths('/repo', parseReportOptions(['--out', '/tmp/probe']))).toEqual({
      report: '/tmp/probe/report.json',
      status: '/tmp/probe/status.md',
    })
  })
  test('unknown, duplicate and missing options fail; projection destinations are unavailable', () => {
    for (const args of [
      ['--source-ref'],
      ['--out', '--gates'],
      ['--gates', '--gates'],
      ['--snapshot-sha', 'HEAD'],
      ['--seed-ref', 'HEAD'],
    ])
      expect(() => parseReportOptions(args)).toThrow()
    expect(() => reportOutputPaths('/repo', parseReportOptions(['--out', 'architecture']))).toThrow(
      'cannot overwrite',
    )
    expect(() =>
      reportOutputPaths(
        '/repo',
        parseReportOptions([
          '--status',
          'design/RFC-294-backend-layered-target-architecture/status.md',
        ]),
      ),
    ).toThrow('cannot overwrite')
    expect(() =>
      reportOutputPaths(
        '/repo',
        parseReportOptions(['--status', '.architecture-report/report.json']),
      ),
    ).toThrow('must differ')
  })
})
