# 迁移可行性：AutoVPN 从自有服务器到 Cloudflare

评估日期 2026-11-12 / 13，基线 `release/2.2.4` @ `ca68f3f`。结论先行，证据在后。

---

## 0. 结论

**可以完全脱离自有服务器，但不能只靠 Workers。** 执行面必须落在 **Cloudflare Containers**（Workers Paid，$5/月，2026-04-13 GA）。

三句话版本：

1. **发布面已经 100% 在 Cloudflare 上**，现在就没有服务器依赖 —— 订阅产物是一个 761 字节、零 import、零 binding 的 module worker，跑在 Pages advanced mode；Pages 项目/域名/部署/DNS 全部走 REST API。
2. **执行面（抓取 + 测速 + 可用性）一行都进不了 Workers**：需要 spawn mihomo 与 curl、裸 TCP/TLS 连任意 host:port 且跳过证书校验、127.0.0.1 监听端口、96 MB APK 全量读入内存、GB 级下载。这不是"工作量问题"，是 Workers 运行时的四道硬墙（§3）。
3. **Containers 能承接，但没有静态出口 IP，也没有 uptime 保证**。这两条是唯一真正需要在动手前先做实验验证的外部风险（§5）。另有一条政策风险必须自己判断（§6）。

改造量：**约 32–46 人日**（22–31 人日改造 + 10–15 人日双跑/灰度/验收），单人日历 8–12 周，拆成 5 个阶段，每阶段可独立回滚（§7）。

**决策要点：这次迁移买不到"更便宜"，只买得到"没有单点"。** 云上常态成本约 $5/月，与一台 VPS 持平；但改造投入按任何日费率折算都远超 VPS 年租金。所以：

| 你的真实痛点 | 该不该迁 |
|---|---|
| 服务器掉线 / IP 被封 / 想让日跑不依赖某台机器 | **迁**（§7 的 5 阶段路线） |
| 想省钱 / 想少花时间运维 | **不迁**，只做 §7.3 的 C 方案（统一阈值 + 密钥收口） |
| 厂商风控要求固定源 IP 或国内登录地 | **只迁一部分**（§7.3 的 B 方案：extract 留最小 VPS，其余上云） |

---

## 1. 现状：这个服务到底依赖服务器的什么

从 `npm/autovpn-cli/src`（19,149 行 TS）与 `~/.auto-vpn` 实测读出。

### 1.1 流水线十个阶段

```
doctor → extract → dedupe → speedtest → availability → postprocess → render → obfuscate → deploy → verify
```

| 阶段 | 实际动作 | 宿主依赖 |
|---|---|---|
| extract | 官网 → APK（20–30 MB，上限 96 MB）→ 内存解 zip/dex/AXML/PKCS#7 → `/api/eversion` 取 key → 登录 → `/myapi/apinodelist` → 逐区域 `/api/evmess` | `child_process`（curl 兜底）、整包 `arrayBuffer()` 进内存、无上限墙钟 |
| dedupe | 纯函数，`Set` + base64url | 无 |
| speedtest | **每条 link 起一个 mihomo 子进程** + 两个 127.0.0.1 临时端口（mixed / controller），裸 `net`/`tls` 走 CONNECT 读最多 10 MB；`concurrency=20`，`max_download_candidates=0`（不限） | 本地端口、子进程、裸 socket |
| availability | 同样每条 link 一个 mihomo，经它访问 Gemini/ChatGPT/Claude，按 `<title>`/地区字样/挑战页判定 | 同上 |
| postprocess | GeoIP（ipwho.is → ipapi.co）加国旗国家码 | `node:dns` 反查 |
| render / obfuscate | 字符串模板替换 + 确定性关键字拆分（0.45 ms / 1 节点，2.1 ms / 200 节点，逐字节可复现） | 写文件 |
| deploy | `wrangler pages deploy <bundle> --project-name X --branch main`，失败按 403/407/429/451/503 与 block-page 文案切代理重试 | wrangler 子进程、185 MB managed tools |
| verify | GET pages.dev / 自定义域 / `?serect_key=`，比对 payload | 无 |

### 1.2 请求量级（实测/配置）

- 抓取：lap 模式 50 laps × 26–31 areas × 2 平台 × 4 品牌 ≈ **11,800 次 evmess/run**；本机 profile 写的是 `max_iterations = 10000`、`max_runtime_seconds = 0`，只靠 `daily-run.json` 的 `source_runtime_seconds = 900` 兜底。
- APK：冷缓存 ~100 MB 下载/run（4 品牌 × 2 平台共享一次指纹）。
- 测速：可达的 link 全部下 10 MB，20 并发 → 单阶段可产生 **GB 级**下载量。
- 一次真实 run 的漏斗（`20260710-151700/pipeline_report.json`，唯一一份完整报告）：**raw 248 → 去重 222 → 测速通过 6 → 可用性通过 1 → final 1**。这个损耗率很关键：测速/可用性阶段是全流程最贵的部分，而绝大多数节点会被淘汰 —— 迁移时优先保证这两个阶段的**保真度**，别为了适配平台而放松判定。
- **闸门口径不一致（迁移前必须澄清）**：三处各有一份阈值 —— `daily-run.sh` 的 `min_final_nodes` 默认 **50**（`>` 才部署）、profile 的 `min_final_links = 10`（被 `assertDeployMinimumFinalLinks()` 用作 `<` 即抛错，见 `orchestrator.ts:196/207`）、CLI 里还有一处 fallback 10。按上面 **final=1** 的实测，日跑必然"hold"且 deploy 阶段自身也会抛错。迁移到 Workflow 时必须先把这三个阈值统一成一个，否则"迁移后行为一致"这个验收条件本身无法定义。
- 时间尺度：一次正常 run 约 **15.5 分钟**（受 `source_runtime_seconds=900` 约束，5 个源理论上限 75 分钟）；脚本注释记录过一次无界 sweep 跑了 **10 小时** —— 这两个数字差 40 倍，迁移设计必须按"正常 run 在 15 分钟内、异常 run 要能被预算截断"来考虑，不能只看其中一个。
- 注意：`~/.auto-vpn/artifacts` 里最近 9 个 run 目录只有 `run.db`（`runs` 表为空、无 report），说明本机近期的运行都没有正常收尾 —— 迁移前应先在原环境把这条链路跑通，否则无法做迁移后的等价性对比。

