# RFC-370 执行接口 CI 夹具与源码定位修复

本片只修三份测试，生产执行机制、应用端口、Windows workflow 和原预算保持。完整 selected 材料／取证／生命周期／执行／回执组合及装配根仍未完成；A-T5、A-G、独立 CS adapters、M0 首次部署和 M1～M4 继续开放。

## 原 CI 证据

`b3dbcdda9453cf545f07dc80684b52bce4974f4a` 的主 CI `37270989081` 正式 cancelled（50 jobs：25 success／7 failure／18 cancelled）；Windows `37270989104` 正式 failure。Windows platform 272 pass／3 skip／0 fail、shared 2295 pass／0 fail，只代表这些测试通过，不能替代整套 workflow。

可归属问题是新执行夹具的 readonly cmd 类型不符合旧 AgentSpawnPlan 注解、S-15 的 child-unkillable 与 RFC-108 的 PID／binary 回执仍定位旧 runner，以及 macOS direct 回执拒绝用例误要求拒绝后也必须零输出。原 RFC-371 native pages revision 和 nativeUsageReconciliationVerification 类型失败分别留证，本片不改并行实现或其测试。

## 修复与原机制

- 冻结材料夹具保留原数组、对象与 identity，只补类型断言；不修改生产类型。
- S-15 保留原 child-unkillable 数量判据、Promise.race、cancel 和 unreaped 判据，跟随实际 native diagnostic，并补 runner 的两处消费检查。
- RFC-108 保留原 PID／spawnBinaryPath 字段判据，跟随 actual opaque receipt → native projection，并检查原 durable 写入与旧 fallback 两条真实链。
- Direct target 在原 owner callback 之前已经存在。原回执等待期间没有 output pump；拒绝触发 abort 后，原 bounded drain 可以排空已缓冲的 stdout。因此将原零输出断言移到拒绝前，保留 aborted、started 与未读取 stdin 的原断言，补 callback 只在拒绝后发生、pumpError 为空、每行仅为实际 buffered 输出、raw stdout 与消费行完整一致。没有更改原 native 算法，也没有改预算来规避失败。

## 验证边界

12 项执行用例仍完整存在；除上述一个错误的新断言窗口外，其余 11 项在类型擦除后的整项 AST 相等，五项真实 native 用例与原预算均保留。纯 AST／字节证明核对实际消费链和七项生产／workflow 控制字节。有限独立功能门与新 exact-SHA hosted CI 分别记录；旧 FAIL／cancelled 不替换。

本机仅做 owned 格式／lint 与纯 AST／字节检查，没有 AW tests、typecheck、build 或服务。生产语料和 canonical 不变，不重复 census。本片不关闭 RFC，也不宣称 AW 已部署到 CS。
