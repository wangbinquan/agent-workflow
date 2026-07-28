#!/usr/bin/env bun
/**
 * Runnable business Workgroup scenario: a customer-data migration war room.
 *
 * The catalog is consumed directly by e2e/business-workgroup-scenarios.spec.ts,
 * so the checked-in example and the real-daemon contract test cannot drift.
 * CLI execution is dry-run by default. Pass --apply to create the resources
 * and --launch to additionally start the scratch task.
 */

import process from 'node:process'

interface AgentSpec {
  key: BusinessOperationsAgentKey
  name: string
  description: string
  bodyMd: string
  permission?: Record<string, unknown>
}

interface AgentRow {
  id: string
  name: string
  ownerUserId: string | null
}

interface AgentDetail extends AgentRow {
  description: string
  bodyMd: string
  inputs: unknown[]
  outputs: string[]
  outputKinds?: Record<string, string>
  outputWrapperPortNames?: Record<string, string>
  role?: string
  syncOutputsOnIterate: boolean
  runtime?: string
  permission: Record<string, unknown>
  skills: unknown[]
  dependsOn: unknown[]
  mcp: unknown[]
  plugins: unknown[]
  frontmatterExtra: Record<string, unknown>
}

interface WorkgroupRow {
  id: string
  name: string
  version: number
  ownerUserId: string | null
}

interface WorkgroupDetail extends WorkgroupRow {
  description: string
  instructions: string
  mode: string
  switches: { shareOutputs: boolean; directMessages: boolean; blackboard: boolean }
  maxRounds: number
  completionGate: boolean
  clarifyBudget?: number
  fanOut?: boolean
  members: Array<{
    memberType: 'agent' | 'human'
    agentId?: string | null
    userId: string | null
    displayName: string
    roleDesc: string
    sortOrder: number
  }>
}

interface TaskRow {
  id: string
  name: string | null
  status: string
}

export type BusinessOperationsAgentKey = 'migrationPlanner' | 'migrationRiskReviewer'

export interface BusinessOperationsSeedResult {
  userId: string
  agents: Record<BusinessOperationsAgentKey, AgentRow>
  workgroup: WorkgroupRow
  task?: TaskRow
}

export const BUSINESS_OPERATIONS_AGENTS: readonly AgentSpec[] = [
  {
    key: 'migrationPlanner',
    name: 'business-migration-planner',
    description: 'Plans a customer-data migration and turns risks into executable cards.',
    bodyMd:
      'Own the migration checklist, expose dependencies, and collaborate on concrete repository artifacts. Report partial failures honestly so only the affected card is retried.',
  },
  {
    key: 'migrationRiskReviewer',
    name: 'business-migration-risk-reviewer',
    description: 'Reviews migration risk and contributes a read-only planning track.',
    bodyMd:
      'Review migration risk, challenge missing controls, and contribute to planning without modifying the repository. Leave execution cards to the writable migration planner.',
    permission: { read: 'allow', edit: 'deny', write: 'deny' },
  },
]

export const BUSINESS_OPERATIONS_WORKGROUP = {
  name: 'business-customer-data-migration-war-room',
  description:
    'A leaderless migration war room that collects independent planning tracks, executes cards in batches, retries one failed validation card, preserves successful work, and closes through human approval.',
  instructions:
    'BUSINESS_MIGRATION_CHARTER. Protect customer data, keep every card independently auditable, publish blockers to the room, and retry only the card whose evidence is incomplete.',
  mode: 'free_collab' as const,
  switches: { shareOutputs: true, directMessages: true, blackboard: true },
  maxRounds: 16,
  completionGate: true,
  clarifyBudget: 0,
  members: [
    {
      agentKey: 'migrationPlanner' as const,
      displayName: 'migration-planner',
      roleDesc: 'decompose and execute migration controls, including bounded retries',
    },
    {
      agentKey: 'migrationRiskReviewer' as const,
      displayName: 'migration-risk-reviewer',
      roleDesc: 'read-only risk review and independent planning',
    },
  ],
}

