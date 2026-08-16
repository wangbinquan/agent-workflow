// RFC-253 — the script node's pure oracles. No IO, browser-safe: the canvas
// Inspector, the validator, the permission gate and the executor all read
// their answers from HERE so the four can never drift.
//
// Field readers are tolerant (`WorkflowNodeSchema` is `.passthrough()`, so a
// stored node is a bag of unknowns until the strict `ScriptNodeSchema` runs at
// the write boundary): a malformed field degrades to its default rather than
// throwing inside a canvas render.

import {
  SCRIPT_DEFAULT_OUTPUT_PORT,
  SCRIPT_DEPENDENCY_MAX_LEN,
  SCRIPT_LANGUAGES,
  type ScriptLanguage,
  type ScriptOutputPort,
  type WorkflowDefinition,
  type WorkflowNode,
} from './schemas/workflow'
import { canonicalJson } from './workflow-canonical'
import { inboundEdgeSignature, wrapperAncestryOf } from './workflowNodeAncestry'

// ---------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------

function record(node: WorkflowNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>
}

export function readScriptLanguage(node: WorkflowNode): ScriptLanguage | undefined {
  const raw = record(node).language
  return typeof raw === 'string' && (SCRIPT_LANGUAGES as readonly string[]).includes(raw)
    ? (raw as ScriptLanguage)
    : undefined
}

export function readScriptBody(node: WorkflowNode): string {
  const raw = record(node).script
  return typeof raw === 'string' ? raw : ''
}

/** Declared output ports in declaration order, dropping malformed rows. */
export function readScriptOutputPorts(node: WorkflowNode): ScriptOutputPort[] {
  const raw = record(node).outputs
  if (!Array.isArray(raw)) return []
  const out: ScriptOutputPort[] = []
  for (const entry of raw) {
    const row = entry as { name?: unknown; kind?: unknown; branch?: unknown } | null
    if (typeof row?.name !== 'string' || row.name.length === 0) continue
    out.push({
      name: row.name,
      ...(typeof row.kind === 'string' ? { kind: row.kind } : {}),
      // RFC-306: only a literal `true` declares a branch port. Anything else
      // (absent, 'true', 1, null) leaves it undeclared — a runtime marker on it
      // then fails loudly instead of quietly deactivating a branch.
      ...(row.branch === true ? { branch: true } : {}),
    })
  }
  return out
}

export function readScriptDependencies(node: WorkflowNode): string[] {
  const raw = record(node).dependencies
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === 'string')
}

