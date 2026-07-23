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
  'execution-identity-mismatch' | 'execution-identity-instance-changed'
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

export interface VerifyExecutionIdentityInput {
  expectedInlineConfig: unknown
  effectiveConfig: unknown
  /** First GET /agent response from the dedicated opencode instance. */
  agents: unknown
  selectedAgentName: string
  /**
   * Optional immediate second GET /agent response. Supplying it makes the
   * same-instance seal check atomic with the rest of verification.
   */
  secondAgents?: unknown
  /**
   * HOME used by the frozen opencode child. Required only when an injected
   * permission pattern uses ~ or $HOME expansion.
   */
  permissionHome?: string
}

export interface ExecutionIdentityProof {
  configDigest: string
  agentInfoSeal: string
  controlledAgentNames: readonly string[]
}

const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const PERMISSION_ACTIONS = new Set(['allow', 'deny', 'ask'])
const NATIVE_AGENT_NAMES = new Set([
  'build',
  'plan',
  'general',
  'explore',
  'compaction',
  'title',
  'summary',
])
const AGENT_INFO_FIELDS = new Set([
  'name',
  'description',
  'mode',
  'native',
  'hidden',
  'topP',
  'temperature',
  'color',
  'permission',
  'model',
  'variant',
  'prompt',
  'options',
  'steps',
])
const AGENT_CONFIG_KNOWN_FIELDS = new Set([
  'name',
  'model',
  'variant',
  'prompt',
  'description',
  'temperature',
  'top_p',
  'mode',
  'hidden',
  'color',
  'steps',
  'maxSteps',
  'options',
  'permission',
  'disable',
  'tools',
])
const OPTIONAL_AGENT_INFO_FIELDS = [
  'description',
  'hidden',
  'topP',
  'temperature',
  'color',
  'model',
  'variant',
  'prompt',
  'steps',
] as const
const SECURITY_CONFIG_FIELDS = [
  'share',
  'autoupdate',
  'snapshot',
  'formatter',
  'lsp',
  'compaction',
  'shell',
  'instructions',
  'skills',
] as const
const ALLOWED_EFFECTIVE_CONFIG_FIELDS = new Set([
  ...SECURITY_CONFIG_FIELDS,
  'agent',
  'permission',
  'mcp',
  'plugin',
  // Exact harmless defaults observed in the pinned v1.18.3 /config response.
  'command',
  'username',
  'mode',
  // Optional explicit provider config is compared when present in the
  // expected manifest; provider/model implementation is also checked through
  // /config/providers by the launcher.
  'provider',
])

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
  officialBuildDigest: string
  sealRoot: string
}): string {
  if (
    !isAbsolute(input.sealRoot) ||
    resolve(input.sealRoot) !== input.sealRoot ||
    typeof input.agent !== 'string' ||
    input.agent.length === 0 ||
    !/^[0-9a-f]{64}$/.test(input.officialBuildDigest)
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
    officialBuildDigest: input.officialBuildDigest,
  })
}

function firstDifferenceValidated(
  expected: IdentityJson,
  actual: IdentityJson,
  path: string,
): string | null {
  if (expected === actual) return null
  if (expected === null || actual === null || typeof expected !== typeof actual) {
    return path
  }
  if (
    typeof expected === 'boolean' ||
    typeof expected === 'number' ||
    typeof expected === 'string'
  ) {
    return path
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return path
    const commonLength = Math.min(expected.length, actual.length)
    for (let index = 0; index < commonLength; index += 1) {
      const difference = firstDifferenceValidated(
        expected[index] as IdentityJson,
        actual[index] as IdentityJson,
        childPath(path, index),
      )
      if (difference !== null) return difference
    }
    return expected.length === actual.length ? null : childPath(path, commonLength)
  }

  const expectedObject = expected as { [key: string]: IdentityJson }
  const actualObject = actual as { [key: string]: IdentityJson }
  const keys = [...new Set([...Object.keys(expectedObject), ...Object.keys(actualObject)])].sort(
    compareCodePoints,
  )
  for (const key of keys) {
    if (!Object.hasOwn(expectedObject, key) || !Object.hasOwn(actualObject, key)) {
      return childPath(path, key)
    }
    const difference = firstDifferenceValidated(
      expectedObject[key] as IdentityJson,
      actualObject[key] as IdentityJson,
      childPath(path, key),
    )
    if (difference !== null) return difference
  }
  return null
}

/**
 * Return the first semantic difference as a JSON Pointer. No compared value is
 * ever returned or interpolated into an error.
 */
