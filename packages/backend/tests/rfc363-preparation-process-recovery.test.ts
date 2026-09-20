// RFC-363: real process interruption, durable provider rows and real Git/HTTP.
// The worker is killed after the first commit set and physical intent are stored.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { describeEachProvider } from './helpers/eachProvider'
import { remoteUrlFor, startGitHttpRemote, stopGitHttpRemote } from './helpers/gitHttpRemote'

const roots: string[] = []
beforeAll(async () => {
  await startGitHttpRemote()
})
afterAll(stopGitHttpRemote)
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const worker = resolve(import.meta.dir, 'fixtures', 'rfc363-preparation-crash-worker.ts')
function git(repo: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rfc363-crash-'))
  roots.push(root)
  const repo = join(root, 'source')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  const commit = (text: string) => {
    writeFileSync(join(repo, 'a.txt'), text)
    git(repo, 'add', 'a.txt')
    git(
      repo,
      '-c',
      'user.name=RFC363',
      '-c',
      'user.email=rfc363@example.test',
      'commit',
      '-qm',
      text,
    )
    return git(repo, 'rev-parse', 'HEAD')
  }
  return { root, repo, base: commit('frozen'), commit }
}
function waitForCheckpoint(root: string, exited: Promise<number>): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let done = false
    const finish = (error?: Error) => {
      if (done) return
      done = true
      watcher.close()
      clearTimeout(timer)
      if (error) reject(error)
      else resolveReady()
    }
    const watcher = watch(root, () => {
      if (existsSync(join(root, 'ready.json'))) finish()
    })
    const timer = setTimeout(() => finish(new Error('checkpoint was not reached')), 30_000)
    void exited.then((code) => finish(new Error(`worker exited before checkpoint: ${code}`)))
    if (existsSync(join(root, 'ready.json'))) finish()
  })
}

describeEachProvider('RFC-363 real-process preparation recovery', (harness) => {
  for (const point of [
    'before-worktree-add',
    'post-add-before-submodules',
    'working-branch-prepared-before-cas',
    'changed-prepared-branch',
  ] as const) {
    test(`same operation survives process death at ${point}`, async () => {
      const f = fixture()
      const binding = harness.applicationBinding
      const input = {
        root: f.root,
        remote: remoteUrlFor(f.repo),
        taskId: ulid(),
        operation: `sc:operation:v1:${ulid()}`,
        snapshot: `sc:preparation:v1:${ulid()}`,
        source: `sc:source:v1:${ulid()}`,
        ...(point === 'working-branch-prepared-before-cas' ? { workingBranch: 'release' } : {}),
        provider:
          binding.provider === 'sqlite'
            ? { kind: 'sqlite' }
            : {
                kind: 'postgresql',
                config: binding.databaseConfig,
                generationId: binding.runtime.generationId,
              },
      }
      const inputPath = join(f.root, 'input.json')
      writeFileSync(inputPath, JSON.stringify(input))
      const children: Array<Pick<ReturnType<typeof Bun.spawn>, 'exitCode' | 'kill' | 'exited'>> = []
      const launch = (crashPoint: string) => {
        const child = Bun.spawn({
          cmd: [process.execPath, 'run', worker, inputPath],
          cwd: resolve(import.meta.dir, '..'),
          env: { ...process.env, RFC363_CRASH_POINT: crashPoint },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        })
        children.push(child)
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
        timer.unref()
        void child.exited.then(() => clearTimeout(timer))
        return child
      }
      const first = launch(
        point === 'changed-prepared-branch' ? 'post-add-before-submodules' : point,
      )
      const firstOut = new Response(first.stdout).text(),
        firstErr = new Response(first.stderr).text()
      try {
        try {
          await waitForCheckpoint(f.root, first.exited)
        } catch (error) {
          first.kill('SIGKILL')
          await first.exited
          throw new Error(`${String(error)}\n${await firstOut}\n${await firstErr}`)
        }
        const checkpoint = JSON.parse(readFileSync(join(f.root, 'ready.json'), 'utf8')) as {
          worktreePath: string
        }
        first.kill('SIGKILL')
        await first.exited
        f.commit('branch moved after crash')
        let changedHead: string | undefined
        if (point === 'changed-prepared-branch') {
          writeFileSync(join(checkpoint.worktreePath, 'a.txt'), 'another writer')
          git(checkpoint.worktreePath, 'add', 'a.txt')
          git(
            checkpoint.worktreePath,
            '-c',
            'user.name=RFC363',
            '-c',
            'user.email=rfc363@example.test',
            'commit',
            '-qm',
            'external branch change',
          )
          changedHead = git(checkpoint.worktreePath, 'rev-parse', 'HEAD')
        }
        const marker = join(checkpoint.worktreePath, 'retained-after-crash')
        if (point === 'post-add-before-submodules') writeFileSync(marker, 'reuse this directory')
        const resumed = launch('')
        const stdout = new Response(resumed.stdout).text(),
          stderr = new Response(resumed.stderr).text()
        const code = await resumed.exited
        expect({
          code,
          stderr: code === 0 ? '' : await stderr,
          stdout: code === 0 ? '' : await stdout,
        }).toEqual({ code: 0, stderr: '', stdout: '' })
        const result = JSON.parse(readFileSync(join(f.root, 'result.json'), 'utf8')) as {
          outcome: { kind: string; receipt: string }
          row: { resolvedJson: string; receiptJson: string }
        }
        if (changedHead !== undefined) {
          expect(result.outcome.kind).toBe('failed')
          expect(git(checkpoint.worktreePath, 'rev-parse', 'HEAD')).toBe(changedHead)
          expect(readFileSync(join(checkpoint.worktreePath, 'a.txt'), 'utf8')).toBe(
            'another writer',
          )
          return
        }
        expect(result.outcome.kind).toBe('prepared')
        const receipt = JSON.parse(result.row.receiptJson) as {
          space: {
            worktreePath: string
            baseCommit: string
            cleanup: { worktrees: Array<{ branchBefore: string | null }> }
          }
        }
        expect(receipt.space.baseCommit).toBe(f.base)
        expect(readFileSync(join(receipt.space.worktreePath, 'a.txt'), 'utf8')).toBe('frozen')
        expect(receipt.space.cleanup.worktrees[0]?.branchBefore).toBeNull()
        if (point === 'post-add-before-submodules')
          expect(readFileSync(marker, 'utf8')).toBe('reuse this directory')
        const replay = launch('')
        const replayError = new Response(replay.stderr).text()
        void new Response(replay.stdout).text()
        expect({ code: await replay.exited, error: await replayError }).toEqual({
          code: 0,
          error: '',
        })
        const replayed = JSON.parse(
          readFileSync(join(f.root, 'result.json'), 'utf8'),
        ) as typeof result
        expect(replayed.outcome).toEqual(result.outcome)
        expect(replayed.row.resolvedJson).toBe(result.row.resolvedJson)
      } finally {
        for (const child of children) {
          if (child.exitCode === null) child.kill('SIGKILL')
          await child.exited
        }
      }
    }, 90_000)
  }
})
