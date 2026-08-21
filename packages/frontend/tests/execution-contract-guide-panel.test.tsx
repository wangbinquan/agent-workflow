import { render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { ExecutionContractGuidePanel } from '../src/components/execution-contracts/ExecutionContractGuidePanel'
import type { ExecutionContractGuide } from '../src/components/execution-contracts/types'

const text = (value: string) => ({ 'zh-CN': value, 'en-US': value })

const guide: ExecutionContractGuide = {
  schemaVersion: 1,
  contractRef: { contractId: 'development.prepare-materials', version: 1 },
  displayName: text('准备工作材料'),
  description: text('取得需求材料'),
  input: {
    schemaId: 'development.work-request.v1',
    displayName: text('输入'),
    description: text('输入'),
    topLevelFields: ['roundRef', 'contractInput'],
    primaryFieldPaths: ['contractInput.workRequest.externalId'],
    fields: [
      {
        path: 'roundRef',
        label: text('执行轮次'),
        description: text('平台生成'),
        valueType: 'string',
        required: true,
        source: 'platform',
        condition: null,
        example: null,
      },
      {
        path: 'contractInput.workRequest.externalId',
        label: text('需求 / 问题 ID'),
        description: text('用户在受理页面填写的原始 ID'),
        valueType: 'string',
        required: false,
        source: 'work-input',
        condition: text('仅 external-id 形式必填'),
        example: 'ISSUE-1234',
      },
    ],
    exampleJson: '{}',
  },
  output: {
    schemaId: 'development.requirement-context.v1',
    displayName: text('输出'),
    description: text('输出'),
    topLevelFields: ['summary'],
    primaryFieldPaths: ['summary'],
    fields: [
      {
        path: 'summary',
        label: text('结果摘要'),
        description: text('简短结果'),
        valueType: 'string',
        required: true,
        source: 'work-input',
        condition: null,
        example: null,
      },
    ],
    exampleJson: '{}',
  },
  allowedExecutorKinds: ['agent'],
  transports: {
    agent: {
      inputLocation: 'Agent prompt · INPUT_ENVELOPE_JSON',
      outputLocation: 'Agent output port · agent-result',
      inputInstruction: text('平台注入输入'),
      outputInstruction: text('平台接收输出'),
    },
    workflow: null,
    program: null,
  },
}

describe('<ExecutionContractGuidePanel />', () => {
  test('puts the contract-selected business parameter first and folds system fields', () => {
    const { container, getByTestId } = render(
      <ExecutionContractGuidePanel guide={guide} language="zh-CN" kind="agent" />,
    )

    const primary = getByTestId('execution-contract-primary-fields')
    expect(primary.textContent).toContain('需求 / 问题 ID')
    expect(primary.textContent).toContain('contractInput.workRequest.externalId')
    expect(primary.textContent).not.toContain('执行轮次')
    expect(container.textContent).toContain('参数值来自每次任务，不在工具定义中固定填写')

    const advanced = container.querySelector(
      '.execution-contract-guide__advanced',
    ) as HTMLDetailsElement | null
    expect(advanced).not.toBeNull()
    expect(advanced?.open).toBe(false)
    expect(advanced?.textContent).toContain('系统执行参数')
    expect(advanced?.textContent).toContain('执行轮次')
  })
})
