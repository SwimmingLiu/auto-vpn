# nodesCatch 测速相关分析

## 说明

本文基于对 `nodesCatch.exe` 的静态分析，以及当前目录下的配置文件、生成文件和相关内核文件进行整理，目的是说明：

- `nodesCatch` 实际使用了哪些测速地址
- 程序如何实现延迟测速与下载测速
- 当前这份包默认走的是哪一套测速流程
- 旧版与新版测速实现的区别

分析时间：2026-04-24  
分析目录：`D:\VPN\nodesCatch-V2.0-2023`

---

## 一、实际使用的测速地址

### 1. 当前目录下配置指定的测速地址

当前程序实际读取的是根目录下的 `nodeConfig.json`，对应关键配置如下：

- `speedTestUrl`: `https://raw.githubusercontent.com/bulianglin/demo/main/10MB.bin`
- `speedPingTestUrl`: `http://www.gstatic.com/generate_204`

也就是说，当前这份程序中：

- 下载测速目标是 GitHub Raw 上的 `10MB.bin`
- 延迟测速目标是 Google 的 `generate_204`

### 2. 程序内置默认值

即使配置文件缺失，程序内部也会回落到以下默认值：

- 下载测速默认值：`https://raw.githubusercontent.com/bulianglin/demo/main/10MB.bin`
- 延迟测速默认值：`http://www.gstatic.com/generate_204`

### 3. 历史版本中出现过的测速地址

在子目录 `nodesCatch-V2.0\nodeConfig.json` 中，旧包配置里还能看到旧的下载测速地址：

- `http://cachefly.cachefly.net/10mb.test`

这说明该工具早期版本曾使用 `cachefly` 的测试文件作为下载测速源，后来切换到了 GitHub Raw。

### 4. 不是测速站点，但参与测速流程的本地服务

以下地址不是外部测速目标，但属于测速链路中的关键组成部分：

- `http://127.0.0.1:25500/sub?target=clash&url=temp.txt&insert=false&list=true`
- `http://127.0.0.1:40001/proxies/{name}/delay?timeout={timeout}&url={url}`
- `http://127.0.0.1:40001/proxies/GLOBAL`
- `http://127.0.0.1:40001/configs`

这些地址分别用于：

- 调用 `subconverter` 生成 Clash 配置
- 调用 Clash API 测延迟
- 切换当前全局代理节点
- 切换 Clash 使用的配置文件

---

## 二、当前包默认走的是哪一套测速逻辑

当前根目录 `nodeConfig.json` 中的关键参数如下：

- `coreType = 2`
- `localPort = 40000`
- `externalControllerPort = 40001`
- `externalController = 127.0.0.1:40001`
- `ThreadNum = 0`
- `DownloadThreadNum = 0`

结合程序逻辑可知：

- `ThreadNum = 0` 时，延迟测速走旧方案 `RunRealPing`
- `DownloadThreadNum = 0` 时，下载测速走旧方案 `RunSpeedTest`
- 这套旧方案依赖 `clash-nodes.exe + Clash 控制接口 + subconverter`

因此，**当前这份包默认并不是走新版 Xray 多线程测速，而是走旧版 Clash 测速流程。**

---

## 三、测速实现概览

程序里实际存在两套测速实现：

### 方案 A：旧版 Clash 测速方案

适用条件：

- `ThreadNum = 0` 或 `DownloadThreadNum = 0`

核心思路：

1. 把选中的节点转换成 Clash 配置
2. 让 Clash 加载这份测速专用配置
3. 通过 Clash 的本地控制接口切换当前节点
4. 用 Clash 的延迟接口测 `generate_204`
5. 或者通过 Clash 的本地 HTTP 代理去下载测试文件，统计速度

### 方案 B：新版 Xray 多线程测速方案

适用条件：

- `ThreadNum != 0` 或 `DownloadThreadNum != 0`

核心思路：

1. 程序动态生成一份 Xray 测速配置
2. 为每个节点创建一个独立的本地 HTTP 代理端口
3. 启动 `xray-nodes.exe`
4. 每个待测节点通过各自的本地代理并发发起测速请求
5. 分别统计延迟或下载速度

