import { AGENT_BINDING_SOURCE, LEAF_NODE_SOURCES } from './helpers/executionMechanismSources'
import { legacyContentRef } from '@/platform/content/contentRef'
import { contentRowColumns } from '@/platform/content/infrastructure/contentStore'
// RFC-282 B2 / RFC-345 T4a — the legacy resolver keeps its focused behavior
// tests below, while all six TaskExecution entries now use the per-task named
// Resource Catalog session (four managed + two synthetic code-owned entries).
//
// §7-7 (registered behavior change): the RFC-170 skill-quarantine gate and
// the RFC-223 canonical-path gate used to THROW out of the resolver — runScope
// turned that into a TASK-level failure, unlike every sibling fence
// (mcp-not-found / plugin-disabled…) which fails just the node. Both now
// return `{kind:'failed'}`. The first test here was written against the old
// throw (red under the new code in the throw direction) and flipped with the
// change — the typed shape IS the new contract.
//
// 设计门 P2-9 regression lock: a zero-resource synthetic agent (commit-push /
// merge) must ALWAYS resolve ok — B2's wiring made those two entries go
// through the resolver, so a new failure mode here would break every task's
// commit step.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import ts from 'typescript'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'
import { resolveInjection } from './helpers/legacyTaskExecutionInjectionResolver'
import { legacyInjectionAgentLookup } from './helpers/legacyInjectionAgentLookup'
import { buildCommitAgent } from '../src/modules/task-execution/domain/commitAgent'
import { buildMergeAgent } from '../src/services/mergeAgent'
import {
  activateBootReverifyForTest,
  markSkillBootVerified,
  resetSkillBootVerifyForTest,
} from '../src/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { skillFilesRel } from '../src/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'
import { createLogger } from '../src/util/log'
import type { Agent } from '@agent-workflow/shared'

const SRC = resolve(import.meta.dir, '..', 'src')
const log = createLogger('rfc282-b2')

function mkAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-' + ulid(),
    name: 'root',
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Agent
}

