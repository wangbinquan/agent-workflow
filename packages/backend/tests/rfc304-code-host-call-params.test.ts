// RFC-304 — every code-host call a capability makes must name its params the
// way the client reads them.
//
// Four call sites passed `__project__` as a params KEY. That is the name of the
// path placeholder, not of a param: `executeCodeHostCall` fills `{__project__}`
// from the explicit `project` param, and a capability's `projectFallback` is
// wired to a REFUSAL on purpose (guessing the project would send the request to
// whichever repository the task happens to sit in). So each of those calls could
// only ever return "a capability call reached the project fallback".
//
// What that cost, undetected: `mr-comment-fix` could not read the discussion it
// exists to answer, `requirement` could not open its merge request after doing
// all the work and pushing the branch, and every notification `ci-fix` posts —
// its entire voice on the MR — failed. Three capabilities, dead at the point
// where they touch the outside world.
//
// None of it was visible from inside. Unit tests hand the params in and assert
// on what the stage did with the response, so they agree with whatever the call
// site spells; the e2e that finally caught it drove a real thread through the
// mock. Between "the params are wrong" and "somebody notices" there was no
// error, no round, nothing to alert on.
//
// This reads the call sites themselves and checks them against the same field
// registry the client uses, so a name that no longer exists — or never did —
// fails here rather than in production. It is a static check on purpose: the
// alternative is one e2e per call site, and the calls that broke were exactly
// the ones no e2e reached.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import {
  codeHostActionFields,
  codeHostRequiredFields,
  CODE_HOST_ACTIONS,
  type CodeHostAction,
  type CodeHostProvider,
} from '@agent-workflow/shared'

const REPO_SRC = resolve(import.meta.dir, '..', 'src')
const MODULE_DIR = join(REPO_SRC, 'modules', 'code-capability')
const PROVIDERS: readonly CodeHostProvider[] = ['gitlab', 'github']

