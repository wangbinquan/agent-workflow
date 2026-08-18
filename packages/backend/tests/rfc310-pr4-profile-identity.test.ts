// RFC-310 PR-4 T44 —— 数字员工 profile 的零 Git identity / 零凭据（真子进程双向证）。
//
// 正向锁在 rfc310-pr4-execution-host.test.ts（DE 启动 → 子进程 env 四键缺席）。
// 本文件补两面：
//   1. 对照组：RFC-067 普通任务的 per-task identity 注入**必须还活着**——
//      同一 spawn 装配、同一 mock、带 gitUserName/gitUserEmail 启动 → 子进程
//      env 四键在场。没有这半边，「缺席」断言会在注入分支整体坏死时假绿。
//   2. 文本锁：digital-employee 执行链两个新文件的代码行不得出现
//      GIT_AUTHOR/COMMITTER、SSH agent、token/secret 注入 token（对齐
//      rfc310-architecture-lock T7 的口径；注释行不扫）。

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent } from '../src/services/agent'
import { startTaskWithLocalRepo } from '../src/services/task'
import { createWorkflow } from '../src/services/workflow'
import { nonInteractiveGitEnv } from '../src/util/git'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'

setDefaultTimeout(120_000)

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: { ...process.env, ...nonInteractiveGitEnv() } as Record<string, string>,
  })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
  }
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

let tmp = ''
let db: DbClient
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rfc310-pr4-ident-'))
  db = createInMemoryDb(MIGRATIONS)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('rfc310 pr4 — identity injection stays alive for RFC-067, absent for digital employees', () => {
  test('对照组：普通任务带 gitUserName/gitUserEmail → 子进程 env 四键在场', async () => {
    await seedTestDefaultOpencodeRuntime(db)
    const appHome = join(tmp, 'home')
    mkdirSync(appHome, { recursive: true })
    const repoPath = join(tmp, 'repo')
    mkdirSync(repoPath)
    git(repoPath, 'init', '-q', '-b', 'main')
    writeFileSync(join(repoPath, 'a.txt'), 'x\n')
    git(repoPath, 'add', '.')
    git(repoPath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i')

    const agent = await createAgent(db, {
      name: 'echoer',
      description: '',
      outputs: ['out'],
      outputKinds: { out: 'string' },
      syncOutputsOnIterate: false,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    const wf = await createWorkflow(db, {
      name: 'ident-wf',
      description: '',
      definition: {
        $schema_version: 2,
        inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic' },
          {
            id: 'a1',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'echoer',
            promptTemplate: '{{topic}}',
          },
        ],
        edges: [
          {
            id: 'e1',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'a1', portName: 'topic' },
          },
        ],
      },
    })

    const envLog = join(tmp, 'env.log')
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ out: 'ok' }),
        MOCK_OPENCODE_CAPTURE_ENV_TO: envLog,
      },
      () =>
        startTaskWithLocalRepo(
          {
            workflowId: wf.id,
            name: 'ident-control',
            repoPath,
            baseBranch: 'main',
            inputs: { topic: 't' },
            gitUserName: 'DE Control',
            gitUserEmail: 'control@example.test',
          },
          { db, appHome, binaryOverride: ['bun', 'run', MOCK_OPENCODE], awaitScheduler: true },
        ),
    )
    const captured = JSON.parse(readFileSync(envLog, 'utf8').trim().split('\n')[0]!) as Record<
      string,
      string | null
    >
    expect(captured.GIT_AUTHOR_NAME).toBe('DE Control')
    expect(captured.GIT_AUTHOR_EMAIL).toBe('control@example.test')
    expect(captured.GIT_COMMITTER_NAME).toBe('DE Control')
    expect(captured.GIT_COMMITTER_EMAIL).toBe('control@example.test')
  })

  test('文本锁：digital-employee 执行链代码行零 identity/凭据 token（注释行不扫）', () => {
    const files = [
      'modules/task-execution/domain/digitalEmployeeHost.ts',
      'modules/task-execution/composition/agentActionExecution.ts',
    ]
    const offenders: string[] = []
    for (const rel of files) {
      const lines = readFileSync(join(BACKEND_SRC, rel), 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return
        if (
          /GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)|gitUserName|gitUserEmail|SSH_AUTH_SOCK|secretProjection|connectionSecret/.test(
            line,
          )
        ) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
