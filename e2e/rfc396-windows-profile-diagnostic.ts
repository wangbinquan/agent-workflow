// Failure-only diagnostics. This does not change the daemon or its verification result.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Attach = (name: string, data: { body: Buffer; contentType: string }) => Promise<void>

export async function attachWindowsProfileDiagnostic(
  files: Record<string, string>,
  attach: Attach,
) {
  if (process.platform !== 'win32') return
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        /^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile)$/i.test(key),
    ),
  )
  let directory: string | undefined
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    platform: process.platform,
    fixture: 'initial',
    variants: [true, false],
  }
  const run = (command: string, args: string[], cwd: string, budgetMs: number) =>
    new Promise<{
      code: number | null
      timedOut: boolean
      stdout: string
      stderr: string
      durationMs: number
      error: string | null
    }>((resolve) => {
      const started = Date.now()
      const child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '',
        stderr = '',
        timedOut = false,
        settled = false
      const finish = (code: number | null, error: string | null = null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdout.destroy()
        child.stderr.destroy()
        resolve({ code, timedOut, stdout, stderr, durationMs: Date.now() - started, error })
      }
      const timer = setTimeout(() => {
        timedOut = true
        if (child.pid)
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            env,
            windowsHide: true,
            stdio: 'ignore',
            timeout: 3_000,
          })
        try {
          child.kill()
        } catch {
          /* close may already have arrived */
        }
        finish(null, 'diagnostic-process-timeout')
      }, budgetMs)
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-65_536)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-65_536)
      })
      child.once('error', (error: NodeJS.ErrnoException) =>
        finish(null, error.code ?? 'spawn-error'),
      )
      child.once('close', (code) => finish(code))
    })
  try {
    directory = await mkdtemp(join(tmpdir(), 'rfc396-profile-diagnostic-'))
    const version = await run('bun', ['--version'], directory, 5_000)
    report.compilerVersion = version
    if (version.code !== 0 || version.stdout.trim() !== '1.4.3')
      throw new Error('expected-ci-bun-1.4.3')
    await writeFile(join(directory, 'fixture.json'), JSON.stringify(files))
    const caller = `import * as fs from 'node:fs'
import * as path from 'node:path'
const root = ${JSON.stringify(directory)}
const files = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'))
const results = { bunVersion: Bun.version, platform: process.platform, cases: [] }
const save = () => fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(results, null, 2))
save()
for (const detached of [true, false]) {
  const cwd = path.join(root, detached ? 'detached-true' : 'detached-false')
  fs.mkdirSync(cwd)
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), content)
  fs.appendFileSync(path.join(cwd, 'verify.cjs'), '\\nfs.writeFileSync("diagnostic-completed.json", JSON.stringify({completed:true, nodeVersion:process.version, nodePath:process.execPath}))\\n')
  const stdout = path.join(cwd, 'stdout.log'), stderr = path.join(cwd, 'stderr.log')
  const started = Date.now()
  let timedOut = false, code = null, error = null, timer
  try {
    const child = Bun.spawn({ cmd:[path.join(cwd, 'verify.cmd')], cwd, windowsHide:true, stdin:'ignore', stdout:Bun.file(stdout), stderr:Bun.file(stderr), detached })
    timer = setTimeout(() => {
      timedOut = true
      const kill = Bun.spawn({cmd:['taskkill.exe','/PID',String(child.pid),'/T','/F'],stdout:'ignore',stderr:'ignore',timeout:3000})
      void kill.exited.finally(() => { try { child.kill() } catch {} }).catch(() => {})
    }, 7000)
    code = await child.exited
  } catch (failure) { error = String(failure) }
  finally { if (timer) clearTimeout(timer) }
  const output = file => {
    if (!fs.existsSync(file)) return {exists:false,bytes:0,content:''}
    const bytes = fs.readFileSync(file)
    return {exists:true,bytes:bytes.length,content:bytes.subarray(-65536).toString('utf8')}
  }
  const marker = path.join(cwd, 'diagnostic-completed.json')
  results.cases.push({detached,code,timedOut,error,durationMs:Date.now()-started,stdout:output(stdout),stderr:output(stderr),completion:fs.existsSync(marker)?JSON.parse(fs.readFileSync(marker,'utf8')):null})
  save()
}
`
    await writeFile(join(directory, 'caller.js'), caller)
    const executable = join(directory, 'caller.exe')
    const compile = await run(
      'bun',
      ['build', '--compile', join(directory, 'caller.js'), '--outfile', executable],
      directory,
      30_000,
    )
    report.compile = compile
    if (compile.code !== 0 || compile.timedOut) throw new Error('diagnostic-compile-failed')
    report.caller = await run(executable, [], directory, 25_000)
    // Read a direct file: compiled caller stdout is itself under investigation.
    try {
      report.results = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'))
    } catch {
      report.resultReadError = 'diagnostic-results-unavailable'
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : 'diagnostic-failed'
  } finally {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
      } catch {
        report.cleanupError = 'diagnostic-temp-removal-failed'
      }
    }
    try {
      await attach('windows-profile-detached-diagnostic.json', {
        body: Buffer.from(JSON.stringify(report, null, 2)),
        contentType: 'application/json',
      })
    } catch {
      console.warn('RFC396 diagnostic attachment failed; original marker assertion remains')
    }
  }
}
