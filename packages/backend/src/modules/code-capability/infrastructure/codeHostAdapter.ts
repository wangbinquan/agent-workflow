// RFC-304 — the `CodeHostPort` implementation.
//
// Resolves the configured connection for a provider and hands the call to the
// platform's one code-host client, so capabilities inherit its retry policy,
// its compatibility fallbacks and its token redaction rather than growing a
// second, subtly-different HTTP path.
//
// One deliberate asymmetry with the scheduler's call site: `projectFallback` is
// wired to a REFUSAL. The scheduler supports "leave project blank and mean the
// task's repository", which is a convenience for a human filling in a node
// form. A capability always knows its project — it resolved one in
// `resolve-target` — so a call that reaches the fallback is a capability bug,
// and a fallback that silently guessed would send the request to whichever
// repository the task happens to sit in.

import type { DbClient } from '@/db/client'
import type { CodeHostProvider } from '@agent-workflow/shared'
import { executeCodeHostCall, type ProjectFallback } from '@/services/codeHost/call'
import {
  resolveCodeHostConnectionsFromKeyFile,
  type CodeHostConnectionsService,
  type FetchLike,
} from '@/services/codeHost/connections'
import { Paths } from '@/util/paths'
import type {
  CodeHostCall,
  CodeHostPort,
  CodeHostResult,
} from '@/modules/code-capability/ports/codeHostPort'

const CAPABILITY_SUPPLIES_PROJECT: ProjectFallback = {
  ok: false,
  code: 'code-host-project-unresolved',
  message:
    'a capability call reached the project fallback — capabilities resolve their own project in resolve-target, so this is a wiring bug rather than a configuration one',
}

export interface CodeHostAdapterDeps {
  db: DbClient
  provider: CodeHostProvider
  /** Injected in tests; production resolves from the secret key file. */
  connections?: CodeHostConnectionsService | null
  timeoutMs?: number
  /**
   * Mirrors `CodeHostCallDeps.fetchImpl` — the seam the client already exposes.
   * Typed as the client's own `FetchLike` rather than `typeof fetch`: Bun's
   * global carries a `preconnect` property that no test double has, and
   * demanding it would reject every stub for a reason unrelated to fetching.
   */
  fetchImpl?: FetchLike
}

export function createCodeHostAdapter(deps: CodeHostAdapterDeps): CodeHostPort {
  return {
    async call(call: CodeHostCall): Promise<CodeHostResult> {
      const connections =
        deps.connections ?? resolveCodeHostConnectionsFromKeyFile(deps.db, Paths.secretKeyFile)
      const connection = connections?.resolve(deps.provider) ?? null
      if (connection === null) {
        // Named separately from a call failure: nothing is wrong with the
        // request, and the fix is in Settings rather than in the round.
        return {
          ok: false,
          code: 'code-host-not-configured',
          message: `no ${deps.provider} connection is configured; set its base URL and token in Settings`,
        }
      }

      const outcome = await executeCodeHostCall(
        {
          provider: deps.provider,
          action: call.action,
          params: call.params,
          ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        },
        {
          connection,
          ctx: { ports: {} },
          projectFallback: CAPABILITY_SUPPLIES_PROJECT,
          ...(call.maxResponseBytes !== undefined
            ? { maxResponseBytes: call.maxResponseBytes }
            : {}),
          ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        },
      )

      return outcome.ok
        ? {
            ok: true,
            status: outcome.status,
            body: outcome.body,
            truncated: outcome.truncated,
          }
        : { ok: false, code: outcome.code, message: outcome.message }
    },
  }
}
