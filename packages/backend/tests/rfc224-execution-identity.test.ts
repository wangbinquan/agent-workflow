// RFC-224 regression lock, narrowed by RFC-251.
//
// RFC-224 originally treated opencode's final /config and /agent responses as
// hostile JSON and compared them byte-for-byte against the frozen manifest.
// RFC-251 removed that attestation layer, so the comparison suites (final
// config identity, Agent.Info mapping, same-instance seal) are gone with it.
//
// What REMAINS load-bearing, and is locked here:
//   1. the canonical JSON codec — still the basis of every digest;
//   2. `businessOpencodeIdentityDigest` — SESSION RESUME still refuses to reuse
//      a session whose owner row was frozen against different inputs
//      (verifiedPlan compares `owner.identityDigest`), so its stability across
//      an attempt-local seal root, and its sensitivity to real MCP changes,
//      must not drift;
//   3. secret-safe failures — an ExecutionIdentityError may carry only the
//      stable code and a JSON Pointer, never the value that differed.

import { describe, expect, test } from 'bun:test'
import {
  businessOpencodeIdentityDigest,
  canonicalizeIdentity,
  ExecutionIdentityError,
  identityDigest,
} from '@/services/runtime/opencode/executionIdentity'

type JsonObject = Record<string, unknown>

function identityError(fn: () => unknown): ExecutionIdentityError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionIdentityError)
    return error as ExecutionIdentityError
  }
  throw new Error('expected ExecutionIdentityError')
}

describe('RFC-224 canonical identity JSON', () => {
  test('sorts object keys by Unicode code point and retains array order', () => {
    const astral = '\u{10000}'
    const privateUse = '\uE000'
    expect(canonicalizeIdentity({ [astral]: 1, [privateUse]: 2, a: [3, 2, 1] })).toBe(
      `{"a":[3,2,1],"${privateUse}":2,"${astral}":1}`,
    )
    expect(canonicalizeIdentity([2, 1])).not.toBe(canonicalizeIdentity([1, 2]))
  })

  test('object insertion order is semantic-free for canonical bytes and digest', () => {
    const first = { outer: { z: 1, a: 2 }, list: [{ b: true, a: false }] }
    const second = { list: [{ a: false, b: true }], outer: { a: 2, z: 1 } }
    expect(canonicalizeIdentity(first)).toBe(canonicalizeIdentity(second))
    expect(identityDigest(first)).toBe(identityDigest(second))
  })

  test('does not trim strings or normalize prompt line endings', () => {
    const prompt = '  keep leading space\r\nand CRLF\n'
    expect(canonicalizeIdentity(prompt)).toBe(JSON.stringify(prompt))
    expect(identityDigest(prompt)).not.toBe(identityDigest(prompt.trim().replaceAll('\r\n', '\n')))
  })

  const invalidValues: Array<[string, () => unknown, string]> = [
    ['undefined', () => ({ value: undefined }), '/value'],
    ['NaN', () => ({ value: Number.NaN }), '/value'],
    ['Infinity', () => [Number.POSITIVE_INFINITY], '/0'],
    ['bigint', () => 1n, ''],
    ['function', () => ({ fn: () => undefined }), '/fn'],
    ['date instance', () => new Date(0), ''],
    [
      'sparse array',
      () => {
        const sparse = new Array(2)
        sparse[1] = 'present'
        return sparse
      },
      '/0',
    ],
    [
      'array extra property',
      () => {
        const array = [1] as number[] & { extra?: number }
        array.extra = 2
        return array
      },
      '',
    ],
    [
      'accessor',
      () => {
        const value: JsonObject = {}
        Object.defineProperty(value, 'secret', {
          enumerable: true,
          get: () => 'must-not-run',
        })
        return value
      },
      '/secret',
    ],
    [
      'symbol key',
      () => {
        const value: JsonObject = {}
        Object.defineProperty(value, Symbol('hidden'), {
          enumerable: true,
          value: 1,
        })
        return value
      },
      '',
    ],
  ]

  test.each(invalidValues)('rejects non-JSON value: %s', (_name, make, expectedPath) => {
    const error = identityError(() => canonicalizeIdentity(make()))
    expect(error.code).toBe('execution-identity-mismatch')
    expect(error.path).toBe(expectedPath)
  })

  test.each(['__proto__', 'prototype', 'constructor'])(
    'rejects prototype-poisoning key %s',
    (key) => {
      const value = JSON.parse(`{"safe":{"${key}":"do-not-log"}}`)
      const error = identityError(() => canonicalizeIdentity(value))
      expect(error.path).toBe(`/safe/${key}`)
      expect(error.message).not.toContain('do-not-log')
    },
  )

  test('accepts a null-prototype plain JSON record', () => {
    const value = Object.create(null) as Record<string, number>
    value.b = 2
    value.a = 1
    expect(canonicalizeIdentity(value)).toBe('{"a":1,"b":2}')
  })
})

