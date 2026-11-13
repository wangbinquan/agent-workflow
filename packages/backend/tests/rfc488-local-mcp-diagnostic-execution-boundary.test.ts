// RFC-488 — resource-catalog 本机 MCP 诊断的运行时工作改经自有端口（RFC-294 §4.7 运行时驱动一族第二步）。
//
// 锁四件事：
// ① resource-catalog 的全部生产文件不 import 运行时驱动一族（`services/runtime/**` 与 `services/execution/{agentInjection,
//    workspaceBoundary,taskExecutionResourceDependencies}`、`services/{driverLease,runtimeSmoke,systemAgentRun}`）；相对路径、
//    `@/` 别名、re-export 与动态 import 都认，带负对照。
// ② 本机执行体只经端口做运行时相关的工作：文件里没有驱动、启动上下文、假运行与启动校验的标识符；依赖收必填的 `execution`、
//    不收 `runFn`；`LocalMcpDiagnosticExecution` 只在 resource-catalog 的 `application/ports` 声明一次、经
//    `composition/required-ports.ts` 转出；观测类型与托管端口共用一份（`McpDiagnosticObservation`）。
// ③ task-execution 的本机实现在 `infrastructure/local/mcpDiagnosticRunner.ts`，经 `composition/localMcpDiagnosticRunner.ts` 交出；
//    bootstrap 的观测模块用它绑定，守护进程阶段给了夹具时选本机装配（unstarted scope 照旧自己组装并登记释放）；resource-catalog
//    里不再出现 `runFn`（CrewStation 的诊断装配不再按夹具分支）；本机实现在类型上就是 resource-catalog 的端口；
//    `windows-platform.yml` 的两份路径过滤登记这条链的新位置（RFC-487 的做法）。
// ④ 行为（本机实现的纯函数，与原本机执行体逐项对拍）：真运行的启动上下文与包裹、假运行的最小计划、观测与续会话只在真运行带上、
//    启动校验只对真运行的成功轮次做且声明清单缺失时报错；`executable` 登记优先、缺省取驱动；跨轮会话支持与原生会话号取驱动。
//
// 覆盖范围（C12）：① 读 resource-catalog 全部生产文件（语料下限 350）；②③ 读指定文件与全部生产文件里的同名声明；④ 单元。
import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import {
  DEFAULT_CONFIG_DIR_PROFILE,
  observationForVerification,
  verifyStartup,
  type DeclaredInjectionManifest,
  type Mcp,
} from '@agent-workflow/shared'
import type { LocalMcpDiagnosticExecution } from '@/modules/resource-catalog/composition/required-ports'
import { createLocalMcpDiagnosticRunner } from '@/modules/task-execution/composition/localMcpDiagnosticRunner'
// RFC-491: the runner and its two pure halves read the driver through bootstrap's native system-agent run providers.
import { localNativeSystemAgentRunProviders } from '@/bootstrap/runFamilyProviders'
import {
  localMcpDiagnosticRunOptions,
  verifyLocalMcpDiagnosticTurn,
  type LocalMcpDiagnosticRunRequest,
} from '@/modules/task-execution/infrastructure/local/mcpDiagnosticRunner'
import { getRuntimeDriver } from '@/services/runtime'
import type { AgentSpawnPlan } from '@/services/runtime/types'
import type { SystemAgentRunResult } from '@/modules/task-execution/infrastructure/local/nativeSystemAgentRun'
import { createLogger } from '@/util/log'

const SRC = resolve(import.meta.dir, '..', 'src')
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}
const filesOf = (dir: string) => walk(join(SRC, dir)).map((path) => slash(relative(SRC, path)))

/** Static and dynamic module specifiers of a file, relative ones resolved to `src`-relative paths. */
function specifiers(path: string, text: string): string[] {
  const out: string[] = []
  const add = (specifier: string) =>
    out.push(
      specifier.startsWith('.')
        ? slash(relative(SRC, resolve(dirname(join(SRC, path)), specifier)))
        : specifier.startsWith('@/')
          ? specifier.slice(2)
          : specifier,
    )
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    )
      add(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, text))
  return out
}

