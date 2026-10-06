# RFC-371 完整报告读取与启动复验

## 2026-10-06 当前结果

完整报告暖读实现已通过有限独立功能门：23 份候选与 7 份只读控制首末摘要稳定，V1 的首屏游标测试问题已修正，V2 PASS。对应原设计见 [完整报告读取资格复用](./complete-report-read-qualification.md)。本节记录待发布候选，不以静态功能门或本机页面代表新提交 CI 通过。

原四张派生报告关系由 SQLite／PostgreSQL 同事务原生触发器标记发布后的改变；新增关系仅保存不透明修订身份，没有第二份 Token 或金额账本。冷读取和进程重启仍执行完整物理校验。暖读取仅在实际当前父内容与修订均未变化时复用该校验；每次读取仍查询当前 Actor、完整 Task 人口和费用可见性。派生行删除、同计数内容改写、跨父移动、回滚与跨发布写入均有真实双 provider 回归。显式刷新重新构建全部原来源，不通过恢复旧行绕过重建。

SQLite 仅在原链尾追加 0241；PostgreSQL 由原 V2 helper 追加 0017 的完整 KEEP 关系与有限 function／trigger 投影，旧 221 张表和所有历史迁移字节保持。实际逻辑目标在 copy 全部完成后的原 finalizeSchema 事务安装触发器，不改变导入行或摘要。测试已编写，未在本机运行 AW tests／typecheck／build／压测；新确切提交的 hosted CI 与原 100K Task／10M usage、100 次样本和 500ms P95 验收继续。

## 原数据库启动与正式页面

用户明确批准用原数据库、原 7456 端口复现后端启动。原库事先保留一致性备份；正常启动运行已追加迁移，当前 dbVersion=241，没有重置、恢复或替换用户数据。

原 bun dev 的一个热更新代次在 2026-10-06T04:48:23Z 退出，实际日志为 `undefined is not an object (evaluating 'input.effects.config')`，对应运行管理新增 effects 接线。当时后端子进程已退出，Vite 与 dev-auth 仍运行。该运行管理接线由并行 RFC-370 修正，不作为本会话新增修复提交。随后原 bun dev 于 04:53:55Z 监听 7456，并在下一次热更新于 04:58:16Z 再次成功监听；前端 localhost:5174 返回 200。

使用已获授权的本机 dev-admin 原页面复验：总览已显示 8 个任务、14 次运行时执行、已记录 123238 Token（非缓存输入96095、缓存读取21120、缓存写入0、输出6023），已记录人民币估值 ¥0.16583。原 13／14 次调用覆盖、8／13 条已定价及不完整标记保持，未知记录没有被补零。实际柱状趋势有 123238 数字与四桶明细。此次启动与页面来自共享工作树，包含并行未提交输出，不能宣称整个服务为某个干净提交的部署。

原退出日志、备份、后继启动日志和页面截图均保留于本机验收原件；不把先前显示“加载中”的瞬时页面当成功证据。

## 尚未关闭

本补充不代表同组 self-total 选择／工作区的原规模超时已修复。CS 的原 52c8eb74 两个规模作业均达到原四小时预算，其失败与资源原文保持。开发 native v2 消费者、默认 producer、CLI／算力自测归因和 CS→AW 实际托管联动仍须完成；既有正式页面矩阵、确切 CI 与本机部署分别验收，两个 RFC 保持 In Progress。

## 2026-10-06 报告生成到完成的正常状态变化

45c9cb462b64edef611a2c20e3208e0f6db0fa62 的正式 Playwright Ubuntu shard2在两条原页面用例准备数据时收到状态GET的HTTP425：原测试辅助函数严格检查response.ok，没有延长60s等待、改重试、跳过用例或将错误转成成功。独立类型修复5116ef20b14c501a10ea3385f302fa15fe3ca289已上库，其新CI单独验收。

原qualified reader先收到store.get()的building值，再从一个新的原snapshot读取当前值。如果该报告在两次读取之间正常发布，之前的“current或supplied任一已发布”判断就会要求两份不同阶段的整对象相同，产生425。改为只有supplied已有已发布seal时才要求不可变对象一致。当前snapshot仍完整执行原物理qualification、原Task人口与费用可见性；building调用者也不能绕过当前输出的真实变化。这个修复不改变reportId/owner/requestKey/actorScope/request、四桶、CNY、EOF或统计人口。

新增同一真实provider数据库的回归：先获得原building，正常落盘发布全部关系，再以该building调用原qualified reader；随后改写已发布派生行，仍须拒绝。两个provider执行由确切提交GitHub Actions负责。保留所有原用例与HTTP成功断言，不在测试helper吞掉425，不把所有425称作正常等待。本机仅自有format/lint、纯AST/字节/JSON及一次原静态清单生成，完整CI、原规模及两RFC残余资格继续。
