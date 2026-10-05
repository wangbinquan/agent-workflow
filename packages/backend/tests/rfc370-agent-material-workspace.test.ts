// RFC-370 A-T5: the selected content lifecycle retains the real native layout,
// seed bytes and caller-owned removal policy. Runtime/process tests continue
// to verify the original entry-specific capture/reap/retention decisions.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bindNativeAgentMaterialWorkspace } from '../src/modules/runtime-management/infrastructure/local/agentMaterialWorkspace'

const roots: string[] = []
function appHome() {
  const path = mkdtempSync(join(tmpdir(), 'aw-rfc370-material-workspace-'))
  roots.push(path)
  return path
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('RFC-370 native material content lifecycle', () => {
  test('task construction and prepare leave original materialization lazy; removal keeps the actual working tree', async () => {
    const home = appHome()
    const worktree = join(home, 'actual-worktree')
    mkdirSync(worktree)
    writeFileSync(join(worktree, 'source.txt'), 'keep working content')
    let workspaceReads = 0
    const selected = bindNativeAgentMaterialWorkspace({
      kind: 'task',
      appHome: home,
      taskId: 'task',
      nodeRunId: 'attempt',
      workingDirectory: () => {
        workspaceReads++
        return worktree
      },
    })
    expect(selected.locations.root).toBe(join(home, 'runs', 'task', 'attempt'))
    expect(workspaceReads).toBe(0)
    expect(existsSync(selected.locations.root)).toBe(false)
    await selected.workspace.prepare()
    expect(workspaceReads).toBe(0)
    expect(existsSync(selected.locations.root)).toBe(false)
    expect(selected.locations.workingDirectory).toBe(worktree)
    expect(workspaceReads).toBe(1)
    mkdirSync(selected.locations.runDirectory, { recursive: true })
    writeFileSync(join(selected.locations.runDirectory, 'native-material.json'), '{}')
    await selected.workspace.discard()
    expect(existsSync(selected.locations.root)).toBe(false)
    expect(readFileSync(join(worktree, 'source.txt'), 'utf8')).toBe('keep working content')
    expect(JSON.stringify(selected.workspace.workspace)).not.toContain(home)
    expect(JSON.stringify(selected.workspace.runContent)).not.toContain(home)
  })

  test('system content prepares the original named scratch and seed bytes before its explicit removal', async () => {
    const home = appHome()
    const parent = join(home, 'caller-scratch')
    const reads: string[] = []
    const selected = bindNativeAgentMaterialWorkspace({
      kind: 'system',
      parent: () => {
        reads.push('parent')
        return parent
      },
      feature: () => {
        reads.push('feature')
        return 'system'
      },
      scratchName: () => {
        reads.push('name')
        return 'same-session'
      },
    })
    expect(reads).toEqual(['name', 'parent'])
    expect(existsSync(parent)).toBe(false)
    await selected.workspace.prepare([
      { path: 'nested/seed.md', content: '中文\nraw seed bytes\0' },
      { path: 'empty.txt', content: '' },
    ])
    expect(reads).toEqual(['name', 'parent', 'parent'])
    expect(selected.locations.root).toBe(join(parent, 'same-session'))
    expect(selected.locations.workingDirectory).toBe(join(parent, 'same-session', 'worktree'))
    expect(selected.locations.runDirectory).toBe(join(parent, 'same-session', 'run'))
    expect(readFileSync(join(selected.locations.workingDirectory, 'nested/seed.md'), 'utf8')).toBe(
      '中文\nraw seed bytes\0',
    )
    expect(readFileSync(join(selected.locations.workingDirectory, 'empty.txt'), 'utf8')).toBe('')
    expect(existsSync(selected.locations.runDirectory)).toBe(true)
    await selected.workspace.discard()
    expect(existsSync(selected.locations.root)).toBe(false)
    expect(existsSync(parent)).toBe(true)
  })

  test('system default name keeps feature lookup before parent lookup and construction performs no mkdir', () => {
    const home = appHome()
    const reads: string[] = []
    const selected = bindNativeAgentMaterialWorkspace({
      kind: 'system',
      parent: () => {
        reads.push('parent')
        return join(home, 'scratch')
      },
      feature: () => {
        reads.push('feature')
        return 'original-feature'
      },
      scratchName: () => {
        reads.push('name')
        return undefined
      },
    })
    expect(reads).toEqual(['name', 'feature', 'parent'])
    expect(selected.locations.root).toMatch(/[\\/]original-feature-[0-9a-f]{16}$/)
    expect(existsSync(selected.locations.root)).toBe(false)
  })

  test('a prepare failure retains original content until its caller chooses discard', async () => {
    const home = appHome()
    const selected = bindNativeAgentMaterialWorkspace({
      kind: 'system',
      parent: () => home,
      feature: () => 'system',
      scratchName: () => 'failed-prepare',
    })
    mkdirSync(selected.locations.root)
    writeFileSync(join(selected.locations.root, 'worktree'), 'original blocking file')
    expect(() => selected.workspace.prepare()).toThrow()
    expect(readFileSync(join(selected.locations.root, 'worktree'), 'utf8')).toBe(
      'original blocking file',
    )
    await selected.workspace.discard()
    expect(existsSync(selected.locations.root)).toBe(false)
  })

  test('the native seed reader runs after the original directories exist and keeps its original failure', async () => {
    const home = appHome()
    const seedError = new Error('original-seed-read-failure')
    let reads = 0
    const selected = bindNativeAgentMaterialWorkspace({
      kind: 'system',
      parent: () => home,
      feature: () => 'system',
      scratchName: () => 'reader-timing',
      seedFiles: () => {
        reads++
        expect(existsSync(join(home, 'reader-timing', 'worktree'))).toBe(true)
        expect(existsSync(join(home, 'reader-timing', 'run'))).toBe(true)
        throw seedError
      },
    })
    expect(reads).toBe(0)
    expect(() => selected.workspace.prepare()).toThrow(seedError)
    expect(reads).toBe(1)
    expect(existsSync(selected.locations.root)).toBe(true)
    await selected.workspace.discard()
    expect(existsSync(selected.locations.root)).toBe(false)
  })

  test('smoke content keeps the app-home layout and ownerless prepare/discard semantics', async () => {
    const home = appHome()
    const selected = bindNativeAgentMaterialWorkspace({ kind: 'smoke', appHome: home })
    expect(selected.locations.root).toMatch(/[\\/]runtime-smoke-[0-9a-f]{16}$/)
    expect(selected.locations.root.startsWith(join(home, 'scratch'))).toBe(true)
    expect(existsSync(selected.locations.root)).toBe(false)
    await selected.workspace.prepare()
    expect(existsSync(selected.locations.workingDirectory)).toBe(true)
    expect(existsSync(selected.locations.runDirectory)).toBe(true)
    await selected.workspace.discard()
    expect(existsSync(selected.locations.root)).toBe(false)
  })
})
