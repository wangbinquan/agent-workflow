import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { executionIdentityFailure } from './failure'
import { canonicalizeIdentity, type IdentityJson } from './executionIdentity'
import { assertOpencodeStoreUnlocked } from './storeHygiene'

export const PINNED_OPENCODE_VERSION = '1.18.3' as const
export const OPENCODE_FFF_CAPABILITY_CODEC = 1 as const
export const PINNED_BUILTIN_SKILL = Object.freeze({
  name: 'customize-opencode',
  description:
    "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.",
  location: '<built-in>',
  contentDigest: '6d22eed007626b08113c19a8837e2327e0af0bd3e75bfda9c3bfa07cf122e3eb',
})

export const PINNED_BUNDLED_PROVIDER_NPM = new Set([
  '@ai-sdk/amazon-bedrock',
  '@ai-sdk/amazon-bedrock/mantle',
  '@ai-sdk/anthropic',
  '@ai-sdk/azure',
  '@ai-sdk/google',
  '@ai-sdk/google-vertex',
  '@ai-sdk/google-vertex/anthropic',
  '@ai-sdk/openai',
  '@ai-sdk/openai-compatible',
  '@openrouter/ai-sdk-provider',
  '@ai-sdk/xai',
  '@ai-sdk/mistral',
  '@ai-sdk/groq',
  '@ai-sdk/deepinfra',
  '@ai-sdk/cerebras',
  '@ai-sdk/cohere',
  '@ai-sdk/gateway',
  '@ai-sdk/togetherai',
  '@ai-sdk/perplexity',
  '@ai-sdk/vercel',
  '@ai-sdk/alibaba',
  'gitlab-ai-provider',
  '@ai-sdk/github-copilot',
  'venice-ai-sdk-provider',
])

