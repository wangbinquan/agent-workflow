// RFC-292 architecture ratchets: the canonical trigger namespace must not
// fork back into code-host-only helpers, runtime dispatch must keep authored
// and framework prompts separated, and frozen context must stay off task/API
// projections and process configuration.

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
      expect(text, file).not.toMatch(/from\s+['"][^'"]*codeHost\/triggerContext['"]/)
      expect(text, file).not.toMatch(/\bTRIGGER_CONTEXT_VARS\b/)
      expect(text, file).not.toMatch(/\bisTriggerContextVar\b/)
      expect(text, file).not.toMatch(/\btriggerContextOf\b/)
    }
  })

  test('scheduler passes one frozen context to every authored runtime sink', () => {
    const source = readFileSync(resolve(BACKEND_SRC, 'services/scheduler.ts'), 'utf8')
    expect(source).toContain('agent,\n          triggerContext: state.triggerContext')
    expect(source).toContain('agent: innerAgent,\n      triggerContext: state.triggerContext')
    expect(source).toContain('agent: aggAgent,\n      triggerContext: state.triggerContext')
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
    expect(orchestrator).toContain('availableFields.map(webhookTriggerToken)')
  })

  test('task wire projection and runtime config do not expose frozen trigger JSON', () => {
    const task = readFileSync(resolve(BACKEND_SRC, 'services/task.ts'), 'utf8')
    const rowProjection = task.slice(
      task.indexOf('function rowToTask('),
      task.indexOf('\nfunction rowToSummary(', task.indexOf('function rowToTask(')),
    )
    expect(rowProjection).not.toContain('triggerContextJson')

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
