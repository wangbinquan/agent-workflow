// RFC-198 PR4 — all editable resource detail rails must distinguish initial
// load failures from background refetch failures. Once a draft is seeded, a
// transient GET failure must keep it mounted and expose the same inline retry
// affordance. The agent route has a rendered regression in
// agents-split-page.test.tsx; this source ratchet prevents its MCP/plugin/skill
// siblings from drifting from the shared contract.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const routesDir = path.resolve(import.meta.dirname, '../src/routes')

function readRoute(name: string): string {
  return readFileSync(path.join(routesDir, name), 'utf8')
}

describe('RFC-198 resource detail query-state contract', () => {
  for (const file of [
    'agents.detail.tsx',
    'mcps.detail.tsx',
    'plugins.detail.tsx',
    'skills.detail.tsx',
  ]) {
    test(`${file} exposes retry for both initial and stale query failures`, () => {
      const source = readRoute(file)
      expect(source).toContain("{t('common.retry')}")
      expect(source).toContain('action={retryDetailAction}')
      expect(source.match(/action=\{retryDetailAction\}/g)?.length ?? 0).toBeGreaterThanOrEqual(2)

      const detailHeader = source.indexOf('<DetailHeaderActions')
      const staleBanner = source.indexOf('action={retryDetailAction}', detailHeader)
      expect(detailHeader).toBeGreaterThan(0)
      expect(staleBanner).toBeGreaterThan(detailHeader)
    })
  }
})
