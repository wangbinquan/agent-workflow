// RFC-255 T1 — the wire contract for administrator-configured custom
// OpenAI-compatible providers.
//
// Why this test exists: RFC-224 sealed the verified execution path off from
// machine-level opencode config, which silently removed the only channel a
// custom baseURL gateway had (a production Linux deployment failed every run
// with `execution-identity-auth-invalid` until this RFC). The design gate then
// found three ways a naive re-introduction breaks:
//   P0-1 — a custom id equal to a catalog id does not create a provider, it
//          RE-POINTS the catalog one (18 anthropic models measured moving to
//          the gateway url). The sealed enumeration cannot supply the catalog
//          id set, so `RESERVED_PROVIDER_IDS` is a load-bearing snapshot.
//   P1-2 — the mask must stay a LEGAL wire value; rejecting it in the base
//          schema makes the frontend unable to parse its own GET response.
//   D13  — no URL normalization: admission compares the reported url
//          byte-for-byte, so two entries may legitimately differ by a slash.
// Each assertion below locks one of those.

import { describe, expect, test } from 'bun:test'
import {
  ConfigSchema,
  CustomProviderEntrySchema,
  CUSTOM_PROVIDER_API_KEY_MASK,
  CUSTOM_PROVIDER_NPM,
  DEFAULT_CONFIG,
  EXECUTION_IDENTITY_FAILURE_CODES,
  idsRequiringCatalogProbe,
  isPreservedApiKey,
  isReservedProviderId,
  isValidCustomProviderBaseURL,
  RESERVED_PROVIDER_IDS,
  validateCustomProviders,
} from '../src'

const base = {
  id: 'mygw',
  npm: CUSTOM_PROVIDER_NPM,
  baseURL: 'https://gw.internal.example/v1',
  apiKey: 'sk-real-value',
  models: [{ id: 'deepseek-v3' }, { id: 'qwen-max', name: 'Qwen Max' }],
  enabled: true,
}

const codes = (entries: unknown, known: ReadonlySet<string> = new Set()): string[] =>
  validateCustomProviders(entries, known).map((issue) => issue.code)

