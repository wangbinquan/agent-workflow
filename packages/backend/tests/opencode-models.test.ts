// RFC-001 unit tests for the opencode-models parser + cache.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearOpencodeModelsCache,
  listOpencodeModels,
  parseModelsOutput,
} from '../src/util/opencode-models'

describe('parseModelsOutput', () => {
  test('extracts name from verbose JSON block', () => {
    const out = [
      'anthropic/claude-sonnet-4-6',
      '{',
      '  "name": "Claude Sonnet 4.6",',
      '  "cost": { "input": 0.003 }',
      '}',
      'openai/gpt-5',
      '{',
      '  "name": "GPT-5"',
      '}',
    ].join('\n')
    expect(parseModelsOutput(out)).toEqual([
      { id: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', modelID: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'openai/gpt-5', provider: 'openai', modelID: 'gpt-5', name: 'GPT-5' },
    ])
  })

  test('handles id-only output without verbose JSON', () => {
    const out = 'anthropic/foo\nopenai/bar\nopencode/baz'
    expect(parseModelsOutput(out)).toEqual([
      { id: 'anthropic/foo', provider: 'anthropic', modelID: 'foo' },
      { id: 'openai/bar', provider: 'openai', modelID: 'bar' },
      { id: 'opencode/baz', provider: 'opencode', modelID: 'baz' },
    ])
  })

  test('drops malformed JSON metadata but keeps id', () => {
    const out = ['anthropic/foo', '{not valid json'].join('\n')
    expect(parseModelsOutput(out)).toEqual([
      { id: 'anthropic/foo', provider: 'anthropic', modelID: 'foo' },
    ])
  })

  test('ignores blank input', () => {
    expect(parseModelsOutput('')).toEqual([])
    expect(parseModelsOutput('\n\n\n')).toEqual([])
  })

  test('json keys that contain slashes do not get mis-detected', () => {
    const out = [
      'anthropic/foo',
      '{',
      '  "name": "Anthropic Foo",',
      '  "endpoint": "https://api/anthropic"',
      '}',
    ].join('\n')
    expect(parseModelsOutput(out)).toEqual([
      { id: 'anthropic/foo', provider: 'anthropic', modelID: 'foo', name: 'Anthropic Foo' },
    ])
  })
})

describe('listOpencodeModels cache', () => {
  let tmp: string
  let stub: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-opencode-stub-'))
    stub = join(tmp, 'stub-opencode.sh')
    writeStub(stub, '/* default */')
    clearOpencodeModelsCache()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('first call cached=false; second call cached=true', async () => {
    writeStub(stub, ['anthropic/foo', 'openai/bar'].join('\n'))
    const first = await listOpencodeModels(stub)
    expect(first.cached).toBe(false)
    expect(first.models).toHaveLength(2)
    const second = await listOpencodeModels(stub)
    expect(second.cached).toBe(true)
    expect(second.models).toEqual(first.models)
  })

  test('different binary path bypasses cache', async () => {
    writeStub(stub, 'anthropic/foo')
    await listOpencodeModels(stub)
    const otherStub = join(tmp, 'stub-other.sh')
    writeStub(otherStub, 'openai/bar')
    const result = await listOpencodeModels(otherStub)
    expect(result.cached).toBe(false)
    expect(result.binary).toBe(otherStub)
    expect(result.models).toEqual([{ id: 'openai/bar', provider: 'openai', modelID: 'bar' }])
  })

  test('refresh=true bypasses cache and passes --refresh flag', async () => {
    writeStub(stub, 'anthropic/foo', { recordArgs: true })
    await listOpencodeModels(stub) // priming
    const refreshed = await listOpencodeModels(stub, { refresh: true })
    expect(refreshed.cached).toBe(false)
    const args = await Bun.file(join(tmp, 'args.log')).text()
    expect(args).toContain('--refresh')
  })

  test('non-zero exit code throws', async () => {
    writeStub(stub, '', { exitCode: 7, stderr: 'boom' })
    let threw: Error | null = null
    try {
      await listOpencodeModels(stub)
    } catch (e) {
      threw = e as Error
    }
    expect(threw).not.toBeNull()
    expect(threw?.message).toContain('exited 7')
    expect(threw?.message).toContain('boom')
  })
})

function writeStub(
  path: string,
  body: string,
  opts: { exitCode?: number; stderr?: string; recordArgs?: boolean } = {},
): void {
  const { exitCode = 0, stderr = '', recordArgs = false } = opts
  const escapedBody = body.replace(/'/g, `'\\''`)
  const escapedStderr = stderr.replace(/'/g, `'\\''`)
  const argsLog = recordArgs ? `echo "$@" >> "$(dirname "$0")/args.log"\n` : ''
  const script = `#!/bin/sh\n${argsLog}printf '%s' '${escapedBody}'\nif [ -n '${escapedStderr}' ]; then printf '%s' '${escapedStderr}' >&2; fi\nexit ${exitCode}\n`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
}