export function readScriptEnv(node: WorkflowNode): Record<string, string> {
  const raw = record(node).env
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/** D8 — absent resolves to false (writable + iso + merge-back). */
export function resolveScriptReadonly(node: WorkflowNode): boolean {
  return record(node).readonly === true
}

// ---------------------------------------------------------------------------
// Output shape (D3 / D22)
// ---------------------------------------------------------------------------

export type ScriptOutputMode = 'single' | 'envelope'

/**
 * D3 — the mode is decided by ONE observable fact: did the author declare
 * output ports? No second knob, so "which protocol does this node speak" is
 * never ambiguous to the author, the validator or the executor.
 */
export function scriptOutputMode(node: WorkflowNode): ScriptOutputMode {
  return readScriptOutputPorts(node).length > 0 ? 'envelope' : 'single'
}

/** The node's outlets: declared ports, or the implicit single `stdout`. */
export function declaredScriptOutputs(
  node: WorkflowNode,
): Array<{ name: string; kind?: string; branch?: boolean }> {
  const declared = readScriptOutputPorts(node)
  if (declared.length === 0) return [{ name: SCRIPT_DEFAULT_OUTPUT_PORT }]
  // Dedup by name so a duplicate (which the validator rejects) still renders a
  // stable handle set instead of colliding React keys.
  const seen = new Set<string>()
  const out: Array<{ name: string; kind?: string; branch?: boolean }> = []
  for (const port of declared) {
    if (seen.has(port.name)) continue
    seen.add(port.name)
    // RFC-306: `branch` only ever appears as `true` — see the agent deriver's
    // note; a false/absent flag must leave the object byte-identical to before.
    out.push({
      name: port.name,
      ...(port.kind === undefined ? {} : { kind: port.kind }),
      ...(port.branch === true ? { branch: true } : {}),
    })
  }
  return out
}

/** RFC-306 — declared branch ports of a script node (empty in single-port mode). */
export function scriptBranchPorts(node: WorkflowNode): string[] {
  if (scriptOutputMode(node) === 'single') return []
  return declaredScriptOutputs(node)
    .filter((p) => p.branch === true)
    .map((p) => p.name)
}

// ---------------------------------------------------------------------------
// Port → environment variable mapping (D5)
// ---------------------------------------------------------------------------

export const SCRIPT_ENV_VALUE_PREFIX = 'AW_PORT_'
export const SCRIPT_ENV_FILE_PREFIX = 'AW_PORT_FILE_'

/** Single-value inline ceiling; larger values spill to `$AW_INPUT_DIR`. */
export const SCRIPT_ENV_INLINE_LIMIT = 32 * 1024
/** Ceiling on the SUM of inline values — the real `E2BIG` risk is aggregate. */
export const SCRIPT_ENV_TOTAL_LIMIT = 256 * 1024

/**
 * Port name → environment variable suffix. Uppercased, every character outside
 * `[A-Z0-9_]` folded to `_`, digit-leading names prefixed so the result is a
 * POSIX-legal identifier.
 *
 * The folding is lossy ON PURPOSE (a legible `AW_PORT_MY_PORT` beats an escaped
 * mangling), which means two distinct port names CAN land on the same suffix —
 * `scriptPortEnvCollisions` exists so the validator rejects that at save time
 * instead of letting one value silently shadow the other at run time.
 */
export function scriptEnvSuffix(portName: string): string {
  const folded = portName.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  return /^[0-9]/.test(folded) ? `_${folded}` : folded
}

export interface ScriptPortEnvCollision {
  suffix: string
  /** The colliding port names, in input order. */
  portNames: string[]
}

/** Every suffix claimed by more than one port name. */
export function scriptPortEnvCollisions(portNames: readonly string[]): ScriptPortEnvCollision[] {
  const bySuffix = new Map<string, string[]>()
  for (const name of portNames) {
    const suffix = scriptEnvSuffix(name)
    const list = bySuffix.get(suffix)
    if (list === undefined) bySuffix.set(suffix, [name])
    else if (!list.includes(name)) list.push(name)
  }
  const out: ScriptPortEnvCollision[] = []
  for (const [suffix, names] of bySuffix) {
    if (names.length > 1) out.push({ suffix, portNames: names })
  }
  return out
}

export interface ScriptPortEnvPlan {
  /** `AW_PORT_<SUFFIX>` → value, for values kept inline. */
  inline: Record<string, string>
  /** Values that must be written to `$AW_INPUT_DIR/<portName>` instead. */
  spilled: Array<{ portName: string; envName: string; value: string }>
  /** Original port name → suffix, published to the script as `AW_PORT_NAMES`. */
  suffixByPort: Record<string, string>
}

/**
 * UTF-8 byte length without `TextEncoder`/`Buffer` — this package is isomorphic
 * and its tsconfig carries neither the DOM nor the Node lib. Surrogate pairs are
 * counted once (4 bytes), which is what the OS argv/env accounting sees.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
        continue
      }
      bytes += 3
    } else bytes += 3
  }
  return bytes
}

/**
 * Decide which upstream values ride in the environment and which spill to disk.
 *
 * Ordering is deterministic (sorted by port name) so the same inputs always
 * produce the same plan — an aggregate-limit decision that depended on object
 * key order would make "did my 30 KiB value spill?" unanswerable.
 *
 * A spilled value sets ONLY `AW_PORT_FILE_<SUFFIX>`; the inline variable is
 * left absent rather than truncated, so a script can never silently read half
 * a value and believe it read all of it.
 */
export function planScriptPortEnv(inputs: Record<string, string>): ScriptPortEnvPlan {
  const plan: ScriptPortEnvPlan = { inline: {}, spilled: [], suffixByPort: {} }
  let inlineBytes = 0
  for (const portName of Object.keys(inputs).sort()) {
    const value = inputs[portName] ?? ''
    const suffix = scriptEnvSuffix(portName)
    plan.suffixByPort[portName] = suffix
    const bytes = utf8ByteLength(value)
    if (bytes > SCRIPT_ENV_INLINE_LIMIT || inlineBytes + bytes > SCRIPT_ENV_TOTAL_LIMIT) {
      plan.spilled.push({ portName, envName: `${SCRIPT_ENV_FILE_PREFIX}${suffix}`, value })
      continue
    }
    inlineBytes += bytes
    plan.inline[`${SCRIPT_ENV_VALUE_PREFIX}${suffix}`] = value
  }
  return plan
}

// ---------------------------------------------------------------------------
// Author snippets (T43 / AC-37…40)
// ---------------------------------------------------------------------------
//
// Why these live in shared rather than in the Inspector: the snippets are the
// ONLY place the platform tells an author how to speak the two protocols, so
// they must be generated from the same oracles the executor obeys —
// `scriptEnvSuffix` for the variable names, the envelope grammar for the output
// — or the instructions drift away from the runtime and the author debugs a
// framework bug as if it were their own.
//
// The nonce is ALWAYS read from `AW_ENVELOPE_NONCE` at run time and never
// rendered as a literal. D5 is explicit that the platform substitutes nothing
// into a script body, so a snippet that showed `nonce="$AW_ENVELOPE_NONCE"` as
// text would be correct for bash (the shell expands it) and silently wrong for
// python / node — the exact confusion that produced this task: the body would
// print a literal `$AW_ENVELOPE_NONCE`, the parser would not match it, and the
// node would burn its retries on `script-envelope-missing`.

/** Placeholder each generated port body carries; the author replaces it. */
export const SCRIPT_SNIPPET_PLACEHOLDER = 'TODO'

/**
 * A port name that can never appear in an envelope: `PORT_OPEN_RE`
 * (`services/envelope.ts`) accepts `name="…"` or `name='…'`, and a name holding
 * BOTH quote characters fits inside neither. Declaring one guarantees
 * `script-port-missing` on every single run, so the validator refuses it at
 * save time (AC-40) — the generator stays defensive anyway, since a definition
 * written before that rule existed still has to render something.
 */
export function scriptPortNameUnquotable(name: string): boolean {
  return name.includes('"') && name.includes("'")
}

/** `name="x"`, or `name='x'` when the name itself contains a double quote. */
function portOpenTag(name: string): string {
  const quote = name.includes('"') ? "'" : '"'
  return `<port name=${quote}${name}${quote}>`
}

/**
 * A single-quoted string literal — the escaping happens to be identical for
 * python and JavaScript, and both reject a raw newline inside one, so control
 * characters have to become escapes rather than pass through.
 */
function singleQuotedLiteral(value: string): string {
  const body = value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
  return `'${body}'`
}

/**
 * Text inside an UNQUOTED heredoc delimiter. The delimiter cannot be quoted —
 * that is precisely what makes `$AW_ENVELOPE_NONCE` expand — so the three
 * characters the shell still acts on have to be escaped.
 */
function heredocText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('$', '\\$')
}