export function firstIdentityDifference(
  expected: unknown,
  actual: unknown,
  basePath = '',
): string | null {
  assertIdentityJson(expected, basePath)
  assertIdentityJson(actual, basePath)
  return firstDifferenceValidated(expected, actual, basePath)
}

function expectObject(
  value: IdentityJson | undefined,
  path: string,
  code: ExecutionIdentityErrorCode = 'execution-identity-mismatch',
): { [key: string]: IdentityJson } {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object') {
    fail(path, code)
  }
  return value
}

function optionalObject(
  parent: { [key: string]: IdentityJson },
  key: string,
  path: string,
): { [key: string]: IdentityJson } {
  if (!Object.hasOwn(parent, key)) return Object.create(null) as { [key: string]: IdentityJson }
  return expectObject(parent[key], path)
}

function optionalArray(
  parent: { [key: string]: IdentityJson },
  key: string,
  path: string,
): IdentityJson[] {
  if (!Object.hasOwn(parent, key)) return []
  const value = parent[key]
  if (!Array.isArray(value)) fail(path)
  return value
}

function normalizePermissionConfig(
  value: IdentityJson | undefined,
  path: string,
): { [key: string]: IdentityJson } {
  if (value === undefined) return Object.create(null) as { [key: string]: IdentityJson }
  if (typeof value === 'string') {
    if (!PERMISSION_ACTIONS.has(value)) fail(path)
    return { '*': value }
  }
  return expectObject(value, path)
}

function normalizeAgentConfig(value: IdentityJson, path: string): { [key: string]: IdentityJson } {
  const source = expectObject(value, path)
  const output: { [key: string]: IdentityJson } = { ...source }

  const options =
    source.options === undefined
      ? ({} as { [key: string]: IdentityJson })
      : { ...expectObject(source.options, childPath(path, 'options')) }
  for (const [key, field] of Object.entries(source)) {
    if (!AGENT_CONFIG_KNOWN_FIELDS.has(key)) options[key] = field
  }
  output.options = options

  const permission: { [key: string]: IdentityJson } = {}
  if (source.tools !== undefined) {
    const tools = expectObject(source.tools, childPath(path, 'tools'))
    for (const [tool, enabled] of Object.entries(tools)) {
      if (typeof enabled !== 'boolean') fail(childPath(childPath(path, 'tools'), tool))
      const action = enabled ? 'allow' : 'deny'
      if (tool === 'write' || tool === 'edit' || tool === 'patch') {
        permission.edit = action
      } else {
        permission[tool] = action
      }
    }
  }
  const configuredPermission = normalizePermissionConfig(
    source.permission,
    childPath(path, 'permission'),
  )
  for (const [key, rule] of Object.entries(configuredPermission)) permission[key] = rule
  output.permission = permission

  if (source.steps === undefined && source.maxSteps !== undefined) {
    output.steps = source.maxSteps
  }
  return output
}

interface PermissionRule {
  permission: string
  pattern: string
  action: string
}

function expandPermissionPattern(pattern: string, home: string | undefined, path: string): string {
  if (pattern === '~' || pattern.startsWith('~/') || pattern.startsWith('$HOME')) {
    if (home === undefined) fail(path)
    if (pattern === '~') return home
    if (pattern.startsWith('~/')) return home + pattern.slice(1)
    if (pattern.startsWith('$HOME/')) return home + pattern.slice(5)
    return home + pattern.slice(5)
  }
  return pattern
}

function permissionConfigToRules(
  value: IdentityJson | undefined,
  path: string,
  home: string | undefined,
): PermissionRule[] {
  const config = normalizePermissionConfig(value, path)
  const rules: PermissionRule[] = []
  for (const [permission, configured] of Object.entries(config)) {
    const permissionPath = childPath(path, permission)
    if (typeof configured === 'string') {
      if (!PERMISSION_ACTIONS.has(configured)) fail(permissionPath)
      rules.push({ permission, pattern: '*', action: configured })
      continue
    }
    const patterns = expectObject(configured, permissionPath)
    for (const [pattern, action] of Object.entries(patterns)) {
      const rulePath = childPath(permissionPath, pattern)
      if (typeof action !== 'string' || !PERMISSION_ACTIONS.has(action)) fail(rulePath)
      rules.push({
        permission,
        pattern: expandPermissionPattern(pattern, home, rulePath),
        action,
      })
    }
  }
  return rules
}

function parseModel(model: string, path: string): { providerID: string; modelID: string } {
  const [providerID = '', ...rest] = model.split('/')
  const modelID = rest.join('/')
  if (providerID === '' || modelID === '') fail(path)
  return { providerID, modelID }
}

