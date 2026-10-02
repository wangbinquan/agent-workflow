// Selected CLI storage is asynchronous; the standalone CLI contract stays sync.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configGetCommand, configSetCommand } from '@/cli/config-cli'
import type { ApplicationConfigurationPersistencePort } from '@/modules/system-operations/composition/cliConfiguration'
import {
  mergeValidatedConfigurationPatch,
  validateConfigurationPatch,
} from '@/platform/configuration/configurationValues'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function storage() {
  class Storage implements ApplicationConfigurationPersistencePort {
    current = structuredClone(DEFAULT_CONFIG)
    reads = 0
    previews = 0
    writes = 0
    patches: unknown[] = []
    readEntered = barrier()
    readRelease: Promise<void> = Promise.resolve()
    writeEntered = barrier()
    writeRelease: Promise<void> = Promise.resolve()

    async load() {
      expect<unknown>(this).toBe(selected)
      this.reads += 1
      this.readEntered.resolve()
      await this.readRelease
      return structuredClone(this.current)
    }
    async previewPatch(patch: unknown) {
      expect<unknown>(this).toBe(selected)
      this.previews += 1
      return mergeValidatedConfigurationPatch(this.current, validateConfigurationPatch(patch))
    }
    async applyPatch(patch: unknown) {
      expect<unknown>(this).toBe(selected)
      this.writes += 1
      this.patches.push(patch)
      this.writeEntered.resolve()
      await this.writeRelease
      this.current = mergeValidatedConfigurationPatch(
        this.current,
        validateConfigurationPatch(patch),
      )
      return structuredClone(this.current)
    }
  }
  const selected = new Storage()
  return selected
}