/** Port name rendered safely into a trailing `# port '…'` comment. */
function commentSafe(name: string): string {
  return name.replaceAll('\r', ' ').replaceAll('\n', ' ')
}

/**
 * The envelope every declared-port script must print (D3). Empty when no ports
 * are declared: single-port mode IS the whole stdout, and handing that author
 * an envelope would teach them a protocol they must not use.
 */
export function buildScriptEnvelopeSnippet(
  language: ScriptLanguage,
  ports: readonly string[],
): string {
  if (ports.length === 0) return ''
  const header = `# Replace ${SCRIPT_SNIPPET_PLACEHOLDER} with each port's real value.`
  const body = (name: string) => `${portOpenTag(name)}${SCRIPT_SNIPPET_PLACEHOLDER}</port>`

  if (language === 'bash') {
    return [
      header,
      'cat <<EOF',
      // `$AW_ENVELOPE_NONCE` is left unescaped ON PURPOSE — the shell expanding
      // it is exactly how bash gets the run's nonce.
      '<workflow-output nonce="$AW_ENVELOPE_NONCE">',
      ...ports.map((name) => heredocText(body(name))),
      '</workflow-output>',
      'EOF',
      '',
    ].join('\n')
  }

  if (language === 'node') {
    return [
      header.replace(/^# /, '// '),
      'const nonce = process.env.AW_ENVELOPE_NONCE',
      "console.log('<workflow-output nonce=\"' + nonce + '\">')",
      ...ports.map((name) => `console.log(${singleQuotedLiteral(body(name))})`),
      "console.log('</workflow-output>')",
      '',
    ].join('\n')
  }

  return [
    header,
    'import os',
    '',
    "nonce = os.environ['AW_ENVELOPE_NONCE']",
    "print('<workflow-output nonce=\"' + nonce + '\">')",
    ...ports.map((name) => `print(${singleQuotedLiteral(body(name))})`),
    "print('</workflow-output>')",
    '',
  ].join('\n')
}

/**
 * Reading the upstream ports (D5). The generated helper checks the SPILL
 * variable first: a value over `SCRIPT_ENV_INLINE_LIMIT` sets only
 * `AW_PORT_FILE_<SUFFIX>` and leaves `AW_PORT_<SUFFIX>` absent, so a script
 * that reads the environment alone works on a small diff and silently reads an
 * empty string on a large one (AC-3 — invisible in the UI until now).
 */
export function buildScriptInputSnippet(
  language: ScriptLanguage,
  ports: readonly string[],
): string {
  if (ports.length === 0) return ''
  const rows = ports.map((name) => ({ name, suffix: scriptEnvSuffix(name) }))

  if (language === 'bash') {
    return [
      'read_port() {',
      '  # A large upstream value is written to a file instead of the environment.',
      '  local file_var="AW_PORT_FILE_$1"',
      '  local value_var="AW_PORT_$1"',
      '  if [ -n "${!file_var:-}" ]; then',
      '    cat "${!file_var}"',
      '  else',
      '    printf \'%s\' "${!value_var:-}"',
      '  fi',
      '}',
      '',
      '# NOTE: $( ) strips trailing newlines — read the file directly if they matter.',
      ...rows.map(
        (row) => `${row.suffix}="$(read_port ${row.suffix})"  # port ${commentSafe(row.name)}`,
      ),
      '',
    ].join('\n')
  }

  if (language === 'node') {
    return [
      // The platform runs node scripts as `script.mjs` (ESM), so this is
      // `import`, not `require` — a `require` snippet would not even start.
      "import { readFileSync } from 'node:fs'",
      '',
      'function readPort(suffix) {',
      '  // A large upstream value is written to a file instead of the environment.',
      "  const file = process.env['AW_PORT_FILE_' + suffix]",
      "  if (file) return readFileSync(file, 'utf8')",
      "  return process.env['AW_PORT_' + suffix] ?? ''",
      '}',
      '',
      ...rows.map(
        (row) =>
          `const ${row.suffix} = readPort(${singleQuotedLiteral(row.suffix)}) // port ${commentSafe(row.name)}`,
      ),
      '',
    ].join('\n')
  }

  return [
    'import os',
    '',
    'def read_port(suffix):',
    '    # A large upstream value is written to a file instead of the environment.',
    "    path = os.environ.get('AW_PORT_FILE_' + suffix)",
    '    if path:',
    "        with open(path, encoding='utf-8') as fh:",
    '            return fh.read()',
    "    return os.environ.get('AW_PORT_' + suffix, '')",
    '',
    ...rows.map(
      (row) =>
        `${row.suffix} = read_port(${singleQuotedLiteral(row.suffix)})  # port ${commentSafe(row.name)}`,
    ),
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Dependency specs (D14 / AC-19 / AC-19b)
// ---------------------------------------------------------------------------

/**
 * pip: `name[extra,extra]==1.2.3`. npm: `[@scope/]name@1.2.3`.
 *
 * The two grammars are SEPARATE (design-gate F10): a single pattern that tried
 * to serve both matched neither cleanly — it rejected `@scope/pkg@1.2.3` while
 * accepting `pkg^1.2.3`, which pip does not understand.
 */
// impl-gate (Codex 7): these previously accepted `requests==2.*`, `lodash@4`
// and `lodash@4.17` — none of which pin anything. "Exact" now means a full
// dotted release: at least major.minor.patch, and no wildcard segment.
const PIP_SPEC_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9][A-Za-z0-9,._-]*\])?==[0-9]+(?:\.[0-9]+){2,}(?:[A-Za-z0-9.+_-]*)$/
const NPM_SPEC_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*@[0-9]+(?:\.[0-9]+){2}(?:[A-Za-z0-9.+-]*)$/