function expectedAgentInfoProjection(
  registryName: string,
  rawEntry: { [key: string]: IdentityJson },
  path: string,
): { [key: string]: IdentityJson } {
  const projection: { [key: string]: IdentityJson } = {
    name: registryName,
    mode: rawEntry.mode ?? 'all',
    native: false,
    options: rawEntry.options ?? {},
  }
  const directFields = [
    'description',
    'hidden',
    'temperature',
    'color',
    'variant',
    'prompt',
  ] as const
  for (const field of directFields) {
    if (rawEntry[field] !== undefined) projection[field] = rawEntry[field]
  }
  if (rawEntry.top_p !== undefined) projection.topP = rawEntry.top_p
  const steps = rawEntry.steps ?? rawEntry.maxSteps
  if (steps !== undefined) projection.steps = steps
  if (rawEntry.model !== undefined) {
    if (typeof rawEntry.model !== 'string') fail(childPath(path, 'model'))
    projection.model = parseModel(rawEntry.model, childPath(path, 'model'))
  }
  if (rawEntry.name !== undefined) {
    if (rawEntry.name !== registryName) fail(childPath(path, 'name'))
    projection.name = rawEntry.name
  }
  return projection
}

function validatePermissionRules(
  value: IdentityJson | undefined,
  path: string,
  code: ExecutionIdentityErrorCode,
): PermissionRule[] {
  if (!Array.isArray(value)) fail(path, code)
  for (let index = 0; index < value.length; index += 1) {
    const rulePath = childPath(path, index)
    const rule = expectObject(value[index], rulePath, code)
    const keys = Object.keys(rule).sort(compareCodePoints)
    const expectedKeys = ['action', 'pattern', 'permission']
    const keyDifference = firstDifferenceValidated(expectedKeys, keys, rulePath)
    if (keyDifference !== null) fail(keyDifference, code)
    if (
      typeof rule.permission !== 'string' ||
      typeof rule.pattern !== 'string' ||
      typeof rule.action !== 'string' ||
      !PERMISSION_ACTIONS.has(rule.action)
    ) {
      if (typeof rule.permission !== 'string') fail(childPath(rulePath, 'permission'), code)
      if (typeof rule.pattern !== 'string') fail(childPath(rulePath, 'pattern'), code)
      fail(childPath(rulePath, 'action'), code)
    }
  }
  return value as unknown as PermissionRule[]
}

function suffixDifference(
  actual: PermissionRule[],
  expected: PermissionRule[],
  path: string,
): string | null {
  if (actual.length < expected.length) return childPath(path, actual.length)
  const offset = actual.length - expected.length
  for (let index = 0; index < expected.length; index += 1) {
    const difference = firstDifferenceValidated(
      expected[index] as unknown as IdentityJson,
      actual[offset + index] as unknown as IdentityJson,
      childPath(path, offset + index),
    )
    if (difference !== null) return difference
  }
  return null
}

function assertControlledPermissionTail(
  actual: PermissionRule[],
  controlled: PermissionRule[],
  path: string,
  code: ExecutionIdentityErrorCode,
): void {
  const directDifference = suffixDifference(actual, controlled, path)
  if (directDifference === null) return
  fail(directDifference, code)
}

interface AgentRegistry {
  byName: { [key: string]: { [key: string]: IdentityJson } }
  orderedControlled: { [key: string]: IdentityJson }[]
}

function parseAgentRegistry(
  agents: IdentityJson,
  controlledNames: readonly string[],
  code: ExecutionIdentityErrorCode,
): AgentRegistry {
  if (!Array.isArray(agents)) fail('/agent', code)
  const controlled = new Set(controlledNames)
  const byName: { [key: string]: { [key: string]: IdentityJson } } = Object.create(null)
  const orderedControlled: { [key: string]: IdentityJson }[] = []

  for (let index = 0; index < agents.length; index += 1) {
    const indexedPath = childPath('/agent', index)
    const info = expectObject(agents[index], indexedPath, code)
    if (typeof info.name !== 'string' || info.name === '') {
      fail(childPath(indexedPath, 'name'), code)
    }
    const name = info.name
    const namedPath = childPath('/agent', name)
    if (Object.hasOwn(byName, name)) fail(namedPath, code)
    for (const key of Object.keys(info)) {
      if (!AGENT_INFO_FIELDS.has(key)) fail(childPath(namedPath, key), code)
    }
    byName[name] = info
    if (controlled.has(name)) {
      orderedControlled.push(info)
      continue
    }
    if (info.native !== true || !NATIVE_AGENT_NAMES.has(name)) fail(namedPath, code)
  }

  for (const name of controlledNames) {
    if (!Object.hasOwn(byName, name)) fail(childPath('/agent', name), code)
  }
  return { byName, orderedControlled }
}

