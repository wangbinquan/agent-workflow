// RFC-370: the complete selected Doctor family preserves the one shared diagnostic policy.
// These functional fixtures do not constitute CS deployment or runtime acceptance.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { composeDoctorApplication } from '@/modules/system-operations/composition/doctorDiagnostics'
import { createLocalDoctorDiagnosticsFactory } from '@/modules/system-operations/composition/localDoctorDiagnostics'
import type {
  DoctorDiagnosticsFamily,
  DoctorDiagnosticsFactory,
  DoctorRuntimeProbe,
  DoctorRuntimeSelectionRef,
} from '@/modules/system-operations/application/ports/doctorDiagnostics'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import type { CheckResult } from '@/modules/system-operations/domain/doctorDiagnostics'
import * as decisions from '@/modules/system-operations/domain/doctorDiagnostics'
import * as compatibility from '@/cli/doctor'
import * as native from '@/modules/system-operations/infrastructure/local/doctorDiagnostics'

const members = [
  'loadRuntimeConfiguration',
  'probeRuntime',
  'git',
  'ssh',
  'home',
  'configuration',
  'installation',
  'migrations',
  'database',
  'backups',
] as const
type Member = (typeof members)[number]
function barrier() {
  return Promise.withResolvers<void>()
}
class OpaqueRuntimeSelection {
  get opencodePath(): never {
    throw new Error('shared Doctor interpreted a runtime configuration reference')
  }
  get path(): never {
    throw new Error('shared Doctor interpreted a local path')
  }
}
const check = (name: string, ok = true): CheckResult => ({ name, ok, message: 'selected:' + name })
class SelectedFamily implements DoctorDiagnosticsFamily {
  readonly #selection = new OpaqueRuntimeSelection()
  readonly #probe: DoctorRuntimeProbe
  readonly #errors: Partial<Record<Member, Error>>
  readonly #failCheck: string | undefined
  readonly calls: Member[] = []
  readonly entered = Object.fromEntries(members.map((name) => [name, barrier()])) as Record<
    Member,
    ReturnType<typeof barrier>
  >
  readonly releases = Object.fromEntries(members.map((name) => [name, barrier()])) as Record<
    Member,
    ReturnType<typeof barrier>
  >
  constructor(
    options: {
      probe?: DoctorRuntimeProbe
      held?: boolean
      errors?: Partial<Record<Member, Error>>
      failCheck?: string
    } = {},
  ) {
    this.#probe = options.probe ?? {
      binary: 'owner:binary',
      version: 'selected-version',
      ran: true,
    }
    Object.defineProperty(this.#probe, 'compatible', {
      get() {
        throw new Error('shared Doctor added a runtime compatibility gate')
      },
    })
    this.#errors = options.errors ?? {}
    this.#failCheck = options.failCheck
    if (!options.held) this.releaseAll()
  }
  releaseAll() {
    for (const name of members) this.releases[name].resolve()
  }
  async #run<T>(name: Member, result: T): Promise<T> {
    this.calls.push(name)
    this.entered[name].resolve()
    await this.releases[name].promise
    const error = this.#errors[name]
    if (error !== undefined) throw error
    return result
  }
  #check(name: string) {
    return check(name, this.#failCheck !== name)
  }
  async loadRuntimeConfiguration() {
    return await this.#run('loadRuntimeConfiguration', this.#selection)
  }
  async probeRuntime(selection: DoctorRuntimeSelectionRef) {
    expect(selection).toBe(
      this.#errors.loadRuntimeConfiguration === undefined ? this.#selection : undefined,
    )
    return await this.#run('probeRuntime', this.#probe)
  }
  async git() {
    return await this.#run('git', this.#check('git'))
  }
  async ssh() {
    return await this.#run('ssh', this.#check('ssh'))
  }
  async home() {
    return await this.#run('home', this.#check('home'))
  }
  async configuration() {
    return await this.#run('configuration', this.#check('configuration'))
  }
  async installation() {
    return await this.#run('installation', this.#check('installation'))
  }
  async migrations() {
    return await this.#run('migrations', this.#check('migrations'))
  }
  async database() {
    return await this.#run('database', [this.#check('database'), this.#check('lifecycle')])
  }
  async backups() {
    return await this.#run('backups', this.#check('backups'))
  }
}
const selectedApplication = (family: DoctorDiagnosticsFamily) =>
  composeDoctorApplication({ diagnostics: { create: () => family } })