### 1.3 状态

| 对象 | 体量（实测） | 形态 |
|---|---|---|
| `accounts.db` | 336 KB，631 账号（604 active），2,794 pool_events | SQLite + WAL，0600/0700，**明文密码** |
| `run.db` / run | **220 个里 215 个是空的 64 KB**；非空只有 5 个：217 KB / 229 KB / 389 KB ×2 / 940 KB | SQLite + WAL，**8 张用户表**（第 9 张是 `sqlite_sequence`），`BEGIN IMMEDIATE` |
| artifacts | 22 MB / 220 个 run | 目录树；"最新"按文件 mtime 排序（R2 只有 `uploaded` 上传时间，语义不等价，所以仍要一张显式索引表） |
| jobs | 5.5 MB / 35 个 | JSONL 追加 + 按字节 offset `tail` |
| managed tools | 185 MB | 运行期 `npm install` wrangler |
| profile.toml | 2.7 KB | **0644，明文 Cloudflare token** |

---

## 2. 已经在 Cloudflare 上、不需要迁的部分

这一半今天就没有服务器参与：

- **订阅产物**：`templates/vmess_node.js`，761 B，零 import、零 binding。读 `serect_key`，命中返回 `btoa(SUBSCRIPTION_PAYLOAD)`，否则返回 0–99 随机字节的 base64。Pages advanced mode 把它放在所有请求前。
- **发布调用**：`CloudflareHttpClient` 全走 `fetch` —— Pages 项目 CRUD、`deployment_configs` 克隆、自定义域、`/zones/<id>/dns_records` CNAME upsert、blocked-project（8000119）fallback 建新项目、share 项目的 `SUB` 环境变量改写。
- **share 项目**：第二个 Pages 项目，`deployment_configs` 由 API 克隆，`SUB` 每次指向最新订阅 URL。

账户实测（`/accounts/e743…`）：standard 计划，1 个 Free Website zone（`swimmingliu.online`），**已有** Workers 与 D1（`cloud-mail`），**没有** DO namespace、Queues；**R2 未开通**（API 返回 `Please enable R2 through the Cloudflare Dashboard`）。→ 迁移前要开 R2 与 Workers Paid。

---

## 3. 为什么 Workers-only 不可能：四道硬墙

每一条都是文档化限制，且与本项目具体代码点对撞，不是"理论上可能慢"。

| # | 限制 | 文档 | 项目里撞在哪 |
|---|---|---|---|
| 1 | `node:child_process` 是**空实现**（compat date ≥ 2026-03-17，可 import，调了什么都不做）；`node:sqlite` 同样是 non-functional stub | workers/runtime-apis/nodejs | `proxy-runtime.ts` spawn mihomo、`egress.ts:176` spawn curl、`managed-tools.ts` npm install wrangler、`run-store.ts` 的 `DatabaseSync` |
| 2 | 每 isolate **128 MB**（Free/Paid 相同，per-isolate 不可调） | workers/platform/limits | `credential-source.ts:1036` `MAX_APK_BYTES=96MB`，`apk-discovery.ts:89` `inflateRawSync` 整 dex 解压；本机同一解析器 32 MB APK 峰值 **244 MB RSS**，211 MB APK 423 MB |
| 3 | 每请求 **6 条**"等待响应头"的连接（收到头即不再计数，压的是建连窗口，不会退化为串行）；子请求 50（Free）/10,000（Paid，可调至 10M）；CPU 30 s 默认 / 5 min 上限 | 同上 | 单 run 11.8k evmess + 每节点 3–4 次 provider 探测，**子请求与 CPU 才是这里的真墙**；6 连接只影响吞吐 |
| 4 | `node:fs` 是 **memory-backed VFS**（`/tmp` 可写但**每请求独立、不持久**，写入计入 128 MB 内存）；不能监听端口；`connect()` 拒绝 localhost/私网 | workers/runtime-apis/nodejs、tcp-sockets | `run.db` / `accounts.db` 需要跨请求持久化；`127.0.0.1:<mixed-port>` 整个测速设计 |

补两条容易忽略的：

- **TLS 语义**：Workers 的 TLS **总是校验证书**，`rejectUnauthorized` / `ca` 不支持；`startTls({expectedServerHostname})` 在生产边缘被忽略（workerd #6903，未修）。
  - 独立实测（本次复核，非引用 agent 结论）：从 `20260710-151700/vpn_node_deduped.txt` 取 222 条中的前 20 条 `tls` 节点，用 IP 连接 + SNI 主机名做标准校验 → **8 条通过 / 8 条 hostname 不匹配 / 4 条握手失败**。整个池 222 条全是裸 IP，其中 195 条带独立 SNI（例：`add=107.148.242.186, sni=www.53605943.xyz`），mihomo 能测通这些节点**只因 profile 里 `skip-cert-verify: true`**。
  - 含义：Workers 原生路径会**静默丢掉约 40–60% 的节点**（比例随厂商轮换变化），不是"性能差一点"，而是产出直接少一半。Containers 不受影响（可以照旧跳过校验）。
