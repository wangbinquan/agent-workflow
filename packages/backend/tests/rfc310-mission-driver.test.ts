// RFC-310 production progress regression.
//
// The single-step reconciler is an audit primitive. The HTTP/daemon caller must
// drive settled synchronous decisions until a real async boundary; otherwise a
// newly launched direct mission stops after requirement materialization and no
// wake source exists to ever start its Agent.

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cachedRepos } from '../src/db/schema'
import { composeDevelopmentAutomation } from '../src/modules/development-automation/composition'
import type { AgentActionLauncherPort } from '../src/modules/development-automation/application/ports/reconcilerPorts'
import { bindChangeCandidateParticipant } from '../src/modules/source-control/composition'
import { createDeferredMissionDrive } from '../src/modules/development-automation/application/missionDriver'
import { buildPr3Fixture } from './helpers/rfc310Pr3Fixture'

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync({ cmd: ['git', ...args], cwd })
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
}

test('mission driver crosses every settled setup step and stops at the Agent boundary', async () => {
  const fx = await buildPr3Fixture()
  const home = mkdtempSync(join(tmpdir(), 'rfc310-driver-'))
  const repo = join(home, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(repo + '/pom.xml', '<project/>\n')
  writeFileSync(repo + '/App.java', 'class App {}\n')
  git(repo, 'add', '-A')
  git(
    repo,
    '-c',
    'user.name=driver-test',
    '-c',
    'user.email=driver@test.invalid',
    'commit',
    '-q',
    '-m',
    'base',
  )
  fx.db
    .insert(cachedRepos)
    .values({
      id: 'repo-1',
      urlHash: 'driver-test',
      localPath: repo,
      defaultBranch: 'main',
      lastFetchedAt: Date.now(),
      createdAt: Date.now(),
    })
    .run()

  const launches: string[] = []
  const launcher: AgentActionLauncherPort = {
    async launch(input) {
      launches.push(input.actionRunId)
      return { ok: true, executionRef: `driver-exec-${launches.length}` }
    },
    async fetchOutcome(executionRef) {
      return { kind: 'pending', executionRef, taskStatus: 'running' }
    },
    async cancel() {
      return { settled: 'already-terminal' }
    },
  }
  const automation = composeDevelopmentAutomation({
    db: fx.db,
    appHome: home,
    agentLauncher: launcher,
    changeCandidate: bindChangeCandidateParticipant(),
  })
  const missionId = await fx.launchDirect('driver-direct')
  const stashed = await automation.materializer.stashDirectSubmission({
    missionId,
    submission: { title: 'Add feature', body: 'do the thing', uploads: [] },
  })
  expect(stashed.ok).toBe(true)

  const outcome = await automation.drive(missionId)

  expect(outcome).toMatchObject({
    steps: 3,
    stop: 'async-boundary',
    last: { kind: 'decided', handled: 'action-launched' },
  })
  expect(launches).toHaveLength(1)
  expect(fx.store.getMission(missionId)?.currentActionRunId).toBe(launches[0])
})

// 这条锁的是「child Mission 的 drive 与 ReconcileDeps 互相引用」那处延迟绑定：守卫
// 属应用层（composition 只 bind——rfc310-architecture-lock 机械禁止装配层写业务分支），
// 且未绑定时必须显式抛错，绝不静默变成一次空转的子任务推进。
test('deferred mission drive refuses to run before composition finished binding', async () => {
  const deferred = createDeferredMissionDrive()
  await expect(deferred.drive('mission-1')).rejects.toThrow(
    'development-automation-composition-incomplete',
  )
})
