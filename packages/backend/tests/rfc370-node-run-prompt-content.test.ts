// RFC-370: complete prompt content selection preserves durable native behavior
// and waits for remote content ACKs before returning storage or a body.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  nodeRunPromptRelPath as publicNodeRunPromptRelPath,
  storeNodeRunPrompt as publicStoreNodeRunPrompt,
} from '../src/modules/task-execution/public/commands'
import { readNodeRunPrompt as publicReadNodeRunPrompt } from '../src/modules/task-execution/public/queries'
import { selectNodeRunPromptOperations as publicSelectNodeRunPromptOperations } from '../src/modules/task-execution/public/participants'
import type { PromptStorage } from '../src/modules/task-execution/public/types'
import {
  composeNodeRunPromptOperations,
  selectNodeRunPromptOperations,
} from '../src/modules/task-execution/composition/nodeRunPrompts'
import type {
  NodeRunPromptContentEffects,
  NodeRunPromptOperations,
  NodeRunPromptRow,
} from '../src/modules/task-execution/application/ports/nodeRunPromptContent'
import {
  nodeRunPromptRelPath,
  readNodeRunPrompt,
  storeNodeRunPrompt,
} from '../src/services/nodeRunPrompt'

function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function rejectionReasons(): unknown[] {
  return [
    new Error('storage unavailable'),
    'rejected',
    undefined,
    null,
    Object.create(null),
    {
      [Symbol.toPrimitive]() {
        throw new Error('description unavailable')
      },
    },
  ]
}

function callablePromise<T>(promise: Promise<T>): Promise<T> {
  return Object.assign(() => {}, {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    [Symbol.toStringTag]: 'Promise',
  })
}

