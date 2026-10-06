# RFC-370 启动恢复家族发布配套

状态：阶段 A 候选；本片仅抽取原启动恢复四步，不代表完整 H7、A-G 或 CS 部署完成。

## 有限实现门

设计门 DESIGN-D1 与 SOURCE12-R1 已有效 PASS。源码门 12 owned／12 control／3 evidence 共 27 项，指纹 `285089d51f9247295bbc979b524dd4e323e3e92c7203a5b5ab4ac73d8022d7be`；回执 38531 bytes，SHA256 `e1bce94d35257c47490cabdd6477e8158c9284787d4586949b0076133ebb54b5`。唯一共同 prepare／reap／repair／finalize 顺序在 application；所选 factory 创建完整家族，原生实现解释 opaque 配对引用。原四个机制体、实际 SQLite CLI／PostgreSQL CLI 两个完整 SourceFile AST 逆向、兼容名／签名、receiver、ACK、错误、getter 时点、count／report identity 均保持。HTTP composition 不新增启动恢复。三个旧 reader 的全部 163 expect 和预算保持，新增 23 个类型明确的功能场景；原真实双 provider 启动恢复用例完整保留。

Windows 最初受 Doctor 源码门冻结，不重派 SOURCE12。Doctor 已发布后，独立 Windows1-R1 在 1 owned／4 control／2 evidence 共 7 项有效 PASS，指纹 `6c2b70da97c1c65238dd50ca99e37638ab9b33d5510188a211981d3cbd18677c`，回执 14308 bytes、SHA256 `36d05ea43f5128a3239fcc0b7a4e15605b62cf6bc62f539dc24a06adcf711aac`。10 条触发路径在 push／PR 各一次，4 个适用 suite 各一次；只移除新增 20 行／4 token 后与原 47041 bytes workflow 逐字一致。Doctor 和全部旧命令／预算原样保留。

## 对应源码人口与完整库存

一份原 scoped census 使用完整 committed `a8ebb65189e3a1281bbd9af1bdd645abede80917` 加冻结 SOURCE12 的 8 个 production 文件；所有非本片源读自该完整已提交人口。四个原规则／分类器不变，只写私有产物；sourceDigest 为 `sha256:d05ef6a5d7e5bc34e3826afb624edc3390efa8fa11f79bd325b01261f4ba9a50`。355 条既有 authored debt 全部保留，新增四条真实 type import／export 地址仍按原 R1 分类，共 359；无泛化例外。129 有序库存／why、214 原 guard 判据、40 SPI／69 targets、9 Task effects 与所有原 SCC 保持，guard 行数无差额。

原计数的实际差额如下，只登记五项一次性增长；正常退役 Doctor 的四项已消费许可，下一普通后继退役本批许可。

| 原库存                  |  前值 |  后值 |
| ----------------------- | ----: | ----: |
| mutation entrypoints    |  1923 |  1926 |
| background jobs         |   361 |   365 |
| observed imports        |  6707 |  6712 |
| architecture exceptions |  5906 |  5911 |
| symbol owners           | 27157 | 27169 |

首次纯投影工具沿用 Doctor 的差额白名单，未预期原 background 计数变化而停止；该脚本和错误日志保留，未写共享产物或重复 census。使用同一原扫描输出，完整比较旧／新 background 行：一项旧行更新、五项新行全部来自冻结八个源码地址，原分类器仍包含同名 recovery factory 的 long-running 匹配。504 条 ambient wiring 的完整字段仅实际行号／id 前移，人口不变。只为这项已实测的原计数补私有投影说明，不改变原规则，不声称新增四个业务后台任务。

## 上库与 CI 证据边界

Doctor 已正式提交并推送 `a8ebb651`，发布后 main／origin/main 0／0，index 空，H7 在制内容和并行 RFC-371 全部保留。冻结的正式 API 快照中，Doctor 主 CI `37470083701` 为 queued，Windows `37470167361` 为 in_progress，二者 conclusion 均为空；不能记全仓绿。该 SHA 的较早取消 runs 也不替代新 CI 结论。

本片只运行自有 format／lint、纯 AST／字节／JSON 及一次上述原静态生成；未运行本机 AW tests／typecheck／build／service。完整共享 STATE 作为逐字 suffix 保留。有限元数据门、精确发布、新确切 SHA 的双 OS／双数据库 CI 各自留证；门本身不等于已上库或正式 CI 通过。

## 后续范围

完整 H7 执行 claim／renew／activate、失去执行权时的 admission 与后台停止、handoff／migration、其余 purpose 调用者、全根 A-T7／A-G 仍未关闭。CS adapters 尚未开始，AW 尚未部署到 CS。随后依序 M0 必须适配并首次实际部署，M1 任务闭环，M2／M3 逐项收编，M4 迁移及全部 RFC 验收；RFC 保持 In Progress。
