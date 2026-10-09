# RFC-370 CI：原源码注释投影的重复处理修复

精确 `13a58441962de23c306bbb0709d98fd40fad825d` 的主 CI `37998000621` 中，Mac 后端 shard 1 job `114048842978` 的原 `rfc347-identity-access-runtime.test.ts` 源码锁 case 在 `6608.86ms` 后触及默认 `5000ms` 预算；实际分片 `1732 pass / 3 skip / 1 fail`，原失败保留。主 CI 与完整 Windows 另有同一 frontend 搜索输入类型错误，其并行修复独立保留；这些部分通过不代签当前 SHA 总绿。

## 修复设计

原模块初始化已经完整遍历 `src` 的全部 `.ts` 文件，将原路径及完整原文固定在 `productionSources`。每次 `callPaths(needle)` 又对这个同一快照的每个文件调用相同 `stripComments`；失败 case 的六次查询因此重复进行六遍完整注释处理。

在原 `stripComments` 定义后，对同一 `productionSources` 只生成一次 `callSources`：逐项保留原路径，以原函数生成完全相同的字符串。`callPaths` 改为查询这份投影，原 includes、路径映射与排序保持。原目录遍历、源文件读取、原 productionSources、正则和 importPaths/raw source 使用保持，既有 case、matcher、完整人口及默认 5 秒预算全部保持；不改源码锁判据，不做新增审计或扩大检查范围。

投影只保存同一测试模块已有源码快照的注释处理结果；不缓存产品运行状态，不引入文件变更监听、筛选上限或跨进程持久化。测试内原快照没有写入路径，原 case 的字符串查询按相同函数输入输出计算；性能改善由新 exact-SHA hosted 原用例验收。

## 验证与发布边界

独立功能设计与实现门限定为本原测试及本文、STATE 新前缀，读取完整旧测试并验证精确逆变换：移除一次投影、还原原 callPaths 后必须逐字恢复完整旧测试。记录原全部 case 和断言的文本，确认排序、原 raw importPaths 和原两个注释正则完整保留。

仅做本候选格式与静态字节检查；不运行本机 AW tests、typecheck、build、E2E 或服务，不运行 TypeChecker 或新 census，不改生产、CI 命令、架构 metadata 或四个原 census 规则。精确三文件提交与远端整条主 CI、完整默认 Windows 分别验收。生命周期 L 的 69 项 SOURCE18-R2 保持、211 新 case 未签收；H7／A-G、独立 CS adapter、M0～M4 与 RFC 均继续开放，AW 未部署 CS。
