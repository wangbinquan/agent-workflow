# RFC-370 阶段 A 退出清单

## 2026-10-14 集中验收修复与完整发布候选

阶段 A 的完整生产／用例源码已发布为 `b9b27bfd84e0b39dac6b6f7dd76eee78343cc511`，配套架构投影为 `1e085af8e14bb6b7657fd6be9402f88ff78276d3`；两条确切 CI 已终态失败，不能据完整提交签 A-G。阶段 B 仍未启动，AW 尚未部署到 CS。

集中诊断修正了 native 前端状态夹具及 ErrorBanner 接线、真实 maintenance activateDispatch 转交、Fusion 语义常量、调用者类型、Memory 原候选稳定 ID，以及原回执的 PostgreSQL JSON 字节存储。Memory journal 用 versioned canonical-json base64 封套保留 NUL／原输出，旧 JSON 可读取；原 ID／preparedAt／ACK 判据保持。Intent 的 retained owner／方法在原 await 前一次捕获，native 与 selected 不混用后换的 getter。宿主关闭先完成原 owner 正常 stop/drain 和 authority 退休，再进入 provider close，避免 beforeCloseProvider 回调同一 session 队列形成死锁。

针对实际 CI 失败的本机集中诊断：前端七文件 108 项通过；Intent 原 prepared/started/terminal/settlement/material ACK 八项通过；实际宿主激活／embedded 根及 Memory 业务恢复 35 项通过；MCP 生命周期 23 项通过（含本次真实 child 原恢复，需要可读取 ps 的正常宿主权限）；最后五文件存储／webhook／boot/owner 夹具 48 项通过。另有多份已通过的相关回归，记录见 [阶段 A CI 修复](stage-a-ci-closeout.md)。这些是候选诊断，不代签 GitHub 双 provider、Windows、完整总流水线或独立实现门。

本任务之前 `651f956df` 的 CI run `38429501809`／job `115407653250` 已有 `tests/cli.test.ts` 四处 signalCode 类型错误；本轮 backend Typecheck 修正本人错误后，仅余它们及 `scripts/rfc359-p0-mutations.ts` 同类错误。原 whole-source root oracle 在加入本轮有限逆变换后仍有先前并发根变化的原摘要差，须按实际原提交与依赖归因，不能删除断言或覆盖并发内容。独立 Codex 评审工具仍缺失，未记实现门 PASS。

当前退出顺序不变：完成本人缺陷修复及配套生成物，按明确路径完整提交并 push，核对远端同步与确切 SHA 主 CI／Windows；总绿及 A-G 取得后才推进独立 CS adapter 的 M0 首次实际部署，之后 M1～M4。没有跨 session 消息。以下历史及并发正文完整保留。

2026-10-13。用户再次要求：阶段 A 全部完成后先完整提交上库，并把 GitHub 总流水线修绿，之后才能进入阶段 B。此前实现、远端提交和本机部署的批准保持。

本文是当前退出清单，不是完成回执。历史片段 PASS、新候选的语法解析以及其它 session 的提交不能替代阶段 A 的完整验收。RFC 仍为 In Progress，AW 尚未部署到 CS。

2026-10-14 续推：实际 daemon 在执行启动受阻时保留已就绪资源 HTTP，新增原 SO 激活重试/API/UI 和 Memory 行级恢复，正常在途 tick 不被冷恢复接管；Intent 遗留 scratch helper 复用既有存储 port。参见 [资源服务与原恢复接线](resource-serving-and-original-recovery.md) 和 [当前调用者账本](stage-a-caller-ledger.md)。新增用例仍未执行，不据此关闭阶段 A。

最新候选已将双 provider 原回执日志接到实际 Memory 调度、协议链、候选写入、业务结算和重建恢复；启动失败保留可排空的原 owner，新执行代等待原恢复/写入确认。native 准备阶段也有原 gated identity，原 daemon 崩溃后可处理未激活 helper；未执行任务归还原领取且保留预算，已执行协议轮不重跑。相关代码和用例已写入，尚未集中验收；见 [耐久原执行与日志候选](durable-system-recovery-reference.md)。下表记录阶段 A 退出要求，不以候选接线替代通过证据。

| 剩余工作                            | 已有候选                                                                                            | 退出条件                                                                                                       | 当前结论                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 原执行恢复及恢复后继续（A-T5/A-T6） | MCP 原 turn/lease/结算恢复；System 原启动/材料引用；Memory 主回执、冷恢复、原协议续接及 SO 新代接线 | 原身份、物理事实、capture/材料/写入 ACK 与后续准入一致；覆盖重建/重启，未知不能重放                            | 候选及回归已补；与完整根/调用者一并集中验收          |
| H1～H8 全调用者核对（A-T1～A-T6）   | 配置/安装/内容、身份/事件、workspace/Git、双 Agent/脚本/runtime 材料及宿主执行权独立切面和本地实现  | 按逐入口 oracle 核对实际 port/adapter/composition，消除本 RFC 范围内直连效果；完整合同不是空 facade            | 清单尚未最终闭合                                     |
| 三根/十九 owner 完整用例（A-T6）    | SQLite/PG daemon 已选择十九 owner；嵌入式根保留其原实际 owner；循环及 HTTP/UI 用例已编写            | 写齐根整体、原 native、冷启动/激活/暂停/失权/恢复/关闭和原 ACK 竞争；不伪造嵌入式 daemon owner                 | 接线已写入，完整覆盖仍待收口；新用例未执行           |
| 依赖/账本/共同合同（A-T7）          | public/composition 与部分守卫配套                                                                   | 全调用者 ledger、依赖守卫、canonical 清单和最终源码一致，保留并发输出                                          | 未闭合                                               |
| 验证/完整上库/CI 总绿（A-G）        | 历史片段的有限证据；新候选只做必要静态自查                                                          | 完整开发和用例写作后集中功能验证及实现门；按确切路径完整提交阶段 A；远端同步和确切 SHA GitHub 总流水线终态全绿 | 尚未开始本次最终验收；不能以相关作业绿替代总流水线绿 |

2026-10-14 最终候选：Intent 实际 turn lifecycle、主回执、原 ACK 继续、冷恢复与 HTTP/UI 已补入两 daemon/embedded；相关用例写齐，源码及测试写作完成。后续仅集中验收、架构产物、完整远端提交与确切 SHA CI 总绿。独立 Codex 功能门工具仍缺失，没有 PASS 记录。共享源码发布时使用已提交 Git source-ref 投影清单，避免纳入并发在制品；这不创建其他 checkout 或 index。

## 执行顺序

1. 完成阶段 A 全部生产实现、调用者接线和测试编写。开发期间只做必要读码、语法、格式自查。
2. 收口 A-T7，针对最终任务候选集中功能验证和实现门；本人缺陷只复验受影响范围，不追逐无关 SHA 重跑完整本地门。
3. 核对共享 main 与 origin/main、完整 index 和明确路径清单，完整提交阶段 A 候选，保留相关并发产出并正确记录共同贡献；完成远端提交与同步证明。
4. 等待确切 SHA 的 GitHub Actions 终态，失败按 job/step/日志和确切 diff 归因。本会话引入的问题由本会话修复；其它归属保留证据，不代改、回退或跨 session 催办。修复提交也取得自己的确切 SHA 终态证据。
5. A-G 与 GitHub 总流水线通过后，进入独立 CS adapters：先 M0 实际部署、登录/编辑/保存/重建回读，再按 M1～M4 收编。

共享 CI 未绿时不进入阶段 B，不把部分通过、排队、取消或后继无关提交记作阶段 A 完成。
