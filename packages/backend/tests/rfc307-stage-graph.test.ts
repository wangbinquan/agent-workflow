// RFC-307 T1/T2 — the stage contract projected into a graph, and the soundness
// check that projection made possible.
//
// Why these exist: RFC-304 shipped four stage sequences that the UI rendered as
// one opaque box, and the user's report was "I have no flow I can look at, I
// don't even know what it actually looks like". The DAG was already in the
// contract — `requires` / `produces` ARE an edge list — so the fix is a
// projection, and the thing worth locking is that it stays a projection:
//
//   · the picture is derived from the contract, so changing a stage changes the
//     picture. A hand-maintained diagram is a second copy, and copies drift;
//   · the projection is pure, so it is exhaustively testable without a database.
//
// The soundness check earns its own cases. `validateStageContract` already
// catches "requires something nothing produces"; nobody had ever checked the
// mirror image, "produces something nothing reads", because until the sequence
// was drawn there was no natural way to ask. Running it on the shipped contracts
// found three, and all three turned out to be legitimate — three DIFFERENT
// legitimate shapes (branch end, round end, read by the dispatcher) that the
// contract now declares via `terminal`. That declaration is the point: exempting
// every unconsumed artifact would make the check fire never, while requiring the
// declaration still catches a consumer dropped in a refactor.

import { describe, expect, test } from 'bun:test'
import {
  lookupStageContract,
  registeredCapabilities,
} from '../src/modules/code-capability/domain/capabilityRegistry'
import {
  checkStageGraphSoundness,
  projectStageGraph,
} from '../src/modules/code-capability/domain/stageGraph'
import type { StageContract } from '../src/modules/code-capability/domain/stageContract'
import type { StageGraph as PublicStageGraph } from '../src/modules/code-capability/public/queries'

// The public contract declares its own shape rather than re-exporting the
// domain type — the RFC-294 preflight rejects a public type that resolves
// through `typeof CODE_CAPABILITIES`. The cost of two declarations is drift, so
// this assignment is the check: the projection must still satisfy the contract
// the outside world was promised, or this file stops compiling.
const _publicShapeHolds: (g: ReturnType<typeof projectStageGraph>) => PublicStageGraph = (g) => g
void _publicShapeHolds

const contractFor = (capability: Parameters<typeof lookupStageContract>[0]): StageContract => {
  const contract = lookupStageContract(capability)
  if (contract === undefined) throw new Error(`no contract for ${capability}`)
  return contract
}

describe('RFC-307 — the shipped contracts are sound', () => {
  // The whole soundness case in one assertion, run over every capability the
  // platform ships. A new stage whose output nobody reads, or whose input
  // nothing produces, turns this red at the point it is written rather than at
  // the point a round fails in production.
  for (const capability of registeredCapabilities()) {
    test(`${capability}: every artifact has both a producer and a consumer`, () => {
      expect(checkStageGraphSoundness(contractFor(capability), lookupStageContract)).toEqual([])
    })
  }

  test('the projection covers every stage, and every stage has a kind', () => {
    // Guards the shape of the whole exercise: if a fifth `StageDef` arm were
    // added and the projection did not learn it, the count would still match
    // but the node would carry no slot information.
    for (const capability of registeredCapabilities()) {
      const contract = contractFor(capability)
      const graph = projectStageGraph(contract, lookupStageContract)
      expect(graph.nodes).toHaveLength(contract.stages.length)
      expect(graph.nodes.map((n) => n.name)).toEqual(contract.stages.map((s) => s.name))
      for (const node of graph.nodes) {
        expect(['program', 'script', 'ai', 'invoke']).toContain(node.kind)
        if (node.kind === 'ai') expect(node.agentSlot).toBeTruthy()
        if (node.kind === 'script') expect(node.scriptSlot).toBeTruthy()
        if (node.kind === 'invoke') expect(node.invokes?.capability).toBeTruthy()
      }
    }
  })

  test('mr-review is 13 stages of which exactly 2 are AI — the constitution, measured', () => {
    // proposal §2 constitution R2: "program where a program suffices". This is
    // that claim as an assertion instead of a sentence, so quietly turning a
    // program stage into an AI one cannot pass review unnoticed.
    const graph = projectStageGraph(contractFor('mr-review'), lookupStageContract)
    expect(graph.nodes).toHaveLength(13)
    expect(graph.nodes.filter((n) => n.kind === 'ai').map((n) => n.name)).toEqual([
      'review-shard',
      'review-global',
    ])
  })

  test('mr-monitor ships as a capability but has NO stage contract', () => {
    // It is the monitor main loop, not a sequence. Pinned because the route has
    // to answer for it, and answering 404 would read as "you typed the name
    // wrong" for a capability the platform genuinely provides.
    expect(lookupStageContract('mr-monitor')).toBeUndefined()
    expect(registeredCapabilities()).not.toContain('mr-monitor')
  })
})