interface CallSite {
  readonly file: string
  readonly line: number
  readonly action: string
  readonly keys: readonly string[]
  /**
   * Whether the whole params object is readable here. A spread, or a `params`
   * that is a variable rather than a literal, means keys arrive from elsewhere
   * — so an absence proves nothing and only the keys present are checked.
   */
  readonly complete: boolean
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/** The `{ action, params }` argument of every `<something>.call(...)`. */
function collectCallSites(file: string): CallSite[] {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
  const sites: CallSite[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'call' &&
      node.arguments.length > 0
    ) {
      const arg = node.arguments[0]
      if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
        const action = arg.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) && p.name.getText(source) === 'action',
        )
        // A computed action (a variable, a ternary) cannot be checked against a
        // field list; those are left to their own tests rather than guessed at.
        if (action !== undefined && ts.isStringLiteralLike(action.initializer)) {
          const params = arg.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText(source) === 'params',
          )
          const literal =
            params !== undefined && ts.isObjectLiteralExpression(params.initializer)
              ? params.initializer
              : null
          sites.push({
            file: relative(REPO_SRC, file),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            action: action.initializer.text,
            keys:
              literal === null
                ? []
                : literal.properties
                    .filter(
                      (p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
                        ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p),
                    )
                    .map((p) => p.name.getText(source).replace(/^['"`]|['"`]$/g, '')),
            complete: literal !== null && !literal.properties.some(ts.isSpreadAssignment),
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites
}

/**
 * Everything under the module, plus any file that builds a capability's code
 * host — `createCodeHostAdapter` is precisely what wires `projectFallback` to a
 * refusal, so its callers live under the same rules wherever they sit. The
 * scheduler's own call path is deliberately NOT included: there, a blank
 * project legitimately means "the task's repository".
 *
 * The fifth site with this bug was in `services/`, not in the module.
 */
const SCANNED = tsFilesUnder(REPO_SRC).filter(
  (file) =>
    file.startsWith(MODULE_DIR) || readFileSync(file, 'utf8').includes('createCodeHostAdapter('),
)
const SITES = SCANNED.flatMap(collectCallSites)

/** Field names the client will actually read, across both providers. */
function knownFields(action: CodeHostAction): Set<string> {
  const names = new Set<string>()
  for (const provider of PROVIDERS) {
    for (const field of codeHostActionFields(action, provider)) names.add(field.name)
  }
  // Resolved separately from the field list, and legal at every call site.
  names.add('project')
  return names
}

/** Required of BOTH providers — the part a shared call site must always fill. */
function alwaysRequired(action: CodeHostAction): string[] {
  const [first, ...rest] = PROVIDERS.map((p) => new Set(codeHostRequiredFields(action, p)))
  if (first === undefined) return []
  return [...first].filter((name) => rest.every((set) => set.has(name)))
}

describe('RFC-304 — the params capabilities send to the code host', () => {
  test('the module has code-host call sites to check at all', () => {
    // Without this, a rename of `.call` or a move of the module would turn the
    // whole file into a vacuous pass — the failure mode every static lock has.
    expect(SITES.length).toBeGreaterThanOrEqual(15)
  })

  test('every params key is a field the client reads', () => {
    // The exact bug: `__project__` is a path placeholder, not a param, so the
    // call resolved no project and was refused. A key the registry does not
    // know is either a typo or a field that has since been renamed; both are
    // silent, because unknown params are simply not sent.
    const unknown = SITES.flatMap((site) => {
      if (!CODE_HOST_ACTIONS.includes(site.action as CodeHostAction)) return []
      const known = knownFields(site.action as CodeHostAction)
      return site.keys
        .filter((key) => !known.has(key))
        .map(
          (key) =>
            `${site.file}:${String(site.line)} — '${site.action}' has no param '${key}' (it takes: ${[...known].sort().join(', ')})`,
        )
    })
    expect(unknown).toEqual([])
  })

  test('every action named is one the client supports', () => {
    const unsupported = SITES.filter(
      (site) => !CODE_HOST_ACTIONS.includes(site.action as CodeHostAction),
    ).map((site) => `${site.file}:${String(site.line)} — unknown action '${site.action}'`)
    expect(unsupported).toEqual([])
  })

  test('a capability always supplies its own project', () => {
    // `projectFallback` is a refusal for capabilities — deliberately, so that a
    // missing project is loud rather than sent to the task's repository. Which
    // means a call site that omits `project` cannot work, ever.
    const missing = SITES.filter((site) => site.complete && !site.keys.includes('project')).map(
      (site) =>
        `${site.file}:${String(site.line)} — '${site.action}' passes no 'project'; capabilities resolve one in resolve-target and the fallback is a refusal`,
    )
    expect(missing).toEqual([])
  })

  test('every call fills the fields both providers require', () => {
    // Provider-specific requirements (GitHub's `comment_scope`) are added by
    // conditional spreads, which relax the check for that site; what is left is
    // the set no provider can do without.
    const short = SITES.flatMap((site) => {
      if (!site.complete) return []
      if (!CODE_HOST_ACTIONS.includes(site.action as CodeHostAction)) return []
      return alwaysRequired(site.action as CodeHostAction)
        .filter((field) => !site.keys.includes(field))
        .map(
          (field) =>
            `${site.file}:${String(site.line)} — '${site.action}' requires '${field}' and does not pass it`,
        )
    })
    expect(short).toEqual([])
  })

  test('`__project__` never appears as a params key anywhere in the module', () => {
    // Belt to the AST's braces: a call whose action is computed escapes the
    // checks above, and this one name is never right in a params position.
    const offenders = SCANNED.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          /^\s*__project__\s*:/.test(line)
            ? [`${relative(REPO_SRC, file)}:${String(index + 1)}`]
            : [],
        ),
    )
    expect(offenders).toEqual([])
  })
})
