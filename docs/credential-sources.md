# 官网 + 账号 数据源

数据源有两种模式。老的 `url` 模式要求手工粘贴一条已经带 token 的请求地址，token 一过期就得重新抓；`credential` 模式只要求官网地址和账号密码，其余每次运行时现取。

## 配置

```toml
[sources]
[sources.leiting]
mode = "credential"
official_site = "https://www.68123836.com"
account = "你的账号"
password = "你的密码"
platform = "android"
enabled = true
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `mode` | 是 | `credential` 或 `url` |
| `official_site` | 是 | 官网地址；从这里定位当前 APK |
| `account` / `password` | 是 | 登录凭据 |
| `platform` | 否 | `android`（默认）或 `ios` |
| `max_areas` | 否 | 最多请求几条线路；不填为全部 |
| `device_id` | 否 | 固定设备号；不填用内置默认值 |
| `key` | 否 | 控制面 AES 密钥；不填自动探测 |
| `code` | 否 | 邀请码；不填用 App 的默认值 |

也可以直接指定 `apk_url` 或 `apk_path` 跳过官网发现。

## 运行时序

```
官网首页 → 下载页 chunk → cdn.js
        → 候选 APK 地址（按发布间隔回退几个槽位）
        → APK：包名 / 版本 / 签名证书 / 种子域名
        → /api/eversion       控制面密钥、api_links、api_lines
        → /myapi/eapilogin    会话 token
        → /myapi/eapiuserinfo 会员等级、unlimited 标志
        → /myapi/apinodelist  可点击的线路 id
        → /api/evmess?area=ID 每条线路一个 vmess 链接
```

`/myapi/apinodelist` 是唯一明文返回的接口，其余都是 AES-CBC（key 与 IV 相同）。

## APK 不是每次都取

包名、版本、证书、种子域名只在厂商发新版时变化，所以第一次运行后会把这份指纹写入
`$HOME/.auto-vpn/brand-fingerprints/`。之后运行先拿缓存里的种子做 `/api/eversion`：

- 通了 → 不下载 APK，只走登录和节点流程
- 全都不通 → 说明厂商换了域名，这时才重新下载并解析 APK，然后覆盖缓存

实测同一台机器：首次约 13 秒（含 22 MB 下载），命中缓存约 6 秒。

## 平台差异

| | Android | iOS |
|---|---|---|
| 响应 | `vmess://<base64>` | `ps\|<v2ray 配置>` |
| 单条体积 | 约 384 B | 约 2944 B |
| `kbox` | APK 里无条件拼上 | 不带 |

`kbox` 是白盒 AES 产出的防篡改参数，本实现不带它也能拿到节点：缺少 `kbox` 时服务端
仍按 `apps`（`MD5(证书 SHA1 + 设备号)`）签发真实节点。这样 Node 侧不必移植白盒算法。

## 已知限制

**黑洞的 Android 通道返回占位节点。** `/api/evmess` 对 `platform=android` 一律返回
`1.1.1.1:443` 模板，`area` 被忽略；同一账号的 iOS 通道正常。同一台服务器上
`/api/rules` 和 `/myapi/apinodelist` 对相同的 Android 参数完全正常，所以降级只发生在这一个接口。
需要黑洞节点时把该 source 的 `platform` 设成 `ios`。

## 与旧模式的兼容

没有 `mode` 字段的 source 仍按 `url` 模式处理；带 `account` 而没有 `url` 的 source 自动按
`credential` 模式处理。旧 profile 不需要改。
