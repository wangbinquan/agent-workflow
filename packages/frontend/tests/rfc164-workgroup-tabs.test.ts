// RFC-164 PR-4 — tab-set contrast lock for workgroup tasks.
//
// Group tasks get a FIXED tab set (chatroom default-first + task-questions +
// worktree-structure + details) that hides the workflow-status canvas and
// outputs; every non-workgroup shape stays item-by-item identical to the
// pre-RFC-164 lists (the golden lock — a refactor that leaks 'chatroom' into
// normal tasks or drops a legacy tab goes red here).
//
// Source-level assertions on tasks.detail.tsx pin the RFC-201 wiring: the
// capability oracle feeds route resolution, PageSectionNav owns navigation,
// and inapplicable workgroup panes do not enter the DOM. The canvas remains
// gated off for turn-engine workgroups.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { TAB_ORDER, WORKGROUP_TAB_ORDER, availableTabs } from '../src/lib/task-detail-tabs'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src/routes/tasks.detail.tsx'), 'utf8')

describe('availableTabs — workgroup tasks', () => {
  test('group tab set = chatroom(first) + task-questions + worktree-structure + details', () => {
    expect(availableTabs({ hasOutputs: false, isWorkgroup: true })).toEqual([
      'chatroom',
      'task-questions',
      'worktree-structure',
      'details',
    ])
  })

  test('outputs stays hidden for group tasks even if the snapshot declared ports', () => {
    // The builtin host snapshot declares none, but the gate must not depend
    // on that accident — hasOutputs is ignored entirely for group tasks.
    expect(availableTabs({ hasOutputs: true, isWorkgroup: true })).toEqual([...WORKGROUP_TAB_ORDER])
    expect(availableTabs({ hasOutputs: true, isWorkgroup: true })).not.toContain('workflow-status')
    expect(availableTabs({ hasOutputs: true, isWorkgroup: true })).not.toContain('outputs')
  })

  test('WORKGROUP_TAB_ORDER leads with chatroom (the group default tab)', () => {
    expect(WORKGROUP_TAB_ORDER[0]).toBe('chatroom')
  })
})

describe('availableTabs — non-workgroup tasks stay item-by-item unchanged', () => {
  const LEGACY_WITH_OUTPUTS = [
    'workflow-status',
    'task-questions',
    'node-runs',
    'details',
    'outputs',
    'worktree-files',
    'worktree-diff',
    'worktree-structure',
    'feedback',
  ]

  test('explicit isWorkgroup:false matches the pre-RFC-164 list (with outputs)', () => {
    expect(availableTabs({ hasOutputs: true, isWorkgroup: false })).toEqual(LEGACY_WITH_OUTPUTS)
  })

  test('omitted isWorkgroup (legacy callers) matches the pre-RFC-164 list', () => {
    expect(availableTabs({ hasOutputs: true })).toEqual(LEGACY_WITH_OUTPUTS)
    expect(availableTabs({ hasOutputs: false })).toEqual(
      LEGACY_WITH_OUTPUTS.filter((t) => t !== 'outputs'),
    )
  })

  test('chatroom never leaks into TAB_ORDER or a non-workgroup set', () => {
    expect(TAB_ORDER).not.toContain('chatroom')
    expect(availableTabs({ hasOutputs: true })).not.toContain('chatroom')
    expect(availableTabs({ hasOutputs: false, isWorkgroup: false })).not.toContain('chatroom')
  })
})