describeEachProvider(
  'RFC-282 B2 — §7-7 skill gates are typed failures (node-level attribution)',
  (harness) => {
    let db: PersistenceDb

    beforeEach(() => {
      db = harness.db
      resetSkillBootVerifyForTest()
    })

    test('quarantined managed skill → {kind:failed, skill-quarantined} (was a THROW → task-level)', async () => {
      const skillId = ulid()
      const { skills } = tablesOf(db)
      await insertOne(db, skills, {
        id: skillId,
        name: 'quarantined-skill',
        description: '',
        ...contentRowColumns(legacyContentRef('skill-path', 'local-file', skillFilesRel(skillId))),
        contentVersion: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      // Boot-reverify active with an EMPTY verified set ⇒ this skill is
      // quarantined for the boot epoch (RFC-170 T9).
      activateBootReverifyForTest()
      const agent = mkAgent({ skills: [{ kind: 'managed', skillId }] })
      const result = await resolveInjection(db, agent, {
        appHome: '/tmp/aw',
        log,
        agentDependencies: legacyInjectionAgentLookup(db),
      })
      expect(result.kind).toBe('failed')
      if (result.kind !== 'failed') throw new Error('unreachable')
      expect(result.message).toBe('skill-quarantined')
      expect(result.summary).toContain('quarantined-skill')
    })

    test('missing content reference → typed skill-content-missing failure', async () => {
      const skillId = ulid()
      const { skills } = tablesOf(db)
      await insertOne(db, skills, {
        id: skillId,
        name: 'legacy-path-skill',
        description: '',
        contentRefJson: null,
        contentInlineBytes: null, // Legacy identity proof is exercised at B conversion.
        contentVersion: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      activateBootReverifyForTest()
      markSkillBootVerified(skillId)
      const agent = mkAgent({ skills: [{ kind: 'managed', skillId }] })
      const result = await resolveInjection(db, agent, {
        appHome: '/tmp/aw',
        log,
        agentDependencies: legacyInjectionAgentLookup(db),
      })
      expect(result.kind).toBe('failed')
      if (result.kind !== 'failed') throw new Error('unreachable')
      expect(result.message).toBe('skill-content-missing')
    })

    test('the resolver no longer throws domain errors for these gates (typed-only surface)', async () => {
      const skillId = ulid()
      const { skills } = tablesOf(db)
      await insertOne(db, skills, {
        id: skillId,
        name: 'q2',
        description: '',
        ...contentRowColumns(legacyContentRef('skill-path', 'local-file', skillFilesRel(skillId))),
        contentVersion: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      activateBootReverifyForTest()
      const agent = mkAgent({ skills: [{ kind: 'managed', skillId }] })
      // A throw here would reject; typed failure resolves.
      await expect(
        resolveInjection(db, agent, {
          appHome: '/tmp/aw',
          log,
          agentDependencies: legacyInjectionAgentLookup(db),
        }),
      ).resolves.toMatchObject({ kind: 'failed' })
    })
  },
)

describeEachProvider(
  'RFC-282 B2 — zero-resource synthetic agents always resolve ok (P2-9 lock)',
  (harness) => {
    test('commit-push and merge synthetic agents → ok with empty faces', async () => {
      const db = harness.db
      for (const agent of [buildCommitAgent(), buildMergeAgent()]) {
        const result = await resolveInjection(db, agent, {
          appHome: '/tmp/aw',
          log,
          agentDependencies: legacyInjectionAgentLookup(db),
        })
        expect(result.kind).toBe('ok')
        if (result.kind !== 'ok') throw new Error('unreachable')
        expect(result.spec.dependents).toEqual([])
        expect(result.spec.skills).toEqual([])
        expect(result.spec.mcps).toEqual([])
        expect(result.spec.plugins).toEqual([])
        expect(result.spec.agent).toBe(agent)
      }
    })
  },
)

describe('RFC-282 B2 / RFC-345 T4a — all six TaskExecution entries use one resource session', () => {
  test('TaskExecution has six managed session reads plus three explicit synthetic resolutions', () => {
    const text = [
      ...LEAF_NODE_SOURCES,
      // RFC-405: the agent body reads its injection through the agent binding.
      AGENT_BINDING_SOURCE,
      readFileSync(resolve(SRC, 'modules/task-execution/composition/wrapperMechanics.ts'), 'utf8'),
      // RFC-412: the commit&push tail (engine body + binding) replaced services/scheduler.ts.
      readFileSync(
        resolve(SRC, 'modules/task-execution/engine/node/commit-push/runCommitPush.ts'),
        'utf8',
      ),
      readFileSync(resolve(SRC, 'modules/task-execution/composition/commitPushBinding.ts'), 'utf8'),
      readFileSync(
        resolve(SRC, 'modules/task-execution/engine/node/shared/resolveMergeConflicts.ts'),
        'utf8',
      ),
    ].join('\n')
    expect(text).not.toContain('await resolveInjection(')
    // RFC-354 (schema v6): the sixth read resolves a fan-out shard source's
    // declared output kind from its agent (`sourcePortKindOf`).
    // RFC-407: the fan-out shard / aggregator reads moved with their lines into
    // engine/node/agent-single/ and, like the agent body, go through the agent binding's one
    // `resources.injection` delegate; the source-port kind read (`sourcePortKindOf`) moved into the
    // binding too — four literal reads, three port readers, still six entries.
    // RFC-420: the fan-out hydration and the source-port-kind read moved into
    // application/fanoutAgentResolution.ts and reach the session through the agent binding's second
    // delegate (`agentResolutionResources`) — three literal reads (two delegates and the host's),
    // three port readers and two resolution readers, still six entries.
    const resolution = readFileSync(
      resolve(SRC, 'modules/task-execution/application/fanoutAgentResolution.ts'),
      'utf8',
    )
    const literalReads = text.split('taskExecutionResources.injection(').length - 1
    const bindingReaders = text.split('ports.resources.injection(').length - 1
    const resolutionReaders = resolution.split('await resources.injection(').length - 1
    expect(literalReads).toBe(3)
    expect(bindingReaders).toBe(3)
    expect(resolutionReaders).toBe(2)
    expect(
      AGENT_BINDING_SOURCE.split(
        'injection: (agentId) => state.taskExecutionResources.injection(agentId),',
      ).length - 1,
    ).toBe(2)
    expect(literalReads - 2 + bindingReaders + resolutionReaders).toBe(6)
    expect(text.split('resolveSyntheticTaskAgentInjection(').length - 1).toBe(3)
    // the commit-push / merge bypass shape (four hand-written empty arrays)
    expect(text).not.toContain('skills: [],\n          dependents: [],')
    expect(text).not.toContain('skills: [],\n      dependents: [],')
    // no resolver implementation is duplicated in either execution composition file
    expect(text).not.toContain('function prepareNodeRunInjection')
    expect(text).not.toContain('async function resolveSkills')
  })

  test('the writeSem call sites (commit/merge) thread the scope signal (§9-5)', () => {
    // RFC-412: the commit session runs through the commit&push port; its binding threads the scope signal.
    const commitEngine = ts.createSourceFile(
      'modules/task-execution/engine/node/commit-push/runCommitPush.ts',
      readFileSync(
        resolve(SRC, 'modules/task-execution/engine/node/commit-push/runCommitPush.ts'),
        'utf8',
      ),
      ts.ScriptTarget.Latest,
      true,
    )
    const commitCalls: ts.CallExpression[] = []
    const findCommitCall = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(commitEngine) === 'ports.runtime.runAgent' &&
        ts.isObjectLiteralExpression(node.arguments[0]!) &&
        node.arguments[0].properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            p.name.getText(commitEngine) === 'agent' &&
            p.initializer.getText(commitEngine) === 'commitAgent',
        )
      )
        commitCalls.push(node)
      ts.forEachChild(node, findCommitCall)
    }
    findCommitCall(commitEngine)
    expect(commitCalls).toHaveLength(1)
    expect(
      readFileSync(resolve(SRC, 'modules/task-execution/composition/commitPushBinding.ts'), 'utf8'),
    ).toContain('...(state.opts.signal ? { signal: state.opts.signal } : {}),')
    const sites = [
      {
        path: 'modules/task-execution/engine/node/shared/resolveMergeConflicts.ts',
        agent: 'mergeAgent',
      },
    ]
    for (const { path, agent } of sites) {
      // RFC-371 adds invocation metadata: inspect the complete call rather
      // than truncating the signal away at an arbitrary character boundary.
      const source = ts.createSourceFile(
        path,
        readFileSync(resolve(SRC, path), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      )
      const calls: ts.CallExpression[] = []
      const walk = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ['runNode', 'ports.agent.runNode'].includes(node.expression.getText(source))
        ) {
          const input = node.arguments[agent === 'mergeAgent' ? 0 : 1]
          if (
            input &&
            ts.isObjectLiteralExpression(input) &&
            input.properties.some(
              (p) =>
                ts.isPropertyAssignment(p) &&
                p.name.getText(source) === 'agent' &&
                p.initializer.getText(source) === agent,
            )
          )
            calls.push(node)
        }
        ts.forEachChild(node, walk)
      }
      walk(source)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.getText(source)).toContain(
        agent === 'mergeAgent' ? 'signal: ports.signal' : 'signal: state.opts.signal',
      )
    }
  })
})
