// RFC-292 architecture ratchets: the canonical trigger namespace must not
// fork back into code-host-only helpers, runtime dispatch must keep authored
// and framework prompts separated, and frozen context must stay off raw
// task/API projections and process configuration. RFC-298 permits exactly one
// narrow, derived `{kind,url}` detail projection without exposing source JSON.

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..', '..')
const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')

function sourceFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (/\.(?:ts|tsx)$/.test(entry.name)) out.push(path)
  }
  return out
}

// RFC-317 T14 —— 退役符号表提到模块顶层：扫描与「matcher 自证」共用同一份实现。
// 这四条正则是本守卫的全部判据；任何一条失配，对应的退役符号就能悄悄复活。
const RETIRED_TRIGGER_SYMBOLS: readonly RegExp[] = [
  /from\s+['"][^'"]*codeHost\/triggerContext['"]/,
  /\bTRIGGER_CONTEXT_VARS\b/,
  /\bisTriggerContextVar\b/,
  /\btriggerContextOf\b/,
]

describe('RFC-292 trigger namespace source locks', () => {
  test('production code has no private code-host trigger import or retired alias', () => {
    expect(existsSync(resolve(REPO, 'packages/shared/src/codeHost/triggerContext.ts'))).toBe(false)
    const roots = [
      resolve(REPO, 'packages/shared/src'),
      resolve(REPO, 'packages/backend/src'),
      resolve(REPO, 'packages/frontend/src'),
    ]
    for (const file of roots.flatMap(sourceFiles)) {
      const text = readFileSync(file, 'utf8')
      for (const retired of RETIRED_TRIGGER_SYMBOLS) {
        expect(text, `${file} 命中已退役符号 ${retired.source}`).not.toMatch(retired)
      }
    }
  })

  test('scheduler passes one frozen context to every authored runtime sink', () => {
    const source = [
      readFileSync(resolve(BACKEND_SRC, 'services/scheduler.ts'), 'utf8'),
      readFileSync(
        resolve(BACKEND_SRC, 'modules', 'task-execution', 'composition', 'nodeMechanics.ts'),
        'utf8',
      ),
    ].join('\n')
    // RFC-287 moved the main-agent call into an assembly callback. Lock the
    // adjacency and exact frozen-context identity without coupling RFC-292 to
    // that callback's indentation depth.
    expect(source).toMatch(/\bagent,\n\s+triggerContext: state\.triggerContext/)
    // RFC-287 T4 同 aggAgent 那条：迁入装配回调只改了缩进，锁「相邻性 + 身份」
    // 而不绑死嵌套深度。
    expect(source).toMatch(/agent: innerAgent,\n\s+triggerContext: state\.triggerContext/)
    // RFC-287 moved this call into an assembly callback and therefore changed
    // indentation only. Keep the adjacency/identity lock without coupling the
    // RFC-292 invariant to a particular nesting depth.
    expect(source).toMatch(/agent: aggAgent,\n\s+triggerContext: state\.triggerContext/)
    expect(source).toContain('ctx: { ports: upstreamInputs, triggerContext: state.triggerContext }')
    expect(source).toContain('{ triggerContext: state.triggerContext }')
    expect(source).toContain('renderCallGoal(goalTemplate, inputs, state.triggerContext')

    // Workgroup/dynamic host, commit and merge prompts are framework-authored
    // strings. They keep trigger-looking user text literal instead of opening
    // an accidental second template pass.
    expect(source.match(/triggerContext: null/g)).toHaveLength(3)
    expect(source.match(/expandPromptTemplate: false/g)).toHaveLength(3)
  })

  test('Intent and dynamic generation derive canonical vocabulary and schema version', () => {
    const intent = readFileSync(resolve(BACKEND_SRC, 'services/intent/intentDoc.ts'), 'utf8')
    const orchestrator = readFileSync(resolve(BACKEND_SRC, 'services/orchestratorAgent.ts'), 'utf8')
    expect(intent).toContain('WEBHOOK_TEMPLATE_VARS.map(webhookTriggerToken)')
    expect(intent).toContain('$schema_version:${WORKFLOW_SCHEMA_VERSION}')
    expect(intent).toContain('Trigger values are execution context, NOT workflow inputs')
    expect(orchestrator).toContain('$schema_version: WORKFLOW_SCHEMA_VERSION')
    expect(orchestrator).toContain('triggerToken(opts.triggerContext!.namespace, field)')
  })

  test('task wire exposes only the RFC-298 derived link, never frozen trigger JSON', () => {
    const task = readFileSync(resolve(BACKEND_SRC, 'services/task.ts'), 'utf8')
    const getTaskProjection = task.slice(
      task.indexOf('export async function getTask('),
      task.indexOf(
        '\nexport interface ListTasksFilters',
        task.indexOf('export async function getTask('),
      ),
    )
    const rowProjection = task.slice(
      task.indexOf('function rowToTask('),
      task.indexOf('\nfunction rowToSummary(', task.indexOf('function rowToTask(')),
    )
    expect(getTaskProjection).toContain('webhookTaskSourceLinkOf(parsedTriggerContext.value)')
    expect(getTaskProjection).toContain('row.task.triggerContextJson')
    expect(rowProjection).not.toContain('triggerContextJson')
    expect(rowProjection).toContain('webhookSourceLink')
    expect(rowProjection).not.toMatch(/comment_text|event_json|triggerContext:/)

    for (const rel of [
      'services/runtime',
      'services/agentDeps.ts',
      'services/resourcePackage',
      'services/bundle',
    ]) {
      const path = resolve(BACKEND_SRC, rel)
      const files = /\.ts$/.test(rel) ? [path] : sourceFiles(path)
      for (const file of files) {
        expect(readFileSync(file, 'utf8'), file).not.toMatch(
          /triggerContextJson|trigger_context_json/,
        )
      }
    }
  })
})

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(sourceFiles(BACKEND_SRC).length).toBeGreaterThanOrEqual(300)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的复活写法喂给**扫描用的同一份判据**。
//
// 这是一条「退役符号零再现」的灭绝守卫，绿是常态。正则少认一种写法（改成裸
// import、换个引号、加上 `type` 关键字），退役符号就能悄悄复活而扫描仍报零。
describe('RFC-317 T14 —— matcher 自证：退役符号的复活写法必须被抓到', () => {
  test('私有 triggerContext 的各种 import 写法都命中', () => {
    for (const fabricated of [
      "import { x } from '@/codeHost/triggerContext'",
      'import type { Y } from "../codeHost/triggerContext"',
      "export { z } from '@agent-workflow/shared/codeHost/triggerContext'",
    ]) {
      expect(
        RETIRED_TRIGGER_SYMBOLS.some((re) => re.test(fabricated)),
        `没抓到：${fabricated}`,
      ).toBe(true)
    }
  })

  test('三个退役标识符逐个命中', () => {
    for (const fabricated of [
      'const vars = TRIGGER_CONTEXT_VARS',
      'if (isTriggerContextVar(name)) return',
      'const ctx = triggerContextOf(trigger)',
    ]) {
      expect(
        RETIRED_TRIGGER_SYMBOLS.some((re) => re.test(fabricated)),
        `没抓到：${fabricated}`,
      ).toBe(true)
    }
  })

  test('公共 trigger 合同的正常用法放行（规则不能宽到把正解也报了）', () => {
    for (const legitimate of [
      "import { triggerContext } from '@/modules/integration/public/types'",
      'const vars = TRIGGER_VARS',
      'const ctx = triggerContextFromWebhook(payload)',
    ]) {
      expect(
        RETIRED_TRIGGER_SYMBOLS.some((re) => re.test(legitimate)),
        `误伤：${legitimate}`,
      ).toBe(false)
    }
  })
})
