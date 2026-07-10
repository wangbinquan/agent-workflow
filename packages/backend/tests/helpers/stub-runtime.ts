// RFC-W001 — Cross-platform test stub helper.
//
// On Windows, .sh scripts cannot be spawned directly (no shebang interpreter).
// This module provides helpers that write Node.js (.js) stubs on Windows and
// .sh stubs on POSIX, so tests work identically on both platforms.
//
// CRITICAL ESCAPING NOTE for JS stub generation:
//   In a template literal, `\n` is a literal newline and `\\` is a single
//   backslash. To emit a REAL newline as a line terminator in the generated
//   JS, the generated source must read `'\n'` (backslash + n) - which means the
//   TEMPLATE must contain `\\n` (two backslashes + n). Four backslashes (`\\\\n`)
//   would collapse to `\\n` in the source, which JS evaluates as a LITERAL
//   backslash-n (2 chars) - NOT a newline - and the stub would write
//   `JSON + \n` (literal), which pumpLines never splits on and JSON.parse
//   chokes on. The .sh stubs already emit real newlines via `printf '\n'`; the
//   .js stubs must match.
//   For arbitrary string literals that need newlines/quotes at runtime, prefer
//   JSON.stringify() (it produces a correctly-escaped JS source literal).
//
// Usage pattern:
//   import { writeStubOpencode, stubCmd } from './helpers/stub-runtime'
//   const stubPath = writeStubOpencode(tmpDir, { version: '1.14.99', ... })
//   // Then pass to runTask / startTask:
//   runTask({ ..., opencodeCmd: stubCmd(stubPath) })