describe('RFC-307 — edges follow the artifacts', () => {
  test('an edge exists for each consumed artifact, naming what flows along it', () => {
    const graph = projectStageGraph(contractFor('mr-review'), lookupStageContract)
    // `publish` reads `reconciled`, produced upstream by `reconcile`.
    const edge = graph.edges.find((e) => e.to === 'publish' && e.artifact === 'reconciled')
    expect(edge?.from).toBe('reconcile')
  })

  test('a re-produced artifact connects to its NEAREST producer, not every producer', () => {
    // An overwrite is not a fan-in. Drawing an edge from the earlier producer
    // as well would show data flowing along a path the run never takes.
    const contract: StageContract = {
      capability: 'mr-review',
      version: 1,
      stages: [
        { kind: 'program', name: 'first', requires: [], produces: ['diff'], terminal: ['diff'] },
        { kind: 'program', name: 'second', requires: [], produces: ['diff'] },
        { kind: 'program', name: 'reader', requires: ['diff'], produces: ['out'] },
      ],
    }
    const edges = projectStageGraph(contract).edges.filter((e) => e.to === 'reader')
    expect(edges).toHaveLength(1)
    expect(edges[0]?.from).toBe('second')
  })

  test('one producer feeding several consumers is a fan-out, and shows as one edge each', () => {
    const graph = projectStageGraph(contractFor('mr-review'), lookupStageContract)
    const fromReconcile = graph.edges.filter((e) => e.from === 'reconcile')
    expect(fromReconcile.length).toBeGreaterThan(1)
    // Distinct targets, not one target repeated.
    expect(new Set(fromReconcile.map((e) => e.to)).size).toBe(fromReconcile.length)
  })

  test('an unsatisfied requirement is REPORTED, not drawn as a dangling edge', () => {
    const contract: StageContract = {
      capability: 'ci-fix',
      version: 1,
      stages: [{ kind: 'program', name: 'only', requires: ['ghost'], produces: [] }],
    }
    expect(projectStageGraph(contract).edges).toEqual([])
    expect(checkStageGraphSoundness(contract)).toEqual([
      {
        code: 'requires-unproduced',
        stageName: 'only',
        artifact: 'ghost',
        message: "stage 'only' requires 'ghost', which no upstream stage produces",
      },
    ])
  })
})

