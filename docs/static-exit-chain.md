# 静态 IP 出口与 Clash 链式代理

这份文档说明怎么给订阅加一个固定 IP 出口节点，并让 Clash Verge Rev（mihomo 内核）用 `dialer-proxy` 把它串到任意机场节点后面。

## 1. 两条链路先分清

订阅输出分成两段，静态出口挂在第二段：

| 段 | 部署物 | 作用 | 静态出口会不会生效 |
| --- | --- | --- | --- |
| 主 Worker（`sub-nodes-05`） | 混淆后的最小导出 Worker | 只吐 base64 节点列表 | 不会，它不做 Clash 订阅转换 |
| 分享 Worker（`sub-links-share-22`） | `templates/share-worker/vpn.js` | 拉取主 Worker 的订阅源，交给 SUBAPI 转 Clash，再热补丁 | 会 |

所以静态出口只对分享 Worker 输出的订阅地址生效。

本机当前配置（`~/.auto-vpn/profile.toml`）：

```text
https://www.swimmingliu.online/sub?token=...          # 分享 Worker，原样输出，不含静态出口
https://www.swimmingliu.online/static?token=...       # 分享 Worker，同一份订阅 + 静态出口（手机用这个）
https://sub-nodes-05.pages.dev/?serect_key=...    # 主 Worker，只吐 base64
```

`/static` 是单独入口：默认 `/sub` 的内容和没有静态出口时逐字一致，静态出口只挂在 `/static` 上。`?static=1` 与 `/static` 等价，给不方便改路径的客户端用。两个地址的 token 相同。

> 部署状态（2026-11-15）：`sub-links-share-07`、`-19`、`-20` 和 `-21` 先后被 Cloudflare 以 `code: 8000119`（Pages project has been blocked）拒绝部署，已按“新建项目 + 迁移环境变量”的方式切到 `sub-links-share-22`，`www.swimmingliu.online` 的 CNAME 和自定义域都指向新项目，`/sub` 与 `/static` 均已实测可用，旧项目和它们专用的 KV 命名空间已删除。分享 Worker 模板同时升级到 cmliu/edgetunnel `2026-11-10`（新的 `KEY`/`userIDMD5` token 派生和 SS AEAD）。分享 Worker 的 `SUB` 指向主 Worker 的真实订阅（`sub-nodes-05.pages.dev/?serect_key=...`），因此环境变量兼容层会在 `SUB` 存在时设置 `优选订阅生成.local = false`；订阅里是主 Worker 的 37 个真实节点，不是分享 Worker 自己生成的 16 个 CF 占位节点。旧模板里的 `env.SUB` 等环境变量覆盖在新模板中不再存在，`templates/share-worker/vpn.js` 里保留了一段兼容层，部署仍只写 Pages 环境变量。

> 部署状态（2026-11-25）：`sub-links-share-24` 亦遭 `code: 8000119` 封禁——项目 API 仍读得，既有部署照旧供流，唯新建部署被拒。已迁至 `sub-links-share-25`，环境变量、KV 绑定与 `ADMIN` 密文、两条自定义域与 CNAME 俱已随迁；两域实测 200 / 29400 B / 65 关 / 三法。上传之 `_worker.js` 为压缩后混淆之产物（2,609,472 B），非明文模板。

## 2. 配置

在 `~/.auto-vpn/profile.toml` 增加：

```toml
[static_exit]
# socks5:// / http:// / https:// 都支持；多个地址用换行或逗号分隔；# 后面是显示名
exit = """
socks5://USER:PASS@198.51.100.10:1080#🇭🇰 香港静态IP
http://USER:PASS@198.51.100.11:8080#住宅出口
"""
# 需要 tls / skip-cert-verify 等额外字段时改用 JSON
exit_json = ""
# 留空用默认分组名
group = ""
entrance = ""
# entrance：一条链式节点 + 一个入口分组（推荐）
# all：每个入口节点各配一条链式节点
# off：只注入出口节点，不做链式
twins = "entrance"
```