import { writeFileSync, mkdirSync, chmodSync, symlinkSync, copyFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const isWindows = process.platform === 'win32'

// ─── Core helpers ───────────────────────────────────────────────────────

/**
 * Get the spawn command array for a stub script.
 * POSIX: [stubPath] (direct spawn, shebang handles interpreter)
 * Windows: ['bun', 'run', stubPath] (bun runs .js files natively)
 */
export function stubCmd(stubPath: string): string[] {
  if (isWindows) {
    return ['bun', 'run', stubPath]
  }
  return [stubPath]
}

/**
 * Write a generic stub script to disk.
 * POSIX: writes .sh with shebang + chmod 0o755
 * Windows: writes .js (Node.js script)
 * Returns the path to the script file.
 */
export function writeStubScript(
  dir: string,
  name: string,
  posixScript: string,
  jsScript: string,
): string {
  if (isWindows) {
    const jsPath = join(dir, name.replace(/\.sh$/, '.js'))
    writeFileSync(jsPath, jsScript)
    return jsPath
  }
  const shPath = join(dir, name)
  writeFileSync(shPath, posixScript)
  chmodSync(shPath, 0o755)
  return shPath
}

// ─── Stub opencode ─────────────────────────────────────────────────────

export interface StubOpencodeOpts {
  /** Version string for --version response. Default: 'stub-opencode 1.14.99' */
  version?: string
  /** Port outputs as { portName: content } for the envelope. Default: { out: 'stub output' } */
  outputs?: Record<string, string>
  /** If true, emit a <workflow-clarify> envelope instead of <workflow-output> */
  clarify?: Array<{ id: string; title: string; kind: string; options: Array<{ label: string }> }>
  /** If true, exit with non-zero code (simulates failure) */
  fail?: boolean
  /** If true, hang forever (simulates timeout) */
  hang?: boolean
  /** If set, write inventory JSON to OPENCODE_AW_INVENTORY_OUT */
  inventory?: object
  /** Custom JS script body (advanced — overrides all other opts on Windows) */
  customJs?: string
  /** Custom bash script body (advanced — overrides all other opts on POSIX) */
  customBash?: string
  /** Counter file path for multi-invocation stubs that vary behavior per call */
  counterFile?: string
  /** Per-invocation behavior: array of outputs/clarify for each call index */
  perCall?: Array<{
    outputs?: Record<string, string>
    clarify?: Array<{ id: string; title: string; kind: string; options: Array<{ label: string }> }>
    fail?: boolean
  }>
}

/**
 * Write a stub opencode binary. Returns the script path.
 * Use `stubCmd(path)` to get the spawn argv.
 */
export function writeStubOpencode(dir: string, opts: StubOpencodeOpts = {}): string {
  const name = 'stub-opencode'
  const version = opts.version ?? 'stub-opencode 1.14.99'
  const outputs = opts.outputs ?? { out: 'stub output' }

  if (isWindows) {
    return writeStubOpencodeJs(dir, name, version, outputs, opts)
  }
  return writeStubOpencodeSh(dir, name, version, outputs, opts)
}

function writeStubOpencodeJs(
  dir: string,
  name: string,
  version: string,
  defaultOutputs: Record<string, string>,
  opts: StubOpencodeOpts,
): string {
  if (opts.customJs) {
    const jsPath = join(dir, `${name}.js`)
    writeFileSync(jsPath, opts.customJs)
    return jsPath
  }

  const jsPath = join(dir, `${name}.js`)
  // Use JSON.stringify for all string literals to ensure correct escaping
  // In the generated JS file, \\n must appear as two characters (\ then n),
  // not as a literal newline. JSON.stringify handles this correctly.
  const versionLiteral = JSON.stringify(version + '\n')
  const lines: string[] = [
    `// Auto-generated stub opencode for Windows test compatibility`,
    `const { writeFileSync, readFileSync, existsSync, mkdirSync } = require('node:fs')`,
    `const { join } = require('node:path')`,
    ``,
    `const args = process.argv.slice(2)`,
    ``,
    `if (args.includes('--version') || args.includes('-v')) {`,
    `  process.stdout.write(${versionLiteral})`,
    `  process.exit(0)`,
    `}`,
    ``,
    `if (args[0] !== 'run') {`,
    `  process.stderr.write('stub-opencode: expected run, got: ' + args[0] + '\\n')`,
    `  process.exit(2)`,
    `}`,
  ]

  // Inventory support
  if (opts.inventory) {
    lines.push(
      ``,
      `if (process.env.OPENCODE_AW_INVENTORY_OUT) {`,
      `  writeFileSync(process.env.OPENCODE_AW_INVENTORY_OUT, JSON.stringify(${JSON.stringify(opts.inventory)}, null, 2))`,
      `}`,
    )
  }

  // Hang mode
  if (opts.hang) {
    lines.push(``, `// Hang forever (timeout simulation)`, `setInterval(() => {}, 60000)`)
    writeFileSync(jsPath, lines.join('\n'))
    return jsPath
  }

  // Fail mode
  if (opts.fail) {
    lines.push(``, `process.stderr.write('stub-opencode: simulated failure\\n')`, `process.exit(1)`)
    writeFileSync(jsPath, lines.join('\n'))
    return jsPath
  }

  // Per-call mode (counter-based)
  if (opts.perCall && opts.perCall.length > 0) {
    const counterFile = opts.counterFile ?? join(dir, '.invoke-counter')
    lines.push(
      ``,
      `const COUNTER_FILE = ${JSON.stringify(counterFile)}`,
      `let n = 0`,
      `if (existsSync(COUNTER_FILE)) n = Number(readFileSync(COUNTER_FILE, 'utf-8').trim()) || 0`,
      `n++`,
      `writeFileSync(COUNTER_FILE, String(n))`,
      `const perCall = ${JSON.stringify(opts.perCall)}`,
      `const step = perCall[Math.min(n - 1, perCall.length - 1)]`,
    )
    lines.push(
      `if (step.clarify) {`,
      `  const env = '<workflow-clarify>' + JSON.stringify({ questions: step.clarify }) + '</workflow-clarify>'`,
      `  process.stdout.write(JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text: env } }) + '\\n')`,
      `  process.exit(0)`,
      `}`,
    )
    lines.push(`if (step.fail) { process.exit(1) }`)
    lines.push(
      `const outputs = step.outputs ?? ${JSON.stringify(defaultOutputs)}`,
      buildEmitEnvelopeJs('outputs'),
      `process.exit(0)`,
    )
    writeFileSync(jsPath, lines.join('\n'))
    return jsPath
  }

  // Clarify mode
  if (opts.clarify) {
    const clarifyEnv = `<workflow-clarify>${JSON.stringify({ questions: opts.clarify })}</workflow-clarify>`
    lines.push(
      ``,
      `const env = ${JSON.stringify(clarifyEnv)}`,
      `process.stdout.write(JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text: env } }) + '\\n')`,
      `process.exit(0)`,
    )
    writeFileSync(jsPath, lines.join('\n'))
    return jsPath
  }

  // Default: emit workflow-output envelope
  lines.push(
    ``,
    `const outputs = ${JSON.stringify(defaultOutputs)}`,
    buildEmitEnvelopeJs('outputs'),
    `process.exit(0)`,
  )
  writeFileSync(jsPath, lines.join('\n'))
  return jsPath
}

function buildEmitEnvelopeJs(outputsVar: string): string {
  // Use \\n in template literal to produce \\n in generated JS source
  // (which runtime interprets as newline character)
  return [
    `let envelope = '<workflow-output>\\n'`,
    `for (const [p, c] of Object.entries(${outputsVar})) envelope += '  <port name="' + p + '">' + c + '</port>\\n'`,
    `envelope += '</workflow-output>'`,
    `process.stdout.write(JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text: envelope } }) + '\\n')`,
  ].join('\n')
}

function writeStubOpencodeSh(
  dir: string,
  name: string,
  version: string,
  defaultOutputs: Record<string, string>,
  opts: StubOpencodeOpts,
): string {
  if (opts.customBash) {
    const shPath = join(dir, `${name}.sh`)
    writeFileSync(shPath, opts.customBash)
    chmodSync(shPath, 0o755)
    return shPath
  }

  const shPath = join(dir, `${name}.sh`)
  const lines: string[] = [
    `#!/usr/bin/env bash`,
    `set -e`,
    ``,
    `if [[ "$1" == "--version" ]]; then`,
    `  echo '${version}'`,
    `  exit 0`,
    `fi`,
    ``,
    `if [[ "$1" != "run" ]]; then`,
    `  echo "stub-opencode: expected run, got: $1" >&2`,
    `  exit 2`,
    `fi`,
  ]

  if (opts.inventory) {
    lines.push(
      ``,
      `if [ -n "\${OPENCODE_AW_INVENTORY_OUT:-}" ]; then`,
      `  cat > "\${OPENCODE_AW_INVENTORY_OUT}" <<'INVENTORY_JSON'`,
      JSON.stringify(opts.inventory, null, 2),
      `INVENTORY_JSON`,
      `fi`,
    )
  }

  if (opts.hang) {
    lines.push(`sleep 300`)
    writeFileSync(shPath, lines.join('\n'))
    chmodSync(shPath, 0o755)
    return shPath
  }

  if (opts.fail) {
    lines.push(`echo 'stub-opencode: simulated failure' >&2`, `exit 1`)
    writeFileSync(shPath, lines.join('\n'))
    chmodSync(shPath, 0o755)
    return shPath
  }

  if (opts.perCall && opts.perCall.length > 0) {
    const counterFile = opts.counterFile ?? join(dir, '.invoke-counter')
    lines.push(
      ``,
      `COUNTER_FILE='${counterFile}'`,
      `N=0`,
      `if [[ -f "$COUNTER_FILE" ]]; then N=$(cat "$COUNTER_FILE"); fi`,
      `N=$((N + 1))`,
      `echo $N > "$COUNTER_FILE"`,
    )
    for (let i = 0; i < opts.perCall.length; i++) {
      const step = opts.perCall[i]!
      lines.push(`if [[ $N -eq ${i + 1} ]]; then`)
      if (step.clarify) {
        const clarifyEnv = `<workflow-clarify>${JSON.stringify({ questions: step.clarify })}</workflow-clarify>`
        lines.push(
          `  ENV='${clarifyEnv.replace(/'/g, "'\\''")}'`,
          `  TS=$(date +%s%3N)`,
          `  printf '{"type":"text","ts":%s,"text":"%s"}\\n' "$TS" "$ENV"`,
          `  exit 0`,
        )
      } else if (step.fail) {
        lines.push(`  exit 1`)
      } else {
        const stepOutputs = step.outputs ?? defaultOutputs
        lines.push(buildBashEnvelope(stepOutputs), `  exit 0`)
      }
      lines.push(`fi`)
    }
    const lastStep = opts.perCall[opts.perCall.length - 1]!
    if (lastStep.clarify) {
      const clarifyEnv = `<workflow-clarify>${JSON.stringify({ questions: lastStep.clarify })}</workflow-clarify>`
      lines.push(
        `ENV='${clarifyEnv.replace(/'/g, "'\\''")}'`,
        `TS=$(date +%s%3N)`,
        `printf '{"type":"text","ts":%s,"text":"%s"}\\n' "$TS" "$ENV"`,
        `exit 0`,
      )
    } else {
      const stepOutputs = lastStep.outputs ?? defaultOutputs
      lines.push(buildBashEnvelope(stepOutputs), `exit 0`)
    }
    writeFileSync(shPath, lines.join('\n'))
    chmodSync(shPath, 0o755)
    return shPath
  }

  if (opts.clarify) {
    const clarifyEnv = `<workflow-clarify>${JSON.stringify({ questions: opts.clarify })}</workflow-clarify>`
    lines.push(
      ``,
      `ENV='${clarifyEnv.replace(/'/g, "'\\''")}'`,
      `TS=$(date +%s%3N)`,
      `printf '{"type":"text","ts":%s,"text":"%s"}\\n' "$TS" "$ENV"`,
      `exit 0`,
    )
    writeFileSync(shPath, lines.join('\n'))
    chmodSync(shPath, 0o755)
    return shPath
  }

  lines.push(``, buildBashEnvelope(defaultOutputs), `exit 0`)
  writeFileSync(shPath, lines.join('\n'))
  chmodSync(shPath, 0o755)
  return shPath
}

export function buildBashEnvelope(outputs: Record<string, string>): string {
  let envelope = `<workflow-output>\\n`
  for (const [p, c] of Object.entries(outputs)) {
    envelope += `  <port name="${p}">${c.replace(/'/g, "'\\''")}</port>\\n`
  }
  envelope += `</workflow-output>`
  // printf %s substitutes ENV verbatim - it does NOT JSON-escape. The envelope
  // contains `"` (every <port name="..."> attribute) which, left unescaped,
  // closes the JSON text string early and parseEnvelope reports malformed
  // (unclosed) ports - the task-fetch BP-01/02/03 CI failures on the .sh stub
  // path (ubuntu/macOS). Escape `"` -> `\"` so the emitted event is valid JSON.
  // Leave the literal `\n` (backslash-n) intact: printf %s passes it through
  // and JSON reads it as a newline escape, matching the .js stub's
  // JSON.stringify output. (Exported so the JSON-validity invariant is locked
  // by a platform-independent regression test - see stub-runtime-bash-envelope.)
  const jsonEnv = envelope.replace(/"/g, '\\"')
  return [
    `ENV='${jsonEnv}'`,
    `TS=$(date +%s%3N)`,
    `printf '{"type":"text","ts":%s,"text":"%s"}\\n' "$TS" "$ENV"`,
  ].join('\n')
}

// ─── Fake npm ──────────────────────────────────────────────────────────

export function writeFakeNpm(dir: string): string {
  const npmDir = join(dir, 'fake-npm-bin')
  mkdirSync(npmDir, { recursive: true })

  if (isWindows) {
    writeFakeNpmJs(npmDir)
  } else {
    writeFakeNpmSh(npmDir)
  }

  return npmDir
}

function writeFakeNpmJs(npmDir: string): void {
  // Use JSON.stringify for proper escaping of all string literals
  // Use \\n in template literals to produce \\n in generated source
  const js = `// Fake npm shim for Windows test compatibility
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const MODE = process.env.FAKE_NPM_MODE ?? 'success'
const args = process.argv.slice(2)

if (args.includes('--version')) {
  process.stdout.write('9.0.0\\n')
  process.exit(0)
}

const installIdx = args.indexOf('install')
if (installIdx === -1) {
  process.exit(0)
}

const installArgs = args.slice(installIdx + 1)
let prefix = ''
let spec = ''
for (let i = 0; i < installArgs.length; i++) {
  if (installArgs[i] === '--prefix' && installArgs[i + 1]) {
    prefix = installArgs[i + 1]
    i++
  } else if (installArgs[i].startsWith('--no-') || installArgs[i].startsWith('--silent') || installArgs[i].startsWith('-')) {
    // skip flags
  } else if (!installArgs[i].startsWith('-')) {
    spec = installArgs[i]
  }
}

if (MODE === 'fail') {
  process.stderr.write('ERR! 404 Not Found - GET https://registry.example.com/fake/' + spec + '\\n')
  process.stderr.write('ERR! 404 ' + spec + ' is not in the npm registry.\\n')
  process.exit(1)
} else if (MODE === 'timeout') {
  // Hang forever
  setInterval(() => {}, 60000)
} else if (MODE === 'leak-secret') {
  process.stderr.write('ERR! Failed at https://x-token-auth:SUPER_SECRET_TOKEN_123@example.com/foo\\n')
  process.exit(1)
} else {
  // Success path
  // Handle git specs like 'github:org/repo' -> package name is 'repo'
  let pkgName = spec.replace(/@[^@]*$/, '')
  if (pkgName.startsWith('github:')) {
    // github:org/repo -> repo
    const parts = pkgName.split('/')
    pkgName = parts[parts.length - 1] || pkgName
  } else if (pkgName.startsWith('git+') || pkgName.endsWith('.git')) {
    // git URL: extract a name from the last path segment
    pkgName = pkgName.replace(/\\.git$/, '')
    const parts = pkgName.split('/')
    pkgName = parts[parts.length - 1] || pkgName
    pkgName = pkgName.replace(/^git\\+/, '')
  }
  let installDir
  if (pkgName.startsWith('@')) {
    const scope = pkgName.split('/')[0]
    const name = pkgName.split('/').slice(1).join('/')
    installDir = join(prefix, 'node_modules', scope, name)
  } else {
    installDir = join(prefix, 'node_modules', pkgName)
  }
  const version = process.env.FAKE_NPM_VERSION ?? '2.4.1'

  for (const decoy of ['aaa-decoy-transitive', 'zzz-decoy-transitive']) {
    const decoyDir = join(prefix, 'node_modules', decoy)
    mkdirSync(decoyDir, { recursive: true })
    writeFileSync(join(decoyDir, 'package.json'), JSON.stringify({
      name: decoy,
      version: '9.9.9',
      main: 'index.js',
    }, null, 2))
  }

  mkdirSync(installDir, { recursive: true })
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({
    name: pkgName,
    version: version,
    main: 'index.js',
  }, null, 2))
  writeFileSync(join(installDir, 'index.js'), "export default { id: 'fake' }\\n")

  const hostPkg = join(prefix, 'package.json')
  if (existsSync(hostPkg)) {
    try {
      const content = readFileSync(hostPkg, 'utf-8')
      const updated = content.replace(
        /"dependencies":\\s*\\{\\}/,
        '"dependencies": { "' + pkgName + '": "^' + version + '" }'
      )
      writeFileSync(hostPkg, updated)
    } catch {}
  }

  process.exit(0)
}
`
  writeFileSync(join(npmDir, 'fake-npm.js'), js)

  // .cmd wrapper that calls bun on the .js
  const cmd = `@echo off\r\nbun "%~dp0fake-npm.js" %*\r\n`
  writeFileSync(join(npmDir, 'npm.cmd'), cmd)
}

function writeFakeNpmSh(npmDir: string): void {
  const sh = `#!/usr/bin/env bash
# RFC-031 fake npm shim — minimal subset for installPlugin tests.
set -e

MODE="\${FAKE_NPM_MODE:-success}"

if [[ "$1" == "--version" ]]; then
  echo "9.0.0"
  exit 0
fi

if [[ "$1" == "install" ]]; then
  PREFIX=""
  SPEC=""
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --prefix) PREFIX="$2"; shift 2 ;;
      --no-audit|--no-fund|--no-save|--silent) shift ;;
      -*) shift ;;
      *) SPEC="$1"; shift ;;
    esac
  done

  if [[ "$MODE" == "fail" ]]; then
    echo "ERR! 404 Not Found - GET https://registry.example.com/fake/\${SPEC}" >&2
    echo "ERR! 404 \${SPEC} is not in the npm registry." >&2
    exit 1
  fi

  if [[ "$MODE" == "timeout" ]]; then
    sleep 300
    exit 0
  fi

  if [[ "$MODE" == "leak-secret" ]]; then
    echo "ERR! Failed at https://x-token-auth:SUPER_SECRET_TOKEN_123@example.com/foo" >&2
    exit 1
  fi

  PKG_NAME="\${SPEC%@*}"
  # Handle git specs like 'github:org/repo' -> package name is 'repo'
  if [[ "$PKG_NAME" == github:* ]]; then
    PKG_NAME="\${PKG_NAME#github:*/}"
  elif [[ "$PKG_NAME" == git+* ]] || [[ "$PKG_NAME" == *.git ]]; then
    PKG_NAME="\${PKG_NAME%.git}"
    PKG_NAME="\${PKG_NAME##*/}"
    PKG_NAME="\${PKG_NAME#git+}"
  fi
  case "$PKG_NAME" in
    @*)
      SCOPE="\${PKG_NAME%%/*}"
      NAME="\${PKG_NAME#*/}"
      INSTALL_DIR="\${PREFIX}/node_modules/\${SCOPE}/\${NAME}"
      ;;
    *)
      INSTALL_DIR="\${PREFIX}/node_modules/\${PKG_NAME}"
      ;;
  esac
  VERSION="\${FAKE_NPM_VERSION:-2.4.1}"

  for DECOY in aaa-decoy-transitive zzz-decoy-transitive; do
    DECOY_DIR="\${PREFIX}/node_modules/\${DECOY}"
    mkdir -p "$DECOY_DIR"
    cat > "$DECOY_DIR/package.json" <<EOF
{
  "name": "\${DECOY}",
  "version": "9.9.9",
  "main": "index.js"
}
EOF
  done

  mkdir -p "$INSTALL_DIR"
  cat > "$INSTALL_DIR/package.json" <<EOF
{
  "name": "\${PKG_NAME}",
  "version": "\${VERSION}",
  "main": "index.js"
}
EOF
  cat > "$INSTALL_DIR/index.js" <<'EOF'
export default { id: 'fake' }
EOF

  HOST_PKG="\${PREFIX}/package.json"
  if [[ -f "$HOST_PKG" ]]; then
    TMP="\${HOST_PKG}.tmp"
    awk -v pkg="$PKG_NAME" -v ver="$VERSION" '
      {
        if ($0 ~ /"dependencies":[[:space:]]*\\{\\}/) {
          sub(/"dependencies":[[:space:]]*\\{\\}/, "\\"dependencies\\": { \\"" pkg "\\": \\"^" ver "\\" }")
        }
        print
      }
    ' "$HOST_PKG" > "$TMP" && mv "$TMP" "$HOST_PKG"
  fi
  exit 0
fi

exit 0
`
  const shPath = join(npmDir, 'fake-npm.sh')
  writeFileSync(shPath, sh)
  chmodSync(shPath, 0o755)

  try {
    symlinkSync(shPath, join(npmDir, 'npm'))
  } catch {
    copyFileSync(shPath, join(npmDir, 'npm'))
    chmodSync(join(npmDir, 'npm'), 0o755)
  }
}

// ─── Symlink helper ────────────────────────────────────────────────────

export function tryCreateSymlink(
  target: string,
  linkPath: string,
  type: 'file' | 'dir' = 'file',
): boolean {
  try {
    if (isWindows) {
      if (type === 'dir') {
        symlinkSync(target, linkPath, 'junction')
      } else {
        copyFileSync(target, linkPath)
      }
    } else {
      symlinkSync(target, linkPath, type)
    }
    return true
  } catch {
    return false
  }
}

// ─── chmod mode assertion helper ───────────────────────────────────────

export function expectFileMode(
  filePath: string,
  expectedMode: number,
  expectFn: (received: number, expected: number) => void,
): void {
  if (isWindows) {
    return
  }
  const mode = statSync(filePath).mode & 0o777
  expectFn(mode, expectedMode)
}

// ─── pgrep replacement ─────────────────────────────────────────────────

export function isProcessRunningByCmd(marker: string): boolean {
  if (isWindows) {
    try {
      const result = Bun.spawnSync({
        cmd: [
          'wmic',
          'process',
          'where',
          `CommandLine like '%${marker}%'`,
          'get',
          'ProcessId',
          '/format:list',
        ],
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stdout = result.stdout.toString()
      return /ProcessId=\d+/.test(stdout)
    } catch {
      return false
    }
  }
  try {
    const result = Bun.spawnSync({ cmd: ['pgrep', '-f', marker] })
    return result.exitCode === 0
  } catch {
    return false
  }
}

// ─── Cross-platform mkdir ──────────────────────────────────────────────

/**
 * Create a directory recursively. Cross-platform replacement for `execSync('mkdir -p ...')`.
 */
export function mkdirp(dir: string): void {
  mkdirSync(dir, { recursive: true })
}