const FAMILY_FILES = new Set([
  'services/execution/agentInjection',
  'services/execution/workspaceBoundary',
  'services/execution/taskExecutionResourceDependencies',
  'services/driverLease',
  'services/runtimeSmoke',
  'services/systemAgentRun',
])
function inFamily(target: string): boolean {
  const bare = target.replace(/\.[cm]?tsx?$/, '').replace(/\/index$/, '')
  return (
    bare === 'services/runtime' || bare.startsWith('services/runtime/') || FAMILY_FILES.has(bare)
  )
}
function familyImports(path: string, text: string): string[] {
  return specifiers(path, text)
    .filter(inFamily)
    .map((target) => `${path} -> ${target}`)
}

/** Every identifier written in a file (comments and string contents excluded). */
function identifiers(path: string, text: string): Set<string> {
  const out = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) out.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, text))
  return out
}

const TEXTS = new Map<string, string>()
/** A production file's text, read once for all the whole-corpus scans below. */
function sourceText(path: string): string {
  let content = TEXTS.get(path)
  if (content === undefined) TEXTS.set(path, (content = read(path)))
  return content
}

/**
 * Every production declaration of `name` (function, interface or type alias), as `src`-relative paths. Only a file whose
 * text contains `name` can declare it, so only those are parsed (a whole-corpus AST pass per name exceeds bun's default
 * 5 s on a loaded runner — docs/dev-gotchas.md, RFC-403 / RFC-487).
 */
function declarationsOf(name: string, files: readonly string[]): string[] {
  return files.filter(
    (path) =>
      sourceText(path).includes(name) &&
      parse(path, sourceText(path)).statements.some(
        (statement) =>
          (ts.isFunctionDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement)) &&
          statement.name?.text === name,
      ),
  )
}

const RESOURCE_CATALOG = filesOf('modules/resource-catalog')
const PRODUCTION = filesOf('.')
const EFFECTS = 'modules/resource-catalog/infrastructure/local/mcpDiagnosticsEffects.ts'
const PORT = 'modules/resource-catalog/application/ports/localMcpDiagnosticExecution.ts'
const RUNNER = 'modules/task-execution/infrastructure/local/mcpDiagnosticRunner.ts'

describe('RFC-488 ① resource-catalog 不取运行时驱动一族', () => {
  test('resource-catalog 的全部生产文件不 import 一族', () => {
    expect(RESOURCE_CATALOG.length).toBeGreaterThanOrEqual(350)
    expect(RESOURCE_CATALOG).toContain(EFFECTS)
    expect(RESOURCE_CATALOG.flatMap((path) => familyImports(path, sourceText(path)))).toEqual([])
  })

  test('负对照：相对路径、别名、re-export 与动态 import 都会被认出', () => {
    const path = 'modules/resource-catalog/infrastructure/local/probe.ts'
    const fixture = [
      "import { getRuntimeDriver } from '../../../../services/runtime'",
      "import type { SpawnPlan } from '@/services/runtime/types'",
      "export { runSystemAgent } from '@/services/systemAgentRun'",
      "const later = () => import('@/services/runtime/index')",
      "import type { McpDiagnosticObservation } from '../../application/ports/mcpDiagnosticExecution'",
      "import { notFamily } from '@/services/mergeAgent'",
    ].join('\n')
    expect(familyImports(path, fixture)).toEqual([
      `${path} -> services/runtime`,
      `${path} -> services/runtime/types`,
      `${path} -> services/systemAgentRun`,
      `${path} -> services/runtime/index`,
    ])
  })
})