/**
 * The single reason a dependency spec is refused, or null when it is fine.
 *
 * Exact pins are MANDATORY (AC-19b): the prepared environment is cached by a
 * hash of this list and only resolved on a cold cache, so an unpinned spec
 * means the same authorized definition can install different bytes at different
 * times. Determinism is the whole reason a script node exists.
 */
export function scriptDependencyIssue(language: ScriptLanguage, spec: string): string | null {
  if (language === 'bash') return `bash scripts cannot declare dependencies`
  if (spec.length === 0) return 'dependency spec is empty'
  if (spec.length > SCRIPT_DEPENDENCY_MAX_LEN) {
    return `dependency spec is too long (max ${SCRIPT_DEPENDENCY_MAX_LEN})`
  }
  // Checked before the grammar so the message names the actual problem rather
  // than the generic "malformed".
  if (spec.startsWith('-')) return `dependency '${spec}' looks like a command-line flag`
  // `<` and `>` are deliberately NOT in this set: they are pip's own range
  // comparators, and the argv the platform builds never passes through a shell,
  // so they cannot do anything here. Rejecting them as "shell metacharacters"
  // would give the author a misleading reason for what is really an unpinned
  // version — the grammar check below produces the accurate message.
  if (/[\s;&|`$(){}'"\\]/.test(spec)) return `dependency '${spec}' contains shell metacharacters`
  if (/[/:]/.test(spec) && !spec.startsWith('@')) {
    return `dependency '${spec}' looks like a URL, path or VCS spec — only packages from the default index are accepted`
  }
  if (language === 'python') {
    if (!PIP_SPEC_RE.test(spec)) {
      return /[<>~^!]|(?:^[^=]*$)/.test(spec)
        ? `dependency '${spec}' must pin an exact version, e.g. 'requests==2.32.3'`
        : `dependency '${spec}' is not a plain package name with an exact '==' version`
    }
    return null
  }
  if (!NPM_SPEC_RE.test(spec)) {
    return /[<>~^]|(?:^[^@]*$)|(?:^@[^@]*$)/.test(spec)
      ? `dependency '${spec}' must pin an exact version, e.g. 'lodash@4.17.21'`
      : `dependency '${spec}' is not a plain package name with an exact '@' version`
  }
  return null
}

/** Canonical spec list: trimmed, deduped, sorted — order must not change the
 *  cache identity of an otherwise identical environment. */
export function normalizeScriptDependencies(specs: readonly string[]): string[] {
  return [...new Set(specs.map((s) => s.trim()).filter((s) => s.length > 0))].sort()
}

/**
 * Canonical bytes identifying one prepared dependency environment. The CALLER
 * hashes it (`workflow-canonical.ts` precedent: shared owns canonicalization,
 * crypto stays at the boundary that has it).
 *
 * The interpreter identity participates: the same specs under a different
 * python are a different ABI and must not share a cache directory.
 */
export const SCRIPT_DEPS_ENV_DOMAIN_V1 = 'script-deps-env/v1\n'
export function serializeScriptDepsEnvKeyV1(input: {
  language: ScriptLanguage
  interpreterPath: string
  interpreterVersion: string
  specs: readonly string[]
}): string {
  return `${SCRIPT_DEPS_ENV_DOMAIN_V1}${canonicalJson({
    language: input.language,
    interpreterPath: input.interpreterPath,
    interpreterVersion: input.interpreterVersion,
    specs: normalizeScriptDependencies(input.specs),
  })}`
}

// ---------------------------------------------------------------------------
// Sensitive projection (D20)
// ---------------------------------------------------------------------------

export const SCRIPT_SENSITIVE_PROJECTION_DOMAIN_V1 = 'workflow-script-sensitive/v1\n'

/**
 * D20 — the exact slice of a definition that `scripts:author` governs.
 *
 * What is in: the node's own execution fields, the SHAPE of its inputs (which
 * ports feed it, from where) and its wrapper ancestry with the loop terms that
 * decide how many times it runs. What is out: position, title, and edits to
 * other node kinds — so a user without the point can still lay out a workflow
 * that happens to contain a script.
 *
 * ⚠ Scope limit, stated rather than implied (impl-gate 1.2): this governs the
 * SHAPE of what runs, NOT the CONTENT that flows in. Rewriting an upstream
 * agent's prompt changes the bytes that arrive in `AW_PORT_*` while leaving
 * this projection identical, and that is inherent — every upstream node's
 * output is data this script consumes, so "govern the content too" would mean
 * `scripts:author` governs the entire graph. A script that pipes an input into
 * a shell is therefore as trusted as its upstream; that is a property of the
 * script, and the node's own body IS gated.
 *
 * Returns canonical BYTES, not a hash: the gate compares strings, which is
 * exact by construction — no collision surface to reason about, and a mismatch
 * can be diffed when someone has to debug a 403.
 *
 * `id` participates so that moving a body between two nodes (which swaps which
 * node executes what) is a change, and node order is normalized so that merely
 * reordering `nodes[]` is not.
 */
export function serializeScriptSensitiveProjectionV1(definition: WorkflowDefinition): string {
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

  const rows = definition.nodes
    .filter((node) => node.kind === 'script')
    .map((node) => ({
      id: node.id,
      language: readScriptLanguage(node) ?? null,
      script: readScriptBody(node),
      outputs: readScriptOutputPorts(node).map((port) => ({
        name: port.name,
        kind: port.kind ?? null,
      })),
      dependencies: readScriptDependencies(node),
      env: Object.fromEntries(Object.entries(readScriptEnv(node)).sort(([a], [b]) => cmp(a, b))),
      readonly: resolveScriptReadonly(node),
      // RFC-269 抽取：入边决定 `AW_PORT_*` 的名字与取值、wrapper 归属决定跑不跑
      // 与跑几次 —— 两段推理与代码平台调用节点逐字相同，故由
      // `workflowNodeAncestry.ts` 共用（含 impl-gate 1.2 的完整祖先链修正）。
      // 字段名与顺序保持不变，投影字节因此与抽取前完全一致。
      inbound: inboundEdgeSignature(definition, node.id),
      wrappers: wrapperAncestryOf(definition, node.id),
    }))
    .sort((a, b) => cmp(a.id, b.id))
  return `${SCRIPT_SENSITIVE_PROJECTION_DOMAIN_V1}${canonicalJson(rows)}`
}

/** True when the definition contains at least one script node. */
export function definitionHasScriptNode(definition: WorkflowDefinition): boolean {
  return definition.nodes.some((node) => node.kind === 'script')
}

// ---------------------------------------------------------------------------
// Reserved environment keys (design-gate P1)
// ---------------------------------------------------------------------------

/**
 * Keys a node's `env` map may NOT set.
 *
 * `mcpEnvIssues` is reused for the generic rules (legal identifier, no NUL, no
 * dynamic-loader variables) but it deliberately ALLOWS `PYTHONPATH` and
 * `NODE_OPTIONS` — reasonable for an MCP child, unsafe here: those two load
 * arbitrary code before the authored body or override the deterministic
 * dependency environment.
 *
 * The platform writes its own keys LAST regardless, so this table is the
 * save-time diagnostic that tells the author why their variable was refused
 * instead of letting it be silently overwritten at run time.
 */
export const SCRIPT_RESERVED_ENV_KEYS: readonly string[] = [
  'PWD',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'NODE_PATH',
  'NODE_OPTIONS',
  // Kept platform-owned because it protects stdout's byte contract on Windows.
  'PYTHONUTF8',
]

export const SCRIPT_RESERVED_ENV_PREFIXES: readonly string[] = [
  'AW_',
  'GIT_',
  // impl-gate 4.3: the loader families were only refused at SAVE time by
  // `mcpEnvIssues`, so the runtime filter — the layer this file's own comment
  // calls "defence in depth" — had no second line for exactly the variables
  // that load arbitrary code before the script's first statement.
  'LD_',
  'DYLD_',
]

/** Shell startup files run before the script body; bash reads these. */
const SCRIPT_RESERVED_SHELL_STARTUP: readonly string[] = ['BASH_ENV', 'ENV']

/** Why this env key is refused for a script node, or null when it is fine. */
export function scriptReservedEnvKeyIssue(key: string): string | null {
  const upper = key.toUpperCase()
  if (SCRIPT_RESERVED_ENV_KEYS.includes(upper)) {
    return `env key '${key}' is reserved by the platform and cannot be overridden`
  }
  for (const prefix of SCRIPT_RESERVED_ENV_PREFIXES) {
    if (upper.startsWith(prefix)) {
      return `env key '${key}' uses the reserved '${prefix}' prefix`
    }
  }
  if (SCRIPT_RESERVED_SHELL_STARTUP.includes(upper)) {
    return `env key '${key}' would make the shell run a startup file before the script`
  }
  return null
}
