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

  test('the surviving publication consumer delegates candidate selection to source-control', () => {
    // RFC-310 PR-10 T104/T105：code-capability 的 gitAdapter 随 writer 删除，
    // 「双消费者」收缩为一个（普通任务 commit/push）。code-capability 只剩读
    // 面，因此对它的断言从「经 public/participants 委托」变为**零 source-
    // control / task-execution 依赖**——比原断言更强的收缩证明。
    const ordinary = readFileSync(join(BACKEND_SRC, 'services', 'commitPushRunner.ts'), 'utf8')
    expect(ordinary).toContain('bindRepositoryCommitParticipant')
    expect(ordinary).toContain('.prepare()')
    expect(ordinary).toContain('.publish(')
    const codeCapability = sourceFiles(join(BACKEND_SRC, 'modules', 'code-capability'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')
    expect(codeCapability).not.toMatch(/modules\/(?:source-control|task-execution)\//)
    const taskAdapter = readFileSync(
      join(BACKEND_SRC, 'modules', 'task-execution', 'composition', 'taskWorkspaceCommit.ts'),
      'utf8',
    )
    expect(taskAdapter).toContain('@/modules/source-control/public/participants')
    expect(taskAdapter).not.toContain('@/modules/source-control/composition')
    expect(ordinary).not.toMatch(/modules\/source-control\/(?:application|domain|infrastructure)/)
    // 原断言逐条禁止 code-capability 自己跑 git 动词（add/commit/push/
    // update-ref）；T105 后该模块整体无 git 调用，一条正则覆盖全部。
    expect(codeCapability).not.toMatch(/runGit|\[\s*'(?:add|commit|push|update-ref)'/)
  })
})
