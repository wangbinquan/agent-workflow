import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Plugin } from '@agent-workflow/shared'
import { executionIdentityFailure } from './failure'
import { canonicalizeIdentity, type IdentityJson } from './executionIdentity'
import { buildPluginSpecArray } from './pluginSpec'
import { assertOpencodeStoreUnlocked } from './storeHygiene'
import { NULL_DEVICE_FOR_HOST, buildControlledPathForHost } from '@/util/platformExec'
import { assertSameFileIdentityForHost } from '@/util/fileTrust'

export const OPENCODE_FFF_CAPABILITY_CODEC = 1 as const
export const PINNED_BUILTIN_SKILL = Object.freeze({
  name: 'customize-opencode',
  description:
    "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.",
  location: '<built-in>',
  /**
   * Known-verified bodies of the ONE built-in skill, newest first.
   *
   * Upstream edits this document between releases (1.18.8 rewrote it wholesale
   * while leaving name/description/location byte-identical). A single frozen
   * digest therefore contradicts RFC-227's version-neutral admission: every
   * user on the newer release would fail `execution-identity-skill-mismatch`
   * on EVERY verified run — the nightly `opencode latest` leg caught exactly
   * that on 2026-07-28.
   *
   * The boundary is unchanged in kind: exactly one skill, exact key set, exact
   * name/description/location, and a body whose bytes we have reviewed. An
   * unknown body still fails closed — adding an entry here is a deliberate act
   * that means "these bytes were diffed against the previous release".
   */
  contentDigests: Object.freeze([
    // opencode 1.18.8 (verified 2026-07-28: body rewrite only; identity fields
    // byte-identical to the 1.18.3 entry below).
    'f83e8f42cd3f1422656a9725357b6dca24ee8af4582905d03da97ffb999db11e',
    // opencode 1.17.x–1.18.4.
    '6d22eed007626b08113c19a8837e2327e0af0bd3e75bfda9c3bfa07cf122e3eb',
  ] as readonly string[]),
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

const MAX_NATIVE_AUTH_BYTES = 1024 * 1024

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

// RFC-251: OPENCODE_PURE is NOT in this table — it is derived per-run from the
// controlled config (see buildHermeticServerEnv). Every flag here is
// unconditional.
//
// OPENCODE_DISABLE_DEFAULT_PLUGINS stays unconditional on purpose: it gates
// opencode's own `internalPlugins` (plugin/index.ts:166), which is a different
// axis from the operator's selected plugins (`cfg.plugin_origins`, :177).
const OPENCODE_FLAGS = Object.freeze({
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

export interface ResolveStrictProviderAuthOptions {
  /** Test seam; production resolves OpenCode's outer Global.Path.data/auth.json. */
  nativeAuthPath?: string
  /** Test seam for the xdg-basedir fallback when XDG_DATA_HOME is absent. */
  home?: string
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
  nativeAuthContent?: string,
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
  if (present.length > 0) {
    if (present.length !== 1 || present[0]!.key.includes('\0')) {
      return executionIdentityFailure('execution-identity-auth-invalid')
    }
    return {
      providerID,
      serialized: JSON.stringify({ [providerID]: { type: 'api', key: present[0]!.key } }),
    }
  }

  if (nativeAuthContent === undefined) {
    return executionIdentityFailure('execution-identity-auth-invalid')
  }
  let nativeAuth: unknown
  try {
    nativeAuth = JSON.parse(nativeAuthContent)
  } catch {
    return executionIdentityFailure('execution-identity-auth-invalid')
  }
  if (!plainRecord(nativeAuth) || !strictApiEntry(nativeAuth[providerID])) {
    return executionIdentityFailure('execution-identity-auth-invalid')
  }
  return {
    providerID,
    // The outer file may contain many providers. Only the selected provider's
    // already-validated API entry crosses into the hermetic child.
    serialized: JSON.stringify({ [providerID]: nativeAuth[providerID] }),
  }
}

/**
 * Mirror OpenCode's Global.Path.data (`xdg-basedir` + `opencode/auth.json`).
 * xdg-basedir uses ~/.local/share on every supported OS when XDG_DATA_HOME is
 * absent; there is deliberately no Agent Workflow platform admission gate.
 */
export function resolveNativeOpencodeAuthPath(
  sourceEnv: Readonly<Record<string, string | undefined>>,
  home = homedir(),
): string {
  const configuredData = sourceEnv.XDG_DATA_HOME
  const dataRoot =
    typeof configuredData === 'string' && configuredData !== ''
      ? configuredData
      : join(home, '.local', 'share')
  if (dataRoot.includes('\0') || !isAbsolute(dataRoot) || resolve(dataRoot) !== dataRoot) {
    return executionIdentityFailure('execution-identity-auth-invalid')
  }
  return join(dataRoot, 'opencode', 'auth.json')
}

function sameOpenedFile(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean {
  // Identity via the shared primitive (RFC-254 T0b); size/mtime/ctime stay
  // here because this helper's contract is "utterly unchanged", which is
  // stricter than identity alone.
  return (
    assertSameFileIdentityForHost(before, after).trusted &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  )
}

async function readNativeOpencodeAuth(path: string): Promise<string | undefined> {
  if (path.includes('\0') || !isAbsolute(path) || resolve(path) !== path) {
    return executionIdentityFailure('execution-identity-auth-invalid')
  }
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    return executionIdentityFailure('execution-identity-auth-invalid')
  })
  if (before === null) return undefined
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size <= 0 ||
    before.size > MAX_NATIVE_AUTH_BYTES
  ) {
    return executionIdentityFailure('execution-identity-auth-invalid')
  }

  const handle = await open(path, 'r').catch(() =>
    executionIdentityFailure('execution-identity-auth-invalid'),
  )
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameOpenedFile(before, opened)) {
      return executionIdentityFailure('execution-identity-auth-invalid')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (
      bytes.byteLength !== before.size ||
      bytes.byteLength > MAX_NATIVE_AUTH_BYTES ||
      !sameOpenedFile(before, after)
    ) {
      return executionIdentityFailure('execution-identity-auth-invalid')
    }
    return bytes.toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Resolve the selected provider credential without exposing OpenCode's whole
 * native auth store. Explicit daemon env keeps its established precedence;
 * the native store is only a fallback for a normal `opencode auth login`.
 */
export async function resolveStrictProviderAuth(
  providerID: string,
  sourceEnv: Readonly<Record<string, string | undefined>>,
  options: ResolveStrictProviderAuthOptions = {},
): Promise<StrictProviderAuth> {
  const inherited = sourceEnv.OPENCODE_AUTH_CONTENT
  const providerEnvPresent = (PROVIDER_API_KEY_ENV[providerID] ?? []).some((name) => {
    const value = sourceEnv[name]
    return typeof value === 'string' && value.length > 0
  })
  if ((inherited !== undefined && inherited !== '') || providerEnvPresent) {
    return buildStrictProviderAuth(providerID, sourceEnv)
  }

  const nativeAuthPath =
    options.nativeAuthPath ?? resolveNativeOpencodeAuthPath(sourceEnv, options.home)
  const nativeAuthContent = await readNativeOpencodeAuth(nativeAuthPath)
  return buildStrictProviderAuth(providerID, sourceEnv, nativeAuthContent)
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

/** Materialize every config-discovery root owned by the behavior codec. */
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
  /**
   * The selected provider's credential, or undefined to let OpenCode resolve
   * one itself from the operator's own configuration (RFC-256). Undefined is
   * only produced when machine-config inheritance is on and no platform
   * channel supplied a key — a provider declared in the operator's
   * `opencode.json` with an inline `apiKey` needs no auth store at all.
   */
  auth?: StrictProviderAuth
  config: IdentityJson
  username?: string
  password?: string
  sourceEnv?: Readonly<Record<string, string | undefined>>
  /**
   * RFC-256 — expose the operator's own global OpenCode config directories to
   * this process. Repository config stays blocked either way; see
   * `machineConfigEnvOverrides` for exactly which variables change.
   */
  inheritMachineConfig?: boolean
}

/**
 * RFC-256 — the env delta that makes a sealed OpenCode process read the
 * operator's own global configuration.
 *
 * Deliberately narrow. OpenCode discovers global config through
 * `XDG_CONFIG_HOME` (→ `<xdg>/opencode`) and `OPENCODE_TEST_HOME`
 * (→ `$HOME/.opencode`), and discovers REPOSITORY config through a separate
 * switch (`OPENCODE_DISABLE_PROJECT_CONFIG`, opencode `config/paths.ts:23-40`).
 * Restoring the first two therefore brings back "the models I configured on
 * this machine" without bringing back "any repo I clone can configure my
 * agents".
 *
 * Data, state and cache roots stay private on purpose: the session database
 * lives under `XDG_DATA_HOME`, and platform session ownership, store locking
 * and resume are all built on it being per-chain.
 *
 * `OPENCODE_PURE` is dropped as well — it empties `plugin_origins` before any
 * external plugin loads, so leaving it on would silently ignore plugins the
 * operator declared in that very config.
 */
/**
 * RFC-256 — does the operator's own OpenCode config declare plugins that this
 * platform will NOT load?
 *
 * Machine-config inheritance restores config discovery but keeps
 * `OPENCODE_PURE` on, so `plugin_origins` is emptied before any external plugin
 * loads (opencode `plugin/index.ts:177`). That is a deliberate scope limit, but
 * a limit the operator cannot see: OpenCode reports no error, it simply runs
 * without them. This predicate lets the caller say so out loud.
 *
 * Returns the declared plugin count, or 0 when the file is absent/unreadable/
 * malformed — this is a diagnostic, never a gate.
 */
export function machineConfigDeclaredPluginCount(configDir: string): number {
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    try {
      const raw = readFileSync(join(configDir, name), 'utf8')
      // Tolerate JSONC line comments; a parse failure is OpenCode's to report.
      const parsed: unknown = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const plugin = (parsed as { plugin?: unknown }).plugin
        if (Array.isArray(plugin)) return plugin.length
      }
    } catch {
      // absent, unreadable or not JSON — nothing to report
    }
  }
  return 0
}

export function machineConfigEnvOverrides(
  sourceEnv: Readonly<Record<string, string | undefined>>,
  home = homedir(),
): Record<string, string> {
  const overrides: Record<string, string> = {}
  const realHome =
    typeof sourceEnv.HOME === 'string' && isAbsolute(sourceEnv.HOME) ? sourceEnv.HOME : home
  const configured = sourceEnv.XDG_CONFIG_HOME
  const xdgConfig =
    typeof configured === 'string' && configured !== '' && isAbsolute(configured)
      ? configured
      : join(realHome, '.config')
  if (!realHome.includes('\0') && isAbsolute(realHome)) {
    overrides.HOME = realHome
    overrides.OPENCODE_TEST_HOME = realHome
  }
  if (!xdgConfig.includes('\0') && isAbsolute(xdgConfig)) overrides.XDG_CONFIG_HOME = xdgConfig
  return overrides
}

/**
 * RFC-251 — does this controlled config actually select any plugin? Drives
 * OPENCODE_PURE so the flag and the config are always consistent by
 * construction. Defensive about shape: anything that is not a non-empty array
 * means "no plugins", i.e. keep the strictest flag.
 */
function configSelectsPlugins(config: IdentityJson): boolean {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return false
  const plugin = (config as { [key: string]: IdentityJson }).plugin
  return Array.isArray(plugin) && plugin.length > 0
}

export function buildHermeticServerEnv(input: HermeticServerEnvInput): Record<string, string> {
  if (input.auth !== undefined && input.auth.providerID !== input.providerID) {
    return executionIdentityFailure('execution-identity-auth-invalid')
  }
  if (input.auth === undefined && input.inheritMachineConfig !== true) {
    // A sealed process has no other place to get a credential from.
    return executionIdentityFailure('execution-identity-auth-invalid')
  }
  const source = input.sourceEnv ?? process.env
  const env: Record<string, string> = {}
  for (const key of SAFE_FORWARD_ENV) {
    const value = source[key]
    if (typeof value === 'string' && value !== '' && !value.includes('\0')) env[key] = value
  }
  Object.assign(env, OPENCODE_FLAGS)
  // RFC-251 — the load-bearing half of plugin support. `OPENCODE_PURE` empties
  // `cfg.plugin_origins` BEFORE any external plugin loads (opencode
  // plugin/index.ts:177), so leaving it on while the controlled config selects
  // plugins drops them SILENTLY: no error, no log, just a different plugin set
  // than the operator chose. Derived from the config itself rather than passed
  // in separately, so the env flag and the config can never disagree.
  // With no plugins selected this restores the historical PURE=1 exactly.
  if (!configSelectsPlugins(input.config)) env.OPENCODE_PURE = '1'
  // RFC-254 T12 / design gate P0-A: capability whitelist, platform-aware,
  // and on Windows it must carry the resolved git directory or the agent has
  // no `git` at all (see buildControlledPath).
  env.PATH = buildControlledPathForHost()
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
  // is converted into the ordered Agent.Info rule tail by the qualified
  // implementation, so sorting here can move the wildcard external_directory
  // deny ahead of the exact Truncate.GLOB deny and change effective policy.
  canonicalizeIdentity(input.config)
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(input.config)
  if (input.auth !== undefined) env.OPENCODE_AUTH_CONTENT = input.auth.serialized
  if (input.inheritMachineConfig === true) {
    // Applied AFTER the private layout so the operator's roots win.
    //
    // `OPENCODE_PURE` is deliberately LEFT ALONE. Clearing it would also load
    // plugins declared in that machine config, and a plugin runs inside the
    // OpenCode server process with no containment — a far larger step than
    // "read the models I configured". Providers need no plugin (the
    // openai-compatible SDK is bundled), so the restoration does not require
    // it. The cost is that a plugin declared there is ignored rather than
    // refused; `machineConfigPluginNotice` exists so that is reported, not
    // silent.
    Object.assign(env, machineConfigEnvOverrides(source))
  }
  env.OPENCODE_SERVER_USERNAME = input.username ?? `aw-${randomBytes(12).toString('base64url')}`
  env.OPENCODE_SERVER_PASSWORD = input.password ?? randomBytes(32).toString('base64url')
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = NULL_DEVICE_FOR_HOST
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

/**
 * RFC-234 §1.1 — the ONLY tools a system profile may flip to allow. A closed
 * subset of DENIED_TOOLS: read-only file access, nothing that writes, spawns,
 * or reaches the network. Everything else in the deny tail is untouchable by
 * construction (Codex design-gate P0-1 — no arbitrary permission pass-through).
 */
export const SYSTEM_READ_ONLY_TOOLS = ['read', 'grep', 'glob'] as const

/**
 * RFC-251 — permission keys the platform decides unconditionally. A user
 * override for any of these is dropped rather than merged, so the platform's
 * value is always the LAST rule for that key in the emitted record (OpenCode
 * resolves with `findLast`).
 */
const CONTROLLED_PERMISSION_KEYS: ReadonlySet<string> = new Set<string>([
  'bash',
  'external_directory',
  ...DENIED_TOOLS,
])
export type SystemReadOnlyTool = (typeof SYSTEM_READ_ONLY_TOOLS)[number]

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
  shellPath: string | null
  allowShell: boolean
  mcp?: Record<string, IdentityJson>
  /**
   * RFC-234 §1.1 — read-only tools to ALLOW instead of deny. Must be members
   * of SYSTEM_READ_ONLY_TOOLS; any other name is an identity failure, never a
   * silent allow. The deny-tail KEY SET AND INSERTION ORDER are unchanged —
   * only the values of the listed tools flip — so the ordered Agent.Info rule
   * tail keeps its qualified shape.
   */
  allowedReadOnlyTools?: readonly SystemReadOnlyTool[]
  /**
   * RFC-251 — the agent's selected plugin closure (union over the `dependsOn`
   * closure, already resolved by the runner). Encoded by the shared
   * `buildPluginSpecArray` so this path and the legacy inline path cannot
   * drift. Omitted/empty keeps the historical byte-identical `plugin: []`.
   *
   * NOTE: emitting plugins here is only half the contract — `OPENCODE_PURE`
   * must also be off, or opencode discards `plugin_origins` before loading
   * anything (see buildHermeticServerEnv).
   */
  plugins?: readonly Plugin[]
  /**
   * RFC-251 — the resolved `dependsOn` closure (BFS order, root excluded).
   * Each member is registered as a `mode: 'subagent'` entry so opencode's
   * `task` tool can reach it by name; the root's `task` permission is opened
   * only when this list is non-empty.
   *
   * Each member carries its OWN shell/permission surface rather than
   * inheriting the root's: opencode re-derives a child ruleset at spawn time
   * (`agent/subagent-permissions.ts:14`) that unions the PARENT session's deny
   * rules on top of whatever the subagent declares. A member that declared
   * nothing would therefore end up with every tool denied and be unable to do
   * any work at all.
   */
  dependents?: readonly ControlledSubagentInput[]
  /**
   * RFC-255 — the selected custom OpenAI-compatible provider's section, or
   * undefined when the run uses a built-in catalog provider.
   *
   * Only the SELECTED entry is admitted, mirroring how MCP admits only the
   * selected closure: a run must not carry endpoints it has no reason to reach.
   * The section itself is built by `customProvider.ts` (no key, no display
   * name) and lands in the frozen config, so the endpoint is part of the
   * execution identity while the credential is not.
   */
  customProvider?: Record<string, IdentityJson>
}

/**
 * RFC-251 — one `dependsOn` closure member as it enters the controlled config.
 * Deliberately mirrors the root's fields instead of reusing the platform
 * `Agent` row, so this module stays free of DB shapes and the caller does the
 * runtime-profile resolution (model/variant/temperature) exactly once.
 */
export interface ControlledSubagentInput {
  name: string
  prompt: string
  description: string
  model: string
  variant?: string | null
  temperature?: number | null
  steps?: number | null
  options?: Record<string, IdentityJson>
  userPermission?: Record<string, IdentityJson>
  allowShell: boolean
  allowedReadOnlyTools?: readonly SystemReadOnlyTool[]
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
    (input.shellPath !== null && !isAbsolute(input.shellPath)) ||
    !isAbsolute(input.toolOutputPattern)
  ) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  const dependents = input.dependents ?? []
  const buildPermission = (
    member: Pick<
      BuildControlledAgentConfigInput,
      'userPermission' | 'allowShell' | 'allowedReadOnlyTools'
    >,
    allowTask: boolean,
  ): Record<string, IdentityJson> => {
    const allowedReadOnly = new Set<string>(member.allowedReadOnlyTools ?? [])
    for (const tool of allowedReadOnly) {
      if (!(SYSTEM_READ_ONLY_TOOLS as readonly string[]).includes(tool)) {
        return executionIdentityFailure('execution-identity-mismatch')
      }
    }
    // RFC-251 (Codex impl-gate P1): platform-owned keys must be APPENDED after
    // everything the user supplied, never merged in place.
    //
    // OpenCode turns this record into an ordered ruleset and resolves a tool
    // with `findLast` (permission/index.ts:28-34). Re-assigning an existing key
    // does not move it, so the previous `{...userPermission}` + overwrite kept
    // a controlled key at the USER's position — a later `"*": "allow"` in the
    // same record would then win over it. Dropping the controlled keys first
    // and appending the platform values last makes the platform ruling final
    // regardless of what the user wrote, without changing the effective value
    // for any config that has no wildcard.
    const permission: Record<string, IdentityJson> = {}
    for (const [key, value] of Object.entries(member.userPermission ?? {})) {
      if (CONTROLLED_PERMISSION_KEYS.has(key)) continue
      permission[key] = value
    }
    permission.bash = member.allowShell ? 'allow' : 'deny'
    for (const tool of DENIED_TOOLS) {
      permission[tool] = allowedReadOnly.has(tool) ? 'allow' : 'deny'
    }
    // RFC-251 (Codex impl-gate P1): `task: 'allow'` would become pattern `*`,
    // letting the model delegate to OpenCode's BUILT-IN agents (general,
    // explore, …) which are in the registry regardless of our config and carry
    // their own default write/shell surface. Scope the allow to the resolved
    // closure instead: `*` denies first, each member name allows after it, and
    // `findLast` picks the specific name only for a real closure member.
    if (allowTask) {
      const byName: Record<string, IdentityJson> = { '*': 'deny' }
      for (const dep of allowedTaskTargets) byName[dep] = 'allow'
      permission.task = byName
    }
    permission.external_directory = {
      [input.toolOutputPattern]: 'deny',
      '*': 'deny',
    }
    return permission
  }

  const allowedTaskTargets = dependents
    .map((dep) => dep.name)
    .filter((name) => name.length > 0 && name !== input.name)
  const permission = buildPermission(input, allowedTaskTargets.length > 0)

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

  // RFC-251: register the closure so `task` can address each member by name.
  // opencode fails a task call with an unknown agent type outright
  // (tool/task.ts:131-134) — there is no silent fallback to a default agent.
  const agents: Record<string, IdentityJson> = { [input.name]: agent }
  for (const dep of dependents) {
    // The root must never be shadowed by a closure member, and resource names
    // are external keys — `constructor` is a legal agent name, so a prototype
    // lookup would mistake it for an existing entry and drop the member.
    if (dep.name === input.name) continue
    if (Object.hasOwn(agents, dep.name)) continue
    if (dep.name.length === 0 || dep.model.length === 0) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    const entry: Record<string, IdentityJson> = {
      prompt: dep.prompt,
      description: dep.description,
      model: dep.model,
      mode: 'subagent',
      hidden: false,
      // Never `allowTask` for a member: v1 does not do nested delegation, and
      // opencode independently denies `task` to any subagent that does not
      // declare it (agent/subagent-permissions.ts:25).
      permission: buildPermission(dep, false),
      options: dep.options ?? {},
    }
    if (dep.variant != null && dep.variant !== '') entry.variant = dep.variant
    if (dep.temperature != null) entry.temperature = dep.temperature
    if (dep.steps != null) entry.steps = dep.steps
    agents[dep.name] = entry
  }

  return {
    share: 'disabled',
    autoupdate: false,
    snapshot: false,
    formatter: false,
    lsp: false,
    instructions: [],
    skills: { paths: [], urls: [] },
    // OPENCODE_DISABLE_PRUNE materializes as `prune:false` in the qualified
    // /config response. Keep it in the frozen raw config too so the
    // same-instance comparator proves the complete effective value instead of
    // accepting an upstream-added field.
    compaction: { auto: false, prune: false },
    // RFC-254 T13: `null` means DO NOT DECLARE a shell. On Windows the sealed
    // sh wrapper does not exist (T14b — there is no shebang, and a .cmd shim
    // would re-tokenize arguments), so declaring a path to it would point
    // OpenCode at a missing file. Omitting the key instead lets OpenCode use
    // its own probe chain (pwsh -> powershell -> git-bash -> cmd), which is the
    // honest state on a platform with no child fence to enter anyway.
    ...(input.shellPath === null ? {} : { shell: input.shellPath }),
    // Plugin `options` is a DB-shaped Record<string, unknown>; the whole config
    // is validated as real JSON by canonicalizeIdentity downstream, so the
    // compile-time narrowing follows the same convention as the other
    // DB-sourced fields (e.g. agent outputs in verifiedPlan).
    plugin: buildPluginSpecArray(input.plugins ?? []) as unknown as IdentityJson,
    mcp: input.mcp ?? {},
    // RFC-255: absent for catalog providers, so a run that does not select a
    // custom gateway serializes byte-identically to before this key existed.
    ...(input.customProvider === undefined ? {} : { provider: input.customProvider }),
    permission: {
      question: 'deny',
      plan_enter: 'deny',
      plan_exit: 'deny',
    },
    agent: agents,
  }
}

export function assertBundledProviderImplementation(npm: string): void {
  if (!PINNED_BUNDLED_PROVIDER_NPM.has(npm)) {
    return executionIdentityFailure('execution-identity-provider-untrusted')
  }
}