function buildAgentRegistrySeal(registry: AgentRegistry): IdentityJson {
  // The second `/agent` gate seals the complete registry, including the fixed
  // native baseline. Otherwise a native entry could appear/disappear or mutate
  // between reads while the controlled-only projection remained unchanged.
  const seal: { [key: string]: IdentityJson } = Object.create(null)
  for (const name of Object.keys(registry.byName).sort(compareCodePoints)) {
    seal[name] = registry.byName[name] as { [key: string]: IdentityJson }
  }
  return seal
}

function verifyAgentInfos(
  agents: IdentityJson,
  controlledEntries: { [key: string]: { [key: string]: IdentityJson } },
  globalPermission: IdentityJson | undefined,
  permissionHome: string | undefined,
  code: ExecutionIdentityErrorCode,
): AgentRegistry {
  const controlledNames = Object.keys(controlledEntries)
  const registry = parseAgentRegistry(agents, controlledNames, code)

  for (const name of controlledNames) {
    const path = childPath('/agent', name)
    const info = registry.byName[name] as { [key: string]: IdentityJson }
    const expectedEntry = controlledEntries[name] as { [key: string]: IdentityJson }
    if (info.name !== name) fail(childPath(path, 'name'), code)
    if (info.native !== false) fail(childPath(path, 'native'), code)
    if (info.mode === 'subagent' || (info.mode !== 'primary' && info.mode !== 'all')) {
      fail(childPath(path, 'mode'), code)
    }
    if (info.hidden === true) fail(childPath(path, 'hidden'), code)

    const expectedProjection = expectedAgentInfoProjection(name, expectedEntry, path)
    for (const [field, expectedValue] of Object.entries(expectedProjection)) {
      const actualValue =
        (OPTIONAL_AGENT_INFO_FIELDS as readonly string[]).includes(field) && info[field] === null
          ? undefined
          : info[field]
      const difference = firstDifferenceValidated(
        expectedValue,
        actualValue as IdentityJson,
        childPath(path, field),
      )
      if (difference !== null) fail(difference, code)
    }
    for (const field of OPTIONAL_AGENT_INFO_FIELDS) {
      if (
        !Object.hasOwn(expectedProjection, field) &&
        Object.hasOwn(info, field) &&
        info[field] !== null
      ) {
        fail(childPath(path, field), code)
      }
    }

    const actualRules = validatePermissionRules(
      info.permission,
      childPath(path, 'permission'),
      code,
    )
    const controlledRules = [
      ...permissionConfigToRules(globalPermission, '/config/permission', permissionHome),
      ...permissionConfigToRules(
        expectedEntry.permission,
        childPath(childPath('/config/agent', name), 'permission'),
        permissionHome,
      ),
    ]
    assertControlledPermissionTail(
      actualRules,
      controlledRules,
      childPath(path, 'permission'),
      code,
    )
  }
  return registry
}

function compareOrFail(
  expected: IdentityJson,
  actual: IdentityJson,
  path: string,
  code: ExecutionIdentityErrorCode = 'execution-identity-mismatch',
): void {
  const difference = firstDifferenceValidated(expected, actual, path)
  if (difference !== null) fail(difference, code)
}

/**
 * Verify the final config and Agent.Info registry returned by one dedicated
 * opencode server. The function is pure: it reads no files, environment, or
 * process-global state.
 */
