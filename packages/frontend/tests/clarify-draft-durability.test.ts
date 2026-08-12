// RFC-250 T15-T17 — Clarify draft durability is generation-bound.
//
// These tests lock the failure modes that previously made the footer claim
// "saved" after a swallowed IDB error, dropped the last edit on unmount, or
// let an older server PUT completion bless a newer local answer.

import { describe, expect, test } from 'vitest'
import type { ClarifyAnswer } from '@agent-workflow/shared'
import { ApiError } from '../src/api/client'
import {
  createClarifyDraftDurabilityController,
  projectClarifyDraftStatus,
  type ClarifyDraftGenerationState,
  type ClarifyLocalWrite,
  type ClarifyServerWrite,
} from '../src/lib/clarify/durability'

function answer(customText: string): ClarifyAnswer {
  return {
    questionId: 'q1',
    selectedOptionIndices: [],
    selectedOptionLabels: [],
    customText,
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function nextTimer(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function state(overrides: Partial<ClarifyDraftGenerationState>): ClarifyDraftGenerationState {
  return {
    latestGeneration: 0,
    localAckGeneration: 0,
    latestQuestionGeneration: { q1: 0 },
    serverAckGenerationByQuestion: { q1: 0 },
    localPending: false,
    serverPending: false,
    localError: null,
    serverError: null,
    serverRetryable: false,
    sealed: false,
    ...overrides,
  }
}

describe('projectClarifyDraftStatus', () => {
  test('never reports saved before the latest local and per-question server generations ack', () => {
    expect(projectClarifyDraftStatus(state({ latestGeneration: 1, localPending: true })).kind).toBe(
      'saving',
    )
    expect(
      projectClarifyDraftStatus(
        state({
          latestGeneration: 1,
          localAckGeneration: 1,
          latestQuestionGeneration: { q1: 1 },
          serverPending: true,
        }),
      ).kind,
    ).toBe('saving')
    expect(
      projectClarifyDraftStatus(
        state({
          latestGeneration: 1,
          localAckGeneration: 1,
          latestQuestionGeneration: { q1: 1 },
          serverAckGenerationByQuestion: { q1: 1 },
        }),
      ).kind,
    ).toBe('saved')
  })

  test('projects IDB failure, local-only server failure, and sealed state distinctly', () => {
    const localError = new Error('indexeddb aborted')
    expect(
      projectClarifyDraftStatus(state({ latestGeneration: 2, localAckGeneration: 1, localError })),
    ).toMatchObject({ kind: 'error', error: localError })

    const serverError = new Error('offline')
    expect(
      projectClarifyDraftStatus(
        state({
          latestGeneration: 2,
          localAckGeneration: 2,
          latestQuestionGeneration: { q1: 2 },
          serverError,
          serverRetryable: true,
        }),
      ),
    ).toMatchObject({ kind: 'local-only', error: serverError, canRetryServer: true })

    expect(projectClarifyDraftStatus(state({ sealed: true })).kind).toBe('sealed')
  })
})

describe('ClarifyDraftDurabilityController local writer', () => {
  test('explicitly unpersisted initial server baseline is mirrored to IDB without a redundant PUT', async () => {
    const localWrites: ClarifyLocalWrite[] = []
    const serverWrites: ClarifyServerWrite[] = []
    const controller = createClarifyDraftDurabilityController({
      initialAnswers: [answer('server draft')],
      serverAnswers: [answer('server draft')],
      initialLocalPersisted: false,
      debounceMs: 0,
      writeLocal: async (write) => {
        localWrites.push(write)
      },
      writeServer: async (write) => {
        serverWrites.push(write)
      },
    })

    await controller.flushLocal()
    expect(localWrites).toEqual([{ generation: 1, answers: [answer('server draft')] }])
    await nextTimer()
    expect(serverWrites).toEqual([])
    expect(controller.getStatus().kind).toBe('saved')
  })

  test('serializes IDB writes, coalesces queued generations, and keeps running after UI unsubscribe', async () => {
    const writes: ClarifyLocalWrite[] = []
    const gates = [deferred(), deferred()]
    const controller = createClarifyDraftDurabilityController({
      initialAnswers: [answer('A')],
      serverAnswers: [answer('A')],
      debounceMs: 60_000,
      writeLocal: async (write) => {
        writes.push(write)
        await gates[writes.length - 1]!.promise
      },
      writeServer: async () => {},
    })
    const unsubscribe = controller.subscribe(() => {})

    controller.recordChange([answer('B')], 'q1')
    expect(writes.map((write) => write.generation)).toEqual([1])
    controller.recordChange([answer('C')], 'q1')
    controller.recordChange([answer('D')], 'q1')
    expect(writes).toHaveLength(1)

    // Unmount only removes React's listener. The already-enqueued local writer
    // remains alive and must persist the latest immutable snapshot.
    unsubscribe()
    const flushed = controller.flushLocal()
    gates[0]!.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject({ generation: 3, answers: [answer('D')] })
    gates[1]!.resolve()
    await flushed
    expect(controller.getState().localAckGeneration).toBe(3)
  })

  test('surfaces a failed latest IDB write and explicit flush retries it', async () => {
    let attempts = 0
    const controller = createClarifyDraftDurabilityController({
      initialAnswers: [answer('A')],
      serverAnswers: [answer('A')],
      debounceMs: 60_000,
      writeLocal: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('quota exceeded')
      },
      writeServer: async () => {},
    })

    controller.recordChange([answer('B')], 'q1')
    await expect(controller.flushLocal()).rejects.toThrow('quota exceeded')
    expect(controller.getStatus().kind).toBe('error')

    await controller.flushLocal()
    expect(attempts).toBe(2)
    expect(controller.getState().localAckGeneration).toBe(1)
  })

  test('flushLocal resolves after IDB ack without waiting for a pending server PUT', async () => {
    const local = deferred()
    const server = deferred()
    const controller = createClarifyDraftDurabilityController({
      initialAnswers: [answer('A')],
      serverAnswers: [answer('A')],
      debounceMs: 0,
      writeLocal: async () => local.promise,
      writeServer: async () => server.promise,
    })

    controller.recordChange([answer('B')], 'q1')
    await nextTimer()
    const flushed = controller.flushLocal()
    local.resolve()
    await flushed

    expect(controller.getState().localAckGeneration).toBe(1)
    expect(controller.getStatus().kind).toBe('saving')
    server.resolve()
  })
})

describe('ClarifyDraftDurabilityController server queue', () => {
  test('keeps one PUT in flight per question and an older ack cannot bless a newer edit', async () => {
    const writes: ClarifyServerWrite[] = []
    const gates = [deferred(), deferred()]
    const controller = createClarifyDraftDurabilityController({
      initialAnswers: [answer('A')],
      serverAnswers: [answer('A')],
      debounceMs: 0,
      writeLocal: async () => {},
      writeServer: async (write) => {
        writes.push(write)
        await gates[writes.length - 1]!.promise
      },
    })

    controller.recordChange([answer('B')], 'q1')
    await nextTimer()
    expect(writes).toHaveLength(1)
    controller.recordChange([answer('C')], 'q1')
    await nextTimer()
    expect(writes).toHaveLength(1)

    gates[0]!.resolve()
    for (let i = 0; i < 4 && writes.length < 2; i += 1) await nextTimer()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject({ generation: 2, answer: answer('C') })
    expect(controller.getState()).toMatchObject({
      latestQuestionGeneration: { q1: 2 },
      serverAckGenerationByQuestion: { q1: 1 },
    })
    expect(controller.getStatus().kind).toBe('saving')

    gates[1]!.resolve()
    await Promise.resolve()
    await nextTimer()
    expect(controller.getState().serverAckGenerationByQuestion.q1).toBe(2)
    expect(controller.getStatus().kind).toBe('saved')
  })

  test('transient server failure becomes retryable local-only; retry sends the latest value', async () => {
    const writes: ClarifyServerWrite[] = []
    let attempts = 0
    const controller = createClarifyDraftDurabilityController({
      initialAnswers: [answer('A')],
      serverAnswers: [answer('A')],
      debounceMs: 0,
      writeLocal: async () => {},
      writeServer: async (write) => {
        writes.push(write)
        attempts += 1
        if (attempts === 1) throw new ApiError(0, 'network-unreachable', 'offline')
      },
    })

    controller.recordChange([answer('B')], 'q1')
    await controller.flushLocal()
    await nextTimer()
    expect(controller.getStatus()).toMatchObject({ kind: 'local-only', canRetryServer: true })

    controller.recordChange([answer('C')], 'q1')
    await controller.flushLocal()
    await nextTimer()
    expect(writes.at(-1)).toMatchObject({ generation: 2, answer: answer('C') })
    expect(controller.getStatus().kind).toBe('saved')
  })

  test('403/409 disables server sync without invalidating the durable local draft', async () => {
    const controller = createClarifyDraftDurabilityController({
      initialAnswers: [answer('A')],
      serverAnswers: [answer('A')],
      debounceMs: 0,
      writeLocal: async () => {},
      writeServer: async () => {
        throw new ApiError(409, 'clarify-round-sealed', 'sealed')
      },
    })

    controller.recordChange([answer('B')], 'q1')
    await controller.flushLocal()
    await nextTimer()
    expect(controller.getStatus()).toMatchObject({ kind: 'local-only', canRetryServer: false })
  })

  // RFC-285 B1 回归锁：服务端把「存在但无权」改成与「不存在」同形的 404 后，
  // 被撤权协作者的草稿同步收到的是 404 而不再是 403。404 必须同样判终局停写
  //（草稿留本地、不无限重试）——B1 落地时若漏改这条判据，撤权场景会从「干净
  // 停写」退化成永久重试风暴。
  test('404 (B1: revoked ≡ missing) disables server sync like the old 403 did', async () => {
    const controller = createClarifyDraftDurabilityController({
      initialAnswers: [answer('A')],
      serverAnswers: [answer('A')],
      debounceMs: 0,
      writeLocal: async () => {},
      writeServer: async () => {
        throw new ApiError(404, 'clarify-session-not-found', 'clarify session not found')
      },
    })

    controller.recordChange([answer('B')], 'q1')
    await controller.flushLocal()
    await nextTimer()
    expect(controller.getStatus()).toMatchObject({ kind: 'local-only', canRetryServer: false })
  })

  test('a retryable question remains retryable when a sibling has a definitive failure', async () => {
    const q1 = answer('A')
    const q2 = { ...answer('A'), questionId: 'q2' }
    let q2Attempts = 0
    const controller = createClarifyDraftDurabilityController({
      initialAnswers: [q1, q2],
      serverAnswers: [q1, q2],
      debounceMs: 0,
      writeLocal: async () => {},
      writeServer: async ({ questionId }) => {
        if (questionId === 'q1') {
          throw new ApiError(409, 'clarify-round-sealed', 'sealed')
        }
        q2Attempts += 1
        if (q2Attempts === 1) throw new ApiError(0, 'network-unreachable', 'offline')
      },
    })

    controller.recordChange([{ ...q1, customText: 'q1 local' }, q2], 'q1')
    controller.recordChange(
      [
        { ...q1, customText: 'q1 local' },
        { ...q2, customText: 'q2 local' },
      ],
      'q2',
    )
    await controller.flushLocal()
    await nextTimer()
    expect(controller.getStatus()).toMatchObject({
      kind: 'local-only',
      canRetryServer: true,
    })

    controller.retryServer()
    await nextTimer()
    expect(q2Attempts).toBe(2)
    expect(controller.getStatus()).toMatchObject({
      kind: 'local-only',
      canRetryServer: false,
    })
  })

  test('remote merge adopts only while clean, mirrors to IDB, and never PUTs it back', async () => {
    const localWrites: ClarifyLocalWrite[] = []
    const serverWrites: ClarifyServerWrite[] = []
    const clean = createClarifyDraftDurabilityController({
      initialAnswers: [answer('A')],
      serverAnswers: [answer('A')],
      debounceMs: 60_000,
      writeLocal: async (write) => {
        localWrites.push(write)
      },
      writeServer: async (write) => {
        serverWrites.push(write)
      },
    })
    expect(clean.tryAdoptRemote('q1', answer('A'), answer('A'))).toBe(false)
    expect(localWrites).toEqual([])
    expect(clean.tryAdoptRemote('q1', answer('A'), answer('remote'))).toBe(true)
    await clean.flushLocal()
    expect(localWrites).toEqual([{ generation: 1, answers: [answer('remote')] }])
    expect(serverWrites).toEqual([])
    expect(clean.getStatus().kind).toBe('saved')

    clean.recordChange([answer('local')], 'q1')
    expect(clean.tryAdoptRemote('q1', answer('local'), answer('foreign'))).toBe(false)
  })
})
