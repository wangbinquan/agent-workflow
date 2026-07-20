import { useTranslation } from 'react-i18next'
import type { CanvasNodeData } from './types'

export function NodeConfigurationSummary({ data }: { data: CanvasNodeData }) {
  const { t } = useTranslation()
  if (data.surface !== 'editor') return null
  return (
    <div className="canvas-node__configuration">
      {t('canvas.nodeConfigurationSummary', {
        inputs: data.inputPorts.length,
        outputs: data.outputPorts.length,
      })}
    </div>
  )
}