describe('RFC-224 stable business owner identity', () => {
  const model = { providerID: 'openai', modelID: 'gpt-5.6' }
  const build = 'a'.repeat(64)
  const wrapperDigest = 'b'.repeat(64)

  function config(sealRoot: string, digest = wrapperDigest): JsonObject {
    return {
      shell: `${sealRoot}/shell/sh`,
      mcp: {
        tools: {
          type: 'local',
          enabled: true,
          command: [`${sealRoot}/mcp/${digest}/run`],
          timeout: 4_000,
        },
      },
      agent: { worker: { permission: { bash: 'allow' } } },
    }
  }

  // RFC-254 T31: POSIX simulation — `config()` builds a POSIX-absolute sealRoot
  // (`resolve()` rewrites it to a backslash path on win32, so it fails the
  // lexical-canonical gate) AND declares a `shell` key, which win32 rejects
  // outright (SEALED_SHELL_SUPPORTED=false). The win32 digest path is covered
  // for real by rfc254-verified-plan-win32's full-plan build, which calls
  // businessOpencodeIdentityDigest with a real win32-canonical seal root and no
  // shell. Registered in test-suite-policy.
  test.skipIf(process.platform === 'win32')(
    'normalizes only attempt-local seal roots while retaining the MCP semantic digest',
    () => {
      const first = businessOpencodeIdentityDigest({
        config: config('/private/app/runs/task/run-1/opencode-identity-seal'),
        agent: 'worker',
        model,
        binaryDigest: build,
        sealRoot: '/private/app/runs/task/run-1/opencode-identity-seal',
      })
      const resumed = businessOpencodeIdentityDigest({
        config: config('/private/app/runs/task/run-2/opencode-identity-seal'),
        agent: 'worker',
        model,
        binaryDigest: build,
        sealRoot: '/private/app/runs/task/run-2/opencode-identity-seal',
      })
      const changedMcp = businessOpencodeIdentityDigest({
        config: config('/private/app/runs/task/run-2/opencode-identity-seal', 'c'.repeat(64)),
        agent: 'worker',
        model,
        binaryDigest: build,
        sealRoot: '/private/app/runs/task/run-2/opencode-identity-seal',
      })
      expect(resumed).toBe(first)
      expect(changedMcp).not.toBe(first)
    },
  )

  test('rejects an unsealed shell or malformed local-MCP wrapper path', () => {
    const sealRoot = '/private/app/runs/task/run-1/opencode-identity-seal'
    const unsealedShell = config(sealRoot)
    unsealedShell.shell = '/tmp/sh'
    expect(() =>
      businessOpencodeIdentityDigest({
        config: unsealedShell,
        agent: 'worker',
        model,
        binaryDigest: build,
        sealRoot,
      }),
    ).toThrow()

    const malformedMcp = config(sealRoot)
    ;((malformedMcp.mcp as JsonObject).tools as JsonObject).command = [
      `${sealRoot}/mcp/name-only/run`,
    ]
    expect(() =>
      businessOpencodeIdentityDigest({
        config: malformedMcp,
        agent: 'worker',
        model,
        binaryDigest: build,
        sealRoot,
      }),
    ).toThrow()
  })

  // RFC-251: the attestation comparator that used to be the main secret-leak
  // risk is gone, but the digest path still parses configs that carry MCP
  // headers, OAuth secrets, child env and private prompts. The error contract
  // is unchanged: stable code + JSON Pointer only, and no extra own properties
  // that a logger would serialize.
  test('digest failures never carry MCP secrets, env, or prompts', () => {
    const sealRoot = '/private/app/runs/task/run-1/opencode-identity-seal'
    const secrets = ['bearer-token-value', 'oauth-client-secret', 'child-api-token', 'private-body']
    const poisoned: JsonObject = {
      shell: '/tmp/not-sealed',
      mcp: {
        remote_docs: {
          type: 'remote',
          headers: { Authorization: 'bearer-token-value' },
          oauth: { clientSecret: 'oauth-client-secret' },
        },
        local_tools: {
          type: 'local',
          command: [`${sealRoot}/mcp/${'b'.repeat(64)}/run`],
          environment: { API_TOKEN: 'child-api-token' },
        },
      },
      agent: { worker: { prompt: 'private-body' } },
    }

    const error = identityError(() =>
      businessOpencodeIdentityDigest({
        config: poisoned,
        agent: 'worker',
        model,
        binaryDigest: build,
        sealRoot,
      }),
    )
    const rendered = `${error.message}\n${JSON.stringify(error)}\n${error.stack ?? ''}`
    for (const secret of secrets) expect(rendered).not.toContain(secret)
    expect(Object.keys(error).sort()).toEqual(['code', 'name', 'path'])
  })
})