- **端口**：`fetch()` 对**未被 Cloudflare 代理**的域名可以用任意端口（`allow_custom_ports`，2024-09-02 起默认）；对橙云域名只保留 **13 个**反代端口（HTTP 80/8080/8880/2052/2082/2086/2095，HTTPS 443/2053/2083/2087/2096/8443），20000 会被**静默忽略**（文档原文 "it will be ignored"）。本项目 4 个厂商域经 DoH 查全部解析到 `156.254.5.x` / `103.233.8x.x`（非 CF），所以这条恰好**不是**阻碍 —— 但这是运气，不是设计，厂商换 CDN 就会变。

---

## 4. 逐组件迁移映射

| 组件 | 目标原语 | 判定 | 关键改造 |
|---|---|---|---|
| extract | **Containers**（Node 22 + curl，镜像内置全部工具） | adapt | 去掉运行期 `npm install`；APK 保持内存解析（容器内没问题）；账号池与 run 状态外置 |
| speedtest | **Containers** + DO 管生命周期 | adapt | mihomo 原样保留（容器内 `spawn`、`mkdtemp`、`net.createServer(0)` 全部可用）；`enableInternet: true` 时非 HTTP 端口直连 |
| availability | **Containers**（同一个镜像，同一段代码） | adapt | 不要用 Browser Run：它没有代理、没有地区选择，且本项目可用性判定本来就是"经节点"而不是"开浏览器" |
| transform | Workers（纯 JS，内存内）+ R2 | **adapt（最轻）** | 只有两处：`geoip.ts` 的 `node:dns` `lookup` 换成 DoH over `fetch`（注意 `resolve()` 在 `acquireProviderSlot` 之外、`orchestrator` 用 `Promise.all` 扇出全部 link —— DoH 调用是**无界并发**，必须自己加信号量，且每次查询都计一个 subrequest）；`writeWorkerArtifacts()` 改成返回内存对象 + R2 put。整个阶段在 Workers 预算是三个数量级的富余 |
| deploy | Workers `fetch` → Pages **Direct Upload REST** | adapt | 五步：`upload-token` → `assets/check-missing` → `assets/upload?base64=true` → `assets/upsert-hashes` → `deployments`（multipart）。当前订阅 worker 是单文件零 import，**直接发 `_worker.js` 这个 file part 即可**，不必合成 `_worker.bundle`（只有带本地 import 才需要，且它是 FormData→Blob，不是 zip）；`manifest` 与 `branch:"main"` 必填。资产哈希是 `blake3(base64+ext)[:32]`，WebCrypto 没有 blake3，需内联 wasm 并用 wrangler 实际输出做 golden 对拍 |
| controlplane | Workers + Static Assets + DO + D1 + R2 + Access | adapt | 14 条路由逐条搬；SSE 改成 DO 内的环形缓冲 + Last-Event-ID 重放（R2 不能 append、不能按 mtime 排序）；`?token=` 必须废止；限流 Map 要按 `CF-Connecting-IP` 搬进 DO |
| state | DO SQLite（每 run 一个）/ D1（账号池 + run 索引）/ KV（指纹）/ R2（产物）/ Secrets | adapt | `node:sqlite` 是 stub，`run-store.ts` 734 行要换实现；`orchestrator.ts` 对 RunStore 的方法引用约 **99 处**，所以只能"换实现保方法名"，不能换接口；`transaction()` → `ctx.storage.transactionSync()`（现有回调都是同步的，可平滑替换）；`lease()` 的 SELECT-then-UPDATE 必须改成单写语句，但 **D1 文档对 `UPDATE … RETURNING` 是否返回行自相矛盾**（一处说写操作 `results` 为空），必须在目标库上实测；不稳则退化为 `lease_token` 唯一列 + 同一次 `batch()` 内 `SELECT` 校验；`importRecords()` 不能直接变静态 `batch()`（要串 `last_row_id` 自增序号），需触发器/CTE 或两阶段写 —— 现有 `BEGIN IMMEDIATE` 循环本身已是全有全无，迁移不是"补事务"而是"换事务语义"，且 D1 `batch()` 的回滚边界文档未明说，须实测 |
| schedule | Cron Trigger（只发射）+ Workflows/DO alarm（编排）+ Containers（执行）+ D1/R2 | adapt | `daily-run.sh` 的 200 行 bash → 一个 Workflow；`flock` → singleton DO 的 `transactionSync` 租约（仅 SQLite-backed DO；顺带补掉现存漏洞：`serve` 的 `run_already_active` 只是进程内存，CLI 根本没有跨进程锁）；Cron 只认 UTC，本机 04:15（Asia/Shanghai）= 20:15 UTC。**Workflows 的 `step.do` 默认 timeout 是 10 分钟/次尝试**，`waitForRun` 要等 15–75 分钟的 run 必须显式调大（如 90 min），且轮询逻辑要幂等（重试会重跑 step）。Workflows 现已支持在 binding 上直接写 `schedules`（每账号最多 100 条 cron），可以省掉单独的发射器 |

**没有一个组件判 blocked。** 唯一需要重写而不是搬移的是控制面的实时日志（§7 阶段 3）。

---

## 5. 真正的外部风险（动手前必须实测）

### 5.1 出口 IP（最高风险）

Workers / Containers / Browser Run **全部**从 Cloudflare 共享出口出去（文档点名 `172.64.0.0/13`），**没有静态/独享出口**。常见误解要纠正：**Smart Shield Dedicated CDN Egress IPs 不是 Workers/Containers 的出站源 IP** —— 它只作用于 Cloudflare→origin 的 CDN/WAF/Spectrum 流量，且仅 Enterprise。Workers VPC + Gateway 专用出口与 BYOIP 同样在 Enterprise 档。Containers 只支持**大区**约束（APAC/ENAM/…），不能选国家。

