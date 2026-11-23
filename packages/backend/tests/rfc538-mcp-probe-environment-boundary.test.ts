// RFC-538 — MCP 探测的选项与时钟随应用走（RFC-294 S12 第十九步）。
//
// 锁两件事（design §3 的清单即退出门）：
// ① `resource-catalog/composition/mcpProbeOperations.ts` 顶层没有 `let` 与 `new Map / Set / WeakMap / WeakSet`，在架构报告的模块级可变单例判据
//    里为空；生产代码不再引用删去的名字；`createMcpProbeEnvironment(` 在生产里只在 `bootstrap/daemonApplication.ts` 调一次、实参是应用的测试
//    接缝 `input.testSeams?.mcpProbeOptions`；`createInProcessMcpProbeRunner(` 每处调用都带环境实参；`composeMcpProbeOperations(` 每处调用都给
//    `clock`（语料下限 3,000）。
// ② 行为：两份环境各用各的选项与时钟；选项每次读取；没有选项时取 `Date.now`；进程内执行器把环境的选项交给探测（用的是这份环境的客户端
//    工厂）。探测用例的开始时间取交进来的时钟由 `rfc448` 的装配用例钉（它直接给环境的时钟）。
// 负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  createInProcessMcpProbeRunner,
  createMcpProbeEnvironment,
  type McpProbeOptions,
} from '@/modules/resource-catalog/composition/mcpProbeOperations'
import type { ProbedMcpClient } from '@/modules/resource-catalog/infrastructure/mcpProbe'
import type { Mcp } from '@agent-workflow/shared'
import { mutableSingletons } from './architecture/architectureReport'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const PROBE = SRC + 'modules/resource-catalog/composition/mcpProbeOperations.ts'
const APPLICATION = SRC + 'bootstrap/daemonApplication.ts'
const CORPUS_TIMEOUT = 30_000
/** The process-wide probe test seam RFC-538 removed; production must not name it again. */
const REMOVED = ['__setMcpProbeOptionsForTesting', 'mcpProbeNow', 'probeOptionsOverride']
const COLLECTIONS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet'])
const CREATE = 'createMcpProbeEnvironment'
const RUNNER = 'createInProcessMcpProbeRunner'
const OPERATIONS = 'composeMcpProbeOperations'
const SEAM = 'input.testSeams?.mcpProbeOptions'

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
function calls(unit: SourceUnit, callee: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  walk(unit.source, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(unit.source) === callee)
      found.push(node)
  })
  return found
}
function hasProperty(argument: ts.Expression | undefined, name: string): boolean {
  return (
    argument !== undefined &&
    ts.isObjectLiteralExpression(argument) &&
    argument.properties.some(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        ts.isIdentifier(property.name) &&
        property.name.text === name,
    )
  )
}

export function mcpProbeEnvironmentViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  const probe = units.find((unit) => unit.path === PROBE)
  if (probe === undefined) errors.add('missing source: ' + PROBE)
  else {
    for (const statement of probe.source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(probe.source)
        if ((statement.declarationList.flags & ts.NodeFlags.Let) !== 0)
          errors.add(`module-level let:mcpProbeOperations.ts:${name}`)
        const init = declaration.initializer
        if (
          init !== undefined &&
          ts.isNewExpression(init) &&
          COLLECTIONS.has(init.expression.getText(probe.source))
        )
          errors.add(`module-level collection:mcpProbeOperations.ts:${name}`)
      }
    }
    for (const entry of mutableSingletons([probe]))
      errors.add(`mutable singleton:mcpProbeOperations.ts:${entry.symbol}`)
  }
  const created: string[] = []
  for (const unit of units) {
    if (!unit.path.startsWith(SRC)) continue
    walk(unit.source, (node) => {
      if (ts.isIdentifier(node) && REMOVED.includes(node.text))
        errors.add(`removed name:${unit.path}:${node.text}`)
    })
    for (const call of calls(unit, RUNNER))
      if (call.arguments.length !== 1)
        errors.add(`in-process probe without its environment:${unit.path}`)
    for (const call of calls(unit, OPERATIONS))
      if (!hasProperty(call.arguments[0], 'clock'))
        errors.add(`probe use cases without the application clock:${unit.path}`)
    for (const call of calls(unit, CREATE))
      created.push(`${unit.path}:${call.arguments.map((a) => a.getText(unit.source)).join(',')}`)
  }
  if (created.length !== 1 || created[0] !== `${APPLICATION}:${SEAM}`)
    errors.add(`environment construction:${created.join(' | ')}`)
  return [...errors].sort()
}