同一组值也可以直接写成分享 Worker 的环境变量：`STATIC_EXIT`、`STATIC_EXIT_JSON`、`STATIC_EXIT_GROUP`、`STATIC_EXIT_ENTRANCE`、`STATIC_EXIT_TWINS`。部署时 `deploy.ts` 会把 profile 里的值同步到 Cloudflare Pages 项目的 env vars，`preview` 与 `production` 都写：这个项目不部署 preview 分支，两个环境写同一份值只是让 Pages 侧保持一致，多出来的暴露面是零。

profile 里只要有 `[static_exit]` 段，这五个键就会整组写入，空的也照写——**这是清空出口的方式**：把 `exit` 和 `exit_json` 都置空再部署一次，项目上旧的 `user:pass@host` 会被空值覆盖掉。不这样写的话，删掉的出口会一直留在项目上，继续注入给每个订阅者。profile 里完全没有这个段时一个键都不写，所以旧版本的 profile 不会误伤已有配置。

写进 env vars 意味着出口账号会落在 Cloudflare 项目的配置里，能被有权访问该项目的人读到。如果不想让它离开本机，用第 4.1 节的 Verge 扩展脚本，那里的凭证只存在你本地的 `profiles/*.js`。

存放位置的取舍：

| 位置 | 能不能用 | 说明 |
| --- | --- | --- |
| Pages 项目 env vars（`STATIC_EXIT` 等） | 推荐 | 部署时由 `profile.toml` 写入，只属于这一个项目；不进仓库、不进 CI 日志 |
| GitHub Secrets | 只在 CI 负责部署时需要 | 本机 runner 直接读 `profile.toml`，没有 workflow 需要这个值；存了也不会被用到 |
| KV `static-exit.json` | 不推荐 | 同一个 namespace 被多个项目共用，写进去等于让所有项目的 Worker 都能读到，旧 Worker 还会把它注入 `/sub` |

仓库、测试和文档里只出现 `USER`/`PASS`/`198.51.100.x` 这类文档地址；真实 `socks5://…@…` 链接只存在 `~/.auto-vpn/verge-exit.txt`、`~/.auto-vpn/profile.toml`（都是 600）和 Cloudflare 项目配置里。

`exit_json` 里的每条记录就是一条 mihomo 代理，字段原样透传：

```json
[
  {"name": "香港静态IP", "type": "socks5", "server": "198.51.100.10", "port": 1080,
   "username": "USER", "password": "PASS", "udp": true}
]
```

## 3. `/static` 订阅里会多出什么

以下内容只出现在 `/static` 入口。`/sub` 不会因为项目上配了出口而变化，同一份订阅可以继续给别的设备用。以 `twins = "entrance"` 为例，Clash 配置里会新增：

```yaml
proxies:
  # 直连出口，不经过任何机场节点
  - {name: "🇭🇰 香港静态IP", type: "socks5", server: "198.51.100.10", port: 1080,
     username: "USER", password: "PASS", udp: true}
  # 链式出口：先走「🛬 静态IP入口」选中的节点，再落到静态 IP
  - {name: "🇭🇰 香港静态IP（链式）", type: "socks5", server: "198.51.100.10", port: 1080,
     username: "USER", password: "PASS", udp: true, dialer-proxy: "🛬 静态IP入口"}

proxy-groups:
  - name: "🛡️ 静态IP出口"
    type: select
    proxies:
      - "🇭🇰 香港静态IP（链式）"
      - "🇭🇰 香港静态IP"
  - name: "🛬 静态IP入口"
    type: select
    proxies:
      - "US 421"
      - "JP 9"
      - ...
      - DIRECT
```

`🛡️ 静态IP出口` 会被追加到每个 `select` 分组的末尾，所以「🚀 节点选择」以及各类业务分组里都能直接选到它。`url-test` / `load-balance` 分组不会挂它——不是 mihomo 不允许（实测 1.19.33 允许测速分组里嵌套 `select`），而是把出口放进自动测速组没有意义：出口只有一两个，选中哪个用户也管不了，测速还会反复把流量切来切去。想让它进测速组，在 Verge 的代理页手动加即可。

