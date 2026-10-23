// Regression lock for the in-submodule merge agent (RFC-210 T25) in the
// standalone isolation merge-back (`platform/workspace/local/isolation.ts`).
//
// The bug: `tryAgentResolveSubmodule` handed the resolver a conflict whose
// `paths` was `[subPath]` — the gitlink NAME in the superproject (e.g.
// `vendor`) — while the conflict's worktree is the submodule itself, whose
// conflicted files are `a.txt`, … The resolver's manifest guard treats any
// conflicted path missing from the parsed manifest as an unrecognized conflict
// class and fails closed, so `vendor` (never a file inside the submodule) made
// EVERY in-submodule resolution "unresolved": the agent ran, fixed the file,
// and the repo was still withheld for a human. The fix reports the conflicted
// paths from the submodule's own `merge-tree` (relative to its worktree) with
// that same raw output for the manifest.
//
// The second test keeps the pre-existing fail-soft contract: a hard
// `merge-tree` error (exit > 1, e.g. an unreadable base) is not something an
// agent can fix — the repo is withheld instead of the merge-back throwing.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNodeIso,
  discardNodeIso,
  mergeBackNodeIso,
  resolveConflictWithAgent,
  snapshotNodeIsoFinal,
  type CanonRepo,
  type MergeBackConflict,
} from '@/services/nodeIsolation'
import { runGit } from '@/util/git'

const appHome = mkdtempSync(join(tmpdir(), 'aw-v3-subagent-home-'))
const created: string[] = [appHome]
let previousGitGlobal: string | undefined
const gitConfigDir = mkdtempSync(join(tmpdir(), 'aw-v3-subagent-cfg-'))

beforeAll(() => {
  // Local submodule URLs need protocol.file under CI's isolated git config.
  const config = join(gitConfigDir, 'gitconfig')
  writeFileSync(
    config,
    '[protocol "file"]\n\tallow = always\n[user]\n\tname = t\n\temail = t@e.com\n',
  )
  previousGitGlobal = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = config
})

afterAll(() => {
  if (previousGitGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = previousGitGlobal
  rmSync(gitConfigDir, { recursive: true, force: true })
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

async function git(dir: string, args: string[]): Promise<string> {
  const result = await runGit(dir, args)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

async function commitIn(dir: string, message: string): Promise<void> {
  await git(dir, ['add', '-A'])
  await git(dir, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', message])
}

/** A canonical worktree whose `vendor` submodule holds `a.txt`. */
async function canonWithSubmodule(): Promise<string> {
  const sub = tmp('aw-v3-subagent-sub-')
  await git(sub, ['init', '-q', '-b', 'main'])
  writeFileSync(join(sub, 'a.txt'), 'l1\nl2\nl3\n')
  await commitIn(sub, 'init')
  const host = tmp('aw-v3-subagent-host-')
  await git(host, ['init', '-q', '-b', 'main'])
  writeFileSync(join(host, 'README.md'), 'root\n')
  await commitIn(host, 'init')
  await git(host, ['submodule', 'add', '-q', sub, 'vendor'])
  await git(host, ['commit', '-q', '-m', 'add submodule'])
  const canon = join(tmp('aw-v3-subagent-wt-'), 'canon')
  await git(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
  await git(canon, ['submodule', 'update', '--init', '-q'])
  return canon
}

const canonRepo = (dir: string): CanonRepo => ({
  repoPath: dir,
  worktreePath: dir,
  mountPath: '',
  baseBranch: 'main',
})

/** Two concurrent nodes editing the same line of the submodule file. */
async function conflictingNodes(taskId: string) {
  const canon = await canonWithSubmodule()
  const a = await createNodeIso({
    appHome,
    taskId,
    nodeRunId: 'rA',
    canonRepos: [canonRepo(canon)],
  })
  const b = await createNodeIso({
    appHome,
    taskId,
    nodeRunId: 'rB',
    canonRepos: [canonRepo(canon)],
  })
  writeFileSync(join(a.repos[0]!.isoWorktreePath, 'vendor', 'a.txt'), 'l1-A\nl2\nl3\n')
  await commitIn(join(a.repos[0]!.isoWorktreePath, 'vendor'), 'A edits line 1')
  writeFileSync(join(b.repos[0]!.isoWorktreePath, 'vendor', 'a.txt'), 'l1-B\nl2\nl3\n')
  await commitIn(join(b.repos[0]!.isoWorktreePath, 'vendor'), 'B edits line 1')
  expect((await mergeBackNodeIso(a, await snapshotNodeIsoFinal(a))).clean).toBe(true)
  return { canon, a, b }
}

test('the in-submodule merge agent sees submodule-relative conflicted paths and can resolve them', async () => {
  const { canon, a, b } = await conflictingNodes('tsubpaths')
  const seen: MergeBackConflict[] = []
  const merged = await mergeBackNodeIso(
    b,
    await snapshotNodeIsoFinal(b),
    undefined,
    async (conflict) => {
      seen.push(conflict)
      return resolveConflictWithAgent(conflict, {
        containerPath: b.containerPath,
        runAgent: async (_prompt, cwd) => {
          writeFileSync(join(cwd, 'a.txt'), 'l1-AB\nl2\nl3\n')
        },
      })
    },
  )
  expect(seen).toHaveLength(1)
  // Paths are relative to the submodule worktree the conflict points at,
  // never the superproject's gitlink name.
  expect(seen[0]!.paths).toEqual(['a.txt'])
  expect(seen[0]!.canonWorktreePath).toBe(join(canon, 'vendor'))
  expect(seen[0]!.mergedTree).toMatch(/^[0-9a-f]{40,64}$/)
  expect(seen[0]!.rawConflictOutput).toContain('a.txt')
  // Before the fix this merge-back withheld the repo despite the resolution.
  expect(merged.clean).toBe(true)
  expect(readFileSync(join(canon, 'vendor', 'a.txt'), 'utf8')).toBe('l1-AB\nl2\nl3\n')
  await discardNodeIso(a)
  await discardNodeIso(b)
}, 180_000)

test('a hard submodule merge-tree error withholds the repo instead of throwing', async () => {
  const { b, a } = await conflictingNodes('tsubhard')
  const trees = await snapshotNodeIsoFinal(b)
  // An unreadable merge base makes `git merge-tree` exit 128.
  b.repos[0]!.subBases['vendor'] = '0'.repeat(40)
  let resolverCalls = 0
  const merged = await mergeBackNodeIso(b, trees, undefined, async () => {
    resolverCalls++
    return { resolved: true }
  })
  expect(merged.clean).toBe(false)
  expect(resolverCalls).toBe(0)
  await discardNodeIso(a)
  await discardNodeIso(b)
}, 180_000)
