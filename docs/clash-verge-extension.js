// ============================================================================
// Clash Verge Rev「扩展脚本」：每次订阅更新后自动注入静态 IP 出口 + 链式代理
//
// 用法：订阅卡片右键 → 编辑扩展脚本 / 或「订阅」页右上角新建脚本，把本文件
// 内容整段贴进去，保存后重新激活订阅即可。脚本独立保存，订阅更新时自动重跑。
//
// 出口地址只存在这个本地文件里，不会随订阅地址外流。
// ============================================================================

// ---- 配置区：改这里 ----------------------------------------------------------

// 固定 IP 出口。支持 socks5 / http / https，多个出口就写多条。
const STATIC_EXITS = [
  {
    name: '🇭🇰 香港静态IP',
    type: 'socks5',
    server: '198.51.100.10',
    port: 1080,
    username: 'USER',
    password: 'PASS',
    udp: true,
  },
];

// 出口分组名（在 Clash Verge 里手动选哪个出口）
const EXIT_GROUP = '🛡️ 静态IP出口';
// 入口分组名（在 Clash Verge 里选中转的机场节点）
const ENTRANCE_GROUP = '🛬 静态IP入口';

// 'chain'  : 一条链式节点 + 入口分组（推荐，节点数不膨胀）
// 'all'    : 每个机场节点各配一条链式节点（直接选「US 421 ➜ 香港静态IP」）
// 'direct' : 只注入出口节点，不建链式节点
const MODE = 'chain';

// 命中这些规则的流量改走出口分组；留空则不改规则，只在界面里手动选。
const RULES_TO_EXIT = [];

// 出口分组挂进哪些 select 分组。写主选择器的名字就够了，比如 ['🚀 节点选择']：
// 其它分组大多指向它，挂到每个分组上会让同一件事有好几个地方能改，看着像重复。
// 留空 = 所有 select 分组。
const EXIT_GROUP_TARGETS = ['🚀 节点选择'];

// ---- 以下不用改 --------------------------------------------------------------

const SEP = ' ➜ ';
const TWIN_SUFFIX = '（链式）';

// mihomo 只认这几个类型名。`socks5h` / `https` 是 URI 写法里的叫法，直接写进
// 配置会让 mihomo 报 `unsupport proxy type` 并拒绝整份文件，所以在这里归一。
const 类型映射 = {
  socks5: 'socks5',
  socks5h: 'socks5',
  socks: 'socks5',
  http: 'http',
  https: 'http',
  'http+tls': 'http',
};

function 解析出口(条目) {
  const 原始类型 = String(条目.type || 'socks5').toLowerCase();
  const 出口 = {
    name: String(条目.name || `${条目.server}:${条目.port}`),
    type: 类型映射[原始类型] || 原始类型,
    server: 条目.server,
    port: Number(条目.port),
  };
  // `https://` 与 `http+tls` 走的是带 TLS 的 HTTP 代理，缺了 tls 会被
  // 当成明文 HTTP 连过去，握手直接失败。
  if (条目.tls || 原始类型 === 'https' || 原始类型 === 'http+tls') 出口.tls = true;
  if (条目.username !== undefined) 出口.username = 条目.username;
  if (条目.password !== undefined) 出口.password = 条目.password;
  if (条目['skip-cert-verify']) 出口['skip-cert-verify'] = true;
  if (条目.udp !== undefined) 出口.udp = Boolean(条目.udp);
  else if (出口.type === 'socks5') 出口.udp = true;
  return 出口;
}

// 分组名可能因避让改成 `EXIT_GROUP 2`。这两组分组归脚本所有：每一轮都先摘掉
// 再重建，所以认家族名就够了。
function 家族内(名, 基础名) {
  if (typeof 名 !== 'string') return false;
  if (名 === 基础名) return true;
  return 名.startsWith(`${基础名} `) && /^\d+$/.test(名.slice(基础名.length + 1));
}

// 注入的节点和分组都带上这个标记。mihomo 不认的字段会被忽略（`mihomo -t` 可过），
// 但下一轮能凭它精确认出「这是我们上一轮加的东西」，不必靠名字猜。
// 旧版本注入的没带标记，所以名字形态还要留一套兜底。
const 标记 = '__static_exit';

