import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { MultiSelect } from '@/components/MultiSelect'
import { contractRefKey, contractText, type ExecutionContractSummary } from './types'

export function ExecutionContractPicker(props: {
  value: string[]
  onChange: (
    next: string[],
    transportsByKey: Readonly<Record<string, { outputPort: string; outputKind: string | null }>>,
  ) => void
  enabled?: boolean
}): React.ReactElement {
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const zh = language.startsWith('zh')
  const query = useQuery<{ items: ExecutionContractSummary[] }>({
    queryKey: ['execution-contracts'],
    queryFn: ({ signal }) => api.get('/api/execution-contracts', undefined, signal),
    staleTime: 60_000,
    retry: false,
    enabled: props.enabled !== false,
  })
  if (query.isPending) {
    return <LoadingState size="compact" label={zh ? '正在加载执行契约…' : 'Loading contracts…'} />
  }
  if (query.isError) return <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
  const contracts = query.data.items.filter((guide) => guide.allowedExecutorKinds.includes('agent'))
  return (
    <MultiSelect
      value={props.value}
      onChange={(next) =>
        props.onChange(
          next,
          Object.fromEntries(
            contracts.flatMap((contract) => {
              const key = contractRefKey(contract.contractRef)
              return contract.agentOutputPort === null
                ? []
                : [
                    [
                      key,
                      {
                        outputPort: contract.agentOutputPort,
                        outputKind: contract.agentOutputKind,
                      },
                    ] as const,
                  ]
            }),
          ),
        )
      }
      ariaLabel={zh ? '平台执行契约' : 'Platform execution contracts'}
      placeholder={zh ? '选择这个 Agent 能执行的工作' : 'Choose work this Agent can execute'}
      emptyLabel={zh ? '没有可供 Agent 执行的契约' : 'No Agent-compatible contracts'}
      data-testid="agent-execution-contracts"
      options={contracts.map((guide) => ({
        value: contractRefKey(guide.contractRef),
        label: contractText(guide.displayName, language),
        description: `${guide.inputSchemaId} → ${guide.outputSchemaId}`,
      }))}
    />
  )
}