`/static` 输出的订阅名带 `-静态IP` 后缀，加到 Verge 或手机客户端里不会和原来的 `/sub` 混成一个订阅。这个入口只处理 Clash 格式（`UA` 里带 `clash`/`mihomo`）；v2ray 等其它格式拿到的是原样订阅，不含出口。

## 4. 在 Clash Verge Rev 里怎么用

先说清楚一件事：**订阅更新会不会覆盖你手改的内容，取决于你改在哪里。**

| 改在哪 | 订阅更新后 |
| --- | --- |
| 直接改订阅 YAML（右键「编辑文件」） | 被覆盖 |
| 订阅右键的「编辑节点/代理组/规则」 | 保留 |
| 「扩展配置 / 扩展脚本」 | 保留，且每次更新自动重跑 |

所以想让静态出口跟着订阅一起自动更新，用扩展脚本，别手改 YAML。

### 4.1 扩展脚本（推荐）

`docs/clash-verge-extension.js` 是现成的脚本，顶部配置区改出口地址即可：

```js
const STATIC_EXITS = [
  { name: '🇭🇰 香港静态IP', type: 'socks5', server: '198.51.100.10', port: 1080,
    username: 'USER', password: 'PASS', udp: true },
];
const MODE = 'chain';  // 'chain' | 'all' | 'direct'
// 出口分组挂进哪些 select 分组；留空 = 所有 select 分组
const EXIT_GROUP_TARGETS = ['🚀 节点选择'];
```

放进 Clash Verge Rev：

1. 「订阅」页右上角 → 新建「扩展脚本」（或订阅卡片右键 → 编辑扩展脚本）。
2. 把脚本全文贴进去，保存。
3. 重新激活一次订阅（右键 → 重新激活，或点右上角 🔥）。
4. 之后每次订阅自动更新，脚本都会重新跑一遍，注入结果跟着新节点列表刷新。

脚本是幂等的：每一轮先摘掉上一轮注入的节点和分组，再从订阅原样重建，所以重复执行不会叠加。这样用户删掉其中一组分组、或订阅换了节点时不会留下悬空引用——旧版「已注入就直接返回」会让链式节点的 `dialer-proxy` 指着已删的入口组，mihomo 直接拒收整份配置。链式模式下如果订阅里连一个可用的上一跳都没有，这一轮就不注入出口，不会退回直连。

`🛡️ 静态IP出口` 和 `🛬 静态IP入口` 这两组归脚本所有：位置（总在分组列表末尾）和成员每次都会被重建，手工加进去的成员或调整过的顺序不会保留。注入的节点带一个 `__static_exit: true` 字段，mihomo 会忽略它，脚本靠它认出自己上一轮加的东西。

#### 4.1.1 真实出口地址怎么写进去

扩展脚本运行在 Verge 的沙箱里，**没有文件系统权限**，所以出口地址只能以字面量形式存在于 `profiles/<uid>.js`。把这一步交给 CLI，地址只经过磁盘和进程内存，不经过终端回显：

```bash
# 直接粘贴：提示符不回显，回车结束
autovpn verge exit

# 或者从文件读，一行一个地址
autovpn verge exit --from ~/.auto-vpn/verge-exit.txt
```

文件格式（`#` 后面是显示名）：

```text
socks5://USER:PASS@203.0.113.7:1080#🇭🇰 香港静态IP
```

路径默认是 `~/.auto-vpn/verge-exit.txt`。**用编辑器写**，别写成 `echo`/`printf` 命令——那样会留在 `~/.zsh_history` 里。CLI 会拒绝 group/other 可读的源文件，写完 `chmod 600` 它。`--stdin` 在终端里同样不回声：它走的是和默认提示符一样的隐藏输入，不会把粘贴的内容打到屏幕上；只有在管道里才读整段 stdin。少写 `@` 的链接（`socks5://USER:PASS:1080`）会被拒绝，不会把误当成主机名的那段原样打印出来。

