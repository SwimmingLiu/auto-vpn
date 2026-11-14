# 静态 IP 出口与 Clash 链式代理

这份文档说明怎么给订阅加一个固定 IP 出口节点，并让 Clash Verge Rev（mihomo 内核）用 `dialer-proxy` 把它串到任意机场节点后面。

## 1. 两条链路先分清

订阅输出分成两段，静态出口挂在第二段：

| 段 | 部署物 | 作用 | 静态出口会不会生效 |
| --- | --- | --- | --- |
| 主 Worker（`sub-nodes-04`） | 混淆后的最小导出 Worker | 只吐 base64 节点列表 | 不会，它不做 Clash 订阅转换 |
| 分享 Worker（`sub-links-share-06/07`） | `templates/share-worker/vpn.js` | 拉主 Worker 的节点，交给 SUBAPI 转 Clash，再热补丁 | 会 |

所以静态出口只对分享 Worker 输出的订阅地址生效。

本机当前配置（`~/.auto-vpn/profile.toml`）：

```text
https://www.swimmingliu.online/sub?token=...          # 分享 Worker，静态出口在这里生效
https://sub-nodes-04.pages.dev/?serect_key=...    # 主 Worker，只吐 base64
```

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

`exit_json` 里的每条记录就是一条 mihomo 代理，字段原样透传：

```json
[
  {"name": "香港静态IP", "type": "socks5", "server": "198.51.100.10", "port": 1080,
   "username": "USER", "password": "PASS", "udp": true}
]
```

## 3. 订阅里会多出什么

以 `twins = "entrance"` 为例，Clash 配置里会新增：

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
```

放进 Clash Verge Rev：

1. 「订阅」页右上角 → 新建「扩展脚本」（或订阅卡片右键 → 编辑扩展脚本）。
2. 把脚本全文贴进去，保存。
3. 重新激活一次订阅（右键 → 重新激活，或点右上角 🔥）。
4. 之后每次订阅自动更新，脚本都会重新跑一遍，注入结果跟着新节点列表刷新。

脚本是幂等的：重复执行不会叠加，检测到 `🛡️ 静态IP出口` 已经存在就直接返回。

`MODE` 三种取值：

- `chain`：一条 `香港静态IP（链式）` + 一个 `🛬 静态IP入口` 分组，节点数只多 2 个。
- `all`：每个机场节点各配一条 `US 421 ➜ 香港静态IP`，节点数直接翻倍（37 → 75），但不用手动选入口。
- `direct`：只注入出口节点，不做链式。

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
   - 在 `🚀 节点选择` 里选 `🇭🇰 香港静态IP（链式）`。
   - 出口就是静态 IP，入口是中转节点。
3. 只想用静态 IP 直连（不经机场）：
   - 在 `🚀 节点选择` 里选 `🇭🇰 香港静态IP`。

链路验证过：mihomo 1.19 下 `dialer-proxy` 指向一个 `select` 分组时，会先连中转节点，再由中转节点去连静态出口，最后才访问目标站点（本地双 SOCKS5 中转 + HTTP 目标的链路验证结论，mihomo 1.19.24）。

`twins = "all"` 时不再需要入口分组，配置里会直接出现 `US 421 ➜ 🇭🇰 香港静态IP`、`JP 9 ➜ 🇭🇰 香港静态IP` 这样的节点，每个机场节点各配一条，缺点是节点数会乘上出口数量（上限 300 条）。

## 5. 约束

- **UDP**：DNS 之类 UDP 流量在链式节点上取决于中转节点和出口是否都支持 UDP。mihomo 文档建议中转链路用 SS AEAD 或 VMess，避开 hy2/tuic/wg 这类 UDP 协议和 reality/shadowtls 这类 TLS 伪装协议。
- **命名冲突**：出口名撞上已有节点或分组（包括分组名本身）时会自动改成 `名字 2`，链式节点跟着改名。出口名和分组重名会让 mihomo 判成分组环，所以这条是硬要求。
- **端口**：`exit` URI 不带端口时按协议补默认值（socks5 1080、http 80、https 443）；`exit_json` 里缺 `port` 的记录会被丢掉，避免整份配置被 mihomo 拒掉。
- **失败即空**：`exit` 和 `exit_json` 都为空时不注入任何内容，订阅和原来完全一致。
- **上游写法兼容**：`proxies` / `proxy-groups` 用流式（`proxies: [{...}]`）还是块式、节点名用 `'It''s HK'` 这类转义、`proxy-groups` 后面跟 `"my:provider":` 这种带冒号的顶层键、以及完全没有 `proxy-groups` 段的配置，都会先规范化再注入。

## 6. 相关代码

- `templates/share-worker/vpn.js`
  - `// <静态出口 begin>` 到 `// <静态出口 end>` 之间是独立的注入块，自带解析和 YAML 改写。
  - `收尾Clash配置()` 是 Clash 输出的统一入口：先 `应用静态出口()`，再 `pruneEmptyClashGroups()`。
  - `admin/static-exit.json`：POST 写入 KV（`static-exit.json`），GET 读取；订阅请求只要有 KV 且没有用 `STATIC_EXIT_JSON` 直接给清单，就会把这个 KV 清单读进来。
- `npm/autovpn-cli/src/pipeline/deploy.ts`：`buildShareStaticExitEnv()` 把 `[static_exit]` 同步成分享项目的环境变量。
- `npm/autovpn-cli/src/config/profile.ts`：`normalizeStaticExitSection()` 负责默认值与 twin 模式校验；`redactStaticExitForClient()` 让 `/api/state` 不吐出口账号密码。
- `npm/autovpn-cli/src/pipeline/orchestrator.ts`：`deployStaticExitFields()` 把 `[static_exit]` 折进 deploy 入参。

## 7. 快速自检

```bash
node --test npm/autovpn-cli/test/pipeline/static-exit.test.mjs
node --test npm/autovpn-cli/test/pipeline/share-worker-static-exit.test.mjs
node --test npm/autovpn-cli/test/pipeline/verge-extension.test.mjs
```

`static-exit.test.mjs` 覆盖转义名、流式 proxies/分组、带冒号顶层键、出口名撞分组名、无 `proxy-groups` 段这些畸形输入，最后统一交给 `mihomo -t` 复核。`share-worker-static-exit.test.mjs` 会把模板 Worker 真跑起来（SUBAPI 用本地桩），验证订阅输出与管理接口，再交 `mihomo -t` 校验。`verge-extension.test.mjs` 按 Verge 的方式 eval 扩展脚本，检查幂等、重名避让，三种模式都过 `mihomo -t`。没装 mihomo 时最后一步自动跳过。
