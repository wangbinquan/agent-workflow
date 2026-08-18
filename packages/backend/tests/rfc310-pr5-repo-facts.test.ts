// RFC-310 PR-5 T53 —— repository facts collector（真仓库探测）。
//
// 锁：①languages/buildSystems/moduleIds 启发式（maven <modules> 优先、顶层
// 构建目录兜底、根构建文件记 'root'）；②contributor 指令文档与 per-module
// 语言的 `__` 内部投影（正文不进 cells，只投相对路径/归属）；③refresh/失效
// = sourceRevision 跟 exact HEAD sha——HEAD 前进后 re-collect 的 cells 内容
// 变化让 decision dedup 自然重开（design §2.6：没有专用 refresh 逻辑）；
// ④reconciler 端到端：collect-repository-facts arm 用真 collector 后，规则
// 从 indeterminate 走到 implement。

import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRepositoryFactsCollector } from '../src/modules/development-automation/infrastructure/repositoryFactsCollector'
import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import { cachedRepos } from '../src/db/schema'
import { buildPr3Fixture } from './helpers/rfc310Pr3Fixture'
import { fakeAgentActionPorts } from './helpers/rfc310AgentPorts'

setDefaultTimeout(120_000)

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync({ cmd: ['git', ...args], cwd })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
  }
  return proc.stdout.toString()
}

function commitAll(repo: string, message: string): string {
  git(repo, 'add', '-A')
  git(repo, '-c', 'user.email=t53@test', '-c', 'user.name=t53', 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD').trim()
}

let repoPath = ''
let headSha = ''

beforeAll(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'rfc310-t53-repo-'))
  git(repoPath, 'init', '-q')
  // maven 多模块 + ts 前端 + contributor 文档。
  writeFileSync(
    join(repoPath, 'pom.xml'),
    '<project><modules><module>core</module><module>api</module></modules></project>\n',
  )
  mkdirSync(join(repoPath, 'core/src'), { recursive: true })
  writeFileSync(join(repoPath, 'core/pom.xml'), '<project/>\n')
  writeFileSync(join(repoPath, 'core/src/App.java'), 'class App {}\n')
  mkdirSync(join(repoPath, 'web'), { recursive: true })
  writeFileSync(join(repoPath, 'web/package.json'), '{}\n')
  writeFileSync(join(repoPath, 'web/index.ts'), 'export const a = 1\n')
  writeFileSync(join(repoPath, 'CONTRIBUTING.md'), '# how to contribute\n')
  writeFileSync(join(repoPath, 'CLAUDE.md'), '# agent instructions\n')
  headSha = commitAll(repoPath, 'baseline')
})

describe('rfc310 pr5 T53 — repository facts collector', () => {
  test('detects languages, build systems, maven module catalog and contributor docs', async () => {
    const fx = await buildPr3Fixture()
    fx.db
      .insert(cachedRepos)
      .values({
        id: 'repo-1',
        urlHash: 't53aaaa1',
        localPath: repoPath,
        lastFetchedAt: Date.now(),
        createdAt: Date.now(),
      })
      .run()
    const collector = createRepositoryFactsCollector(fx.db)
    const out = await collector.collect({ missionId: 'm-1', repositoryId: 'repo-1' })

    expect(out.factsRef).toBe(`repo:${headSha}`)
    expect(out.cells['repository.languages']).toMatchObject({
      state: 'known',
      value: ['java', 'typescript'],
      sourceRevision: headSha,
    })
    expect(out.cells['repository.buildSystems']).toMatchObject({
      state: 'known',
      value: ['maven', 'npm'],
    })
    // maven <modules> 优先作为 module catalog。
    expect(out.cells['repository.moduleIds']).toMatchObject({
      state: 'known',
      value: ['api', 'core'],
    })
    // 内部投影：文档相对路径 + per-module 语言（正文不进 cells）。
    expect(out.cells['__repository.contributorDocs']).toMatchObject({
      state: 'known',
      value: ['CONTRIBUTING.md', 'CLAUDE.md'],
    })
    expect(out.cells['__repository.languageByModule']).toMatchObject({
      state: 'known',
      value: ['core=java', 'web=typescript'],
    })
  })

  test('sourceRevision follows exact HEAD: a new commit re-opens decision dedup naturally', async () => {
    const fx = await buildPr3Fixture()
    // --randomize 会打乱同 describe 内 test 顺序：本 test 要再 commit，必须用
    // 自己的 clone，不能污染共享 repoPath（否则先跑会让 beforeAll 的 headSha 过期）。
    const workRepo = join(mkdtempSync(join(tmpdir(), 'rfc310-t53-mut-')), 'work')
    git(mkdtempSync(join(tmpdir(), 'rfc310-t53-cwd-')), 'clone', '-q', repoPath, workRepo)
    fx.db
      .insert(cachedRepos)
      .values({
        id: 'repo-1',
        urlHash: 't53aaaa2',
        localPath: workRepo,
        lastFetchedAt: Date.now(),
        createdAt: Date.now(),
      })
      .run()
    const collector = createRepositoryFactsCollector(fx.db)
    const before = await collector.collect({ missionId: 'm-1', repositoryId: 'repo-1' })

    writeFileSync(join(workRepo, 'core/src/New.kt'), 'class New\n')
    const newSha = commitAll(workRepo, 'add kotlin')
    const after = await collector.collect({ missionId: 'm-1', repositoryId: 'repo-1' })

    expect(after.factsRef).toBe(`repo:${newSha}`)
    expect(after.cells['repository.languages']).toMatchObject({
      state: 'known',
      value: ['java', 'kotlin', 'typescript'],
      sourceRevision: newSha,
    })
    expect(
      (before.cells['repository.languages'] as { sourceRevision: string }).sourceRevision,
    ).not.toBe(newSha)
  })

  test('uncached repository is a loud error, never empty facts', async () => {
    const fx = await buildPr3Fixture()
    const collector = createRepositoryFactsCollector(fx.db)
    await expect(
      collector.collect({ missionId: 'm-1', repositoryId: 'repo-none' }),
    ).rejects.toThrow(/not cached/)
  })

  test('end to end: real collector unblocks the rules chain to implement', async () => {
    const fx = await buildPr3Fixture()
    fx.db
      .insert(cachedRepos)
      .values({
        id: 'repo-1',
        urlHash: 't53aaaa3',
        localPath: repoPath,
        lastFetchedAt: Date.now(),
        createdAt: Date.now(),
      })
      .run()
    const launches: string[] = []
    const deps = fx.deps({
      repositoryFacts: createRepositoryFactsCollector(fx.db),
      ...fakeAgentActionPorts({ db: fx.db, launches }),
    })
    const missionId = await fx.launchDirect('t53-e2e-1')
    await fx.materializer.stashDirectSubmission({
      missionId,
      submission: { title: 'Add feature', body: 'do the thing', uploads: [] },
    })
    await runMissionReconcile(deps, missionId) // materialize
    const collectRound = await runMissionReconcile(deps, missionId)
    expect(collectRound.kind === 'decided' && collectRound.selected.kind).toBe(
      'collect-repository-facts',
    )
    const actionRound = await runMissionReconcile(deps, missionId)
    expect(actionRound.kind === 'decided' && actionRound.handled).toBe('action-launched')
    expect(launches).toEqual(['change.implement'])
  })
})
