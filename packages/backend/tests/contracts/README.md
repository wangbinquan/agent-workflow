# API contract suite (RFC-054 W1-2)

`packages/backend/tests/contracts/` is the data layer behind the two
contract test entry points:

- [`api-contract.test.ts`](../api-contract.test.ts) — drives the registry.
  For every entry, it (a) sends an anonymous request and asserts a 401 +
  canonical `ErrorResponse` body (unless the entry is `public: true`),
  and (b) if a `happy` fixture is declared, sends an authenticated request
  and validates the 2xx response against the declared Zod schema.
- [`api-contract-coverage.test.ts`](../api-contract-coverage.test.ts) —
  greps every `packages/backend/src/routes/*.ts` for `app.<verb>('...')`
  registrations and asserts that each method+path is also in
  `registry.ts ENDPOINTS`. New routes that land without a registry entry
  → CI red.

## Files

| Path                           | Role                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------ |
| [`harness.ts`](./harness.ts)   | `buildContractHarness()` — in-memory DB + seeded user/agent/workflow/task etc. |
| [`registry.ts`](./registry.ts) | `ENDPOINTS` — the table of every API endpoint + optional happy fixture.        |

## Adding a new route

When you mount a new route under `packages/backend/src/routes/*.ts`:

1. Add the entry to `registry.ts ENDPOINTS`. Minimum form:

   ```ts
   { method: 'POST', path: '/api/my-new-endpoint' },
   ```

   That alone gives you:
   - The 401 baseline (auth gate must work).
   - The coverage assertion (the route is registered).

2. **Recommended**: add a `happy: {...}` fixture so the suite also schema-
   validates a real 2xx response:

   ```ts
   {
     method: 'POST',
     path: '/api/my-new-endpoint',
     happy: {
       body: { foo: 'bar' },
       schema: z.object({ ok: z.literal(true), id: z.string() }).passthrough(),
     },
   }
   ```

   `body` can be a static value or a function that takes the harness
   (lets you reference seeded ids like `h.fixtures.taskId`). `pathParams`
   substitutes `:name` etc.; `query` adds `?k=v`; `headers` and `status`
   work the obvious way; `schema` defaults to a permissive `z.unknown()`
   but you should narrow it.

3. If your route is **public** (multiAuth bypasses it — `/health`,
   `/api/auth/login`, OIDC providers), mark it `public: true` so the 401
   test is skipped.

## Why a registry + coverage instead of decentralised route-level tests

Route-level tests still exist (and should keep being added). The contract
registry layer is on top of those:

- Catches "I added a new route but forgot to expose it" mistakes.
- Catches "I changed the error envelope shape" regressions at a single
  enforcement point instead of in N route tests.
- Reuses one harness for all 138 endpoints — cheap to add a new entry,
  no per-endpoint boilerplate beyond the spec line.

## Local maintenance

```sh
bun test packages/backend/tests/api-contract.test.ts \
         packages/backend/tests/api-contract-coverage.test.ts \
         packages/backend/tests/shared-no-any.test.ts
```

When the coverage test surfaces a missing endpoint, the failure message
prints the exact `method path (defined in <file>)` you need to copy into
`registry.ts`.

When a registry entry yields a 401 mismatch (e.g. the response body
changed), update `packages/shared/src/schemas/apiError.ts` plus the
`errorHandler` in `packages/backend/src/platform/errors/domainErrors.ts` together — the
two files are the canonical wire shape.

When a happy fixture's schema fails, the failure prints the actual body +
Zod errors. Decide whether the **schema** or the **handler** is the bug
and fix accordingly.
