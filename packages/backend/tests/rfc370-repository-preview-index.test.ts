// RFC-370 A4: a selected index owns acquisition/release; AW retains candidate selection.
import { describe, expect, test } from 'bun:test'
import { bindRepositoryCommitParticipant } from '../src/modules/source-control/composition'
import type {
  RepositoryPreviewIndexPort,
  RepositoryPreviewIndexScope,
} from '../src/modules/source-control/application/ports/repositoryPreviewIndex'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function indexScope(failure?: string) {
  const calls: Array<{ args: string[]; literal: boolean }> = []
  const scope: RepositoryPreviewIndexScope = {
    async run(args, options) {
      expect(this).toBe(scope)
      calls.push({ args: [...args], literal: options?.literalPathspecs === true })
      const stage =
        args[0] === 'diff' ? (args.includes('--name-status') ? 'inventory' : 'diff') : args[0]
      if (stage === failure) return { stdout: '', stderr: 'selected index failure', exitCode: 1 }
      return {
        stdout:
          stage === 'inventory'
            ? 'M\0tracked.tmp\0M\0keep.txt\0'
            : stage === 'diff'
              ? 'selected candidate diff'
              : '',
        stderr: '',
        exitCode: stage === 'config' ? 1 : 0,
      }
    },
  }
  return { scope, calls }
}

describe('RFC-370 selected repository preview index', () => {
  test('waits for selected acquisition and release, preserves selection and literal path options', async () => {
    const acquire = barrier()
    const reclaim = barrier()
    const entered = barrier()
    const operationDone = barrier()
    const { scope, calls } = indexScope()
    const port: RepositoryPreviewIndexPort = {
      async withIndex(operation) {
        expect(this).toBe(port)
        entered.release()
        await acquire.promise
        try {
          return await operation(scope)
        } finally {
          operationDone.release()
          await reclaim.promise
        }
      },
    }
    const participant = bindRepositoryCommitParticipant({
      repoPath: 'workspace://selected-preview',
      configuredPatterns: ['*.tmp'],
      previewIndex: port,
      runGit: async () => {
        throw new Error('preview must use the selected index')
      },
    })
    let settled = false
    const pending = participant.preview().finally(() => {
      settled = true
    })
    try {
      await entered.promise
      expect(calls).toEqual([])
      expect(settled).toBe(false)
      acquire.release()
      await operationDone.promise
      expect(settled).toBe(false)
      expect(calls.map((call) => call.args[0])).toEqual([
        'read-tree',
        'add',
        'config',
        'diff',
        'reset',
        'diff',
      ])
      expect(calls[4]).toEqual({
        args: ['reset', '-q', 'HEAD', '--', 'tracked.tmp'],
        literal: true,
      })
      expect(calls.filter((call) => call.args[0] !== 'reset').every((call) => !call.literal)).toBe(
        true,
      )
      reclaim.release()
      const result = await pending
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.diff).toBe('selected candidate diff')
        expect(result.receipt.excludedPaths).toEqual(['tracked.tmp'])
        expect(result.receipt.policyDigest).not.toBe('')
      }
    } finally {
      acquire.release()
      reclaim.release()
      await pending
    }
  })

  for (const [stage, message] of [
    ['read-tree', 'git preview index initialization failed'],
    ['add', 'git add failed'],
    ['inventory', 'git staged-path inventory failed'],
    ['reset', 'git excluded-path reset failed'],
    ['diff', 'git preview diff failed'],
  ]) {
    test(`preserves the original ${stage} failure and releases the selected index`, async () => {
      const { scope, calls } = indexScope(stage)
      let releases = 0
      const port: RepositoryPreviewIndexPort = {
        async withIndex(operation) {
          try {
            return await operation(scope)
          } finally {
            releases++
          }
        },
      }
      const result = await bindRepositoryCommitParticipant({
        repoPath: 'workspace://selected-failure',
        configuredPatterns: ['*.tmp'],
        previewIndex: port,
      }).preview()
      expect(result).toEqual({ ok: false, error: `${message}: selected index failure` })
      expect(releases).toBe(1)
      const last = calls.at(-1)!.args
      expect(last[0]).toBe(stage === 'inventory' || stage === 'diff' ? 'diff' : stage)
      if (stage === 'inventory') expect(last).toContain('--name-status')
      if (stage === 'diff') expect(last).toContain('--unified=3')
    })
  }

  test('propagates acquisition failure without invoking a local Git fallback', async () => {
    const failure = new Error('selected index unavailable')
    let physicalCalls = 0
    const port: RepositoryPreviewIndexPort = {
      async withIndex() {
        throw failure
      },
    }
    const pending = bindRepositoryCommitParticipant({
      repoPath: 'workspace://unavailable',
      previewIndex: port,
      runGit: async () => {
        physicalCalls++
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }).preview()
    await expect(pending).rejects.toBe(failure)
    expect(physicalCalls).toBe(0)
  })

  test('an operation rejection waits for release and retains the exact error', async () => {
    const failure = new Error('selected Git rejected')
    const operationDone = barrier()
    const reclaim = barrier()
    let settled = false
    const port: RepositoryPreviewIndexPort = {
      async withIndex(operation) {
        try {
          return await operation({
            async run() {
              throw failure
            },
          })
        } finally {
          operationDone.release()
          await reclaim.promise
        }
      },
    }
    const pending = bindRepositoryCommitParticipant({
      repoPath: 'workspace://rejected',
      previewIndex: port,
    })
      .preview()
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => {
        settled = true
      })
    try {
      await operationDone.promise
      expect(settled).toBe(false)
      reclaim.release()
      expect(await pending).toEqual({ ok: false, error: failure })
    } finally {
      reclaim.release()
      await pending
    }
  })
})
