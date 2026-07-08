// RFC-001 + RFC-111: model lists for Settings → Runtime.
// Mounted under /api/* — token auth applied by server.ts.
//
// RFC-135: the two legacy single-runtime probes (GET /api/runtime/opencode +
// /api/runtime/claude) were removed — the homepage hero (their last consumer)
// now reads the registry-wide GET /api/runtimes/status in routes/runtimes.ts.

import type { Hono } from 'hono'
import { loadConfig } from '@/config'
import type { AppDeps } from '@/server'
import { parseBoolQuery } from '@/util/http'
import { getRuntimeDriver, type RuntimeKind } from '@/services/runtime'
import { resolveRuntimeByName } from '@/services/runtimeRegistry'
import { redactSensitiveString } from '@/util/redact'

export function mountRuntimeRoutes(app: Hono, deps: AppDeps): void {
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
      return c.json(await driver.listModels(binary, { refresh }))
    } catch (err) {
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
