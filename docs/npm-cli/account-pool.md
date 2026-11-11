# 账号池

官网登录用的账号密码不再写在设置页里，而是存在一个独立的 SQLite 账号池。
设置页只需要填四个加速器的官网；密钥从 APK 里自动发现，账号从池里按品牌轮换取用。

数据库位置：`~/.auto-vpn/accounts.db`（可用 `VPN_AUTOMATION_ACCOUNTS_DB` 覆盖）。
目录以 `0700` 创建，主库和 `-wal` / `-shm` 三个文件都会收紧到 `0600` —— 打开期间明文
凭据就在 WAL 里，只锁主库拦不住。

## 上传格式

UTF-8 CSV，第一行必须是表头。列顺序固定，尾部可选列可以整列省略。

```csv
brand,account,password,official_site,expires_at,status,note
leiting,ACCOUNT,PASSWORD,https://www.68123836.com,2026-12-31,active,
xuanfeng,ACCOUNT,PASSWORD,,,active,备用
heidong,ACCOUNT,PASSWORD,,2026-06-30,active,
mifeng,ACCOUNT,PASSWORD,,,active,
```

| 列 | 必填 | 说明 |
| --- | --- | --- |
| `brand` | 是 | `leiting` / `xuanfeng` / `heidong` / `mifeng`，也接受中文名 `雷霆加速器` 等 |
| `account` | 是 | 登录账号 |
| `password` | 是 | 登录密码。含逗号或引号时用双引号包裹，内部引号写成 `""` |
| `official_site` | 否 | 留空则用该品牌的默认官网。填了已知域名但品牌对不上会报错 |
| `expires_at` | 否 | 会员到期日，`YYYY-MM-DD`（也接受 `2026/1/5`）。留空表示未知 |
| `status` | 否 | `active` / `disabled` / `expired` / `invalid`，留空为 `active` |
| `note` | 否 | 备注，仅用于展示 |

表头也接受中文：`品牌,账号,密码,官网,到期时间,状态,备注`。

生成一份空白模板：

```bash
autovpn accounts template > accounts.csv
```

## 导入

```bash
autovpn accounts import accounts.csv
```

同一个 `(brand, account)` 重复导入是更新，不是新增。留空的可选列表示"这项没说"，
不是"清空"：用三列模板改密码时，库里已有的到期日和备注会保留。订阅日期已经过去的行
不会因为一次导入就复活。导入结果分四类计数：

- `inserted` 新账号
- `updated` 已有账号的字段变化
- `rotated` 密码变了 —— 以文件为准更新，并重新启用
- `revived` 之前被软删除、这次导入把它带回可用状态（会员日期已过的不算）

坏行会跳过并报告行号（文件里的物理行号，空行和多行引号字段都会计入），其余行照常导入。
比表头宽的行会被拒绝而不是截断 —— 多出来的单元格几乎总是没加引号的逗号。
`official_site` 若属于另一个品牌会报错，带不带 `www.` 都能识别。有问题行时退出码为 `1`，加 `--allow-issues` 可接受。

先看结果不写库：`--dry-run`。它以只读方式打开数据库，连"到期自动停用"的清理都不跑，
输出里的 `inserted/updated/rotated/revived` 是真正执行时会发生的数量。

旧的 `account-info.txt`（`[雷霆加速器 #2]` + `官网/账号/密码` 段式）可以直接导入，
格式自动识别，也可以显式 `--format legacy`：

```bash
autovpn accounts import /path/to/account-info.txt
```

## 软删除

账号不会物理删除。退出轮换时写 `deleted_at` 并置状态，行还在，历史和去重都保留。

三种退出方式：

- **到期自动**：`expires_at` 早于本机今天（本地日历日，不是 UTC 日）的 `active` 行，
  在任何一次读取池之前被自动标记 `expired` 并软删除。不需要人工干预。
- **登录失败**：流水线用某个账号登录被拒，调用 `markInvalid`，标记 `invalid` 并软删除。
  这是"密码被改了"的检测路径。