describe('RFC-255 custom provider wire schema', () => {
  test('accepts a well-formed entry and defaults to an empty list', () => {
    expect(CustomProviderEntrySchema.safeParse(base).success).toBe(true)
    expect(codes([base])).toEqual([])
    expect(DEFAULT_CONFIG.customProviders).toEqual([])
    const parsed = ConfigSchema.parse({ ...DEFAULT_CONFIG, customProviders: [base] })
    expect(parsed.customProviders[0]?.id).toBe('mygw')
  })

  test('the mask is a legal wire value — the frontend parses its own GET response', () => {
    const masked = { ...base, apiKey: CUSTOM_PROVIDER_API_KEY_MASK }
    expect(CustomProviderEntrySchema.safeParse(masked).success).toBe(true)
    // Known id ⇒ the mask means "keep stored", which is not an issue.
    expect(codes([masked], new Set(['mygw']))).toEqual([])
    // An omitted key is the same statement.
    const { apiKey: _omitted, ...withoutKey } = masked
    expect(codes([withoutKey], new Set(['mygw']))).toEqual([])
  })

  test('a new entry (or a renamed id) must carry a real key, never the mask', () => {
    expect(codes([{ ...base, apiKey: CUSTOM_PROVIDER_API_KEY_MASK }])).toEqual([
      'config-custom-provider-apikey-required',
    ])
    const { apiKey: _dropped, ...withoutKey } = base
    expect(codes([withoutKey])).toEqual(['config-custom-provider-apikey-required'])
    // Renaming is indistinguishable from creating: the old id's secret does not
    // follow the new one, so the mask cannot stand in for it.
    expect(
      codes([{ ...base, id: 'renamed', apiKey: CUSTOM_PROVIDER_API_KEY_MASK }], new Set(['mygw'])),
    ).toEqual(['config-custom-provider-apikey-required'])
  })

  test('catalog ids are rejected — a config entry re-points the catalog provider', () => {
    for (const reserved of [
      'anthropic',
      'openai',
      'amazon-bedrock',
      'github-copilot',
      'opencode',
    ]) {
      expect(isReservedProviderId(reserved)).toBe(true)
      expect(codes([{ ...base, id: reserved }])).toContain('config-custom-provider-id-reserved')
    }
    expect(isReservedProviderId('mygw')).toBe(false)
  })

  test('reserved snapshot covers every credential-env provider id', () => {
    // Mirrors backend PROVIDER_API_KEY_ENV. A backend id missing here would be
    // accepted as "custom", then silently satisfied by the daemon's own key
    // against the vendor endpoint (design gate P1-1 branch B).
    const credentialEnvIds = [
      'openai',
      'anthropic',
      'google',
      'openrouter',
      'xai',
      'mistral',
      'groq',
      'deepinfra',
      'cerebras',
      'cohere',
      'gateway',
      'togetherai',
      'perplexity',
      'vercel',
      'alibaba',
      'azure',
    ]
    for (const id of credentialEnvIds) expect(RESERVED_PROVIDER_IDS).toContain(id)
  })

  test('id shape follows the same rule OpenCode itself applies', () => {
    for (const bad of ['', 'MyGw', '_gw', 'gw/1', 'gw space', '-gw']) {
      expect(codes([{ ...base, id: bad }])).toContain('config-custom-provider-id-invalid')
    }
    for (const good of ['gw', 'gw-1', 'gw.internal', 'g0']) {
      expect(codes([{ ...base, id: good }])).not.toContain('config-custom-provider-id-invalid')
    }
  })

  test('duplicate ids are rejected; a shared baseURL is not', () => {
    expect(codes([base, { ...base, apiKey: 'other' }])).toContain(
      'config-custom-provider-id-duplicate',
    )
    // D13: uniqueness is by id only — two gateways may sit behind one URL.
    expect(codes([base, { ...base, id: 'second', apiKey: 'k2' }])).toEqual([])
  })

  test('baseURL: absolute http(s) only, and never a ${} expansion marker', () => {
    expect(isValidCustomProviderBaseURL('https://gw.example/v1')).toBe(true)
    expect(isValidCustomProviderBaseURL('http://127.0.0.1:8080/v1')).toBe(true)
    // A trailing slash is a DIFFERENT url and stays legal — admission compares
    // bytes, so normalizing here would break the equality it depends on.
    expect(isValidCustomProviderBaseURL('https://gw.example/v1/')).toBe(true)
    for (const bad of [
      '',
      'gw.example/v1',
      'ftp://gw.example',
      'file:///etc/passwd',
      // OpenCode expands ${VAR} inside the effective baseURL against the sealed
      // server env (provider.ts:1698-1710) — that probe must not be reachable.
      'https://gw.example/${HOME}',
      'https://${LEAK}.example',
      ' https://gw.example',
      'https://gw.example ',
    ]) {
      expect(isValidCustomProviderBaseURL(bad)).toBe(false)
      expect(codes([{ ...base, baseURL: bad }])).toContain('config-custom-provider-baseurl-invalid')
    }
  })

  test('npm is a closed enum — free strings would re-open runtime package download', () => {
    // opencode downloads any non-bundled npm at runtime (provider.ts:1780) and
    // dynamic-imports `file://` specs (:1777). Both stay unreachable.
    for (const bad of ['@ai-sdk/anthropic', 'file:///tmp/evil.js', 'evil-provider', '']) {
      expect(codes([{ ...base, npm: bad }])).toContain('config-custom-provider-npm-unsupported')
      expect(CustomProviderEntrySchema.safeParse({ ...base, npm: bad }).success).toBe(false)
    }
  })

  test('model list: non-empty, unique ids, no NUL', () => {
    expect(codes([{ ...base, models: [] }])).toContain('config-custom-provider-models-empty')
    expect(codes([{ ...base, models: [{ id: 'a' }, { id: 'a' }] }])).toContain(
      'config-custom-provider-model-duplicate',
    )
    expect(codes([{ ...base, models: [{ id: 'a\0b' }] }])).toContain(
      'config-custom-provider-model-invalid',
    )
    expect(codes([{ ...base, models: [{ id: '' }] }])).toContain(
      'config-custom-provider-model-invalid',
    )
  })

  test('rejects NUL in key and name, and a non-boolean enabled', () => {
    expect(codes([{ ...base, apiKey: 'k\0x' }])).toContain('config-custom-provider-apikey-invalid')
    expect(codes([{ ...base, apiKey: '' }])).toContain('config-custom-provider-apikey-invalid')
    expect(codes([{ ...base, name: 'n\0x' }])).toContain('config-custom-provider-name-invalid')
    expect(codes([{ ...base, enabled: 'yes' }])).toContain('config-custom-provider-enabled-invalid')
  })

  test('malformed containers report a single structural issue', () => {
    expect(codes('nope')).toEqual(['config-custom-provider-malformed'])
    expect(codes([42])).toEqual(['config-custom-provider-malformed'])
    expect(validateCustomProviders(undefined)).toEqual([])
  })

  test('issues carry the entry index so the UI can point at the offending row', () => {
    const issues = validateCustomProviders([base, { ...base, id: 'anthropic', apiKey: 'k' }])
    const reserved = issues.find((i) => i.code === 'config-custom-provider-id-reserved')
    expect(reserved?.index).toBe(1)
    expect(reserved?.field).toBe('id')
    expect(reserved?.detail).toBe('anthropic')
  })

  test('isPreservedApiKey distinguishes "keep stored" from a new secret', () => {
    expect(isPreservedApiKey(undefined)).toBe(true)
    expect(isPreservedApiKey(CUSTOM_PROVIDER_API_KEY_MASK)).toBe(true)
    expect(isPreservedApiKey('sk-new')).toBe(false)
  })

  test('the catalog probe runs for new ids only — never for a key rotation', () => {
    const known = new Set(['mygw'])
    expect(idsRequiringCatalogProbe([{ id: 'mygw' }], known)).toEqual([])
    expect(idsRequiringCatalogProbe([{ id: 'mygw' }, { id: 'fresh' }], known)).toEqual(['fresh'])
    // Disabling or editing an existing entry must not require a working
    // runtime binary: PUT /api/config would otherwise fail when opencode is
    // missing, blocking even the act of disabling a broken provider.
    expect(idsRequiringCatalogProbe([{ id: 'mygw' }], known)).toEqual([])
  })
})

describe('RFC-255 failure taxonomy', () => {
  test('the disabled-provider code joins the emit vocabulary exactly once', () => {
    const code = 'execution-identity-custom-provider-disabled'
    expect(EXECUTION_IDENTITY_FAILURE_CODES).toContain(code)
    expect(EXECUTION_IDENTITY_FAILURE_CODES.filter((c) => c === code)).toHaveLength(1)
  })
})
