# RFC-370：HumanGate 切面配套清单与发布

本记录配套 [HumanGate 原子与目的设计](host-authority-task-human-gate.md)。本片把 Task 原人工门三原子接入既有宿主目的选择，保留十个真实调用的原输入、原业务事务与结果。它只完成阶段 A 的一个片段；完整 H7、十九个 owner、三个启动根、A-T7／A-G，以及 CS 各层独立 adapter 和 M0～M4 仍需继续。AW 尚未部署到 CS，RFC 未完成。

## 源码检视与实际执行的边界

SOURCE1-R1 为正式 FAIL，两项新增测试夹具错误已保留：显式依赖测试的新 port 破坏原绑定身份，Clarify 测试的问题缺少真实 schema 字段。修正只触及新增测试，复用原 port／显式 transactionFor receiver，并提供完整 single 问题与两个 option。SOURCE1-R2 的独立功能门为 PASS、零 findings；主会话已逐项消费 40 份材料及其实际字节身份。R2 fingerprint 为 `29f1ce761923810831bbce48d9a01eb3f584aa6225d08e6a02746dfda4e20978`。

R2 保留九份完整原生产源码的有限逆变换、37 段目的选择增量和十个真实调用的原参数；原生命周期 52 个 provider case 与一个全量原调用者 case 保持。新增 HumanGate 文件静态枚举为每 provider 46 个 case 加一个全量 case，预期 Ubuntu93／macOS47／Windows47，合计187次；原生命周期预期211次，两文件合计398次。以上是静态人口，尚未执行，必须逐项消费新提交的 hosted 原输出才能签署通过。

前置 `801435f8d364d556fccd57f71505b799049d2256` 的主 CI `38028006155` 为72/72 success，默认完整 Windows `38028075893` 为1/1 success；原生命周期211次实际执行与两条流水线各四工作区类型检查完整通过。它只满足开始本片生产实现的前置总绿门槛，不替代本片的新提交验收。

## 唯一原 census 与来源

共享 Windows／ledger／T19f 文件等待另一会话正常发布后，采用已核对同步的 `236c6dab9d6c7b242d9e01d7445a9ac942f033b7` 为生成基底。此前并行内容由 `70a29581d3987d7269ab479be09cb40f2cb79efb` 与紧邻许可退役提交发布。原四份生成规则字节未改；18份已通过 SOURCE 的本片材料从冻结数据读入，6818份非本片源码全部来自该精确提交的 Git blob。

这个内容候选只运行一次完整原 census，成功1次、不完整0次，私有生成全部13份产物。sourceDigest 为 `sha256:af830c52e7f2206701ba489e1ae1dcfa46e9266e16d03583cd1dffd8492eadc9`。之后只提取原规则的28个纯 JSON／投影／渲染声明，逐字复现原8份 canonical JSON、4份 governance JSON 与原 status；没有再采数，没有改分类器、fixture、阈值或测试注册。新增两项一次性许可后，以原 provenance 函数重新计算 ledger contentDigest。

## 实际增量与一次性增长许可

| 原账本                        | 前值  | 新值  | 本提交实际增量                                                               |
| ----------------------------- | ----- | ----- | ---------------------------------------------------------------------------- |
| `rfc294-mutation-entrypoints` | 1993  | 1994  | `taskHostHumanGateWritePurposes.ts#createSelectedHumanGateTaskWritePurposes` |
| `rfc294-module-symbol-owners` | 27794 | 27804 | 下列十个原生成器新增 owner                                                   |

十个 owner 来自以下精确符号：

- `application/humanGateTaskWriteSelection.ts` 的 `$file`、`selectHumanGateTaskWrites`、`Selection`。
- `application/ports/humanGateTaskLifecycle.ts#HumanGateTaskWritePurposes`。
- `composition/humanGate.ts#resolveHumanGateTaskWrites`。
- `infrastructure/humanGateTaskLifecyclePersistence.ts` 的 `assertPreparedInput`、`HostHumanGateGuardWrite`、`HostHumanGateWrite`。
- `infrastructure/taskHostHumanGateWritePurposes.ts` 的 `$file`、`createSelectedHumanGateTaskWritePurposes`。

以上均位于 `packages/backend/src/modules/task-execution/`。原 mutation／owner 条目没有删除，也没有既有行内容变化。transaction277、background374／ambient505、observed imports6907／exceptions6049／required ports40／target edges69／target SCC0、facades298、public1260／governed fields5／opaque15／contexts18 保持。commons kernels81、debt357／registered79、guard214与130行 ledger 的全部原 ID／顺序／why 保持；ledger 只有上表两项实际 baseline 增长。

production 文件2428→2430、module1832→1834、Task491→493。原 backend／repo SCC 全数组、native timers79／intervals23及19个原文件、inbound311／outbound46、空 AppDeps／unresolved 数组保持。本片11个生产文件的原经典边界集合前后均为 inbound0／outbound0。status 由原完整纯 renderer 生成，不手改。

源码消费提交只为上述两项登记 `allowGrowth.why`，不增加其他许可；紧邻普通后继提交只移除这两个许可并由原 provenance 函数重算 digest。退役后的 ledger 恢复本次原 census 的完整原字节，130行内容与新增 baseline 均保持。已用原 `growthViolations`／`staleGrowthPermits` 两个纯比较函数分别核对消费提交相对原 baseline、退役提交相对消费提交，均无增长违规或过期许可。没有执行本机架构测试。

## 完整 Windows 配套

在原 push 与 pull_request 两个 path filter 中分别补入本片缺少的12个精确输入，17个 backend 源码／测试输入全部登记。在原 `RFC-254 platform suites` 的完整 `bun test --isolate` 命令内，原生命周期 token 后补入 HumanGate、RFC-333 source locks、RFC-359 W4-D25 三套测试。移除这12个输入与三个 token 后，完整解析后的 workflow 与原文件完全相等；此前所有并行 RFC-371 内容、原 steps／env／超时／预算均保持。

完整 Windows 将采用新 SHA 已存在的自动完整 run；仅当 path filter 限制使其未出现，才对同一 SHA 的 main 发起一次无输入默认完整 run。主 CI 的总结果及完整 Windows 都须终态 success；部分作业、旧 SHA 或被取消的 run 均不代签。

## 发布与后继验收

配套检视按功能范围独立读取13份实际 JSON／status、完整 Windows、源码冻结身份、原规则及来源／许可证据；主会话完整消费 PASS 后才能发布。发布仅涉及本片17份源码／测试、4份 RFC／STATE 文档、13份配套产物及 Windows，共35个精确路径。共享索引与 main 的短发布区互斥，fetch 后核对 ancestry 与全部 staged 字节，保持并行输出；许可退役是紧邻一笔仅 ledger 的普通提交，不改写历史。

发布后核对完整远端同步，逐一消费新 SHA 的全部主 CI jobs、默认完整 Windows、两条流水线四工作区类型检查、HumanGate187次和原生命周期211次真实执行／断言／名称／时长。未运行本机 AW tests／typecheck／build／services／E2E。检视、发布与新 hosted CI 分别验收，尚不签署新用例成功、完整 H7、A-G 或 CS 部署。
