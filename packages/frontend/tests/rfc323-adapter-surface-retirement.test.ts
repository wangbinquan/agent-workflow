import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

import { CONFIG_KIND_SPECS } from '../src/routes/code.config'

const FRONTEND = resolve(import.meta.dirname, '..')
const WORKSPACE = resolve(FRONTEND, '..', '..')
const source = (path: string): string => readFileSync(resolve(FRONTEND, 'src', path), 'utf8')

describe('RFC-323 retired Adapter surfaces stay retired', () => {
  test('old URLs are redirect-only and the generic config registry has no Adapter kind', () => {
    const executors = source('routes/code.executors.tsx')
    const list = source('routes/code.config.tsx')
    const detail = source('routes/code.config.detail.tsx')

    expect(executors).toContain("redirect({ to: '/digital-employees' })")
    expect(executors).not.toContain('ExecutorLibraryPage')
    expect(list).toContain("params.kind === 'adapters'")
    expect(detail).toContain("params.kind === 'adapters'")
    expect('adapters' in CONFIG_KIND_SPECS).toBe(false)
  })

  test('old Adapter DOM, tool-owned connection picker, editor branch, and snapshots cannot return', () => {
    const typeRoute = source('routes/digital-employees.$typeRef.tsx')
    const detail = source('routes/code.config.detail.tsx')
    const editor = source('components/code/DevelopmentConfigEditor.tsx')

    expect(typeRoute).not.toContain('digital-employee-tool-connections')
    expect(typeRoute).not.toContain('setConnectionId')
    expect(typeRoute).toContain(
      'data-testid={`digital-employee-configure-responsibilities-${employee.id}`}',
    )
    expect(typeRoute).toContain('onSelectAdapterSlot={setToolboxAdapterTarget}')
    expect(typeRoute).toContain('<LaneAdapterResourceDialog')
    expect(typeRoute).not.toContain('LaneAdapterTargetDialog')
    expect(typeRoute).not.toContain('adapterAuthoringRequest')
    expect(typeRoute).toContain('data-testid="employee-responsibilities-dialog"')
    expect(typeRoute).toContain('form="employee-responsibilities-form"')
    expect(detail).not.toContain('config-summary-adapter')
    expect(editor).not.toContain('config-guided-editor-adapter')
    expect(editor).not.toContain('AdapterEditor')
    for (const platform of ['darwin', 'linux']) {
      expect(
        existsSync(
          resolve(
            WORKSPACE,
            `e2e/visual-regression.spec.ts-snapshots/code-executors-chromium-${platform}.png`,
          ),
        ),
      ).toBe(false)
    }
    expect(readFileSync(resolve(WORKSPACE, 'e2e/visual-regression.spec.ts'), 'utf8')).not.toContain(
      'code-executors',
    )
  })
})
