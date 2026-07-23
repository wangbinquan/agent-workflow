// RFC-038 — button + dialog controller that scans the AgentForm body for
// inventory names and lets the user merge matches into dependsOn / skills /
// mcp / plugins. Pure presentational; the parent owns the agent value via
// onApply -> mergeAgentDeps(...).

import { useMemo, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Agent, Skill, Mcp, Plugin, CreateAgent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import {
  detectAgentDeps,
  type DepSelection,
  type DetectInventoryRow,
  type DetectionGroupKey,
  type DetectionResult,
} from '@/lib/agent-dep-detect'
import { AGENTS_QUERY_KEY } from '../AgentDependsPicker'
import { SKILLS_QUERY_KEY } from '../SkillsPicker'
import { MCPS_QUERY_KEY } from '../McpsPicker'
import { PLUGINS_QUERY_KEY } from '../PluginsPicker'
import { DependencyAutodetectDialog } from './DependencyAutodetectDialog'

export interface DependencyAutodetectButtonProps {
  bodyMd: string
  value: CreateAgent
  selfName: string
  onApply: (selection: DepSelection) => void
}

function toRow(r: { name: string; description?: string | null }): DetectInventoryRow {
  return { name: r.name, description: r.description ?? undefined }
}

const EMPTY_RESULT: DetectionResult = {
  agents: { candidates: [] },
  skills: { candidates: [] },
  mcps: { candidates: [] },
  plugins: { candidates: [] },
}

export function DependencyAutodetectButton(props: DependencyAutodetectButtonProps): ReactElement {
  const { t } = useTranslation()
  const agentsQ = useQuery<Agent[]>({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
    staleTime: 30_000,
    retry: false,
  })
  const skillsQ = useQuery<Skill[]>({
    queryKey: SKILLS_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/skills', undefined, signal),
    staleTime: 30_000,
    retry: false,
  })
  const mcpsQ = useQuery<Mcp[]>({
    queryKey: MCPS_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/mcps', undefined, signal),
    staleTime: 30_000,
    retry: false,
  })
  const pluginsQ = useQuery<Plugin[]>({
    queryKey: PLUGINS_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/plugins', undefined, signal),
    staleTime: 30_000,
    retry: false,
  })

  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<DetectionResult>(EMPTY_RESULT)
  const [failures, setFailures] = useState<readonly DetectionGroupKey[]>([])

  // RFC-173 follow-up (user request): the button is ALWAYS clickable. Neither
  // an empty body nor pending/failed inventory queries block it — clicking with
  // an empty body just opens the dialog's "nothing detected" empty state, which
  // is clearer than a greyed-out button whose reason is only a hover tooltip.

  const failureList = useMemo<DetectionGroupKey[]>(() => {
    const out: DetectionGroupKey[] = []
    if (agentsQ.isError) out.push('agents')
    if (skillsQ.isError) out.push('skills')
    if (mcpsQ.isError) out.push('mcps')
    if (pluginsQ.isError) out.push('plugins')
    return out
  }, [agentsQ.isError, skillsQ.isError, mcpsQ.isError, pluginsQ.isError])

  const handleOpen = () => {
    // RFC-223 (PR-1): detection matches catalog NAMES in the body, but the
    // agent's own refs are stored by id (mcp/plugins/dependsOn) / as typed refs
    // (skills). Map them back to names via the catalogs so the already-selected
    // exclusion works (an unresolved id stays verbatim → harmlessly matches no
    // catalog name).
    const nameOf = (rows: readonly { id: string; name: string }[] | undefined) =>
      new Map((rows ?? []).map((r) => [r.id, r.name]))
    const agentNames = nameOf(agentsQ.data)
    const skillNames = nameOf(skillsQ.data)
    const mcpNames = nameOf(mcpsQ.data)
    const pluginNames = nameOf(pluginsQ.data)
    const result = detectAgentDeps(
      props.bodyMd ?? '',
      {
        agents: agentsQ.isError ? undefined : (agentsQ.data ?? []).map(toRow),
        skills: skillsQ.isError ? undefined : (skillsQ.data ?? []).map(toRow),
        mcps: mcpsQ.isError ? undefined : (mcpsQ.data ?? []).map(toRow),
        plugins: pluginsQ.isError ? undefined : (pluginsQ.data ?? []).map(toRow),
      },
      {
        dependsOn: (props.value.dependsOn ?? []).map((id) => agentNames.get(id) ?? id),
        skills: (props.value.skills ?? []).map((ref) =>
          ref.kind === 'project' ? ref.name : (skillNames.get(ref.skillId) ?? ref.skillId),
        ),
        mcp: (props.value.mcp ?? []).map((id) => mcpNames.get(id) ?? id),
        plugins: (props.value.plugins ?? []).map((id) => pluginNames.get(id) ?? id),
      },
      props.selfName,
    )
    setSnapshot(result)
    setFailures(failureList)
    setOpen(true)
  }

  const handleApply = (selection: DepSelection) => {
    props.onApply(selection)
    setOpen(false)
  }

  return (
    <div className="agent-form__autodetect-row">
      <button
        type="button"
        className="btn btn--primary btn--sm"
        onClick={handleOpen}
        data-testid="agent-dep-autodetect-button"
      >
        {t('agentForm.autodetect.button')}
      </button>
      <DependencyAutodetectDialog
        open={open}
        result={snapshot}
        loadFailures={failures}
        onApply={handleApply}
        onClose={() => setOpen(false)}
      />
    </div>
  )
}
