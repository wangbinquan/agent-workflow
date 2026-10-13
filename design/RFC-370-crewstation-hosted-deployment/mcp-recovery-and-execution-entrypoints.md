# RFC-370 MCP 恢复、执行入口与融合工作区候选

2026-10-13；阶段 A 开发记录。生产接线和测试用例仍在完整收口，本文不构成功能验收。RFC 保持 In Progress，AW 尚未部署到 CS。

## 原 MCP 结算与显式恢复

MCP host frame 现在保留原结算 callback，覆盖原 terminal capture、原验证、原 lease 释放和原结果写入。重试不重新领取 turn，不准备替代执行，也不再次调用 runtime。原 native `release` 的受影响行语义保持；新增完整 `releaseAcknowledged` 端口通过同一 protocol/native-session/test-session 的真实耐久状态确认原 lease 已释放，不能确认或释放另一持有者。

terminal capture 后丢 ACK、落库后丢 ACK、释放后丢 ACK、一次未释放及失败关闭后重试均已编写用例。原运行结果和时间戳保留；不确定 ACK 不能改成成功收据。正常 owner 的原隔离进程恢复对账先于原结算重试，避免结算失败阻断其自身恢复；失权不会因此自动执行新回收。

新增完整 `recover` 应用命令、原资源 coordinator、HTTP `POST /api/mcps/:id/runtime-test-sessions/:sessionId/recover` 和测试对话框恢复入口。权限沿原会话所有者/审计判据，恢复只处理原会话、原 turn 和原 lease。进程存在事实、原回收结果、原 CAS 和原 lease 释放都须确认；缺少 PID、命令不匹配或回收 ACK 未确认仍隔离并阻止新会话。实际子进程回收用例已写入，将在集中验收中执行，当前不能作为物理回收已通过的证据。

## 执行入口与界面

服务端补齐集中问题下发、开发任务回答/需求来源选择/来源刷新、意图 current-action/working-set/重试、事件程序 validate/publish 的分组。runtime 新建仅在原请求要求 smoke 时领取 diagnostics 请求 lease；明确不执行 probe 的配置保存仍是资源操作。runtime status 和 models 的原实现会执行运行时命令，因此也归 diagnostics。已取消的 intent turn 仍完成原取消；其可选下一项自动执行须独立准入，不因不可执行而反转取消。

界面接入同一实际状态：澄清继续/追问、多文档评审、集中问题下发、意图生成/上下文更新、开发任务、数字员工任务创建/续跑、融合、计划立即执行、事件验证、记忆重试、MCP probe 和 runtime probe。资源输入、文档选择、草稿、计划编辑和取消保留。能力变更期间的旧异步 callback 在实际 POST 前再次读取当前可用性，避免准备草稿后越过关闭状态。模型库存未就绪时保留模型 ID 文本编辑，不自动启动模型列表命令；runtime 新建提供明确的“先执行运行测试”选择。

新增/扩展的 HTTP root、组件和 hook 用例只写入，尚未执行。其它未盘点变体与完整界面覆盖仍须沿实际调用者清单核对，不能用这些已登记入口代签全部 H1～H8。

## 融合工作区的独立切面

此前 `fusionOrchestration` 直接持有 FS/Git 效果。现由 knowledge-evolution 的完整 `FusionWorkspaceFactory`/`FusionWorkspace` 端口承接目录引用、不可变版本内容、准备/复制、Git 基线、diff 与 manifest 读取、提案叠加和清理。local adapter 实现原效果，system-operations bootstrap 组装原 source-control excludes/scaffold；业务编排不再直接 import FS/path/Git 实现，选中的全部原方法和 receiver 在首次异步工作前捕获。

SQLite daemon、PostgreSQL daemon 和 embedded HTTP 均可独立选择该 factory，默认在原根显式装配 local adapter；现有三处真实融合测试装配随完整合同更新。原预复制/后复制技能身份围栏、原 seed Git 失败注入、原 Task 所有权移交、未移交清理、manifest 判据及最终领域结果保留。融合列表、待办计数和详情在执行不可用时仅读原持久事实；可用时持有实际请求 lease 完成原对账。原 standalone 行为保留。

已写 native 实际工作区/Git、manifest 缺失与非文件、提案叠加、失败清理、完整 binding/receiver/getter 捕获，以及真实 embedded 冷查询的用例；没有执行这些用例，不宣称 local parity 已验收，也没有编写 CS production adapter。

## 当前证据与剩余工作

本候选累计 123 份 TS/TSX 仅完成 `parseDiagnostics=0` 的语法解析；限定格式和 diff 静态自查完成。未运行 AW 本机 tests/typecheck/build/services/E2E 或实现门，未对新候选作精确 SHA CI 验收，未提交、推送或部署。语法结果不能代签类型、功能或 CI。

后续仍须完成阶段 A 的完整三根/十九 owner 合同与 native/provider 回归用例、剩余入口和界面、其它不确定结算恢复、H1～H8 实际调用者清单与架构配套，再集中进行 A-G。阶段 B 生产 adapter 仍服从 AC00：A-G 通过后开始，各模块各层独立实现；先完成 M0 的实际 CS 发布、登录、编辑/保存与服务重建回读，再逐项推进 M1～M4，不能等待全部能力才首次部署。

最近 fetch 后 `main` 和 `origin/main` 同为 `8d057d62aed78ab305359b26231aa58743d5f4ae`、差异 0/0，index 空。当前并发源码、观测统计算法/缓存、共享架构清单和文档完整保留；本轮未发送跨 session 信息。
