// RFC-143 closeout (2026-07-31) — the OpenCode model-enumeration capability.
//
// This was inline in `routes/runtime.ts` behind a `kind !== 'opencode'` branch
// (the last runtime-kind discriminator outside the drivers). Enumeration is a
// capability, not a routing concern: `models` still initializes OpenCode's
// whole configuration stack, so a byte-frozen executable alone is
// insufficient — it must run from a private source-guarded cwd with every
// config/auth root redirected, and the source fingerprint must be unchanged
// before a fresh result may enter the cache. All of that now lives with the
// driver that needs it; the route just calls `driver.listModels`.

import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { ListModelsOpts, RuntimeModelList } from '../types'
import { listOpencodeModels, opencodeModelsCacheKey } from '@/util/opencode-models'
import { loadConfig } from '@/config'
import { Paths } from '@/util/paths'
import { buildEnumerationProviderSection, customProvidersProjection } from './customProvider'
import type { IdentityJson } from './executionIdentity'
import { machineConfigEnvOverrides } from './hermetic'
import { withRuntimeOpencodeSnapshot } from './runtimeBinary'
import { assertSourceFingerprintUnchanged, scanOpencodeProjectSurface } from './sourceGuard'

export async function listOpencodeModelsHermetic(
  binary: string,
  opts: ListModelsOpts = {},
): Promise<RuntimeModelList> {
  const refresh = opts.refresh === true
  // Production: the real byte-frozen seal. Tests may inject a stand-in via the
  // explicit seam (the route threads its AppDeps override) — the hermetic
  // layout, source guard and cache fence below stay identical either way.
  const withSnapshot = opts.testOnlySnapshot ?? withRuntimeOpencodeSnapshot
  return withSnapshot([binary], async (snapshot) => {
    const root = dirname(snapshot)
    const home = join(root, 'home')
    const cwd = join(root, 'cwd')
    const tmp = join(root, 'tmp')
    const xdgConfig = join(root, 'xdg-config')
    const xdgData = join(root, 'xdg-data')
    const xdgCache = join(root, 'xdg-cache')
    const xdgState = join(root, 'xdg-state')
    const explicitConfig = join(root, 'explicit-config')
    const testHome = join(root, 'test-home')
    const managedConfig = join(root, 'managed-config')
    await Promise.all(
      [
        home,
        cwd,
        tmp,
        xdgConfig,
        xdgData,
        xdgCache,
        xdgState,
        explicitConfig,
        testHome,
        managedConfig,
      ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
    )
    // `models` still initializes OpenCode's configuration stack. An
    // frozen executable alone is therefore insufficient: run it from a
    // private source-guarded cwd with every config/auth root redirected,
    // so a repo/V2 plugin or host account cannot execute during inventory.
    // RFC-255: administrator-configured gateways must appear in every model
    // picker. Enumeration is measured to list config-defined providers with no
    // credential present, so the section injected here carries display names
    // but never a key — the enumeration surface stays credential-free.
    const cfg = (opts.loadCustomProviderConfig ?? (() => loadConfig(Paths.config)))()
    const inheritMachineConfig =
      (cfg as { inheritMachineOpencodeConfig?: unknown }).inheritMachineOpencodeConfig !== false
    // The catalog probe supplies its own single-entry section and must not be
    // answered from (or written into) the configured-gateway cache slot.
    const probing = opts.injectedProviderSection !== undefined
    const providerSection = probing
      ? (opts.injectedProviderSection as Record<string, IdentityJson>)
      : buildEnumerationProviderSection(cfg)
    const hasCustomProviders = Object.keys(providerSection).length > 0
    const sourceBefore = await scanOpencodeProjectSurface(cwd)
    const result = await listOpencodeModels(snapshot, {
      refresh,
      // The projection joins the key so an edit to any gateway invalidates the
      // cached list; a key rotation deliberately leaves it unchanged.
      cacheKey: opencodeModelsCacheKey(
        binary,
        probing ? `probe:${JSON.stringify(providerSection)}` : customProvidersProjection(cfg),
      ),
      cwd,
      env: {
        ...(hasCustomProviders
          ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: providerSection }) }
          : {}),
        PATH: '/usr/bin:/bin',
        HOME: home,
        TMPDIR: tmp,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_CACHE_HOME: xdgCache,
        XDG_STATE_HOME: xdgState,
        OPENCODE_CONFIG_DIR: explicitConfig,
        OPENCODE_TEST_HOME: testHome,
        OPENCODE_TEST_MANAGED_CONFIG_DIR: managedConfig,
        OPENCODE_AUTH_CONTENT: '{}',
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
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        // RFC-256: the probe is the surface an operator judges "does the
        // platform see my models" by. Sealed off, it reports an empty catalog
        // for every model declared in the machine's own opencode.json — which
        // is what made the pickers go blank after RFC-224. Repository config
        // stays disabled above; only the operator's global roots come back.
        ...(inheritMachineConfig ? machineConfigEnvOverrides(process.env) : {}),
      },
      beforeCacheWrite: async () => {
        const sourceAfter = await scanOpencodeProjectSurface(cwd)
        assertSourceFingerprintUnchanged(sourceBefore, sourceAfter)
      },
    })
    return result
  })
}
