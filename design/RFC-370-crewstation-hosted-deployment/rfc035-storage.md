# RFC-370：RFC-035 对象存储接入

状态：接入设计；AW adapter 与联合部署尚未完成。阶段 A → A-G → B／M0～M4 的顺序保持。

## 1. 已有平台合同与分工

2026-10-01 只读核对 CS `35cf5a475979cbf74fb324230173f55b4e1a0a75` 的 [integration-contract](https://raw.githubusercontent.com/wangbinquan/CrewStation/35cf5a475979cbf74fb324230173f55b4e1a0a75/proposal/rfc/RFC-035-service-persistent-volumes/integration-contract.md)、[acceptance](https://raw.githubusercontent.com/wangbinquan/CrewStation/35cf5a475979cbf74fb324230173f55b4e1a0a75/proposal/rfc/RFC-035-service-persistent-volumes/acceptance.md) 和 [serviceStorageClient](https://raw.githubusercontent.com/wangbinquan/CrewStation/35cf5a475979cbf74fb324230173f55b4e1a0a75/packages/api-client/serviceStorageClient.ts)。这三个路径没有工作树修改。平台已记录对象上传、任务输入、暂停留卷、finalize 归档后回收及卷后下载的真实验收；这些记录不替代 AW 自身的联合部署证明。

| 内容 | AW／CS 责任 |
| --- | --- |
| 配置、工作流、任务状态、执行收据、requestKey、cursor、内容引用 | AW PG 元数据；保留 AW 的业务状态机及世代判断 |
| skills／plugins 不可变版本、附件、归档日志／结果 | CS 对象空间；域内 binding 和保留决定属于原 AW owner |
| 仓库、worktree、iso、Git、原生会话工作区 | persistent business task 的 `/work` PVC；环节 Pod 顺序挂载 |
| 服务本地内容 | 可重建缓存；服务模板零 PVC，不能作为唯一副本 |

原 `hosted_content_objects/chunks` 字节库方案退役。无需新增 CS SQL provider；现 PG provider 继续承载 AW 数据。

## 2. owner 内独立 adapter

每个模块在自己的 `infrastructure/crewstation/` 实现 reader／writer／lifecycle／recovery 端口。公共客户端只处理字节和平台请求，AW 的版本选择、操作阶段、锁、工作流和业务终态不移入全局 CS 服务。standalone local adapter 保留。

SDK `createServiceStorageClient({baseUrl: CS_PLATFORM_API_URL})` 已拼接 `/v3/objects`。直接 HTTP 客户端才以含该后缀的 `CS_OBJECTS_URL` 为对象资源根，不能重复拼接。调用使用服务域身份。上传传 `ReadableStream`／Content-Length，下载消费流式 Response 并保留 Range／取消；PUT 没有自动重试。

## 3. 发布与恢复的必需合同

B-T0 冻结当期 owner 的 binding／效果日志 schema 后再实现：

1. 效果日志先保存稳定 requestKey、operationId、目标域版本及内容摘要；reserve 后保存返回的 uploadId。沿同一上传执行一次 PUT、commit 并查询原 uploadId。未知写结果保持未决状态，不换键重新上传。
2. 分别保存 AW canonical tree `contentHash` 与 CS 对象归档字节 `sha256`，不能互换。文件清单、二进制及 mode 位保留，更新生成新的不可变 objectId。
3. 对象 ready 后完成 material-version 或 application pin，再发布 AW 可消费引用。跨 CS 与 AW 没有单一数据库事务；上传、引用、AW 提交、回滚及清理失败均沿持久效果日志恢复。引用未完成不能标成已发布。
4. 删除与旧版本保留按原 owner 决定，冻结 pin 身份、解绑顺序、未决上传及补偿语义；对象空间删除 API 不替代 AW 的业务删除状态机。

上述是 CS adapter 的实现要求，当前阶段 A 的文件端口重构没有创建这些托管表，也没有接通对象 API。

## 4. 分阶段部署

M0 先完成必要 H1／H2／H6，以新安装登录、编辑／保存和跨副本／Pod 重建回读证明服务可用。仅对当期开放路径验收容量、Range／取消、丢回执及引用／清理恢复；全量旧内容迁移和全部 runtime 仍按 M2～M4 收编。

M1 新任务输入使用 `inputObjects[{objectId,sha256,path}]`，由 CS 与任务创建一起持久 pin 和物化。它不提供活跃卷通用写入；任务创建后的动态写入继续走 SC 所选 command 效果合同并单独验收。

人工等待／可恢复失败使用 pause 或显式重试，保留原卷。只有业务决定最终成功／失败／取消时，封存分页 archive plan，再用固定键 finalize。AW 分别显示业务 outcome、归档状态与 storageReclaimed；终态业务结果不能冒称物理回收已完成。检查 `capabilities.storage` 后才开放依赖该合同的功能。

长期事件由 AW 显式保存为带 cursor 范围与摘要的 NDJSON 对象并 pin，最终清单引用。410／gap 显示历史不完整；final receipt 不等于完整日志。对象字节恢复沿平台备份 runbook；AW PG 和活跃任务卷分别验收。

B3 的剩余项是 AW 实际对象消费、持久引用／恢复、当期容量和工作区输入／动态写入对拍。平台已有合同不等于 B3 或 M0 已完成。