function 转义(文本) {
  return String(文本).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 节点是不是上一轮注入的出口。优先看标记；没有标记时按名字形态认：
// `出口名`、`出口名 2`、`出口名（链式）`、`入口 ➜ 出口名`，以及它们的数字后缀。
// 地址也必须对上，避免误删订阅里同名但指向别处的节点。
function 是我们注入的节点(节点, 出口) {
  if (!节点 || typeof 节点 !== 'object' || typeof 节点.name !== 'string') return false;
  if (节点[标记] === true) return true;
  if (节点.server !== 出口.server || Number(节点.port) !== Number(出口.port)) return false;
  const 形态 = new RegExp(
    `^(?:.+${转义(SEP)})?${转义(出口.name)}(?: \\d+)?(?:${转义(TWIN_SUFFIX)})?(?: \\d+)?$`,
  );
  return 形态.test(节点.name);
}

// 摘掉上一轮注入的所有东西，让 main() 每一轮都从订阅原样重建。
//
// 早退式的「已注入就不动」在用户删掉其中一个分组、或订阅换了节点时会留下悬空
// 引用：链式节点的 dialer-proxy 指着已删的入口组，select 分组的成员指着已删的
// 出口组，mihomo 一律报 not found 并拒收整份配置。整轮重建把这些状态全部
// 收敛掉，重复执行的结果也完全一致。
function 摘掉上一轮(config, 出口清单) {
  const 分组 = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [];
  const 节点 = (Array.isArray(config.proxies) ? config.proxies : [])
    .filter((p) => !(p && typeof p === 'object'
      && (p[标记] === true || 出口清单.some((出口) => 是我们注入的节点(p, 出口)))));
  // 被删掉的节点名要从分组成员里一起摘掉，否则分组指向不存在的节点，
  // mihomo 同样拒收整份配置。
  const 删掉的 = new Set(
    (Array.isArray(config.proxies) ? config.proxies : [])
      .map((p) => (p && typeof p === 'object' ? p.name : undefined))
      .filter((名) => typeof 名 === 'string' && !节点.some((p) => p && p.name === 名)),
  );
  const 保留 = 分组
    .filter((g) => !(g && typeof g === 'object' && (g[标记] === true
      || 家族内(g.name, EXIT_GROUP) || 家族内(g.name, ENTRANCE_GROUP))))
    .map((g) => {
      if (!g || typeof g !== 'object' || !Array.isArray(g.proxies)) return g;
      const 成员 = g.proxies.filter((m) => !删掉的.has(m)
        && !家族内(m, EXIT_GROUP) && !家族内(m, ENTRANCE_GROUP));
      return 成员.length === g.proxies.length ? g : { ...g, proxies: 成员 };
    });
  // RULES_TO_EXIT 每一轮都会重新加，先把上一轮的摘掉，否则规则越叠越多；
  // 分组改名后旧规则还会指向不存在的名字（或更糟：指向同名的别的节点）。
  const 规则 = Array.isArray(config.rules) ? config.rules.filter((行) => {
    const 文本 = String(行);
    const 位 = 文本.lastIndexOf(',');
    if (位 < 0) return true;
    return !家族内(文本.slice(位 + 1), EXIT_GROUP);
  }) : config.rules;
  const 结果 = { ...config, proxies: 节点, 'proxy-groups': 保留 };
  if (Array.isArray(config.rules)) 结果.rules = 规则;
  return 结果;
}


function main(config) {
  if (!config || typeof config !== 'object') return config;
  if (!Array.isArray(config.proxies) || config.proxies.length === 0) return config;

  const 出口清单 = STATIC_EXITS.map(解析出口).filter((e) => e.server && e.port > 0);
  // 出口被清空：把上一轮注入的节点、分组、规则一并摘掉，别让一个已经不用的
  // 出口继续留在配置里。
  if (出口清单.length === 0) return 摘掉上一轮(config, 出口清单);

  // 每一轮都摘掉上一轮注入的东西，再从订阅原样重建。
  config = 摘掉上一轮(config, 出口清单);

  const 现有节点 = new Set(config.proxies.map((p) => p && p.name).filter(Boolean));
  const 现有分组 = config['proxy-groups'];

  const 已占 = new Set([...现有节点, ...现有分组.map((g) => g && g.name).filter(Boolean)]);
  const 唯一 = (候选) => {
    let 名称 = 候选;
    let 序号 = 2;
    while (已占.has(名称)) {
      名称 = `${候选} ${序号}`;
      序号 += 1;
    }
    已占.add(名称);
    return 名称;
  };

  // 分组名同样不能和节点重名，mihomo 会判 the duplicate name。
  const 出口组名 = 唯一(EXIT_GROUP);
  const 入口组名 = 唯一(ENTRANCE_GROUP);

  // 摘掉上一轮之后，剩下的都是订阅自己的节点。名字里带 ` ➜ ` 的也能当入口：
  // 有些机场本来就用这种名字，按名字过滤会把它们全部错杀。
  const 机场节点 = config.proxies
    .map((p) => p && p.name)
    .filter((名) => typeof 名 === 'string' && 名);

  // 出口名先定下来：链式节点的名字由它拼出来，避让规则要和它一致。
  const 出口名 = new Map();
  for (const 出口 of 出口清单) 出口名.set(出口, 唯一(出口.name));
  const 全部出口名 = [...出口名.values()];

  // MODE = 'direct' 只注入出口节点；chain / all 只注入链式节点。直连出口是一个
  // 把本机 IP 直接交给出口服务商的开关，选错一次就绕过了整条链，所以链式模式
  // 下连选项都不留。
  const 新节点 = [];
  const 链式名 = [];
  if (MODE === 'direct') {
    for (const 出口 of 出口清单) 新节点.push({ ...出口, name: 出口名.get(出口), [标记]: true });
  } else if (机场节点.length > 0) {
    if (MODE === 'all') {
      for (const 出口 of 出口清单) {
        for (const 入口 of 机场节点) {
          新节点.push({ ...出口, name: 唯一(`${入口}${SEP}${出口名.get(出口)}`), 'dialer-proxy': 入口, [标记]: true });
        }
      }
    } else {
      for (const 出口 of 出口清单) {
        新节点.push({ ...出口, name: 唯一(`${出口名.get(出口)}${TWIN_SUFFIX}`), 'dialer-proxy': 入口组名, [标记]: true });
      }
    }
    for (const 节点 of 新节点) 链式名.push(节点.name);
  } else {
    // 要链式却连一个上一跳都没有：这一次什么都不注入，配置保持摘掉后的原样。
    // 退回直连正好是这个脚本要堵的那道门，宁可这一轮没有出口。
    return config;
  }

  config.proxies = [...config.proxies, ...新节点];

  const 出口分组 = {
    name: 出口组名,
    type: 'select',
    proxies: MODE === 'direct' ? [...全部出口名, 'DIRECT'] : [...链式名],
    [标记]: true,
  };
  const 新分组 = [出口分组];
  if (MODE !== 'direct' && MODE !== 'all') {
    // 入口组同样不给 DIRECT：入口选 DIRECT 等于把本机 IP 当作上一跳，
    // 和直连出口是一回事。
    新分组.push({ name: 入口组名, type: 'select', proxies: [...机场节点], [标记]: true });
  }

  // 让 select 分组能直接选到出口分组，不改变原有顺序与默认项。
  // EXIT_GROUP_TARGETS 非空时只挂到点名的那些分组。
  // 字符串写错成单个名字时也当一项，不要悄悄退化成「所有分组」。
  const 目标清单 = typeof EXIT_GROUP_TARGETS === 'string'
    ? [EXIT_GROUP_TARGETS]
    : Array.isArray(EXIT_GROUP_TARGETS)
      ? EXIT_GROUP_TARGETS.filter((名) => typeof 名 === 'string' && 名)
      : [];
  const 目标分组 = 目标清单.length > 0 ? new Set(目标清单) : null;
  const 分组副本 = 现有分组.map((g) => {
    if (!g || typeof g !== 'object') return g;
    if (g.type !== 'select') return g;
    if (目标分组 && !目标分组.has(g.name)) return g;
    const 成员 = Array.isArray(g.proxies) ? g.proxies : [];
    if (成员.includes(出口组名)) return g;
    return { ...g, proxies: [...成员, 出口组名] };
  });
  config['proxy-groups'] = [...分组副本, ...新分组];

  if (Array.isArray(RULES_TO_EXIT) && RULES_TO_EXIT.length > 0) {
    // 规则里写的是配置区的分组名，但分组可能因避让改了名（`… 2`）。
    // 规则格式是 `TYPE,payload,TARGET`，目标永远是最后一个逗号之后那段，
    // 所以只替换尾段，不碰域名/进程名里可能出现的同名字符串。
    const 改目标 = (规则行) => {
      const 文本 = String(规则行);
      const 位 = 文本.lastIndexOf(',');
      if (位 < 0) return 文本;
      const 目标 = 文本.slice(位 + 1);
      if (目标 !== EXIT_GROUP) return 文本;
      return `${文本.slice(0, 位 + 1)}${出口组名}`;
    };
    const 规则 = Array.isArray(config.rules) ? config.rules : [];
    config.rules = [...RULES_TO_EXIT.map(改目标), ...规则];
  }

  return config;
}
