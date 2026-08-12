// RFC-250 T15-T17 — generation-bound Clarify draft durability.
//
// The route and centralized answer dialog share this controller so neither can
// infer "saved" from a debounce timer or from an older request settling. Local
// IndexedDB writes are serialized and coalesced; server writes are independently
// single-flight per question.

import type { ClarifyAnswer } from '@agent-workflow/shared'
import { ApiError } from '@/api/client'
import { answersEqual, isAnswerFilled } from './answers'

export interface ClarifyLocalWrite {
  generation: number
  answers: ClarifyAnswer[]
}

export interface ClarifyServerWrite {
  generation: number
  questionId: string
  answer: ClarifyAnswer
}

export interface ClarifyDraftGenerationState {
  latestGeneration: number
  localAckGeneration: number
  latestQuestionGeneration: Readonly<Record<string, number>>
  serverAckGenerationByQuestion: Readonly<Record<string, number>>
  localPending: boolean
  serverPending: boolean
  localError: unknown | null
  serverError: unknown | null
  serverRetryable: boolean
  sealed: boolean
}

export type ClarifyDraftStatus =
  | { kind: 'sealed' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; error: unknown; canRetryLocal: true }
  | {
      kind: 'local-only'
      error: unknown | null
      canRetryServer: boolean
    }

export function projectClarifyDraftStatus(state: ClarifyDraftGenerationState): ClarifyDraftStatus {
  if (state.sealed) return { kind: 'sealed' }

  if (state.latestGeneration > state.localAckGeneration) {
    if (state.localError !== null) {
      return { kind: 'error', error: state.localError, canRetryLocal: true }
    }
    return { kind: 'saving' }
  }

  const serverBehind = Object.entries(state.latestQuestionGeneration).some(
    ([questionId, generation]) =>
      (state.serverAckGenerationByQuestion[questionId] ?? 0) < generation,
  )
  if (!serverBehind) return { kind: 'saved' }
  if (state.serverError !== null || !state.serverPending) {
    return {
      kind: 'local-only',
      error: state.serverError,
      canRetryServer: state.serverRetryable,
    }
  }
  return { kind: 'saving' }
}

function cloneAnswer(answer: ClarifyAnswer): ClarifyAnswer {
  return {
    ...answer,
    selectedOptionIndices: [...answer.selectedOptionIndices],
    selectedOptionLabels: [...answer.selectedOptionLabels],
  }
}

function cloneAnswers(answers: readonly ClarifyAnswer[]): ClarifyAnswer[] {
  return answers.map(cloneAnswer)
}

class LatestSerialLocalWriter {
  private latest: ClarifyLocalWrite | null
  private ackGeneration: number
  private pending = false
  private error: unknown | null = null
  private runPromise: Promise<void> | null = null
  private stopped = false

  constructor(
    initial: ClarifyLocalWrite,
    initialAckGeneration: number,
    private readonly write: (write: ClarifyLocalWrite) => Promise<void>,
    private readonly onStateChange: () => void,
  ) {
    this.latest = initial
    this.ackGeneration = initialAckGeneration
  }

  enqueue(write: ClarifyLocalWrite): void {
    if (this.stopped) return
    this.latest = { generation: write.generation, answers: cloneAnswers(write.answers) }
    this.error = null
    this.onStateChange()
    this.start()
  }

  private start(): void {
    if (
      this.stopped ||
      this.runPromise !== null ||
      this.latest === null ||
      this.latest.generation <= this.ackGeneration ||
      this.error !== null
    ) {
      return
    }
    const run = this.pump()
    this.runPromise = run
    void run.finally(() => {
      if (this.runPromise !== run) return
      this.runPromise = null
      this.onStateChange()
      if (
        !this.stopped &&
        this.error === null &&
        this.latest !== null &&
        this.latest.generation > this.ackGeneration
      ) {
        this.start()
      }
    })
  }

