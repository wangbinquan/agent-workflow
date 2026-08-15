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

function identifierCalls(name: string): Map<string, number> {
  if (identifierCallInventory) return identifierCallInventory.get(name) ?? new Map()

  const inventory = new Map<string, Map<string, number>>()
  for (const file of sourceFiles(BACKEND_SRC)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        REVIEWED_CALL_NAMES.has(node.expression.text)
      ) {
        const rel = relative(BACKEND_SRC, file).replaceAll('\\', '/')
        const counts = inventory.get(node.expression.text) ?? new Map<string, number>()
        counts.set(rel, (counts.get(rel) ?? 0) + 1)
        inventory.set(node.expression.text, counts)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
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
      'services/codeRoundLaunch.ts': 1,
      'services/execution/executor.ts': 1,
      'services/fusion.ts': 2,
      'services/task.ts': 1,
      'services/workgroup/launch.ts': 2,
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
    expect(operations).toContain('b.launch_origin = ${filters.origin}')
    expect(sharedTaskSchema).not.toMatch(/\blaunchOrigin\b|\blaunch_origin\b/)

    for (const file of sourceFiles(resolve(BACKEND_SRC, 'routes'))) {
      const text = readFileSync(file, 'utf8')
      expect(text).not.toMatch(/\blaunchOrigin\b|\blaunch_origin\b/)
    }
  })
})
