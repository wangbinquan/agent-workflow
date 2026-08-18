// RFC-310 PR-5 T60 —— `mr.ensure` 幂等 + observe（对真 system-mocks stateful
// code-host 的 GitLab/GitHub REST 面；executeCodeHostCall 全链真跑）。
//
// 锁：不存在才创建（body 带机器 marker）；同 source branch 重放绑定既有 MR
// （不重复创建）；target 不一致 = typed mr-binding-mismatch（绝不改别人 MR）；
// observe 的 closed 状态归一（gitlab opened/merged/closed、github open/closed+
// merged）；坏凭据 → mr-lookup-failed（401 不静默）。

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  startSystemMockSuite,
  SYSTEM_MOCK_CODE_HOST_TOKEN,
  type StartedSystemMockSuite,
} from '@agent-workflow/system-mocks'

import { runGit } from '../src/util/git'
import {
  ensureMergeRequest,
  observeMergeRequest,
  type MrEnsureConnectionDeps,
} from '../src/modules/integration/application/mrEnsure'

setDefaultTimeout(120_000)

let suite: StartedSystemMockSuite

beforeAll(async () => {
  suite = await startSystemMockSuite()
})

afterAll(async () => {
  await suite.close()
})

/** mock 的 create 会校验 source branch 真实存在——先把分支推进项目 git 仓。
 *  http remote 必须走 runGit（non-interactive env）：裸 spawnSync 会被
 *  credential prompt 挂死到超时。 */
