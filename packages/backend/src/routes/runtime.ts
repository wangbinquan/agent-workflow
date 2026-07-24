// RFC-001 + RFC-111: model lists for Settings → Runtime.
// Mounted under /api/* — token auth applied by server.ts.
//
// RFC-135: the two legacy single-runtime probes (GET /api/runtime/opencode +
// /api/runtime/claude) were removed — the homepage hero (their last consumer)
// now reads the registry-wide GET /api/runtimes/status in routes/runtimes.ts.

import type { Hono } from 'hono'
import {
  isExecutionIdentityFailureCode,
  type ExecutionIdentityFailureCode,
} from '@agent-workflow/shared'
import { loadConfig } from '@/config'
import type { AppDeps } from '@/server'
import { parseBoolQuery } from '@/util/http'
import { getRuntimeDriver, type RuntimeKind } from '@/services/runtime'
import { resolveRuntimeByName } from '@/services/runtimeRegistry'
import { redactSensitiveString } from '@/util/redact'
import { withRuntimeOpencodeSnapshot as productionRuntimeOpencodeSnapshot } from '@/services/runtime/opencode/runtimeBinary'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import {
  assertSourceFingerprintUnchanged,
  scanOpencodeProjectSurface,
} from '@/services/runtime/opencode/sourceGuard'
import { ExecutionIdentityFailure } from '@/services/runtime/opencode/failure'

function safeExecutionIdentityRouteFailure(error: unknown): {
  code: ExecutionIdentityFailureCode
  message: string
} | null {
  const code = executionIdentityCode(error)
  if (code === null) return null
  const pointer = error instanceof ExecutionIdentityFailure ? error.pointer : null
  return {
    code,
    message: pointer === null || pointer === '' ? code : `${code} at ${pointer}`,
  }
}

function executionIdentityCode(error: unknown): ExecutionIdentityFailureCode | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return isExecutionIdentityFailureCode(code) ? code : null
}

export function mountRuntimeRoutes(app: Hono, deps: AppDeps): void {
  const withRuntimeOpencodeSnapshot =
    deps.runtimeDiagnosticTestDependencies?.withRuntimeOpencodeSnapshot ??
    productionRuntimeOpencodeSnapshot

  app.get('/api/runtime/models', async (c) => {
    const cfg = loadConfig(deps.configPath)
    // RFC-114: `?runtime=<name>` lists models for THAT runtime's binary (a custom
    // opencode fork no longer shows the default opencode's models). Resolve the
    // registered runtime FIRST; the legacy `claude`/`claude-code` alias only
    // applies when no runtime is named that (Codex P1-1 — else a runtime literally
    // named `claude` would be hijacked into the static list). No `?runtime=` /
    // unknown name → default opencode (byte-identical to pre-RFC-114).
    const rtParam = c.req.query('runtime')
    const resolved =
      rtParam !== undefined && rtParam.length > 0
        ? await resolveRuntimeByName(deps.db, rtParam)
        : null
    // resolveRuntimeByName fail-safes unknown names to the opencode built-in, so a
    // real match is `resolved.name === rtParam`; the bare alias is when it didn't.
    const matchedReal = resolved !== null && resolved.name === rtParam
    const resolvedBinary = matchedReal ? resolved.binaryPath : null
    // RFC-143: resolve the runtime KIND (name resolution stays here — a routing
    // concern), then let its driver produce the model list (opencode: CLI+cache;
    // claude: static table incl. the provider/modelID defaults, now in the
    // driver). `resolved.protocol` is already the kind; the bare `claude` /
    // `claude-code` alias (RFC-114 Codex P1-1) maps when no runtime matched.
    const kind: RuntimeKind = matchedReal
      ? resolved.protocol
      : rtParam === 'claude' || rtParam === 'claude-code'
        ? 'claude-code'
        : 'opencode'
    const driver = getRuntimeDriver(kind)
    const binary = resolvedBinary ?? driver.defaultBinary(cfg)[0]!
    const refresh = parseBoolQuery(c, 'refresh', { default: false })
    try {
      if (kind !== 'opencode') {
        return c.json(await driver.listModels(binary, { refresh }))
      }
      const listed = await withRuntimeOpencodeSnapshot([binary], async (snapshot) => {
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
        const sourceBefore = await scanOpencodeProjectSurface(cwd)
        const result = await driver.listModels(snapshot, {
          refresh,
          cacheKey: binary,
          cwd,
          env: {
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
          },
          beforeCacheWrite: async () => {
            const sourceAfter = await scanOpencodeProjectSurface(cwd)
            assertSourceFingerprintUnchanged(sourceBefore, sourceAfter)
          },
        })
        return result
      })
      return c.json({ ...listed, binary })
    } catch (err) {
      const identityFailure = safeExecutionIdentityRouteFailure(err)
      if (identityFailure !== null) {
        // RFC-224: preserve the stable closed-vocabulary code while refusing to
        // reflect an arbitrary Error.message. Only ExecutionIdentityFailure's
        // constructor-validated JSON Pointer may accompany the code.
        return c.json(
          {
            ok: false,
            ...identityFailure,
            runtime: rtParam ?? null,
          },
          502,
        )
      }
      // Codex P2-4: the message can carry the fork's raw stderr → redact before
      // it reaches the client.
      return c.json(
        {
          ok: false,
          code: 'opencode-models-failed',
          message: redactSensitiveString((err as Error).message),
          runtime: rtParam ?? null,
        },
        502,
      )
    }
  })
}
