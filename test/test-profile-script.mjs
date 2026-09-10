// 回归测试 Clash Verge 扩展脚本：确认它不会破坏分场景副本
import fs from 'node:fs';

// 载入扩展脚本（它只有普通 function/var，没有 export）
const src = fs.readFileSync('profile-script.js', 'utf8');
const main = new Function(src + '\n; return main;')();

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
}

// 从 worker 生成的 out.yaml 里取出 proxies 段（每行是标准 JSON）
const yaml = fs.readFileSync('out.yaml', 'utf8');
const seg = yaml.split('proxies:')[1].split('proxy-groups:')[0];
const proxies = seg.split('\n').filter(l => l.trim().startsWith('- {')).map(l => JSON.parse(l.trim().slice(2)));
console.log(`读入 ${proxies.length} 个节点\n`);

// == 场景一：订阅侧已经展开好，脚本应当完全不动 ==
const before = JSON.stringify(proxies);
const out = main({ proxies: proxies.map(p => ({ ...p })) }, '测试订阅');
const after = JSON.stringify(out.proxies);
check('分场景副本未被任何修改', before === after);
check('家宽档带宽保持 30/80', out.proxies.find(p => p.name === '日本2 · 家宽')?.up === '30 Mbps');
check('移动档带宽保持 10/50', out.proxies.find(p => p.name === '日本2 · 移动')?.down === '50 Mbps');
check('BBR 档仍不带带宽（关键）', !out.proxies.find(p => p.name === '日本2 · BBR')?.up, JSON.stringify(out.proxies.find(p => p.name === '日本2 · BBR')));
check('美国1 vless 未被注入字段', !out.proxies.find(p => p.name === '美国1')?.up);

// == 场景二：订阅侧回退（无副本），脚本应兜底写入 ==
const legacy = [
    { name: '美国1', type: 'vless', server: 'edge.susie.one', port: 443 },
    { name: '日本2', type: 'hysteria2', server: '142.91.106.165', port: 24443 },
    { name: '奔哥专用', type: 'hysteria2', server: '142.91.106.178', port: 24778 },
    { name: '美国2', type: 'hysteria2', server: 'hy.susie.one', port: 24500 },
    { name: '某个新加的节点', type: 'hysteria2', server: '9.9.9.9', port: 1 }
];
const r2 = main({ proxies: legacy.map(p => ({ ...p })) }, '回退测试');
check('回退时按名称兜底写入', r2.proxies.find(p => p.name === '日本2')?.up === '30 Mbps');
check('回退时按 IP 兜底写入', r2.proxies.find(p => p.name === '奔哥专用')?.down === '80 Mbps');
check('回退时非 hysteria 不被写入', !r2.proxies.find(p => p.name === '美国1')?.up);
check('回退时端口跳跃节点也兜底', r2.proxies.find(p => p.name === '美国2')?.down === '80 Mbps');
check('回退时白名单外的 hy2 也兜底（MATCH_ALL_HYSTERIA2）', r2.proxies.find(p => p.name === '某个新加的节点')?.up === '30 Mbps');

// == 场景三：改名后仍能命中 ==
const r3 = main({ proxies: [{ name: '东京-新', type: 'hysteria2', server: '142.91.106.165', port: 1 }] }, '改名测试');
check('改名后仍兜底命中', r3.proxies[0].up === '30 Mbps');

// == 场景三之二：MATCH_ALL_HYSTERIA2 关掉后回落到白名单 ==
const srcList = src.replace('var MATCH_ALL_HYSTERIA2 = true;', 'var MATCH_ALL_HYSTERIA2 = false;');
const mainList = new Function(srcList + '\n; return main;')();
const r3b = mainList({ proxies: [
    { name: '名单外节点', type: 'hysteria2', server: '9.9.9.9', port: 1 },
    { name: '日本2', type: 'hysteria2', server: '1.2.3.4', port: 1 }
] }, '白名单模式');
check('白名单模式：名单外不写入', !r3b.proxies[0].up);
check('白名单模式：名单内写入', r3b.proxies[1].up === '30 Mbps');

// == 场景四：异常输入不抛错、原样返回 ==
check('proxies 缺失不崩溃', main({}, 'x') !== null);
check('proxies 非数组不崩溃', main({ proxies: null }, 'x') !== null);
check('节点为 null 不崩溃', main({ proxies: [null, undefined, 'str'] }, 'x') !== null);
check('空数组不崩溃', Array.isArray(main({ proxies: [] }, 'x').proxies));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