describe('RFC-307 — the check catches what it is for', () => {
  test('an artifact nobody reads and nobody declared terminal is reported', () => {
    // The refactor case: someone deletes the stage that read `orphan` and the
    // producing stage keeps declaring it. Nothing else in the repo notices.
    const contract: StageContract = {
      capability: 'ci-fix',
      version: 1,
      stages: [
        { kind: 'program', name: 'produce', requires: [], produces: ['orphan'] },
        { kind: 'program', name: 'last', requires: [], produces: ['done'] },
      ],
    }
    const issues = checkStageGraphSoundness(contract)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('produces-unconsumed')
    expect(issues[0]?.artifact).toBe('orphan')
  })

  test('declaring it terminal silences the report — and only for what was declared', () => {
    const contract: StageContract = {
      capability: 'ci-fix',
      version: 1,
      stages: [
        {
          kind: 'program',
          name: 'produce',
          requires: [],
          produces: ['declared', 'undeclared'],
          terminal: ['declared'],
        },
        { kind: 'program', name: 'last', requires: [], produces: ['done'] },
      ],
    }
    const issues = checkStageGraphSoundness(contract)
    // Precisely one survives: the declaration is per-artifact, so it cannot be
    // used to wave through a whole stage.
    expect(issues.map((i) => i.artifact)).toEqual(['undeclared'])
  })

  test('the three the platform actually ships are each declared, with distinct reasons', () => {
    // Not a restatement of the check — these pin the specific artifacts, so
    // dropping a `terminal` declaration during a refactor turns this red with
    // the stage named, rather than turning the generic soundness case red with
    // "something changed".
    const declared = (capability: Parameters<typeof lookupStageContract>[0], stage: string) =>
      projectStageGraph(contractFor(capability), lookupStageContract).nodes.find(
        (n) => n.name === stage,
      )?.terminal
    expect(declared('mr-comment-fix', 'publish-suggestion')).toEqual(['published'])
    expect(declared('requirement', 'clarify')).toEqual(['clarification'])
    expect(declared('ci-fix', 'select')).toEqual(['agentPlan'])
  })

  test("an invoke target's collected outputs are not reported against the target", () => {
    // `mr-review` produces `findings`, and `requirement`/`ci-fix` reach in and
    // collect it. Within mr-review's own sequence it is consumed downstream, so
    // this locks the exemption by construction instead: a contract whose last
    // useful output is collected by a parent must not be flagged.
    const target: StageContract = {
      capability: 'mr-review',
      version: 1,
      stages: [
        { kind: 'program', name: 'a', requires: [], produces: ['subOut'] },
        { kind: 'program', name: 'b', requires: [], produces: ['tail'] },
      ],
    }
    const parent: StageContract = {
      capability: 'ci-fix',
      version: 1,
      stages: [
        { kind: 'program', name: 'prep', requires: [], produces: ['worktree', 'left'] },
        {
          kind: 'invoke',
          name: 'self-review',
          requires: ['worktree'],
          produces: ['selfFindings'],
          invokes: {
            capability: 'mr-review',
            from: 'a',
            to: 'b',
            worktreeFrom: 'worktree',
            diffLeftFrom: 'left',
          },
          collect: { selfFindings: 'subOut' },
        },
        { kind: 'program', name: 'use', requires: ['selfFindings'], produces: ['out'] },
      ],
    }
    const registry = (c: string) =>
      c === 'mr-review' ? target : c === 'ci-fix' ? parent : undefined
    expect(
      checkStageGraphSoundness(target, registry as never).map((i) => i.artifact),
    ).not.toContain('subOut')
  })

  test('an invoke node carries the sub-sequence it expands to', () => {
    const graph = projectStageGraph(contractFor('ci-fix'), lookupStageContract)
    const invoke = graph.nodes.find((n) => n.kind === 'invoke')
    expect(invoke?.invokes?.capability).toBe('mr-review')
    // Resolved through the registry rather than left as a name, so the UI can
    // show what the step actually runs.
    expect(invoke?.invokes?.stages.length).toBeGreaterThan(0)
  })

  test('without a registry an invoke node still renders, naming its target', () => {
    // A picture that refuses to draw because one lookup is unavailable is worse
    // than a partial one.
    const graph = projectStageGraph(contractFor('ci-fix'))
    const invoke = graph.nodes.find((n) => n.kind === 'invoke')
    expect(invoke?.invokes?.capability).toBe('mr-review')
    expect(invoke?.invokes?.stages).toEqual([])
  })
})

describe('RFC-307 — what the UI needs is on the node', () => {
  test('injectable is carried through, and empty is a real answer', () => {
    const graph = projectStageGraph(contractFor('mr-review'), lookupStageContract)
    const withHookKeys = graph.nodes.filter((n) => n.injectable.length > 0)
    expect(withHookKeys.length).toBeGreaterThan(0)
    // The distinction the hook UI depends on: "may inject these keys" vs "may
    // run here but may not hand data back". Both must be representable.
    expect(graph.nodes.some((n) => n.injectable.length === 0)).toBe(true)
  })

  test('a parallel segment is marked as one', () => {
    const graph = projectStageGraph(contractFor('mr-review'), lookupStageContract)
    expect(graph.nodes.find((n) => n.name === 'review-shard')?.parallel).toBe(true)
  })

  test('the graph carries the contract version it was projected from', () => {
    const contract = contractFor('mr-review')
    expect(projectStageGraph(contract, lookupStageContract).version).toBe(contract.version)
  })
})