**如果厂商要求固定源 IP，这一条直接否定"完全脱离自有服务器"** —— 只剩自建或第三方 egress proxy 一条路。

还有第二层，比 ASN 更容易被忽略：**登录地突变**。631 个账号此前都是从国内/本机出口登录的；搬到 Cloudflare 后落到共享的美/欧机房段，等于同一天里 631 个账号同时"换了城市登录"。厂商侧不需要封 IP，只要按账号做设备/位置一致性判断就能批量拦截。今天 `egress.ts` 的判据（`403/407/429/451/503` + 封禁文案）**抓不到这类拒绝** —— 风控通常返回 `200` + 空 body 或"账号异常"业务码。迁移前必须先做**单账号试登录**（eversion → login → userinfo → apinodelist），记录状态码、验证码率、封号率，再决定是否分批放量。

对本项目的含义：

- 厂商侧是自建 nginx（`Server: nginx/1.26.1`），不在 Cloudflare 后面 —— 所以不存在"CF 出站被 CF 前端拦"的问题。
- 但**是否按 ASN=13335 拉黑是纯经验问题**。项目里 `egress.ts` 已经实现了完整的"被判定为封禁就切代理"的状态机（`403/407/429/451/503` + 37 条中英文封禁文案）—— 这就是现成的探测器和兜底路径。
- **建议的第一步实验**（半天）：在 Containers 里跑一次真实的 4 品牌抓取，统计 `egress_transport` / `egress_switches` 事件，看 direct 直连能撑多久。若频繁触发，`[network].proxy_url` 指向一个外部代理即可 —— 但那意味着**又需要一个服务器**，迁移目标就不完整了。

### 5.2 无 uptime 保证

官方明确不承诺容器跑满任何时长；宿主重启会 SIGTERM → 最多等 15 分钟 → SIGKILL；停止后可能换机器。

**三个不同的超时别混为一谈**：

| 机制 | 上限 | 谁在计时 |
|---|---|---|
| `container.setInactivityTimeout()` | **6 小时**（21,600,000 ms），DO 重启后必须重设 | 容器空闲多久被停 |
| DO 自身驱逐 | **70–140 秒**无 hibernate-able 活动（约 10 秒后 hibernate），**不可配置** | DO 内存态 |
| `monitor()` / DO alarm handler | **15 分钟**（取先到者） | 一次观测窗口 |

推论：多小时的 run 不能靠"设一次 6 小时 + 一个长 monitor"撑住 —— 必须 **alarm 驱动重挂**（`if (ctx.container.running) monitor()`），且 **hibernate 会清空内存态**，事件环形缓冲必须落在 DO SQLite 而不是类字段里。

对本项目的含义：单次 run 15.5 分钟、日跑一次，风险可控；但 `speedtest` 阶段可能拖到小时级，必须做成**幂等 + 断点续跑 + 周期续期**（`run.db` 的 resume 机制是现成基础，见 §4 state 行）。磁盘 ephemeral，所以 run.db 每个检查点要 push 到 R2。

### 5.3 测速判定会漂移（迁移后"节点变少"不一定是退化）

测速与可用性都是**相对测量**：探测源从你的住宅/机房 IP 换到 Cloudflare 机房后，到各节点的 RTT、到 `speed.cloudflare.com` 的路径（在 CF 网内）、到 gstatic 的路径全部改变。三件事会同时变：`min_download_mb_s=1` 这类绝对阈值下的通过率、节点排序、以及可用性阶段被 provider 判定为"机房 IP"的比例。

**因此"迁移后节点数与今天一致"不能当作验收条件**，必须设计**同批 link 双测**：固定 `20260710-151700/vpn_node_deduped.txt` 的 222 条，在旧环境与容器内各跑一遍，比对 dedupe 结果、测速通过率、availability 判定；先单品牌 canary，再四品牌。可接受的差异阈值（例如通过率 ±15%、最终节点数不低于基线的 70%）要在动手前写死，否则事后无法判断是环境问题还是服务退化。

### 5.4 厂商侧的三个未验证假设（比 Cloudflare 侧风险更高）

迁移的成败最终由厂商服务器决定，而下面三件事代码里**没有任何证据**，只有"今天能跑通"：

| 假设 | 现状 | 迁移后怎么验 |
|---|---|---|
| 登录不绑设备 | 项目只发 APK 解析出的 `device_id` 类字段，无 Play Integrity / SafetyNet / 短信或图形验证码处理 | 单账号试登录，记录是否出现验证码或"账号异常"业务码 |
| 不校验 TLS 指纹 | 旧路径是 Node `undici`（本机）与 `curl --http1.1`（兜底），两者指纹不同且都能过； Workers `fetch` 是固定的 BoringSSL/HTTP2 指纹，Container 里仍是 Node/curl | 分别从 Worker 与 Container 各跑一遍 `eversion → login → userinfo → apinodelist`，比对状态码与响应体长度 |
| 封禁会返回 403/429 | `egress.ts` 的判据只覆盖 `403/407/429/451/503` + 37 条文案 | 指纹级拒绝常返回 **200 + 空 body**，现有状态机会**漏判**——需要补一条"解密失败/空节点即视为被拦"的规则 |

这三条任何一条不成立，方案就要往 §7.3 的 B 方案退。**验证成本很低（半天），但漏掉会让整个迁移在上线当天失败**，所以应放在阶段 2 门禁里一起做。

### 5.5 无界 sweep 与 `max_download_candidates=0` 是两个放大器

