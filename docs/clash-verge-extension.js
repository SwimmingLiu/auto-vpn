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

// 已经注入过就原样返回，避免脚本重复执行时叠加。
//
// 判据不能是「分组名精确等于 EXIT_GROUP」：订阅里若本来就有个节点叫
// 「🛡️ 静态IP出口」，注入时分组会被改名成「🛡️ 静态IP出口 2」，下一轮就
// 认不出来，于是每次订阅更新都再注入一遍，节点和分组越滚越多。
// 所以既接受 EXIT_GROUP 本身，也接受它加后缀的形态。
function 已注入(分组列表, 候选名) {
  return 分组列表.some((g) => {
    if (!g || typeof g.name !== 'string') return false;
    if (g.name === 候选名) return true;
    return g.name.startsWith(`${候选名} `) && /^\d+$/.test(g.name.slice(候选名.length + 1));
  });
}


function main(config) {
  if (!config || typeof config !== 'object') return config;
  if (!Array.isArray(config.proxies) || config.proxies.length === 0) return config;

  const 现有节点 = new Set(config.proxies.map((p) => p && p.name).filter(Boolean));
  const 现有分组 = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [];

  // 已经注入过就原样返回，避免脚本重复执行时叠加。
  //
  // 判据是出口组存在：分组名可能因避让改成 `… 2`，所以按「EXIT_GROUP 或它加
  // 数字后缀」认。用户可能在界面上删了分组但节点还在，那种情况不早退——下面
  // 会靠命名避让把缺的东西补齐，不会重复。
  if (已注入(现有分组, EXIT_GROUP)) return config;

  const 出口清单 = STATIC_EXITS.map(解析出口).filter((e) => e.server && e.port > 0);
  if (出口清单.length === 0) return config;

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

  const 机场节点 = config.proxies
    .map((p) => p && p.name)
    .filter((名) => typeof 名 === 'string' && 名 && !名.includes(SEP) && !名.endsWith(TWIN_SUFFIX));

  // 判断某个节点是不是本脚本上一轮注入的那条出口：类型、地址都一致，
  // 且名字是「配置名」或「配置名 数字」——链式节点带 SEP 后缀，不算。
  const 是已注入的出口 = (p, 出口) => {
    if (!p || typeof p !== 'object' || typeof p.name !== 'string') return false;
    if (p.server !== 出口.server || Number(p.port) !== Number(出口.port)) return false;
    if (p.name.includes(SEP) || p.name.endsWith(TWIN_SUFFIX)) return false;
    return p.name === 出口.name || p.name.startsWith(`${出口.name} `);
  };

  const 新节点 = [];
  const 出口名 = new Map();
  for (const 出口 of 出口清单) {
    // 这个出口已经注入过（用户删掉了分组、节点还在）就复用它的名字，不再加
    // 一份——否则每删一次分组就多一对节点。
    const 已有 = config.proxies.find((p) => 是已注入的出口(p, 出口));
    if (已有) {
      出口名.set(出口, 已有.name);
      continue;
    }
    const 名称 = 唯一(出口.name);
    出口名.set(出口, 名称);
    新节点.push({ ...出口, name: 名称 });
  }

  const 链式名 = [];
  if (MODE !== 'direct' && 机场节点.length > 0) {
    if (MODE === 'all') {
      for (const 出口 of 出口清单) {
        for (const 入口 of 机场节点) {
          const 期望名 = `${入口}${SEP}${出口名.get(出口)}`;
          // 按名字认，不校验 dialer-proxy：入口组可能因避让换过名字，
          // 旧链式节点的指向会与这一轮算出来的不同，但节点本身还是那条。
          const 已有 = config.proxies.find((p) => p && typeof p === 'object' && typeof p.name === 'string'
            && (p.name === 期望名 || p.name.startsWith(`${期望名} `)));
          if (已有) { 链式名.push(已有.name); continue; }
          const 名称 = 唯一(期望名);
          新节点.push({ ...出口, name: 名称, 'dialer-proxy': 入口 });
          链式名.push(名称);
        }
      }
    } else {
      for (const 出口 of 出口清单) {
        const 期望名 = `${出口名.get(出口)}${TWIN_SUFFIX}`;
        const 已有 = config.proxies.find((p) => p && typeof p === 'object' && typeof p.name === 'string'
          && (p.name === 期望名 || p.name.startsWith(`${期望名} `)));
        if (已有) { 链式名.push(已有.name); continue; }
        const 名称 = 唯一(期望名);
        新节点.push({ ...出口, name: 名称, 'dialer-proxy': 入口组名 });
        链式名.push(名称);
      }
    }
  }

  config.proxies = [...config.proxies, ...新节点];

  const 出口分组 = {
    name: 出口组名,
    type: 'select',
    proxies: [...链式名, ...出口清单.map((e) => 出口名.get(e)), 'DIRECT'],
  };
  const 新分组 = [出口分组];
  if (链式名.length > 0 && MODE !== 'all') {
    新分组.push({ name: 入口组名, type: 'select', proxies: [...机场节点, 'DIRECT'] });
  }

  // 让每个 select 分组都能直接选到出口分组，不改变原有顺序与默认项。
  const 分组副本 = 现有分组.map((g) => {
    if (!g || typeof g !== 'object') return g;
    if (g.type !== 'select') return g;
    if (g.name === 出口组名 || g.name === 入口组名) return g;
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
