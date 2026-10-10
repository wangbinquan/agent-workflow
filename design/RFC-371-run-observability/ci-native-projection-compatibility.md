# RFC-371 原生批量投影回归的 CI 兼容修复

精确 `86129c12f17a3e31ce0f9614af771edd9ae0e172` 的 [Windows CI 38030585328](https://github.com/wangbinquan/agent-workflow/actions/runs/38030585328) 正式 failure。原类型检查日志只列两项错误：新 fixture 的 `rows.toReversed()` 超出本仓目标库，原 fallback 测试用 `string[]` receiver 比较原标量 SQL 返回的 `unknown[]`，不符合 Bun matcher 的静态重载。其它三个工作区类型检查成功不代签整条 CI。主 CI 38030585360 尚未终态；已结束的 Ubuntu 5 分片另有两个物理连接关闭时机断言失败，macOS 9／Ubuntu 17 分片同指新增外部 SQLite 夹具漏登记。

反序故障继续返回原行的独立反序副本，使用 `[...rows].reverse()`；原逐个步骤 ID 的完整相等断言显式采用 `expect<unknown[]>`，保留原 receiver、原标量预言值及 `toEqual`，不转换或筛选任何 ID。两个晚期错误用例继续验证同一错误、全部已 ACK 前缀和读取器已经关闭；共享连接按原合同归还工厂复用，先断言物理关闭为 0，再关闭工厂并保留原物理关闭为 1 的断言。原实际 SQLite、603 个 part、201 个 step、四种 batch 故障、损坏 child、ACK／EOF、其它 matcher 与全部预算保持。

原 T19f 高水位只补 `helpers/rfc371NativeProjectionFixture.ts: 1`：唯一建库是 OpenCode 外部固定 SQLite 文件，复用已有 `real-file-database` 判据；原分类、待迁名单、全部旧行与预算不改。其准确行数由 339 到 340，在原完整 130 项账本中登记这一实际增长，并于紧邻普通提交退役一次许可。原理由与生产来源摘要保留，内容摘要沿原纯 JSON 合同更新。

原 Windows push／PR 过滤各登记批量 helper、原夹具和两个新回归；同一既有平台测试命令增加这两份用例。原过滤、命令、其它用例和预算全部保留，删除这十个新增引用即可逆向恢复完整旧 workflow。

生产 reader／投影 helper、原 SQL、事务发布和原生成规则均不变，无新 census；未运行本机 AW 测试、类型检查、构建或新服务。限定独立功能复核、精确七路径发布及单路径许可退役、新提交的完整 hosted CI 分别验收，旧失败保留，不通过修改目标库、删断言或跳过测试处理。

首次生成与新范围仍约 14 秒，正常缓存重入的 193 ms 只是一次实际路径。全类型真实验收、CS 发布／部署及两个 RFC 的其它关闭条件继续，见[剩余工作](./remaining-work.md)；本修复不将整体目标记为完成。
