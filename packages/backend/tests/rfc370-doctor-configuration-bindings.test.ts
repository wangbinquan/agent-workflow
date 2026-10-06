// Only the configuration entry points are exercised; other doctor checks are unchanged.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { checkConfig, checkConfiguredDatabase } from '@/cli/doctor'
import { loadConfig } from '@/config'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import { Paths } from '@/util/paths'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function selectedSource() {
  class Source implements ApplicationConfigurationQueries {
    current: Config = structuredClone(DEFAULT_CONFIG)
    reads = 0
    entered = barrier()
    release: Promise<void> = Promise.resolve()
    error: Error | undefined

    async read() {
      expect<unknown>(this).toBe(selected)
      this.reads += 1
      this.entered.resolve()
      await this.release
      if (this.error !== undefined) throw this.error
      return structuredClone(this.current)
    }
  }
  const selected = new Source()
  return selected
}

describe('RFC-370 doctor configuration selection', () => {
  let home: string
  let previousHome: string | undefined

  beforeEach(() => {
    previousHome = process.env.AGENT_WORKFLOW_HOME
    home = mkdtempSync(join(tmpdir(), 'rfc370-doctor-config-'))
    process.env.AGENT_WORKFLOW_HOME = home
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  test('configuration report waits for the selected receiver and ignores an invalid local file', async () => {
    writeFileSync(Paths.config, '{invalid local configuration')
    const selected = selectedSource()
    const release = barrier()
    selected.release = release.promise
    let finished = false
    const pending = checkConfig(selected).then((result) => {
      finished = true
      return result
    })
    try {
      await selected.entered.promise
      expect(finished).toBe(false)
      selected.current = { ...selected.current, maxConcurrentNodes: 11 }
      release.resolve()
      expect(await pending).toEqual({
        name: 'config',
        ok: true,
        message: `loaded ($schema_version=${DEFAULT_CONFIG.$schema_version})`,
      })
      expect(selected.reads).toBe(1)
      expect(readFileSync(Paths.config, 'utf8')).toBe('{invalid local configuration')
    } finally {
      release.resolve()
      await pending
    }
  })

  test('selected report errors retain the old message and never use valid file defaults', async () => {
    const local = JSON.stringify({ ...DEFAULT_CONFIG, maxConcurrentNodes: 23 })
    writeFileSync(Paths.config, local)
    const selected = selectedSource()
    selected.error = new Error('selected configuration offline')
    expect(await checkConfig(selected)).toEqual({
      name: 'config',
      ok: false,
      message: 'selected configuration offline',
    })
    expect(selected.reads).toBe(1)
    expect(readFileSync(Paths.config, 'utf8')).toBe(local)
  })

  test('database configuration failure waits for ACK before producing its existing diagnostic', async () => {
    const local = JSON.stringify(DEFAULT_CONFIG)
    writeFileSync(Paths.config, local)
    const selected = selectedSource()
    const release = barrier()
    selected.release = release.promise
    selected.error = new Error('selected database configuration offline')
    let finished = false
    const pending = checkConfiguredDatabase(selected).then((result) => {
      finished = true
      return result
    })
    try {
      await selected.entered.promise
      expect(finished).toBe(false)
      release.resolve()
      expect(await pending).toEqual([
        {
          name: 'database provider',
          ok: false,
          message: 'configuration unavailable: selected database configuration offline',
        },
      ])
      expect(selected.reads).toBe(1)
      expect(readFileSync(Paths.config, 'utf8')).toBe(local)
    } finally {
      release.resolve()
      await pending
    }
  })

  test('a synchronous selected read failure uses the same report contract', async () => {
    const selected: ApplicationConfigurationQueries = {
      read() {
        expect<unknown>(this).toBe(selected)
        throw new Error('synchronous selected source failed')
      },
    }
    expect(await checkConfig(selected)).toEqual({
      name: 'config',
      ok: false,
      message: 'synchronous selected source failed',
    })
    expect(await checkConfiguredDatabase(selected)).toEqual([
      {
        name: 'database provider',
        ok: false,
        message: 'configuration unavailable: synchronous selected source failed',
      },
    ])
  })

  test.each([null, 'selected read rejected', undefined, 42])(
    'a non-Error selected rejection retains a configuration diagnostic: %p',
    async (reason) => {
      const selected: ApplicationConfigurationQueries = {
        read() {
          expect<unknown>(this).toBe(selected)
          return Promise.reject<Config>(reason)
        },
      }
      expect(await checkConfig(selected)).toEqual({
        name: 'config',
        ok: false,
        message: String(reason),
      })
      expect(await checkConfiguredDatabase(selected)).toEqual([
        {
          name: 'database provider',
          ok: false,
          message: `configuration unavailable: ${String(reason)}`,
        },
      ])
    },
  )

  test('standalone absence, loaded schema and invalid-file reports preserve their old policy', async () => {
    expect(await checkConfig()).toEqual({
      name: 'config',
      ok: true,
      message: '(not yet created; defaults will apply)',
    })
    writeFileSync(Paths.config, JSON.stringify(DEFAULT_CONFIG))
    expect(await checkConfig()).toEqual({
      name: 'config',
      ok: true,
      message: `loaded ($schema_version=${DEFAULT_CONFIG.$schema_version})`,
    })
    writeFileSync(Paths.config, '{invalid standalone configuration')
    let originalMessage: string | undefined
    try {
      loadConfig(Paths.config)
    } catch (error) {
      originalMessage = (error as Error).message
    }
    expect(originalMessage).toBeDefined()
    if (originalMessage === undefined) {
      throw new Error('invalid standalone configuration must produce its original load error')
    }
    expect(await checkConfig()).toEqual({ name: 'config', ok: false, message: originalMessage })
  })

  test('the actual doctor root passes one selected instance to all three configuration consumers', () => {
    const file = readFileSync(
      new URL(
        '../src/modules/system-operations/infrastructure/local/doctorDiagnostics.ts',
        import.meta.url,
      ),
      'utf8',
    )
    const source = ts.createSourceFile('doctor.ts', file, ts.ScriptTarget.Latest, true)
    const root = source.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'createLocalDoctorDiagnostics',
    )
    expect(root?.body).toBeDefined()
    const compact = (node: ts.Node) => node.getText(source).replace(/\s+/g, '')
    const calls: ts.CallExpression[] = []
    const declarations: ts.VariableDeclaration[] = []
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) calls.push(node)
      if (ts.isVariableDeclaration(node)) declarations.push(node)
      ts.forEachChild(node, visit)
    }
    visit(root!.body!)
    const selection = declarations.filter((node) => compact(node.name) === 'configuration')
    expect(selection).toHaveLength(1)
    expect(compact(selection[0]!.initializer!)).toBe(
      'selected??composeFileDoctorConfigurationQueries(Paths.config)',
    )
    for (const expected of [
      'configuration.read()',
      'checkConfig(configuration,selected===undefined)',
      'checkConfiguredDatabase(configuration)',
    ]) {
      expect(calls.filter((node) => compact(node) === expected)).toHaveLength(1)
    }
    expect(calls.filter((node) => compact(node.expression) === 'loadConfig')).toHaveLength(0)
  })
})