  private async pump(): Promise<void> {
    while (!this.stopped) {
      const current = this.latest
      if (current === null || current.generation <= this.ackGeneration) return
      this.pending = true
      this.onStateChange()
      try {
        await this.write({
          generation: current.generation,
          answers: cloneAnswers(current.answers),
        })
      } catch (error) {
        this.pending = false
        this.error = error
        this.onStateChange()
        return
      }
      this.ackGeneration = Math.max(this.ackGeneration, current.generation)
      this.pending = false
      this.error = null
      this.onStateChange()
    }
  }

  async flushLatest(): Promise<void> {
    if (this.stopped) return
    this.error = null
    this.start()
    for (;;) {
      const run = this.runPromise
      if (run !== null) await run
      if (this.error !== null) throw this.error
      if (this.latest === null || this.ackGeneration >= this.latest.generation) return
      this.start()
    }
  }

  async stopAfterCurrent(): Promise<void> {
    this.stopped = true
    const run = this.runPromise
    if (run !== null) await run
    this.onStateChange()
  }

  getState(): {
    ackGeneration: number
    pending: boolean
    error: unknown | null
  } {
    return {
      ackGeneration: this.ackGeneration,
      pending:
        this.pending ||
        (this.error === null &&
          this.latest !== null &&
          this.latest.generation > this.ackGeneration),
      error: this.error,
    }
  }
}

interface ServerQueueEntry {
  ackGeneration: number
  ackAnswer: ClarifyAnswer
  latest: ClarifyServerWrite | null
  inFlight: ClarifyServerWrite | null
  timer: ReturnType<typeof setTimeout> | null
  error: unknown | null
  disabled: boolean
  uncertain: boolean
}

class PerQuestionSingleFlightServerQueue {
  private readonly entries = new Map<string, ServerQueueEntry>()
  private stopped = false

  constructor(
    baseline: readonly ClarifyAnswer[],
    private readonly debounceMs: number,
    private readonly write: (write: ClarifyServerWrite) => Promise<void>,
    private readonly onStateChange: () => void,
  ) {
    for (const answer of baseline) {
      this.entries.set(answer.questionId, {
        ackGeneration: 0,
        ackAnswer: cloneAnswer(answer),
        latest: null,
        inFlight: null,
        timer: null,
        error: null,
        disabled: false,
        uncertain: false,
      })
    }
  }

  enqueue(write: ClarifyServerWrite): void {
    if (this.stopped) return
    const entry = this.ensureEntry(write.questionId, write.answer)
    entry.latest = {
      generation: write.generation,
      questionId: write.questionId,
      answer: cloneAnswer(write.answer),
    }
    if (entry.disabled) {
      this.onStateChange()
      return
    }
    // A newer edit is a safe replacement PUT. It clears a transient error but
    // keeps the uncertain marker until one exact latest write succeeds.
    entry.error = null
    if (entry.inFlight === null) this.schedule(entry, write.questionId, this.debounceMs)
    this.onStateChange()
  }

  private ensureEntry(questionId: string, fallback: ClarifyAnswer): ServerQueueEntry {
    const current = this.entries.get(questionId)
    if (current !== undefined) return current
    const created: ServerQueueEntry = {
      ackGeneration: 0,
      ackAnswer: cloneAnswer(fallback),
      latest: null,
      inFlight: null,
      timer: null,
      error: null,
      disabled: false,
      uncertain: false,
    }
    this.entries.set(questionId, created)
    return created
  }