describe('RFC-370 CLI configuration selected storage', () => {
  let directory: string
  let previousAwHome: string | undefined
  let fileText: string
  beforeEach(() => {
    previousAwHome = process.env.AGENT_WORKFLOW_HOME
    directory = mkdtempSync(join(tmpdir(), 'aw-cli-selected-config-'))
    process.env.AGENT_WORKFLOW_HOME = directory
    fileText = JSON.stringify({ ...DEFAULT_CONFIG, maxConcurrentNodes: 23, theme: 'dark' })
    writeFileSync(join(directory, 'config.json'), fileText)
  })
  afterEach(() => {
    if (previousAwHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previousAwHome
    rmSync(directory, { recursive: true, force: true })
  })

  test('GET waits for the selected receiver and formats its current value', async () => {
    const selected = storage()
    const release = barrier()
    selected.readRelease = release.promise
    let settled = false
    const pending = configGetCommand(['maxConcurrentNodes'], selected)
    const completion = pending.then((result) => {
      settled = true
      return result
    })
    try {
      await Promise.race([
        selected.readEntered.promise,
        completion.then(() => {
          throw new Error('GET settled before the selected read ACK')
        }),
      ])
      expect(settled).toBe(false)
      selected.current = { ...selected.current, maxConcurrentNodes: 11 }
      release.resolve()
      expect(await completion).toEqual({ output: '11\n' })
      expect(selected.reads).toBe(1)
      expect(selected.writes).toBe(0)
      expect(readFileSync(join(directory, 'config.json'), 'utf8')).toBe(fileText)
    } finally {
      release.resolve()
      await Promise.allSettled([completion])
    }
  })

  test('GET retains full JSON, raw strings, nested JSON and unknown-key handling', async () => {
    const selected = storage()
    expect(await configGetCommand([], selected)).toEqual({
      output: JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n',
    })
    expect(await configGetCommand(['theme'], selected)).toEqual({ output: 'system\n' })
    const nested = await configGetCommand(['worktreeAutoGc'], selected)
    expect(nested.output).toBe(JSON.stringify(DEFAULT_CONFIG.worktreeAutoGc) + '\n')
    await expect(configGetCommand(['totally-not-a-key'], selected)).rejects.toThrow(
      'unknown config key: totally-not-a-key',
    )
    expect(selected.reads).toBe(4)
    expect(readFileSync(join(directory, 'config.json'), 'utf8')).toBe(fileText)
  })

  test('SET waits for one durable patch ACK and preserves unrelated concurrent settings', async () => {
    const selected = storage()
    const release = barrier()
    selected.writeRelease = release.promise
    let settled = false
    const pending = configSetCommand(['maxConcurrentNodes', '8'], selected)
    const completion = pending.then((result) => {
      settled = true
      return result
    })
    try {
      await Promise.race([
        selected.writeEntered.promise,
        completion.then(() => {
          throw new Error('SET settled before the durable write ACK')
        }),
      ])
      expect(settled).toBe(false)
      expect(selected.reads).toBe(0)
      expect(selected.previews).toBe(0)
      expect(selected.patches).toEqual([{ maxConcurrentNodes: 8 }])
      selected.current = { ...selected.current, publicBaseUrl: 'https://concurrent.example' }
      release.resolve()
      expect(await completion).toEqual({ output: 'maxConcurrentNodes = 8\n' })
      expect(selected.writes).toBe(1)
      expect(selected.current.publicBaseUrl).toBe('https://concurrent.example')
      expect(await configGetCommand(['maxConcurrentNodes'], selected)).toEqual({ output: '8\n' })
      expect(readFileSync(join(directory, 'config.json'), 'utf8')).toBe(fileText)
    } finally {
      release.resolve()
      await Promise.allSettled([completion])
    }
  })

  test('SET keeps JSON-first parsing, nested patches, raw strings and schema rejection', async () => {
    const selected = storage()
    expect(await configSetCommand(['theme', 'dark'], selected)).toEqual({
      output: 'theme = dark\n',
    })
    expect(
      await configSetCommand(['worktreeAutoGc', '{"enabled":true,"olderThanDays":7}'], selected),
    ).toEqual({ output: 'worktreeAutoGc = {"enabled":true,"olderThanDays":7}\n' })
    expect(await configSetCommand(['webhookTaskWorkspaceAutoCleanup', 'true'], selected)).toEqual({
      output: 'webhookTaskWorkspaceAutoCleanup = true\n',
    })
    const prior = structuredClone(selected.current)
    await expect(configSetCommand(['maxConcurrentNodes', '-5'], selected)).rejects.toThrow()
    expect(selected.current).toEqual(prior)
    const writes = selected.writes
    await expect(configSetCommand(['theme'], selected)).rejects.toThrow(
      'usage: agent-workflow config set <key> <value>',
    )
    expect(selected.writes).toBe(writes)
    expect(readFileSync(join(directory, 'config.json'), 'utf8')).toBe(fileText)
  })

  test('synchronous selected failures reject without switching to the file source', async () => {
    const readFailure = new Error('selected read failed')
    const writeFailure = new Error('selected durable write failed')
    const selected = {
      load() {
        expect<unknown>(this).toBe(selected)
        throw readFailure
      },
      applyPatch(patch: unknown) {
        expect<unknown>(this).toBe(selected)
        expect(patch).toEqual({ theme: 'system' })
        throw writeFailure
      },
    }
    await expect(configGetCommand([], selected)).rejects.toBe(readFailure)
    await expect(configSetCommand(['theme', 'system'], selected)).rejects.toBe(writeFailure)
    expect(readFileSync(join(directory, 'config.json'), 'utf8')).toBe(fileText)
  })

  test('standalone commands keep their synchronous result and synchronous errors', () => {
    const get: { output: string } = configGetCommand(['maxConcurrentNodes'])
    expect(get).toEqual({ output: '23\n' })
    expect(get).not.toBeInstanceOf(Promise)
    const set: { output: string } = configSetCommand(['maxConcurrentNodes', '9'])
    expect(set).toEqual({ output: 'maxConcurrentNodes = 9\n' })
    expect(set).not.toBeInstanceOf(Promise)
    expect(configGetCommand(['maxConcurrentNodes'])).toEqual({ output: '9\n' })
    expect(() => configGetCommand(['totally-not-a-key'])).toThrow(/unknown config key/)
    expect(() => configSetCommand(['theme'])).toThrow(/usage:/)
    expect(() => configSetCommand(['maxConcurrentNodes', '-5'])).toThrow()
  })
})