本机 profile 现在是 `max_runtime_seconds = 0` + `max_download_candidates = 0`（不限）—— 在本机上是"多跑一会儿"，在云上是"按秒计费且可能撞 6 小时 inactivity 上限"。迁移前应把这两个值收紧成显式预算（如 `max_runtime_seconds = 5400`、`max_download_candidates = 20`），并把 §1.2 的三个部署阈值统一。这三处配置不收紧，任何容量估算都不成立。

### 5.6 成本

Workers Paid $5/月含 375 vCPU-分钟、25 GiB-小时内存、200 GB-小时磁盘；超出后 $0.00002/vCPU-s、$0.0000025/GiB-s、$0.00000007/GB-s。

按当前负载实算（`standard-1`，0.5 vCPU / 4 GiB，每天一次 16 分钟 run ≈ 每月 8 小时）：

| 项 | 用量 | 含额度 | 超出费用 |
|---|---|---|---|
| CPU | 0.5 × 480 min = 240 vCPU-min | 375 | $0 |
| 内存 | 4 GiB × 8 h = 32 GiB-h | 25 GiB-h | 7 GiB-h ≈ **$0.06** |
| 磁盘 | 8 GB × 8 h = 64 GB-h | 200 GB-h | $0 |
| 出口 | 3–5 GB/天 ≈ 90–150 GB/月 | 500 GB–1 TB | $0 |

**合计约 $5/月** —— 比一台 VPS（$5–20/月）更便宜或持平。**成本不是决策变量**。

按更保守的规格与更长的 run 重算两档（同一套单价，扣套餐额度）：

| 场景 | 规格 | 月用量 | 估算 |
|---|---|---|---|
| 常态 | `standard-2`（1 vCPU / 6 GiB） | 30 × 16 min = 8 h | $5 + 内存 23 GiB-h $0.21 + CPU 105 min $0.13 ≈ **$5.4** |
| 无界 sweep 打开 | `standard-2` | 30 × 2 h = 60 h | $5 + 内存 $3.0 + CPU $3.9 + 磁盘 $0.07 ≈ **$12** |

关键判断：**迁移成本（32–46 人日，见 §7）远超任何一档 VPS 的年租金**。所以这次迁移的理由只能是"去掉单点/去掉运维"，不能写成"省钱"—— 如果痛点是成本，答案是不迁。

（若把 `max_runtime_seconds = 0` 的无界 sweep 打开、或把测速候选数放开，出口与 CPU 才可能真正产生费用 —— 这也是迁移时应该顺手收紧的两个配置，见 §5.5。）

**TCO 对照（云侧已算清，服务器侧需你补三个数）**：

| 项 | Cloudflare | 现 VPS |
|---|---|---|
| 固定月费 | $5（Workers Paid） | `{{VPS_MONTHLY_COST_c3k9m2}}` |
| 计算 | 含 375 vCPU-min / 25 GiB-h，实测用 240 vCPU-min / 32 GiB-h | 已含在月费 |
| 出口流量 | 3–5 GB/天，在免费额度内 | `{{VPS_BANDWIDTH_ALLOWANCE_p7q4r8}}` |
| 备份/面板 | R2 存储（10 GB 免费额度内）$0 | 自建或含在月费 |
| 人工运维 | 迁移后仍需：令牌轮换、账单、排障（见 §7.4） | 系统打补丁、mihomo 升级、磁盘、掉线重启 |
| 一次性改造 | **32–46 人日** | $0 |

结论不变：一次性改造成本远大于年度差额。**只有当"人工运维小时数"或"单点故障的业务损失"能折算成钱时，这笔账才划得来** —— 这需要你自己填上面三个空格。

---

## 6. 一条必须自己判断的政策风险

Cloudflare 自助服务条款 **§2.2.1(j)** 原文：*"use the Services to provide a virtual private network or other similar proxy services."*

- 本项目的**主体**（聚合厂商节点 → 生成订阅文件）更像"内容聚合/生成"，不是"提供 VPN 服务"。
- 但 `templates/share-worker/vpn.js`（229 KB）确实包含 `cloudflare:sockets` 的 `connect()` + SOCKS5 反代 + 反代 IP 池 —— 那是**实打实的代理转发**。今天它跑在 Pages 上。
- 这不是工程问题，也不会因为迁移而改变；但如果把整条流水线搬进 Containers，曝光面会比今天更大（多一个常驻计算负载 + 更大出口流量）。
- 事实参照：账户里已经有 Pages 项目因 `8000119`（"Your Pages project has been blocked"）触发了 fallback 建新项目的逻辑，说明这条路径已经被实际触发过。
- 口径澄清：禁令针对的是**"用 Cloudflare 服务提供 VPN 或代理服务"**，不是"自己用代理"。§2.2.1 另有禁止"IP 优选"（优选 IP/优选域名）的条款 —— 若把 `share-worker` 的优选订阅生成能力一起搬，风险叠加。

**建议**：迁移技术方案与这条解耦 —— 先把**抓取/测速/生成**搬上去（这部分争议最小），share worker 的转发能力单独决策。

---

## 7. 迁移路线（5 阶段，每阶段可独立回滚）