---

## 四、旧版 Clash 测速方案的实现细节

### 1. 生成测速专用 Clash 配置

程序会先把选中的节点导出到：

- `subconverter\temp.txt`

随后访问本地 `subconverter`：

- `http://127.0.0.1:25500/sub?target=clash&url=temp.txt&insert=false&list=true`

生成结果写入：

- `subconverter\temp.yaml`

这份 `temp.yaml` 就是 Clash 测速时实际加载的配置文件。

### 2. 切换 Clash 到测速配置

程序接着通过 Clash API：

- `PUT http://127.0.0.1:40001/configs`

把配置切换到刚生成的 `temp.yaml`。

之后还会继续调用：

- `PATCH http://127.0.0.1:40001/configs`

设置：

- HTTP 代理端口为 `40000`
- 代理模式为 `Global`

### 3. Clash 中的测速节点命名方式

在生成的 `temp.yaml` 里，每个代理名会被改成数字形式，例如：

- `50001`
- `50002`
- `50003`

这也是程序后续调用 Clash API 时使用的代理名。

### 4. 延迟测速实现

旧版延迟测速会访问：

`http://127.0.0.1:40001/proxies/{name}/delay?timeout={timeout}&url=http://www.gstatic.com/generate_204`

其中：

- `{name}` 是 Clash 中的代理名，如 `50001`
- `{timeout}` 来自配置中的 `Timeout`
- `url` 是 `speedPingTestUrl`

程序拿到返回结果后，用正则提取 `delay` 数值，最终显示为：

- `xxxms`

如果返回包含：

- `504`，程序显示 `超时`
- `503`，程序显示 `无法连接`

### 5. 下载测速实现

旧版下载测速不是直接访问节点，而是先通过 Clash API 切换全局代理到当前节点：

- `PUT http://127.0.0.1:40001/proxies/GLOBAL`

切换成功后，程序创建本地代理：

- `127.0.0.1:40000`

然后通过这个本地代理去下载测速文件：

- `https://raw.githubusercontent.com/bulianglin/demo/main/10MB.bin`

测速实现使用的是 `WebClient.DownloadDataAsync`，程序通过下载进度事件持续统计：

- 当前速度
- 平均速度
- 峰值速度
- 下载百分比

界面上会显示类似：

- `正在下载...|`
- `12.34%|1.69 MB/s`
- 最终平均速度与峰值速度

---

## 五、新版 Xray 多线程测速方案的实现细节

### 1. 动态生成 Xray 测速配置

程序会调用内部的 `GenerateClientSpeedtestConfigString` 动态生成测速专用 Xray 配置。

生成逻辑的关键点：

- 基于内置的 `SampleClientConfig`
- 为每个被选中的节点创建一个独立 HTTP 入站
- 每个入站监听在 `127.0.0.1`
- 端口从 `GetLocalPort("speedtest") + 节点索引` 计算得出

其中：

- `GetLocalPort("speedtest") = localPort + 10001`
- 当前 `localPort = 40000`
- 所以基准测速端口是 `50001`

这也解释了为什么旧版生成的 Clash 配置里代理名会大量出现 `50001`、`50002` 这样的编号。

### 2. 启动方式

程序通过：

- `xray-nodes.exe -config stdin:`

把动态生成的测速配置直接通过标准输入送给 Xray 启动。

### 3. 新版延迟测速实现

新版延迟测速不再调用 Clash 的 `/delay` 接口，而是：

1. 为某个节点创建 `WebProxy("127.0.0.1", 对应端口)`
2. 用 `HttpWebRequest` 通过这个代理访问：
   - `http://www.gstatic.com/generate_204`
3. 用 `Stopwatch` 统计总耗时

程序接受 `200` 或 `204` 作为正常返回。

如果测不到，则返回：

- `-1`，最终显示为 `超时`

### 4. 新版下载测速实现

新版下载测速同样是：

1. 为每个节点创建独立本地代理端口
2. 使用 `WebProxy("127.0.0.1", 对应端口)`
3. 通过这个代理下载测速文件
4. 用 `WebClient` 的进度回调统计速度

