# RFC-371 原生用量 Worker 的当前环境绑定

本片修复正式 CI 暴露的原生用量读取缺失，属于已批准 RFC-371 的功能修复。完整 Windows run `38184373106`、job `114603452397` 在确切 `d7de7fdd46e46ab3784820f04dc114bfcc236d27` 上为 failure：原平台 1,396 pass、3 skip、6 fail。六项真实失败均在原 Worker 用例；日志末尾重复列表不算新用例。旧七项回归、独立大整数四桶、人民币部分估值、全部集合与真实 EOF、60 秒预算均保持。

## 已定位的差异与尚待证实的原因

原无缓存 Worker 的独立预言应为 input `9007199254741028`、cacheRead `88`、cacheWrite `109`、output `71`、total `9007199254741296`，实际只有应用账本的 `3/9/15/21`、total `48`。晚写、删除、重归属与读取期间外部更新均没有历史原生行；热复用实际 `cachedRoots=0/cachedPages=0/sourceRoots=1/sourcePages=0`。主线程原生版本观察器已提供 proof，Worker 侧原生 open 没有给出页。

原夹具在当前进程中将 `process.env.OPENCODE_DB` 指向真实独立 WAL 库，原 Task 查询使用已写入的 `node_runs.opencodeSessionId='root'`。平台主线程观察器读取当前 `process.env`，而 `observationReportWorkerHost.ts` 使用 `new Worker(entry)` 的默认环境。Bun 1.3.13 随仓声明 `node_modules/.bun/bun-types@1.3.13/node_modules/bun-types/bun.d.ts:410-416` 明确支持显式 `WorkerOptions.env`，类型为字符串记录或 `SHARE_ENV`。本片以创建时的当前完整原环境消除默认 Worker 初始化环境差异；这是否解决本次 Windows 故障仍由后继真实 CI 判定，不预先宣称已修好。

## 最小生产改动

只修改平台既有 `runOriginalObservationWorker` 创建点：同步枚举当前 `process.env`，保留全部已定义字符串值，形成独立普通记录，再传给同一原 `Worker(entry, { env: environment })`。保留 HOME、XDG、OPENCODE_DB 及所有原环境字段的现值；缺省字段继续缺省，不注入默认数据库、模型、费率或路径。环境只在创建时复制，不使用 `SHARE_ENV`；创建后的父进程变化留给后续新 Worker。

不扩展 IPC/public/provider 合同，不新增配置开关、租户 store、模拟原生源或回退到主线程运算。三个原报告/原生历史入口继续经过同一个创建点，原应用快照、max=1 PG reader 释放顺序、cancel、pending IO、finally close、数值投影和缓存失效规则全部保持。只改既有平台宿主层，符合 RFC-294 的原装配边界。

## 原回归与新增真实切换判据

原七项实际 Worker 案例全文保留。在原双 provider 套件内新增一项：同一应用数据库和同一服务依次读取两个真实原生 WAL 库，二者都含相同 root ID，第一库含 7 个已完成 step，第二库含 3 个。在两个报告之间只改变当前 `OPENCODE_DB`，独立核对第一库的原大整数四桶，以及第二库加原两条应用记录后的 input `9007199254741006`、cacheRead `44`、cacheWrite `57`、output `43`、total `9007199254741150`；人民币已知金额仍为 `0.00015`，第二库 7 条成本记录中仍只有原 2 条已定价。切换必须走原生源读取，不能复用第一库的旧页；第二库随后的实际热报告必须逐集合等于其冷报告并实际命中缓存。所有源和服务按原 stop/close 恢复，不改变其他套件环境或用例预算。

## 验收顺序与边界

先有限功能设计检视，再实现并做源码功能检视、必要原架构配套和精确路径发布。本机仅限定格式/lint与纯静态保持核对，不运行 AW test/typecheck/build/E2E 或新测试服务。原 CI 失败及原预言保留，后继确切 SHA 的完整主 CI、默认完整 Windows 和双 provider 原案例均要实际通过。

本片只解决原生读取链路，不签性能达标。已测热复用约 11 秒的缺口保持开放；后续先实测主线程分批写入和发布耗时，再实现已批准的完整计算复用。切换周期加速必须保持全人口、四桶、已知人民币金额和全部缺口，不用截断、抽样或旧报告冒充新周期结果。