| 阶段 | 内容 | 出口条件 | 估时 |
|---|---|---|---|
| **0. 前置** | 开 Workers Paid + R2；新建 API Token，收窄到 `Pages:Edit` + `Zone:DNS:Edit`（现在允许 global key）；把 `profile.toml` 里的明文 token 与账号密码迁到 Secrets Store | Token 能建 Pages 项目但删不掉 zone | 0.5 d |
| **1. 容器化镜像** | `linux/amd64`：Node 22 + 固定版本 mihomo + `npm/autovpn-cli`；所有工具构建期烘焙（禁止运行期 npm）；`POST /run` 与 `POST /check` 两个薄入口 | 容器内跑通 `doctor` + 单品牌 3 laps，节点数与旧环境同参数 lap 的差异 ≤ 10% | 4–6 d |
| **2. 出口 + 风控实验（门禁）** | 三组实验一起做：① full run 统计 direct/proxy 切换率与封禁文案命中率；② 单账号试登录（§5.4 三假设）；③ R2 上传/下载吞吐 | ① direct 撑不住整轮 → §5.1 决策点；② 出现验证码/账号异常 → §7.3 B 方案 | 1–2 d |
| **3. 状态外置** | `run-store.ts` → DO SQLite（保留方法名，`transactionSync`）；`account-store.ts` → D1（`lease()` 先实测 `UPDATE … RETURNING`，不行就 `lease_token` + 同 batch `SELECT`；`importRecords()` 改两阶段写）；artifacts/logs → R2；`brand-fingerprints` → KV；`artifactWorkedAt` 的 mtime 排序 → D1 显式 run 索引 | 断点续跑、retry-stage 在 Cloud 上等价 | 6–8 d |
| **4. 控制面** | 14 条路由 → Worker；SSE → DO 环形缓冲（`Last-Event-ID` 重放）；Access 或 per-tenant key 替换共享 token；限流按 `CF-Connecting-IP`；`serveRendererIndex` 的字符串注入 → 构建期 Static Assets | Web UI 在 Cloud 上功能对齐，Electron 走同一套 API | 6–8 d |
| **5. 调度 + 发布** | `daily-run.sh` → Workflow（readConfig → startContainer → waitForRun → parseSummary → 闸门 → deploy → verify → writeResult）；wrangler 子进程 → Pages Direct Upload（单文件 worker 直接发 `_worker.js`，blake3 对拍 wrangler 输出）；Cron `20 15 * * *` UTC | 连续 7 天自动跑，`min_final_nodes=50` 闸门行为一致 | 4–6 d |

**总计 22–31 人日纯改造 + 10–15 人日双跑/灰度/验收/运维交接 = 32–46 人日**，单人日历约 8–12 周（悲观 14–19 周，取决于双跑要观察几个周期）；若阶段 2 不放行，约 6–9 人日（阶段 0+1+2）后即可止损。

容器规格：**不能选 `basic`/`dev`/`standard` 这类旧别名 —— 运行时只接受 `lite`（256 MiB）、`standard-1`（4 GiB）、…`standard-4`，或自定义 `{vcpu, memoryMib, diskMb}`。** 下限是 `standard-1`：`lite`（256 MiB）与 `basic` 都撑不住 APK 解析（本机实测单品牌峰值 244–450 MB，4 品牌并发要按 2–4 GiB 预留）。另外容器是 Firecracker microVM、**不是完整 Linux VM**：不支持 iptables / TUN / IP forwarding / rootless Docker，没有 swap —— mihomo 只能用普通出站模式，不能用 TUN/透明代理。

回滚：每阶段都保留 CLI 本机路径（`AUTOVPN_*` 环境变量选择 transport），Containers 侧的失败不影响 Pages 上已在服务的订阅。

### 域名与 DNS

这一块**不需要迁**，因为已经在 Cloudflare：`swimmingliu.online` 是 zone 里的 Free Website，`swimmingliu.online` / `www` / `vpn` / `cfw` 四条 CNAME 全部指向 Pages 项目。迁移唯一要注意的是：**不要把订阅入口改到 `workers.dev` 子域**（`thatdaniel123` 已占用但 `*.workers.dev` 在国内可达性差），继续用自定义域 + Pages/Workers 路由，二维码与已发出去的订阅 URL 才不用变。

### 7.1 验收判据（没有这张表，迁移永远"做完了但不敢切"）

| 指标 | 基线怎么取 | 放行阈值 |
|---|---|---|
| 四品牌 extract 成功率 | 旧环境连跑 7 天 | ≥ 95% |
| dedupe 后节点数 | 同批 222 条 link 双跑 | 差异 ≤ 10% |
| 测速通过率 | 同上 | 差异 ≤ 15%（§5.3：绝对阈值会漂移，不能用"完全一致"） |
| availability 判定一致率 | 同上，逐条比对 | ≥ 90% |
| 连续自动跑 | 灰度期 | 7 天无人工介入，`min_final_nodes` 闸门行为一致 |
| 单轮成本 | 账单 | ≤ $0.50/轮（约 $15/月上限） |

**只要"extract 成功率"与"availability 一致率"两项任何一项不达标，就不切** —— 节点数下降会让订阅价值直接缩水，这比省运维重要。

### 7.2 数据迁移 runbook（一次性，需停机窗口 ≤ 1 轮）

1. **导出**（旧机，run 前执行，避免写到一半）：`accounts.db` 用 `sqlite3 .backup`（不要 `cp`，WAL 未合并会丢最后几条）；`pool_events` 2,794 行、`accounts` 631 行导出 CSV；220 个 `run.db` 只迁非空的 5 个 + 最新一份完整 run；artifacts 22 MB、`brand-fingerprints` 4 个文件、`profile.toml` 2.7 KB。每张表记行数与 `sha256`，导入后逐表对账。
2. **密码列加密**：631 条明文密码不能原样落 D1。生成一把 32 B 密钥，`AES-256-GCM` 每行随机 IV，密文 + IV + tag 三列入库，密钥放 **Secrets Store（每账号仅 1 个，够用）** 而不是 D1 —— Secrets Store 每账号 100 条 secret 上限装不下 631 条账号，但装 1 把主密钥正好。
3. **切换窗口**：日跑 04:15（Asia/Shanghai）。选在**上一轮跑完、下一轮开始前**（例如 02:00–04:00）做导入与首批试登录，最坏情况是当天这一轮不跑，订阅沿用前一天的产物（Pages 上的文件不动，用户侧无感）。
4. **账号重新验证**：导入后不要直接全量开跑。先按品牌各取 3 个账号做单账号试登录（§5.4），确认无验证码/风控，再逐批放量。若出现批量"账号异常"，**立即停**——此时旧机还没下线，回切成本为零。
5. **回滚**：所有新数据（D1/DO SQLite/R2）只写不删旧机数据；回切时把 D1 的 `accounts`/`pool_events` 与最新 `run.db` 导回 SQLite 与文件树即可。触发回滚的指标：extract 连续 2 轮 < 70%、账号封禁率 > 5%、单轮成本 > $2。