describe('tasks.detail.tsx — workgroup wiring (source locks)', () => {
  test('derives capabilities once and delegates URL resolution to the RFC-201 oracle', () => {
    expect(SRC).toMatch(/const isWorkgroup = task\.data\?\.workgroupId != null/)
    expect(SRC).toMatch(/deriveTaskDetailCapabilities\(task\.data, \{/)
    expect(SRC).toMatch(/canReadQuestions: true/)
    expect(SRC).toMatch(/canReadFeedback: actor\.data\?\.permissions\.includes\('memory:read'\)/)
    expect(SRC).toMatch(/resolveTaskDetailTabs\(\{/)
    expect(SRC).toMatch(/capabilitiesReady: permissionsReady/)
    expect(SRC).toMatch(/capabilities: taskCapabilities/)
    expect(SRC).toMatch(/isWorkgroup,\s*room: roomClassification/)
    expect(SRC).toMatch(/mode: isDynamicWorkgroup \? 'dynamic-workflow' : 'turn-engine'/)
  })

  test('resolved default is canonicalized through replace navigation', () => {
    expect(SRC).toMatch(/tabResolution\.canonicalize/)
    expect(SRC).toMatch(/navigateTaskTab\(canonicalTab, true\)/)
  })

  test('RFC-201 PageSectionNav preserves URL-owned task section links and compact selection', () => {
    expect(SRC).toContain('<PageSectionNav<TaskDetailTab>')
    expect(SRC).toMatch(/groups=\{taskSectionGroups\}/)
    expect(SRC).toMatch(/active=\{tab\}/)
    expect(SRC).toMatch(/presentation="inline"/)
    expect(SRC).toContain('<PageSectionLink')
    expect(SRC).toMatch(/withTaskDetailTab\(previous, key\)/)
    expect(SRC).toMatch(/onSelectCompact=\{\(next\) => navigateTaskTab\(next\)\}/)
  })

  test('renders WorkgroupRoom only when the capability oracle permits chatroom', () => {
    expect(SRC).toMatch(/\{taskCapabilities\.chatroom && \(/)
    expect(SRC).toMatch(/taskSectionProps\(t, 'chatroom'\)/)
    expect(SRC).toMatch(/hidden=\{tab !== 'chatroom'\}/)
    expect(SRC).toMatch(/<WorkgroupRoom taskId=\{id\} taskStatus=\{tk\.status\} \/>/)
  })

  test('the host-graph canvas never mounts for turn-engine group tasks; a dynamic task unlocks it only in the executing phase', () => {
    // The workflow-status pane's content is gated: the builtin host snapshot
    // is an implementation detail, not an observation surface (design §10.2).
    // RFC-167: a dynamic task's snapshot becomes a REAL DAG after the confirm
    // swap — the gate widens to (not a workgroup) OR (dynamic AND executing).
    expect(SRC).toMatch(
      /\{\(!isWorkgroup \|\| \(isDynamicWorkgroup && dwPhase === 'executing'\)\) && \(/,
    )
  })

  test('RFC-167/RFC-201: the orchestration pane is capability-gated for dynamic tasks', () => {
    expect(SRC).toMatch(/\{taskCapabilities\.orchestration && \(/)
    expect(SRC).toMatch(/taskSectionProps\(t, 'dw-orchestration'\)/)
    expect(SRC).toMatch(/hidden=\{tab !== 'dw-orchestration'\}/)
    expect(SRC).toMatch(/<DynamicWorkflowPanel/)
  })

  test('RFC-198: room config must settle before a workgroup tab is resolved', () => {
    expect(SRC).toMatch(/room\.data !== undefined/)
    expect(SRC).toMatch(/room\.error !== null\s*\? \{ status: 'error' \}/)
    expect(SRC).toMatch(/: \{ status: 'pending' \}/)
    expect(SRC).toMatch(/tabResolution\.status === 'pending'/)
  })

  test('tabLabel maps the chatroom tab through tasks.tabChatroom', () => {
    expect(SRC).toMatch(/'tasks\.tabChatroom'/)
  })
})

describe('i18n — chatroom keys ship in both bundles', () => {
  test('tasks.tabChatroom + tasks.workgroupBadge', () => {
    expect(zhCN.tasks.tabChatroom.length).toBeGreaterThan(0)
    expect(enUS.tasks.tabChatroom.length).toBeGreaterThan(0)
    expect(zhCN.tasks.workgroupBadge.length).toBeGreaterThan(0)
    expect(enUS.tasks.workgroupBadge.length).toBeGreaterThan(0)
  })

  test('workgroups.room key set (spot-check the load-bearing ones)', () => {
    for (const bundle of [zhCN, enUS]) {
      const room = bundle.workgroups.room
      for (const key of [
        'empty',
        'roundDivider',
        'authorSystem',
        'resultSummary',
        'viewRun',
        'cancelCard',
        'composerPlaceholder',
        'send',
        'terminalNotice',
        'gateAwaiting',
        // PR-5: the gate went live — reject flows through a comment dialog.
        'gateRejectTitle',
        'gateRejectSubmit',
        // PR-5: human delivery + mid-run config + fc panel.
        'deliverQuick',
        'deliverForm',
        'deliverSubmit',
        'configButton',
        'configTitle',
        'fcListTitle',
        'working',
        'idle',
      ] as const) {
        expect(room[key].length, `workgroups.room.${key}`).toBeGreaterThan(0)
      }
      // All 8 assignment statuses + all 4 sources are labeled.
      expect(Object.keys(room.assignmentStatus).sort()).toEqual(
        [
          'awaiting_human',
          'canceled',
          'delivered',
          'dispatched',
          'done',
          'failed',
          'open',
          'running',
        ].sort(),
      )
      expect(Object.keys(room.source).sort()).toEqual(
        ['human', 'leader', 'self_claim', 'system'].sort(),
      )
    }
  })
})