describe('RFC-488 ② 本机执行体只经端口做运行时相关的工作', () => {
  test('本机执行体里没有驱动、启动上下文、假运行与启动校验的标识符', () => {
    const names = identifiers(EFFECTS, sourceText(EFFECTS))
    // Positive control: the file is the local family and it calls the port.
    expect(names.has('createLocalMcpDiagnosticsEffects')).toBe(true)
    expect(names.has('execution')).toBe(true)
    for (const forbidden of [
      'getRuntimeDriver',
      'runSystemAgent',
      'buildCtx',
      'wrapPlan',
      'testPlanOverride',
      'observationForVerification',
      'verifyStartup',
      'mcpTestSessionReference',
      'createMcpTestNativeSessionId',
      'defaultBinary',
      'DEFAULT_CONFIG_DIR_PROFILE',
      'runFn',
    ])
      expect([forbidden, names.has(forbidden)]).toEqual([forbidden, false])
  })

  test('依赖收必填的 execution、不收 runFn', () => {
    const sf = parse(EFFECTS, sourceText(EFFECTS))
    const deps = sf.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) &&
        statement.name.text === 'McpDiagnosticsEffectDependencies',
    )
    expect(deps).toBeDefined()
    const members = new Map(
      deps!.members.map((member) => [member.name?.getText(sf), member] as const),
    )
    expect(members.has('execution')).toBe(true)
    expect(members.get('execution')!.questionToken).toBeUndefined()
    expect(members.get('execution')!.getText(sf)).toContain('LocalMcpDiagnosticExecution')
    expect(members.has('runFn')).toBe(false)
  })

  test('端口只在 resource-catalog 的 application/ports 声明一次，经 required-ports 转出；观测类型与托管端口共用', () => {
    expect(declarationsOf('LocalMcpDiagnosticExecution', PRODUCTION)).toEqual([PORT])
    expect(declarationsOf('McpDiagnosticObservation', PRODUCTION)).toEqual([
      'modules/resource-catalog/application/ports/mcpDiagnosticExecution.ts',
    ])
    expect(read('modules/resource-catalog/composition/required-ports.ts')).toContain(
      "export type { LocalMcpDiagnosticExecution } from '../application/ports/localMcpDiagnosticExecution'",
    )
    expect(read(PORT)).toContain(
      "import type { McpDiagnosticObservation } from './mcpDiagnosticExecution'",
    )
    expect(read('modules/resource-catalog/application/ports/mcpDiagnosticExecution.ts')).toContain(
      'readonly observe?: McpDiagnosticObservation',
    )
  })
})