class PrivateContent implements NodeRunPromptContentEffects {
  readonly calls: string[] = []
  #prefix = 'object:'
  #body = ''
  reference(taskId: string, nodeRunId: string) {
    this.calls.push('reference')
    return this.#prefix + taskId + '/' + nodeRunId
  }
  async write(reference: string, prompt: string) {
    expect(reference.startsWith(this.#prefix)).toBe(true)
    this.calls.push('write')
    this.#body = prompt
  }
  async read(reference: string) {
    expect(reference.startsWith(this.#prefix)).toBe(true)
    this.calls.push('read')
    return this.#body
  }
}

describe('RFC-370 node-run prompt content', () => {
  test('a complete frozen prototype receiver retains private state and opaque references', async () => {
    const content = Object.freeze(new PrivateContent())
    const operations = composeNodeRunPromptOperations(content, '/unused-native-root')
    const prompt = 'x'.repeat(4096)
    const stored = await operations.store('task', 'run', prompt)
    expect(stored).toEqual({ promptText: null, promptPath: 'object:task/run' })
    expect(await operations.read(stored)).toBe(prompt)
    expect(content.calls).toEqual(['reference', 'write', 'read'])
  })

  test('UTF-8 bytes retain the 4096-byte threshold and small prompts never touch content', async () => {
    const content = Object.freeze(new PrivateContent())
    const operations = composeNodeRunPromptOperations(content)
    const below = '界'.repeat(1365)
    expect(Buffer.byteLength(below, 'utf-8')).toBe(4095)
    expect(await operations.store('task', 'below', below)).toEqual({
      promptText: below,
      promptPath: null,
    })
    expect(content.calls).toEqual([])
    const threshold = below + 'x'
    expect(Buffer.byteLength(threshold, 'utf-8')).toBe(4096)
    expect(await operations.store('task', 'threshold', threshold)).toEqual({
      promptText: null,
      promptPath: 'object:task/threshold',
    })
    expect(content.calls).toEqual(['reference', 'write'])
  })

  test('column precedence includes empty text and absent rows or paths avoid all content calls', async () => {
    const content = Object.freeze(new PrivateContent())
    const operations = composeNodeRunPromptOperations(content)
    expect(await operations.read(null)).toBeNull()
    expect(await operations.read(undefined)).toBeNull()
    expect(await operations.read({ promptText: null, promptPath: null })).toBeNull()
    expect(await operations.read({ promptText: '', promptPath: 'object:ignored' })).toBe('')
    expect(await operations.read({ promptText: 'legacy', promptPath: 'object:ignored' })).toBe(
      'legacy',
    )
    expect(content.calls).toEqual([])
  })

  test('store and read return only after their selected content ACKs', async () => {
    const writeAck = held<void>()
    const readAck = held<string>()
    const calls: string[] = []
    const content: NodeRunPromptContentEffects = Object.freeze({
      reference: () => 'object:durable',
      write(reference: string, prompt: string) {
        expect(reference).toBe('object:durable')
        expect(prompt).toBe('x'.repeat(4096))
        calls.push('write')
        return writeAck.promise
      },
      read(reference: string) {
        expect(reference).toBe('object:durable')
        calls.push('read')
        return readAck.promise
      },
    })
    const operations = composeNodeRunPromptOperations(content)
    let storeSettled = false
    const storing = operations.store('task', 'run', 'x'.repeat(4096))
    void storing.then(() => {
      storeSettled = true
    })
    await Promise.resolve()
    expect(calls).toEqual(['write'])
    expect(storeSettled).toBe(false)
    writeAck.resolve(undefined)
    const stored = await storing
    expect(stored).toEqual({ promptText: null, promptPath: 'object:durable' })
    let readSettled = false
    const reading = operations.read(stored)
    void reading.then(() => {
      readSettled = true
    })
    await Promise.resolve()
    expect(calls).toEqual(['write', 'read'])
    expect(readSettled).toBe(false)
    readAck.resolve('acknowledged body')
    expect(await reading).toBe('acknowledged body')
  })

  test('async failures retain the full column or unavailable body even for non-Error rejection', async () => {
    const prompt = 'must survive '.repeat(500)
    for (const reason of rejectionReasons()) {
      const operations = composeNodeRunPromptOperations({
        reference: () => 'object:failed',
        write: () => Promise.reject(reason),
        read: () => Promise.reject(reason),
      })
      expect(await operations.store('task', 'run', prompt)).toEqual({
        promptText: prompt,
        promptPath: null,
      })
      expect(await operations.read({ promptText: null, promptPath: 'object:failed' })).toBeNull()
    }
  })

  test('synchronous effect failures have the same fallback outcomes', async () => {
    const prompt = 'x'.repeat(4096)
    for (const reason of rejectionReasons()) {
      const operations = composeNodeRunPromptOperations({
        reference: () => 'object:failed',
        write() {
          throw reason
        },
        read() {
          throw reason
        },
      })
      expect(await operations.store('task', 'run', prompt)).toEqual({
        promptText: prompt,
        promptPath: null,
      })
      expect(await operations.read({ promptText: null, promptPath: 'object:failed' })).toBeNull()
    }
  })

  test('null and partial selections fail as complete selections before any content work', () => {
    const partials = [null, {}, { reference: () => 'object:partial', write: () => {} }]
    for (const value of partials) {
      expect(() =>
        composeNodeRunPromptOperations(value as unknown as NodeRunPromptContentEffects),
      ).toThrow('complete content effects receiver')
    }
    for (const value of [null, {}, { read: async () => 'partial' }]) {
      expect(() =>
        selectNodeRunPromptOperations(value as unknown as NodeRunPromptOperations),
      ).toThrow('complete operations')
    }
  })

  test('operations selection retains a complete frozen prototype receiver', async () => {
    class PrivateOperations implements NodeRunPromptOperations {
      #body = ''
      async store(taskId: string, nodeRunId: string, prompt: string) {
        this.#body = taskId + '/' + nodeRunId + ':' + prompt
        return { promptText: prompt, promptPath: null }
      }
      async read(_row: NodeRunPromptRow | null | undefined) {
        return this.#body
      }
    }
    const receiver = Object.freeze(new PrivateOperations())
    const selected = selectNodeRunPromptOperations(receiver)
    expect(selected).toBe(receiver)
    expect(await selected.store('task', 'run', 'body')).toEqual({
      promptText: 'body',
      promptPath: null,
    })
    expect(await selected.read(null)).toBe('task/run:body')
  })

  test('structural thenables are awaited rather than treated as synchronous ACKs', async () => {
    const writeAck = held<void>()
    const readAck = held<string>()
    const operations = composeNodeRunPromptOperations({
      reference: () => 'object:thenable',
      write: () =>
        ({
          then: (done: (value: void) => void) => writeAck.promise.then(done),
        }) as unknown as Promise<void>,
      read: () =>
        ({
          then: (done: (value: string) => void) => readAck.promise.then(done),
        }) as unknown as Promise<string>,
    })
    let settled = false
    const storing = operations.store('task', 'run', 'x'.repeat(4096))
    void storing.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    writeAck.resolve(undefined)
    const stored = await storing
    expect(stored.promptPath).toBe('object:thenable')
    const reading = operations.read(stored)
    readAck.resolve('thenable body')
    expect(await reading).toBe('thenable body')
  })

  test('callable promises retain held write and read ACKs and rejection fallback', async () => {
    const writeAck = held<void>(),
      readAck = held<string>()
    const operations = composeNodeRunPromptOperations({
      reference: () => 'object:callable',
      write: () => callablePromise(writeAck.promise),
      read: () => callablePromise(readAck.promise),
    })
    let storeSettled = false,
      readSettled = false
    const storing = operations.store('task', 'run', 'x'.repeat(4096))
    void storing.then(() => {
      storeSettled = true
    })
    try {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(storeSettled).toBe(false)
      writeAck.resolve(undefined)
      const stored = await storing
      expect(stored).toEqual({ promptText: null, promptPath: 'object:callable' })
      const reading = operations.read(stored)
      void reading.then(() => {
        readSettled = true
      })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(readSettled).toBe(false)
      readAck.resolve('callable body')
      expect(await reading).toBe('callable body')
      for (const reason of rejectionReasons()) {
        const failed = composeNodeRunPromptOperations({
          reference: () => 'object:callable-failed',
          write: () => callablePromise(Promise.reject(reason)),
          read: () => callablePromise(Promise.reject(reason)),
        })
        expect(await failed.store('task', 'run', 'x'.repeat(4096))).toEqual({
          promptText: 'x'.repeat(4096),
          promptPath: null,
        })
        expect(
          await failed.read({ promptText: null, promptPath: 'object:callable-failed' }),
        ).toBeNull()
      }
    } finally {
      writeAck.resolve(undefined)
      readAck.resolve('released')
      await storing
    }
  })

  test('native sync helpers and async operations preserve durable reference and dual reads', async () => {
    const runs = mkdtempSync(join(tmpdir(), 'aw-rfc370-prompt-'))
    try {
      const prompt = 'native prompt '.repeat(500)
      const stored = storeNodeRunPrompt('task', 'run', prompt, runs)
      expect(stored).not.toBeInstanceOf(Promise)
      expect(stored).toEqual({
        promptText: null,
        promptPath: nodeRunPromptRelPath('task', 'run'),
      })
      expect(stored.promptPath).toBe(join('task', 'prompts', 'run.md'))
      expect(readFileSync(join(runs, stored.promptPath!), 'utf-8')).toBe(prompt)
      expect(readNodeRunPrompt(stored, runs)).toBe(prompt)
      const operations = composeNodeRunPromptOperations(undefined, runs)
      expect(await operations.read(stored)).toBe(prompt)
      rmSync(join(runs, stored.promptPath!))
      expect(await operations.read(stored)).toBeNull()
      mkdirSync(join(runs, stored.promptPath!))
      expect(await operations.read(stored)).toBeNull()
      expect(await operations.read({ promptText: 'legacy', promptPath: stored.promptPath })).toBe(
        'legacy',
      )
      expect(await operations.store('task', 'small', 'small')).toEqual({
        promptText: 'small',
        promptPath: null,
      })
    } finally {
      rmSync(runs, { recursive: true, force: true })
    }
  })
})

test('public prompt contracts retain legacy function and complete operations identities and ACKs', async () => {
  expect(publicNodeRunPromptRelPath).toBe(nodeRunPromptRelPath)
  expect(publicStoreNodeRunPrompt).toBe(storeNodeRunPrompt)
  expect(publicReadNodeRunPrompt).toBe(readNodeRunPrompt)
  expect(publicSelectNodeRunPromptOperations).toBe(selectNodeRunPromptOperations)
  const storeAck = held<PromptStorage>()
  const readAck = held<string | null>()
  class PublicOperations implements NodeRunPromptOperations {
    readonly calls: string[] = []
    #prefix = 'public:'
    async store(taskId: string, nodeRunId: string, prompt: string) {
      this.calls.push(this.#prefix + taskId + '/' + nodeRunId + '/' + prompt)
      return await storeAck.promise
    }
    async read(row: NodeRunPromptRow | null | undefined) {
      this.calls.push(this.#prefix + String(row?.promptPath))
      return await readAck.promise
    }
  }
  const receiver = Object.freeze(new PublicOperations())
  const operations = publicSelectNodeRunPromptOperations(receiver, '/unused-public-root')
  expect(operations).toBe(receiver)
  let storeSettled = false
  let readSettled = false
  const storing = operations.store('task', 'run', 'prompt').then((result) => {
    storeSettled = true
    return result
  })
  const reading = operations
    .read({ promptText: null, promptPath: 'opaque:reference' })
    .then((body) => {
      readSettled = true
      return body
    })
  try {
    await Promise.resolve()
    await Promise.resolve()
    expect(receiver.calls).toEqual(['public:task/run/prompt', 'public:opaque:reference'])
    expect(storeSettled).toBe(false)
    expect(readSettled).toBe(false)
    const stored = { promptText: null, promptPath: 'opaque:reference' }
    storeAck.resolve(stored)
    readAck.resolve('public body')
    expect(await storing).toBe(stored)
    expect(await reading).toBe('public body')
    expect(() =>
      publicSelectNodeRunPromptOperations(null as unknown as NodeRunPromptOperations),
    ).toThrow(TypeError)
    expect(() =>
      publicSelectNodeRunPromptOperations({ store: receiver.store } as NodeRunPromptOperations),
    ).toThrow(TypeError)
  } finally {
    storeAck.resolve({ promptText: null, promptPath: 'released' })
    readAck.resolve('released')
    await Promise.all([storing, reading])
  }
})