- **人工停用**：`autovpn accounts disable <brand> <account> --reason '…'`。

恢复：`autovpn accounts enable <brand> <account>`，或重新导入一行 `status=active`。
会员日期已经过去的账号不能直接启用 —— 到期清理会在下一次读取时再次停用它，所以
`enable` 会以 `membership_expired` 退出，先用 `accounts expire --date` 续期。
`accounts expire` 必须带 `--date YYYY-MM-DD`（或显式 `--clear`），日期会被规范化；
不是日期的值直接拒绝，不会写进库里。

注意这两条路径方向相反，是有意的：**导入**是运营者声明当前事实，所以改密码即更新并复活；
**运行时登录失败**是观测到旧密码失效，所以标记并停用。

## 查询

```bash
autovpn accounts stats --output human
```

```
account pool: 143 total, 143 active
  retired: 0 disabled, 0 expired, 0 invalid
  expiring within 7 days: 0
  黑洞加速器    total= 39 active= 39 disabled=0 expired=0 invalid=0
  雷霆加速器    total= 44 active= 44 disabled=0 expired=0 invalid=0
  蜜蜂加速器    total= 30 active= 30 disabled=0 expired=0 invalid=0
  旋风加速器    total= 30 active= 30 disabled=0 expired=0 invalid=0
```

```bash
autovpn accounts list --brand leiting --status active --output human
```

列表和统计**永远不含密码**，账号本身也做掩码（`y1***56`）。这是结构上的保证：
展示路径根本不读密码列。只有 `export` 会输出明文，并在 stderr 提示。

```bash
autovpn accounts list --all          # 含已软删除（等同于 --status all）
autovpn accounts export --file backup.csv
```

`export --file` 会以 `0600` 写文件；目标文件已存在时也会把它收紧到 `0600`，
因为这是唯一会写出明文的路径。

## 取用

流水线按品牌调用 `lease(brand)`，取 `last_used_at` 最旧的可用账号，
这样一次运行会把负载摊到整个池，而不是把 1 号账号打到被限流。
`leaseAll(brand)` 返回该品牌全部可用账号，供并发扇出使用。

## 核对会员到期

一次运行只按品牌租用一个账号，所以刚导入的池里绝大多数行的到期日会一直空着。
`accounts refresh-expiry` 逐个登录可用账号，读取厂商返回的真实会员日期并写回；
已经过期、或登录后确认不是会员的行会被标记并退出轮换。

```bash
autovpn accounts refresh-expiry --output human
autovpn accounts refresh-expiry --brand heidong --limit 20 --concurrency 4
```

输出里的 `checked / updated / expired / retired / failed` 是真正发生的数量：

| 结果 | 判定依据 | 行的去向 |
|---|---|---|
| `updated` | 登录成功，会员日期在今天之后 | 写回到期日，保持可用 |
| `expired` | 日期已过，或厂商说会员已到期 | 标记过期，退出轮换 |
| `retired` | 登录成功但等级为免费且没产出任何线路；或厂商明确拒绝了这个账号/密码 | 标记失效，退出轮换 |
| `failed` | 限流、网络失败等无法判断的情况 | 保持原状 |

免费等级的行也会返回一个几年后的日期，所以只看日期不足以剔除它——等级和
"有没有产出"一起判断。厂商把付费行误报成等级 1 时，只要它产出了线路就保留。

设置抽屉的账号池面板有同一个动作（核对会员到期），走
`POST /api/accounts/refresh-expiry`；桌面端走同一条 CLI 命令。

## 前端

设置抽屉里的账号池面板展示总数、各状态计数、按品牌分布和 7 天内到期数，
并支持上传同一份 CSV。上传走的就是上面这个解析器，所以 CLI 和前端导入结果一致。

读取失败时面板显示"账号池未读取"和失败原因，不会渲染一排 0 让人误以为池是空的。
导入失败的行号和原因会显示在面板里；`autovpn serve` 的前端同样如此。