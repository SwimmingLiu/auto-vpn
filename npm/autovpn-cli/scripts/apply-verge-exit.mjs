#!/usr/bin/env node
// 把本机的静态出口地址写进 Clash Verge 的扩展脚本。
//
// 说明：Clash Verge 的扩展脚本运行在沙箱里，没有文件系统权限，所以出口地址
// 必须以字面量的形式出现在 `profiles/<uid>.js` 里。这个脚本负责那一步搬运：
//
//   你写 → ~/.auto-vpn/verge-exit.txt   （600 权限，一行一个 URI）
//   它改 → ~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/profiles/<uid>.js
//          只替换 `const STATIC_EXITS = [ … ];` 这一段
//
// 改的是已经装好的脚本，不是拿仓库模板整个覆盖过去：`MODE`、`RULES_TO_EXIT`
// 这些你在 Verge 里调过的值必须留着。
//
// 全程不打印用户名和密码，只打印脱敏后的 `类型://***@host:port`。仓库里的模板
// 保持占位值不变，所以凭证不会进入 git，也不会进入任何对话记录。
//
// 用法：
//   node scripts/apply-verge-exit.mjs              # 读取并写入
//   node scripts/apply-verge-exit.mjs --check      # 只解析和校验，不写
//   node scripts/apply-verge-exit.mjs --test       # 写入前先测一次出口
//   node scripts/apply-verge-exit.mjs --from <文件> --out <脚本>
//
// 出口文件格式（`#` 前面是地址，后面是显示名；空行和 `//` 开头的行忽略）：
//   socks5://USER:PASS@203.0.113.7:1080#🇭🇰 香港静态IP
//   socks5h://USER:PASS@203.0.113.7:1081