  private schedule(entry: ServerQueueEntry, questionId: string, delay: number): void {
    if (this.stopped || entry.disabled || entry.inFlight !== null) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.run(questionId, entry)
    }, delay)
  }

  private async run(questionId: string, entry: ServerQueueEntry): Promise<void> {
    if (this.stopped || entry.disabled || entry.inFlight !== null) return
    const current = entry.latest
    if (current === null || current.generation <= entry.ackGeneration) return

    // If nothing uncertain/in-flight preceded this edit and the user reverted
    // to the acknowledged value, no PUT is necessary.
    if (!entry.uncertain && answersEqual(entry.ackAnswer, current.answer)) {
      entry.ackGeneration = current.generation
      this.onStateChange()
      return
    }

    entry.inFlight = current
    this.onStateChange()
    let fulfilled = false
    try {
      await this.write({
        generation: current.generation,
        questionId,
        answer: cloneAnswer(current.answer),
      })
      fulfilled = true
      if (current.generation >= entry.ackGeneration) {
        entry.ackGeneration = current.generation
        entry.ackAnswer = cloneAnswer(current.answer)
      }
      entry.error = null
      entry.uncertain = false
    } catch (error) {
      entry.error = error
      entry.uncertain = true
      // 终局性错误 → 停写（草稿留在本地，不再重试）。RFC-285 B1 后「被撤权」
      // 从 403 变成与「任务/会话不存在」同形的 404——两种情况对这条写链的正确
      // 反应相同（服务端已不接受该草稿），404 并入停写集；409（提交冻结）不变。
      entry.disabled =
        error instanceof ApiError &&
        (error.status === 403 || error.status === 404 || error.status === 409)
    } finally {
      entry.inFlight = null
      this.onStateChange()
    }

    if (
      fulfilled &&
      !this.stopped &&
      !entry.disabled &&
      entry.latest !== null &&
      entry.latest.generation > entry.ackGeneration
    ) {
      this.schedule(entry, questionId, 0)
    }
  }

  retry(questionId?: string): void {
    for (const [id, entry] of this.entries) {
      if (questionId !== undefined && id !== questionId) continue
      if (
        entry.disabled ||
        entry.latest === null ||
        entry.latest.generation <= entry.ackGeneration
      ) {
        continue
      }
      entry.error = null
      this.schedule(entry, id, 0)
    }
    this.onStateChange()
  }

  tryAdoptRemote(
    questionId: string,
    currentAnswer: ClarifyAnswer,
    remoteAnswer: ClarifyAnswer,
    latestQuestionGeneration: number,
    adoptedGeneration: number,
  ): boolean {
    const entry = this.ensureEntry(questionId, currentAnswer)
    if (
      latestQuestionGeneration > entry.ackGeneration ||
      entry.inFlight !== null ||
      entry.timer !== null ||
      entry.error !== null
    ) {
      return false
    }
    if (!answersEqual(currentAnswer, entry.ackAnswer)) return false
    entry.ackGeneration = Math.max(entry.ackGeneration, adoptedGeneration)
    entry.ackAnswer = cloneAnswer(remoteAnswer)
    return true
  }

  getState(questionIds: readonly string[]): {
    ackGenerations: Record<string, number>
    pending: boolean
    error: unknown | null
    retryable: boolean
  } {
    const ackGenerations: Record<string, number> = {}
    let pending = false
    let error: unknown | null = null
    let retryable = false
    for (const questionId of questionIds) {
      const entry = this.entries.get(questionId)
      ackGenerations[questionId] = entry?.ackGeneration ?? 0
      if (entry === undefined) continue
      const behind = entry.latest !== null && entry.latest.generation > entry.ackGeneration
      if (behind && !entry.disabled && entry.error === null) pending = true
      if (behind && entry.error !== null) {
        if (error === null) error = entry.error
        if (!entry.disabled) retryable = true
      }
    }
    return { ackGenerations, pending, error, retryable }
  }

  seal(): void {
    this.stopped = true
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer)
      entry.timer = null
    }
    this.onStateChange()
  }
}

export interface ClarifyDraftDurabilityOptions {
  initialAnswers: readonly ClarifyAnswer[]
  serverAnswers: readonly ClarifyAnswer[]
  /**
   * True when initialAnswers came from this draft key in IndexedDB; false when
   * a material server baseline still needs an IDB mirror. Omit for an already
   * durable baseline in pure/non-UI callers.
   */
  initialLocalPersisted?: boolean
  /** Omit questions whose existing product contract intentionally has no draft. */
  persistedQuestionIds?: readonly string[]
  debounceMs?: number
  writeLocal: (write: ClarifyLocalWrite) => Promise<void>
  writeServer: (write: ClarifyServerWrite) => Promise<void>
}

