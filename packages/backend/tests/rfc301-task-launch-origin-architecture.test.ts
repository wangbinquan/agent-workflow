// RFC-301 — launch-origin ownership and negative-wire source ratchets.
//
// AST inventory makes every new raw startTask seam a reviewed decision. Text
// locks keep the internal persisted fact out of public route/shared schemas and
// prevent lifecycle code from gaining an origin UPDATE path.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import ts from 'typescript'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BACKEND_SRC = resolve(REPO_ROOT, 'packages', 'backend', 'src')
const SHARED_TASK_SCHEMA = resolve(REPO_ROOT, 'packages', 'shared', 'src', 'schemas', 'task.ts')

function sourceFiles(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && path.endsWith('.ts')) files.push(path)
    }
  }
  visit(root)
  return files.sort()
}

const REVIEWED_CALL_NAMES = new Set([
  'startTask',
  'createFusion',
  'rejectFusion',
  'directTaskInitiatorFromActorSource',
])

let identifierCallInventory: Map<string, Map<string, number>> | undefined

/**
 * 一份源码里每个受审调用名出现几次。**纯函数**——扫描与 RFC-317 T14 的
 * 「matcher 自证」共用它，两边各留一份拷贝就等于 fixture 只在证明拷贝还活着。
 */
function reviewedCallCounts(text: string): Map<string, number> {
  const source = ts.createSourceFile(
    'probe.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const counts = new Map<string, number>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      REVIEWED_CALL_NAMES.has(node.expression.text)
    ) {
      counts.set(node.expression.text, (counts.get(node.expression.text) ?? 0) + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return counts
}

function identifierCalls(name: string): Map<string, number> {
  if (identifierCallInventory) return identifierCallInventory.get(name) ?? new Map()

  const inventory = new Map<string, Map<string, number>>()
  for (const file of sourceFiles(BACKEND_SRC)) {
    const rel = relative(BACKEND_SRC, file).replaceAll('\\', '/')
    for (const [callName, hits] of reviewedCallCounts(readFileSync(file, 'utf8'))) {
      const counts = inventory.get(callName) ?? new Map<string, number>()
      counts.set(rel, (counts.get(rel) ?? 0) + hits)
      inventory.set(callName, counts)
    }
  }
  identifierCallInventory = inventory
  return inventory.get(name) ?? new Map()
}

describe('RFC-301 task launch-origin architecture ratchets', () => {
  test('all production startTask calls stay inside the reviewed launch adapters', () => {
    expect(Object.fromEntries(identifierCalls('startTask'))).toEqual({
      'services/agentLaunch.ts': 3,
      // RFC-304: the code-round launch adapter, reviewed as part of PR-0's
      // go/no-go. Like the other adapters it does NOT invent provenance — it
      // forwards whatever deps the executor derived from the invoker, so the
      // ownership rule this ratchet protects is unchanged by the fourth kind.
      // RFC-310 PR-4: the digital-employee host launch adapter (fork J,
      // reviewed in the PR-4 integration pass). Mirrors codeRoundLaunch step
      // for step — anchor seed + synthesized snapshot + StartTaskSchema
      // funnel; provenance comes from the injected startDeps (SYSTEM user at
      // both assembly sites), never invented here.
      'modules/task-execution/composition/agentActionExecution.ts': 1,
      // RFC-310 PR-11: the digital-employee *program* host launch adapter. Same
      // adapter shape as agentActionExecution above (synthesized immutable host
      // snapshot + borrowed worktree + StartTaskSchema funnel); provenance again
      // comes from the injected startDeps and is only defaulted when the caller
      // supplied none, so a program step cannot claim an origin of its own.
      'modules/task-execution/composition/scriptActionExecution.ts': 1,
      // RFC-310 OS: one reviewed adapter owns both legal TaskEngine launches:
      // a selected existing Workflow, or the synthesized exact Agent/Program
      // host. Both freeze the employee round id and forward injected provenance;
      // neither route nor Agent can call startTask directly.
      'modules/task-execution/composition/digitalEmployeeExecution.ts': 2,
      'services/execution/executor.ts': 1,
      'services/fusion.ts': 2,
      'services/task.ts': 1,
      'modules/resource-catalog/infrastructure/legacy/workgroup/launch.ts': 2,
    })
  })

  test('Fusion has one route-owned create/reject face and both map trusted actor source', () => {
    expect(Object.fromEntries(identifierCalls('createFusion'))).toEqual({
      'routes/fusions.ts': 1,
    })
    expect(Object.fromEntries(identifierCalls('rejectFusion'))).toEqual({
      'routes/fusions.ts': 1,
    })
    expect(Object.fromEntries(identifierCalls('directTaskInitiatorFromActorSource'))).toEqual({
      'routes/fusions.ts': 2,
      'services/execution/executor.ts': 1,
    })
  })

  test('direct launch adapters declare their exact JSON or multipart transport lane', () => {
    const agentsRoute = readFileSync(resolve(BACKEND_SRC, 'routes', 'agents.ts'), 'utf8')
    const tasksRoute = readFileSync(resolve(BACKEND_SRC, 'routes', 'tasks.ts'), 'utf8')
    const workgroupsRoute = readFileSync(resolve(BACKEND_SRC, 'routes', 'workgroups.ts'), 'utf8')
    const multipartTaskStart = readFileSync(
      resolve(BACKEND_SRC, 'services', 'multipartTaskStart.ts'),
      'utf8',
    )

    expect(agentsRoute).toContain(
      "launchKind: uploads === undefined ? 'direct-json' : 'direct-multipart'",
    )
    expect(tasksRoute).toContain("launchKind: 'direct-json'")
    expect(workgroupsRoute).toContain("launchKind: 'direct-json'")
    expect((multipartTaskStart.match(/launchKind: 'direct-multipart'/g) ?? []).length).toBe(2)
  })

  test('the persisted fact has one application INSERT owner and no response/request schema seam', () => {
    const taskService = readFileSync(resolve(BACKEND_SRC, 'services', 'task.ts'), 'utf8')
    const schema = readFileSync(resolve(BACKEND_SRC, 'db', 'schema.ts'), 'utf8')
    const operations = readFileSync(resolve(BACKEND_SRC, 'services', 'taskOperations.ts'), 'utf8')
    const sharedTaskSchema = readFileSync(SHARED_TASK_SCHEMA, 'utf8')

    expect((taskService.match(/\blaunchOrigin\b/g) ?? []).length).toBe(7)
    expect(taskService).not.toMatch(/\.update\(tasks\)[\s\S]{0,240}\blaunchOrigin\b/)
    expect(schema).toContain("launchOrigin: text('launch_origin'")
    // RFC-311 G1:过滤谓词改成**可换别名**的形式(`col('launch_origin')`),因为
    // 旧穷举管线在已物化的 `base b` 上求值、新快路径直接打 `tasks t`,两条路径
    // 必须共用同一份过滤定义——写死 `b.` 前缀就做不到。棘轮跟着挪到新形态:
    // 它锁的仍是同一件事「launch_origin 的过滤发生在查询层」。
    expect(operations).toContain("${col('launch_origin')} IN ('event', 'webhook')")
    expect(operations).toContain("${col('launch_origin')} = ${filters.origin}")
    expect(sharedTaskSchema).not.toMatch(/\blaunchOrigin\b|\blaunch_origin\b/)

    for (const file of sourceFiles(resolve(BACKEND_SRC, 'routes'))) {
      const text = readFileSync(file, 'utf8')
      expect(text).not.toMatch(/\blaunchOrigin\b|\blaunch_origin\b/)
    }
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的源码喂给**扫描用的同一份纯函数**。
//
// 这条 ratchet 的形状是「受审调用名 → 允许出现的文件与次数」逐字相等。它的静默
// 失效面在第一环：AST 判据只认 `ts.isIdentifier(node.expression)`，也就是**裸调用**。
// 如果哪天有人把 `startTask(...)` 改成 `deps.startTask(...)`，清点结果会从 3 掉到 0，
// 而账本里的期望值也会被一起改成 0——两边同时归零，看起来仍然「逐字相等」。
// 这里把「裸调用会被数到、成员调用不会」这个判据边界钉死，让上面的改动至少留下痕迹。
describe('RFC-317 T14 —— matcher 自证：受审调用的清点判据', () => {
  test('裸调用逐个数得到，重复调用累加', () => {
    const fabricated =
      "import { startTask } from '@/services/task'\n" +
      'export async function launch(a: Input, b: Input) {\n' +
      '  await startTask(a)\n' +
      '  await startTask(b)\n' +
      '  await createFusion(a)\n' +
      '}\n'
    expect(Object.fromEntries(reviewedCallCounts(fabricated))).toEqual({
      startTask: 2,
      createFusion: 1,
    })
  })

  test('成员调用与同名标识符引用都不算（判据只认裸调用——这是它的已知边界）', () => {
    const fabricated =
      'await deps.startTask(input)\n' + 'const fn = startTask\n' + 'type T = typeof startTask\n'
    expect(reviewedCallCounts(fabricated).size).toBe(0)
  })

  test('未受审的调用名不进清点（REVIEWED_CALL_NAMES 被误删一项就会在这里暴露）', () => {
    expect(reviewedCallCounts('await someOtherLaunch(x)\n').size).toBe(0)
    for (const name of REVIEWED_CALL_NAMES) {
      expect(reviewedCallCounts(`await ${name}(x)\n`).get(name), `${name} 没被数到`).toBe(1)
    }
  })
})

// RFC-317 T13 —— 语料非空。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到后端源码语料（扫空即假绿）', () => {
    expect(sourceFiles(BACKEND_SRC).length).toBeGreaterThanOrEqual(600)
  })
})