describe('RFC-370 complete selected Doctor diagnostic family', () => {
  test('prototype/private receivers forward opaque runtime selection and retain full check order', async () => {
    const family = new SelectedFamily()
    const result = await selectedApplication(family).run()
    expect(family.calls).toEqual([...members])
    expect(result.ok).toBe(true)
    expect(result.checks).toEqual([
      {
        name: 'opencode binary',
        ok: true,
        message: 'selected-version (reported version; protocol test required)',
      },
      ...[
        'git',
        'ssh',
        'home',
        'configuration',
        'installation',
        'migrations',
        'database',
        'lifecycle',
        'backups',
      ].map((name) => check(name)),
    ])
  })

  test('every one of the ten asynchronous ACKs precedes the next diagnostic and completion', async () => {
    const family = new SelectedFamily({ held: true })
    let finished = false
    const pending = selectedApplication(family)
      .run()
      .then((result) => {
        finished = true
        return result
      })
    try {
      for (let index = 0; index < members.length; index += 1) {
        const name = members[index]!
        await family.entered[name].promise
        expect(family.calls).toEqual(members.slice(0, index + 1))
        expect(finished).toBe(false)
        family.releases[name].resolve()
      }
      expect((await pending).ok).toBe(true)
      expect(finished).toBe(true)
    } finally {
      family.releaseAll()
      await pending
    }
  })

  test('the selected factory retains its receiver and creates a family for each run at the original point', async () => {
    const events: string[] = []
    const query = {
      read: () => {
        throw new Error('fake complete diagnostics must not read native configuration')
      },
    }
    class Factory implements DoctorDiagnosticsFactory {
      readonly #families: SelectedFamily[] = []
      create(input: Parameters<DoctorDiagnosticsFactory['create']>[0]) {
        expect(input.configuration).toBe(query)
        events.push('create')
        const family = new SelectedFamily()
        this.#families.push(family)
        return family
      }
      getFamilies() {
        return this.#families
      }
    }
    const factory = new Factory()
    const application = composeDoctorApplication({ diagnostics: factory })
    expect(events).toEqual([])
    await application.run(query)
    await application.run(query)
    expect(events).toEqual(['create', 'create'])
    expect(factory.getFamilies()).toHaveLength(2)
    expect(factory.getFamilies()[0]).not.toBe(factory.getFamilies()[1])
    for (const family of factory.getFamilies()) expect(family.calls).toEqual([...members])
  })

  for (const row of [
    {
      probe: { binary: 'owner:binary', version: null, ran: true },
      ok: true,
      message: 'owner:binary (version not reported; protocol test required)',
    },
    {
      probe: { binary: 'owner:binary', version: 'v0', ran: false },
      ok: false,
      message:
        "'owner:binary' not found or not executable; install opencode and ensure PATH or set 'opencodePath' in config",
    },
    {
      probe: { binary: 'owner:binary', version: 'v0' },
      ok: false,
      message:
        "'owner:binary' not found or not executable; install opencode and ensure PATH or set 'opencodePath' in config",
    },
  ]) {
    test(
      'runtime availability preserves ran/version verdict: ' + JSON.stringify(row.probe),
      async () => {
        const family = new SelectedFamily({ probe: row.probe })
        const result = await selectedApplication(family).run()
        expect(result.checks[0]).toEqual({
          name: 'opencode binary',
          ok: row.ok,
          message: row.message,
        })
        expect(result.ok).toBe(row.ok)
        expect(family.calls).toEqual([...members])
      },
    )
  }

  test('configuration load rejection keeps the original ignored boundary and still uses the selected remaining family', async () => {
    const error = new Error('selected configuration unavailable')
    const family = new SelectedFamily({ errors: { loadRuntimeConfiguration: error } })
    expect((await selectedApplication(family).run()).ok).toBe(true)
    expect(family.calls).toEqual([...members])
  })

  for (const name of members) {
    test('missing selected member fails visibly without native fallback: ' + name, async () => {
      const family = new SelectedFamily()
      Object.defineProperty(family, name, { value: undefined })
      await expect(selectedApplication(family).run()).rejects.toThrow()
      expect(family.calls).toEqual(members.slice(0, members.indexOf(name)))
    })
  }

  for (const name of members.filter((name) => name !== 'loadRuntimeConfiguration')) {
    test(
      'selected rejection preserves its error and stops following diagnostics: ' + name,
      async () => {
        const error = new Error('selected failure: ' + name)
        const family = new SelectedFamily({ errors: { [name]: error } })
        let thrown: unknown
        try {
          await selectedApplication(family).run()
        } catch (actual) {
          thrown = actual
        }
        expect(thrown).toBe(error)
        expect(family.calls).toEqual(members.slice(0, members.indexOf(name) + 1))
      },
    )
  }

  test('factory rejection remains outside the ignored configuration-load boundary', async () => {
    const error = new Error('selected family creation failed')
    const factory = {
      create() {
        throw error
      },
    }
    let thrown: unknown
    try {
      await composeDoctorApplication({ diagnostics: factory }).run()
    } catch (actual) {
      thrown = actual
    }
    expect(thrown).toBe(error)
  })

  test('the final verdict still folds every original check and format keeps its original output', async () => {
    const family = new SelectedFamily({ failCheck: 'git' })
    const result = await selectedApplication(family).run()
    expect(result.ok).toBe(false)
    expect(family.calls).toEqual([...members])
    expect(result.checks.filter((value) => !value.ok)).toEqual([check('git', false)])
    expect(decisions.formatDoctor({ ok: false, checks: [check('git', false)] })).toBe(
      '  ✗ git: selected:git\n\none or more checks failed\n',
    )
    expect(decisions.formatDoctor({ ok: true, checks: [check('git')] })).toBe(
      '  ✓ git: selected:git\n\nall checks passed\n',
    )
  })
})