async function pushSourceBranch(repoHttpUrl: string, branch: string): Promise<void> {
  const parent = mkdtempSync(join(tmpdir(), 'rfc310-pr5-mr-src-'))
  const run = async (cwd: string, ...args: string[]): Promise<void> => {
    const out = await runGit(cwd, args, { timeoutMs: 30_000 })
    if (out.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${out.stderr.slice(0, 300)}`)
    }
  }
  await run(parent, 'clone', '-q', repoHttpUrl, 'work')
  const ws = join(parent, 'work')
  writeFileSync(join(ws, 'delivered.txt'), `by ${branch}\n`)
  await run(ws, 'checkout', '-q', '-b', branch)
  await run(ws, 'add', '-A')
  await run(
    ws,
    '-c',
    'user.email=aw@localhost',
    '-c',
    'user.name=aw',
    'commit',
    '-q',
    '-m',
    'candidate',
  )
  await run(ws, 'push', '-q', 'origin', branch)
  rmSync(parent, { recursive: true, force: true })
}

function depsOf(provider: 'gitlab' | 'github', projectId: string): MrEnsureConnectionDeps {
  return {
    provider,
    project: projectId,
    call: {
      connection: {
        provider,
        baseUrl:
          provider === 'gitlab'
            ? suite.endpoints.gitlabApiBaseUrl
            : suite.endpoints.githubApiBaseUrl,
        repositoryUrlPrefixes: [],
        token: SYSTEM_MOCK_CODE_HOST_TOKEN,
        rejectUnauthorized: true,
      },
      ctx: { ports: {}, triggerContext: null },
      sleep: async () => {},
    },
  }
}

describe('rfc310 pr5 — mr.ensure against the stateful code-host mock', () => {
  test('gitlab: create with marker → idempotent rebind → target mismatch typed → observe', async () => {
    const project = await suite.client.seedCodeHost({
      provider: 'gitlab',
      projectPath: 'team/pr5-ensure',
      baseFiles: { 'README.md': 'base\n' },
      headFiles: { 'README.md': 'head\n' },
    })
    const deps = depsOf('gitlab', project.projectId)
    await pushSourceBranch(project.repoHttpUrl, 'aw/mission-01m09ensureulid00000000000')

    const created = await ensureMergeRequest(deps, {
      missionId: '01M09ENSUREULID00000000000',
      sourceBranch: 'aw/mission-01m09ensureulid00000000000',
      targetBranch: project.defaultBranch,
      title: 'aw: deliver mission candidate',
      description: 'platform generated',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.mr.created).toBe(true)
    expect(created.mr.state).toBe('opened')
    expect(created.mr.providerCorrelationRef).toBe(
      `gitlab:${project.projectId}!${created.mr.mrRef}`,
    )

    // marker 真进了 MR body（读回 mock 的 MR 描述）。
    const observedRaw = await fetch(
      `${suite.endpoints.gitlabApiBaseUrl}/projects/${project.projectId}/merge_requests/${created.mr.mrRef}`,
      { headers: { 'private-token': SYSTEM_MOCK_CODE_HOST_TOKEN } },
    )
    const observedBody = (await observedRaw.json()) as { description?: string }
    expect(observedBody.description).toContain('[aw-mission:01M09ENSUREULID00000000000]')

    const rebound = await ensureMergeRequest(deps, {
      missionId: '01M09ENSUREULID00000000000',
      sourceBranch: 'aw/mission-01m09ensureulid00000000000',
      targetBranch: project.defaultBranch,
      title: 'aw: deliver mission candidate',
    })
    expect(rebound.ok).toBe(true)
    if (!rebound.ok) return
    expect(rebound.mr.created).toBe(false)
    expect(rebound.mr.mrRef).toBe(created.mr.mrRef)

    const mismatch = await ensureMergeRequest(deps, {
      missionId: '01M09ENSUREULID00000000000',
      sourceBranch: 'aw/mission-01m09ensureulid00000000000',
      targetBranch: 'release/other',
      title: 'aw: deliver mission candidate',
    })
    expect(mismatch.ok).toBe(false)
    if (mismatch.ok) return
    expect(mismatch.code).toBe('mr-binding-mismatch')

    const observed = await observeMergeRequest(deps, created.mr.mrRef)
    expect(observed.ok).toBe(true)
    if (!observed.ok) return
    expect(observed.mr.state).toBe('opened')
    expect(observed.mr.targetBranch).toBe(project.defaultBranch)
  })

  test('github: create + observe with normalized state', async () => {
    const project = await suite.client.seedCodeHost({
      provider: 'github',
      projectPath: 'octo/pr5-ensure',
      baseFiles: { 'README.md': 'base\n' },
      headFiles: { 'README.md': 'head\n' },
    })
    // github 的 REST 路径是 /repos/{owner}/{repo}/…——定位段用 path 而非数字 id。
    const deps = depsOf('github', project.projectPath)
    await pushSourceBranch(project.repoHttpUrl, 'aw/mission-01m09ghensureulid000000000')
    const created = await ensureMergeRequest(deps, {
      missionId: '01M09GHENSUREULID000000000',
      sourceBranch: 'aw/mission-01m09ghensureulid000000000',
      targetBranch: project.defaultBranch,
      title: 'aw: deliver mission candidate',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.mr.created).toBe(true)
    const observed = await observeMergeRequest(deps, created.mr.mrRef)
    expect(observed.ok).toBe(true)
    if (!observed.ok) return
    expect(observed.mr.state).toBe('opened')
  })

  test('bad credentials surface as typed mr-lookup-failed, not silence', async () => {
    const project = await suite.client.seedCodeHost({
      provider: 'gitlab',
      projectPath: 'team/pr5-authz',
      baseFiles: { 'README.md': 'base\n' },
      headFiles: { 'README.md': 'head\n' },
    })
    const deps = depsOf('gitlab', project.projectId)
    const badDeps: MrEnsureConnectionDeps = {
      ...deps,
      call: {
        ...deps.call,
        connection: { ...deps.call.connection, token: 'aw-fixture-wrong-token' }, // gitleaks:allow
      },
    }
    const out = await ensureMergeRequest(badDeps, {
      missionId: '01M09BADAUTHULID0000000000',
      sourceBranch: 'aw/mission-x',
      targetBranch: project.defaultBranch,
      title: 't',
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('mr-lookup-failed')
  })
})
