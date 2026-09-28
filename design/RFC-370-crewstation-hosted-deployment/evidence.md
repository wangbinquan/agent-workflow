# RFC-370 源码证据

本页是2026-09-28的源码快照，不是运行验收或对历史记忆的引用。

AW根目录：`/Users/wangbinquan/dev/proj/agent-workflow`；SHA `a53425b87bc6fa124d74829c278f52059ca04c93`。

CS根目录：`/Users/wangbinquan/dev/proj/CrewStation`；SHA `ae95d2e88e9337899955ffdf38ad49a0dc6c1928`。CS共享树存在console/e2e在制内容，不纳入本表。所有下列源码均逐字核对与各自固定提交一致。

| 仓库 | 源码锚点                                                                                                                                                                                                    | 本稿使用的事实                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| AW   | [packages/backend/src/platform/persistence/databaseProviderRuntime.ts:237](../../packages/backend/src/platform/persistence/databaseProviderRuntime.ts#L237)                                                 | 已有provider生命周期，不增加第三个数据库实现                             |
| AW   | [packages/backend/src/auth/session.ts:82](../../packages/backend/src/auth/session.ts#L82)                                                                                                                   | 当前HTTP入口按Bearer解析，不能直接吃CS明文用户头                         |
| AW   | [packages/backend/src/ws/server.ts:176](../../packages/backend/src/ws/server.ts#L176)                                                                                                                       | WS有独立接线与鉴权，需要同步适配                                         |
| AW   | [packages/backend/src/services/runtime/types.ts:722](../../packages/backend/src/services/runtime/types.ts#L722)                                                                                             | 现driver负责parseEvent/buildSpawn/session/inventory，不是远程调度器      |
| AW   | [packages/backend/src/services/execution/agentProcess.ts:32](../../packages/backend/src/services/execution/agentProcess.ts#L32)                                                                             | 进程请求携带cmd/cwd/env及PID收据，不能以CS ID伪装PID                     |
| AW   | [packages/backend/src/util/paths.ts:12](../../packages/backend/src/util/paths.ts#L12)                                                                                                                       | 技能/插件/工作区/归档等依赖本地home，PG不自动消除此依赖                  |
| AW   | [packages/backend/src/modules/task-execution/application/ports/workspaceLaunch.ts:35](../../packages/backend/src/modules/task-execution/application/ports/workspaceLaunch.ts#L35)                           | 复用既有Task/SC文件读取合同                                              |
| AW   | [packages/backend/src/modules/integration/infrastructure/verifiedWebhookDeliveryPersistence.ts:29](../../packages/backend/src/modules/integration/infrastructure/verifiedWebhookDeliveryPersistence.ts#L29) | 现受理将dedupe/MR控制/effect以中立事务持久化                             |
| AW   | [packages/backend/src/modules/integration/public/events.ts:257](../../packages/backend/src/modules/integration/public/events.ts#L257)                                                                       | 现归一化产生business和compatibility观测，继续复用                        |
| AW   | [packages/backend/src/services/webhook/githubAdapter.ts:243](../../packages/backend/src/services/webhook/githubAdapter.ts#L243)                                                                             | GitHub归一化依赖事件头；CS信封不能直接当原始webhook                      |
| AW   | [packages/backend/src/services/webhook/gitlabAdapter.ts:186](../../packages/backend/src/services/webhook/gitlabAdapter.ts#L186)                                                                             | GitLab归一化消费object_kind与事件UUID                                    |
| CS   | [packages/contracts/convention.ts:5](../../../CrewStation/packages/contracts/convention.ts#L5)                                                                                                              | 平台身份/来源头、环境变量与JWT约定                                       |
| CS   | [packages/contracts/manifest/serviceSpec.ts:9](../../../CrewStation/packages/contracts/manifest/serviceSpec.ts#L9)                                                                                          | 服务规格无service持久卷字段，不假定挂载home                              |
| CS   | [packages/contracts/api/business/requests.ts:18](../../../CrewStation/packages/contracts/api/business/requests.ts#L18)                                                                                      | 原生agent/command严格DTO；有cwd/materialId/requestKey/fence              |
| CS   | [packages/contracts/api/business/materials.ts:11](../../../CrewStation/packages/contracts/api/business/materials.ts#L11)                                                                                    | 支持systemPrompt/skills/mcp/env/subagents；没有通用plugins/extraArgs字段 |
| CS   | [packages/contracts/api/business/capabilities.ts:5](../../../CrewStation/packages/contracts/api/business/capabilities.ts#L5)                                                                                | 能力布尔/usage/resume不等于AW完整inventory合同                           |
| CS   | [packages/contracts/api/business/files.ts:4](../../../CrewStation/packages/contracts/api/business/files.ts#L4)                                                                                              | 分块文件读取需version，不能假定文件写API                                 |
| CS   | [packages/contracts/api/business/events.ts:19](../../../CrewStation/packages/contracts/api/business/events.ts#L19)                                                                                          | 执行流有sourceEventId/cursor/result/gap等；与业务事件信封不同            |
| CS   | [packages/contracts/api/business/executionValues.ts:5](../../../CrewStation/packages/contracts/api/business/executionValues.ts#L5)                                                                          | 材料、输出、分页、保留和lease均有明确上限                                |
| CS   | [packages/contracts/api/business/control.ts:5](../../../CrewStation/packages/contracts/api/business/control.ts#L5)                                                                                          | epoch/leaseId/instanceId以及claim/renew/activate/交接合同                |
| CS   | [packages/contracts/api/business/recovery.ts:11](../../../CrewStation/packages/contracts/api/business/recovery.ts#L11)                                                                                      | 五类恢复绑定generation/materialDigest/volume/session/attempt             |
| CS   | [packages/contracts/events/delivery.ts:5](../../../CrewStation/packages/contracts/events/delivery.ts#L5)                                                                                                    | 有eventId/deliveryId/source/payload，没有原HTTP headers或签名字节        |
| CS   | [modules/business-task/http/executionRoutes.ts:15](../../../CrewStation/modules/business-task/http/executionRoutes.ts#L15)                                                                                  | v3实际HTTP路由，包含能力、文件、材料、执行和control                      |
| CS   | [templates/business-execution-v3/src/control.ts:7](../../../CrewStation/templates/business-execution-v3/src/control.ts#L7)                                                                                  | 实例竞争租约，preview不能以槽名自授执行权                                |
| CS   | [integrations/github-event-producer/src/github/eventType.ts:7](../../../CrewStation/integrations/github-event-producer/src/github/eventType.ts#L7)                                                          | RFC033 GitHub类型封闭集合；需与AW归一化穷尽对拍                          |
| CS   | [packages/contracts/manifest/manifest.ts:27](../../../CrewStation/packages/contracts/manifest/manifest.ts#L27)                                                                                              | tasks可省略；M0服务部署无需伪造已完成的任务能力                          |
| CS   | [packages/contracts/manifest/tasks.ts:49](../../../CrewStation/packages/contracts/manifest/tasks.ts#L49)                                                                                                    | 恢复能力可选；fenced执行必须声明任务合同版本，随增量开放                 |

## 设计依赖与证据边界

- AW RFC-294是目标结构，RFC-359/363/365/368/369已落地部分以当前源码为准；本稿不把旧总纲中的过期状态当现在的实现状态。
- CS RFC-027/028/029与RFC-033分别是v3执行／运行镜像／恢复／代码托管事件的设计依据；本次只读合同，不重做CS本机部署验收。
- CS RFC-033已有本机producer→cs-events→持久消费者证据，但这不是aw完成事件接入的证据。
- B1～B4明确区分“DTO未表达完整能力”“需要验证”“已确认缺失的接口”，不能从目录名或示例能跑推断aw全能力可用。
- 本稿无外部SDK／第三方版本结论，实施锁定依赖版本后再校验各自官方协议。
