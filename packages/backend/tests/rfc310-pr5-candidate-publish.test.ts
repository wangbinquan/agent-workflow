// RFC-310 PR-5 T59 —— candidate commit + exact-head CAS 发布（design §9.2）。
//
// 真 git 现场（baseline 镜像 + file bare remote）。锁：
//   1. commitCandidate 是 stage 重放对拍——pinned treeOid 不符（prepare 后
//      overlay 又被改）⇒ candidate-drifted，绝不带病 commit；
//   2. commit 幂等（同身份复用，不产生第二个 commit 对象）+ durable 内部 ref；
//   3. push 只有「新建/fast-forward」两形态：remote 已前进 ⇒ typed
//      remote-head-changed（对拍窗口后的并发推进由 git 拒 non-ff 兜底同码）；
//   4. 幂等重放：远端已是同身份 candidate ⇒ reused receipt，不重复 push；
//   5. 文本锁：deliverCandidate.ts 源码里没有任何 force 形态。

import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { deriveChangeCandidate } from '../src/modules/source-control/application/changeCandidate'
import {
  commitCandidate,
  missionCandidateRef,
  pushCandidate,
} from '../src/modules/source-control/application/deliverCandidate'
import { missionSourceBranch } from '../src/modules/source-control/domain/deliveryPolicy'

setDefaultTimeout(120_000)

const MISSION = '01M09PUBLISHULID0000000000'

let baselineRepo = ''
let remoteRepo = ''
let baselineSha = ''

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync({ cmd: ['git', ...args], cwd })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
  }
  return proc.stdout.toString()
}

