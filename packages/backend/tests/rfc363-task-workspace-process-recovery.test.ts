// RFC-363: real process interruption, durable provider rows and real Git/HTTP.
// The worker is killed after the first commit set and physical intent are stored.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
const worker = resolve(import.meta.dir, 'fixtures', 'rfc363-task-workspace-crash-worker.ts')
function git(repo: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rfc363-task-crash-')))
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

describeEachProvider('RFC-363 production Task pre-admission process recovery', (harness) => {
  for (const [scratch, point] of [
    [false, 'prepared-before-upload'],
    [false, 'uploaded-before-admit'],
    [true, 'scratch-root-before-artifact'],
    [true, 'uploaded-before-admit'],
    [false, 'upload-reserved-before-file'],
    [false, 'uploaded-file-before-receipt'],
    [true, 'upload-reserved-before-file'],
    [true, 'uploaded-file-before-receipt'],
  ] as const) {
    test(`${scratch ? 'scratch' : 'repository'} survives SIGKILL at ${point}`, async () => {
      const f = fixture()
      const binding = harness.applicationBinding
      const input = {
        root: f.root,
        taskId: ulid(),
        workflowId: ulid(),
        scratch,
        remote: remoteUrlFor(f.repo),
        provider:
          binding.provider === 'sqlite'
            ? { kind: 'sqlite' }
            : {
                kind: 'postgresql',
                config: binding.databaseConfig,
                generationId: binding.runtime.generationId,
              },
      }
      const path = join(f.root, 'input.json')
      writeFileSync(path, JSON.stringify(input))
      const children: Array<Pick<ReturnType<typeof Bun.spawn>, 'exitCode' | 'kill' | 'exited'>> = []
      const launch = (point: string) => {
        const child = Bun.spawn({
          cmd: [process.execPath, 'run', worker, path],
          cwd: resolve(import.meta.dir, '..'),
          env: { ...process.env, RFC363_TASK_CRASH_POINT: point },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        })
        children.push(child)
        const timer = setTimeout(() => child.kill('SIGKILL'), 45_000)
        timer.unref()
        void child.exited.then(() => clearTimeout(timer))
        return child
      }
      const first = launch(point)
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
          baseCommit: string
        }
        first.kill('SIGKILL')
        await first.exited
        if (!scratch) f.commit('remote moved after preparation')
        const second = launch('')
        const out = new Response(second.stdout).text(),
          err = new Response(second.stderr).text()
        const code = await second.exited
        expect({ code, diagnostics: code === 0 ? '' : `${await out}\n${await err}` }).toEqual({
          code: 0,
          diagnostics: '',
        })
        const result = JSON.parse(readFileSync(join(f.root, 'result.json'), 'utf8'))
        expect(result.rows).toEqual([{ id: input.taskId }])
        expect(result.plan).toMatchObject({
          state: 'admitted',
          lane: 'pre-materialized',
          admittedTaskId: input.taskId,
        })
        expect(result.cleanupRejected).toBe(true)
        expect(result.task.inputs.refs).toBe('inputs/attachment.txt')
        expect(readdirSync(join(checkpoint.worktreePath, 'inputs'))).toEqual(['attachment.txt'])
        expect(result.task.worktreePath).toBe(checkpoint.worktreePath)
        expect(result.task.baseCommit).toBe(checkpoint.baseCommit)
        expect(readFileSync(join(checkpoint.worktreePath, 'preserve.txt'), 'utf8')).toBe(
          'physical preparation survived',
        )
        expect(
          readFileSync(join(checkpoint.worktreePath, 'inputs', 'attachment.txt'), 'utf8'),
        ).toBe('durable upload')
        expect(git(checkpoint.worktreePath, 'rev-list', '--count', 'HEAD')).toBe('1')
      } finally {
        for (const child of children)
          if (child.exitCode === null) {
            child.kill('SIGKILL')
            await child.exited
          }
      }
    }, 90_000)
  }
})
