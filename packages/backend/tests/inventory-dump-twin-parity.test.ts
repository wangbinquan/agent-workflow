// RFC-029 T3 grep-lock: keeps the .mjs dump plugin (loaded by opencode
// child processes — must be import-free ESM) byte-for-byte aligned with the
// TypeScript twin in `transcoder.ts`. If opencode ever changes a field, both
// copies must move together. The check is structural (strips comments + the
// type annotation difference) rather than full diff to allow the .ts file
// to carry `: TypeName` annotations the .mjs cannot.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', 'src', 'opencode-plugin')
const MJS = readFileSync(resolve(ROOT, 'aw-inventory-dump.mjs'), 'utf-8')
const TS = readFileSync(resolve(ROOT, 'transcoder.ts'), 'utf-8')

function critical(src: string): string[] {
  // Pull out the lines that actually shape the output snapshot so a refactor
  // that drops, say, `model.providerID` makes the test red.
  const tokens = [
    "name: str(r.name, '(unnamed)')",
    "mode: str(r.mode, 'unknown')",
    'modelProviderId: nullableStr(model.providerID ?? r.modelProviderId)',
    'modelId: nullableStr(model.modelID ?? r.modelId)',
    "source: str(source.type ?? r.source, 'unknown')",
    'path: nullableStr(source.path ?? r.path)',
    'description: nullableStr(r.description)',
    "type: str(config.type ?? r.type, 'unknown')",
    "status: str(r.status, 'unknown')",
    'hint: nullableStr(r.error ?? r.url ?? r.hint)',
    "specifier: '(unknown)'",
  ]
  return tokens.filter((t) => src.includes(t))
}

describe('aw-inventory-dump.mjs ↔ transcoder.ts parity', () => {
  test('every critical mapping line present in both files', () => {
    const inMjs = critical(MJS)
    const inTs = critical(TS)
    expect(inMjs.length).toBeGreaterThan(0)
    expect(inMjs).toEqual(inTs)
  })

  test('.mjs file is import-free (no node_modules deps survive)', () => {
    // Allow only `node:fs/promises` as the writeFile fallback; anything else
    // is a bug because the file is loaded by an opencode child process.
    const importLines = MJS.split('\n').filter(
      (l) => /^\s*(import|from)\s/.test(l) || /import\(/.test(l),
    )
    for (const line of importLines) {
      const ok =
        /node:fs\/promises/.test(line) || // dynamic fallback
        /^\s*export\b/.test(line) // export default {...}
      if (!ok) {
        throw new Error(`Unexpected import in dump plugin: ${line}`)
      }
    }
  })

  test('exposes default plugin module with `server(input)` entry', () => {
    expect(MJS).toContain('export default {')
    expect(MJS).toContain("id: 'aw-inventory-dump'")
    expect(MJS).toContain('async server(input)')
  })

  test('calls the three required opencode SDK methods (incl. v1 SDK fallback for skills)', () => {
    // agents + mcp.status() are stable across v1/v2 SDK.
    expect(MJS).toContain('input.client.app.agents()')
    expect(MJS).toContain('input.client.mcp.status()')
    // skills lives only on v2 SDK; the v1 SDK that PluginInput.client uses
    // omits it, so the plugin defensively probes `app.skills` AND falls back
    // to the underlying hey-api `_client.get({url:'/skill'})` HTTP route.
    // Both shapes must remain present or skills silently degrade to [] in
    // every install instead of just the absent-SDK-method case.
    expect(MJS).toContain("typeof app.skills === 'function'")
    expect(MJS).toContain("url: '/skill'")
  })

  test('reads OPENCODE_AW_INVENTORY_OUT and writes JSON', () => {
    expect(MJS).toContain('process.env.OPENCODE_AW_INVENTORY_OUT')
    expect(MJS).toContain('JSON.stringify(snapshot)')
  })
})
