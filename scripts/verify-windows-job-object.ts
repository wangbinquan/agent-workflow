// RFC-254 T4 (design gate P0-D) — the one claim that needs a real Windows kernel.
//
// WHAT IS BEING PROVEN
// --------------------
// The verified launcher reclaims a runtime store once it believes the process
// tree is gone. On POSIX "the tree" is a process group, which the kernel tracks
// for us. Windows has no groups, and the RFC's first draft proposed
// `taskkill /T` + a single-PID liveness check — which the design gate rejected
// because taskkill walks a SNAPSHOT (anything forked during the walk escapes)
// and a single-PID check says nothing about descendants. A surviving grandchild
// still holding the store, while the platform hands that store to the next run,
// is data corruption rather than a weakened defence.
//
// So the property to demonstrate is precisely:
//
//   kill the PARENT through the Job Object → the GRANDCHILD is gone too,
//   and the job's active-process count drops to zero.
//
// Unit tests cannot show this: on POSIX `adoptProcessTree` correctly returns
// null, and Docker cannot host a Windows kernel. Hence a script that runs where
// the guarantee actually lives.
//
// Run from the repo root on Windows:  bun run scripts/verify-windows-job-object.ts

import {
  adoptProcessTree,
  processTreeOwnershipDiagnosis,
} from '../packages/backend/src/util/windowsJobObject'

function fail(message: string): never {
  process.stderr.write(`FAIL: ${message}\n`)
  process.exit(1)
}

function ok(message: string): void {
  process.stdout.write(`  ok  ${message}\n`)
}

/** True while a pid exists at all — deliberately NOT via our own helpers. */
function pidExists(pid: number): boolean {
  // An independent oracle on purpose: asking the module under test whether its
  // own kill worked would be circular. `tasklist` is the OS's own answer.
  const res = Bun.spawnSync({
    cmd: ['tasklist', '/FI', `PID eq ${pid}`, '/NH'],
    stdout: 'pipe',
    stderr: 'ignore',
    windowsHide: true,
  })
  return res.stdout.toString().includes(String(pid))
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    process.stderr.write('This verification only means anything on Windows.\n')
    process.exit(1)
  }

  process.stdout.write('Job Object end-to-end (RFC-254 T4 / design gate P0-D)\n')

  // Separate "this Bun build cannot do FFI" from "the FFI is wrong". Measured
  // on Windows 11 ARM64 + Bun 1.3.14: dlopen throws because TinyCC is disabled
  // in that build, and reporting it as a broken Job Object would send someone
  // hunting struct offsets that are correct.
  const diagnosis = processTreeOwnershipDiagnosis()
  if (!diagnosis.available) {
    process.stdout.write(
      `\nSKIPPED: job objects unavailable (${diagnosis.reason}).\n` +
        'On Windows ARM64 the shipped Bun build disables TinyCC, so bun:ffi dlopen()\n' +
        'is absent. The platform then falls back to taskkill, which per design gate\n' +
        'P0-D must NOT be treated as proof that a runtime store can be reclaimed.\n' +
        'Re-run on the x64 build (the RFC-254 D6 release target) to exercise this.\n',
    )
    process.exit(0)
  }

  // A parent that spawns a DETACHED grandchild and then just waits. The
  // grandchild is what a snapshot-walking taskkill can miss and what a
  // single-PID liveness check never sees.
  const parentScript = `
    const child = Bun.spawn({
      cmd: [process.execPath, '-e', 'setTimeout(() => {}, 600000)'],
      stdout: 'ignore', stderr: 'ignore', stdin: 'ignore',
    })
    process.stdout.write(String(child.pid) + '\\n')
    setTimeout(() => {}, 600000)
  `
  const parent = Bun.spawn({
    cmd: [process.execPath, '-e', parentScript],
    stdout: 'pipe',
    stderr: 'ignore',
    stdin: 'ignore',
    windowsHide: true,
  })

  const reader = parent.stdout.getReader()
  const { value } = await reader.read()
  const grandchildPid = Number(new TextDecoder().decode(value).trim())
  reader.releaseLock()
  if (!Number.isInteger(grandchildPid) || grandchildPid <= 0) {
    fail(`could not read grandchild pid (got ${String(grandchildPid)})`)
  }
  process.stdout.write(`  parent pid ${parent.pid}, grandchild pid ${grandchildPid}\n`)

  if (!pidExists(parent.pid)) fail('parent is not running')
  if (!pidExists(grandchildPid)) fail('grandchild is not running')
  ok('both processes are live before adoption')

  const owned = adoptProcessTree(parent.pid)
  if (owned === null) fail('adoptProcessTree returned null on Windows — the FFI path is broken')
  if (owned.kind !== 'windows-job-object') fail(`unexpected ownership kind: ${owned.kind}`)
  ok('adopted into a kill-on-close job')

  const before = owned.liveCount()
  if (before === null) fail('QueryInformationJobObject gave no answer')
  // The grandchild was spawned BEFORE adoption, so it may or may not be a job
  // member depending on when it started; what must hold is that the count is a
  // real number and that termination clears it.
  process.stdout.write(`  active processes in job: ${before}\n`)
  if (before < 1) fail('job reports no active processes while the parent is alive')
  ok('the job reports an authoritative live count')

  owned.terminate()

  const deadline = Date.now() + 10_000
  while ((pidExists(parent.pid) || pidExists(grandchildPid)) && Date.now() < deadline) {
    await Bun.sleep(50)
  }

  if (pidExists(parent.pid)) fail('parent survived TerminateJobObject')
  ok('parent is gone')

  // THE point of the exercise.
  if (pidExists(grandchildPid)) {
    fail(
      'GRANDCHILD SURVIVED — the job did not cover the whole tree, so a store ' +
        'reclaim decision based on it would be unsafe',
    )
  }
  ok('grandchild is gone — the whole tree was terminated, not just the parent')

  const after = owned.liveCount()
  if (after !== 0) fail(`job still reports ${String(after)} active processes after termination`)
  ok('active count dropped to zero')

  process.stdout.write('\nJob Object guarantee verified on a real Windows kernel.\n')
}

await main()