describe('RFC-370 Doctor native pairing and actual standalone root', () => {
  test('one native factory instance binds the selected query to all three original consumers', async () => {
    class Queries implements ApplicationConfigurationQueries {
      #reads = 0
      async read(): Promise<Config> {
        this.#reads += 1
        if (this.#reads === 3) throw new Error('third original query failed')
        return {
          ...structuredClone(DEFAULT_CONFIG),
          opencodePath: 'selected:runtime-configuration',
        }
      }
      count() {
        return this.#reads
      }
    }
    const queries = new Queries()
    const factory = createLocalDoctorDiagnosticsFactory()
    const family = factory.create({ configuration: queries })
    expect(queries.count()).toBe(0)
    expect(await family.loadRuntimeConfiguration()).toBe('selected:runtime-configuration')
    expect(await family.configuration()).toEqual({
      name: 'config',
      ok: true,
      message: 'loaded ($schema_version=' + DEFAULT_CONFIG.$schema_version + ')',
    })
    expect(await family.database()).toEqual([
      {
        name: 'database provider',
        ok: false,
        message: 'configuration unavailable: third original query failed',
      },
    ])
    expect(queries.count()).toBe(3)
  })

  test('native compatibility helpers preserve the exact selected implementation values', () => {
    expect(compatibility.checkConfig).toBe(native.checkConfig)
    expect(compatibility.checkConfiguredDatabase).toBe(native.checkConfiguredDatabase)
    expect(compatibility.evaluateLifecycleHealth).toBe(decisions.evaluateLifecycleHealth)
    expect(compatibility.evaluateGitCheck).toBe(decisions.evaluateGitCheck)
    expect(compatibility.evaluateSshCheck).toBe(decisions.evaluateSshCheck)
    expect(compatibility.evaluateMigrationsStatus).toBe(decisions.evaluateMigrationsStatus)
    expect(compatibility.formatDoctor).toBe(decisions.formatDoctor)
  })

  test('the actual main Doctor arm explicitly chooses the native complete family', () => {
    const file = readFileSync(resolve(import.meta.dir, '../src/main.ts'), 'utf8')
    const source = ts.createSourceFile('main.ts', file, ts.ScriptTarget.Latest, true)
    const arms: ts.CaseClause[] = []
    const visit = (node: ts.Node) => {
      if (
        ts.isCaseClause(node) &&
        ts.isStringLiteral(node.expression) &&
        node.expression.text === 'doctor'
      )
        arms.push(node)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(arms).toHaveLength(1)
    const calls: string[] = []
    const readCalls = (node: ts.Node) => {
      if (ts.isCallExpression(node))
        calls.push(node.getText(source).replace(/\s+/g, '').replace(/,\}/g, '}'))
      ts.forEachChild(node, readCalls)
    }
    readCalls(arms[0]!)
    expect(calls.filter((value) => value === 'createLocalDoctorDiagnosticsFactory()')).toHaveLength(
      1,
    )
    expect(
      calls.filter(
        (value) =>
          value ===
          'composeDoctorApplication({diagnostics:createLocalDoctorDiagnosticsFactory()}).run()',
      ),
    ).toHaveLength(1)
    expect(calls.filter((value) => value === 'doctorCommand()')).toHaveLength(0)
    const common = readFileSync(
      resolve(import.meta.dir, '../src/modules/system-operations/application/doctorDiagnostics.ts'),
      'utf8',
    )
    const composition = readFileSync(
      resolve(import.meta.dir, '../src/modules/system-operations/composition/doctorDiagnostics.ts'),
      'utf8',
    )
    expect(composition).toContain('readonly diagnostics: DoctorDiagnosticsFactory')
    expect(common).not.toMatch(
      /Bun\.spawn|node:fs|Paths\.|getRuntimeDriver|composeFileDoctorConfigurationQueries/,
    )
  })
})
