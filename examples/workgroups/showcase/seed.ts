#!/usr/bin/env bun
/**
 * Seed three runnable mixed-workgroup showcases through the public HTTP API.
 *
 * The exported catalog is also consumed by e2e/workgroup-matrix.spec.ts, so the
 * checked-in examples cannot drift away from the definitions exercised against
 * a real daemon. CLI execution is dry-run by default; --apply creates missing
 * Agents and Workgroups, while --launch additionally starts three scratch tasks.
 */

import process from 'node:process'

export type ShowcaseAgentKey =
  | 'leader'
  | 'researcher'
  | 'builder'
  | 'collabAlpha'
  | 'collabBeta'
  | 'dynamicSource'
  | 'dynamicReviewer'

export type ShowcaseWorkgroupKey = 'leaderWorker' | 'freeCollab' | 'dynamicWorkflow'

interface ShowcaseAgentSpec {
  key: ShowcaseAgentKey
  name: string
  description: string
  bodyMd: string
  inputs?: Array<{ name: string; kind: string; description: string }>
  outputs: string[]
  permission?: Record<string, unknown>
}

type ShowcaseMemberSpec =
  | {
      memberType: 'agent'
      agentKey: ShowcaseAgentKey
      displayName: string
      roleDesc: string
    }
  | {
      memberType: 'human'
      displayName: string
      roleDesc: string
    }

interface ShowcaseWorkgroupSpec {
  key: ShowcaseWorkgroupKey
  name: string
  description: string
  instructions: string
  mode: 'leader_worker' | 'free_collab' | 'dynamic_workflow'
  leaderDisplayName?: string
  switches: { shareOutputs: boolean; directMessages: boolean; blackboard: boolean }
  maxRounds: number
  completionGate: boolean
  clarifyBudget: number
  fanOut?: boolean
  members: ShowcaseMemberSpec[]
}

interface ShowcaseTaskSpec {
  name: string
  goal: string
}

interface AgentRow {
  id: string
  name: string
}

interface WorkgroupRow {
  id: string
  name: string
  version: number
}

interface TaskRow {
  id: string
  name: string | null
  status: string
}

export interface ShowcaseSeedResult {
  userId: string
  agents: Record<ShowcaseAgentKey, AgentRow>
  workgroups: Record<ShowcaseWorkgroupKey, WorkgroupRow>
  tasks: Partial<Record<ShowcaseWorkgroupKey, TaskRow>>
}

export const SHOWCASE_AGENTS: readonly ShowcaseAgentSpec[] = [
  {
    key: 'leader',
    name: 'showcase-wg-lead',
    description: 'Coordinates a governed leader-worker delivery.',
    bodyMd:
      'Decompose the goal, delegate all implementation, reconcile evidence, and request completion only after every assignment is verified.',
    outputs: [],
  },
  {
    key: 'researcher',
    name: 'showcase-wg-researcher',
    description: 'Researches delivery constraints without modifying the repository.',
    bodyMd: 'Research the assigned constraint and return a concise, evidence-based result.',
    outputs: [],
    permission: { read: 'allow', edit: 'deny', write: 'deny' },
  },
  {
    key: 'builder',
    name: 'showcase-wg-builder',
    description: 'Implements isolated code and test shards in parallel.',
    bodyMd:
      'Implement exactly the assigned shard in the current working copy, verify it, and report the concrete result.',
    outputs: [],
  },
  {
    key: 'collabAlpha',
    name: 'showcase-fc-alpha',
    description: 'Plans, claims, implements, and communicates in a leaderless room.',
    bodyMd:
      'Collaborate through the shared room and task list. Add only necessary tasks, claim useful work, and finish every claimed card.',
    outputs: [],
  },
  {
    key: 'collabBeta',
    name: 'showcase-fc-beta',
    description: 'Provides an independent track in a leaderless collaboration.',
    bodyMd:
      'Collaborate through the shared room and task list. Deduplicate overlapping plans and communicate results to peers.',
    outputs: [],
  },
  {
    key: 'dynamicSource',
    name: 'showcase-dw-source',
    description: 'Produces the first artifact in a generated workflow.',
    bodyMd: 'Produce the requested implementation draft and preserve literal template tokens.',
    outputs: ['draft'],
  },
  {
    key: 'dynamicReviewer',
    name: 'showcase-dw-reviewer',
    description: 'Consumes and reviews the generated workflow draft.',
    bodyMd: 'Review the supplied draft exactly once and return a concrete report.',
    inputs: [
      {
        name: 'draft',
        kind: 'string',
        description: 'Upstream implementation draft.',
      },
    ],
    outputs: ['report'],
  },
]

