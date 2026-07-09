import { rimrafDir } from './helpers/cleanup'
// RFC-001 unit tests for the opencode-models parser + cache.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWindows, stubCmd } from './helpers/stub-runtime'
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

  /** On Windows, .js stubs need `bun run` prefix; on POSIX, .sh stubs spawn directly. */
  function modelsOpts(overrides?: { refresh?: boolean; timeoutMs?: number }) {
    return {
      ...overrides,
      ...(isWindows ? { cmd: stubCmd(stub) } : {}),
    }
  }

  /** Build opts for an arbitrary stub path (not the default `stub`). */
  function modelsOptsFor(stubPath: string, overrides?: { refresh?: boolean; timeoutMs?: number }) {
    return {
      ...overrides,
      ...(isWindows ? { cmd: stubCmd(stubPath) } : {}),
    }
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-opencode-stub-'))
    const stubName = isWindows ? 'stub-opencode.js' : 'stub-opencode.sh'
    stub = join(tmp, stubName)
    writeStub(stub, '/* default */')
    clearOpencodeModelsCache()
  })

  afterEach(() => {
    rimrafDir(tmp)
  })

  test('first call cached=false; second call cached=true', async () => {
    writeStub(stub, ['anthropic/foo', 'openai/bar'].join('\n'))
    const first = await listOpencodeModels(stub, modelsOpts())
    expect(first.cached).toBe(false)
    expect(first.models).toHaveLength(2)
    const second = await listOpencodeModels(stub, modelsOpts())
    expect(second.cached).toBe(true)
    expect(second.models).toEqual(first.models)
  })

  test('different binary path bypasses cache', async () => {
    writeStub(stub, 'anthropic/foo')
    await listOpencodeModels(stub, modelsOpts())
    const otherStubName = isWindows ? 'stub-other.js' : 'stub-other.sh'
    const otherStub = join(tmp, otherStubName)
    writeStub(otherStub, 'openai/bar')
    const result = await listOpencodeModels(otherStub, modelsOptsFor(otherStub))
    expect(result.cached).toBe(false)
    expect(result.binary).toBe(otherStub)
    expect(result.models).toEqual([{ id: 'openai/bar', provider: 'openai', modelID: 'bar' }])
  })

  test('refresh=true bypasses cache and passes --refresh flag', async () => {
    writeStub(stub, 'anthropic/foo', { recordArgs: true })
    await listOpencodeModels(stub, modelsOpts()) // priming
    const refreshed = await listOpencodeModels(stub, modelsOpts({ refresh: true }))
    expect(refreshed.cached).toBe(false)
    const args = await Bun.file(join(tmp, 'args.log')).text()
    expect(args).toContain('--refresh')
  })

  test('non-zero exit code throws', async () => {
    writeStub(stub, '', { exitCode: 7, stderr: 'boom' })
    let threw: Error | null = null
    try {
      await listOpencodeModels(stub, modelsOpts())
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
    const otherStubName = isWindows ? 'stub-other.js' : 'stub-other.sh'
    const otherStub = join(tmp, otherStubName)
    writeStub(otherStub, 'openai/b')
    expect((await listOpencodeModels(stub, modelsOpts())).cached).toBe(false) // A: miss
    expect((await listOpencodeModels(otherStub, modelsOptsFor(otherStub))).cached).toBe(false) // B: miss
    expect((await listOpencodeModels(stub, modelsOpts())).cached).toBe(true) // A again: STILL cached (Map)
    expect((await listOpencodeModels(otherStub, modelsOptsFor(otherStub))).cached).toBe(true) // B again: STILL cached
  })

  // RFC-114 P3-6: evicting one binary's slot forces a re-run for it only.
  test('evictOpencodeModelsCache drops one binary, leaving others cached', async () => {
    writeStub(stub, 'anthropic/a')
    const otherStubName = isWindows ? 'stub-other2.js' : 'stub-other2.sh'
    const otherStub = join(tmp, otherStubName)
    writeStub(otherStub, 'openai/b')
    await listOpencodeModels(stub, modelsOpts())
    await listOpencodeModels(otherStub, modelsOptsFor(otherStub))
    evictOpencodeModelsCache(stub)
    expect((await listOpencodeModels(stub, modelsOpts())).cached).toBe(false) // re-run
    expect((await listOpencodeModels(otherStub, modelsOptsFor(otherStub))).cached).toBe(true) // untouched
  })

  // RFC-114 P2-3: a hung fork binary must be killed by the timeout, not wedge the
  // daemon. With a 200ms timeout against a `sleep 5` stub, the call rejects fast.
  test('a hung binary is killed by the timeout', async () => {
    const hungName = isWindows ? 'stub-hung.js' : 'stub-hung.sh'
    const hung = join(tmp, hungName)
    if (isWindows) {
      writeFileSync(hung, 'setInterval(() => {}, 60000)\n')
    } else {
      writeFileSync(hung, '#!/bin/sh\nsleep 5\n')
      chmodSync(hung, 0o755)
    }
    const t0 = Date.now()
    let threw: Error | null = null
    try {
      await listOpencodeModels(hung, {
        timeoutMs: 200,
        ...(isWindows ? { cmd: stubCmd(hung) } : {}),
      })
    } catch (e) {
      threw = e as Error
    }
    expect(threw?.message).toMatch(/timed out/i)
    expect(Date.now() - t0).toBeLessThan(3_000) // killed well before the 5s sleep
  })
})

function writeStub(
  path: string,
  body: string,
  opts: { exitCode?: number; stderr?: string; recordArgs?: boolean } = {},
): void {
  const { exitCode = 0, stderr = '', recordArgs = false } = opts

  if (isWindows) {
    // Write a .js stub for Windows
    const lines: string[] = ['// Auto-generated stub for Windows test compatibility']
    if (recordArgs) {
      lines.push(
        `const { writeFileSync } = require('node:fs')`,
        `const { join } = require('node:path')`,
        `writeFileSync(join(${JSON.stringify(join(path, '..'))}, 'args.log'), process.argv.slice(2).join(' ') + '\\n', { flag: 'a' })`,
      )
    }
    lines.push(`process.stdout.write(${JSON.stringify(body)})`)
    if (stderr) {
      lines.push(`process.stderr.write(${JSON.stringify(stderr)})`)
    }
    lines.push(`process.exit(${exitCode})`)
    writeFileSync(path, lines.join('\n'))
    return
  }

  // POSIX: write .sh
  const escapedBody = body.replace(/'/g, `'\\''`)
  const escapedStderr = stderr.replace(/'/g, `'\\''`)
  const argsLog = recordArgs ? `echo "$@" >> "$(dirname "$0")/args.log"\n` : ''
  const script = `#!/bin/sh\n${argsLog}printf '%s' '${escapedBody}'\nif [ -n '${escapedStderr}' ]; then printf '%s' '${escapedStderr}' >&2; fi\nexit ${exitCode}\n`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
}
