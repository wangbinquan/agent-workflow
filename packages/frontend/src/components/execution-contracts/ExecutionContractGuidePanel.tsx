import { contractText, type ExecutionContractGuide, type ExecutionContractField } from './types'

function FieldList(props: {
  fields: ExecutionContractField[]
  language: string
  primary?: boolean
}): React.ReactElement {
  const zh = props.language.startsWith('zh')
  return (
    <div
      className={
        props.primary === true
          ? 'execution-contract-fields execution-contract-fields--primary'
          : 'execution-contract-fields'
      }
      data-testid={props.primary === true ? 'execution-contract-primary-fields' : undefined}
    >
      {props.fields.map((field) => (
        <div
          className={
            props.primary === true
              ? 'execution-contract-field execution-contract-field--primary'
              : 'execution-contract-field'
          }
          key={field.path}
        >
          <div>
            {props.primary === true ? (
              <strong>{contractText(field.label, props.language)}</strong>
            ) : (
              <code>{field.path}</code>
            )}
            <span className="execution-contract-field__type">{field.valueType}</span>
            {field.required ? (
              <span className="execution-contract-field__required">{zh ? '必填' : 'required'}</span>
            ) : null}
          </div>
          {props.primary === true ? (
            <div className="execution-contract-field__path">
              <span>{zh ? 'Envelope 读取路径' : 'Envelope path'}</span>
              <code>{field.path}</code>
            </div>
          ) : (
            <strong>{contractText(field.label, props.language)}</strong>
          )}
          <p>{contractText(field.description, props.language)}</p>
          {field.condition === null ? null : (
            <small>{contractText(field.condition, props.language)}</small>
          )}
        </div>
      ))}
    </div>
  )
}

export function executionContractProgramStarter(language: 'bash' | 'node' | 'python'): string {
  if (language === 'node') {
    return `import { readFileSync } from 'node:fs'

const inputJson = process.env.AW_PORT_CONTRACT_INPUT ??
  readFileSync(process.env.AW_PORT_FILE_CONTRACT_INPUT ?? '', 'utf8')
const input = JSON.parse(inputJson)

throw new Error('TODO_IMPLEMENT_CONTRACT')

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  roundRef: input.roundRef,
  executionNonce: input.executionNonce,
  status: 'blocked',
  summary: \`contract fixture accepted: \${input.inputSchemaId}\`,
  contextPatches: [],
  effectSuggestions: [],
  artifactRefs: [],
}))`
  }
  if (language === 'python') {
    return `import json
import os

input_json = os.environ.get("AW_PORT_CONTRACT_INPUT")
if input_json is None:
    with open(os.environ["AW_PORT_FILE_CONTRACT_INPUT"], encoding="utf-8") as input_file:
        input_json = input_file.read()
contract_input = json.loads(input_json)

raise RuntimeError("TODO_IMPLEMENT_CONTRACT")

print(json.dumps({
    "schemaVersion": 1,
    "roundRef": contract_input["roundRef"],
    "executionNonce": contract_input["executionNonce"],
    "status": "blocked",
    "summary": f"contract fixture accepted: {contract_input['inputSchemaId']}",
    "contextPatches": [],
    "effectSuggestions": [],
    "artifactRefs": [],
}, separators=(",", ":")))`
  }
  return `#!/usr/bin/env bash
set -euo pipefail

if [[ -n "\${AW_PORT_CONTRACT_INPUT:-}" ]]; then
  contract_input="$AW_PORT_CONTRACT_INPUT"
else
  : "\${AW_PORT_FILE_CONTRACT_INPUT:?platform contract input is required}"
  contract_input="$(<"$AW_PORT_FILE_CONTRACT_INPUT")"
fi

echo "TODO_IMPLEMENT_CONTRACT" >&2
exit 2

# Replace the TODO above with business logic. roundRef and executionNonce are
# fixed fields in contract_input and must be copied into the output.
printf '{"schemaVersion":1,"roundRef":"%s","executionNonce":"%s","status":"blocked","summary":"contract fixture accepted","contextPatches":[],"effectSuggestions":[],"artifactRefs":[]}' \\
  "round-ref-from-contract-input" "nonce-from-contract-input"`
}

