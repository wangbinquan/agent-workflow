// RFC-454 — `services/` 一跳转出清仓（RFC-294 W9-D 第一步）。
//
// 锁四件事：
// ① 30 个只做 `export … from` 的转出与 resource-catalog legacy 目录里随之失去消费方的 3 个文件已删除，`src/` 与用例里零 import
//    （census AST，别名与相对路径都认，带负对照）；余下 5 个转出（RFC-466 删去 `services/workgroups`）的生产消费方清单精确相等（不增）。
// ② 被转出藏住的越界依赖按真实使用者下沉后的行为不变：task-execution `domain/clarifyRules` 的四个澄清判定、resource-catalog
//    `domain/callClosure` 的闭包编解码与边键、平台 `scriptInterpreter` 的解释器登记、shared 的 workgroup 宿主节点 id 与
//    collaboration `domain` 的澄清提问者键、shared 的 `stringifyWorkflowYaml` / `extractWorkflowAgentRefs`。
// ③ 原位置不再导出迁走的名字（不留第二份定义）；resource-catalog 的 public 入口导出的就是 domain 里的那一份。
// ④ event-center 与平台不再取 task-execution / resource-catalog（它们此前经 `services/scriptRun` / `services/workflow.yaml` 越界）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  extractWorkflowAgentRefs,
  stringifyWorkflowYaml,
  stringifyWorkflowYamlDocument,
  WORKGROUP_TURN_CLARIFY_NODE_ID,
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import {
  computeRemaining,
  findClarifyNode,
  resolveEffectiveClarifyChannel,
  shouldInjectStopNotice,
} from '@/modules/task-execution/domain/clarifyRules'
import * as callClosure from '@/modules/resource-catalog/domain/callClosure'
import * as launchInputs from '@/modules/resource-catalog/domain/workflowLaunchInputs'
import * as rcQueries from '@/modules/resource-catalog/public/queries'
import { INTERPRETER_SPEC } from '@/platform/execution/local/scriptInterpreter'
import { wgClarifyAskerKeyForRound } from '@/modules/collaboration/domain/workgroupClarifyAskerKey'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RC = 'modules/resource-catalog/'

const DELETED = [
  'services/backup',
  'services/backupManifest',
  'services/backupScheduler',
  'services/clarify/autoDispatch',
  'services/clarify/rerunLedger',
  'services/clarify/rounds',
  'services/clarify/service',
  'services/clarifyDecision',
  'services/clarifyRerunLedger',
  'services/clarifyRounds',
  'services/execution/closure',
  'services/execution/managedProcess',
  'services/execution/resolveInjection',
  'services/execution/taskEngineRuntimeOptions',
  'services/lifecycle',
  'services/pendingRestore',
  'services/pluginInstaller',
  'services/protocol',
  'services/resourceRefs',
  'services/restore',
  'services/runner',
  'services/runtime/usage',
  'services/scriptDepsEnv',
  'services/scriptRun',
  'services/taskQuestionDispatch',
  'services/taskQuestions',
  'services/workflow.yaml',
  'services/workflowLaunchInputs',
  'services/workgroup/askerKey',
  'services/workgroup/constants',
  RC + 'infrastructure/legacy/workflowLaunchInputs',
  RC + 'infrastructure/legacy/workgroup/askerKey',
  RC + 'infrastructure/legacy/workgroup/constants',
]