export function verifyExecutionIdentity(
  input: VerifyExecutionIdentityInput,
): ExecutionIdentityProof {
  if (typeof input.selectedAgentName !== 'string' || input.selectedAgentName === '') {
    fail('/agent')
  }
  if (input.permissionHome !== undefined && typeof input.permissionHome !== 'string') {
    fail('/permissionHome')
  }
  assertIdentityJson(input.expectedInlineConfig, '/config')
  assertIdentityJson(input.effectiveConfig, '/config')
  assertIdentityJson(input.agents, '/agent')
  if (input.secondAgents !== undefined) {
    assertIdentityJson(input.secondAgents, '/agent', 'execution-identity-instance-changed')
  }

  const expected = expectObject(input.expectedInlineConfig, '/config')
  const effective = expectObject(input.effectiveConfig, '/config')

  for (const key of Object.keys(effective)) {
    if (!ALLOWED_EFFECTIVE_CONFIG_FIELDS.has(key)) fail(childPath('/config', key))
  }
  const securityProof: { [key: string]: IdentityJson } = Object.create(null)
  for (const field of SECURITY_CONFIG_FIELDS) {
    if (!Object.hasOwn(expected, field)) fail(childPath('/config', field))
    if (!Object.hasOwn(effective, field)) fail(childPath('/config', field))
    compareOrFail(
      expected[field] as IdentityJson,
      effective[field] as IdentityJson,
      childPath('/config', field),
    )
    securityProof[field] = expected[field] as IdentityJson
  }
  for (const [field, safeDefault] of [
    ['command', {}],
    ['mode', {}],
  ] as const) {
    if (Object.hasOwn(effective, field)) {
      compareOrFail(
        safeDefault as IdentityJson,
        effective[field] as IdentityJson,
        childPath('/config', field),
      )
    }
  }
  if (Object.hasOwn(effective, 'username') && typeof effective.username !== 'string') {
    fail('/config/username')
  }
  if (Object.hasOwn(expected, 'provider') || Object.hasOwn(effective, 'provider')) {
    if (!Object.hasOwn(expected, 'provider') || !Object.hasOwn(effective, 'provider')) {
      fail('/config/provider')
    }
    compareOrFail(
      expected.provider as IdentityJson,
      effective.provider as IdentityJson,
      '/config/provider',
    )
    securityProof.provider = expected.provider as IdentityJson
  }
  const expectedAgents = expectObject(expected.agent, '/config/agent')
  const effectiveAgents = optionalObject(effective, 'agent', '/config/agent')
  const controlledEntries: {
    [key: string]: { [key: string]: IdentityJson }
  } = Object.create(null)

  for (const [name, expectedEntryValue] of Object.entries(expectedAgents)) {
    const path = childPath('/config/agent', name)
    if (NATIVE_AGENT_NAMES.has(name)) fail(path)
    const expectedEntry = expectObject(expectedEntryValue, path)
    if (expectedEntry.disable === true) fail(childPath(path, 'disable'))
    const normalizedExpected = normalizeAgentConfig(expectedEntry, path)
    if (!Object.hasOwn(effectiveAgents, name)) fail(path)
    const normalizedEffective = expectObject(effectiveAgents[name], path)
    compareOrFail(normalizedExpected, normalizedEffective, path)
    controlledEntries[name] = normalizedExpected
  }
  for (const name of Object.keys(effectiveAgents)) {
    if (!Object.hasOwn(controlledEntries, name) && !NATIVE_AGENT_NAMES.has(name)) {
      fail(childPath('/config/agent', name))
    }
  }

  const expectedPermission = normalizePermissionConfig(expected.permission, '/config/permission')
  const effectivePermission = normalizePermissionConfig(effective.permission, '/config/permission')
  compareOrFail(expectedPermission, effectivePermission, '/config/permission')

  const expectedMcp = optionalObject(expected, 'mcp', '/config/mcp')
  const effectiveMcp = optionalObject(effective, 'mcp', '/config/mcp')
  compareOrFail(expectedMcp, effectiveMcp, '/config/mcp')

  const expectedPlugins = optionalArray(expected, 'plugin', '/config/plugin')
  const effectivePlugins = optionalArray(effective, 'plugin', '/config/plugin')
  if (expectedPlugins.length > 0) fail('/config/plugin/0')
  if (effectivePlugins.length > 0) fail('/config/plugin/0')

  const controlledNames = Object.keys(controlledEntries).sort(compareCodePoints)
  if (!controlledNames.includes(input.selectedAgentName)) {
    fail(childPath('/agent', input.selectedAgentName))
  }

  const firstRegistry = verifyAgentInfos(
    input.agents,
    controlledEntries,
    expected.permission,
    input.permissionHome,
    'execution-identity-mismatch',
  )
  const firstSeal = buildAgentRegistrySeal(firstRegistry)

  if (input.secondAgents !== undefined) {
    const secondRegistry = verifyAgentInfos(
      input.secondAgents,
      controlledEntries,
      expected.permission,
      input.permissionHome,
      'execution-identity-instance-changed',
    )
    const secondSeal = buildAgentRegistrySeal(secondRegistry)
    const difference = firstDifferenceValidated(firstSeal, secondSeal, '/agent')
    if (difference !== null) fail(difference, 'execution-identity-instance-changed')
  }

  const configProof: IdentityJson = {
    ...securityProof,
    agent: controlledEntries,
    mcp: expectedMcp,
    permission: expectedPermission,
    plugin: [],
  }
  return {
    configDigest: identityDigest(configProof),
    agentInfoSeal: identityDigest(firstSeal),
    controlledAgentNames: controlledNames,
  }
}