export const BUSINESS_OPERATIONS_TASK = {
  name: 'Business scenario: customer data migration war room',
  goal: 'BUSINESS_MIGRATION_GOAL. Prepare a controlled 125000-record customer-data migration batch: freeze the source schema, require an exact record-count match plus a verified encrypted-export checksum, and produce a rollback runbook. Keep completed controls intact when one validation card needs another attempt, then request owner approval.',
}

function normalizeContract(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeContract)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
      .map(([key, item]) => [key, normalizeContract(item)]),
  )
}

function assertScenarioContract(label: string, actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(normalizeContract(actual))
  const expectedJson = JSON.stringify(normalizeContract(expected))
  if (actualJson === expectedJson) return
  throw new Error(
    `${label} already exists but its scenario contract has drifted; refusing to reuse it. ` +
      `expected=${expectedJson} actual=${actualJson}`,
  )
}

function projectAgentContract(detail: AgentDetail): Record<string, unknown> {
  return {
    description: detail.description,
    bodyMd: detail.bodyMd,
    inputs: detail.inputs,
    outputs: detail.outputs,
    outputKinds: detail.outputKinds ?? {},
    outputWrapperPortNames: detail.outputWrapperPortNames ?? {},
    role: detail.role ?? 'normal',
    syncOutputsOnIterate: detail.syncOutputsOnIterate,
    runtime: detail.runtime ?? null,
    permission: detail.permission,
    skills: detail.skills,
    dependsOn: detail.dependsOn,
    mcp: detail.mcp,
    plugins: detail.plugins,
    frontmatterExtra: detail.frontmatterExtra,
  }
}

