# RFC-361 技术设计

## 1. 当前调用链

基线为 proposal 所列 SHA，源码均相对仓库根目录。

1. `modules/execution-contract/application/ports.ts` 已定义 `ExecutionContractResourcePort.inspect` 与
   `ExecutionContractProgramFixturePort.validate`。
2. `modules/execution-contract/infrastructure/taskExecutionAdapter.ts` 同时读 `agents/workflows`，使用
   `services/agent.exposedFrontmatterExtra`、`services/workflow.decodeStoredWorkflowDefinition` 和
   `services/scriptRun.resolveScriptInterpreter/runScriptProcess`，还负责临时目录与输出读取。
3. `modules/execution-contract/composition.ts` 构造这两类 adapter，DE authoring/runtime/reaction 消费统一 participant。
4. Workflow 兼容检查先调用 shared migration，再检查 text prompt input、额外 required input、node kinds 与 result output；
   schema v6 output 的 inbound edge 属于当前行为，不可退回只看旧 ports 的判据。

采用 RFC-294 feature-first 分层与 consumer-owned required ports。EC owns contract 判据；RC owns resource projection；
TE owns program execution；bootstrap 注入 provider，不在根节点按 Agent/Workflow/Program 做业务 switch。

## 2. 资源检查合同

保留当前单方法 `ExecutionContractResourcePort.inspect` 的输入和结果形状：implementation 的 exact Agent/Workflow ref 与
expectedOutputPort → `ExecutionContractResourceProjection | null`，包括 kind/name/available/detail/declaredContractRefs。

RC 在 `modules/resource-catalog/infrastructure/adapters/executionContractResourceAdapter.ts` 实现该 required port。
RC 读取自己的 typed query/repository，并执行 resource-specific closure projection；EC 继续执行 guide/contract compatibility。
纯 Workflow closure 判据可放 RC domain，依赖 shared schema migration；不从 EC implementation 深层导入。

保持 Agent `updatedAt` / Workflow `version` 的 revision 对拍、找不到返回 null、frontmatter declarations parser 与 implicit
declarations fallback。版本过期不得静默用最新资源代替；字段缺失和 definition 解码失败的结果跟旧实现逐项比对。
原 optional implicit declarations provider 必须在 composition 明确绑定既有 fallback，实现功能不可因 optional 消失而丢失。

## 3. Script fixture 合同

当前 `validate({ guide, implementation, validateOutputJson? })` 把 EC validator callback 传给外部 mechanism。
目标拆为执行与判定两段，仍在一次 EC application 用例内完成：

```ts
interface ExecutionContractFixtureRequest {
  readonly implementation: Extract<ExecutionContractImplementation, { kind: 'program' }>
  readonly inputJson: string // EC 已物化 host-envelope 或 direct-json 的 fixture input
}

interface ExecutionContractProgramFixturePort {
  run(input: ExecutionContractFixtureRequest): Promise<ExecutionContractFixtureResult>
}

type ExecutionContractFixtureResult =
  | { readonly kind: 'completed'; readonly rawStdout: string }
  | { readonly kind: 'failed'; readonly checks: readonly ExecutionContractCheck[] }
```

`ExecutionContractFixtureRequest` 保留完整 program implementation：runtimeKind、executableArtifactRef、executableDigest、
parameterValuesRef、runtimeProfileRef。最后一项当前不用于解释器选择，不能借迁位更改其作用。EC 生成原有
`fixture-${ulid()}` roundRef 与 `sha256(roundRef)` executionNonce；host-envelope 时将两字段填入 exampleJson，direct-json 不填，
两者都作为已物化 inputJson 交 provider。EC 本域保留这两个验证事实，不要求 provider 理解 guide。

TE provider 保持 artifact 读取/digest 校验、parameterValuesRef 的解析和 `DIGITAL_EMPLOYEE_TOOL_PARAMETERS_JSON` 环境投影；
解释器仍使用现有 overrides。固定 30,000ms timeout、原 fixture task/node 标识及 run/worktree 临时目录结构不变。
失败继续返回当前 `program-artifact-*`、`program-parameter-artifact-*`、`program-interpreter-available`、
`program-fixture-execution` checks；后者 detail 仍是 failureCode 加 stderrTail 最后 1,000 字符。

成功返回当前 rawStdout，EC application 仍先 trim，再按 outputMode 处理：direct-json 必须调用注册 validator 并使用其返回值，
缺 validator 仍返回原失败；envelope/artifact-path 保留原处理。随后用本域保存的 roundRef/executionNonce 调
`validateExactContractOutput`，生成相同 `program-fixture-exact-output` checks 与 receipt。不能省略转换后的 outputJson，
也不能丢掉 envelope 配对事实。provider 不接 validator callback 或完整 guide。

provider 位于 `modules/task-execution/infrastructure/adapters/executionContractFixtureAdapter.ts`，实现 EC-owned SPI；
EC 不反向导入 provider。TE adapter 对仍在 `services/scriptRun` 的 mechanism 引用须按 TE/W5 owner 登记，不能把旧 import
搬个文件就宣称整个 Script mechanism 完成归位；本批清除的是 EC 越权拥有该机制的边。

临时目录创建、解释器失败、timeout、nonzero exit、输出不存在、解析失败以及 finally 清理全部沿用原合同。
进程执行在数据库事务之外；不因 RFC-359 async transaction 可 await 就把长进程放入 DB transaction。

## 4. 装配与接口迁移

`composeExecutionContract...` 改为接收两个必填 provider，删除默认构造和 legacy fallback。
bootstrap 从 RC/TE 的 composition 各取唯一 adapter，注入同一 EC participant，后者继续供 DE 三条实际消费链使用。
EC public commands/types/receipt wire 保持；内部 required-port 方法变更同批更新所有 consumer。

`design/RFC-310-rule-driven-development-digital-employee/os-architecture-manifest.json` 所列三个 OS context 唯一 owner、root/public entrypoint
和 external imports 必须按源码对拍，不因新 provider import 而放宽整目录豁免。
共享 root 与 RFC-360/362 分批串行接线。无 schema 或历史数据迁移。

## 5. 功能验证

沿用 `tests/rfc359-execution-contract-resource-adapter.test.ts`、`tests/execution-contract-platform.test.ts`、
`tests/rfc318-minimal-digital-employee-tool-contracts.test.ts`、`tests/rfc310-digital-employee-os-architecture.test.ts`，
以及 DE authoring/runtime 的现有集成测试。资源投影用真实 SQLite/PostgreSQL 对拍。

| 失败/边界                                       | 必须保留的结果                            |
| ----------------------------------------------- | ----------------------------------------- |
| 资源不存在或 revision 不匹配                    | 原不可用 receipt，不替换成新 revision     |
| Agent explicit / implicit contract 声明         | 原优先级、兼容性和 detail                 |
| Workflow 旧 schema / v6 result 边               | 相同 migration 与 closure 判定            |
| Script 解释器缺失、执行失败/超时                | 原 checks/code/detail；临时资源清理       |
| Script 输出缺失、JSON 错误、exact output 不匹配 | EC 原校验顺序与 receipt                   |
| 同一次 DE authoring/runtime/reaction            | 使用同一 participant，无旁路 fixture 算法 |

新增 architecture 负扫描证明 EC 无 legacy/table依赖、无 composition fallback 与 value cycle；新增行为用例只补迁移风险。
回滚可回退 provider binding 与内部调用形状，保持 public wire；不能留下只有某个数据库使用的旧 adapter。
