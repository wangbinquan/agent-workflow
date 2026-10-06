# RFC-370 自定义观察器正式 CI 修复

2026-10-06，有限 CI 修复设计。`ecf503d0641b5750546b022efde5dcea5539514b` 的主 CI `37488310589` 尚未完整终态；正式 Typecheck 作业 `112354060506` 报告五项新增夹具类型错误。Windows `37488310616` 已正式 failure，平台用例作业 `112354058354` 的唯一失败是新纳入 Windows 的旧真实脚本用例在默认 5000ms 被测试 runner 中断。原失败及日志完整保留。

## 五处类型修正

`rfc370-custom-observer-program-family.test.ts` 的四处 `expect(selected.trace).toEqual(members)` 使用 `string[]` 实际值与 readonly 七成员预言。为四处 expect 显式指定 `readonly string[]`，不改数组、成员、调用、matcher 或断言。另一处故意抛错的 `get language()` 被推断为 void；显式声明 never，保持原 reads 自增及同一 throw。整份测试类型擦除后的 JavaScript 必须与前像逐字一致，所有原 expect、场景与预算不变。

## 首次 Windows 真实程序覆盖的整段预算

`rfc310-event-center.test.ts` 的 `a global custom source validates its real script, publishes exact events, polls on subscription, and dedupes storage` 包含四次串行真实 native 程序：显式 validate、publish 的原再 validate、订阅后的两次 observer scan。每次 program.timeoutMs 都是原 10000ms；整段使用 Bun 默认 5000ms，没有产品规定整段必须在 5 秒完成。首次新增 Windows 覆盖的正式日志显示整段 5006.81ms 中断并杀掉一个尚未收尾的程序，没有失败的业务断言。

仅为这一完整双 provider 集成用例显式设置 50000ms：四次原程序上限共 40000ms，加 10000ms 有限数据库／原生命周期收尾余量。不改变单次程序超时、生产源码、四次实际执行或任何原功能断言；不 skip、不重跑旧失败、不调宽 workflow job 或其它测试预算。该修改纠正整段预算小于一个原程序上限的问题；并不凭静态分析宣称已排除所有 Windows 运行原因。新确切 SHA 的正式用例结果和实际耗时仍需验收。

## 有限验证和交付边界

全部旧测试源码保留，仅上述五处 type 和一个用例第三参数有差额。纯 AST 证明 type-only 文件全份 JavaScript 相同，真实脚本用例完整 callback、程序与 all expect 原样；其它 test 调用与全文件其余代码不变。本机仅 owned format／lint、纯 AST／字节／JSON，不运行 AW tests／typecheck／build／services。

本片与 Doctor／boot 分层 CI 修复同批精确发布，但保留两个独立有限设计结论；不重审未改的观察器生产算法。独立实现门后由新 exact-SHA hosted CI 给出行为结论，matching 静态生成使用同一冻结源码人口一次，四原规则保持。完整 H7／A-T7／A-G、CS adapter、M0 首次部署和 M1～M4 继续，RFC 不记 Done。