`autovpn verge exit` 做四件事：

1. 解析链接（`socks5` / `socks5h` / `socks` / `http` / `https` / `http+tls`），输出里只有 `socks5://***@203.0.113.7:1080` 这种脱敏行；解析失败只报行号，不回声那一行的内容。
2. 只替换 `STATIC_EXITS` 这一段——你在 Verge 里调过的 `MODE`、`EXIT_GROUP_TARGETS`、`RULES_TO_EXIT` 原样保留——写入走「临时文件 + fsync + rename」，权限 600，半截脚本不会留在原地。
3. 重启 Clash Verge，让扩展脚本重新跑；先等核心的 socket 重新出现，再在 mihomo 的 unix socket 上轮询，确认出口分组和它的成员真的加载了，打印分组名和成员。`--wait` 是这两步合起来的预算（默认 25 秒）。成员从运行中的出口分组里读，所以 `MODE = 'all'` 下等的是订阅自己的节点名（`US 421 ➜ …`），不是探针里的 `PROBE-ENTRY ➜ …`。
4. 重启会让 Verge 把分组选择恢复成订阅自己的默认值，原本选着出口分组的 `🚀 节点选择` 会悄悄切回某个机场节点。写入前记下哪些分组正指向出口分组，激活稳定后自动放回去（输出里的 `restored`）；`--use` 则是无条件选中。
5. 另一件重启会掩盖的事是「同名换凭证」：mihomo 的 `/proxies` 不带地址和凭证，新链接和旧链接看起来一样。所以还会读一遍 Verge 生成的 `clash-verge.yaml`：如果里面那条节点跟重启前一模一样，说明配置根本没重建，命令按失败退出（`6`），不会报成功。

- `--check`：只解析、只编译，不写任何东西。
- `--script PATH`：写哪个脚本；路径在 git 工作区里时直接拒绝（退出码 `4`）——模板本身就在仓库里，写进去等于等一次 `git add -A` 把凭证提交上去。
- `--test`：写之前先用 curl 通过每个出口拉一次 `https://api.ipify.org`，只打印返回的出口 IP；连不上就不写。
- `--no-apply`：只写不重启，之后自己在 Verge 里重新激活订阅。
- `autovpn verge status --test`：随时看当前状态——脚本里的出口、运行时是否已加载、当前选中的出口、链式节点的延迟。

退出码：`0` 成功，`2` 用法错误，`3` 没找到 Verge 或扩展脚本，`4` 源文件权限不对，`5` 出口连不上，`6` 核心没有加载新节点，或生成的配置里还是旧的那条。

`npm --prefix npm/autovpn-cli run verge:exit` 是同一套解析逻辑的独立脚本，仍然可用（它的 `--out` 对应 CLI 的 `--script`）。

仓库里的 `docs/clash-verge-extension.js` 始终是占位地址，所以凭证不会进 git，也不会出现在任何对话记录里。如果出口地址要跟云端订阅共用，也可以写进 `~/.auto-vpn/profile.toml` 的 `[static_exit]`，但那条路会在部署时把凭证同步到 Cloudflare 项目的环境变量里（见第 2 节），只想留本机就别混用。

`MODE` 三种取值：

- `chain`：一条 `香港静态IP（链式）` + 一个 `🛬 静态IP入口` 分组，节点数只多 1 个。
- `all`：每个机场节点各配一条 `US 421 ➜ 香港静态IP`，节点数直接翻倍（37 → 74），但不用手动选入口。
- `direct`：只注入出口节点，不做链式。

`chain` 和 `all` 下只注入链式出口，直连出口和 `DIRECT` 都不进分组：留一个直连选项，等于留了一个把本机 IP 直接交给出口服务商的开关，选错一次就绕过了整条链。入口分组同理不给 `DIRECT`——入口选直连就是拿本机 IP 当上一跳。只有 `MODE = 'direct'` 保留直连出口。

