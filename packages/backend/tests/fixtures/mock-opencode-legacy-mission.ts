// Controlled child workload for the legacy mission execution conformance test.
// The real prompt supplies the action reference, digest and result protocol.
import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

export async function runLegacyMissionWorkload(
  prompt: string,
  releasePath: string,
  capturePath: string,
): Promise<string> {
  const header = prompt.match(
    /"actionRunRef": "([^"]+)", "inputDigest": "([^"]+)", "capabilityId": "([^"]+)"/,
  )
  const nonce = prompt.match(/<agent-result nonce="([^"]+)">/)?.[1]
  if (header === null || nonce === undefined) {
    throw new Error('legacy mission child did not receive the assembled action protocol')
  }
  const deadline = Date.now() + 20_000
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error('legacy mission child release timed out')
    await delay(10)
  }
  const envelope = {
    protocolVersion: 1,
    nonce,
    port: 'agent-result',
    actionRunRef: header[1],
    inputDigest: header[2],
    capabilityId: header[3],
    outcome: 'no-change',
    result: { reason: 'already-satisfied', summary: 'Legacy mission child completed its action.' },
  }
  const frame = `<agent-result nonce="${nonce}">\n${JSON.stringify(envelope)}\n</agent-result>`
  writeFileSync(
    capturePath,
    JSON.stringify({ pid: process.pid, cwd: process.cwd(), argv: process.argv, envelope, frame }),
  )
  return frame
}

// The Script executor runs this authored ESM body using its real interpreter.
export function legacyMissionScriptBody(fixturePath: string): string {
  return [
    "import { readFileSync } from 'node:fs'",
    `import { runLegacyMissionWorkload } from ${JSON.stringify(pathToFileURL(fixturePath).href)}`,
    'const prompt = process.env.AW_PORT_PROMPT ?? readFileSync(process.env.AW_PORT_FILE_PROMPT, "utf8")',
    'const frame = await runLegacyMissionWorkload(prompt, process.env.RFC359_MISSION_RELEASE, process.env.RFC359_MISSION_CAPTURE)',
    'process.stdout.write(frame)',
  ].join('\n')
}

if (import.meta.main) {
  if (process.argv.includes('--version')) {
    process.stdout.write('1.0.0\n')
  } else {
    const argv = process.argv.slice(2)
    const separator = argv.indexOf('--')
    const prompt = separator >= 0 ? argv.slice(separator + 1).join(' ') : (argv[1] ?? '')
    const releasePath = process.env.RFC359_MISSION_RELEASE
    const capturePath = process.env.RFC359_MISSION_CAPTURE
    if (releasePath === undefined || capturePath === undefined) {
      throw new Error('legacy mission child fixture paths missing')
    }
    // These outputs belong only to this child, after the parent has observed
    // the real attempt.executionRef commit. The shared mock emits runtime events.
    process.env.MOCK_OPENCODE_OUTPUTS = JSON.stringify({
      'agent-result': await runLegacyMissionWorkload(prompt, releasePath, capturePath),
    })
    await import('./mock-opencode')
  }
}
