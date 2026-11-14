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

function 解析出口(条目) {
  const 出口 = {
    name: String(条目.name || `${条目.server}:${条目.port}`),
    type: String(条目.type || 'socks5').toLowerCase(),
    server: 条目.server,
    port: Number(条目.port),
  };
  if (条目.username !== undefined) 出口.username = 条目.username;
  if (条目.password !== undefined) 出口.password = 条目.password;
  if (条目.tls) 出口.tls = true;
  if (条目['skip-cert-verify']) 出口['skip-cert-verify'] = true;
  if (条目.udp !== undefined) 出口.udp = Boolean(条目.udp);
  else if (出口.type === 'socks5') 出口.udp = true;
  return 出口;
}

function main(config) {
  if (!config || typeof config !== 'object') return config;
  if (!Array.isArray(config.proxies) || config.proxies.length === 0) return config;

  const 现有节点 = new Set(config.proxies.map((p) => p && p.name).filter(Boolean));
  const 现有分组 = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [];

  // 已经注入过就原样返回，避免脚本重复执行时叠加。
  if (现有分组.some((g) => g && g.name === EXIT_GROUP)) return config;

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
    .filter((名) => 名 && !名.includes(SEP) && !名.endsWith(TWIN_SUFFIX));

  const 新节点 = [];
  const 出口名 = new Map();
  for (const 出口 of 出口清单) {
    const 名称 = 唯一(出口.name);
    出口名.set(出口, 名称);
    新节点.push({ ...出口, name: 名称 });
  }

  const 链式名 = [];
  if (MODE !== 'direct' && 机场节点.length > 0) {
    if (MODE === 'all') {
      for (const 出口 of 出口清单) {
        for (const 入口 of 机场节点) {
          const 名称 = 唯一(`${入口}${SEP}${出口名.get(出口)}`);
          新节点.push({ ...出口, name: 名称, 'dialer-proxy': 入口 });
          链式名.push(名称);
        }
      }
    } else {
      for (const 出口 of 出口清单) {
        const 名称 = 唯一(`${出口名.get(出口)}${TWIN_SUFFIX}`);
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

  if (Array.isArray(RULES_TO_EXIT) && RULES_TO_EXIT.length > 0 && Array.isArray(config.rules)) {
    config.rules = [...RULES_TO_EXIT, ...config.rules];
  }

  return config;
}
