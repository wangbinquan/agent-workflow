# `@agent-workflow/system-mocks`

This private workspace package is the single deterministic source for external
infrastructure used by system E2E tests. Production packages must never import
it or expose a switch that enables it.

## Layout

| Directory        | External boundary                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/runtime/`   | Compiled OpenCode/Claude Code model-runtime stand-in and all `AW_STUB_MODE` behaviours                                             |
| `src/git/`       | Real Git smart-HTTP CGI, including fetch and receive-pack                                                                          |
| `src/code-host/` | Stateful GitLab/GitHub REST APIs, real bare repositories, MR/PR special refs, and signed webhook delivery                          |
| `src/oauth/`     | Independent OAuth 2.0 issuer with Authorization Code + PKCE, access tokens, refresh, introspection, revocation, and userinfo       |
| `src/oidc/`      | Independent OIDC issuer with discovery, JWKS, signed ID-token or userinfo identity, Authorization Code + PKCE, refresh, and logout |
| `src/mcp/`       | MCP Streamable HTTP, legacy SSE fallback, and compiled stdio server                                                                |
| `src/registry/`  | Installable npm tarballs and PyPI wheels served through the native registry protocols                                              |
| `src/plantuml/`  | The three PlantUML renderer request shapes consumed by the daemon                                                                  |
| `src/scip/`      | One executable compatible with every configured SCIP indexer argv shape                                                            |
| `src/core/`      | Shared request journal, bounded body parsing, process discipline, and deterministic fault injection                                |

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
await mocks.addFault({
  service: 'github',
  pathPrefix: '/github/api/v3/user',
  status: 503,
  times: 1,
})
expect(await mocks.requests('github')).not.toHaveLength(0)
```

`bun run build:binary:e2e` also builds two cross-platform artifacts:

- `stub-opencode-<platform>` — the runtime dispatcher.
- `system-mock-tool-<platform>` — SCIP by default; `mcp-stdio` as its first
  argument selects the MCP stdio server.

The package test suite drives the gateway with real Git, MCP, npm and pip
clients. `e2e/system-mocks.spec.ts` drives the same endpoints through the
compiled daemon and a real browser OIDC flow.

For an independent local process, run `bun run --filter
@agent-workflow/system-mocks start`. It prints the complete endpoint and control
environment as JSON, then stays alive until `SIGINT` or `SIGTERM`.