import { readFileSync, writeFileSync, copyFileSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// 和扩展脚本里的 `类型映射` 保持一致。URI 里的叫法（socks5h / https）不是
// mihomo 的代理类型名，写进配置会让内核拒绝整份文件。
const 类型映射 = {
  socks5: 'socks5',
  socks5h: 'socks5',
  socks: 'socks5',
  http: 'http',
  https: 'http',
  'http+tls': 'http',
};

const 默认端口 = { socks5: 1080, http: 80, https: 443 };

const 扩展脚本标记 = 'Clash Verge Rev「扩展脚本」';

// 解析一行 URI。返回的字段就是扩展脚本 `STATIC_EXITS` 里的一条记录。
//
// 不用 `new URL()`：非特殊协议下它把 authority 当成路径处理，`socks5://`
// 会被拆成 pathname，端口和用户名都丢；而且密码里出现未编码的 `@` 时它的
// 行为也和 curl 不一致。这里按 curl 的规则手工切。
export function 解析出口URI(原始行) {
  const 行 = String(原始行).trim();
  if (!行) throw new Error('空行');

  // 片段标识符就是显示名。密码里的 `#` 必须写成 %23，否则从这里被截断——
  // 这是 URI 的规定，不是这里的实现选择。
  const 井号 = 行.indexOf('#');
  // 显示名也按 URI 规则解码：直接贴进来的 `%E9%A6%99%E6%B8%AF` 会变成「香港」。
  const 名称 = 井号 >= 0 ? 解码(行.slice(井号 + 1).trim()) : '';
  const 主体 = 井号 >= 0 ? 行.slice(0, 井号) : 行;

  const 协议位 = 主体.indexOf('://');
  if (协议位 <= 0) throw new Error('缺少 协议:// 前缀');
  const 协议 = 主体.slice(0, 协议位).toLowerCase();
  if (!(协议 in 类型映射)) throw new Error(`不支持的协议 ${协议}（支持 socks5 / socks5h / socks / http / https）`);

  let 剩余 = 主体.slice(协议位 + 3);
  const 斜杠 = 剩余.indexOf('/');
  if (斜杠 >= 0) 剩余 = 剩余.slice(0, 斜杠);
  const 问号 = 剩余.indexOf('?');
  if (问号 >= 0) 剩余 = 剩余.slice(0, 问号);

  let 用户名 = '';
  let 密码 = '';
  let 主机端口 = 剩余;
  // 密码里的 `@` 未编码时按最后一个 `@` 切（curl 同此行为），所以用 lastIndexOf。
  const at = 剩余.lastIndexOf('@');
  if (at >= 0) {
    const 用户信息 = 剩余.slice(0, at);
    主机端口 = 剩余.slice(at + 1);
    const 冒号 = 用户信息.indexOf(':');
    if (冒号 >= 0) {
      用户名 = 用户信息.slice(0, 冒号);
      密码 = 用户信息.slice(冒号 + 1);
    } else {
      用户名 = 用户信息;
    }
    用户名 = 解码(用户名);
    密码 = 解码(密码);
  }
  let 主机 = 主机端口;
  let 端口文本 = '';
  if (主机端口.startsWith('[')) {
    const 右 = 主机端口.indexOf(']');
    if (右 < 0) throw new Error('IPv6 地址缺少右方括号');
    主机 = 主机端口.slice(0, 右 + 1);
    const 尾巴 = 主机端口.slice(右 + 1);
    if (尾巴.startsWith(':')) 端口文本 = 尾巴.slice(1);
    else if (尾巴) throw new Error('IPv6 地址后面多了内容');
  } else {
    const 冒号 = 主机端口.lastIndexOf(':');
    if (冒号 >= 0) {
      主机 = 主机端口.slice(0, 冒号);
      端口文本 = 主机端口.slice(冒号 + 1);
    }
  }

  if (!主机) throw new Error('缺少主机地址');
  const 端口 = 端口文本 === '' ? 默认端口[协议] : Number(端口文本);
  if (!Number.isInteger(端口) || 端口 <= 0 || 端口 > 65535) {
    throw new Error('端口不是 1-65535 的整数');
  }

  const 类型 = 类型映射[协议];
  const 出口 = {
    name: 名称 || `${主机}:${端口}`,
    type: 类型,
    server: 主机,
    port: 端口,
  };
  if (协议 === 'https' || 协议 === 'http+tls') 出口.tls = true;
  if (用户名) 出口.username = 用户名;
  if (密码) 出口.password = 密码;
  出口.udp = 类型 === 'socks5';
  return 出口;
}

function 解码(值) {
  try {
    return decodeURIComponent(值);
  } catch {
    // 密码里带未编码的 `%` 是合法输入，解码失败就按原样用。
    return 值;
  }
}

// 读整个出口文件。报错只说第几行，不把那一行的内容带出来。
export function 读取出口文件(文本) {
  const 结果 = [];
  String(文本)
    .split(/\r?\n/)
    .forEach((行, 序号) => {
      const 修剪 = 行.trim();
      if (!修剪 || 修剪.startsWith('//') || 修剪.startsWith('#')) return;
      try {
        结果.push(解析出口URI(修剪));
      } catch (错) {
        throw new Error(`第 ${序号 + 1} 行：${错.message}`);
      }
    });
  if (结果.length === 0) throw new Error('出口文件里没有有效地址');
  return 结果;
}

// 单引号字符串字面量。反斜杠和单引号必须转义，否则密码里的 `'` 会把脚本打断。
function 单引号(值) {
  return `'${String(值).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function 生成配置块(出口列表) {
  const 条目 = 出口列表.map((出口) => {
    const 行 = [
      `    name: ${单引号(出口.name)},`,
      `    type: ${单引号(出口.type)},`,
      `    server: ${单引号(出口.server)},`,
      `    port: ${出口.port},`,
    ];
    if (出口.username !== undefined) 行.push(`    username: ${单引号(出口.username)},`);
    if (出口.password !== undefined) 行.push(`    password: ${单引号(出口.password)},`);
    if (出口.tls) 行.push('    tls: true,');
    if (出口.udp !== undefined) 行.push(`    udp: ${出口.udp ? 'true' : 'false'},`);
    return `  {\n${行.join('\n')}\n  },`;
  });
  return `const STATIC_EXITS = [\n${条目.join('\n')}\n];`;
}

const 配置块正则 = /^const STATIC_EXITS = \[[\s\S]*?^\];$/m;

export function 替换配置块(模板文本, 新块) {
  if (!配置块正则.test(模板文本)) {
    throw new Error('脚本里找不到 `const STATIC_EXITS = [` … `];` 这一段（旧版扩展脚本？把模板重新贴一次再跑）');
  }
  return 模板文本.replace(配置块正则, () => 新块);
}

// 日志里唯一允许出现的出口形态。
export function 脱敏(出口) {
  const 凭证 = 出口.username || 出口.password ? '***@' : '';
  return `${出口.type}://${凭证}${出口.server}:${出口.port}`;
}

function 找Verge脚本() {
  const 目录 = join(
    homedir(),
    'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/profiles',
  );
  if (!existsSync(目录)) return null;
  const 命中 = readdirSync(目录)
    .filter((名) => 名.endsWith('.js'))
    .map((名) => join(目录, 名))
    .filter((路径) => {
      try {
        return readFileSync(路径, 'utf8').includes(扩展脚本标记);
      } catch {
        return false;
      }
    });
  if (命中.length === 1) return 命中[0];
  if (命中.length > 1) {
    throw new Error(`找到多个扩展脚本，用 --out 指定一个：\n${命中.map((p) => `  ${p}`).join('\n')}`);
  }
  return null;
}

// 按解析结果重新拼一个 curl 能认的代理地址。不能直接把用户写的那行交给 curl：
// 密码里的 `@` 未编码时我们的解析器按最后一个 `@` 切（和 curl 一致），但 `:` /
// `#` 未编码时 curl 会切错。这里统一 encodeURIComponent 一遍。
export function curl代理地址(出口) {
  const 协议 = 出口.type === 'http' ? (出口.tls ? 'https' : 'http') : 'socks5h';
  let 凭证 = '';
  if (出口.username !== undefined) {
    凭证 = encodeURIComponent(出口.username);
    if (出口.password !== undefined) 凭证 += `:${encodeURIComponent(出口.password)}`;
    凭证 += '@';
  }
  return `${协议}://${凭证}${出口.server}:${出口.port}`;
}

function 测出口(出口) {
  const 代理 = curl代理地址(出口);
  // 用 ALL_PROXY 而不是命令行参数：凭证不进 argv，`ps` 里看不到。
  const 结果 = spawnSync('curl', ['-sS', '--max-time', '20', 'https://api.ipify.org'], {
    env: { ...process.env, ALL_PROXY: 代理, all_proxy: 代理 },
    encoding: 'utf8',
  });
  if (结果.status !== 0) return { ok: false, 说明: '连接失败' };
  const 地址 = String(结果.stdout || '').trim();
  return { ok: true, 地址 };
}

function 主函数(参数) {
  const 取值 = (名, 默认) => {
    const 位 = 参数.indexOf(名);
    if (位 < 0) return 默认;
    const 值 = 参数[位 + 1];
    if (!值 || 值.startsWith('--')) throw new Error(`${名} 后面要跟一个值`);
    return 值;
  };
  const 检查 = 参数.includes('--check');
  const 测试 = 参数.includes('--test');

  const 来源路径 = 取值('--from', join(homedir(), '.auto-vpn/verge-exit.txt'));

  if (!existsSync(来源路径)) {
    throw new Error(
      `找不到出口文件 ${来源路径}\n` +
        '把地址写进这个文件，一行一个，权限设成 600：\n' +
        '  socks5://USER:PASS@HOST:PORT#🇭🇰 香港静态IP',
    );
  }

  const 文本 = readFileSync(来源路径, 'utf8');
  const 出口列表 = 读取出口文件(文本);

  console.log(`出口文件：${来源路径}`);
  for (const 出口 of 出口列表) console.log(`  ✓ ${出口.name}  ${脱敏(出口)}`);

  const 配置块 = 生成配置块(出口列表);
  // 编译但不执行：语法错误在这里就拦住，不会等到 Verge 里静默失败。
  new Function(配置块);

  if (测试) {
    const 结果 = 测出口(出口列表[0]);
    console.log(结果.ok ? `  ✓ 出口可达，当前出口 IP：${结果.地址}` : `  ✗ 出口连不上（${脱敏(出口列表[0])}）`);
    if (!结果.ok) process.exitCode = 1;
  }

  if (检查) {
    console.log('--check：只校验，没有写入');
    return;
  }

  const 目标 = 取值('--out', null) || 找Verge脚本();
  if (!目标) {
    throw new Error(
      '找不到 Clash Verge 的扩展脚本。先把 docs/clash-verge-extension.js 贴进 Verge 的「扩展脚本」，' +
        '或者用 --out 指定路径。',
    );
  }
  if (!existsSync(目标)) throw new Error(`目标脚本不存在：${目标}`);

  const 原内容 = readFileSync(目标, 'utf8');
  if (!原内容.includes(扩展脚本标记)) {
    throw new Error(`目标脚本不是这个扩展（缺少标记「${扩展脚本标记}」）：${目标}`);
  }
  const 新脚本 = 替换配置块(原内容, 配置块);
  new Function(新脚本);

  copyFileSync(目标, `${目标}.bak`);
  // 备份里可能是上一轮的凭证，权限跟着一起收紧。
  chmodSync(`${目标}.bak`, 0o600);
  writeFileSync(目标, 新脚本, { mode: 0o600 });
  chmodSync(目标, 0o600);

  console.log(`已写入 ${目标}（备份在 ${目标}.bak）`);
  console.log('到 Verge 里重新激活一次订阅即可生效。');
}

const 直接运行 = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (直接运行) {
  try {
    主函数(process.argv.slice(2));
  } catch (错) {
    console.error(`✗ ${错.message}`);
    process.exitCode = 1;
  }
}