与旧版相比，新版的主要区别是：

- 不再反复切换 `GLOBAL`
- 每个节点都有自己的本地代理端口
- 可以真正并发测速

---

## 六、速度统计方式

无论旧版还是新版，下载测速都采用类似的统计方式：

### 1. 实时速度

程序每隔约 1 秒比较：

- 当前累计下载字节数
- 上一次记录的字节数

计算出这一秒的下载速度。

显示规则：

- 大于 `1024 KB/s` 时显示为 `MB/s`
- 否则显示为 `KB/s`

### 2. 平均速度

程序在下载结束时按：

- 总下载字节数 / 总耗时

计算平均速度。

### 3. 峰值速度

程序在下载过程中持续记录每秒最高值，作为 `MaxSpeed`。

---

## 七、Fast Mode 机制

当前配置中：

- `fastMode = true`
- `FMSecond = 5`
- `FMave = 10`
- `FMmax = 300`

程序逻辑是：

1. 下载测速最多等待 `timeout` 秒
2. 如果开启 `fastMode`
3. 到第 `FMSecond` 秒时检查当前下载情况
4. 当下载进度大于等于 `FMave`
5. 且峰值速度小于 `FMmax`
6. 则提前终止下载

结合代码看，这套逻辑的目的主要是：

- 快速跳过明显很慢的节点
- 避免某些差节点长期占用测速线程

当前这份配置对应的含义大致可理解为：

- 测到第 5 秒时
- 如果下载进度已经到 10%
- 但峰值速度仍然低于 300 KB/s
- 就提前取消本次测速

---

## 八、当前包的关键结论

### 1. 当前外部测速目标只有两个

- 下载测速：`https://raw.githubusercontent.com/bulianglin/demo/main/10MB.bin`
- 延迟测速：`http://www.gstatic.com/generate_204`

### 2. 历史上还出现过一个旧下载测速源

- `http://cachefly.cachefly.net/10mb.test`

### 3. 当前这份包默认走的是旧版 Clash 测速流程

原因是：

- `ThreadNum = 0`
- `DownloadThreadNum = 0`

### 4. 程序内部确实保留了新版 Xray 并发测速能力

只要把：

- `ThreadNum`
- `DownloadThreadNum`

改成非 `0`，程序就会切换到新版 `RunRealPing2 / RunSpeedTest2` 逻辑。

### 5. 延迟测速和下载测速不是网页前端测速

它不是打开浏览器或网页测速页面，而是：

- 通过本地代理程序转发请求
- 直接请求固定 URL
- 自己统计响应时间和下载速度

---

## 九、相关文件索引

本次分析涉及的主要文件如下：

- `nodesCatch.exe`
- `nodeConfig.json`
- `nodesCatch-V2.0\nodeConfig.json`
- `subconverter\temp.yaml`
- `xray-nodes.exe`
- `clash-nodes.exe`
- `config\config.yaml`

其中最关键的是：

- `nodeConfig.json`：决定当前实际测速 URL 和测速模式
- `subconverter\temp.yaml`：旧版 Clash 测速时实际加载的测速节点配置
- `nodesCatch.exe`：测速主逻辑所在

---

## 十、简版结论

`nodesCatch` 的测速核心不是“访问某个测速网页”，而是“通过本地代理内核访问固定 URL 并自行统计结果”。

当前这份包中实际使用的测速目标是：

- `https://raw.githubusercontent.com/bulianglin/demo/main/10MB.bin`
- `http://www.gstatic.com/generate_204`

默认流程是：

1. 先把节点转成 Clash 配置
2. 让 Clash 加载测速配置
3. 延迟测速时调用 Clash 的 `/delay` 接口
4. 下载测速时让本地 HTTP 代理去下载 `10MB.bin`
5. 程序自己计算平均速度、瞬时速度和峰值速度

如果启用多线程新模式，则会改成：

1. 生成 Xray 测速配置
2. 给每个节点创建独立本地代理端口
3. 直接通过各自端口并发访问 `generate_204` 或 `10MB.bin`
4. 自行统计延迟与速度

