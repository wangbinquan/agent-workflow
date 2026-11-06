// RFC-458 — workflow-output 信封解析器归 shared、端口内容解析归 task-execution（RFC-294 W9-D 第五步）。
//
// 锁四件事：
// ① `services/envelope.ts` 与 `services/scriptPorts.ts` 已删除，新位置都在；`src/` 与用例零 import 旧路径（census AST，带负对照）。
// ② 解析器的每个导出在后端与 shared 的源码里只有 shared `workflowOutputEnvelope.ts` 一处定义，shared 入口导出的就是它。
// ③ task-execution 的端口内容包装就是 composition 里原生解析的薄包装：同一输入结果相同，`resolvePortContent` 取其 `body`。
// ④ `node_runs.port_validation_failures_json` 的形状不变：序列化往返，坏 JSON 与非数组回落 null，缺字段的条目跳过。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import * as shared from '@agent-workflow/shared'
import * as parser from '../../shared/src/workflowOutputEnvelope'
import {
  parsePortValidationFailuresJson,
  serializePortValidationFailures,
  type PortValidationFailure,
} from '@/modules/task-execution/application/portOutputValidation'
import {
  resolveNativePortContentDetailed,
  resolvePortContent,
  resolvePortContentDetailed,
} from '@/modules/task-execution/composition/portOutputValidation'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const SHARED_SRC = resolve(REPO_ROOT, 'packages', 'shared', 'src')
const TESTS = resolve(import.meta.dir)
const DELETED = ['services/envelope', 'services/scriptPorts']
const PARSER_EXPORTS = [
  'readPortActiveAttr',
  'EnvelopeParseResult',
  'extractLastEnvelope',
  'DetectedEnvelopeKind',
  'CLARIFY_REQUIRED_PREFIX',
  'CLARIFY_FORBIDDEN_PREFIX',
  'ENVELOPE_PORT_MALFORMED_PREFIX',
  'BRANCH_PORT_NOT_DECLARED_PREFIX',
  'BRANCH_MARKER_MALFORMED_PREFIX',
  'detectEnvelopeKind',
  'extractClarifyEnvelopeBody',
  'parseEnvelope',
] as const

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

const slash = (path: string) => path.split('\\').join('/')

/** 说明符解析到 `src/` 下的路径（不带扩展名）；包名等非本地说明符返回 null。 */
function targetOf(from: string, specifier: string): string | null {
  let target: string
  if (specifier.startsWith('@/')) target = specifier.slice(2)
  else if (specifier.startsWith('.')) target = slash(relative(SRC, resolve(from, '..', specifier)))
  else return null
  return target.replace(/\.[cm]?tsx?$/, '')
}

function importsOfDeleted(files: readonly string[]): string[] {
  return files.flatMap((path) => {
    const unit = sourceUnit(slash(relative(REPO_ROOT, path)), readFileSync(path, 'utf8'))
    return [...new Set(importEdges(unit).map((edge) => targetOf(path, edge.specifier)))]
      .filter((target): target is string => target !== null && DELETED.includes(target))
      .map((target) => `${slash(relative(REPO_ROOT, path))} -> ${target}`)
  })
}

describe('RFC-458 —— 两个文件迁出 services/', () => {
  test('旧文件不在了，新位置都在', () => {
    for (const from of DELETED)
      expect([from, existsSync(join(SRC, `${from}.ts`))]).toEqual([from, false])
    expect(existsSync(join(SHARED_SRC, 'workflowOutputEnvelope.ts'))).toBe(true)
    expect(existsSync(join(SRC, 'modules/task-execution/domain/scriptPorts.ts'))).toBe(true)
  })

  test('src/ 与用例里零 import 旧路径', () => {
    expect(importsOfDeleted(walk(SRC))).toEqual([])
    expect(importsOfDeleted(walk(TESTS))).toEqual([])
    // The repository-root perf gate (`tests/perf/run.ts`) imports backend sources by relative path; the first RFC-458
    // push missed it (CI "Perf microbenchmark gate": Cannot find module …/services/envelope).
    expect(importsOfDeleted(walk(join(REPO_ROOT, 'tests')))).toEqual([])
  }, 60_000)

  test('负对照：判据认得出别名与相对路径', () => {
    const probe = join(SRC, 'services', 'probe.ts')
    expect(targetOf(probe, '@/services/envelope')).toBe('services/envelope')
    expect(targetOf(probe, './scriptPorts.ts')).toBe('services/scriptPorts')
    expect(targetOf(probe, '@agent-workflow/shared')).toBeNull()
  })
})