export function ExecutionContractGuidePanel(props: {
  guide: ExecutionContractGuide
  language: string
  kind: 'agent' | 'workflow' | 'program'
}): React.ReactElement {
  const zh = props.language.startsWith('zh')
  const transport = props.guide.transports[props.kind]
  const primaryFields = props.guide.input.primaryFieldPaths.flatMap((path) => {
    const field = props.guide.input.fields.find((candidate) => candidate.path === path)
    return field === undefined ? [] : [field]
  })
  const primaryPaths = new Set(primaryFields.map((field) => field.path))
  const advancedInputFields = props.guide.input.fields.filter(
    (field) => !primaryPaths.has(field.path),
  )
  return (
    <section className="execution-contract-guide" data-testid="execution-contract-guide">
      <header className="execution-contract-guide__primary-heading">
        <div>
          <span>{zh ? '这个工具运行时会收到' : 'This tool receives at runtime'}</span>
          <strong>{zh ? '关键业务参数' : 'Key business parameters'}</strong>
        </div>
        <span className="execution-contract-guide__injected">
          {zh ? '平台自动注入' : 'Injected by platform'}
        </span>
      </header>
      <p className="execution-contract-guide__primary-copy">
        {zh
          ? '参数值来自每次任务，不在工具定义中固定填写。请确认所选 Agent、Workflow 或脚本能消费下面的路径。'
          : 'Values come from each task and are not fixed in the tool definition. Confirm that the selected Agent, Workflow, or script consumes the path below.'}
      </p>
      <FieldList fields={primaryFields} language={props.language} primary />

      <details className="execution-contract-guide__advanced">
        <summary>
          <span>{zh ? '系统执行参数' : 'System execution parameters'}</span>
          <small>
            {zh
              ? `${advancedInputFields.length} 个输入字段 · ${props.guide.output.fields.length} 个输出字段`
              : `${advancedInputFields.length} input fields · ${props.guide.output.fields.length} output fields`}
          </small>
        </summary>
        <div className="execution-contract-guide__advanced-body">
          <header>
            <div>
              <span>{zh ? '平台执行契约' : 'Platform execution contract'}</span>
              <strong>
                {props.guide.contractRef.contractId}@{props.guide.contractRef.version}
              </strong>
            </div>
            <div className="execution-contract-guide__schema-flow">
              <code>{props.guide.input.schemaId}</code>
              <span aria-hidden="true">→</span>
              <code>{props.guide.output.schemaId}</code>
            </div>
          </header>

          {transport === null ? null : (
            <div className="execution-contract-transport">
              <div>
                <span>{zh ? '平台如何注入输入' : 'How input is injected'}</span>
                <code>{transport.inputLocation}</code>
                <p>{contractText(transport.inputInstruction, props.language)}</p>
              </div>
              <div>
                <span>{zh ? '平台从哪里接收输出' : 'Where output is received'}</span>
                <code>{transport.outputLocation}</code>
                <p>{contractText(transport.outputInstruction, props.language)}</p>
              </div>
            </div>
          )}

          <details open>
            <summary>{zh ? '其余输入字段' : 'Other input fields'}</summary>
            <FieldList fields={advancedInputFields} language={props.language} />
          </details>
          <details>
            <summary>{zh ? '输出字段' : 'Output fields'}</summary>
            <FieldList fields={props.guide.output.fields} language={props.language} />
          </details>
          <details>
            <summary>{zh ? '查看输入 JSON 示例' : 'View input JSON example'}</summary>
            <pre>{props.guide.input.exampleJson}</pre>
          </details>
          <details>
            <summary>
              {zh ? '查看必须输出的 JSON 模板' : 'View required output JSON template'}
            </summary>
            <pre>{props.guide.output.exampleJson}</pre>
          </details>
        </div>
      </details>
    </section>
  )
}