function makeOverlay(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc310-pr5-overlay-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

const BASE_FILES = {
  'README.md': '# baseline\n',
  'src/app.ts': 'export const app = 1\n',
}

beforeAll(() => {
  baselineRepo = mkdtempSync(join(tmpdir(), 'rfc310-pr5-baseline-'))
  git(baselineRepo, 'init', '-q')
  for (const [rel, content] of Object.entries(BASE_FILES)) {
    mkdirSync(resolve(baselineRepo, rel, '..'), { recursive: true })
    writeFileSync(join(baselineRepo, rel), content)
  }
  git(baselineRepo, 'add', '-A')
  git(baselineRepo, '-c', 'user.email=p5@test', '-c', 'user.name=p5', 'commit', '-q', '-m', 'base')
  baselineSha = git(baselineRepo, 'rev-parse', 'HEAD').trim()

  remoteRepo = mkdtempSync(join(tmpdir(), 'rfc310-pr5-remote-'))
  git(remoteRepo, 'init', '-q', '--bare')
})

async function derivedReceipt(overlay: string) {
  const derived = await deriveChangeCandidate({
    baselineRepoPath: baselineRepo,
    baselineSha,
    overlayRoot: overlay,
    excludePolicyDigest: 'x'.repeat(64),
    agentOutcomeRef: 'attempt-1',
  })
  expect(derived.ok).toBe(true)
  if (!derived.ok) throw new Error('derive failed')
  return derived.receipt
}

describe('rfc310 pr5 — candidate commit + CAS publish', () => {
  test('commit → durable internal ref → new-branch push → post-push verification; replay is reused end to end', async () => {
    const overlay = makeOverlay({ ...BASE_FILES, 'src/feature.ts': 'export const f = 1\n' })
    const receipt = await derivedReceipt(overlay)

    const committed = await commitCandidate({
      baselineRepoPath: baselineRepo,
      baselineSha,
      overlayRoot: overlay,
      expectedTreeOid: receipt.treeOid,
      missionId: MISSION,
      summarySource: 'add feature module',
      uploadPlan: null,
    })
    expect(committed.ok).toBe(true)
    if (!committed.ok) return
    expect(committed.reused).toBe(false)
    // durable：对象已在 baseline 镜像 + 内部 ref 指向它；message 是平台模板。
    expect(git(baselineRepo, 'rev-parse', missionCandidateRef(MISSION)).trim()).toBe(
      committed.commitSha,
    )
    const message = git(baselineRepo, 'log', '-1', '--format=%B', committed.commitSha)
    expect(message).toContain('aw: add feature module')
    expect(message).toContain(`[aw-mission:${MISSION}]`)
    const author = git(baselineRepo, 'log', '-1', '--format=%an <%ae>', committed.commitSha)
    expect(author.trim()).toBe('agent-workflow <agent-workflow@localhost>')

    // commit 幂等：重放复用同一 commit 对象。
    const replayedCommit = await commitCandidate({
      baselineRepoPath: baselineRepo,
      baselineSha,
      overlayRoot: overlay,
      expectedTreeOid: receipt.treeOid,
      missionId: MISSION,
      summarySource: 'add feature module',
      uploadPlan: null,
    })
    expect(replayedCommit.ok && replayedCommit.reused).toBe(true)
    if (replayedCommit.ok) expect(replayedCommit.commitSha).toBe(committed.commitSha)

    const branch = missionSourceBranch(MISSION)
    const pushed = await pushCandidate({
      baselineRepoPath: baselineRepo,
      commitSha: committed.commitSha,
      remoteUrl: remoteRepo,
      branch,
      expectedRemoteSha: null,
      expectedTreeOid: receipt.treeOid,
      baselineSha,
    })
    expect(pushed.ok).toBe(true)
    if (!pushed.ok) return
    expect(pushed.receipt).toMatchObject({
      remoteRef: `refs/heads/${branch}`,
      oldSha: null,
      newSha: committed.commitSha,
      reused: false,
    })
    expect(git(remoteRepo, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(committed.commitSha)

    // push 幂等重放：远端已是同身份 ⇒ reused，不再 push。
    const replayedPush = await pushCandidate({
      baselineRepoPath: baselineRepo,
      commitSha: committed.commitSha,
      remoteUrl: remoteRepo,
      branch,
      expectedRemoteSha: null,
      expectedTreeOid: receipt.treeOid,
      baselineSha,
    })
    expect(replayedPush.ok).toBe(true)
    if (replayedPush.ok) expect(replayedPush.receipt.reused).toBe(true)
  })

  test('candidate drift after prepare voids the whole candidate (no commit happens)', async () => {
    const overlay = makeOverlay({ ...BASE_FILES, 'src/other.ts': 'export const o = 1\n' })
    const receipt = await derivedReceipt(overlay)
    // prepare 之后现场又被改动 ⇒ 重放树身份漂移。
    writeFileSync(join(overlay, 'src', 'other.ts'), 'export const o = 2\n')
    const committed = await commitCandidate({
      baselineRepoPath: baselineRepo,
      baselineSha,
      overlayRoot: overlay,
      expectedTreeOid: receipt.treeOid,
      missionId: '01M09DRIFTULID000000000000',
      summarySource: 'drifted',
      uploadPlan: null,
    })
    expect(committed.ok).toBe(false)
    if (committed.ok) return
    expect(committed.code).toBe('candidate-drifted')
  })

  test('remote head moved by someone else → typed remote-head-changed, never an overwrite', async () => {
    const missionId = '01M09RACEULID0000000000000'
    const branch = missionSourceBranch(missionId)
    const overlay = makeOverlay({ ...BASE_FILES, 'src/race.ts': 'export const r = 1\n' })
    const receipt = await derivedReceipt(overlay)
    const committed = await commitCandidate({
      baselineRepoPath: baselineRepo,
      baselineSha,
      overlayRoot: overlay,
      expectedTreeOid: receipt.treeOid,
      missionId,
      summarySource: 'race',
      uploadPlan: null,
    })
    expect(committed.ok).toBe(true)
    if (!committed.ok) return

    // 别人先占了这个分支（不同内容）。
    const foreign = mkdtempSync(join(tmpdir(), 'rfc310-pr5-foreign-'))
    git(foreign, 'clone', '-q', remoteRepo, 'work')
    const foreignWs = join(foreign, 'work')
    writeFileSync(join(foreignWs, 'human.txt'), 'human was here\n')
    git(foreignWs, 'checkout', '-q', '-b', branch)
    git(foreignWs, 'add', '-A')
    git(foreignWs, '-c', 'user.email=h@t', '-c', 'user.name=h', 'commit', '-q', '-m', 'human')
    git(foreignWs, 'push', '-q', 'origin', branch)
    const foreignSha = git(foreignWs, 'rev-parse', 'HEAD').trim()

    const pushed = await pushCandidate({
      baselineRepoPath: baselineRepo,
      commitSha: committed.commitSha,
      remoteUrl: remoteRepo,
      branch,
      expectedRemoteSha: null,
      expectedTreeOid: receipt.treeOid,
      baselineSha,
    })
    expect(pushed.ok).toBe(false)
    if (pushed.ok) return
    expect(pushed.code).toBe('remote-head-changed')
    // 远端毫发无损。
    expect(git(remoteRepo, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(foreignSha)
  })

  test('text lock: the publish path has no force form at all', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '..', 'src/modules/source-control/application/deliverCandidate.ts'),
      'utf8',
    )
    const codeLines = source
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).not.toMatch(/force/i)
  })
})
