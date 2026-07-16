// RFC-201 PR-A regression guard: /api/config is one causally ordered browser-
// tab resource. Readers and writers outside Settings must never fork their own
// direct API transport or reconstruct a PUT body from a cached full Config.

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')

function sourceFiles(relativeDir: string): string[] {
  const absolute = resolve(ROOT, relativeDir)
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${relativeDir}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(relative)
    return /\.tsx?$/.test(entry.name) ? [relative] : []
  })
}

const CONFIG_CONSUMERS = [
  'src/components/LanguageSwitch.tsx',
  'src/components/RuntimeList.tsx',
  'src/hooks/useLanguage.ts',
  'src/hooks/useTheme.ts',
  'src/routes/agents.new.tsx',
  'src/routes/settings.tsx',
] as const

describe('RFC-201 centralized config resource integration', () => {
  test('every Config consumer imports config-resource and has no direct config transport', () => {
    for (const file of CONFIG_CONSUMERS) {
      const source = read(file)
      expect(source, file).toContain("from '@/lib/config-resource'")
      expect(source, file).not.toMatch(/api\.(?:get|put)(?:<[^>]+>)?\(\s*['"]\/api\/config['"]/)
    }
  })

  test('LanguageSwitch and RuntimeList send strict minimal patches', () => {
    const languageSwitch = read('src/components/LanguageSwitch.tsx')
    expect(languageSwitch).toContain('writeConfigPatch({ language: lang })')
    expect(languageSwitch).not.toContain('...(config.data ?? {})')

    const runtimeList = read('src/components/RuntimeList.tsx')
    expect(runtimeList).toContain('writeConfigPatch({ defaultRuntime: name })')
  })

  test('the only direct config transport in this integration is the singleton adapter', () => {
    const resource = read('src/lib/config-resource.ts')
    expect(resource.match(/api\.get<unknown>\('\/api\/config'/g)).toHaveLength(1)
    expect(resource.match(/api\.put<unknown>\('\/api\/config'/g)).toHaveLength(1)
    expect(resource).toContain('currentSnapshot.generation !== receipt.generation')
    expect(resource).toContain('currentSnapshot.config')
    expect(resource).toContain('configReceiptCoordinator.getSnapshot() === readReceipt')
  })

  test('no future frontend source file can add a second direct config transport', () => {
    const directTransport = /api\.(?:get|put)(?:<[^>]+>)?\(\s*['"]\/api\/config['"]/
    for (const file of sourceFiles('src')) {
      if (file === 'src/lib/config-resource.ts') continue
      expect(read(file), file).not.toMatch(directTransport)
    }
  })
})