export const SHOWCASE_WORKGROUPS: readonly ShowcaseWorkgroupSpec[] = [
  {
    key: 'leaderWorker',
    name: 'showcase-governed-release-swarm',
    description:
      'Leader clarification, parallel same-member fan-out, direct/public messages, retry, merge-back, and a rejectable completion gate.',
    instructions:
      'WG_MATRIX_CHARTER coordinate, verify, and revise after human feedback. Keep research read-only and implementation shards independent.',
    mode: 'leader_worker',
    leaderDisplayName: 'lead',
    switches: { shareOutputs: true, directMessages: true, blackboard: true },
    maxRounds: 20,
    completionGate: true,
    clarifyBudget: 2,
    fanOut: true,
    members: [
      {
        memberType: 'agent',
        agentKey: 'leader',
        displayName: 'lead',
        roleDesc: 'decompose and govern',
      },
      {
        memberType: 'agent',
        agentKey: 'researcher',
        displayName: 'researcher',
        roleDesc: 'read-only release research',
      },
      {
        memberType: 'agent',
        agentKey: 'builder',
        displayName: 'builder',
        roleDesc: 'parallel implementation instances',
      },
      {
        memberType: 'human',
        displayName: 'owner',
        roleDesc: 'answer questions and approve completion',
      },
    ],
  },
  {
    key: 'freeCollab',
    name: 'showcase-open-collaboration-room',
    description:
      'Leaderless parallel planning with normalized task deduplication, public/direct messages, batch execution, merge-back, and approval.',
    instructions:
      'FC_MATRIX_CHARTER plan openly, deduplicate overlapping cards, communicate dependencies, and finish every accepted task.',
    mode: 'free_collab',
    switches: { shareOutputs: false, directMessages: false, blackboard: false },
    maxRounds: 20,
    completionGate: true,
    clarifyBudget: 1,
    members: [
      {
        memberType: 'agent',
        agentKey: 'collabAlpha',
        displayName: 'alpha',
        roleDesc: 'plan and implement alpha shards',
      },
      {
        memberType: 'agent',
        agentKey: 'collabBeta',
        displayName: 'beta',
        roleDesc: 'plan and implement beta shards',
      },
      {
        memberType: 'human',
        displayName: 'owner',
        roleDesc: 'approve convergence',
      },
    ],
  },
  {
    key: 'dynamicWorkflow',
    name: 'showcase-generated-delivery-dag',
    description:
      'Human-governed graph generation, rejection/regeneration, and ordinary two-Agent DAG execution with typed port handoff.',
    instructions:
      'DW_MATRIX_CHARTER generate a minimal reviewable graph before execution and preserve every literal token in downstream data.',
    mode: 'dynamic_workflow',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 10,
    completionGate: true,
    clarifyBudget: 0,
    members: [
      {
        memberType: 'agent',
        agentKey: 'dynamicSource',
        displayName: 'source',
        roleDesc: 'produce a draft output',
      },
      {
        memberType: 'agent',
        agentKey: 'dynamicReviewer',
        displayName: 'reviewer',
        roleDesc: 'consume the draft and review it',
      },
    ],
  },
]

export const SHOWCASE_TASKS: Readonly<Record<ShowcaseWorkgroupKey, ShowcaseTaskSpec>> = {
  leaderWorker: {
    name: 'Showcase: governed parallel release',
    goal: 'WG_MATRIX_GOAL literal {{do_not_expand}}. Clarify the release strategy, research constraints, implement code and tests in parallel, then revise if the completion gate rejects the first result.',
  },
  freeCollab: {
    name: 'Showcase: open collaboration delivery',
    goal: 'FC_MATRIX_GOAL literal {{fc_literal}}. Independently plan the work, deduplicate overlapping cards, exchange direct and public context, execute batches, and converge for human approval.',
  },
  dynamicWorkflow: {
    name: 'Showcase: generated two-agent delivery',
    goal: 'DW_MATRIX_GOAL literal {{dw_goal_literal}}. Generate a source-to-reviewer DAG, let the human reject and regenerate the first graph, then execute the approved typed handoff.',
  },
}

