# RFC-575 技术设计

记号：`S/` = `packages/backend/src/`，`P/` = `S/platform/`。落在 platform（接收三个文件）与它们的读者（只改 import）。另改架构报告的归属表、
`architecture/counts.json`、公共内核清单与它的债务账本、public 类型偏差账本里的四条说明符、钉着旧路径的判据与指针，新增一个 RFC-575 用例。数字取
HEAD `9083e8331`。不改行为。

## 1. 文件去向

| 原位置             | 新位置                          | 说明                                                                                                         |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `S/util/errors.ts` | `P/errors/domainErrors.ts`      | `DomainError` 一族与它的 HTTP 映射；与 `publicError.ts`（将来唯一的 public 错误映射）同目录，W9-C 在这里改造 |
| `S/util/hash.ts`   | `P/contracts/hash.ts`           | 与业务无关的摘要原语（只取 `node:crypto`），与同目录的 `semver`、`monotonicNow` 同类                         |
| `S/util/log.ts`    | `P/logging/logger.ts`（新目录） | 结构化日志；design 目标表里的“platform 观测”，目录名见 §5 第 2 条                                            |

`hash.ts`、`logger.ts` 内容原样；`domainErrors.ts` 只有取日志的那一行（`./log` → `../logging/logger`）随新位置重算，行数不变（公共内核债务
账本里指向它的行号锚点因此不动）。三个文件都没有按自身位置算的路径（`import.meta` / `__dirname`）。

## 2. 读者改指

与 RFC-571～RFC-574 同一个解析器式的改写：约 680 个生产文件、约 370 个用例与测试助手。读者里 `auth/`、`util/` 余下的 git / 凭据 / 安全路径
文件、身份认证与任务授权一类的文件只动 import 那一行。改写也会改到用例里当夹具用的源码字符串，对应的期望值随改（§3）。

## 3. 门、用例与文档

- 架构报告的 `LEGACY_BACKEND_FILE_OWNERS` 删去三行；`counts.json` 的 `legacy-horizontal-files` 上限 101 → 98。
- `PUBLIC_SURFACE_DEBT` 里四条 `forbidden type import @/util/log#Logger` 的说明符随改（条数与 `public-surface-deviations` 不变）。
- 公共内核清单与债务账本里指向三个文件的路径；`scripts/rfc359-p0-mutations.ts` 的保护文件清单里的一条。
- 钉着旧路径的判据随改：各 RFC 边界用例里的闭集依赖清单（`import util/errors: …` 一类的描述、`'@/util/hash'` 一类的放行项、按解析路径比对的
  `'util/hash'`）、`rfc310` 的 development-automation domain 白名单、`rfc427` 的入口白名单、`rfc377` 的 `util/git` 叶子锁（三个原语的新位置按精确
  说明符放行）、RFC-572～RFC-574 用例里登记的依赖、读源码的用例（`log.test`、`rfc359-w42`）。
- 源码注释、e2e / 前端 / shared 里指向三个文件的现状指针改成新路径；`docs/`、`design/` 里的事故记录不改。
- 新增 `tests/rfc575-util-errors-hash-log-into-platform-boundary.test.ts`，登记 guard-manifest：① 三个旧路径不存在，`src` / `tests` / `scripts` 的
  全部说明符不再解析到它们（带负对照）；② 新位置的三个文件只取登记过的依赖，不取模块；③ 导出的名字与搬迁前相同；④ `util/` 余下的文件只剩
  10 个且都在 git / 凭据 / 文件信任 / Windows ACL / OIDC / 脱敏 / 安全路径一族里（清单钉住，下一个移出 `util/` 的 RFC 需同步）。

## 4. 检索

按 RFC-572～RFC-574 记进 `docs/dev-gotchas.md` 的清单：路径文本（含 `e2e/`、前端、shared、脚本、工作流与账本）、分段拼出的路径、正则写的
路径、按 `@/util/` 前缀放行或拒绝的判据、`import.meta` 相对路径。工作流与 dependency-cruiser 配置都不涉及这三个文件；`no-util-to-upper` 只管
`util/` 取什么，不受影响；分层规则（`moduleLayerViolations`）按说明符认 hono / drizzle / fs 与 `db` 一类目标，`@/util/` 与 `@/platform/` 一视同仁。

集中验证又查出三类这份清单之外的钉法（都已随改，教训补进 `docs/dev-gotchas.md`）：

- **按解析路径的泛化放行**：`rfc448` 用 `target.startsWith('util/')` 放行探测用例取整个 `util/`（没有 `@/` 前缀，前面按 `@/util/` 搜的模式找不到）；
  改成点名两个原语。`rfc437` 的 `util\/[A-Za-z]+` 同类（那一条在 RFC-574 的 CI 里先红，见 RFC-574 plan）。
- **源码摘要锁**：`tests/fixtures/rfc395-serialized-insert-source-locks.json` 钉着三个已审读的串行化写入文件（及其调用方）的 SHA-256，任何编辑都让
  “已审读”失效、那几处写入落回债务账本。三个文件只改了 import 那一行，摘要随之更新。
- **按目录名判的规则**：`rfc371` 的 `/observ/`（§5 第 2 条）。

## 5. 取舍（可推翻）

1. **errors 进 `platform/errors/domainErrors.ts`，不在本 RFC 做 W9-C**：位置与 design 目标一致；去 HTTP status 是错误合同的改造，另立。
2. **log 进新目录 `platform/logging/`，不叫 `observability/`**：design 目标表写的是“platform 观测”；现有目录里没有合适的（`operations/` 是
   API 操作描述，`health/` 是体检）。起初用的是 `platform/observability/`，集中验证里 `rfc371-v2-observation-boundaries` 红了：RFC-371 把“观测”
   （运行观测）收在 run-observability 模块，platform 下路径匹配 `/observ/` 的只许是冻结的历史生成器。日志不是那种观测，改名 `logging/`。文件名
   用 `logger.ts`，比 `log.ts` 说得清楚。
3. **hash 进 `platform/contracts/`**：与同目录的其他无依赖原语同类。
4. **三个一起搬**：它们的读者几乎覆盖全部后端，分三次搬，每次都要跑近乎全量的验证；一起搬只跑一次。

## 6. 失败模式

- **有人在旧路径重建文件或重新取它**：RFC-575 用例 ① 红。
- **漏改某个钉着旧路径的判据**：本地全量运行与 CI 的全量运行红（该判据要么找不到文件，要么闭集清单对不上）。
- **`util/` 又多出一个文件，或余下的文件被挪走而清单没跟上**：用例 ④ 红。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：三个基础原语进 platform 的对应目录。**C11**：不改 public 的形状（四条偏差的说明符随改，条数不变）。**C12**：RFC-575 用例 ① 覆盖 `src` /
  `tests` / `scripts` 的全部说明符；② ③ 只读三个新文件；④ 只读 `util/` 目录。**C13**：`legacy-horizontal-files` 101 → 98，其余计数不升。
- **本 RFC 承担的演进**：W9-D 里 `util/` 的第五批；之后 `util/` 只剩安全相邻的一族。
- **留下的债**：W9-C 的错误合同改造；`util/` 余 10 个。
