# CI：新增 System 原测试的类型标注

`79b63f483990136a1e6e131da4966c3704be2803` 的主流水线 `37746020731`，作业 `113207582002` 在 Typecheck 阶段报告三处错误。该作业日志已完整保存并 EOF 读取，本次只处理两个原测试的类型。

| 位置                                                                 | 原问题                                                     | 修复                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `rfc371-system-complete-report-provider.test.ts` 的 `publish` helper | UUID 默认值推断成 UUID 模板，拒绝原有 refreshKey 字符串    | 参数明确为 `string`，默认表达式原样保留                                                |
| 同文件 linked Task 的完整 Set 对账                                   | 原索引表达式可能为 `undefined`，Bun matcher 的默认推断过窄 | 显式使用 `Set<string \| undefined>` 的 matcher 类型，两个 Set 及严格对账表达式原样保留 |
| `rfc371-system-root-serialization.test.ts` 的 accepted root 归属     | 可选 head 字段与 Array matcher 的推断冲突                  | 显式使用 `Array<string \| undefined>` 的 matcher 类型，原可选读取和成员判断原样保留    |

没有新增非空断言、值回退、提前返回或条件跳过。缺少 head、缺少原索引项、错误 root 或人口差异仍由原有运行时断言拒绝。

三条原用例继续通过原 `describeEachProvider` 执行两种 provider；214/203 条人口、分页、linked Task、retained 读回、并行 root reset 的原判据与 60000/120000/30000 ms 预算完整保留。helper 和 matcher 只改变 TypeScript 类型标注，完整运行时 AST 对比检验等价。没有修改生产代码、架构清单或 CI 规则，没有本地产品测试、typecheck、build、服务或新 census。

有限源门和格式检查不等于 GitHub 全绿。发布后继续等待完整主 CI 和 Windows；新的 runtime/Node/CS 实现继续暂停。RFC-370、H7/A-G 和 AW 在 CrewStation 的部署仍未完成。