`EXIT_GROUP_TARGETS` 控制出口分组挂到哪些 `select` 分组上，默认就是主选择器 `['🚀 节点选择']`：其它分组大多指向它，挂到每个分组上会让同一件事有好几个地方能改，看着像重复。留空则所有 `select` 分组都挂；写成单个字符串时按一项处理。

想按规则分流，填 `RULES_TO_EXIT`：

```js
const RULES_TO_EXIT = [
  'DOMAIN-SUFFIX,openai.com,🛡️ 静态IP出口',
  'DOMAIN-SUFFIX,anthropic.com,🛡️ 静态IP出口',
];
```

### 4.2 扩展配置（只加节点，逻辑更简单的写法）

不想用 JS 的话，用「扩展配置」也行，但要注意两个限制：

- v1.7.x 起，`prepend-proxies` / `append-proxy-groups` 在扩展配置里的支持不稳定，官方推荐改用订阅右键的可视化编辑器。
- 扩展配置里的分组列表是位置式的，不会按名字合并，重名会冲突。

所以只有出口节点、不需要链式分组时，扩展配置才比脚本省事。

### 4.3 用起来

1. 打开「代理」页。
2. 想看「机场节点 → 静态 IP 出口」这条链：
   - 打开 `🛬 静态IP入口`，选中转节点（比如 `US 421`）。
   - 在 `🚀 节点选择` 里选 `🛡️ 静态IP出口`，它下面只有链式出口。
   - 出口就是静态 IP，入口是中转节点。
3. 不想走静态出口时，在 `🚀 节点选择` 里选任意机场节点即可；配置里没有「静态 IP 直连」这个选项。

链路验证过：mihomo 1.19 下 `dialer-proxy` 指向一个 `select` 分组时，会先连中转节点，再由中转节点去连静态出口，最后才访问目标站点（本地双 SOCKS5 中转 + HTTP 目标的链路验证结论，mihomo 1.19.24）。

`twins = "all"` 时不再需要入口分组，配置里会直接出现 `US 421 ➜ 🇭🇰 香港静态IP`、`JP 9 ➜ 🇭🇰 香港静态IP` 这样的节点，每个机场节点各配一条，缺点是节点数会乘上出口数量（上限 300 条）。

## 5. 约束

- **UDP**：DNS 之类 UDP 流量在链式节点上取决于中转节点和出口是否都支持 UDP。mihomo 文档建议中转链路用 SS AEAD 或 VMess，避开 hy2/tuic/wg 这类 UDP 协议和 reality/shadowtls 这类 TLS 伪装协议。
- **命名冲突**：出口名撞上已有节点或分组（包括分组名本身）时会自动改成 `名字 2`，链式节点跟着改名。出口名和分组重名会让 mihomo 判成分组环，所以这条是硬要求。
- **端口**：`exit` URI 不带端口时按协议补默认值（socks5 1080、http 80、https 443）；`exit_json` 里缺 `port` 的记录会被丢掉，避免整份配置被 mihomo 拒掉。
- **失败即空**：`exit` 和 `exit_json` 都为空时不注入任何内容，订阅和原来完全一致；Verge 扩展脚本这时会顺手把上一轮注入的节点、分组和 `RULES_TO_EXIT` 规则摘干净。
- **上游写法兼容**：`proxies` / `proxy-groups` 用流式（`proxies: [{...}]`）还是块式、节点名用 `'It''s HK'` 这类转义、`proxy-groups` 后面跟 `"my:provider":` 这种带冒号的顶层键、以及完全没有 `proxy-groups` 段的配置，都会先规范化再注入。

## 6. 相关代码

- `templates/share-worker/vpn.js`
  - `// <静态出口 begin>` 到 `// <静态出口 end>` 之间是独立的注入块，自带解析和 YAML 改写。
  - `收尾Clash配置()` 是 Clash 输出的统一入口：先 `应用静态出口()`，再 `pruneEmptyClashGroups()`。
  - `admin/static-exit.json`：POST 写入 KV（`static-exit.json`），GET 读取；订阅请求只要有 KV 且没有用 `STATIC_EXIT_JSON` 直接给清单，就会把这个 KV 清单读进来。