describe('RFC-538 ① 探测接缝没有进程级状态；组合根每份应用建一份环境', () => {
  test(
    '真实语料：探测文件没有模块级状态，删去的名字不在，环境只在组合根建一次，执行器与探测用例都取这份环境',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(mcpProbeEnvironmentViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

function fakeClient(name: string): ProbedMcpClient {
  return {
    serverInfo: { name, version: '1.0' },
    protocolVersion: '2024-11-05',
    capabilities: {},
    listTools: () => Promise.resolve([{ name: `${name}-tool` }]),
    listResources: () => Promise.resolve([]),
    listResourceTemplates: () => Promise.resolve([]),
    listPrompts: () => Promise.resolve([]),
    capturedStderr: () => '',
    close: async () => {},
  }
}
function recordingOptions(name: string, opened: string[], now: number): McpProbeOptions {
  return {
    now: () => now,
    openClient: async (mcp) => {
      opened.push(`${name}:${mcp.id}`)
      return { client: fakeClient(name), handshakeMs: 1 }
    },
  }
}
const MCP = {
  id: 'mcp-a',
  name: 'mcp-a',
  type: 'local',
  enabled: true,
  config: { command: ['fake-mcp'] },
} as unknown as Mcp

describe('RFC-538 ② 环境随应用走的行为', () => {
  test('两份环境各用各的选项与时钟；进程内执行器用自己环境的客户端工厂', async () => {
    const opened: string[] = []
    const first = createMcpProbeEnvironment(() => recordingOptions('first', opened, 1_000))
    const second = createMcpProbeEnvironment(() => recordingOptions('second', opened, 2_000))
    expect([first.clock(), second.clock()]).toEqual([1_000, 2_000])
    await createInProcessMcpProbeRunner(first).probe(MCP, { startedAt: 1_000 })
    await createInProcessMcpProbeRunner(second).probe(MCP, { startedAt: 2_000 })
    expect(opened).toEqual(['first:mcp-a', 'second:mcp-a'])
  })

  test('选项每次读取；没有选项时取 Date.now', async () => {
    expect(createMcpProbeEnvironment().options()).toBeUndefined()
    const seam: { current?: McpProbeOptions } = {}
    const environment = createMcpProbeEnvironment(() => seam.current)
    const before = Date.now()
    const defaultNow = environment.clock()
    expect(defaultNow).toBeGreaterThanOrEqual(before)
    expect(defaultNow).toBeLessThanOrEqual(Date.now())
    const opened: string[] = []
    seam.current = recordingOptions('late', opened, 7)
    expect(environment.clock()).toBe(7)
    await createInProcessMcpProbeRunner(environment).probe(MCP, { startedAt: 7 })
    expect(opened).toEqual(['late:mcp-a'])
  })
})

describe('RFC-538 负对照', () => {
  const clean = [
    sourceUnit(
      PROBE,
      [
        `export function ${CREATE}(options) { return { clock: () => (options()?.now ?? Date.now)(), options } }`,
        `export function ${RUNNER}(environment) { return { probe: (mcp, o) => probeMcp(mcp, { ...environment.options(), ...o }) } }`,
      ].join('\n'),
    ),
    sourceUnit(APPLICATION, `const mcpProbe = ${CREATE}(${SEAM})`),
    sourceUnit(
      SRC + 'modules/resource-catalog/composition/mcpDiagnostics.ts',
      `const runner = ${RUNNER}(input.probe)`,
    ),
    sourceUnit(
      SRC + 'bootstrap/daemonHttpComposition.ts',
      `const probes = ${OPERATIONS}({ queries, probeRunner, clock: mcpProbe.clock })`,
    ),
  ]
  const replace = (path: string, text: string) =>
    clean.map((unit) => (unit.path === path ? sourceUnit(path, text) : unit))

  test('伪造的干净语料没有违例', () => {
    expect(mcpProbeEnvironmentViolations(clean)).toEqual([])
  })

  test('模块级的接缝、删去的名字、不带环境的执行器与不给时钟的探测用例都会被认出', () => {
    expect(
      mcpProbeEnvironmentViolations(
        replace(PROBE, `let probeOptionsOverride = undefined\nexport function ${CREATE}() {}`),
      ),
    ).toEqual([
      'module-level let:mcpProbeOperations.ts:probeOptionsOverride',
      'mutable singleton:mcpProbeOperations.ts:probeOptionsOverride',
      `removed name:${PROBE}:probeOptionsOverride`,
    ])
    expect(
      mcpProbeEnvironmentViolations(
        replace(PROBE, `const options = new Map()\nexport function mcpProbeNow() {}`),
      ),
    ).toEqual([
      'module-level collection:mcpProbeOperations.ts:options',
      `removed name:${PROBE}:mcpProbeNow`,
    ])
    expect(
      mcpProbeEnvironmentViolations(
        replace(SRC + 'modules/resource-catalog/composition/mcpDiagnostics.ts', `${RUNNER}()`),
      ),
    ).toEqual([
      `in-process probe without its environment:${SRC}modules/resource-catalog/composition/mcpDiagnostics.ts`,
    ])
    expect(
      mcpProbeEnvironmentViolations(
        replace(
          SRC + 'bootstrap/daemonHttpComposition.ts',
          `${OPERATIONS}({ queries, probeRunner })`,
        ),
      ),
    ).toEqual([
      `probe use cases without the application clock:${SRC}bootstrap/daemonHttpComposition.ts`,
    ])
  })

  test('环境建了两份、建在组合根之外、不取测试接缝，都会被认出', () => {
    for (const units of [
      replace(APPLICATION, `const a = ${CREATE}(${SEAM})\nconst b = ${CREATE}(${SEAM})`),
      replace(APPLICATION, `const mcpProbe = ${CREATE}()`),
      [...clean, sourceUnit(SRC + 'modules/elsewhere.ts', `const probe = ${CREATE}(${SEAM})`)],
    ])
      expect(
        mcpProbeEnvironmentViolations(units).filter((e) => e.startsWith('environment')),
      ).toHaveLength(1)
  })
})
