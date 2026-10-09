# RFC-370 C2-W2-D：原 Windows 动态状态登记

## 已发布来源与共享文件条件

七个动态状态生产文件及新测试已随 `331f30aaf75500487b38910da08df946648664e9` 发布；合法夹具和 PG SQL 观测修复已精确发布 `60c189681acdf2c8c6dd8b8fb9afe88424cf2862`。本后继只登记这些已在 main 的实际输入，不改生产或测试正文。

原 `.github/workflows/windows-platform.yml` 正由 RFC-371 会话修改，包含该会话四个尚未发布的新测试引用。本候选先保存其完整当前正文并制作私有差额，保留全部并行输出。只有对方完成源码与 workflow 发布、当前原 workflow 与该候选 before 的完整字节相等、引用的全部源码存在 main 且共享索引为空时，才在协调后的发布窗口落入本 17 个引用。若原内容推进，按实际差额重新核对，不覆盖对方文件或提交未发布来源。

## 本批准确接线

- 两处原 push/PR 路径过滤器各加入七个真实生产文件：动态状态端口、中立选择器、composition、原 Drizzle adapter、原 SQL helper、Task-local 两目的 writer 和 `services/dynamicWorkflowRunner.ts`，合计 14 个引用。
- 两处原路径过滤器各加入 `packages/backend/tests/rfc370-task-host-dynamic-state.test.ts`；原平台 `bun test --isolate` 命令在已登记的 Node caller 测试后加入同一新测试，合计 3 个引用。
- 逆向删除这 17 个引用必须得到原 workflow 完整正文。所有原命令、分组、并行接线、断言、预算和 RFC-371 引用保持，不修改测试执行模式。

有限功能门仅核本差额和发布条件。它不代签对方源码或共享架构配套，也不将私有候选记成已发布 workflow。

## 托管执行验收

确切提交的主 CI 与原 Windows 默认完整运行分别达到成功终态后，逐项消费实际动态状态案例：Ubuntu SQLite/PG 各 26 例及一个全局合同共 53 例，Mac SQLite 26 例及一个全局合同共 27 例，Windows 同样 27 例，合计 107 个实际结果。原失败及重复 summary 记录保留，不能以标题清单、历史 19bf 总绿或此前 298 个已消费案例代签这些新结果。

当前全仓总绿门槛仍待修复后的同一提交验收。本后继没有本机 AW tests/typecheck/build/services/E2E，没有新增 census；生命周期设计门通过也只签设计，生产编码仍等待总绿。完整 H7/A-T7/A-G、十九 owner、三个实际 roots、各层 CS 独立 adapter 与 M0～M4 继续；AW 尚未部署 CS，RFC 未完成。