### 7.3 如果 §5.1 / §6 被否决：三种替代终局

| 终局 | 做法 | 是否"完全脱离服务器" | 适用 |
|---|---|---|---|
| **A. 全 Cloudflare** | 本文方案 | 是 | 出口实验通过、且接受 §6 的条款判断 |
| **B. 最小残留跳板** | 只把 **extract**（约 1.2k 行 + 4 个厂商协议）留在一台最小 VPS 上，其余（测速/可用性/状态/控制面/发布）全上 Cloudflare Containers | 否（但服务器从"跑全流程"降到"跑一个抓取器"） | 出口 IP 或登录地突变被证实是硬阻塞 |
| **C. 干脆不迁** | 维持现状，只做两件低成本改进：统一三个部署阈值、把明文 token/密码收进系统钥匙串 | 否 | 痛点是成本/时间，而不是单点可用性 |

**必须先回答的问题（否则无法定义"完全迁移"的边界）**：那台服务器上除了 AutoVPN，还有没有别的常驻东西 —— `127.0.0.1:7897` 的 mihomo、crontab 里的其他任务、面板、日志轮转、其他站点？如果 7897 那个代理本身是这台机器提供的，那么 `egress.ts` 的默认上游代理会一起消失，抓取会退回 direct —— 这会让 §5.1 的实验结果完全不同。**盘点清楚再谈"下线服务器"。**

### 7.4 迁移后的可观测性

Workers/Containers 的日志默认只留 **7 天**，而项目今天的 `human.log` / `stdout.log` / `events.jsonl` 是长期保留的。迁移时必须补一条：容器与 Worker 的日志 → **Logpush → R2**（或 Workers Logs + Tail Worker 落 R2），并定义一次 run 的 SLO（成功率、时延、`final_links` 数）与告警通道（Webhook / Email Workers）。否则 11.8k 请求里哪一条失败，事后无从定位 —— 这会把"服务器运维"换成"Cloudflare 排障"，总运维量未必下降。

---

## 8. 不建议现在动的

- **Electron 桌面端**：它本来就是本地客户端，`main.js` 21 个 IPC 通道全部 spawn 本地 CLI。迁移后它有两条路，需先选一条再动工：
  - **本地优先（推荐）**：Electron 继续跑本地 CLI 与本地 mihomo，云端只是可选的远程入口。好处是断网/云账号出问题时仍可用，工作量几乎为零；代价是"完全脱离服务器"只对服务端成立，桌面用户本机仍需 Node + mihomo。
  - **纯远程客户端**：21 个 IPC 改 HTTP，Access 登录，artifact 从 R2 下载，删掉 `shell:open-path` / `logs:export` / 剪贴板等桌面能力。工作量 2–3 周，且用户必须联网。
  
  两条路的差别不在迁移工作量，而在"离线可用性"和"分发签名/公证"，所以这是产品决策，不是迁移阻塞项。
- **Electron 的版本号与 UI 文案**：若走纯远程路线，`vX.Y.Z` 显示与 `package.json`/Python/发布 tag 的同步规则仍适用（项目 AGENTS.md 明确要求），迁移不豁免这条。
- **`modules/{runtime,guard,noise,payload}.js` 四个 sidecar**：`_worker.js` 从不 import、也从不服务它们，是上传配重。Direct Upload 端口直接不发，顺带删掉失效的 `emit_sidecar_modules` 配置。（注：Pages advanced mode **确实**提供 `env.ASSETS` 绑定；删它们的理由只是未使用，不是平台缺能力。）
- **Pages → Workers Static Assets**：官方已经在推这个方向（并建议迁移后删 Pages 项目），但换掉会改 `pages.dev` URL → 改订阅 URL → 已发出去的二维码全废。单独决策。
- **Playwright**：`doctor` 里检查它，但流水线里没有用（可用性判定是"经节点 HTTP GET"，不是开浏览器）。不需要 Browser Run。

---

## 9. 一页速查：Cloudflare 侧配额与项目用量