describe('RFC-488 ③ task-execution 实现端口，bootstrap 绑定', () => {
  test('本机实现在 task-execution 的 infrastructure/local，经 composition 交出', () => {
    for (const name of [
      'createLocalMcpDiagnosticRunner',
      'localMcpDiagnosticRunOptions',
      'verifyLocalMcpDiagnosticTurn',
    ])
      expect([name, declarationsOf(name, PRODUCTION)]).toEqual([name, [RUNNER]])
    expect(read('modules/task-execution/composition/localMcpDiagnosticRunner.ts')).toContain(
      "} from '../infrastructure/local/mcpDiagnosticRunner'",
    )
    // Type-level: the runner is Resource Catalog's port.
    const execution: LocalMcpDiagnosticExecution = createLocalMcpDiagnosticRunner(
      {},
      localNativeSystemAgentRunProviders,
    )
    expect(typeof execution.run).toBe('function')
  })

  test('bootstrap 的观测模块建本机实现，守护进程阶段给了夹具时选本机装配；resource-catalog 里不再出现 runFn', () => {
    const observation = read('bootstrap/daemonModules/observation.ts')
    // RFC-491: the observation module takes bootstrap's selection, which builds the runner over the native system-agent
    // run providers.
    expect(observation).toContain('execution: composeLocalMcpDiagnosticRunnerSelection(')
    expect(read('bootstrap/runFamilyProviders.ts')).toContain(
      'return createLocalMcpDiagnosticRunner(input, localNativeSystemAgentRunProviders)',
    )
    expect(observation).toContain('{ fixture: { runFn: mcpRunFixture } }')
    // One diagnostics family per composition, the adapter's selection; a test fixture selects the local family in the
    // daemon phase, and the unstarted scope keeps composing (and tracking) its own local family.
    expect(observation).toContain('const mcpRuntimeTests = input.adapters.mcpDiagnostics({')
    expect(read('bootstrap/daemonApplication.ts').replace(/\s+/g, ' ')).toContain(
      "mcpDiagnostics: phase.kind !== 'daemon' ? phase.scope.createMcpRuntimeTests : " +
        'input.testSeams?.mcpRuntimeTestDependencies?.runFn === undefined ? input.mcpDiagnostics : ' +
        'composeLocalMcpDiagnostics,',
    )
    expect(
      RESOURCE_CATALOG.filter(
        (path) =>
          sourceText(path).includes('runFn') && identifiers(path, sourceText(path)).has('runFn'),
      ),
    ).toEqual([])
  })

  test('windows-platform 的两份路径过滤都登记本机实现链的新位置（端口、实现、composition 与 bootstrap 的绑定）', () => {
    const workflow = readFileSync(
      resolve(SRC, '..', '..', '..', '.github', 'workflows', 'windows-platform.yml'),
      'utf8',
    )
    const listed = [...workflow.matchAll(/^\s*- '([^']+)'\s*$/gm)].map((match) => match[1]!)
    // Positive control: the local family's own file is registered in both filters.
    expect(listed.filter((entry) => entry === `packages/backend/src/${EFFECTS}`)).toHaveLength(2)
    for (const path of [
      PORT,
      RUNNER,
      'modules/task-execution/composition/localMcpDiagnosticRunner.ts',
      'bootstrap/daemonModules/observation.ts',
    ]) {
      expect(existsSync(join(SRC, path))).toBe(true)
      expect([
        path,
        listed.filter((entry) => entry === `packages/backend/src/${path}`).length,
      ]).toEqual([path, 2])
    }
  })
})

const MCP = Object.freeze({ id: 'mcp-1', name: 'probe' }) as unknown as Mcp
const log = createLogger('rfc488-test')

function request(
  overrides: Partial<LocalMcpDiagnosticRunRequest> = {},
): LocalMcpDiagnosticRunRequest {
  const sink = {
    append: async () => {},
    markRootSessionResetPending: async () => {},
    setRootSessionId: async () => {},
    markTerminal: async () => {},
  }
  return {
    feature: 'mcp-runtime-test',
    protocol: 'claude-code',
    agentName: 'aw-mcp-runtime-test',
    systemPrompt: 'diagnose the MCP',
    prompt: 'list your tools',
    scratch: {
      parent: '/scratch/mcp-runtime-tests',
      name: 'session-1',
      root: '/persisted/session-1',
    },
    turn: { id: 'turn-2', seq: 2 },
    mcp: MCP,
    binary: '/bin/claude',
    runtime: {
      protocol: 'claude-code',
      model: 'model-a',
      variant: null,
      temperature: 0.5,
      steps: null,
      maxSteps: 7,
      isSandbox: true,
      configDirEnv: null,
      configDirName: 'custom-dir',
    },
    nativeSessionId: 'native-1',
    observe: async () => {
      throw new Error('not opened in this test')
    },
    resumeSessionId: 'native-1',
    timeoutMs: 1_000,
    maxEventTextBytes: 10,
    maxRawFrameBytes: 20,
    signal: new AbortController().signal,
    sink,
    beforeSpawn: async () => {},
    onSpawned: async () => {},
    ...overrides,
  }
}

const DECLARED: DeclaredInjectionManifest = {
  mcpServers: ['probe'],
  skippedDisabledMcps: [],
  skills: [],
  subagents: [],
  plugins: [],
  tools: null,
  droppedParams: [],
  unsupported: [],
  unobservable: [],
}

