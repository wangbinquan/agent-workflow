import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ExecutionIdentityFailureCode } from '@agent-workflow/shared'

/**
 * RFC-224's identity codec is deliberately narrower than JavaScript values:
 * manifests and opencode HTTP responses must both be ordinary JSON trees.
 *
 * In particular, accepting class instances, accessors, sparse arrays, or
 * prototype-sensitive keys here would make the digest depend on JavaScript
 * behaviour which JSON itself cannot represent.
 *
 * RFC-251 removed the same-instance config attestation that this module also
 * used to host (`verifyExecutionIdentity` and its /config + /agent comparison
 * machinery). What remains is the canonical JSON codec and the digests, which
 * are still load-bearing for SESSION RESUME: `verifiedPlan` reconstructs
 * `businessOpencodeIdentityDigest` and refuses to resume a session whose owner
 * row was frozen against different inputs.
 */
export type IdentityJson =
  | null
  | boolean
  | number
  | string
  | IdentityJson[]
  | { [key: string]: IdentityJson }

export type ExecutionIdentityErrorCode = Extract<
  ExecutionIdentityFailureCode,
  'execution-identity-mismatch'
>

/**
 * Safe-to-persist RFC-224 failure. The message intentionally contains only the
 * stable code and JSON Pointer; expected/actual values may contain prompts,
 * MCP credentials, headers, or OAuth secrets.
 */
export class ExecutionIdentityError extends Error {
  readonly code: ExecutionIdentityErrorCode
  readonly path: string

  constructor(code: ExecutionIdentityErrorCode, path: string) {
    super(path === '' ? code : `${code} at ${path}`)
    this.name = 'ExecutionIdentityError'
    this.code = code
    this.path = path
  }
}

const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function pointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

function childPath(path: string, key: string | number): string {
  return `${path}/${pointerSegment(String(key))}`
}

function fail(
  path: string,
  code: ExecutionIdentityErrorCode = 'execution-identity-mismatch',
): never {
  throw new ExecutionIdentityError(code, path)
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (key === '') return false
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
}

function assertIdentityJson(
  value: unknown,
  path: string,
  code: ExecutionIdentityErrorCode = 'execution-identity-mismatch',
): asserts value is IdentityJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, code)
    return
  }
  if (typeof value !== 'object') fail(path, code)

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail(path, code)
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue
      if (typeof key !== 'string' || !isArrayIndexKey(key, value.length)) {
        fail(path, code)
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        fail(childPath(path, key), code)
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail(childPath(path, index), code)
      assertIdentityJson(value[index], childPath(path, index), code)
    }
    return
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(path, code)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(path, code)
    if (POISON_KEYS.has(key)) fail(childPath(path, key), code)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      fail(childPath(path, key), code)
    }
    assertIdentityJson(descriptor.value, childPath(path, key), code)
  }
}

/** Compare strings by Unicode code points, not locale or UTF-16 code units. */
function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0) as number)
  const b = Array.from(right, (char) => char.codePointAt(0) as number)
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] as number) - (b[index] as number)
    if (delta !== 0) return delta
  }
  return a.length - b.length
}

function canonicalizeValidated(value: IdentityJson): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeValidated).join(',')}]`
  }
  const keys = Object.keys(value).sort(compareCodePoints)
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalizeValidated(value[key] as IdentityJson)}`)
    .join(',')}}`
}

/**
 * Stable JSON codec used by every RFC-224 digest. Object keys are sorted by
 * Unicode code point and arrays retain their original order.
 */
export function canonicalizeIdentity(value: unknown): string {
  assertIdentityJson(value, '')
  return canonicalizeValidated(value)
}

export function identityDigest(value: unknown): string {
  return createHash('sha256').update(canonicalizeIdentity(value), 'utf8').digest('hex')
}

const LOGICAL_ATTEMPT_SEAL = 'agent-workflow://opencode-attempt-seal'
const LOCAL_MCP_WRAPPER_RELATIVE_RE = /^mcp\/[0-9a-f]{64}\/run$/

function contained(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Owner identity must survive a resume attempt's new runRoot while still
 * changing for every semantic local-MCP input. Physical wrapper paths contain
 * the current nodeRunId, so normalize only the two known sealed path fields.
 * The MCP wrapper directory is itself the full digest of name/executable/argv/
 * sanitized env/timeout, preserving those semantics after normalization.
 */
export function businessOpencodeIdentityDigest(input: {
  config: unknown
  agent: string
  model: unknown
  binaryDigest: string
  sealRoot: string
}): string {
  if (
    !isAbsolute(input.sealRoot) ||
    resolve(input.sealRoot) !== input.sealRoot ||
    typeof input.agent !== 'string' ||
    input.agent.length === 0 ||
    !/^[0-9a-f]{64}$/.test(input.binaryDigest)
  ) {
    fail('')
  }
  const config = JSON.parse(canonicalizeIdentity(input.config)) as Record<string, IdentityJson>
  const expectedShell = join(input.sealRoot, 'shell', 'sh')
  if (config.shell !== expectedShell) fail('/config/shell')
  config.shell = `${LOGICAL_ATTEMPT_SEAL}/shell/sh`

  const mcp = config.mcp
  if (mcp === null || Array.isArray(mcp) || typeof mcp !== 'object') {
    fail('/config/mcp')
  }
  for (const [name, value] of Object.entries(mcp)) {
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      fail(`/config/mcp/${pointerSegment(name)}`)
    }
    if (value.type !== 'local') continue
    const command = value.command
    if (
      !Array.isArray(command) ||
      command.length !== 1 ||
      typeof command[0] !== 'string' ||
      !contained(input.sealRoot, command[0])
    ) {
      fail(`/config/mcp/${pointerSegment(name)}/command`)
    }
    const relativeWrapper = relative(input.sealRoot, command[0]).replaceAll('\\', '/')
    if (!LOCAL_MCP_WRAPPER_RELATIVE_RE.test(relativeWrapper)) {
      fail(`/config/mcp/${pointerSegment(name)}/command/0`)
    }
    value.command = [`${LOGICAL_ATTEMPT_SEAL}/${relativeWrapper}`]
  }

  return identityDigest({
    codec: 2,
    config,
    agent: input.agent,
    model: input.model,
    binaryDigest: input.binaryDigest,
  })
}
