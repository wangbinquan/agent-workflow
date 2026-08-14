// RFC-303 / RFC-294 architecture ratchet: provider integration may invoke the
// task-execution participant, but may not reach task selectors, lifecycle
// services, GC, or workspace paths. Internal termination identity/fences also
// stay out of public task request/response wire schemas.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', 'src')
const SHARED_TASK = resolve(import.meta.dir, '..', '..', 'shared', 'src', 'schemas', 'task.ts')

function tsFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

describe('RFC-303 architecture locks', () => {
  test('integration domain/application/infrastructure import only the task public contract', () => {
    const root = join(SRC, 'modules', 'integration')
    const forbidden = /from ['"]@\/(?:services\/(?:task|gc|scheduler|execution)|util\/paths)/
    const violations = tsFiles(root)
      .filter((file) => !file.includes(`${join('integration', 'composition')}/`))
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8')
        return forbidden.test(source) ? [relative(SRC, file)] : []
      })
    expect(violations).toEqual([])
  })

  test('the cross-context command cannot select arbitrary task ids', () => {
    const file = join(SRC, 'modules', 'task-execution', 'public', 'participants.ts')
    const source = readFileSync(file, 'utf8')
    const input = source.match(
      /export type TaskSourceTerminationEffectInput = Readonly<\{[\s\S]*?\n\}>/,
    )?.[0]
    expect(input).toBeDefined()
    expect(input).not.toContain('taskId')
    expect(source).not.toMatch(/\b(?:retry|resume|delete)Task\b/)
  })

  test('task HTTP wire schemas expose no internal binding, fence, capability, or effect revision', () => {
    const sources = [
      readFileSync(SHARED_TASK, 'utf8'),
      readFileSync(join(SRC, 'routes', 'tasks.ts'), 'utf8'),
    ].join('\n')
    for (const internalName of [
      'sourceTerminationBinding',
      'sourceTerminationFence',
      'sourceTerminationEffectRev',
      'SourceTerminationEffectCapability',
    ]) {
      expect(sources).not.toContain(internalName)
    }
  })
})
