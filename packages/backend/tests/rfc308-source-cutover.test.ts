import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')
const SHARED_SRC = resolve(import.meta.dir, '..', '..', 'shared', 'src')
const FRONTEND_SRC = resolve(import.meta.dir, '..', '..', 'frontend', 'src')

function sourceFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.(?:ts|tsx)$/.test(entry)) out.push(path)
  }
  return out
}

describe('RFC-308 hard-cut source inventory', () => {
  test('production has no legacy workspace or gitignore preset consumer', () => {
    const source = [
      ...sourceFiles(BACKEND_SRC),
      ...sourceFiles(SHARED_SRC),
      ...sourceFiles(FRONTEND_SRC),
    ]
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')
    const forbidden = [
      ['.', 'aw', '-run'].join(''),
      ['.', 'agent', '-inputs'].join(''),
      ['.', 'agent-workflow', '-inputs'].join(''),
      ['__', 'fusion', '__'].join(''),
      ['gitignore', 'Commit'].join(''),
      ['gitignore', '_commit'].join(''),
      ['commit', 'GitignorePreset'].join(''),
      ['repoGroup', 'Gitignore'].join(''),
    ]
    for (const token of forbidden) expect(source.includes(token), token).toBe(false)
  })

  test('both publication consumers delegate candidate selection to source-control', () => {
    const ordinary = readFileSync(join(BACKEND_SRC, 'services', 'commitPushRunner.ts'), 'utf8')
    const code = readFileSync(
      join(BACKEND_SRC, 'modules', 'code-capability', 'infrastructure', 'gitAdapter.ts'),
      'utf8',
    )
    expect(ordinary).toContain('bindRepositoryCommitParticipant')
    expect(ordinary).toContain('.prepare()')
    expect(ordinary).toContain('.publish(')
    expect(code).toContain('TaskWorkspaceCommitParticipant')
    expect(code).toContain('deps.taskCommit.freeze(')
    expect(code).toContain('deps.taskCommit.publish(')
    expect(code).toContain('deps.taskCommit.release(')
    expect(code).not.toContain('@/modules/source-control/')
    const scheduler = readFileSync(join(BACKEND_SRC, 'services', 'scheduler.ts'), 'utf8')
    expect(scheduler).toContain('bindTaskWorkspaceCommitParticipant')
    expect(scheduler).toContain('git: createGitAdapter({ taskCommit })')
    const codeCapability = sourceFiles(join(BACKEND_SRC, 'modules', 'code-capability'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')
    expect(codeCapability).not.toMatch(
      /modules\/(?:source-control|task-execution)\/(?:application|composition|domain|infrastructure)/,
    )
    expect(codeCapability).toContain('@/modules/task-execution/public/participants')
    const taskAdapter = readFileSync(
      join(BACKEND_SRC, 'modules', 'task-execution', 'composition', 'taskWorkspaceCommit.ts'),
      'utf8',
    )
    expect(taskAdapter).toContain('@/modules/source-control/public/participants')
    expect(taskAdapter).not.toContain('@/modules/source-control/composition')
    expect(ordinary).not.toMatch(/modules\/source-control\/(?:application|domain|infrastructure)/)
    expect(code).not.toContain("['add', '-A']")
    expect(code).not.toContain("['add', '-A', '--intent-to-add']")
    expect(code).not.toMatch(/\[\s*'commit'/)
    expect(code).not.toMatch(/\[\s*'push'/)
    expect(code).not.toContain("['update-ref'")
  })
})
