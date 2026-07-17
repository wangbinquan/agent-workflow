// RFC-165 (T12) — /tasks/new: the unified 4-step task-creation wizard.
//
//   ① 执行方式 + 对象   (workflow / single agent / workgroup + which one)
//   ② 执行空间          (remote URL repos ⊕ scratch temp space)
//   ③ 名称 + 任务内容    (+ advanced fold: collaborators / git identity /
//                        branch & auto-push / limits / allowClarify)
//   ④ 只读确认          (summary with per-step "modify" backlinks; primary
//                        launch + secondary save-as-scheduled — swapped when
//                        `?schedule=1`)
//
// Deep links (`?kind=agent&agent=auditor`) pre-fill Step 1 and land on Step 2
// (D9). `?editScheduled=<id>` turns the wizard into the schedule's config
// editor: kind + object lock, every field seeds from the stored payload
// (kind-aware, RFC-159 absorbed), and Step 4's single button PUTs the rebuilt
// payload back.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Agent,
  CachedRepo,
  ScheduledTask,
  Task,
  TaskMembers,
  UserPublic,
  Workflow,
  WorkflowDefinition,
  Workgroup,
} from '@agent-workflow/shared'
import {
  isLooseValidBranchName,
  taskExecutionKind,
  workgroupLaunchReadiness,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, NumberInput, Switch, TextArea, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { ScheduleDialog } from '@/components/ScheduleDialog'
import { ChoiceCards } from '@/components/ChoiceCards'
import { Select } from '@/components/Select'
import { Stepper } from '@/components/Stepper'
import { UserPicker } from '@/components/UserPicker'
import { DynamicInput } from '@/components/launch/DynamicInput'
import { RepoSourceList, type MultiRepoBlockedReason } from '@/components/launch/RepoSourceList'
import { UploadPicker } from '@/components/launch/UploadPicker'
import { useActor } from '@/hooks/useActor'
import { useUserLookup } from '@/hooks/useUserLookup'
import { resolveUrlRepoPath, validateRepoUrl } from '@/lib/launch-repo-source'
import {
  buildAgentStartBody,
  buildScheduledEnvelope,
  taskToLaunchPayload,
  type WizardSeed,
  buildWorkflowStartBody,
  buildWorkflowStartFormData,
  buildWorkgroupStartBody,
  defaultWizardSpace,
  loadAutoCommitPushPref,
  loadSpaceKindPref,
  normalizeSeededInput,
  payloadToWizardSeed,
  saveAutoCommitPushPref,
  saveSpaceKindPref,
  type WizardKind,
} from '@/lib/task-wizard'
import { workgroupLaunchErrorMessage } from '@/lib/workgroup-launch'
import { Route as RootRoute } from './__root'

interface TaskWizardSearch {
  kind?: WizardKind
  /** Deep-link object refs — one per kind (workflow id / agent name / group name). */
  workflow?: string
  /** RFC-199: exact editor revision handed to the launch wizard. */
  workflowVersion?: number
  agent?: string
  workgroup?: string
  /** `?schedule=1` — scheduled mode: save-as-scheduled becomes the primary action. */
  schedule?: boolean
  /** RFC-159 absorbed — edit an existing schedule's launch config. */
  editScheduled?: string
  /** RFC-175 — "relaunch": pre-fill from a terminal task's persisted params. */
  relaunchFrom?: string
}

export const TaskWizardRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/new',
  component: TaskWizardPage,
  validateSearch: (raw: Record<string, unknown>): TaskWizardSearch => {
    const out: TaskWizardSearch = {}
    if (raw.kind === 'workflow' || raw.kind === 'agent' || raw.kind === 'workgroup')
      out.kind = raw.kind
    for (const k of ['workflow', 'agent', 'workgroup', 'editScheduled', 'relaunchFrom'] as const) {
      const v = raw[k]
      if (typeof v === 'string' && v.length > 0) out[k] = v
    }
    const rawWorkflowVersion = raw.workflowVersion
    const numericWorkflowVersion =
      typeof rawWorkflowVersion === 'number'
        ? rawWorkflowVersion
        : typeof rawWorkflowVersion === 'string' && rawWorkflowVersion.trim() !== ''
          ? Number(rawWorkflowVersion)
          : undefined
    if (
      numericWorkflowVersion !== undefined &&
      Number.isInteger(numericWorkflowVersion) &&
      numericWorkflowVersion > 0
    ) {
      out.workflowVersion = numericWorkflowVersion
    }
    if (raw.schedule === true || raw.schedule === 1 || raw.schedule === '1') out.schedule = true
    return out
  },
})

const STEP_MODE = 0
const STEP_SPACE = 1
const STEP_CONTENT = 2
const STEP_CONFIRM = 3

