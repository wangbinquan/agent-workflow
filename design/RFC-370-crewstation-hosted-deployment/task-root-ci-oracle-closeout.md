# Task Run 的三个旧 CI 预言补正

状态：有限实现候选；独立功能门、精确发布和新 hosted CI 待验。

确切提交 `4bcfe74838087078360444f5728263fef19f393c` 的 Windows run37538984223 已正式成功。主 run37538984299 的原 backend jobs112527046517／112527046629／112527046707／112527046764／112527046778 分别失败；实际失败日志对应三个仍引用旧 Task Run 形状的预言。run 的汇总尚未完成，不能记录全仓通过。

- W8 的两个 provider 根仍通过同一个 `createTaskExecutionRuntimeParticipants` 工厂，输入现由完整 `bindProviderTaskRunParticipantsInput` 绑定。本片只把原直接对象调用的正则映射到这一准确包裹入口，原计数仍为二。
- `taskEngineApplication.ts` 已通过 exact `source-control/public/participants` 的 `bindWorkspaceExcludeProfile` 消费所选工作区合同，原 `source-control/composition.ts` 导入实际消失。因此只删除这一条过期 cross-context pilot debt，将其基线从二降为一；剩余 MR type import、原扫描函数及全部判据保持。
- committed `public-surfaces.json` 的 `WorkspaceExcludeParticipant` 已有三个 `publicTypeConsumerIds`，按原 `unconsumedPublicSymbols` 的规则不再属于零消费者。只删此条旧 public symbol debt，并将基线从 136 降至 135；原公共面和 required-port 判断函数、其它债务条目保持。

两项基线保留完整旧 why 并追加本次真实收敛原因，全部其它有序库存、计数与条款保持。本片零生产改动，复用 Task Run 已完成的原生成结果，只修实际账本计数，不重复 census、不增加增长许可。完整测试全文按上述有限差额逆向恢复，原 case／断言／预算不变；本机只做自有 format／lint 与纯源码、AST、JSON 核对，正式功能执行仍交给新 exact-SHA GitHub Actions。

在制的 Purpose／Staging 和并行输出保留且不包含于本次发布。完整 H7、阶段 A／A-G、各 owner 的 CS adapters，以及 M0 首次实际部署和逐项 M1～M4 仍在推进；AW 尚未部署到 CS，RFC 不记完成。

SOURCE5-R1 的独立有限实现门正式有效稳定 FAIL：三个 oracle 与 129 有序库存已核对，唯一功能 P2 为两项 ledger payload 修正后仍保留旧 provenance.contentDigest。原 FAIL 和全部候选留证；本后继按原 canonical-json-without-provenance 规则仅重算内容摘要，不更改 census sourceDigest／snapshot／origin、不新增生成或改变原规则。最终功能门、发布与 hosted CI 继续。
