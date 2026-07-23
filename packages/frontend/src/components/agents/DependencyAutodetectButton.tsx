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
  selfId?: string
  onApply: (selection: DepSelection) => void
}

function toRow(r: {
  id: string
  name: string
  description?: string | null
  ownerUserId?: string | null
}): DetectInventoryRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    ownerUserId: r.ownerUserId,
  }
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
    // Detection still scans prose by display name, but candidate/existing/self
    // identity is immutable id so cross-owner duplicate names stay distinct.
    const result = detectAgentDeps(
      props.bodyMd ?? '',
      {
        agents: agentsQ.isError ? undefined : (agentsQ.data ?? []).map(toRow),
        skills: skillsQ.isError ? undefined : (skillsQ.data ?? []).map(toRow),
        mcps: mcpsQ.isError ? undefined : (mcpsQ.data ?? []).map(toRow),
        plugins: pluginsQ.isError ? undefined : (pluginsQ.data ?? []).map(toRow),
      },
      {
        dependsOn: props.value.dependsOn ?? [],
        skills: (props.value.skills ?? [])
          .filter((ref) => ref.kind === 'managed')
          .map((ref) => ref.skillId),
        mcp: props.value.mcp ?? [],
        plugins: props.value.plugins ?? [],
      },
      props.selfId,
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