function result(overrides: Partial<SystemAgentRunResult> = {}): SystemAgentRunResult {
  return {
    status: 'ok',
    exitCode: 0,
    stderrTail: '',
    durationMs: 5,
    ...overrides,
  } as SystemAgentRunResult
}

const drivers = localNativeSystemAgentRunProviders.drivers

describe('RFC-488 ④ 本机实现的行为与原本机执行体一致', () => {
  test('真运行：选项、观测与续会话、启动上下文逐字段等于原组装', () => {
    const req = request()
    const opts = localMcpDiagnosticRunOptions(req, { fixture: false, log }, drivers)
    expect(opts).toMatchObject({
      feature: 'mcp-runtime-test',
      agentName: 'aw-mcp-runtime-test',
      systemPrompt: 'diagnose the MCP',
      prompt: 'list your tools',
      protocol: 'claude-code',
      runtimeBinary: '/bin/claude',
      model: 'model-a',
      scratchParent: '/scratch/mcp-runtime-tests',
      scratchName: 'session-1',
      timeoutMs: 1_000,
      maxEventTextBytes: 10,
      maxRawFrameBytes: 20,
      nativeIdentityAuthoritative: true,
      retainScratchOnSuccess: true,
      resumeSessionId: 'native-1',
    })
    expect(opts.abortSignal).toBe(req.signal)
    expect(opts.eventSink).toBe(req.sink)
    expect(opts.observe).toBe(req.observe)
    expect(opts.onSpawned).toBe(req.onSpawned)
    expect(opts.testPlanOverride).toBeUndefined()
    const ctx = opts.buildCtx!({
      driver: getRuntimeDriver('claude-code'),
      worktreePath: '/work',
      runDir: '/run',
      log,
    })
    const defaults = DEFAULT_CONFIG_DIR_PROFILE['claude-code']
    expect(ctx).toEqual({
      injection: { mcps: [MCP] },
      prompt: 'list your tools',
      agentName: 'aw-mcp-runtime-test',
      systemPrompt: 'diagnose the MCP',
      resolvedParamsByAgent: new Map([
        [
          'aw-mcp-runtime-test',
          {
            model: 'model-a',
            variant: null,
            temperature: 0.5,
            steps: null,
            maxSteps: 7,
            isSandbox: true,
          },
        ],
      ]),
      cwd: '/work',
      runRoot: join('/run', 'turns', 'turn-2'),
      configDir: { env: defaults.env, name: 'custom-dir' },
      runtimeBinary: '/bin/claude',
      freshAgentRun: true,
      ...getRuntimeDriver('claude-code').mcpTestSessionReference?.({
        turnSeq: 2,
        nativeSessionId: 'native-1',
      }),
      nodeRunId: 'turn-2',
      log,
    })
  })

  test('真运行的包裹只有两处：先过驱动的闸再过诊断的闸，清理时删掉本轮的 mcp-config.json', async () => {
    const order: string[] = []
    const opts = localMcpDiagnosticRunOptions(
      request({ beforeSpawn: async () => void order.push('diagnostic-gate') }),
      { fixture: false, log },
      drivers,
    )
    const runDir = mkdtempSync(join(tmpdir(), 'rfc488-'))
    try {
      const turnDir = join(runDir, 'turns', 'turn-2')
      mkdirSync(turnDir, { recursive: true })
      writeFileSync(join(turnDir, 'mcp-config.json'), '{}')
      writeFileSync(join(turnDir, 'inventory.json'), '{}')
      const base = {
        beforeSpawn: async () => void order.push('driver-gate'),
        cleanup: async () => void order.push('driver-cleanup'),
      } as unknown as AgentSpawnPlan
      const wrapped = await opts.wrapPlan!(base, {
        driver: getRuntimeDriver('claude-code'),
        worktreePath: '/work',
        runDir,
        log,
      })
      expect(Object.keys(wrapped).sort()).toEqual(['beforeSpawn', 'cleanup'])
      await wrapped.beforeSpawn!()
      expect(order).toEqual(['driver-gate', 'diagnostic-gate'])
      await wrapped.cleanup!()
      expect(order).toEqual(['driver-gate', 'diagnostic-gate', 'driver-cleanup'])
      expect(existsSync(join(turnDir, 'mcp-config.json'))).toBe(false)
      expect(existsSync(join(turnDir, 'inventory.json'))).toBe(true)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  test('观测与续会话只在调用方给了时带上（真运行）；假运行一律不带，并给最小计划', () => {
    const plain = localMcpDiagnosticRunOptions(
      request({ observe: undefined, resumeSessionId: undefined }),
      { fixture: false, log },
      drivers,
    )
    expect('observe' in plain).toBe(false)
    expect('resumeSessionId' in plain).toBe(false)
    const req = request()
    const fixture = localMcpDiagnosticRunOptions(req, { fixture: true, log }, drivers)
    expect('observe' in fixture).toBe(false)
    expect('resumeSessionId' in fixture).toBe(false)
    expect(fixture.buildCtx).toBeUndefined()
    expect(fixture.wrapPlan).toBeUndefined()
    expect(fixture.onSpawned).toBe(req.onSpawned)
    const plan = fixture.testPlanOverride!({
      driver: getRuntimeDriver('claude-code'),
      worktreePath: '/work',
      runDir: '/run',
      log,
    })
    expect(plan).toEqual({
      cmd: ['/bin/claude'],
      env: {},
      stdin: { mode: 'ignore' },
      beforeSpawn: req.beforeSpawn,
    })
  })

  test('启动校验只对真运行的成功轮次做；声明清单缺失时报错；结果与 shared 的判据一致', async () => {
    const req = request()
    expect(
      await verifyLocalMcpDiagnosticTurn(req, result(), { fixture: true }, drivers),
    ).toBeUndefined()
    expect(
      await verifyLocalMcpDiagnosticTurn(
        req,
        result({ status: 'timeout' }),
        { fixture: false },
        drivers,
      ),
    ).toBeUndefined()
    await expect(
      verifyLocalMcpDiagnosticTurn(req, result(), { fixture: false }, drivers),
    ).rejects.toThrow('mcp-test declared manifest missing from run result (assembly seam broken)')
    const driver = getRuntimeDriver('claude-code')
    const expected = verifyStartup(
      DECLARED,
      await observationForVerification(driver.capabilities, {
        claudeInit: null,
        loadSnapshot: async () => null,
      }),
    )
    expect(
      await verifyLocalMcpDiagnosticTurn(
        req,
        result({ declared: DECLARED }),
        { fixture: false },
        drivers,
      ),
    ).toEqual(expected)
  })

  test('跨轮会话支持、原生会话号与可执行文件取驱动，登记的可执行文件优先', () => {
    const runner = createLocalMcpDiagnosticRunner({}, localNativeSystemAgentRunProviders)
    for (const protocol of ['opencode', 'claude-code'] as const) {
      const driver = getRuntimeDriver(protocol)
      expect(runner.supportsSession(protocol)).toBe(driver.mcpTestSessionReference !== undefined)
      // claude-code mints a fresh UUID per call; opencode reports null (its server assigns the id).
      const sample = driver.createMcpTestNativeSessionId?.() ?? null
      const id = runner.createNativeSessionId(protocol)
      expect([protocol, id === null]).toEqual([protocol, sample === null])
      if (sample !== null) expect(id).not.toBe(sample)
      expect(runner.executable(protocol, '/registered/bin', {})).toBe('/registered/bin')
      const configuration = { opencodePath: '/custom/opencode', claudeCodePath: '/custom/claude' }
      expect(runner.executable(protocol, null, configuration)).toBe(
        driver.defaultBinary(configuration)[0],
      )
    }
  })
})