export interface ClarifyDraftDurabilityController {
  recordChange: (answers: readonly ClarifyAnswer[], changedQuestionId: string) => void
  tryAdoptRemote: (
    questionId: string,
    currentAnswer: ClarifyAnswer,
    remoteAnswer: ClarifyAnswer,
  ) => boolean
  flushLocal: () => Promise<void>
  retryLocal: () => Promise<void>
  retryServer: (questionId?: string) => void
  seal: () => Promise<void>
  getState: () => ClarifyDraftGenerationState
  getStatus: () => ClarifyDraftStatus
  subscribe: (listener: (state: ClarifyDraftGenerationState) => void) => () => void
}

class ClarifyDraftDurabilityControllerImpl implements ClarifyDraftDurabilityController {
  private readonly questionOrder: string[]
  private readonly persistedQuestionIds: Set<string>
  private readonly latestAnswers = new Map<string, ClarifyAnswer>()
  private readonly latestQuestionGeneration: Record<string, number> = {}
  private readonly listeners = new Set<(state: ClarifyDraftGenerationState) => void>()
  private readonly localWriter: LatestSerialLocalWriter
  private readonly serverQueue: PerQuestionSingleFlightServerQueue
  private latestGeneration = 0
  private sealed = false

  constructor(options: ClarifyDraftDurabilityOptions) {
    this.persistedQuestionIds = new Set(
      options.persistedQuestionIds ?? options.initialAnswers.map((answer) => answer.questionId),
    )
    this.questionOrder = options.initialAnswers
      .map((answer) => answer.questionId)
      .filter((questionId) => this.persistedQuestionIds.has(questionId))

    const serverByQuestion = new Map(
      options.serverAnswers.map((answer) => [answer.questionId, cloneAnswer(answer)]),
    )
    const initial = options.initialAnswers
      .filter((answer) => this.persistedQuestionIds.has(answer.questionId))
      .map(cloneAnswer)
    for (const answer of initial) {
      this.latestAnswers.set(answer.questionId, answer)
      this.latestQuestionGeneration[answer.questionId] = 0
      if (!serverByQuestion.has(answer.questionId))
        serverByQuestion.set(answer.questionId, cloneAnswer(answer))
    }

    const changed = initial.filter((answer) => {
      const server = serverByQuestion.get(answer.questionId)
      return server !== undefined && !answersEqual(answer, server)
    })
    // `false` is an explicit instruction from a UI seed path that the baseline
    // (including a server-restored draft) has not yet been mirrored to IDB.
    // `undefined` keeps the controller ergonomic for pure/unit callers that
    // supply an already-durable baseline without opting into a seed write.
    const needsInitialLocalWrite =
      options.initialLocalPersisted === false && initial.some((answer) => isAnswerFilled(answer))
    if (changed.length > 0 || needsInitialLocalWrite) {
      this.latestGeneration = 1
      for (const answer of changed) this.latestQuestionGeneration[answer.questionId] = 1
    }

    const initialWrite: ClarifyLocalWrite = {
      generation: this.latestGeneration,
      answers: cloneAnswers(initial),
    }
    const initialLocalAck =
      this.latestGeneration === 0 || options.initialLocalPersisted === true
        ? this.latestGeneration
        : 0
    this.localWriter = new LatestSerialLocalWriter(
      initialWrite,
      initialLocalAck,
      options.writeLocal,
      () => this.emit(),
    )
    this.serverQueue = new PerQuestionSingleFlightServerQueue(
      [...serverByQuestion.values()].filter((answer) =>
        this.persistedQuestionIds.has(answer.questionId),
      ),
      options.debounceMs ?? 500,
      options.writeServer,
      () => this.emit(),
    )

    if (this.latestGeneration > initialLocalAck) this.localWriter.enqueue(initialWrite)
    for (const answer of changed) {
      this.serverQueue.enqueue({
        generation: this.latestGeneration,
        questionId: answer.questionId,
        answer,
      })
    }
  }

