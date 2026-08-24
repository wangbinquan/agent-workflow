import { render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import {
  ExecutionContractGuidePanel,
  executionContractProgramStarter,
} from '../src/components/execution-contracts/ExecutionContractGuidePanel'
import type { ExecutionContractGuide } from '../src/components/execution-contracts/types'

const text = (value: string) => ({ 'zh-CN': value, 'en-US': value })

const guide: ExecutionContractGuide = {
  schemaVersion: 1,
  outputMode: 'envelope',
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

    const primary = getByTestId('execution-contract-primary-input-fields')
    expect(primary.textContent).toContain('需求 / 问题 ID')
    expect(primary.textContent).toContain('contractInput.workRequest.externalId')
    expect(primary.textContent).not.toContain('执行轮次')
    expect(getByTestId('execution-contract-primary-output-fields').textContent).toContain(
      '结果摘要',
    )
    expect(container.textContent).toContain('参数值来自每次任务，不在工具定义中固定填写')

    const advanced = container.querySelector(
      '.execution-contract-guide__advanced',
    ) as HTMLDetailsElement | null
    expect(advanced).not.toBeNull()
    expect(advanced?.open).toBe(false)
    expect(advanced?.textContent).toContain('系统执行参数')
    expect(advanced?.textContent).toContain('执行轮次')
  })

  test('renders v2 as direct business JSON and generates direct Program starters', () => {
    const directGuide: ExecutionContractGuide = {
      ...guide,
      inputMode: 'direct-json',
      outputMode: 'direct-json',
      contractRef: { contractId: 'development.implement-change', version: 2 },
      input: {
        ...guide.input,
        topLevelFields: ['requirementsDirectory'],
        primaryFieldPaths: ['requirementsDirectory'],
        fields: [
          {
            path: 'requirementsDirectory',
            label: text('需求材料目录'),
            description: text('本次实现的完整需求材料'),
            valueType: 'string',
            required: true,
            source: 'platform',
            condition: null,
            example: null,
          },
        ],
      },
      output: {
        ...guide.output,
        topLevelFields: ['outcome', 'commitMessage'],
        primaryFieldPaths: ['outcome', 'commitMessage'],
        fields: [
          {
            path: 'outcome',
            label: text('结果'),
            description: text('completed 或 blocked'),
            valueType: 'enum',
            required: true,
            source: 'work-input',
            condition: null,
            example: null,
          },
          {
            path: 'commitMessage',
            label: text('提交信息'),
            description: text('代码修改对应的提交信息'),
            valueType: 'string',
            required: false,
            source: 'work-input',
            condition: text('completed 时使用'),
            example: null,
          },
        ],
      },
    }
    const { container, getByTestId } = render(
      <ExecutionContractGuidePanel guide={directGuide} language="zh-CN" kind="agent" />,
    )
    expect(container.textContent).toContain('每次运行只收到下面这些业务字段')
    expect(container.textContent).toContain('完成时只返回下面的业务结果')
    expect(getByTestId('execution-contract-primary-input-fields').textContent).toContain(
      'JSON 字段requirementsDirectory',
    )
    expect(container.textContent).not.toContain('Envelope 读取路径')

    for (const runtime of ['bash', 'node', 'python'] as const) {
      const starter = executionContractProgramStarter(runtime, directGuide)
      expect(starter).toContain('AW_PORT_CONTRACT_INPUT')
      expect(starter).toContain('outcome')
      expect(starter).toContain('blocked')
      expect(starter).not.toContain('contextPatches')
      expect(starter).not.toContain('effectSuggestions')
      expect(starter).not.toContain('artifactRefs')
      expect(starter).not.toContain('schemaVersion')
    }
  })

  test('shows planning output as one raw file path rather than an envelope', () => {
    const path = '.agent-workflow/inputs/requirements/case/review/implementation-plan.md'
    const pathGuide: ExecutionContractGuide = {
      ...guide,
      inputMode: 'direct-json',
      outputMode: 'artifact-path',
      contractRef: { contractId: 'development.plan-implementation', version: 2 },
      output: {
        ...guide.output,
        schemaId: 'development.plan-implementation.path.v2',
        topLevelFields: ['artifactPath'],
        primaryFieldPaths: ['artifactPath'],
        fields: [
          {
            path: 'artifactPath',
            label: text('方案文件路径'),
            description: text('与输入 outputFile 完全相同'),
            valueType: 'string',
            required: true,
            source: 'artifact',
            condition: null,
            example: null,
          },
        ],
        exampleJson: JSON.stringify({ artifactPath: path }),
      },
    }
    const { container, getByTestId, getByText } = render(
      <ExecutionContractGuidePanel guide={pathGuide} language="zh-CN" kind="agent" />,
    )
    expect(container.textContent).toContain('只返回写好的文件路径')
    expect(getByTestId('execution-contract-primary-output-fields').textContent).toContain(
      '输出值artifactPath',
    )
    expect(container.textContent).not.toContain('输出 envelope')
    expect(getByText('查看输出路径示例')).toBeTruthy()
    expect(container.querySelector('.execution-contract-guide__advanced')?.textContent).toContain(
      path,
    )
  })
})