/** The one-hop re-exports this RFC leaves, with their exact production consumers (design §4). */
const REMAINING: Readonly<Record<string, readonly string[]>> = {
  // RFC-461: memory's distill work-store port takes `SystemAgentEventSinkV1` from runtime-management `public/participants`.
  // RFC-464: intent's turn sink implements the contract its own system-agent port declares.
  'services/sessionEventSink': [
    'modules/memory/infrastructure/memoryDistillSessionEventSink.ts',
    'modules/memory/infrastructure/memoryDistillWorkStore.ts',
    'services/runtime/opencode/sessionCapture.ts',
    'services/systemAgentRun.ts',
  ],
  // RFC-466: `services/taskLaunchGate.ts` no longer reads `services/workflow` (its full gate moved to the test helpers);
  // `services/workgroups` is deleted — its only production consumer, `legacyCallClosure`, moved to the test helpers.
  'services/workflow': ['modules/task-execution/infrastructure/taskRouteOperations.ts'],
  'services/workflow.validator': ['services/task.ts', 'services/taskLaunchGate.ts'],
  'services/skillBootVerify': [
    'modules/task-execution/infrastructure/legacyTaskExecutionInjectionResolver.ts',
  ],
  'services/skillIdentityPaths': [
    'modules/task-execution/infrastructure/legacyTaskExecutionInjectionResolver.ts',
  ],
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** 说明符解析到 `src/` 下的路径（不带扩展名）；包名等非本地说明符返回 null。 */
function targetOf(from: string, specifier: string): string | null {
  let target: string
  if (specifier.startsWith('@/')) target = specifier.slice(2)
  else if (specifier.startsWith('.')) {
    target = relative(SRC, resolve(from, '..', specifier))
      .split('\\')
      .join('/')
  } else return null
  return target.replace(/\.[cm]?tsx?$/, '')
}

/** `file -> target` for every import / re-export whose target satisfies `matches`. */
function importsMatching(files: readonly string[], matches: (target: string) => boolean): string[] {
  return files.flatMap((path) => {
    const rel = relative(REPO_ROOT, path).split('\\').join('/')
    const unit = sourceUnit(rel, readFileSync(path, 'utf8'))
    return [...new Set(importEdges(unit).map((edge) => targetOf(path, edge.specifier)))]
      .filter((target): target is string => target !== null && matches(target))
      .map((target) => `${relative(SRC, path).split('\\').join('/')} -> ${target}`)
  })
}

const isDeleted = (target: string) => DELETED.includes(target)

describe('RFC-454 —— 转出删除', () => {
  test('30 个转出与 3 个失去消费方的 legacy 文件都不存在', () => {
    for (const file of DELETED)
      expect([file, existsSync(join(SRC, `${file}.ts`))]).toEqual([file, false])
  })

  test('src/ 与用例里零 import 这些文件', () => {
    expect(importsMatching(walk(SRC), isDeleted)).toEqual([])
    expect(importsMatching(walk(TESTS), isDeleted)).toEqual([])
  }, 60_000)

  test('余下 5 个转出的生产消费方精确相等（不增）', () => {
    const files = walk(SRC)
    for (const [facade, consumers] of Object.entries(REMAINING)) {
      expect(existsSync(join(SRC, `${facade}.ts`))).toBe(true)
      const observed = importsMatching(files, (target) => target === facade)
        .map((edge) => edge.split(' -> ')[0])
        .sort()
      expect([facade, observed]).toEqual([facade, [...consumers].sort()])
    }
  }, 60_000)

  test('负对照：判据认得出别名与相对路径，也不误伤同前缀的文件', () => {
    const probe = join(SRC, 'modules', 'collaboration', 'infrastructure', 'probe.ts')
    expect(isDeleted(targetOf(probe, '@/services/taskQuestions') ?? '')).toBe(true)
    expect(isDeleted(targetOf(probe, '../../../services/clarify/service.ts') ?? '')).toBe(true)
    expect(isDeleted(targetOf(probe, './taskQuestions') ?? '')).toBe(false)
    expect(isDeleted(targetOf(probe, '@/services/taskQuestionsExtra') ?? '')).toBe(false)
  })
})

describe('RFC-454 —— 澄清判定（task-execution domain）', () => {
  test('有效反问通道：通道 ∧ 无 stop 指令 ∧ 无节点 stop ∧（非复审或澄清续跑）', () => {
    const base = {
      hasClarifyChannel: true,
      nodeStopOverride: false,
      reviewActive: false,
      isClarifyRerun: false,
    }
    expect(resolveEffectiveClarifyChannel(base)).toBe(true)
    expect(resolveEffectiveClarifyChannel({ ...base, hasClarifyChannel: false })).toBe(false)
    expect(resolveEffectiveClarifyChannel({ ...base, contextDirective: 'stop' })).toBe(false)
    expect(resolveEffectiveClarifyChannel({ ...base, contextDirective: 'continue' })).toBe(true)
    expect(resolveEffectiveClarifyChannel({ ...base, nodeStopOverride: true })).toBe(false)
    expect(resolveEffectiveClarifyChannel({ ...base, reviewActive: true })).toBe(false)
    expect(
      resolveEffectiveClarifyChannel({ ...base, reviewActive: true, isClarifyRerun: true }),
    ).toBe(true)
  })

  test('stop 提示恰好注入一次：节点 stop 且上下文没带 stop', () => {
    expect(shouldInjectStopNotice({ nodeStopOverride: false })).toBe(false)
    expect(shouldInjectStopNotice({ nodeStopOverride: true })).toBe(true)
    expect(shouldInjectStopNotice({ nodeStopOverride: true, contextDirective: 'continue' })).toBe(
      true,
    )
    expect(shouldInjectStopNotice({ nodeStopOverride: true, contextDirective: 'stop' })).toBe(false)
  })

  test('循环剩余次数与澄清节点查找', () => {
    const definition = {
      nodes: [
        { id: 'loop', kind: 'wrapper-loop', nodeIds: ['a'], maxIterations: 5 },
        { id: 'a', kind: 'agent-single' },
        { id: 'c', kind: 'clarify' },
        { id: 'x', kind: 'agent-single' },
      ],
      edges: [],
    } as unknown as WorkflowDefinition
    expect(computeRemaining(definition, 'a', 2)).toBe('3')
    expect(computeRemaining(definition, 'a', 9)).toBe('0')
    expect(computeRemaining(definition, 'x', 0)).toBe('')
    // 成员改经 RFC-339 的唯一读者 directNodeIdsOf 取：非数组成员、非字符串项、非循环包装、缺上限的与原写法同解。
    const odd = {
      nodes: [
        { id: 'git', kind: 'wrapper-git', nodeIds: ['b'] },
        { id: 'l1', kind: 'wrapper-loop', nodeIds: 'b', maxIterations: 4 },
        { id: 'l2', kind: 'wrapper-loop', nodeIds: [7, 'b'], maxIterations: 0 },
        { id: 'l3', kind: 'wrapper-loop', nodeIds: [null, 'b'], maxIterations: 6 },
      ],
      edges: [],
    } as unknown as WorkflowDefinition
    expect(computeRemaining(odd, 'b', 1)).toBe('5')
    expect(computeRemaining(odd, '7', 1)).toBe('')
    expect(
      computeRemaining({ nodes: [], edges: [] } as unknown as WorkflowDefinition, 'b', 0),
    ).toBe('')
    expect(findClarifyNode(definition, 'c')?.id).toBe('c')
    expect(findClarifyNode(definition, 'x')).toBeUndefined()
  })
})

describe('RFC-454 —— 调用闭包编解码与启动输入校验（resource-catalog domain）', () => {
  test('v1 / v2 形状、空与坏输入、边键', () => {
    expect(callClosure.parseCallClosure(null)).toBeNull()
    expect(callClosure.parseCallClosure('')).toBeNull()
    expect(callClosure.parseCallClosure('{bad')).toBeNull()
    expect(callClosure.parseCallClosure('{}')).toBeNull()
    expect(callClosure.parseCallClosure('{"workflows":{}}')).toEqual({
      workflows: {},
      workgroups: {},
    })
    expect(callClosure.parseCallClosure('{"closureVersion":2,"workflows":{}}')).toEqual({
      closureVersion: 2,
      workflows: {},
      workgroups: {},
    })
    expect(
      callClosure.parseCallClosure('{"workflows":{},"workgroups":{"g":{"id":"G","version":1}}}'),
    ).toBeNull()
    expect(callClosure.callEdgeKey('wf-1', 'call-1')).toBe('wf-1#call-1')
    expect(() => callClosure.parseFrozenWorkgroupGroup({} as never)).toThrow()
  })

  test('resource-catalog public 导出的就是 domain 里的那一份', () => {
    // RFC-466: callEdgeKey 唯一的模块外读者（task-execution 的调用闭包预言）已迁入用例树，它退出 public。
    expect('callEdgeKey' in rcQueries).toBe(false)
    expect(rcQueries.parseCallClosure).toBe(callClosure.parseCallClosure)
    expect(rcQueries.childClosureSubset).toBe(callClosure.childClosureSubset)
    expect(rcQueries.frozenWorkflowFromClosure).toBe(callClosure.frozenWorkflowFromClosure)
    expect(rcQueries.frozenWorkgroupFromClosure).toBe(callClosure.frozenWorkgroupFromClosure)
    expect(rcQueries.parseFrozenWorkgroupGroup).toBe(callClosure.parseFrozenWorkgroupGroup)
    expect(rcQueries.assertWorkflowLaunchInputs).toBe(launchInputs.assertWorkflowLaunchInputs)
  })
})

describe('RFC-454 —— 下沉到平台 / shared / collaboration 的纯件', () => {
  test('脚本解释器登记：三种语言的二进制、扩展名与 argv', () => {
    expect(Object.keys(INTERPRETER_SPEC).sort()).toEqual(['bash', 'node', 'python'])
    expect(INTERPRETER_SPEC.python.binary).toBe('python3')
    expect(INTERPRETER_SPEC.python.ext).toBe('py')
    expect(INTERPRETER_SPEC.python.argv('/usr/bin/python3', 's.py')).toEqual([
      '/usr/bin/python3',
      '-u',
      's.py',
    ])
    expect(INTERPRETER_SPEC.bash.ext).toBe('sh')
    expect(INTERPRETER_SPEC.node.ext).toBe('mjs')
    expect(INTERPRETER_SPEC.node.argv('node', 's.mjs')).toEqual(['node', 's.mjs'])
  })

  test('workgroup 宿主节点 id 的线上取值与澄清提问者键', () => {
    expect([
      WORKGROUP_TURN_LEADER_NODE_ID,
      WORKGROUP_TURN_MEMBER_NODE_ID,
      WORKGROUP_TURN_CLARIFY_NODE_ID,
    ]).toEqual(['__wg_leader__', '__wg_member__', '__wg_clarify__'])
    expect(wgClarifyAskerKeyForRound(WORKGROUP_TURN_LEADER_NODE_ID, null)).toBe('leader')
    expect(wgClarifyAskerKeyForRound(WORKGROUP_TURN_MEMBER_NODE_ID, null)).toBe('leader')
    expect(wgClarifyAskerKeyForRound('plain-node', null)).toBe('')
    expect(wgClarifyAskerKeyForRound('plain-node', 'shard-3')).toBe('shard-3')
  })

  test('stringifyWorkflowYaml 是 stringifyWorkflowYamlDocument 带 id 的适配；extractWorkflowAgentRefs 只取代理节点', () => {
    const definition = WorkflowDefinitionSchema.parse({ $schema_version: 4 })
    const yaml = stringifyWorkflowYaml({ id: 'WF1', name: 'flow', description: 'd', definition })
    expect(yaml).toBe(
      stringifyWorkflowYamlDocument({ name: 'flow', description: 'd', definition }, { id: 'WF1' }),
    )
    expect(yaml).toContain('id: WF1')
    const nodes = [
      { id: 'a', kind: 'agent-single', agentId: 'AG1' },
      { id: 'b', kind: 'agent-single', agentId: 'AG2' },
      { id: 'c', kind: 'clarify' },
    ]
    expect([...extractWorkflowAgentRefs({ nodes })].sort()).toEqual(['AG1', 'AG2'])
  })
})

describe('RFC-454 —— 原位置不再导出迁走的名字', () => {
  const source = (rel: string) => readFileSync(join(SRC, rel), 'utf8')
  const exportsName = (text: string, name: string) =>
    new RegExp(`export (?:async )?(?:function|const|interface|type) ${name}\\b`).test(text)

  test('collaboration、task-execution 与 resource-catalog 的原文件里没有第二份定义', () => {
    const rounds = source('modules/collaboration/infrastructure/clarifyRounds.ts')
    for (const name of [
      'computeRemaining',
      'resolveEffectiveClarifyChannel',
      'shouldInjectStopNotice',
    ])
      expect([name, exportsName(rounds, name)]).toEqual([name, false])
    expect(
      exportsName(
        source('modules/collaboration/infrastructure/clarify/service.ts'),
        'findClarifyNode',
      ),
    ).toBe(false)
    // RFC-466: the freeze-walk oracle now lives in the test helpers.
    const legacyClosure = readFileSync(join(TESTS, 'helpers/legacyCallClosure.ts'), 'utf8')
    for (const name of [
      'parseCallClosure',
      'callEdgeKey',
      'FrozenCallClosure',
      'FrozenWorkgroupGroupSchema',
    ])
      expect([name, exportsName(legacyClosure, name)]).toEqual([name, false])
    expect(exportsName(legacyClosure, 'freezeCallClosure')).toBe(true)
    const scriptRun = source('modules/task-execution/infrastructure/local/scriptRun.ts')
    for (const name of ['INTERPRETER_SPEC', 'resolveScriptInterpreter', 'ResolvedInterpreter'])
      expect([name, exportsName(scriptRun, name)]).toEqual([name, false])
    expect(exportsName(scriptRun, 'runScriptProcess')).toBe(true)
    expect(
      exportsName(source(RC + 'infrastructure/legacy/workflow.yaml.ts'), 'stringifyWorkflowYaml'),
    ).toBe(false)
    expect(
      exportsName(source(RC + 'infrastructure/legacy/resourceRefs.ts'), 'extractWorkflowAgentRefs'),
    ).toBe(false)
  })

  test('event-center 与平台不再取 task-execution / resource-catalog', () => {
    const files = [
      ...walk(join(SRC, 'modules', 'event-center')),
      join(SRC, 'platform', 'execution', 'local', 'scriptInterpreter.ts'),
      join(SRC, 'platform', 'persistence', 'portableApplicationAssets.ts'),
    ]
    expect(
      importsMatching(
        files,
        (target) =>
          target.startsWith('modules/task-execution/') ||
          target.startsWith('modules/resource-catalog/') ||
          target === 'services/scriptRun' ||
          target === 'services/workflow.yaml',
      ),
    ).toEqual([])
  })
})
