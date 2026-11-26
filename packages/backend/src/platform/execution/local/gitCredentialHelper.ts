// Windows standalone executables cannot reliably re-enter their bundled main
// module as a Git credential helper: application argv and stdin may be lost.
// The binary build bundles this deliberately small entrypoint as JavaScript;
// gitCredentialLease extracts it beside the one-shot lease and executes it
// through the same executable in Bun-CLI mode.

import { GIT_CREDENTIAL_SUBCOMMAND, runGitCredentialSubcommand } from './gitCredentialLease'

async function main(): Promise<void> {
  const subcommandIndex = Bun.argv.indexOf(GIT_CREDENTIAL_SUBCOMMAND)
  const operation = subcommandIndex < 0 ? '' : (Bun.argv[subcommandIndex + 1] ?? '')
  const stdin = await Bun.stdin.text().catch(() => '')
  const out = runGitCredentialSubcommand(operation, stdin)
  if (out.length > 0) process.stdout.write(out)
}

if (import.meta.main) {
  await main()
}