export async function seedShowcase(input: {
  baseUrl: string
  token: string
  /** Optional E2E/runtime-parity pin; omitted by the normal showcase CLI. */
  runtime?: 'opencode' | 'claude-code'
  launch?: boolean
  log?: (message: string) => void
}): Promise<ShowcaseSeedResult> {
  const baseUrl = input.baseUrl.replace(/\/+$/, '')
  const log = input.log ?? (() => undefined)
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${input.token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
    })
    if (!response.ok) {
      throw new Error(
        `${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}: ${await response.text()}`,
      )
    }
    return (await response.json()) as T
  }

  const me = await request<{ user: { id: string } }>('/api/auth/me')
  const listedAgents = await request<AgentRow[]>('/api/agents')
  const agents = {} as Record<ShowcaseAgentKey, AgentRow>

  for (const spec of SHOWCASE_AGENTS) {
    let row = listedAgents.find((candidate) => candidate.name === spec.name)
    if (row === undefined) {
      row = await request<AgentRow>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: spec.name,
          description: spec.description,
          bodyMd:
            input.runtime === undefined
              ? spec.bodyMd
              : `[AW_SCENARIO_AGENT:${spec.name}]\n${spec.bodyMd}`,
          inputs: spec.inputs ?? [],
          outputs: spec.outputs,
          outputKinds: Object.fromEntries(spec.outputs.map((port) => [port, 'string'])),
          permission: spec.permission ?? {},
          ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        }),
      })
      log(`created Agent ${row.name} (${row.id})`)
      listedAgents.push(row)
    } else {
      log(`reused Agent ${row.name} (${row.id})`)
    }
    agents[spec.key] = row
  }

  const listedWorkgroups = await request<WorkgroupRow[]>('/api/workgroups')
  const workgroups = {} as Record<ShowcaseWorkgroupKey, WorkgroupRow>

  for (const spec of SHOWCASE_WORKGROUPS) {
    let row = listedWorkgroups.find((candidate) => candidate.name === spec.name)
    if (row === undefined) {
      row = await request<WorkgroupRow>('/api/workgroups', {
        method: 'POST',
        body: JSON.stringify({
          name: spec.name,
          description: spec.description,
          instructions: spec.instructions,
          mode: spec.mode,
          ...(spec.leaderDisplayName === undefined
            ? {}
            : { leaderDisplayName: spec.leaderDisplayName }),
          switches: spec.switches,
          maxRounds: spec.maxRounds,
          completionGate: spec.completionGate,
          clarifyBudget: spec.clarifyBudget,
          fanOut: spec.fanOut ?? false,
          members: spec.members.map((member) =>
            member.memberType === 'agent'
              ? {
                  memberType: 'agent',
                  agentId: agents[member.agentKey].id,
                  displayName: member.displayName,
                  roleDesc: member.roleDesc,
                }
              : {
                  memberType: 'human',
                  userId: me.user.id,
                  displayName: member.displayName,
                  roleDesc: member.roleDesc,
                },
          ),
        }),
      })
      log(`created Workgroup ${row.name} (${row.id})`)
      listedWorkgroups.push(row)
    } else {
      log(`reused Workgroup ${row.name} (${row.id})`)
    }
    workgroups[spec.key] = row
  }

  const tasks: Partial<Record<ShowcaseWorkgroupKey, TaskRow>> = {}
  if (input.launch === true) {
    for (const spec of SHOWCASE_WORKGROUPS) {
      const group = workgroups[spec.key]
      const taskSpec = SHOWCASE_TASKS[spec.key]
      const task = await request<TaskRow>(`/api/workgroups/${group.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          name: taskSpec.name,
          goal: taskSpec.goal,
          scratch: true,
          expectedWorkgroupId: group.id,
          expectedWorkgroupVersion: group.version,
        }),
      })
      tasks[spec.key] = task
      log(`launched Task ${task.name ?? task.id} (${task.id})`)
    }
  }

  return { userId: me.user.id, agents, workgroups, tasks }
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const launch = args.includes('--launch')
  const baseUrl =
    optionValue(args, '--url') ?? process.env.AGENT_WORKFLOW_URL ?? 'http://127.0.0.1:7456'

  if (!apply) {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: 'dry-run',
          baseUrl,
          agents: SHOWCASE_AGENTS.map(({ key, name }) => ({ key, name })),
          workgroups: SHOWCASE_WORKGROUPS.map(({ key, name, mode, members }) => ({
            key,
            name,
            mode,
            members: members.map((member) => member.displayName),
          })),
          tasks: SHOWCASE_TASKS,
          next: 'Pass --apply with AGENT_WORKFLOW_TOKEN to create resources; add --launch to start all three scratch tasks.',
        },
        null,
        2,
      )}\n`,
    )
  } else {
    const token = optionValue(args, '--token') ?? process.env.AGENT_WORKFLOW_TOKEN
    if (token === undefined || token.length === 0) {
      throw new Error('--apply requires --token or AGENT_WORKFLOW_TOKEN')
    }
    if (launch) {
      process.stderr.write(
        'Launching uses the daemon configured runtime and may send task prompts to its model provider.\n',
      )
    }
    const result = await seedShowcase({
      baseUrl,
      token,
      launch,
      log: (message) => process.stderr.write(`${message}\n`),
    })
    process.stdout.write(
      `${JSON.stringify(
        {
          baseUrl,
          agents: result.agents,
          workgroups: result.workgroups,
          tasks: result.tasks,
        },
        null,
        2,
      )}\n`,
    )
  }
}