- `npm/autovpn-cli/src/verge/`
  - `exit-uri.ts`：链接解析、脱敏、curl 代理地址。
  - `script.ts`：`STATIC_EXITS` 的生成与替换、按 `profiles.yaml` 找扩展脚本、把脚本跑在探针配置上得到「这一轮会注入什么」。
  - `runtime.ts`：mihomo unix socket 上的 `/proxies`、选择、延迟探测。
- `npm/autovpn-cli/src/cli/verge-commands.ts`：`verge exit|status|test` 的解析、写入、重启、验证。
- `npm/autovpn-cli/src/pipeline/deploy.ts`：`buildShareStaticExitEnv()` 把 `[static_exit]` 同步成分享项目的环境变量。
- `npm/autovpn-cli/src/config/profile.ts`：`normalizeStaticExitSection()` 负责默认值与 twin 模式校验；`redactStaticExitForClient()` 让 `/api/state` 不吐出口账号密码。
- `npm/autovpn-cli/src/pipeline/orchestrator.ts`：`deployStaticExitFields()` 把 `[static_exit]` 折进 deploy 入参。

## 7. 快速自检

```bash
node --test npm/autovpn-cli/test/pipeline/static-exit.test.mjs
node --test npm/autovpn-cli/test/pipeline/share-worker-static-exit.test.mjs
node --test npm/autovpn-cli/test/pipeline/verge-extension.test.mjs
node --test npm/autovpn-cli/test/pipeline/verge-exit-apply.test.mjs
node --test npm/autovpn-cli/test/verge-exit-uri.test.mjs
node --test npm/autovpn-cli/test/verge-script.test.mjs
node --test npm/autovpn-cli/test/verge-commands.test.mjs
```

`static-exit.test.mjs` 覆盖转义名、流式 proxies/分组、带冒号顶层键、出口名撞分组名、无 `proxy-groups` 段这些畸形输入，最后统一交给 `mihomo -t` 复核。`share-worker-static-exit.test.mjs` 会把模板 Worker 真跑起来（SUBAPI 用本地桩），验证订阅输出与管理接口，再交 `mihomo -t` 校验。`verge-extension.test.mjs` 按 Verge 的方式 eval 扩展脚本，检查幂等、重名避让，三种模式都过 `mihomo -t`。没装 mihomo 时最后一步自动跳过。

## 8. Cloudflare 误封后的处理

`code: 8000119`（Pages project has been blocked）是项目级封禁，原项目上的部署和域名都不能再用。按下面的顺序迁移，不要在原项目上反复重试：

1. 新建主 Worker 项目和分享 Worker 项目（`sub-nodes-05`、`sub-links-share-22` 这种递增编号），不要复用被封的名字。
2. 主 Worker 重新走一遍 `autovpn` 的构建，换一个新的 `variable_prefix`，确认产物和上一版逐字节不同。
3. 分享 Worker 从 `templates/share-worker/vpn.js` 重新部署；环境变量按被封项目的 `deployment_configs` 逐项迁移（`ADMIN` 是 `secret_text`，`STATIC_EXIT` 从 `~/.auto-vpn/profile.toml` 的 `[static_exit]` 同步），KV 建议新建独立命名空间，避免和旧项目的 `config.json` 串用。
4. 把 `www.swimmingliu.online` 的 CNAME 改到新项目，删除旧项目上的自定义域，再在新项目上重新添加；Pages 侧的域名状态到 `active` 后再验收。
5. 更新 `~/.auto-vpn/profile.toml` 的 `project_name`、`pages_project_url`、`share_project_name` 和 `share_project_fallback_last_used_suffix`，然后各拉一次 `/sub` 与 `/static`，两份都要过 `mihomo -t`，并确认 `/static` 的 `Content-Disposition` 带 `-静态IP`。
6. 验收通过后删除旧项目：只删除已经迁移完、且不再承载任何自定义域的旧 Worker；顺带删除它们专用的 KV 命名空间，避免留下孤儿资源。共用命名空间只在确认没有其他项目绑定后删除。
