# `@agent-workflow/system-mocks`

This private workspace package is the single deterministic source for external
infrastructure used by system E2E tests. Production packages must never import
it or expose a switch that enables it.

That boundary is fail-closed in two places: the package test verifies private
and dev-only manifest placement plus direct package references, while
`bun run depcheck` rejects every resolved dependency edge from production
backend/frontend/shared sources into this directory, including relative-path
imports.

## Layout

| Directory            | External boundary                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/runtime/`       | Compiled OpenCode/Claude Code model-runtime stand-in and all `AW_STUB_MODE` behaviours                                             |
| `src/git/`           | Real Git smart-HTTP CGI, including fetch and receive-pack                                                                          |
| `src/code-host/`     | Stateful GitLab/GitHub REST APIs, real diffs, comments/reviews/issues/pipelines, fork-safe MR/PR refs, and signed webhook delivery |
| `src/external-http/` | Ordered HTTP responses for company-specific CI, issue-routing, document and other script adapters                                  |
| `src/oauth/`         | Independent OAuth 2.0 issuer with Authorization Code + PKCE, access tokens, refresh, introspection, revocation, and userinfo       |
| `src/oidc/`          | Independent OIDC issuer with discovery, JWKS, signed ID-token or userinfo identity, Authorization Code + PKCE, refresh, and logout |
| `src/mcp/`           | MCP Streamable HTTP, legacy SSE fallback, and compiled stdio server                                                                |
| `src/registry/`      | Installable npm tarballs and PyPI wheels served through the native registry protocols                                              |
| `src/plantuml/`      | The three PlantUML renderer request shapes consumed by the daemon                                                                  |
| `src/scip/`          | One executable compatible with every configured SCIP indexer argv shape                                                            |
| `src/core/`          | Shared request journal, bounded body parsing, process discipline, and deterministic fault injection                                |

## Playwright lifecycle

`e2e/global-setup.ts` starts one HTTP gateway on an ephemeral loopback port and
exports its endpoint inventory plus the authenticated control URL/token to all
workers. Specs use `SystemMockClient` to seed state, inject a bounded fault,
emit a provider-signed webhook, reset state, or inspect what the compiled daemon
actually sent.

```ts
const mocks = new SystemMockClient(
  process.env.AW_SYSTEM_MOCK_CONTROL_URL!,
  process.env.AW_SYSTEM_MOCK_CONTROL_TOKEN!,
)
await mocks.seedCodeHost({ provider: 'github', projectPath: 'team/repo' })
await mocks.mutateCodeHost({
  kind: 'advance-head',
  provider: 'github',
  projectPath: 'team/repo',
  files: { 'src/new.ts': 'export const value = 1\n' },
})
await mocks.seedHttpRoute({
  path: '/ci/runs/42',
  responses: [{ status: 503 }, { json: { state: 'failed' } }],
})
await mocks.addFault({
  service: 'github',
  pathPrefix: '/github/api/v3/user',
  status: 503,
  times: 1,
})
expect(await mocks.requests('github')).not.toHaveLength(0)
```

## Code-host state contract

One seeded project owns one real bare repository and provider state. The same
head SHA is exposed through smart HTTP, `mr.get`, provider diff APIs, webhooks,
and `refs/merge-requests/<iid>/head` or `refs/pull/<number>/head`. A real Git
push or `mutateCodeHost({ kind: 'advance-head', ... })` advances all of them.
Fork PR creation imports the source commit into the target object database, so
the target special ref remains fetchable even when the contributor branch is
not present there.

The REST surface keeps draft notes, published discussions/review comments,
overview comments, issue labels/comments, pipeline jobs and logs in state.
Consequently RFC-304 recovery tests can read back exactly what an earlier write
left behind rather than receiving canned empty arrays. Webhook delivery mutates
that same state before emitting the provider-shaped event and applies the real
GitLab token or GitHub HMAC signature.

`externalHttpBaseUrl` is intentionally protocol-neutral. Route responses are
consumed in order, can become exhausted, participate in request journaling and
fault injection, and are reset by the same suite lifecycle. This is the mock
boundary for adapters whose upstream protocol is supplied by a user script
rather than by the platform.

`bun run build:binary:e2e` also builds two cross-platform artifacts:

- `stub-opencode-<platform>` — the runtime dispatcher.
- `system-mock-tool-<platform>` — SCIP by default; `mcp-stdio` as its first
  argument selects the MCP stdio server.

The package test suite drives the gateway with real Git, GitLab/GitHub request
shapes, MCP, npm and pip clients. The RFC-304 backend acceptance test runs its
real eight-stage review engine and production code-host client against this
gateway for both providers. `e2e/system-mocks.spec.ts` drives signed MR/issue
events and the same endpoints through the compiled daemon, plus a real browser
OIDC flow.

For an independent local process, run `bun run --filter
@agent-workflow/system-mocks start`. It prints the complete endpoint and control
environment as JSON, then stays alive until `SIGINT` or `SIGTERM`.
