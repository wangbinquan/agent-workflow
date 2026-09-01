// RFC-348 — the intent capability-teaching registries (design §1.2/§1.3/§1.5,
// §9). Locks, in one place:
//
//  - every authorable node kind / resource type renders every non-omitted
//    field name (nested and variant sub-tables included) and never an omitted
//    one; the `?` insertion never produces `??`;
//  - `availability` agrees with the shared SSOTs (`isSynthesizedOnlyNodeKind`,
//    the two permission points `privilegedNodeLensFor` reads, the shared
//    redaction constants by identity);
//  - the five passthrough node kinds and the four passthrough input kinds have
//    REAL read points (forward AST check) and the validator / launch / frontend
//    read sites name nothing the registries do not teach (reverse AST check,
//    with resident baselines so drift is visible in either direction);
//  - the platform capability map is complementary to `INTENT_RESOURCE_TYPES`
//    and every `route` entry matches the frontend route table;
//  - field-adjacent counter-examples stay on their field's line while entry
//    level mistakes reach the Common-mistakes section.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import {
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_OUTPUT_PORT_NAME,
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  CODE_HOST_REDACTED_FIELDS,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
  INTENT_RESOURCE_TYPES,
  LOOP_EXIT_CONDITION_KINDS,
  NODE_KIND,
  OPENCODE_PERMISSION_ACTIONS,
  OPENCODE_PERMISSION_KEYS,
  SCRIPT_REDACTED_FIELDS,
  WORKFLOW_INPUT_KIND,
  isSynthesizedOnlyNodeKind,
  type AclResourceType,
  type NodeKind,
} from '@agent-workflow/shared'
import { INTENT_NODE_TEACHING } from '../src/modules/intent/domain/teaching/nodeKinds'
import {
  INTENT_PLATFORM_RESOURCE_MAP,
  platformOnlyResourceTypes,
} from '../src/modules/intent/domain/teaching/platformMap'
import {
  authorableNodeKinds,
  collectFieldNames,
  collectOmittedFieldNames,
  renderCommonMistakes,
  renderDeliveryBudget,
  renderNodeForm,
  renderOutputContract,
  renderOutputDeclarations,
  renderPermissionGrammar,
  renderPlatformCapabilityMap,
  renderPlatformModel,
  renderRequestedArtifactType,
  REQUESTED_ARTIFACT_NONE,
  REQUESTED_ARTIFACT_PICKED,
  renderResourceLine,
  renderSupportedNodeForms,
  renderWorkingDirectoryLayout,
  withheldPrivilegedNodeKinds,
  type IntentDocPrivileges,
} from '../src/modules/intent/domain/teaching/render'
import { INTENT_RESOURCE_TEACHING } from '../src/modules/intent/domain/teaching/resourceTypes'
import type { IntentPassthroughFieldSource } from '../src/modules/intent/domain/teaching/types'
import {
  INPUT_FIELD_OWNERSHIP,
  WORKFLOW_EDGE_TEACHING,
  WORKFLOW_INPUT_BASE_TEACHING,
  WORKFLOW_INPUT_TEACHING,
  WORKFLOW_OUTPUT_TEACHING,
  WORKFLOW_PORT_REF_TEACHING,
} from '../src/modules/intent/domain/teaching/workflowParts'
import { privilegedNodeLensFor } from '../src/services/privilegedNodeLens'

const ALL: IntentDocPrivileges = { mayAuthorScripts: true, mayAuthorCodeHostCalls: true }
const NONE: IntentDocPrivileges = { mayAuthorScripts: false, mayAuthorCodeHostCalls: false }
const REPO_ROOT = resolve(import.meta.dir, '../../..')

type LooseFields = Parameters<typeof collectFieldNames>[0]
const nodeFields = (kind: NodeKind): LooseFields =>
  ((INTENT_NODE_TEACHING[kind] as { fields?: LooseFields }).fields ?? {}) as LooseFields
const resourceFields = (type: (typeof INTENT_RESOURCE_TYPES)[number]): LooseFields =>
  INTENT_RESOURCE_TEACHING[type].fields as unknown as LooseFields

