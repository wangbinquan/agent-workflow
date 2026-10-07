# RFC-370 Pipeline 兼容装配公开入口补正 D3

状态：待独立功能设计门。本补正继续已获批 Purpose／staging 重构，只改变两个 import 地址的公开接线；H7、A-T7、A-G、CS adapters 与 M0～M4 继续开放。

SOURCE61-R4 已有效稳定功能 PASS（81c60c4afd41950cc708ea5fb2819ee861e1908b43d10430fabae91e4be87dae）；该最终生产候选的一次原 scoped census 在865fc045成功，13份私有输出、4原规则全文不变。SOURCE60-R2 的旧一次 census 因 legacy services helper 未登记 owner 而失败、SOURCE61-R3 的准备因7bytes export补正而在任何 census前停止，全部历史保留。

原 classic 规则对本候选44个生产文件测得旧43条R1／0条R2、新44条R1／0条R2；真实差额为 retirement of services/developmentDeliveryDeps.ts → integration/infrastructure/developmentPipelineAdapter 的旧type边，新增 services/developmentDeliveryDeps.ts → development-automation/composition/pipelineEvidence 的value与type两边。canonical投影不能代替这个分类。

## 有限设计与所有权

DA 已持有完整 `composeSelectedDevelopmentPipelineEvidence`、`composeLegacyDevelopmentPipelineEvidence` 和 `LegacyPipelineEvidencePort`，分别在自己的composition及local infrastructure中实现。其完整函数正文、参数／结果、native临时目录机制、selected lease／receiver、ACK与错误／finally边界已经复核，继续全文保持。

在 DA 既有 `public/participants.ts` 新增 exact named re-export：`composeSelectedDevelopmentPipelineEvidence`、`composeLegacyDevelopmentPipelineEvidence`、`type LegacyPipelineEvidencePort`，仅转发本owner的 `../composition/pipelineEvidence`。既有模板、staging assert公开入口及全部正文保持。services/developmentDeliveryDeps.ts 的同一三名import只把specifier从 `@/modules/development-automation/composition/pipelineEvidence` 改为 `@/modules/development-automation/public/participants`。旧一个参数兼容重载和新两个参数selected重载全文不变，不新增函数包装、默认能力、effects或调用。

该participants入口公开的是DA本已拥有的关闭式Pipeline参与者装配；legacy入口明确保留原物理API供旧compat调用，selected入口继续只消费opaque staging引用。没有CS DTO、远程协议或CS实现进入common，也不把legacy物理API当作未来CS合同。每个owner仍持有自己的local／CS adapter与composition。

## 验证与发布顺序

先通过本有限独立设计门，再作两个完整文件机械补正。完整before保存及字节逆变换证明：移除唯一named re-export恢复participants全文，反向替换唯一import specifier恢复services全文；其余115个R4条目、所有既有case／assert／budget和原函数身份保持。对59个TS做纯syntax parse，owned格式／lint按需执行；不在本机运行AW tests／typecheck／build／service。既有正向与边界回归继续由精确SHA hosted CI验收。

源码独立功能门通过后，这一不同的生产候选执行一次原 scoped census；R4原成功输出不覆盖、不重跑。继续采用同一4原规则，私有输出、源人口从精确已提交基准和冻结owned候选组成，其他WIP不参与。纯JSON核对差额时保存真实旧R1 retirement与每一条剩余原debt的完整clauses；不添加新的越层债务、不修改scanner／classifier／guards／原断言与预算。最终源与matching组成一份可发布候选，正式CI仍单独验收。

D3 已独立有效稳定 PASS：12项／321537bytes，FP 943a0f676c717c23b6541e5edfc9ee251f98bd18819610de0d6d413157a92532；两个完整源码文件按上述唯一转发／specifier补正落地。旧R4功能PASS与一次成功census完整保持；本最终源码候选及其一次匹配生成／正式CI继续，不关闭H7／A-G／CS部署。