| 配额 | 上限 | 本项目 | 差 |
|---|---|---|---|
| Workers 内存 | 128 MB / isolate，不可调 | APK 解析峰值 244 MB | **撞墙** |
| Workers 并发连接 | 6 条"等待响应头"的连接（非总连接上限） | 32（抓取）、20（测速） | 只压吞吐，不是主要否决理由 |
| Workers 子请求 | 10,000（Paid，可调 10M） | ~11.8k/run | 刚好在边缘 |
| Workers CPU | 30 s 默认 / 5 min 上限 | 单 run 15.5 min 墙钟 | **撞墙**（I/O 等待不抵 CPU 上限） |
| Cron / Queue consumer / DO alarm 墙钟 | 15 min | 日跑 75 min 预算 | **撞墙** → 只做发射器 |
| DO SQLite | 10 GB / 对象；单行 8 MB；单语句 100 KB | run.db 940 KB 最大 | 富余 4 个数量级 |
| D1 | 10 GB / 库，单线程，auto-commit（事务只文档化了 `batch()`；交互式 `BEGIN/COMMIT` 按不支持处理），30 s 上限作用于整个 batch | accounts.db 336 KB | 富余；但**语义要对齐**（无 WAL） |
| Containers | 4 vCPU / 12 GiB / 20 GB，`setInactivityTimeout` ≤ 6 h，`monitor()`/alarm ≤ 15 min | 单 run 15.5 min | 富余，但要 alarm 续期 |
| Containers 出口 | 任意 TCP 端口（`enableInternet: true`），UDP 未文档化 | 只走 TCP | 够用 |
| D1 batch | 整个 batch 30 s，单语句保留自身限制；`batch()` 计一次 query 但每条语句仍各自计限 | accounts.db 导入 ~600 行 | 够用，但导入要分批 |
| KV | 每 key **1 写/秒** | 品牌指纹每 run 写一次 | 富余 |
| R2 multipart | 最小分片 5 MiB | 产物单文件 < 5 MiB 时走单次 put | 走单次 put 即可 |
| Secrets Store | **open beta**：每账号 1 个 store、100 个 secret、单个 ≤ 65,536 B | Cloudflare token 1 条；厂商账号密码 631 条 | **631 > 100 → 超限**，账号密码只能留 D1 加密列，Secrets 只放 token |

---

## 附：证据索引

- 代码：`npm/autovpn-cli/src/pipeline/{credential-source,speedtest,availability,proxy-runtime,deploy,obfuscate,geoip,run-store}.ts`、`src/server/{http,runtime}.ts`、`src/pool/account-store.ts`、`scripts/server/daily-run.sh`
- 文档：`docs/credential-sources.md`、`docs/deploy-pages-sub-nodes.md`、`docs/headless-agent/linux-headless-guide.md`、`docs/superpowers/specs/2026-05-07-pages-blocked-fallback-and-share-sub-sync-design.md`
- Cloudflare：`workers/platform/limits`、`workers/runtime-apis/nodejs`、`workers/runtime-apis/tcp-sockets`、`workers/configuration/compatibility-flags`（`allow_custom_ports`）、`containers/platform/{limits,pricing}`、`containers/concepts/{architecture,placement}`、`containers/configuration/outbound-traffic`、`containers/api/durable-object-container`、`durable-objects/platform/limits`、`durable-objects/api/alarms`、`d1/platform/{limits,pricing}`、`workflows/reference/limits`、`queues/platform/limits`、`pages/configuration/api`、`www.cloudflare.com/terms` §2.2.1(j)
- 本次评估的原始过程数据（8 个组件的代码报告、5 个 Cloudflare 主题的文档调研、8 个组件的迁移映射、8 个对抗性验证、1 个完整性批判）：`~/.claude/projects/-Users-swimmingliu-data-VPN-vpn-subscription-automation--claude-worktrees-cf-migration-analysis/29fe18a7-c12a-4255-995b-88cb67727fd9/subagents/workflows/wf_4bae166c-712/journal.jsonl`

---

## 附二：本报告是如何得出的

1. **代码侧**：8 个并行 agent 分别读抓取、测速、可用性、控制面、状态、发布、调度路径，每条结论必须带文件行号。
2. **Cloudflare 侧**：5 个并行 agent 只读 `developers.cloudflare.com` 一手页面，逐条引用原文与 URL。
3. **映射**：8 个组件各自判定 `native / adapt / blocked` 并写明"决定判决的那条限制"。
4. **对抗验证**：每个组件的结论交给独立 verifier 尝试**推翻**（默认 `refuted`，除非能从一手文档确认）。
5. **本地复核**：本报告作者另做了三项独立验证 ——
   - 用 DoH 实测 4 个厂商域的真实解析与 TLS 行为（发现 `www.lgfstt.info:20000` 今天就连标准校验都过不去）；
   - 用 Python `ssl` 对 20 条真实节点做 IP+SNI 校验（8 通过 / 8 hostname 不匹配 / 4 握手失败）；
   - 用 Cloudflare API 直接读账户能力（standard 计划、1 个 Free zone、已有 Workers+D1、无 DO namespace、R2 未开通）。

所有 quote 过的限制都可以在 §附 的文档路径里复核。若某条与实际不符，以 Cloudflare 官方页面为准。

> 过程说明：**8 个对抗性验证全部返回，0 个被推翻（`refuted=false`）**。每个 verifier 都独立给出了 3–8 处需要修正的细节，包括"R2 对象其实有 `uploaded` 时间"、"Workers 的 `node:fs` 是内存 VFS 而非完全 stub"、"6 连接压的是建连窗口不是总连接数"、"Smart Shield 的独享出口 IP 不覆盖 Workers"、"`run.db` 实际是 8 张用户表、且 220 个里 215 个是空的"——这些修正**全部已并入正文**。结论（`adapt`，Containers 承接执行面）未经任何 verifier 动摇。
>
> 另有一个**完整性批判** agent（第 9 个，专门找"报告缺了什么"而不是"哪里写错了"），提出 13 类缺口。值得单独说明的是：它对**工作量与成本**的估价（14–19 周）比作者最初的 22–31 人日更悲观，理由是统计口径不同 —— 作者算"改造"，它算"含双跑、灰度、验收、运维交接的交付"。两者不矛盾，报告现在同时给出两个口径（§0、§7）。它指出的 **TCO 对照、数据迁移 runbook、验收判据、厂商风控三假设、测速漂移、可观测性、替代终局、Electron 去向** 八项已补写进 §5–§7；其余（vendor 反爬逐项、DNS 细节、分片容量）属于阶段 1–2 的实施计划，不属于可行性结论，故只在此标注。