// ---------------------------------------------------------------------------
// AST helpers (comments are not in the AST, so a name in a comment never counts)
// ---------------------------------------------------------------------------
function parseFile(relPath: string): ts.SourceFile {
  const abs = resolve(REPO_ROOT, relPath)
  return ts.createSourceFile(
    abs,
    readFileSync(abs, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    relPath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}
function parseSource(text: string, tsx = false): ts.SourceFile {
  return ts.createSourceFile(
    tsx ? 'sample.tsx' : 'sample.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}
function hasName(sf: ts.SourceFile, name: string): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      (ts.isIdentifier(node) && node.text === name) ||
      (ts.isStringLiteral(node) && node.text === name) ||
      (ts.isPropertyAccessExpression(node) && node.name.text === name)
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}
function stringLiteralsUnder(node: ts.Node): string[] {
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}
function unparen(expr: ts.Expression): ts.Expression {
  let current = expr
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}
function isRecordCast(expr: ts.Expression): boolean {
  const inner = unparen(expr)
  return ts.isAsExpression(inner) && inner.type.getText().includes('Record<string, unknown>')
}
/** Second-argument string literals of `helper(node, 'field')` calls. */
function helperArgNames(sf: ts.SourceFile, helpers: readonly string[]): Set<string> {
  const out = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      helpers.includes(node.expression.text) &&
      node.arguments[1] !== undefined
    ) {
      for (const literal of stringLiteralsUnder(node.arguments[1])) out.add(literal)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}
/** Property names read off `(x as Record<string, unknown>).name` or off the named receivers. */
function propertyReads(sf: ts.SourceFile, receivers: readonly string[]): Set<string> {
  const out = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const receiver = unparen(node.expression)
      if (
        isRecordCast(node.expression) ||
        (ts.isIdentifier(receiver) && receivers.includes(receiver.text))
      ) {
        out.add(node.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}
function sourceHasReadPoint(source: IntentPassthroughFieldSource, field: string): boolean {
  if ('readPoint' in source)
    return hasName(parseFile(source.readPoint.file), source.readPoint.identifier)
  return hasName(parseFile(source.intentOnly.resolvedIn), field)
}

// ---------------------------------------------------------------------------
// node kinds
// ---------------------------------------------------------------------------
describe('RFC-348 — node-kind registry', () => {
  test('registry keys are exactly NODE_KIND', () => {
    expect(Object.keys(INTENT_NODE_TEACHING).sort()).toEqual([...NODE_KIND].sort())
  })

  test('availability agrees with isSynthesizedOnlyNodeKind', () => {
    for (const kind of NODE_KIND) {
      const availability = INTENT_NODE_TEACHING[kind].availability.kind
      expect(availability === 'synthesized-only', kind).toBe(isSynthesizedOnlyNodeKind(kind))
    }
  })

  test('every authorable form names every non-omitted field (nested included), no omitted field, no `??`', () => {
    for (const kind of NODE_KIND) {
      if (isSynthesizedOnlyNodeKind(kind)) {
        expect('fields' in INTENT_NODE_TEACHING[kind]).toBe(false)
        continue
      }
      const form = renderNodeForm(kind)
      expect(form.startsWith(`{id,kind:'${kind}'`), kind).toBe(true)
      expect(form).not.toContain('??')
      for (const name of collectFieldNames(nodeFields(kind))) {
        expect(form, `${kind}.${name}`).toContain(name)
      }
      for (const name of collectOmittedFieldNames(nodeFields(kind))) {
        expect(form, `${kind}.${name} is omitted`).not.toContain(name)
      }
    }
  })

  test('synthesized-only kinds are named as withheld, never given a form', () => {
    const block = renderSupportedNodeForms(ALL)
    for (const kind of NODE_KIND) {
      if (isSynthesizedOnlyNodeKind(kind)) {
        expect(block).toContain(`NOT AVAILABLE TO YOU: \`${kind}\``)
        expect(block).not.toContain(`{id,kind:'${kind}'`)
      } else {
        expect(block).toContain(`{id,kind:'${kind}'`)
      }
    }
  })

  test('privileged availability matches the two permission points privilegedNodeLensFor reads', () => {
    const privileged = NODE_KIND.filter(
      (kind) => INTENT_NODE_TEACHING[kind].availability.kind === 'privileged',
    )
    expect(privileged.sort()).toEqual(['code-host-call', 'script'])
    const lensKey = { script: 'scripts', 'code-host-call': 'codeHost' } as const
    for (const kind of privileged as Array<keyof typeof lensKey>) {
      const availability = INTENT_NODE_TEACHING[kind].availability
      if (availability.kind !== 'privileged') throw new Error('unreachable')
      const lens = privilegedNodeLensFor({
        permissions: new Set([availability.permission]),
      } as unknown as Parameters<typeof privilegedNodeLensFor>[0])
      expect(lens[lensKey[kind]], `${kind} ⇔ ${availability.permission}`).toBe(false)
      const otherKey = kind === 'script' ? 'codeHost' : 'scripts'
      expect(lens[otherKey]).toBe(true)
    }
    expect(INTENT_NODE_TEACHING.script.availability.redactedFields).toBe(SCRIPT_REDACTED_FIELDS)
    expect(INTENT_NODE_TEACHING['code-host-call'].availability.redactedFields).toBe(
      CODE_HOST_REDACTED_FIELDS,
    )
    expect(
      withheldPrivilegedNodeKinds(NONE)
        .map((e) => e.kind)
        .sort(),
    ).toEqual(['code-host-call', 'script'])
    expect(withheldPrivilegedNodeKinds(ALL)).toEqual([])
    expect(authorableNodeKinds(NONE)).not.toContain('script')
    expect(authorableNodeKinds(ALL)).toContain('script')
  })

  test('clarify kinds teach every fixed port constant', () => {
    const clarify = INTENT_NODE_TEACHING.clarify.notes.join(' ')
    for (const port of [
      CLARIFY_INPUT_PORT_NAME,
      CLARIFY_OUTPUT_PORT_NAME,
      CLARIFY_SOURCE_PORT_NAME,
      CLARIFY_RESPONSE_TARGET_PORT_NAME,
    ]) {
      expect(clarify).toContain(`\`${port}\``)
    }
    const cross = INTENT_NODE_TEACHING['clarify-cross-agent'].notes.join(' ')
    for (const port of [
      CROSS_CLARIFY_INPUT_PORT_NAME,
      CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
      CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
      CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
    ]) {
      expect(cross).toContain(`\`${port}\``)
    }
  })

  test('wrapper-loop teaches every LOOP_EXIT_CONDITION_KINDS value and the RFC-236 flag; agent-single has no overrides', () => {
    const form = renderNodeForm('wrapper-loop')
    for (const kind of LOOP_EXIT_CONDITION_KINDS) expect(form).toContain(`'${kind}'`)
    expect(form).toContain('continueOnMaxIterations?')
    expect(renderNodeForm('agent-single')).not.toContain('overrides')
    expect(renderNodeForm('script')).toContain('branch?')
  })

  test('the PortRef sub-table is ONE object referenced from review / edges / outputs', () => {
    expect(INTENT_NODE_TEACHING.review.fields.inputSource.nested).toBe(WORKFLOW_PORT_REF_TEACHING)
    expect(WORKFLOW_EDGE_TEACHING.source.nested).toBe(WORKFLOW_PORT_REF_TEACHING)
    expect(WORKFLOW_EDGE_TEACHING.target.nested).toBe(WORKFLOW_PORT_REF_TEACHING)
    expect(WORKFLOW_OUTPUT_TEACHING.bind.nested).toBe(WORKFLOW_PORT_REF_TEACHING)
  })
})

// ---------------------------------------------------------------------------
// passthrough read points — forward
// ---------------------------------------------------------------------------
describe('RFC-348 — passthrough fields point at real read points (AST forward check)', () => {
  test('node-kind fieldSources', () => {
    for (const kind of NODE_KIND) {
      const entry = INTENT_NODE_TEACHING[kind] as {
        fields?: Record<string, unknown>
        fieldSources?: Record<string, IntentPassthroughFieldSource>
      }
      if (entry.fieldSources === undefined) continue
      expect(Object.keys(entry.fieldSources).sort()).toEqual(Object.keys(entry.fields ?? {}).sort())
      for (const [field, source] of Object.entries(entry.fieldSources)) {
        expect(sourceHasReadPoint(source, field), `${kind}.${field}`).toBe(true)
      }
    }
  })

  test('input-kind extraSources', () => {
    for (const kind of WORKFLOW_INPUT_KIND) {
      const teaching = WORKFLOW_INPUT_TEACHING[kind] as {
        extra: Record<string, unknown>
        extraSources?: Record<string, IntentPassthroughFieldSource>
      }
      if (kind === 'upload') {
        expect(teaching.extraSources).toBeUndefined()
        continue
      }
      expect(Object.keys(teaching.extraSources ?? {}).sort()).toEqual(
        Object.keys(teaching.extra).sort(),
      )
      for (const [field, source] of Object.entries(teaching.extraSources ?? {})) {
        expect(sourceHasReadPoint(source, field), `${kind}.${field}`).toBe(true)
      }
    }
  })

  test('a name that exists only in a comment is NOT a read point', () => {
    const sf = parseSource('// exitCondition lives here\nexport const x = 1\n')
    expect(hasName(sf, 'exitCondition')).toBe(false)
    expect(hasName(sf, 'x')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// passthrough read sites — reverse
// ---------------------------------------------------------------------------
const VALIDATOR_READ_HELPERS = [
  'readString',
  'readNumber',
  'readStringArray',
  'readBindings',
] as const
const VALIDATOR_ALLOWLIST: Record<string, string> = {
  agentName:
    'platform identity cache; intent expresses it as agentRef (collectIntentWorkflowAgentRefs rejects it)',
  agentId:
    'platform identity cache; intent expresses it as agentRef (collectIntentWorkflowAgentRefs rejects it)',
}
/** Every name the validator reads through its helpers today (resident baseline). */
const VALIDATOR_BASELINE = [
  'action',
  'agentId',
  'agentName',
  'commentInjectTemplate',
  'goalTemplate',
  'inputKey',
  'maxIterations',
  'nodeIds',
  'outputBindings',
  'ports',
  'promptTemplate',
  'provider',
  'rerunnableOnIterate',
  'rerunnableOnReject',
  'targetDir',
  'workflowName',
  'workgroupName',
]
const LAUNCH_BASELINE = [
  'allowOther',
  'choices',
  'gitKind',
  'maxCount',
  'maxLength',
  'minCount',
  'multiSelect',
]
const INPUT_BASE_KEYS = Object.keys(WORKFLOW_INPUT_BASE_TEACHING)
/** Frontend files that read input-declaration fields (authoring + launch surfaces). */
const FRONTEND_INPUT_READERS = [
  'packages/frontend/src/components/canvas/inspector/InputEdit.tsx',
  'packages/frontend/src/components/launch/DynamicInput.tsx',
  'packages/frontend/src/components/launch/FilesPicker.tsx',
  'packages/frontend/src/components/launch/EnumPicker.tsx',
  'packages/frontend/src/components/launch/GitPicker.tsx',
  'packages/frontend/src/components/launch/UploadPicker.tsx',
  'packages/frontend/src/components/webhooks/webhookAgentAuthoring.ts',
  'packages/frontend/src/routes/tasks.new.tsx',
  'packages/frontend/src/lib/task-wizard.ts',
] as const
const FRONTEND_RECEIVERS = ['def', 'rec', 'input', 'inputDef', 'd'] as const
/** Property reads on those receivers that are NOT input-declaration fields. */
const FRONTEND_ALLOWLIST: Record<string, string> = {
  inputKey: 'the input NODE key edited by InputEdit, not a declaration field',
  inputs: 'DynamicInput reads the workflow definition (`def.inputs`), not a declaration',
  severity: 'tasks.new casts a validation issue, not a declaration',
}
const FRONTEND_BASELINE = [
  'accept',
  'agentKind',
  'allowOther',
  'choices',
  'gitKind',
  'maxCount',
  'maxFileSize',
  'maxLength',
  'minCount',
  'multiSelect',
  'multiline',
  'onConflict',
  'presentation',
  'targetDir',
]

function taughtNodeFieldNames(): Set<string> {
  const out = new Set<string>()
  for (const kind of NODE_KIND)
    for (const name of collectFieldNames(nodeFields(kind))) out.add(name)
  for (const kind of NODE_KIND)
    for (const name of collectOmittedFieldNames(nodeFields(kind))) out.add(name)
  return out
}
function taughtInputFieldNames(): Set<string> {
  const out = new Set<string>(INPUT_BASE_KEYS)
  for (const kind of WORKFLOW_INPUT_KIND) {
    for (const name of Object.keys(WORKFLOW_INPUT_TEACHING[kind].extra)) out.add(name)
  }
  return out
}

describe('RFC-348 — read sites name nothing the registries do not teach (AST reverse check)', () => {
  test('workflow.validator.ts read* helpers', () => {
    const found = helperArgNames(
      parseFile(
        'packages/backend/src/modules/resource-catalog/infrastructure/legacy/workflow.validator.ts',
      ),
      VALIDATOR_READ_HELPERS,
    )
    expect([...found].sort()).toEqual(VALIDATOR_BASELINE)
    const taught = new Set([...taughtNodeFieldNames(), ...taughtInputFieldNames()])
    for (const name of found) {
      expect(taught.has(name) || name in VALIDATOR_ALLOWLIST, `validator reads '${name}'`).toBe(
        true,
      )
    }
    // self-check: the scanner reports a helper read of an untaught name
    const sample = parseSource(
      "const n = readNumber(node, 'zzzFake'); const s = readString(node, cond ? 'a' : 'zzzOther')",
    )
    const sampleNames = helperArgNames(sample, VALIDATOR_READ_HELPERS)
    expect(sampleNames.has('zzzFake')).toBe(true)
    expect(sampleNames.has('zzzOther')).toBe(true)
  })

  test('workflowLaunchInputs.ts numberField / stringField / as-cast reads', () => {
    const sf = parseFile(
      'packages/backend/src/modules/resource-catalog/infrastructure/legacy/workflowLaunchInputs.ts',
    )
    const found = new Set([
      ...helperArgNames(sf, ['numberField', 'stringField']),
      ...propertyReads(sf, []),
    ])
    expect([...found].sort()).toEqual(LAUNCH_BASELINE)
    for (const name of found) {
      expect(name in INPUT_FIELD_OWNERSHIP, `launch reads '${name}'`).toBe(true)
    }
    const sample = parseSource(
      "const a = numberField(def, 'zzzFake'); const b = (def as Record<string, unknown>).zzzCast",
    )
    const sampleNames = new Set([
      ...helperArgNames(sample, ['numberField', 'stringField']),
      ...propertyReads(sample, []),
    ])
    expect(sampleNames.has('zzzFake')).toBe(true)
    expect(sampleNames.has('zzzCast')).toBe(true)
  })

  test('frontend authoring + launch files: every file hits, the union is the ownership table', () => {
    const union = new Set<string>()
    for (const file of FRONTEND_INPUT_READERS) {
      const found = [...propertyReads(parseFile(file), FRONTEND_RECEIVERS)].filter(
        (name) => !INPUT_BASE_KEYS.includes(name) && !(name in FRONTEND_ALLOWLIST),
      )
      expect(found.length, `${file} reads no input-declaration field`).toBeGreaterThan(0)
      for (const name of found) {
        expect(name in INPUT_FIELD_OWNERSHIP, `${file} reads '${name}'`).toBe(true)
        union.add(name)
      }
    }
    expect([...union].sort()).toEqual(FRONTEND_BASELINE)
    expect([...union].sort()).toEqual(Object.keys(INPUT_FIELD_OWNERSHIP).sort())
    const sample = parseSource(
      'const v = (def as Record<string, unknown>).zzzFake; const w = rec.zzzRec',
      true,
    )
    const sampleNames = propertyReads(sample, FRONTEND_RECEIVERS)
    expect(sampleNames.has('zzzFake')).toBe(true)
    expect(sampleNames.has('zzzRec')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// input field ownership (three-way)
// ---------------------------------------------------------------------------
describe('RFC-348 — INPUT_FIELD_OWNERSHIP', () => {
  test("authorable (field, kind) pairs appear in that kind's extra; derived fields appear nowhere", () => {
    for (const [field, ownership] of Object.entries(INPUT_FIELD_OWNERSHIP)) {
      for (const kind of WORKFLOW_INPUT_KIND) {
        const taughtHere = field in WORKFLOW_INPUT_TEACHING[kind].extra
        const owned = (ownership.kinds as readonly string[]).includes(kind)
        expect(taughtHere, `${kind}.${field}`).toBe(owned && ownership.authorable)
      }
      if (!ownership.authorable) expect(ownership.why, field).toBeTruthy()
    }
  })

  test('upload extras are keyed by UploadInputSchema; every kind renders its extra fields', () => {
    expect(Object.keys(WORKFLOW_INPUT_TEACHING.upload.extra).sort()).toEqual(
      ['accept', 'maxCount', 'maxFileSize', 'minCount', 'onConflict', 'targetDir'].sort(),
    )
    const line = renderResourceLine('workflow', ALL)
    for (const kind of WORKFLOW_INPUT_KIND) {
      expect(line).toContain(`\`${kind}{`)
      for (const field of Object.keys(WORKFLOW_INPUT_TEACHING[kind].extra))
        expect(line).toContain(field)
    }
    expect(line).toContain("gitKind:'branch'|'commit-range'|'pr'")
    expect(line).toContain('`text{multiline?,maxLength?}`')
    // impl-gate r3 #1 — root definition.outputs[] is rendered from WORKFLOW_OUTPUT_TEACHING
    expect(line).toContain('`outputs:[{name,bind:{nodeId,portName}}]`')
    expect(renderOutputDeclarations()).toContain('outputs:[{name,bind:{nodeId,portName}}]')
  })
})

// ---------------------------------------------------------------------------
// resource types
// ---------------------------------------------------------------------------
describe('RFC-348 — resource-type registry', () => {
  test('registry keys are exactly INTENT_RESOURCE_TYPES', () => {
    expect(Object.keys(INTENT_RESOURCE_TEACHING).sort()).toEqual([...INTENT_RESOURCE_TYPES].sort())
  })

  test('every type line names every non-omitted field (nested / variant sub-tables included), no `??`', () => {
    for (const type of INTENT_RESOURCE_TYPES) {
      const line = renderResourceLine(type, ALL)
      expect(line.startsWith(`- **${type}**: `)).toBe(true)
      expect(line).not.toContain('??')
      for (const name of collectFieldNames(resourceFields(type))) {
        expect(line, `${type}.${name}`).toContain(name)
      }
    }
  })

  test('RFC-348 drifts are taught: branchPorts, permission grammar, runtime (ENABLED rows), skills forms, files, oauth, timeoutMs', () => {
    const agent = renderResourceLine('agent', ALL)
    expect(agent).toContain('branchPorts?:[port]')
    expect(agent).toContain('ENABLED')
    expect(agent).toContain('runtime-disabled')
    expect(agent).toContain("{kind:'project',name}")
    expect(agent).toContain('managed skill')
    const grammar = renderPermissionGrammar()
    expect(agent).toContain(grammar)
    expect(grammar).toContain("'*'")
    for (const action of OPENCODE_PERMISSION_ACTIONS) expect(grammar).toContain(`'${action}'`)
    for (const key of OPENCODE_PERMISSION_KEYS) expect(grammar).toContain(`\`${key}\``)
    expect(renderResourceLine('skill', ALL)).toContain('files?:[{path,content}]')
    const mcp = renderResourceLine('mcp', ALL)
    expect(mcp).toContain("oauth?:false|{clientId?,clientSecret?:'‹secret›',scope?,redirectUri?}")
    expect(mcp).toContain('timeoutMs?')
    expect(mcp).toContain('omitting `oauth` keeps the stored configuration')
  })

  test('field-adjacent mistakes stay on the field line; entry-level mistakes reach Common mistakes', () => {
    const agent = renderResourceLine('agent', ALL)
    expect(agent).toContain('There is NO `systemPrompt`/`ports`/`outputPorts` field.')
    expect(renderResourceLine('plugin', ALL)).toContain('never `options`')
    const common = renderCommonMistakes(ALL)
    expect(common.startsWith('## Common mistakes')).toBe(true)
    expect(common).not.toContain('systemPrompt')
    expect(common).not.toContain('never `options`')
    for (const type of INTENT_RESOURCE_TYPES) {
      for (const mistake of INTENT_RESOURCE_TEACHING[type].mistakes)
        expect(common).toContain(`- ${mistake}`)
    }
    for (const kind of authorableNodeKinds(ALL)) {
      for (const mistake of INTENT_NODE_TEACHING[kind].mistakes)
        expect(common).toContain(`- ${mistake}`)
    }
  })
})

// ---------------------------------------------------------------------------
// platform capability map + doc sections
// ---------------------------------------------------------------------------
function frontendRoutePaths(): Set<string> {
  const routesDir = resolve(REPO_ROOT, 'packages/frontend/src/routes')
  const paths = new Set<string>()
  let configKinds: string[] = []
  for (const file of readdirSync(routesDir)) {
    if (!file.endsWith('.tsx')) continue
    const text = readFileSync(resolve(routesDir, file), 'utf8')
    for (const match of text.matchAll(/path:\s*'([^']+)'/g)) paths.add(match[1] as string)
    const kinds = /CONFIG_KINDS\s*=\s*\[([^\]]+)\]/.exec(text)
    if (kinds !== null)
      configKinds = [...(kinds[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string)
  }
  for (const path of [...paths]) {
    if (path.includes('$kind'))
      for (const kind of configKinds) paths.add(path.replace('$kind', kind))
  }
  return paths
}

describe('RFC-348 — platform capability map', () => {
  test('intent-creatable stance ⇔ INTENT_RESOURCE_TYPES; nine platform-only types', () => {
    const creatable = (Object.keys(INTENT_PLATFORM_RESOURCE_MAP) as AclResourceType[]).filter(
      (type) => INTENT_PLATFORM_RESOURCE_MAP[type].stance === 'intent-creatable',
    )
    expect(creatable.sort()).toEqual([...INTENT_RESOURCE_TYPES].sort())
    expect(platformOnlyResourceTypes().length).toBe(9)
    for (const type of platformOnlyResourceTypes()) {
      expect((INTENT_RESOURCE_TYPES as readonly string[]).includes(type)).toBe(false)
    }
  })

  test('every route-managed type names a real frontend route; api-only notes are non-empty', () => {
    const routes = frontendRoutePaths()
    expect(routes.size).toBeGreaterThan(0)
    for (const type of platformOnlyResourceTypes()) {
      const teaching = INTENT_PLATFORM_RESOURCE_MAP[type]
      if (teaching.stance !== 'platform-only') throw new Error('unreachable')
      expect(teaching.purpose.length).toBeGreaterThan(0)
      if (teaching.managedAt.kind === 'route') {
        expect(routes.has(teaching.managedAt.path), `${type} → ${teaching.managedAt.path}`).toBe(
          true,
        )
      } else {
        expect(teaching.managedAt.note.length).toBeGreaterThan(0)
      }
    }
  })

  test('the capability-map section lists every platform-only type with its purpose', () => {
    const section = renderPlatformCapabilityMap()
    expect(section.startsWith('## Platform capability map')).toBe(true)
    for (const type of platformOnlyResourceTypes()) {
      const teaching = INTENT_PLATFORM_RESOURCE_MAP[type]
      if (teaching.stance !== 'platform-only') throw new Error('unreachable')
      expect(section).toContain(`- \`${type}\` — ${teaching.purpose}.`)
    }
    expect(section).toContain('cannot create, update, mount or reference')
  })
})

describe('RFC-348 — intentDoc.ts holds no capability literals (assembly only)', () => {
  test('no kind / resource type / payload field / envelope field / inventory file literal survives outside comments', () => {
    const raw = readFileSync(
      resolve(REPO_ROOT, 'packages/backend/src/services/intent/intentDoc.ts'),
      'utf8',
    )
    // strip comments, then un-escape template-literal backticks so \`summary\` reads as `summary`
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\\`/g, '`')
    expect(source).not.toMatch(/kind:'/)
    // the doc names a type as **type** / `type` (turn roles like 'agent' | 'user' are not resource types)
    for (const type of INTENT_RESOURCE_TYPES) {
      expect(source, `resource type ${type}`).not.toMatch(
        new RegExp(`\\*\\*${type}\\*\\*|\`${type}\`|resourceType: '${type}'`),
      )
    }
    for (const literal of [
      '{opId',
      'tempRef',
      'multiSelect',
      'promptTemplate',
      'branchPorts',
      'inventory/runtimes.md',
      'inventory/platform/',
      '`summary`',
      '`changeset`',
      '`questions`',
      '`requests`',
    ]) {
      expect(source, literal).not.toContain(literal)
    }
    for (const renderer of [
      'renderWorkingDirectoryLayout(',
      'renderPlatformModel(',
      'renderPlatformCapabilityMap(',
      'renderRequestedArtifactType(',
      'renderReferenceRules(',
      'renderCapabilityLimits(',
      'renderDeliveryBudget(',
      'renderPayloadSchemas(',
      'renderCommonMistakes(',
      'renderOutputContract(',
    ]) {
      expect(source, renderer).toContain(renderer)
    }
    // the renderers derive the envelope shapes from the shared schemas
    const contract = renderOutputContract('LANG')
    expect(contract).toContain("{opId, action:'create', resourceType, tempRef, payload}")
    expect(contract).toContain("{opId, action:'update', resourceType, target:'res#…', payload}")
    expect(contract).toContain('{id, question, options[2..4], multiSelect}')
    expect(contract).toContain('{resourceType, name, reason?}')
    expect(contract.endsWith('LANG')).toBe(true)
    expect(renderDeliveryBudget()).toContain(
      'list the remaining work in `summary` for the next turn',
    )
    // self-check: the lock sees an escaped backtick literal the way the doc renders it
    expect('a \\`summary\\` b'.replace(/\\`/g, '`')).toBe('a `summary` b')
    expect(renderWorkingDirectoryLayout()).toContain(
      "`inventory/runtimes.md` — runtime profiles an agent's `runtime` may name",
    )
  })
})

describe('RFC-348 — derived doc sections', () => {
  test('platform model derives the resource roster and the authorable kind list', () => {
    const full = renderPlatformModel(ALL)
    expect(full).toContain(
      `(${INTENT_RESOURCE_TYPES.length}): ${INTENT_RESOURCE_TYPES.join(', ')}.`,
    )
    for (const kind of authorableNodeKinds(ALL)) expect(full).toContain(`\`${kind}\``)
    expect(full).toContain('inline code, no model')
    const none = renderPlatformModel(NONE)
    expect(none).not.toContain('inline code, no model')
    expect(none).not.toContain('`script`')
    expect(none).toContain(`(${authorableNodeKinds(NONE).length}):`)
  })

  test('requested artifact type: absent vs picked (weak preference, RFC-235 D33)', () => {
    expect(renderRequestedArtifactType(null)).toBe(
      `## Requested artifact type\n\n${REQUESTED_ARTIFACT_NONE}`,
    )
    expect(REQUESTED_ARTIFACT_NONE).toContain('No type requested (Auto)')
    const picked = renderRequestedArtifactType('workflow')
    expect(picked).toBe(
      `## Requested artifact type\n\n${REQUESTED_ARTIFACT_PICKED.replaceAll('<type>', 'workflow')}`,
    )
    expect(picked).toContain('pre-selected **workflow**')
    expect(picked).toContain('follow the message; do not ask for confirmation')
    expect(picked).not.toContain('<type>')
  })
})