describe('RFC-458 —— 解析器只在 shared 定义一份', () => {
  const declaration = (name: string) =>
    new RegExp(`export\\s+(?:function|const|interface|type|class)\\s+${name}\\b`)

  test('每个导出在后端与 shared 源码里只有一处定义，就在 workflowOutputEnvelope.ts', () => {
    const corpus = [...walk(SRC), ...walk(SHARED_SRC)].map((path) => ({
      path: slash(relative(REPO_ROOT, path)),
      text: readFileSync(path, 'utf8'),
    }))
    for (const name of PARSER_EXPORTS) {
      const defining = corpus.filter((file) => declaration(name).test(file.text)).map((f) => f.path)
      expect([name, defining]).toEqual([name, ['packages/shared/src/workflowOutputEnvelope.ts']])
    }
  }, 60_000)

  test('shared 入口导出的就是 workflowOutputEnvelope.ts 那一份', () => {
    expect(shared.parseEnvelope).toBe(parser.parseEnvelope)
    expect(shared.extractLastEnvelope).toBe(parser.extractLastEnvelope)
    expect(shared.detectEnvelopeKind).toBe(parser.detectEnvelopeKind)
    expect(shared.CLARIFY_FORBIDDEN_PREFIX).toBe(parser.CLARIFY_FORBIDDEN_PREFIX)
  })

  test('解析行为：最后一个信封胜出、缺省的声明端口回空串、未声明端口单列', () => {
    const stdout = [
      '<workflow-output><port name="summary">draft</port></workflow-output>',
      'thinking…',
      '<workflow-output><port name="summary">final</port><port name="extra">x</port></workflow-output>',
    ].join('\n')
    const last = shared.extractLastEnvelope(stdout)
    expect(last).toContain('final')
    expect(last).not.toContain('draft')
    const parsed = shared.parseEnvelope(last!, ['summary', 'findings'])
    expect(parsed.ports.get('summary')).toBe('final')
    expect(parsed.ports.get('findings')).toBe('')
    expect(parsed.missingDeclared).toEqual(['findings'])
    expect(parsed.undeclared.map((port) => port.name)).toEqual(['extra'])
  })
})

describe('RFC-458 —— task-execution 的端口内容包装与校验失败形状', () => {
  test('包装与原生解析对同一输入结果相同，resolvePortContent 取 body', () => {
    for (const input of [
      { rawContent: 'plain text', worktreePath: '/nonexistent-worktree' },
      { rawContent: '# heading', kind: 'markdown' as const, worktreePath: '/nonexistent-worktree' },
    ]) {
      const native = resolveNativePortContentDetailed(input)
      expect(resolvePortContentDetailed(input)).toEqual(native)
      expect(resolvePortContent(input)).toBe(native.body)
    }
  })

  test('校验失败 JSON 往返不变；坏 JSON、非数组回落 null；缺字段的条目跳过', () => {
    const failures: PortValidationFailure[] = [
      { port: 'report', kind: 'markdown_file', subReason: 'not-found', detail: 'missing.md' },
      { port: 'summary', kind: 'string', subReason: 'empty' },
    ]
    expect(parsePortValidationFailuresJson(serializePortValidationFailures(failures))).toEqual(
      failures,
    )
    expect(parsePortValidationFailuresJson(null)).toBeNull()
    expect(parsePortValidationFailuresJson('{not json')).toBeNull()
    expect(parsePortValidationFailuresJson('{"port":"a"}')).toBeNull()
    expect(
      parsePortValidationFailuresJson(
        '[{"port":"a","kind":"string"},{"port":"b","kind":"string","subReason":"x"}]',
      ),
    ).toEqual([{ port: 'b', kind: 'string', subReason: 'x' }])
  })
})