function TaskWizardPage() {
  const { t } = useTranslation()
  const search = TaskWizardRoute.useSearch()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const actor = useActor()
  const isEdit = search.editScheduled !== undefined
  // RFC-175: "relaunch" pre-fills from a terminal task (editScheduled wins if both).
  const isRelaunch = search.relaunchFrom !== undefined && !isEdit

  // --- Step 1 state: execution kind + object -------------------------------
  const deepObject =
    search.kind === 'workflow'
      ? search.workflow
      : search.kind === 'agent'
        ? search.agent
        : search.kind === 'workgroup'
          ? search.workgroup
          : undefined
  const [kind, setKind] = useState<WizardKind>(search.kind ?? 'agent')
  const [workflowId, setWorkflowId] = useState(
    search.kind === 'workflow' ? (search.workflow ?? '') : '',
  )
  const [agentName, setAgentName] = useState(search.kind === 'agent' ? (search.agent ?? '') : '')
  const [workgroupName, setWorkgroupName] = useState(
    search.kind === 'workgroup' ? (search.workgroup ?? '') : '',
  )
  // RFC-175 (§2b/§2e, R4-F2/R8-F3): the CAPTURED subject id for the relaunch OCC
  // guard — set at seed-after-verify or explicit re-pick, NOT re-derived from the
  // live inventory each render (a background refresh must not silently adopt a
  // same-name replacement's id). undefined ⇒ no guard sent (fresh pick, or a
  // historical task with no stored id → best-effort by name).
  const [selectedWorkgroupId, setSelectedWorkgroupId] = useState<string | undefined>(undefined)
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined)
  // RFC-175 + RFC-199: every immediate WORKFLOW launch captures the exact
  // `workflows.version` its inputs were normalized against. Editor deep links
  // additionally require their validated version to match the first detail
  // read; later background advances never silently reseed user-entered inputs.
  const [normalizedWorkflowRevision, setNormalizedWorkflowRevision] = useState<{
    workflowId: string
    version: number
    definition: WorkflowDefinition
  } | null>(null)
  const normalizedWorkflowVersion =
    kind === 'workflow' && normalizedWorkflowRevision?.workflowId === workflowId
      ? normalizedWorkflowRevision.version
      : undefined
  const normalizedWorkflowDefinition =
    kind === 'workflow' && normalizedWorkflowRevision?.workflowId === workflowId
      ? normalizedWorkflowRevision.definition
      : undefined
  const [workflowVersionMismatch, setWorkflowVersionMismatch] = useState<{
    workflowId: string
    expected: number
    current: number
  } | null>(null)

  // --- Step 2 state: execution space (D9: default remote, remember last) ---
  const [space, setSpace] = useState(() =>
    defaultWizardSpace(isEdit ? 'remote' : loadSpaceKindPref()),
  )

  // --- Step 3 state: name + content + advanced fold -------------------------
  const [taskName, setTaskName] = useState('')
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [uploads, setUploads] = useState<Record<string, File[]>>({})
  const [description, setDescription] = useState('')
  const [goal, setGoal] = useState('')
  // 单 agent 全新启动默认「不允许反问」（用户 2026-07-14）——保留开关，用户可按需勾选。
  // 后端 StartAgentTaskSchema.allowClarify 仍 default(true)：那是 RFC-175 relaunch/edit
  // 的「wire 省略 ⟺ 原值 true」重建锚点，翻它会误读旧持久化 launchPayload；产品默认在此处。
  // relaunch/edit 会经 applyWizardSeed → setAllowClarify(seed.allowClarify) 覆盖此默认。
  const [allowClarify, setAllowClarify] = useState(false)
  const [collaborators, setCollaborators] = useState<UserPublic[]>([])
  const [gitUserName, setGitUserName] = useState('')
  const [gitUserEmail, setGitUserEmail] = useState('')
  const [workingBranch, setWorkingBranch] = useState('')
  const [autoCommitPush, setAutoCommitPush] = useState(loadAutoCommitPushPref())
  const [maxDurationMin, setMaxDurationMin] = useState<number | undefined>(undefined)
  const [maxTotalTokens, setMaxTotalTokens] = useState<number | undefined>(undefined)

  // --- Wizard chrome: current step + reachable frontier ---------------------
  const deepLinked = search.kind !== undefined && deepObject !== undefined && !isEdit
  const [step, setStep] = useState(deepLinked ? STEP_SPACE : STEP_MODE)
  const [maxVisited, setMaxVisited] = useState(deepLinked ? STEP_SPACE : STEP_MODE)
  const [saveScheduledOpen, setSaveScheduledOpen] = useState(false)

  // --- Object lists (Step 1) -------------------------------------------------
  const workflowsQ = useQuery<Workflow[]>({
    queryKey: ['workflows'],
    queryFn: ({ signal }) => api.get('/api/workflows', undefined, signal),
  })
  const agentsQ = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
  })
  const workgroupsQ = useQuery<Workgroup[]>({
    queryKey: ['workgroups'],
    queryFn: ({ signal }) => api.get('/api/workgroups', undefined, signal),
  })

  // RFC-175: the source task + its members, for relaunch pre-fill.
  // RFC-175 impl-gate F1: both queries SHARE their keys with the task detail
  // page's task/members queries (global staleTime 5s), so React Query would
  // serve a stale cache hit immediately and the seed barrier below would lock
  // on it — re-granting a since-removed collaborator (ACL regression). Force a
  // fresh fetch this mount and gate seeding on `isFetchedAfterMount`.
  const relaunchTaskQ = useQuery<Task>({
    queryKey: ['tasks', search.relaunchFrom],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(search.relaunchFrom ?? '')}`, undefined, signal),
    enabled: isRelaunch,
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const relaunchMembersQ = useQuery<TaskMembers>({
    queryKey: ['tasks', search.relaunchFrom, 'members'],
    queryFn: ({ signal }) =>
      api.get(
        `/api/tasks/${encodeURIComponent(search.relaunchFrom ?? '')}/members`,
        undefined,
        signal,
      ),
    enabled: isRelaunch,
    staleTime: 0,
    refetchOnMount: 'always',
  })

  // Selected workflow detail — the wizard needs `definition.inputs` for Step 3.
  const workflowQ = useQuery<Workflow>({
    queryKey: ['workflows', workflowId],
    queryFn: ({ signal }) =>
      api.get(`/api/workflows/${encodeURIComponent(workflowId)}`, undefined, signal),
    enabled: kind === 'workflow' && workflowId !== '',
    // The editor handoff is an exact revision fence. A shared 5s cache hit is
    // only a placeholder until this wizard mount has observed fresh server
    // truth; otherwise a writer between validate and navigation stays hidden.
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: 15_000,
  })

  const expectedWorkflowVersionForCurrentSelection =
    kind === 'workflow' && normalizedWorkflowRevision?.workflowId === workflowId
      ? normalizedWorkflowRevision.version
      : search.kind === 'workflow' && search.workflow === workflowId
        ? search.workflowVersion
        : undefined
  // Derive the live mismatch in render as well as persisting it in state. A
  // query update renders before its effect runs; gating only on effect-owned
  // state would leave one paint where a stale vN form could still submit vN+1.
  const observedWorkflowVersionMismatch =
    kind === 'workflow' &&
    workflowQ.data !== undefined &&
    workflowQ.isFetchedAfterMount &&
    workflowQ.isSuccess &&
    expectedWorkflowVersionForCurrentSelection !== undefined &&
    workflowQ.data.version !== expectedWorkflowVersionForCurrentSelection
      ? {
          workflowId,
          expected: expectedWorkflowVersionForCurrentSelection,
          current: workflowQ.data.version,
        }
      : null
  const activeWorkflowVersionMismatch = observedWorkflowVersionMismatch ?? workflowVersionMismatch

  // RFC-110: matched cached clone for the files/git input pickers.
  const cachedRepos = useQuery<{ items: CachedRepo[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
  })

  // RFC-175: apply a reconstructed WizardSeed to the field state — shared by the
  // ?editScheduled= and ?relaunchFrom= seed paths (does NOT touch kind / subject
  // id capture / collaborators / step — those stay path-specific).
  const applyWizardSeed = (seed: WizardSeed): void => {
    setWorkflowId(seed.workflowId ?? '')
    setAgentName(seed.agentName ?? '')
    setWorkgroupName(seed.workgroupName ?? '')
    setSpace(seed.space)
    setTaskName(seed.taskName)
    setInputs(seed.inputs)
    setDescription(seed.description)
    setGoal(seed.goal)
    setAllowClarify(seed.allowClarify)
    setGitUserName(seed.gitUserName)
    setGitUserEmail(seed.gitUserEmail)
    setWorkingBranch(seed.workingBranch)
    setAutoCommitPush(seed.autoCommitPush)
    // Keep the exact stored value: fractional minutes round-trip back to the
    // original ms via Math.round(min * 60_000) — a no-op save must not mutate a
    // limit like 123456ms into 120000ms (Codex P2).
    setMaxDurationMin(seed.maxDurationMs !== undefined ? seed.maxDurationMs / 60_000 : undefined)
    setMaxTotalTokens(seed.maxTotalTokens)
  }

  // --- editScheduled: load + seed (kind-aware, one-shot) ---------------------
  const scheduleQ = useQuery<ScheduledTask>({
    queryKey: ['scheduled-tasks', 'detail', search.editScheduled],
    queryFn: ({ signal }) =>
      api.get(
        `/api/scheduled-tasks/${encodeURIComponent(search.editScheduled ?? '')}`,
        undefined,
        signal,
      ),
    enabled: isEdit,
  })
  const seededRef = useRef(false)
  const seedCollabIds = useRef<string[]>([])
  const [seedFailed, setSeedFailed] = useState(false)
  // RFC-175 impl-gate F2: set when a relaunch source's space could not be
  // faithfully rebuilt (internal/fusion, legacy path-mode, or materialize-failed
  // with a possibly-truncated repo prefix) — drives a notice on the space step.
  const [spaceUnresolved, setSpaceUnresolved] = useState(false)
  useEffect(() => {
    if (!isEdit || scheduleQ.data === undefined || seededRef.current) return
    seededRef.current = true
    const row = scheduleQ.data
    setKind(row.launchKind)
    const payload = row.launchPayload as Record<string, unknown> | null
    const seed = payload === null ? null : payloadToWizardSeed(row.launchKind, payload)
    if (seed === null) {
      // Degraded / legacy payload — kind stays locked, fields stay blank for
      // repair (a full re-fill + save rewrites the row).
      setSeedFailed(true)
      setStep(STEP_MODE)
      setMaxVisited(STEP_CONFIRM)
      return
    }
    applyWizardSeed(seed)
    seedCollabIds.current = seed.collaboratorUserIds
    // Everything is pre-filled — open every step so the user can jump straight
    // to what they want to change (or to Confirm to just re-save).
    setStep(STEP_SPACE)
    setMaxVisited(STEP_CONFIRM)
  }, [isEdit, scheduleQ.data])

  // Collaborator ids → UserPublic chips (second async hop, RFC-159 pattern).
  const collabLookup = useUserLookup(seedCollabIds.current)
  const collabSeededRef = useRef(false)
  useEffect(() => {
    if (!seededRef.current || collabSeededRef.current) return
    const ids = seedCollabIds.current
    if (ids.length === 0) {
      collabSeededRef.current = true
      return
    }
    if (collabLookup.isLoading) return
    setCollaborators(
      ids.map((cid) => collabLookup.get(cid)).filter((u): u is UserPublic => u !== undefined),
    )
    collabSeededRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, scheduleQ.data, collabLookup.isLoading])

  // --- RFC-175 relaunch: load task + members → seed (one-shot, kind-aware) ----
  const relaunchSeededRef = useRef(false)
  // Reactive twin of the one-shot ref (final-gate F1-followup-2): the SUBMIT gate
  // must not open until this effect has actually run PAST its fresh-fetch barrier
  // and applied the seed. A cached shared-key hit keeps relaunchTaskQ.isSuccess
  // true during the forced background refetch (isFetchedAfterMount still false),
  // so gating relaunchReady on isSuccess would let a user submit the DEFAULT form
  // pre-seed. This flag flips true only inside the effect, after the barrier.
  const [relaunchApplied, setRelaunchApplied] = useState(false)
  useEffect(() => {
    if (!isRelaunch || relaunchSeededRef.current) return
    // Barrier: the SOURCE TASK gates everything — it drives the kind, the
    // subject-id guard, and (for agent/workflow only) the seeded collaborators.
    //
    // Fresh-fetch barrier (impl-gate F1 + re-review): require this mount's fetch
    // to have SUCCEEDED before seeding. isFetchedAfterMount alone is insufficient
    // — an errored refetch keeps the STALE cached `data` and still flips that
    // flag, which would re-grant a since-removed collaborator. Gate on isSuccess
    // too, and on error do NOT set the one-shot ref (return early) so a later
    // successful retry re-enters and seeds fresh; the error surfaces via
    // relaunchError + the submit gate.
    if (!relaunchTaskQ.isFetchedAfterMount || !relaunchTaskQ.isSuccess) return
    if (relaunchTaskQ.data === undefined) return
    if (actor.isPending) return
    const task = relaunchTaskQ.data
    const kind = taskExecutionKind(task)
    if (kind === 'workgroup' && workgroupsQ.data === undefined) return
    if (kind === 'agent' && agentsQ.data === undefined) return
    // Members feed ONLY the agent/workflow collaborator seed — a WORKGROUP
    // relaunch never consumes them, so it must NOT be blocked by a members fetch
    // it does not use (re-review F1-followup). Require the fresh successful
    // members fetch only for non-workgroup kinds (derived from the task, not the
    // wizard's default kind state).
    if (
      kind !== 'workgroup' &&
      (!relaunchMembersQ.isFetchedAfterMount ||
        !relaunchMembersQ.isSuccess ||
        relaunchMembersQ.data === undefined)
    )
      return
    relaunchSeededRef.current = true
    // Past the barrier — open the submit gate (batched with the seed setState
    // below, so no render sees relaunchApplied=true before the seed is applied).
    setRelaunchApplied(true)

    const { payload, spaceResolvable } = taskToLaunchPayload(task)
    const seed = payloadToWizardSeed(kind, payload)
    if (seed === null) {
      setSeedFailed(true)
      setStep(STEP_MODE)
      setMaxVisited(STEP_CONFIRM)
      return
    }
    setKind(kind)
    // Impl-gate F2: an unresolvable space (internal/fusion, legacy path-mode with
    // no URL, or a task that failed during materialize and may hold only a repo
    // PREFIX) must NOT seed a partial/wrong space. Blank it to a single empty
    // remote row and flag a notice so the user rebuilds it explicitly; sourceReady
    // (which now requires a non-empty repo list) blocks the launch until they do.
    applyWizardSeed(spaceResolvable ? seed : { ...seed, space: defaultWizardSpace('remote') })
    setSpaceUnresolved(!spaceResolvable)

    // Subject-identity guard + CAPTURED id (§4.7). Pre-select ONLY when the
    // current same-named resource is the SAME one the task ran (id match); else
    // clear + force an explicit re-pick — never target a same-name replacement.
    if (kind === 'workgroup') {
      const cur = (workgroupsQ.data ?? []).find((g) => g.name === seed.workgroupName)
      if (cur !== undefined && cur.id === task.workgroupId) {
        setSelectedWorkgroupId(cur.id)
      } else {
        setWorkgroupName('')
        setSelectedWorkgroupId(undefined)
      }
    } else if (kind === 'agent') {
      const cur = (agentsQ.data ?? []).find((a) => a.name === seed.agentName)
      if (task.sourceAgentId == null) {
        setSelectedAgentId(undefined) // historical task: no id to verify → by name
      } else if (cur !== undefined && cur.id === task.sourceAgentId) {
        setSelectedAgentId(cur.id)
      } else {
        setAgentName('')
        setSelectedAgentId(undefined)
      }
    }

    // Collaborators (§4.5, R3-F4): agent/workflow pre-fill the task's CURRENT
    // members (owner + collaborators) minus the launcher; workgroup does NOT
    // (its stored set unions auto-added human members — the launch re-derives
    // those, and replaying would over-grant to members since removed). The
    // barrier above guarantees a fresh successful members fetch for non-workgroup.
    const members = relaunchMembersQ.data
    if (kind !== 'workgroup' && members !== undefined) {
      const launcherId = actor.data?.source !== 'daemon' ? actor.data?.user.id : undefined
      const seen = new Set<string>()
      setCollaborators(
        [members.owner, ...members.users].filter(
          (u): u is UserPublic =>
            u != null && u.id !== launcherId && (seen.has(u.id) ? false : (seen.add(u.id), true)),
        ),
      )
    }

    setStep(STEP_MODE)
    setMaxVisited(STEP_CONFIRM)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isRelaunch,
    relaunchTaskQ.data,
    relaunchMembersQ.data,
    relaunchTaskQ.isFetchedAfterMount,
    relaunchMembersQ.isFetchedAfterMount,
    relaunchTaskQ.isSuccess,
    relaunchMembersQ.isSuccess,
    workgroupsQ.data,
    agentsQ.data,
    actor.isPending,
  ])

  // Seed the inputs map from the selected workflow's declared keys (merge:
  // stale keys drop, new keys start blank, user-typed values survive). The
  // uploads map is filtered in lockstep — leaving files picked for a PREVIOUS
  // workflow would force a multipart submit with unknown keys (Codex P2).
  useEffect(() => {
    if (
      kind !== 'workflow' ||
      workflowQ.data === undefined ||
      !workflowQ.isFetchedAfterMount ||
      !workflowQ.isSuccess
    )
      return
    const capturedVersion =
      normalizedWorkflowRevision?.workflowId === workflowId
        ? normalizedWorkflowRevision.version
        : undefined
    const expectedVersion = expectedWorkflowVersionForCurrentSelection
    if (expectedVersion !== undefined && workflowQ.data.version !== expectedVersion) {
      setWorkflowVersionMismatch({
        workflowId,
        expected: expectedVersion,
        current: workflowQ.data.version,
      })
      return
    }
    setWorkflowVersionMismatch((current) => (current?.workflowId === workflowId ? null : current))
    if (capturedVersion === undefined) {
      setNormalizedWorkflowRevision({
        workflowId,
        version: workflowQ.data.version,
        // React Query replaces cache values, but keep a private immutable-ish
        // snapshot so a later vN+1 refresh cannot redraw vN fields under the
        // user's already-entered values.
        definition: structuredClone(workflowQ.data.definition),
      })
    }
    const defs = workflowQ.data.definition.inputs ?? []
    setInputs((prev) => {
      const seeded: Record<string, string> = {}
      for (const i of defs) {
        // RFC-175 (§4.8, R4-F3 + impl-gate F3): normalize each seeded value
        // against the CURRENT def. Clears stale upload paths (browser can't
        // rebuild a File) AND enum values no longer among the declared choices
        // (they render blank in EnumPicker but would still submit) — the
        // missingRequired gate then forces a visible re-pick. Valid values and
        // free-form text/git survive untouched, so a normal launch is unaffected.
        seeded[i.key] = normalizeSeededInput(i, prev[i.key] ?? '')
      }
      return seeded
    })
    const uploadKeys = new Set(defs.filter((d) => d.kind === 'upload').map((d) => d.key))
    setUploads((prev) => {
      const kept = Object.entries(prev).filter(([k]) => uploadKeys.has(k))
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept)
    })
  }, [
    kind,
    expectedWorkflowVersionForCurrentSelection,
    normalizedWorkflowRevision,
    workflowId,
    workflowQ.data,
    workflowQ.isFetchedAfterMount,
    workflowQ.isSuccess,
  ])

  // --- Step 1 filtering (launchability projection) ---------------------------
  const workflowOptions = (workflowsQ.data ?? [])
    .filter((w) => w.builtin !== true)
    .map((w) => ({ value: w.id, label: w.name }))
  const agentOptions = (agentsQ.data ?? [])
    .filter((a) => a.builtin !== true)
    .map((a) => ({ value: a.name, label: a.name }))
  const workgroupOptions = (workgroupsQ.data ?? []).map((g) => {
    const readiness = workgroupLaunchReadiness(g)
    // RFC-187 TRAP-1 (Codex impl-gate P2): the ADVISORY tier must reach the
    // launch wizard too — a leader-only roster stays selectable (warning
    // never blocks) but says so, instead of silently launching a group that
    // can only idle. Blocking reasons keep the disabled treatment.
    return {
      value: g.name,
      label: g.name,
      ...(readiness.ready
        ? readiness.warnings.length > 0
          ? { description: t('taskWizard.workgroupLeaderOnlyWarning') }
          : {}
        : { disabled: true, description: t('taskWizard.workgroupNotReady') }),
    }
  })
  const activeInventoryQ =
    kind === 'workflow' ? workflowsQ : kind === 'agent' ? agentsQ : workgroupsQ
  const activeInventoryLoading = activeInventoryQ.data === undefined && activeInventoryQ.isLoading
  const activeInventoryError =
    activeInventoryQ.error !== null && activeInventoryQ.error !== undefined
  const activeInventoryEmpty =
    kind === 'workflow'
      ? workflowOptions.length === 0
      : kind === 'agent'
        ? agentOptions.length === 0
        : workgroupOptions.length === 0
  const objectFieldLabel =
    kind === 'workflow'
      ? t('taskWizard.objectWorkflow')
      : kind === 'agent'
        ? t('taskWizard.objectAgent')
        : t('taskWizard.objectWorkgroup')
  const objectPicker =
    kind === 'workflow' ? (
      <Select
        value={workflowId}
        onChange={(nextWorkflowId) => {
          setWorkflowId(nextWorkflowId)
          setNormalizedWorkflowRevision(null)
          setWorkflowVersionMismatch(null)
        }}
        options={workflowOptions}
        searchable
        ariaLabel={objectFieldLabel}
        placeholder={t('taskWizard.objectPlaceholder')}
        data-testid="wizard-object-workflow"
      />
    ) : kind === 'agent' ? (
      <Select
        value={agentName}
        onChange={(name) => {
          setAgentName(name)
          // RFC-175 (R8-F3): capture the picked agent's CURRENT id so an
          // explicit re-pick sends the guard for the chosen agent (not a
          // stale seeded id → no false 409).
          setSelectedAgentId((agentsQ.data ?? []).find((a) => a.name === name)?.id)
        }}
        options={agentOptions}
        searchable
        ariaLabel={objectFieldLabel}
        placeholder={t('taskWizard.objectPlaceholder')}
        data-testid="wizard-object-agent"
      />
    ) : (
      <Select
        value={workgroupName}
        onChange={(name) => {
          setWorkgroupName(name)
          setSelectedWorkgroupId((workgroupsQ.data ?? []).find((g) => g.name === name)?.id)
        }}
        options={workgroupOptions}
        searchable
        ariaLabel={objectFieldLabel}
        placeholder={t('taskWizard.objectPlaceholder')}
        data-testid="wizard-object-workgroup"
      />
    )

  const selectedObject =
    kind === 'workflow' ? workflowId : kind === 'agent' ? agentName : workgroupName
  const selectedObjectLabel =
    kind === 'workflow'
      ? (workflowOptions.find((o) => o.value === workflowId)?.label ??
        workflowQ.data?.name ??
        workflowId)
      : selectedObject

  // --- Gating ---------------------------------------------------------------
  const inputDefs = kind === 'workflow' ? (normalizedWorkflowDefinition?.inputs ?? []) : []
  const missingRequired = inputDefs.some((def) => {
    if (def.kind === 'upload') {
      const list = uploads[def.key] ?? []
      const rec = def as Record<string, unknown>
      const minCount = typeof rec.minCount === 'number' ? rec.minCount : 0
      if (def.required === true && list.length === 0) return true
      return list.length < minCount
    }
    if (def.required !== true) return false
    const raw = (inputs[def.key] ?? '').trim()
    if (raw === '') return true
    // Re-review F3: a required multi-select whose value is an empty array ('[]')
    // — or an unparseable non-selection — is "nothing picked" and must count as
    // missing, even though the raw string is non-empty.
    if (def.kind === 'enum' && (def as Record<string, unknown>).multiSelect === true) {
      try {
        const parsed: unknown = JSON.parse(raw)
        return Array.isArray(parsed) && parsed.length === 0
      } catch {
        return true
      }
    }
    return false
  })
  const hasUploads = Object.values(uploads).some((arr) => arr.length > 0)
  const hasUploadInput = inputDefs.some((d) => d.kind === 'upload')
  const hasWrapperGitNode =
    kind === 'workflow' &&
    (normalizedWorkflowDefinition?.nodes ?? []).some((n) => n.kind === 'wrapper-git')
  const multiRepoBlockedReason: MultiRepoBlockedReason | null =
    kind === 'workflow' && space.kind === 'remote' && space.repos.length > 1
      ? hasWrapperGitNode
        ? 'wrapper-git'
        : hasUploadInput
          ? 'upload'
          : null
      : null

  const stepModeReady = selectedObject !== ''
  // Impl-gate F2: `[].every()` is vacuously true, so a zero-repo remote space
  // (produced by seeding an unresolvable source) would wrongly read "ready".
  // A remote launch needs at least one valid repo.
  const sourceReady =
    space.kind === 'scratch' ||
    (space.repos.length > 0 && space.repos.every((r) => validateRepoUrl(r.repoUrl) === null))
  const nameReady = taskName.trim().length > 0
  // Codex P1: while the workflow detail is loading (or failed), inputDefs is
  // empty and missingRequired reads false — the wizard must NOT treat that as
  // "no required inputs" and let a launch skip them (or skip the multipart
  // path for upload inputs). Require a SUCCESSFUL detail load.
  const contentReady =
    kind === 'workflow'
      ? workflowQ.isSuccess &&
        workflowQ.isFetchedAfterMount &&
        normalizedWorkflowVersion !== undefined &&
        activeWorkflowVersionMismatch === null &&
        !missingRequired
      : kind === 'agent'
        ? description.trim().length > 0
        : goal.trim().length > 0
  const gitNameTrim = gitUserName.trim()
  const gitEmailTrim = gitUserEmail.trim()
  const gitBoth = gitNameTrim !== '' && gitEmailTrim !== ''
  const gitNeither = gitNameTrim === '' && gitEmailTrim === ''
  const gitPairingError = !gitBoth && !gitNeither
  const gitEmailFormatError = gitEmailTrim !== '' && !/^[^\s@]+@[^\s@]+$/.test(gitEmailTrim)
  const gitIdentityOk = gitNeither || (gitBoth && !gitEmailFormatError)
  const workingBranchTrim = workingBranch.trim()
  const workingBranchError =
    space.kind === 'remote' &&
    workingBranchTrim !== '' &&
    !isLooseValidBranchName(workingBranchTrim)
  // Codex P2: NumberInput's native min/step don't gate button-driven submits —
  // zero/negative limits would be silently dropped off the wire and a
  // fractional token cap would 422 against the integer schema.
  const durationInvalid = maxDurationMin !== undefined && maxDurationMin <= 0
  const tokensInvalid =
    maxTotalTokens !== undefined && (maxTotalTokens <= 0 || !Number.isInteger(maxTotalTokens))
  const limitsOk = !durationInvalid && !tokensInvalid
  const stepContentReady =
    nameReady && contentReady && gitIdentityOk && !workingBranchError && limitsOk
  // RFC-159 P2: editing a schedule with collaborators must wait for the id →
  // UserPublic lookup, else Save rebuilds the body with an empty set.
  const collabReady = !isEdit || seedCollabIds.current.length === 0 || collabLookup.isSuccess
  // RFC-175 (R3-F3): a relaunch must not submit until the source task AND (for
  // agent/workflow) its members have loaded — else the launch would fire with
  // empty/wrong collaborators or a half-applied seed. Derive the members
  // requirement from the SOURCE task's kind, NOT the wizard's default `kind`
  // state — for a workgroup source `kind` is still 'agent'/'workflow' until the
  // seed effect runs, and keying off it wrongly blocked a workgroup relaunch on
  // an unrelated members fetch (re-review F1-followup).
  const relaunchSourceKind =
    isRelaunch && relaunchTaskQ.data !== undefined
      ? taskExecutionKind(relaunchTaskQ.data)
      : undefined
  const relaunchNeedsMembers =
    relaunchSourceKind !== undefined && relaunchSourceKind !== 'workgroup'
  // Point the banner at whichever query actually failed (task, or members for a
  // non-workgroup source) so it never renders a null task error while members is
  // the real failure.
  const relaunchErrorQ = relaunchTaskQ.isError
    ? relaunchTaskQ
    : relaunchNeedsMembers && relaunchMembersQ.isError
      ? relaunchMembersQ
      : null
  const relaunchError = isRelaunch && relaunchErrorQ !== null
  // Final-gate F1-followup-2: gate the submit on the reactive relaunchApplied
  // flag (set only after the seed effect passes its full fresh-fetch barrier),
  // NOT on relaunchTaskQ.isSuccess — a cached success can precede the applied
  // seed, opening a pre-seed submit window. relaunchApplied ⇒ task fresh-success
  // + (non-workgroup) members fresh-success + actor/inventory ready + seed applied.
  const relaunchReady = !isRelaunch || relaunchApplied

  const nextEnabled =
    step === STEP_MODE ? stepModeReady : step === STEP_SPACE ? sourceReady : stepContentReady

  const onNavigate = (i: number) => {
    setStep(i)
    setMaxVisited((mv) => Math.max(mv, i))
  }

  // --- Submission -------------------------------------------------------------
  const collectAdvanced = () => ({
    ...(collaborators.length > 0 ? { collaboratorUserIds: collaborators.map((u) => u.id) } : {}),
    ...(gitBoth ? { gitUserName: gitNameTrim, gitUserEmail: gitEmailTrim } : {}),
    ...(workingBranchTrim !== '' ? { workingBranch: workingBranchTrim } : {}),
    ...(autoCommitPush ? { autoCommitPush: true } : {}),
    ...(maxDurationMin !== undefined && maxDurationMin > 0
      ? { maxDurationMs: Math.round(maxDurationMin * 60_000) }
      : {}),
    ...(maxTotalTokens !== undefined && maxTotalTokens > 0 ? { maxTotalTokens } : {}),
  })

  const buildImmediateBody = (): Record<string, unknown> => {
    if (kind === 'agent') {
      return buildAgentStartBody(space, {
        name: taskName.trim(),
        description: description.trim(),
        allowClarify,
        ...collectAdvanced(),
      })
    }
    if (kind === 'workgroup') {
      return buildWorkgroupStartBody(space, {
        name: taskName.trim(),
        goal: goal.trim(),
        ...collectAdvanced(),
      })
    }
    return buildWorkflowStartBody(space, {
      workflowId,
      name: taskName.trim(),
      inputs,
      ...collectAdvanced(),
    })
  }

  // RFC-175 (§2d): immediate-submit OCC guards — spread onto the immediate POST
  // body ONLY, never into buildImmediateBody (scheduledEnvelope reuses that; a
  // persisted schedule must not carry a point-in-time guard — R6/R7-F1).
  const immediateGuards = (): Record<string, unknown> => {
    if (kind === 'agent')
      return selectedAgentId !== undefined ? { expectedAgentId: selectedAgentId } : {}
    if (kind === 'workgroup')
      return selectedWorkgroupId !== undefined ? { expectedWorkgroupId: selectedWorkgroupId } : {}
    return normalizedWorkflowVersion !== undefined
      ? { expectedWorkflowVersion: normalizedWorkflowVersion }
      : {}
  }

  const start = useMutation({
    mutationFn: () => {
      if (kind === 'agent') {
        return api.post<Task>(`/api/agents/${encodeURIComponent(agentName)}/tasks`, {
          ...buildImmediateBody(),
          ...immediateGuards(),
        })
      }
      if (kind === 'workgroup') {
        return api.post<Task>(`/api/workgroups/${encodeURIComponent(workgroupName)}/tasks`, {
          ...buildImmediateBody(),
          ...immediateGuards(),
        })
      }
      // RFC-020: any upload-kind input drives a multipart submit even with
      // zero picked files, so the backend's central min/max gate runs.
      if (hasUploadInput || hasUploads) {
        return api.postMultipart<Task>(
          '/api/tasks',
          buildWorkflowStartFormData(
            space,
            { workflowId, name: taskName.trim(), inputs, ...collectAdvanced() },
            uploads,
            // Impl-gate F4: the JSON path spreads immediateGuards() but any
            // upload-bearing workflow routes HERE — thread the same OCC guard
            // (expectedWorkflowVersion) into the multipart payload so a concurrent
            // workflow PUT still 409s instead of launching new-snapshot/old-params.
            immediateGuards(),
          ),
        )
      }
      return api.post<Task>('/api/tasks', { ...buildImmediateBody(), ...immediateGuards() })
    },
    onSuccess: (created) => navigate({ to: '/tasks/$id', params: { id: created.id } }),
  })

  const startWorkflowVersionMismatch =
    kind === 'workflow' && isWorkflowVersionMismatchError(start.error)

  const adoptLatestWorkflow = (latest: Workflow): void => {
    const defs = latest.definition.inputs ?? []
    setNormalizedWorkflowRevision({
      workflowId,
      version: latest.version,
      definition: structuredClone(latest.definition),
    })
    setInputs((previous) =>
      Object.fromEntries(
        defs.map((definition) => [
          definition.key,
          normalizeSeededInput(definition, previous[definition.key] ?? ''),
        ]),
      ),
    )
    const uploadKeys = new Set(
      defs.filter((definition) => definition.kind === 'upload').map((definition) => definition.key),
    )
    setUploads((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([key]) => uploadKeys.has(key))),
    )
    setWorkflowVersionMismatch(null)
    start.reset()
    // Explicit adoption may change/remove fields. Bring the user back to the
    // content step so the new version is reviewed before another submit.
    setStep(STEP_CONTENT)
    setMaxVisited((previous) => Math.max(previous, STEP_CONTENT))
  }

  const recoverWorkflowVersion = async (): Promise<void> => {
    if (search.workflowVersion !== undefined) {
      await navigate({ to: '/workflows/$id', params: { id: workflowId } })
      return
    }
    const refreshed = await workflowQ.refetch()
    if (!refreshed.isSuccess || refreshed.data === undefined) return
    adoptLatestWorkflow(refreshed.data)
  }

  const scheduledEnvelope = () =>
    buildScheduledEnvelope(kind, buildImmediateBody(), { agentName, workgroupName })

  const saveConfig = useMutation({
    mutationFn: () =>
      api.put(`/api/scheduled-tasks/${encodeURIComponent(search.editScheduled ?? '')}`, {
        launchPayload: scheduledEnvelope(),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduled-tasks'] })
      void navigate({ to: '/scheduled/$id', params: { id: search.editScheduled ?? '' } })
    },
  })

  const submitPending = start.isPending || saveConfig.isPending
  const canSubmit =
    stepModeReady &&
    sourceReady &&
    stepContentReady &&
    multiRepoBlockedReason === null &&
    collabReady &&
    relaunchReady &&
    !relaunchError &&
    !submitPending
  // RFC-159: upload files can't be persisted into a schedule's JSON payload.
  const scheduleUnsupported = kind === 'workflow' && (hasUploadInput || hasUploads)
  const pageTitle = isEdit
    ? t('taskWizard.titleEdit')
    : search.schedule === true
      ? t('taskWizard.titleScheduled')
      : t('taskWizard.title')

  // An edit draft seeds exactly once. Before that barrier, loading/error are
  // full-page initial states; after it, a background refetch failure must not
  // replace (or re-seed) the user's draft.
  if (isEdit && !seededRef.current && !scheduleQ.isError)
    return (
      <div className="page">
        <PageHeader title={pageTitle} />
        <LoadingState />
      </div>
    )
  if (isEdit && !seededRef.current && scheduleQ.isError) {
    return (
      <div className="page">
        <PageHeader title={pageTitle} />
        <ErrorBanner
          error={scheduleQ.error}
          action={
            <button type="button" className="btn btn--sm" onClick={() => void scheduleQ.refetch()}>
              {t('common.retry')}
            </button>
          }
        />
      </div>
    )
  }

  const steps = [
    { key: 'mode', title: t('taskWizard.stepMode') },
    { key: 'space', title: t('taskWizard.stepSpace') },
    { key: 'content', title: t('taskWizard.stepContent') },
    { key: 'confirm', title: t('taskWizard.stepConfirm') },
  ]

  const summaryEdit = (target: number) => (
    <button
      type="button"
      className="btn btn--xs"
      onClick={() => onNavigate(target)}
      data-testid={`wizard-summary-edit-${target}`}
    >
      {t('taskWizard.edit')}
    </button>
  )

  return (
    <div className="page task-wizard" data-testid="task-wizard">
      <PageHeader title={pageTitle} />

      {isEdit && scheduleQ.isError && (
        <div data-testid="wizard-schedule-stale-error">
          <ErrorBanner
            error={scheduleQ.error}
            action={
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void scheduleQ.refetch()}
              >
                {t('common.retry')}
              </button>
            }
          />
        </div>
      )}

      {seedFailed && (
        <NoticeBanner tone="warning" size="compact" className="info-box--muted">
          <span data-testid="wizard-seed-degraded">{t('taskWizard.degradedBanner')}</span>
        </NoticeBanner>
      )}

      {relaunchError && (
        <div data-testid="wizard-relaunch-error">
          <ErrorBanner
            error={relaunchErrorQ?.error}
            action={
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void relaunchErrorQ?.refetch()}
              >
                {t('common.retry')}
              </button>
            }
          />
        </div>
      )}

      {kind === 'workflow' && activeWorkflowVersionMismatch !== null && (
        <div data-testid="wizard-workflow-version-mismatch">
          <NoticeBanner
            tone="warning"
            title={t('taskWizard.workflowVersionMismatchTitle')}
            action={
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void recoverWorkflowVersion()}
                data-testid="wizard-workflow-version-recover"
              >
                {t(
                  search.workflowVersion !== undefined
                    ? 'taskWizard.workflowVersionReturnToEditor'
                    : 'taskWizard.workflowVersionUseLatest',
                )}
              </button>
            }
          >
            {t('taskWizard.workflowVersionMismatchBody', {
              expected: activeWorkflowVersionMismatch.expected,
              current: activeWorkflowVersionMismatch.current,
            })}
          </NoticeBanner>
        </div>
      )}

      {startWorkflowVersionMismatch && (
        <div data-testid="wizard-workflow-submit-version-error">
          <ErrorBanner
            error={start.error}
            message={t('taskWizard.workflowLaunchVersionMismatchBody')}
            action={
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void recoverWorkflowVersion()}
                data-testid="wizard-workflow-submit-version-recover"
              >
                {t(
                  search.workflowVersion !== undefined
                    ? 'taskWizard.workflowVersionReturnToEditor'
                    : 'taskWizard.workflowVersionUseLatest',
                )}
              </button>
            }
          />
        </div>
      )}

      {kind === 'workflow' && (search.schedule === true || isEdit) && (
        <div data-testid="wizard-scheduled-workflow-policy">
          <NoticeBanner
            tone="info"
            size="compact"
            title={t('taskWizard.scheduledWorkflowLatestTitle')}
          >
            {t('taskWizard.scheduledWorkflowLatestBody')}
          </NoticeBanner>
        </div>
      )}

      {/* RFC-203 PR-2 实现门 P1：workflow/agent 启动失败改走富横幅——launch 的
          workflow-invalid 带 details.issues（节点/边定位），字符串壳会把它们
          全部丢掉，只剩一句「工作流内容不合法」。放在版本冲突横幅的同一正文
          区（同类失败的既有先例）；workgroup 分支保留 footer 的专用友好文案
          （workgroupLaunchErrorMessage）。 */}
      {kind !== 'workgroup' &&
        ((start.error !== null && start.error !== undefined && !startWorkflowVersionMismatch) ||
          (saveConfig.error !== null && saveConfig.error !== undefined)) && (
          <div data-testid="wizard-submit-error">
            <ErrorBanner error={start.error ?? saveConfig.error} />
          </div>
        )}

      <Stepper
        steps={steps}
        current={step}
        maxReachable={maxVisited}
        onNavigate={onNavigate}
        nextEnabled={nextEnabled}
        rootTestid="task-wizard-stepper"
        finalActions={
          <>
            {isEdit ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => saveConfig.mutate()}
                disabled={!canSubmit}
                data-testid="wizard-save-config"
              >
                {saveConfig.isPending ? t('scheduled.saving') : t('taskWizard.saveConfig')}
              </button>
            ) : search.schedule === true ? (
              <>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setSaveScheduledOpen(true)}
                  disabled={!canSubmit || scheduleUnsupported}
                  title={scheduleUnsupported ? t('scheduled.uploadUnsupported') : undefined}
                  data-testid="wizard-save-scheduled"
                >
                  {t('taskWizard.saveScheduled')}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => start.mutate()}
                  disabled={!canSubmit}
                  data-testid="wizard-launch"
                >
                  {start.isPending ? t('launch.starting') : t('taskWizard.launch')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => start.mutate()}
                  disabled={!canSubmit}
                  data-testid="wizard-launch"
                >
                  {start.isPending ? t('launch.starting') : t('taskWizard.launch')}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setSaveScheduledOpen(true)}
                  disabled={!canSubmit || scheduleUnsupported}
                  title={scheduleUnsupported ? t('scheduled.uploadUnsupported') : undefined}
                  data-testid="wizard-save-scheduled"
                >
                  {t('taskWizard.saveScheduled')}
                </button>
              </>
            )}
            {start.isPending && space.kind === 'remote' && (
              <span className="muted" data-testid="wizard-cloning-hint">
                {t('launch.repoSource.cloningHint')}
              </span>
            )}
            {isEdit && collabLookup.isError && (
              <span className="form-actions__error" data-testid="wizard-collab-load-error">
                {t('scheduled.collabLoadError')}
              </span>
            )}
            {kind === 'workgroup' &&
              ((start.error !== null && start.error !== undefined) ||
                (saveConfig.error !== null && saveConfig.error !== undefined)) && (
                <span className="form-actions__error" data-testid="wizard-submit-error">
                  {workgroupLaunchErrorMessage(start.error ?? saveConfig.error, t)}
                </span>
              )}
          </>
        }
      >
        {step === STEP_MODE && (
          <div className="form-grid">
            <Field label={t('taskWizard.kindLabel')} group>
              <ChoiceCards<WizardKind>
                value={kind}
                onChange={(next) => {
                  if (next === kind) return
                  setKind(next)
                  // Changing the kind resets the object (and the object-scoped
                  // content the user may have typed stays — it only goes on the
                  // wire for the active kind).
                  setWorkflowId('')
                  setAgentName('')
                  setWorkgroupName('')
                  // RFC-175 (§4.5, R2-F2): clear seeded collaborators + captured
                  // subject ids on a kind switch — else a relaunch-seeded agent/
                  // workflow collaborator set would ride into a workgroup launch
                  // (which must NOT pre-fill collaborators), and a stale captured
                  // id would target the wrong subject.
                  setCollaborators([])
                  setSelectedWorkgroupId(undefined)
                  setSelectedAgentId(undefined)
                  setNormalizedWorkflowRevision(null)
                  setWorkflowVersionMismatch(null)
                }}
                disabled={isEdit}
                ariaLabel={t('taskWizard.kindLabel')}
                testidPrefix="wizard-kind"
                options={[
                  {
                    value: 'agent',
                    label: t('taskWizard.kindAgent'),
                    description: t('taskWizard.kindHintAgent'),
                    icon: <AgentIcon />,
                  },
                  {
                    value: 'workflow',
                    label: t('taskWizard.kindWorkflow'),
                    description: t('taskWizard.kindHintWorkflow'),
                    icon: <WorkflowIcon />,
                  },
                  {
                    value: 'workgroup',
                    label: t('taskWizard.kindWorkgroup'),
                    description: t('taskWizard.kindHintWorkgroup'),
                    icon: <WorkgroupIcon />,
                  },
                ]}
              />
            </Field>
            {isEdit && <div className="muted">{t('taskWizard.kindLocked')}</div>}

            <Field label={objectFieldLabel} required group>
              {activeInventoryLoading ? (
                <LoadingState size="compact" data-testid="wizard-object-loading" />
              ) : activeInventoryError ? (
                <>
                  <div data-testid="wizard-object-load-error">
                    <ErrorBanner
                      error={activeInventoryQ.error}
                      action={
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => void activeInventoryQ.refetch()}
                        >
                          {t('common.retry')}
                        </button>
                      }
                    />
                  </div>
                  {!activeInventoryEmpty && objectPicker}
                </>
              ) : activeInventoryEmpty ? (
                <div className="muted" data-testid="wizard-object-empty">
                  {t('taskWizard.objectEmpty')}
                </div>
              ) : (
                objectPicker
              )}
            </Field>
          </div>
        )}

        {step === STEP_SPACE && (
          <div className="form-grid">
            {spaceUnresolved && (
              <div
                className="info-box info-box--muted"
                role="alert"
                data-testid="wizard-space-unresolved"
              >
                {t('taskWizard.spaceUnresolvedNotice')}
              </div>
            )}
            <Field label={t('taskWizard.spaceLabel')} group>
              <ChoiceCards<'remote' | 'scratch'>
                value={space.kind}
                onChange={(next) => {
                  if (next === space.kind) return
                  setSpace(defaultWizardSpace(next))
                  setSpaceUnresolved(false)
                  if (!isEdit) saveSpaceKindPref(next)
                }}
                ariaLabel={t('taskWizard.spaceLabel')}
                testidPrefix="wizard-space"
                options={[
                  {
                    value: 'scratch',
                    label: t('taskWizard.spaceScratch'),
                    description: t('taskWizard.spaceScratchDesc'),
                    icon: <ScratchIcon />,
                  },
                  {
                    value: 'remote',
                    label: t('taskWizard.spaceRemote'),
                    description: t('taskWizard.spaceRemoteDesc'),
                    icon: <RemoteIcon />,
                  },
                ]}
              />
            </Field>
            {space.kind === 'remote' ? (
              <RepoSourceList
                repos={space.repos}
                onChange={(repos) => setSpace({ kind: 'remote', repos })}
                multiRepoBlockedReason={multiRepoBlockedReason}
              />
            ) : (
              <div className="muted" data-testid="wizard-scratch-hint">
                {t('taskWizard.spaceScratchHint')}
              </div>
            )}
          </div>
        )}

        {step === STEP_CONTENT && (
          <div className="form-grid">
            <Field label={t('launch.fieldTaskName')} required hint={t('launch.fieldTaskNameHint')}>
              <TextInput
                value={taskName}
                onChange={setTaskName}
                required
                maxLength={255}
                data-testid="wizard-task-name"
              />
            </Field>

            {kind === 'agent' && (
              <>
                <Field
                  label={t('taskWizard.contentDescription')}
                  required
                  hint={t('taskWizard.contentDescriptionHint')}
                >
                  <TextArea
                    value={description}
                    onChange={setDescription}
                    rows={8}
                    maxLength={65536}
                    data-testid="wizard-description"
                  />
                </Field>
                {/* 用户 2026-07-11：反问开关是核心行为选择，不藏进高级折叠。 */}
                <Switch
                  checked={allowClarify}
                  onChange={setAllowClarify}
                  label={t('taskWizard.allowClarify')}
                  hint={t('taskWizard.allowClarifyHint')}
                />
              </>
            )}

            {kind === 'workgroup' && (
              <Field
                label={t('workgroups.launch.fieldGoal')}
                required
                hint={t('workgroups.launch.fieldGoalHint')}
              >
                <TextArea
                  value={goal}
                  onChange={setGoal}
                  rows={8}
                  maxLength={65536}
                  data-testid="wizard-goal"
                />
              </Field>
            )}

            {kind === 'workflow' && workflowQ.isLoading && <LoadingState />}
            {kind === 'workflow' && workflowQ.error !== null && workflowQ.error !== undefined && (
              <div data-testid="wizard-workflow-load-error">
                <ErrorBanner
                  error={workflowQ.error}
                  action={
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => void workflowQ.refetch()}
                    >
                      {t('common.retry')}
                    </button>
                  }
                />
              </div>
            )}
            {kind === 'workflow' && workflowQ.data !== undefined && inputDefs.length === 0 && (
              <div className="muted">{t('launch.noInputs')}</div>
            )}
            {kind === 'workflow' &&
              inputDefs.map((def) => (
                <Field
                  key={def.key}
                  label={`${def.label} (${def.key})`}
                  required={def.required === true}
                  hint={def.description}
                >
                  {def.kind === 'upload' ? (
                    <UploadPicker
                      def={def}
                      files={uploads[def.key] ?? []}
                      onChange={(next) => setUploads((prev) => ({ ...prev, [def.key]: next }))}
                    />
                  ) : (
                    <DynamicInput
                      def={def}
                      repoPath={
                        space.kind === 'remote'
                          ? resolveUrlRepoPath(
                              space.repos[0] ?? { kind: 'url', repoUrl: '', ref: '' },
                              cachedRepos.data?.items ?? [],
                            )
                          : ''
                      }
                      sourceKind="url"
                      value={inputs[def.key] ?? ''}
                      onChange={(v) => setInputs((prev) => ({ ...prev, [def.key]: v }))}
                    />
                  )}
                </Field>
              ))}

            <details className="launch-collapsible" data-testid="wizard-advanced">
              <summary>{t('taskWizard.advanced')}</summary>
              <div className="launch-collapsible__body">
                {actor.data !== null &&
                  actor.data !== undefined &&
                  actor.data.source !== 'daemon' && (
                    <Field label={t('members.users')} hint={t('members.hint')}>
                      <UserPicker
                        value={collaborators}
                        onChange={setCollaborators}
                        excludeIds={[actor.data.user.id]}
                        testidPrefix="wizard-collaborators"
                      />
                    </Field>
                  )}
                {space.kind === 'remote' && (
                  <>
                    <Field
                      label={t('launch.workingBranch.label')}
                      hint={
                        workingBranchError
                          ? t('launch.workingBranch.invalid')
                          : t('launch.workingBranch.hint')
                      }
                    >
                      <TextInput
                        value={workingBranch}
                        onChange={setWorkingBranch}
                        maxLength={255}
                        placeholder={t('launch.workingBranch.placeholder')}
                        data-testid="wizard-working-branch"
                      />
                    </Field>
                    {workingBranchError && (
                      <div className="error-text" role="alert" data-testid="wizard-branch-error">
                        {t('launch.workingBranch.invalid')}
                      </div>
                    )}
                    <Switch
                      checked={autoCommitPush}
                      onChange={(v) => {
                        setAutoCommitPush(v)
                        saveAutoCommitPushPref(v)
                      }}
                      label={t('launch.autoCommitPush.label')}
                      hint={t('launch.autoCommitPush.hint')}
                    />
                  </>
                )}
                <Field label={t('launch.gitIdentity.name')} hint={t('launch.gitIdentity.hint')}>
                  <TextInput
                    value={gitUserName}
                    onChange={setGitUserName}
                    maxLength={255}
                    data-testid="wizard-git-user-name"
                  />
                </Field>
                <Field
                  label={t('launch.gitIdentity.email')}
                  {...(gitEmailFormatError ? { hint: t('launch.gitIdentity.emailInvalid') } : {})}
                >
                  <TextInput
                    value={gitUserEmail}
                    onChange={setGitUserEmail}
                    maxLength={255}
                    data-testid="wizard-git-user-email"
                  />
                </Field>
                {gitPairingError && (
                  <div className="error-text" role="alert" data-testid="wizard-git-pair-error">
                    {t('launch.gitIdentity.pairingError')}
                  </div>
                )}
                <Field
                  label={t('taskWizard.maxDurationMin')}
                  hint={t('taskWizard.maxDurationMinHint')}
                >
                  <NumberInput
                    value={maxDurationMin}
                    onChange={setMaxDurationMin}
                    min={1}
                    step={1}
                    data-testid="wizard-max-duration"
                  />
                </Field>
                <Field
                  label={t('taskWizard.maxTotalTokens')}
                  hint={t('taskWizard.maxTotalTokensHint')}
                >
                  <NumberInput
                    value={maxTotalTokens}
                    onChange={setMaxTotalTokens}
                    min={1}
                    step={1}
                    data-testid="wizard-max-tokens"
                  />
                </Field>
                {(durationInvalid || tokensInvalid) && (
                  <div className="error-text" role="alert" data-testid="wizard-limits-error">
                    {t('taskWizard.limitInvalid')}
                  </div>
                )}
              </div>
            </details>
          </div>
        )}

        {step === STEP_CONFIRM && (
          <dl className="wizard-summary" data-testid="wizard-summary">
            <div className="wizard-summary__row">
              <dt>{t('taskWizard.kindLabel')}</dt>
              <dd data-testid="wizard-summary-kind">
                {kind === 'workflow'
                  ? t('taskWizard.kindWorkflow')
                  : kind === 'agent'
                    ? t('taskWizard.kindAgent')
                    : t('taskWizard.kindWorkgroup')}
                {' · '}
                {selectedObjectLabel}
                {!isEdit && summaryEdit(STEP_MODE)}
              </dd>
            </div>
            <div className="wizard-summary__row">
              <dt>{t('taskWizard.spaceLabel')}</dt>
              <dd data-testid="wizard-summary-space">
                {space.kind === 'scratch'
                  ? t('taskWizard.spaceScratch')
                  : space.repos.map((r) => `${r.repoUrl}${r.ref ? ` @ ${r.ref}` : ''}`).join(', ')}
                {summaryEdit(STEP_SPACE)}
              </dd>
            </div>
            <div className="wizard-summary__row">
              <dt>{t('launch.fieldTaskName')}</dt>
              <dd data-testid="wizard-summary-name">
                {taskName.trim() || '—'}
                {summaryEdit(STEP_CONTENT)}
              </dd>
            </div>
            <div className="wizard-summary__row">
              <dt>{t('taskWizard.stepContent')}</dt>
              <dd data-testid="wizard-summary-content">
                {kind === 'workflow' ? (
                  inputDefs.length === 0 ? (
                    t('launch.noInputs')
                  ) : (
                    <ul className="wizard-summary__inputs">
                      {inputDefs.map((def) => (
                        <li key={def.key}>
                          <span className="muted">{def.key}: </span>
                          {def.kind === 'upload'
                            ? (uploads[def.key] ?? []).map((f) => f.name).join(', ') || '—'
                            : truncate(inputs[def.key] ?? '')}
                        </li>
                      ))}
                    </ul>
                  )
                ) : (
                  truncate(kind === 'agent' ? description : goal)
                )}
              </dd>
            </div>
            {(collaborators.length > 0 ||
              gitBoth ||
              (space.kind === 'remote' && workingBranchTrim !== '') ||
              (space.kind === 'remote' && autoCommitPush) ||
              maxDurationMin !== undefined ||
              maxTotalTokens !== undefined ||
              (kind === 'agent' && allowClarify)) && (
              <div className="wizard-summary__row">
                <dt>{t('taskWizard.advanced')}</dt>
                <dd data-testid="wizard-summary-advanced">
                  {[
                    collaborators.length > 0
                      ? t('taskWizard.summaryCollaborators', { count: collaborators.length })
                      : null,
                    gitBoth ? `${gitNameTrim} <${gitEmailTrim}>` : null,
                    space.kind === 'remote' && workingBranchTrim !== '' ? workingBranchTrim : null,
                    space.kind === 'remote' && autoCommitPush
                      ? t('launch.autoCommitPush.label')
                      : null,
                    maxDurationMin !== undefined
                      ? `${t('taskWizard.maxDurationMin')}: ${maxDurationMin}`
                      : null,
                    maxTotalTokens !== undefined
                      ? `${t('taskWizard.maxTotalTokens')}: ${maxTotalTokens}`
                      : null,
                    kind === 'agent' && allowClarify ? t('taskWizard.clarifyOn') : null,
                  ]
                    .filter((s): s is string => s !== null)
                    .join(' · ')}
                  {summaryEdit(STEP_CONTENT)}
                </dd>
              </div>
            )}
          </dl>
        )}
      </Stepper>

      {!isEdit && (
        <ScheduleDialog
          open={saveScheduledOpen}
          onClose={() => setSaveScheduledOpen(false)}
          buildLaunchPayload={scheduledEnvelope}
          launchKind={kind}
          defaultName={taskName.trim()}
        />
      )}
    </div>
  )
}

function AgentIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5" y="8" width="14" height="10" rx="2" />
      <path d="M12 8V5" />
      <circle cx="12" cy="4" r="1" />
      <path d="M9.5 12.5v1M14.5 12.5v1" />
    </svg>
  )
}

function WorkflowIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="6" height="6" rx="1.5" />
      <rect x="15" y="14" width="6" height="6" rx="1.5" />
      <path d="M9 7h5a2 2 0 0 1 2 2v5" />
    </svg>
  )
}

function WorkgroupIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c.8-2.9 3-4.5 5.5-4.5s4.7 1.6 5.5 4.5" />
      <circle cx="17" cy="9" r="2.2" />
      <path d="M15.5 14.7c2 .3 3.9 1.7 4.6 4.3" />
    </svg>
  )
}

function ScratchIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="4 3" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  )
}

function RemoteIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="7" cy="18" r="2.2" />
      <circle cx="17" cy="12" r="2.2" />
      <path d="M7 8.2v7.6M9 17l6-4M9 7l6 4" />
    </svg>
  )
}

function truncate(s: string): string {
  const v = s.trim()
  return v.length > 120 ? `${v.slice(0, 120)}…` : v || '—'
}

function isWorkflowVersionMismatchError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError && error.status === 409 && error.code === 'workflow-version-mismatch'
  )
}
