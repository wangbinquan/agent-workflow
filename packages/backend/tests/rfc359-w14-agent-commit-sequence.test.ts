import { describe, expect, test } from 'bun:test'
import {
  continueResourceCommit,
  finishSynchronousResourceCommit,
  forEachResourceCommit,
} from '@/modules/resource-catalog/infrastructure/resourceCommitSequence'

describe('resource commit sequencing', () => {
  test('immediate steps finish synchronously in the original iteration order', () => {
    const observed: string[] = []
    const result = forEachResourceCommit([1, 2], (value) =>
      continueResourceCommit(value, (loaded) => {
        observed.push(`read:${loaded}`, `write:${loaded}`)
      }),
    )
    expect(result).toBeUndefined()
    finishSynchronousResourceCommit(result)
    expect(observed).toEqual(['read:1', 'write:1', 'read:2', 'write:2'])
  })

  test('a pending read settles before the next item or completion is observed', async () => {
    const release = Promise.withResolvers<void>()
    const observed: string[] = []
    const result = forEachResourceCommit([1, 2], (value) => {
      observed.push(`start:${value}`)
      return continueResourceCommit(value === 1 ? release.promise : undefined, () => {
        observed.push(`finish:${value}`)
      })
    })
    expect(observed).toEqual(['start:1'])
    expect(() => finishSynchronousResourceCommit(result)).toThrow(
      'synchronous resource commit received an asynchronous step',
    )
    release.resolve()
    await result
    expect(observed).toEqual(['start:1', 'finish:1', 'start:2', 'finish:2'])
  })

  for (const asynchronous of [false, true]) {
    test(`a ${asynchronous ? 'pending' : 'synchronous'} failure keeps its identity and closes iteration`, async () => {
      const failure = new Error('commit step failed')
      const observed: string[] = []
      function* values() {
        try {
          yield 1
          observed.push('second item')
          yield 2
        } finally {
          observed.push('iterator closed')
        }
      }
      const run = async () => {
        await forEachResourceCommit(values(), () => {
          if (asynchronous) return Promise.reject(failure)
          throw failure
        })
      }
      await expect(run()).rejects.toBe(failure)
      expect(observed).toEqual(['iterator closed'])
    })
  }
})
