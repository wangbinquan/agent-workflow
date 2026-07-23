// RFC-001 unit tests for the opencode-models parser + cache.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearOpencodeModelsCache,
  evictOpencodeModelsCache,
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
      {
        id: 'anthropic/claude-sonnet-4-6',
        provider: 'anthropic',
        modelID: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
      },
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

  test('a failed pre-cache fence never leaves a reusable result', async () => {
    writeStub(stub, 'anthropic/rejected')
    await expect(
      listOpencodeModels(stub, {
        cacheKey: 'stable-official-binary',
        beforeCacheWrite: () => {
          throw new Error('source changed')
        },
      }),
    ).rejects.toThrow('source changed')

    writeStub(stub, 'openai/accepted')
    const retry = await listOpencodeModels(stub, { cacheKey: 'stable-official-binary' })
    expect(retry.cached).toBe(false)
    expect(retry.models).toEqual([
      { id: 'openai/accepted', provider: 'openai', modelID: 'accepted' },
    ])
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

  // RFC-114 D4: the Map keeps EACH binary's list — querying B between two A calls
  // must NOT evict A. The old single-slot cache returned cached:false on the 2nd A.
  test('different binaries cache independently — an intervening binary does not evict (D4)', async () => {
    writeStub(stub, 'anthropic/a')
    const otherStub = join(tmp, 'stub-other.sh')
    writeStub(otherStub, 'openai/b')
    expect((await listOpencodeModels(stub)).cached).toBe(false) // A: miss
    expect((await listOpencodeModels(otherStub)).cached).toBe(false) // B: miss
    expect((await listOpencodeModels(stub)).cached).toBe(true) // A again: STILL cached (Map)
    expect((await listOpencodeModels(otherStub)).cached).toBe(true) // B again: STILL cached
  })

  // RFC-114 P3-6: evicting one binary's slot forces a re-run for it only.
  test('evictOpencodeModelsCache drops one binary, leaving others cached', async () => {
    writeStub(stub, 'anthropic/a')
    const otherStub = join(tmp, 'stub-other2.sh')
    writeStub(otherStub, 'openai/b')
    await listOpencodeModels(stub)
    await listOpencodeModels(otherStub)
    evictOpencodeModelsCache(stub)
    expect((await listOpencodeModels(stub)).cached).toBe(false) // re-run
    expect((await listOpencodeModels(otherStub)).cached).toBe(true) // untouched
  })

  // RFC-114 P2-3: a hung fork binary must be killed by the timeout, not wedge the
  // daemon. With a 200ms timeout against a `sleep 5` stub, the call rejects fast.
  test('a hung binary is killed by the timeout', async () => {
    const hung = join(tmp, 'stub-hung.sh')
    writeFileSync(hung, '#!/bin/sh\nsleep 5\n')
    chmodSync(hung, 0o755)
    const t0 = Date.now()
    let threw: Error | null = null
    try {
      await listOpencodeModels(hung, { timeoutMs: 200 })
    } catch (e) {
      threw = e as Error
    }
    expect(threw?.message).toMatch(/timed out/i)
    expect(Date.now() - t0).toBeLessThan(3_000) // killed well before the 5s sleep
  })

  test('a wrapper that exits after forking a closed-stdio helper still has its group reaped', async () => {
    const forking = join(tmp, 'stub-forking.sh')
    const leakMarker = join(tmp, 'descendant-survived')
    writeFileSync(
      forking,
      `#!/bin/sh
(
  trap '' HUP
  sleep 1
  printf leaked > "$(dirname "$0")/descendant-survived"
) </dev/null >/dev/null 2>&1 &
printf 'openai/reaped-helper\n'
exit 0
`,
    )
    chmodSync(forking, 0o755)

    expect(await listOpencodeModels(forking)).toMatchObject({
      cached: false,
      models: [{ id: 'openai/reaped-helper' }],
    })
    await Bun.sleep(1_200)
    expect(existsSync(leakMarker)).toBe(false)
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
