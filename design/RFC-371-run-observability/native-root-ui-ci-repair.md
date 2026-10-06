# 原生 v3 详情的版本分支补正

精确提交 `bc7832985e194c321d5409ed5354ad0eea09ce9c` 的 CI `37399216340`
在前端类型检查发现 `ObservationNativeCapture` 把新增严格 root-pages-v3 证明当成
旧单根 pages-v2 读取 `final`、`finalProgress`。原功能作业失败日志保留。

本片包含两个原生 v3 的功能补正。前端同一组件按明确 contract 分支：旧 steps-v1 仍显示原扫描数量，旧 pages-v2
仍显示原 final ACK 或 finalProgress 的累计 sessions/steps。v3 保留实际完成状态、
观察时间、缺口与历史修订；其小型根引用没有累计扫描数量，扫描列显示双语未知。
不能把根数量、emission records、当前可见页或零拼成 sessions/steps。唯一 Token
账本、四桶、人民币估值、报告 EOF、生产 producer OFF 及全部原证明判据不变。

原前端回归及预算逐字保留，追加严格 schema 的 41 根 / 10,000,001 emission
引用回归，核对中文和英文未知、原 invocation，并拒绝借用 emission、零或 undefined。
本机只做目标 format/lint 与原官方静态产物核对；回归执行和类型检查交新确切 SHA CI。
原 backend Task 配套报错及静态作业状态另按各自来源处理，不纳入本片源码。
两个 RFC 和真实规模验收保持开放。

## 丢 ACK 重建的机器前缀

同提交 Ubuntu 8 分片的既有 RFC-349 跨 provider 守卫指出新增 root completion
使用裸 LIKE 读取固定机器前缀。该查询不是用户搜索；SQLite LIKE 忽略 ASCII 大小写，
因此一个较新的 `Native-completion:` 诊断记录可能遮住原小写完成回执。
改用既有中立持久模式的 `substr(eventId,1,prefix.length) = prefix`，两个 provider
精确区分原机器标记，不新增守卫豁免、扫描规则、case-insensitive 查找或读取上限。
原真实子进程丢 ACK / 重建回归追加实际 source/emission 插入，验证新大写前缀记录
不能取代原完整 seal，原 810 条、四桶、¥0.076140、严格 qualification 和 120000ms
预算全部保持。原已通过 SOURCE3 及其材料保留；后继有限 SOURCE5 复核两个实际增量。