  recordChange(answers: readonly ClarifyAnswer[], changedQuestionId: string): void {
    if (this.sealed || !this.persistedQuestionIds.has(changedQuestionId)) return
    const changed = answers.find((answer) => answer.questionId === changedQuestionId)
    if (changed === undefined) return
    const prior = this.latestAnswers.get(changedQuestionId)
    if (prior !== undefined && answersEqual(prior, changed)) return

    this.latestGeneration += 1
    this.latestQuestionGeneration[changedQuestionId] = this.latestGeneration
    for (const answer of answers) {
      if (this.persistedQuestionIds.has(answer.questionId)) {
        this.latestAnswers.set(answer.questionId, cloneAnswer(answer))
      }
    }
    const snapshot = this.snapshotAnswers()
    this.localWriter.enqueue({ generation: this.latestGeneration, answers: snapshot })
    this.serverQueue.enqueue({
      generation: this.latestGeneration,
      questionId: changedQuestionId,
      answer: changed,
    })
    this.emit()
  }

  tryAdoptRemote(
    questionId: string,
    currentAnswer: ClarifyAnswer,
    remoteAnswer: ClarifyAnswer,
  ): boolean {
    if (this.sealed || !this.persistedQuestionIds.has(questionId)) return false
    if (answersEqual(currentAnswer, remoteAnswer)) return false
    const adoptedGeneration = this.latestGeneration + 1
    const adopted = this.serverQueue.tryAdoptRemote(
      questionId,
      currentAnswer,
      remoteAnswer,
      this.latestQuestionGeneration[questionId] ?? 0,
      adoptedGeneration,
    )
    if (adopted) {
      this.latestGeneration = adoptedGeneration
      this.latestQuestionGeneration[questionId] = adoptedGeneration
      this.latestAnswers.set(questionId, cloneAnswer(remoteAnswer))
      this.localWriter.enqueue({
        generation: adoptedGeneration,
        answers: this.snapshotAnswers(),
      })
      this.emit()
    }
    return adopted
  }

  async flushLocal(): Promise<void> {
    await this.localWriter.flushLatest()
    this.emit()
  }

  retryLocal(): Promise<void> {
    return this.flushLocal()
  }

  retryServer(questionId?: string): void {
    this.serverQueue.retry(questionId)
  }

  async seal(): Promise<void> {
    if (this.sealed) return
    this.sealed = true
    this.serverQueue.seal()
    this.emit()
    await this.localWriter.stopAfterCurrent()
    this.emit()
  }

  getState(): ClarifyDraftGenerationState {
    const local = this.localWriter.getState()
    const server = this.serverQueue.getState(this.questionOrder)
    return {
      latestGeneration: this.latestGeneration,
      localAckGeneration: local.ackGeneration,
      latestQuestionGeneration: { ...this.latestQuestionGeneration },
      serverAckGenerationByQuestion: server.ackGenerations,
      localPending: local.pending,
      serverPending: server.pending,
      localError: local.error,
      serverError: server.error,
      serverRetryable: server.retryable,
      sealed: this.sealed,
    }
  }

  getStatus(): ClarifyDraftStatus {
    return projectClarifyDraftStatus(this.getState())
  }

  subscribe(listener: (state: ClarifyDraftGenerationState) => void): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => this.listeners.delete(listener)
  }

  private snapshotAnswers(): ClarifyAnswer[] {
    return this.questionOrder
      .map((questionId) => this.latestAnswers.get(questionId))
      .filter((answer): answer is ClarifyAnswer => answer !== undefined)
      .map(cloneAnswer)
  }

  private emit(): void {
    if (this.listeners.size === 0) return
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}

export function createClarifyDraftDurabilityController(
  options: ClarifyDraftDurabilityOptions,
): ClarifyDraftDurabilityController {
  return new ClarifyDraftDurabilityControllerImpl(options)
}