const PROVIDER_API_KEY_ENV: Readonly<Record<string, readonly string[]>> = Object.freeze({
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  xai: ['XAI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  groq: ['GROQ_API_KEY'],
  deepinfra: ['DEEPINFRA_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  cohere: ['COHERE_API_KEY'],
  gateway: ['AI_GATEWAY_API_KEY'],
  togetherai: ['TOGETHER_AI_API_KEY', 'TOGETHER_API_KEY'],
  perplexity: ['PERPLEXITY_API_KEY'],
  vercel: ['VERCEL_API_KEY'],
  alibaba: ['DASHSCOPE_API_KEY'],
  azure: ['AZURE_API_KEY'],
})

const SAFE_FORWARD_ENV = [
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const

const OPENCODE_FLAGS = Object.freeze({
  OPENCODE_PURE: '1',
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_AUTOCOMPACT: '1',
  OPENCODE_DISABLE_PRUNE: '1',
  OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1',
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
})

export interface StrictProviderAuth {
  providerID: string
  serialized: string
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function strictApiEntry(value: unknown): value is { type: 'api'; key: string } {
  if (!plainRecord(value)) return false
  const keys = Object.keys(value).sort()
  return (
    keys.length === 2 &&
    keys[0] === 'key' &&
    keys[1] === 'type' &&
    value.type === 'api' &&
    typeof value.key === 'string' &&
    value.key.length > 0 &&
    !value.key.includes('\0')
  )
}

/**
 * Upstream only JSON.parse()s OPENCODE_AUTH_CONTENT. Validate the exact single
 * selected-provider API credential locally before it can reach OpenCode.
 */
export function buildStrictProviderAuth(
  providerID: string,
  sourceEnv: Readonly<Record<string, string | undefined>>,
): StrictProviderAuth {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerID)) {
    return executionIdentityFailure('execution-identity-auth-invalid')
  }
  const inherited = sourceEnv.OPENCODE_AUTH_CONTENT
  if (inherited !== undefined && inherited !== '') {
    let decoded: unknown
    try {
      decoded = JSON.parse(inherited)
    } catch {
      return executionIdentityFailure('execution-identity-auth-invalid')
    }
    if (!plainRecord(decoded)) {
      return executionIdentityFailure('execution-identity-auth-invalid')
    }
    const keys = Object.keys(decoded)
    if (keys.length !== 1 || keys[0] !== providerID || !strictApiEntry(decoded[providerID])) {
      return executionIdentityFailure('execution-identity-auth-invalid')
    }
    return { providerID, serialized: JSON.stringify(decoded) }
  }

  const candidates = PROVIDER_API_KEY_ENV[providerID] ?? []
  const present = candidates
    .map((name) => ({ name, key: sourceEnv[name] }))
    .filter((entry): entry is { name: string; key: string } => {
      return typeof entry.key === 'string' && entry.key.length > 0
    })
  if (present.length !== 1 || present[0]!.key.includes('\0')) {
    return executionIdentityFailure('execution-identity-auth-invalid')
  }
  return {
    providerID,
    serialized: JSON.stringify({ [providerID]: { type: 'api', key: present[0]!.key } }),
  }
}

function within(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function ensurePrivateDirectory(root: string, path: string): Promise<string> {
  if (!isAbsolute(root) || !isAbsolute(path) || !within(root, path)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
  const resolvedRoot = await realpath(root)
  const resolvedPath = await realpath(path)
  if (!within(resolvedRoot, resolvedPath)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  let cursor = resolvedPath
  for (;;) {
    const metadata = await lstat(cursor)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    if (cursor === resolvedRoot) break
    const parent = join(cursor, '..')
    const resolvedParent = await realpath(parent)
    if (resolvedParent === cursor || !within(resolvedRoot, resolvedParent)) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    cursor = resolvedParent
  }
  await chmod(resolvedPath, 0o700)
  return resolvedPath
}

export interface HermeticOpencodeLayout {
  root: string
  home: string
  testHome: string
  managedConfig: string
  globalConfig: string
  testConfig: string
  explicitConfig: string
  xdgConfig: string
  xdgData: string
  xdgCache: string
  xdgState: string
  tmp: string
  sessionDbPath: string
  configRoots: readonly string[]
}

/**
 * Derive every path that contributes to the controlled OpenCode config without
 * touching the filesystem. Resume identity must be comparable with the frozen
 * owner before the persistent session store is opened or materialized.
 */
export function deriveHermeticOpencodeLayout(rootPath: string): HermeticOpencodeLayout {
  if (!isAbsolute(rootPath) || rootPath.includes('\0') || resolve(rootPath) !== rootPath) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const paths = {
    home: join(rootPath, 'home'),
    testHome: join(rootPath, 'test-home'),
    managedConfig: join(rootPath, 'managed-config'),
    xdgConfig: join(rootPath, 'xdg-config'),
    xdgData: join(rootPath, 'xdg-data'),
    xdgCache: join(rootPath, 'xdg-cache'),
    xdgState: join(rootPath, 'xdg-state'),
    explicitConfig: join(rootPath, 'explicit-config'),
    tmp: join(rootPath, 'tmp'),
  }
  const globalConfig = join(paths.xdgConfig, 'opencode')
  const testConfig = join(paths.testHome, '.opencode')
  return {
    root: rootPath,
    ...paths,
    globalConfig,
    testConfig,
    sessionDbPath: join(paths.xdgData, 'opencode', 'opencode.db'),
    configRoots: [globalConfig, testConfig, paths.explicitConfig],
  }
}

/** Materialize every v1.18.3 ConfigPaths root as a distinct private path. */
export async function prepareHermeticOpencodeLayout(
  rootPath: string,
): Promise<HermeticOpencodeLayout> {
  const derived = deriveHermeticOpencodeLayout(rootPath)
  const existing = await lstat(rootPath).catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? null : Promise.reject(error),
  )
  if (existing?.isSymbolicLink()) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  await mkdir(rootPath, { recursive: true, mode: 0o700 })
  await ensurePrivateDirectory(rootPath, rootPath)
  for (const path of [
    derived.home,
    derived.testHome,
    derived.managedConfig,
    derived.xdgConfig,
    derived.xdgData,
    derived.xdgCache,
    derived.xdgState,
    derived.explicitConfig,
    derived.tmp,
  ]) {
    await ensurePrivateDirectory(derived.root, path)
  }
  await ensurePrivateDirectory(derived.root, derived.globalConfig)
  await ensurePrivateDirectory(derived.root, derived.testConfig)
  const configRoots = [...derived.configRoots]
  if (new Set(await Promise.all(configRoots.map((path) => realpath(path)))).size !== 3) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  for (const configRoot of configRoots) {
    const gitignore = join(configRoot, '.gitignore')
    const existingGitignore = await lstat(gitignore).catch((error: NodeJS.ErrnoException) =>
      error.code === 'ENOENT' ? null : Promise.reject(error),
    )
    if (existingGitignore === null) {
      await writeFile(gitignore, '*\n!.gitignore\n', { flag: 'wx', mode: 0o400 })
    } else if (
      existingGitignore.isSymbolicLink() ||
      !existingGitignore.isFile() ||
      (existingGitignore.mode & 0o777) !== 0o400 ||
      (await readFile(gitignore, 'utf8')) !== '*\n!.gitignore\n'
    ) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    await chmod(configRoot, 0o500)
  }
  return {
    ...derived,
    configRoots,
  }
}

/**
 * Remove a layout after temporarily reopening the three deliberately sealed
 * config roots. `rm({recursive:true})` alone fails on POSIX because those
 * directories are 0500; cleanup must not silently strand auth/session data.
 * Symlinks are never followed.
 */
export async function removeHermeticOpencodeLayout(rootPath: string): Promise<void> {
  if (!isAbsolute(rootPath)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const root = await lstat(rootPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (root === null) return
  if (root.isSymbolicLink() || !root.isDirectory()) {
    await rm(rootPath, { force: true })
    return
  }
  // An unreaped launcher/server deliberately strands this lock. Parent-side
  // cleanup must preserve the store until boot recovery proves the prior
  // RFC-205 PID namespace is gone and removes the exact inode.
  await assertOpencodeStoreUnlocked(deriveHermeticOpencodeLayout(rootPath).sessionDbPath)
  const sealedRoots = [
    join(rootPath, 'xdg-config', 'opencode'),
    join(rootPath, 'test-home', '.opencode'),
    join(rootPath, 'explicit-config'),
  ]
  for (const path of sealedRoots) {
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (metadata?.isDirectory() === true && !metadata.isSymbolicLink()) {
      await chmod(path, 0o700)
    }
  }
  await chmod(rootPath, 0o700)
  await rm(rootPath, { recursive: true, force: true })
}

export interface HermeticServerEnvInput {
  layout: HermeticOpencodeLayout
  providerID: string
  auth: StrictProviderAuth
  config: IdentityJson
  username?: string
  password?: string
  sourceEnv?: Readonly<Record<string, string | undefined>>
}

export function buildHermeticServerEnv(input: HermeticServerEnvInput): Record<string, string> {
  if (input.auth.providerID !== input.providerID) {
    return executionIdentityFailure('execution-identity-auth-invalid')
  }
  const source = input.sourceEnv ?? process.env
  const env: Record<string, string> = {}
  for (const key of SAFE_FORWARD_ENV) {
    const value = source[key]
    if (typeof value === 'string' && value !== '' && !value.includes('\0')) env[key] = value
  }
  Object.assign(env, OPENCODE_FLAGS)
  env.PATH = '/usr/bin:/bin'
  env.HOME = input.layout.home
  env.PWD = input.layout.root
  env.TMPDIR = input.layout.tmp
  env.XDG_CONFIG_HOME = input.layout.xdgConfig
  env.XDG_DATA_HOME = input.layout.xdgData
  env.XDG_CACHE_HOME = input.layout.xdgCache
  env.XDG_STATE_HOME = input.layout.xdgState
  env.OPENCODE_CONFIG_DIR = input.layout.explicitConfig
  env.OPENCODE_TEST_HOME = input.layout.testHome
  env.OPENCODE_TEST_MANAGED_CONFIG_DIR = input.layout.managedConfig
  // Validate with the canonical identity walker, but do not send its
  // key-sorted serialization to OpenCode. Permission object insertion order
  // is converted into the ordered Agent.Info rule tail by v1.18.3, so sorting
  // here can move the wildcard external_directory deny ahead of the exact
  // Truncate.GLOB deny and change the effective execution policy.
  canonicalizeIdentity(input.config)
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(input.config)
  env.OPENCODE_AUTH_CONTENT = input.auth.serialized
  env.OPENCODE_SERVER_USERNAME = input.username ?? `aw-${randomBytes(12).toString('base64url')}`
  env.OPENCODE_SERVER_PASSWORD = input.password ?? randomBytes(32).toString('base64url')
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  return env
}

const DENIED_TOOLS = [
  'read',
  'edit',
  'write',
  'apply_patch',
  'grep',
  'glob',
  'skill',
  'task',
  'webfetch',
  'websearch',
  'lsp',
] as const

export interface BuildControlledAgentConfigInput {
  name: string
  prompt: string
  description: string
  model: string
  variant?: string | null
  temperature?: number | null
  steps?: number | null
  options?: Record<string, IdentityJson>
  userPermission?: Record<string, IdentityJson>
  toolOutputPattern: string
  shellPath: string
  allowShell: boolean
  mcp?: Record<string, IdentityJson>
}

/**
 * Construct the only raw config shape the verified launcher admits. Property
 * insertion order in permission is load-bearing and is checked through
 * Agent.Info, not merely the /config object.
 */
export function buildControlledOpencodeConfig(
  input: BuildControlledAgentConfigInput,
): Record<string, IdentityJson> {
  if (
    input.name.length === 0 ||
    input.model.length === 0 ||
    !isAbsolute(input.shellPath) ||
    !isAbsolute(input.toolOutputPattern)
  ) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  const permission: Record<string, IdentityJson> = { ...(input.userPermission ?? {}) }
  permission.bash = input.allowShell ? 'allow' : 'deny'
  for (const tool of DENIED_TOOLS) permission[tool] = 'deny'
  permission.external_directory = {
    [input.toolOutputPattern]: 'deny',
    '*': 'deny',
  }

  const agent: Record<string, IdentityJson> = {
    prompt: input.prompt,
    description: input.description,
    model: input.model,
    mode: 'primary',
    hidden: false,
    permission,
    options: input.options ?? {},
  }
  if (input.variant != null && input.variant !== '') agent.variant = input.variant
  if (input.temperature != null) agent.temperature = input.temperature
  if (input.steps != null) agent.steps = input.steps

  return {
    share: 'disabled',
    autoupdate: false,
    snapshot: false,
    formatter: false,
    lsp: false,
    instructions: [],
    skills: { paths: [], urls: [] },
    // OPENCODE_DISABLE_PRUNE materializes as `prune:false` in the pinned
    // v1.18.3 /config response. Keep it in the frozen raw config too so the
    // same-instance comparator proves the complete effective value instead of
    // accepting an upstream-added field.
    compaction: { auto: false, prune: false },
    shell: input.shellPath,
    plugin: [],
    mcp: input.mcp ?? {},
    permission: {
      question: 'deny',
      plan_enter: 'deny',
      plan_exit: 'deny',
    },
    agent: { [input.name]: agent },
  }
}

export function assertBundledProviderImplementation(npm: string): void {
  if (!PINNED_BUNDLED_PROVIDER_NPM.has(npm)) {
    return executionIdentityFailure('execution-identity-provider-untrusted')
  }
}