function expectedAgentContract(spec: AgentSpec): Record<string, unknown> {
  return {
    description: spec.description,
    bodyMd: spec.bodyMd,
    inputs: [],
    outputs: [],
    outputKinds: {},
    outputWrapperPortNames: {},
    role: 'normal',
    syncOutputsOnIterate: true,
    runtime: null,
    permission: spec.permission ?? {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
  }
}

export async function seedBusinessOperationsScenario(input: {
  baseUrl: string
  token: string
  launch?: boolean
  log?: (message: string) => void
}): Promise<BusinessOperationsSeedResult> {
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
  const agents = {} as Record<BusinessOperationsAgentKey, AgentRow>

  for (const spec of BUSINESS_OPERATIONS_AGENTS) {
    let row = listedAgents.find(
      (candidate) => candidate.name === spec.name && candidate.ownerUserId === me.user.id,
    )
    if (row === undefined) {
      row = await request<AgentRow>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: spec.name,
          description: spec.description,
          bodyMd: spec.bodyMd,
          inputs: [],
          outputs: [],
          outputKinds: {},
          syncOutputsOnIterate: true,
          permission: spec.permission ?? {},
          skills: [],
          dependsOn: [],
          mcp: [],
          plugins: [],
          frontmatterExtra: {},
        }),
      })
      listedAgents.push(row)
      log(`created Agent ${row.name} (${row.id})`)
    } else {
      const detail = await request<AgentDetail>(`/api/agents/${row.id}`)
      assertScenarioContract(
        `Agent ${row.name}`,
        projectAgentContract(detail),
        expectedAgentContract(spec),
      )
      row = detail
      log(`verified and reused Agent ${row.name} (${row.id})`)
    }
    agents[spec.key] = row
  }

  const expectedMembers = [
    ...BUSINESS_OPERATIONS_WORKGROUP.members.map((member) => ({
      memberType: 'agent' as const,
      agentId: agents[member.agentKey].id,
      displayName: member.displayName,
      roleDesc: member.roleDesc,
    })),
    {
      memberType: 'human' as const,
      userId: me.user.id,
      displayName: 'migration-owner',
      roleDesc: 'approve the migration evidence and completion gate',
    },
  ]
  const expectedWorkgroupContract = {
    description: BUSINESS_OPERATIONS_WORKGROUP.description,
    instructions: BUSINESS_OPERATIONS_WORKGROUP.instructions,
    mode: BUSINESS_OPERATIONS_WORKGROUP.mode,
    switches: BUSINESS_OPERATIONS_WORKGROUP.switches,
    maxRounds: BUSINESS_OPERATIONS_WORKGROUP.maxRounds,
    completionGate: BUSINESS_OPERATIONS_WORKGROUP.completionGate,
    clarifyBudget: BUSINESS_OPERATIONS_WORKGROUP.clarifyBudget,
    fanOut: false,
    members: expectedMembers,
  }
  const listedWorkgroups = await request<WorkgroupRow[]>('/api/workgroups')
  let workgroup = listedWorkgroups.find(
    (candidate) =>
      candidate.name === BUSINESS_OPERATIONS_WORKGROUP.name && candidate.ownerUserId === me.user.id,
  )
  if (workgroup === undefined) {
    workgroup = await request<WorkgroupRow>('/api/workgroups', {
      method: 'POST',
      body: JSON.stringify({
        name: BUSINESS_OPERATIONS_WORKGROUP.name,
        ...expectedWorkgroupContract,
      }),
    })
    log(`created Workgroup ${workgroup.name} (${workgroup.id})`)
  } else {
    const detail = await request<WorkgroupDetail>(`/api/workgroups/${workgroup.id}`)
    assertScenarioContract(
      `Workgroup ${workgroup.name}`,
      {
        description: detail.description,
        instructions: detail.instructions,
        mode: detail.mode,
        switches: detail.switches,
        maxRounds: detail.maxRounds,
        completionGate: detail.completionGate,
        clarifyBudget: detail.clarifyBudget,
        fanOut: detail.fanOut ?? false,
        members: [...detail.members]
          .sort((left, right) => left.sortOrder - right.sortOrder)
          .map((member) =>
            member.memberType === 'agent'
              ? {
                  memberType: 'agent',
                  agentId: member.agentId,
                  displayName: member.displayName,
                  roleDesc: member.roleDesc,
                }
              : {
                  memberType: 'human',
                  userId: member.userId,
                  displayName: member.displayName,
                  roleDesc: member.roleDesc,
                },
          ),
      },
      expectedWorkgroupContract,
    )
    workgroup = detail
    log(`verified and reused Workgroup ${workgroup.name} (${workgroup.id})`)
  }

  let task: TaskRow | undefined
  if (input.launch === true) {
    task = await request<TaskRow>(`/api/workgroups/${workgroup.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        name: BUSINESS_OPERATIONS_TASK.name,
        goal: BUSINESS_OPERATIONS_TASK.goal,
        scratch: true,
        expectedWorkgroupId: workgroup.id,
        expectedWorkgroupVersion: workgroup.version,
      }),
    })
    log(`launched Task ${task.name ?? task.id} (${task.id})`)
  }

  return {
    userId: me.user.id,
    agents,
    workgroup,
    ...(task === undefined ? {} : { task }),
  }
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
          agents: BUSINESS_OPERATIONS_AGENTS.map(({ key, name }) => ({ key, name })),
          workgroup: {
            name: BUSINESS_OPERATIONS_WORKGROUP.name,
            mode: BUSINESS_OPERATIONS_WORKGROUP.mode,
            members: [
              ...BUSINESS_OPERATIONS_WORKGROUP.members.map((member) => member.displayName),
              'migration-owner',
            ],
          },
          task: BUSINESS_OPERATIONS_TASK,
          next: 'Pass --apply with AGENT_WORKFLOW_TOKEN to create resources; add --launch to start the scratch task.',
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
    const result = await seedBusinessOperationsScenario({
      baseUrl,
      token,
      launch,
      log: (message) => process.stderr.write(`${message}\n`),
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }
}
