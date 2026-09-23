// 边界与异常路径测试
import './bootstrap.mjs';            // 先补齐 WebCrypto（Node 18 没有全局 crypto）
import worker, { SCENE } from './worker.mjs';
import { makeEnv, adminCookie } from './kv.mjs';

const TOKEN = 'edge-test-token-0123456789abcdef';

// 订阅接口现在必须带 token。默认给所有请求补上，需要测鉴权本身的用例
// 自己在 URL 里显式写 token= 即可（下面用 includes 判断，不会重复追加）
function withToken(url) {
    if (url.includes('token=')) return url;
    return url + (url.includes('?') ? '&' : '?') + 'token=' + TOKEN;
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
}

async function gen(links, url = 'https://x/sub?target=clash') {
    const env = makeEnv({ vpn_links: links, sub_token: TOKEN });
    const res = await worker.fetch(new Request(withToken(url)), env);
    return await res.text();
}

// —— A. 空订阅 ——
const a = await gen('');
check('空订阅仍返回 200 + 合法 YAML', a.includes('proxy-groups:') && a.includes('proxies:'));
check('空订阅不产生幽灵场景组', !a.includes('场景'));
check('空订阅 自动选择 兜底 DIRECT', a.includes('⚡ 自动选择, type: url-test, proxies: [DIRECT]'));

// —— B. 无协议行 / 垃圾行 ——
const b = await gen('hello world\n\n#### \nnot-a-link');
check('垃圾行不崩溃', b.includes('proxy-groups:'));

// —— C. 非 hysteria 协议不受影响（只有 hy2 有 up/down 语义）——
const c = await gen('vless://00000000-1111-2222-3333-444444444444@edge.susie.one:443?security=tls&sni=edge.susie.one&type=ws#香港A\ntrojan://pw@142.91.106.165:443?sni=a.com#香港B');
check('vless 保持原名不展开', c.includes('"name":"香港A"'));
check('trojan 保持原名不展开', c.includes('"name":"香港B"'));
check('非 hy2 节点不写 up/down', !c.includes('"up"'));
check('非 hy2 节点仍进自动选择', c.includes('[香港A, 香港B]'));

// —— D. 任意 hy2 节点都展开为 3 份（matchMode: all）——
const d = await gen('hysteria2://p@142.91.106.165:24443?sni=a.com#日本2');
check('命中节点展开 3 份', (d.match(/"name":"日本2/g) || []).length === 3, d.match(/"name":"[^"]*"/g));
check('副本名带档位后缀', d.includes('"name":"日本2 · 家宽"') && d.includes('"name":"日本2 · 移动"') && d.includes('"name":"日本2 · BBR"'));
check('家宽档带宽正确', d.includes('"up":"30 Mbps","down":"80 Mbps"'));
check('移动档带宽正确', d.includes('"up":"10 Mbps","down":"50 Mbps"'));
check('BBR 档不写带宽', d.includes('"name":"日本2 · BBR"') && d.split('"name":"日本2 · BBR"')[1].split('}')[0].indexOf('"up"') < 0);
check('场景组已生成', d.includes('name: 🎚 日本2 场景'));
check('原始节点被移除', !d.includes('"name":"日本2"'));
check('自动选择只含家宽档', d.includes('type: url-test, proxies: [日本2 · 家宽]'));

// —— E. 白名单外的陌生 hy2 节点同样展开（新增节点自动纳入）——
const e = await gen('hysteria2://p@9.9.9.9:8443?sni=a.com#完全没见过的节点');
check('陌生 hy2 节点也展开 3 份', (e.match(/"name":"完全没见过的节点/g) || []).length === 3);
check('陌生节点同样生成场景组', e.includes('name: 🎚 完全没见过的节点 场景'));

// —— E2. matchMode: "list" 时白名单仍然生效（可回退）——
SCENE.matchMode = 'list';
SCENE.matchNames = ['日本2'];
SCENE.matchServers = ['142.91.106.165'];
const e2 = await gen('hysteria2://p@9.9.9.9:8443?sni=a.com#别的节点\nhysteria2://p@142.91.106.165:443?sni=a.com#日本2');
check('list 模式：白名单外不展开', (e2.match(/"name":"别的节点/g) || []).length === 1);
check('list 模式：白名单内展开', (e2.match(/"name":"日本2/g) || []).length === 3);
check('list 模式：白名单外不写带宽', e2.split('"name":"别的节点"')[1].split('}')[0].indexOf('"up"') < 0);
SCENE.matchMode = 'all';

// —— E3. 链接里原有的 up/down 会被档位覆盖，而不是叠加 ——
const e3 = await gen('hysteria2://p@1.2.3.4:443?up=100%20Mbps&down=200%20Mbps&sni=a.com#旧配置节点');
check('原带宽被档位替换', e3.includes('"up":"30 Mbps","down":"80 Mbps"') && !e3.includes('100 Mbps') && !e3.includes('200 Mbps'));
check('摘除后其余参数保留', e3.includes('"sni":"a.com"'));

// —— F. vless / trojan 不做展开 ——
const f = await gen('vless://uuid@1.2.3.4:443?security=tls&sni=a.com&type=ws#日本2\ntrojan://pw@142.91.106.165:443?sni=a.com#奔哥专用');
check('vless 即使同名也不展开', (f.match(/"name":"日本2/g) || []).length === 1);
check('trojan 即使同 IP 也不展开', (f.match(/"name":"奔哥专用/g) || []).length === 1);

// —— G. 端口跳跃链接兼容（副本仍需保留 ports）——
const g = await gen('hysteria2://p@142.91.106.165:20000-30000?sni=a.com#日本2');
check('端口跳跃副本仍带 ports', (g.match(/"ports":"20000-30000"/g) || []).length === 3);

// —— H. 重复链接去重不报 duplicate name ——
const h = await gen('hysteria2://p@142.91.106.165:24443?sni=a.com#日本2\nhysteria2://p@142.91.106.165:24443?sni=a.com#日本2');
const names = [...h.matchAll(/"name":"([^"]*)"/g)].map(m => m[1]);
check('重名自动追加序号', new Set(names).size === names.length, names.join(' | '));

// —— I. 名称含特殊字符时 YAML 加引号 ——
const i = await gen('hysteria2://p@142.91.106.165:24443?sni=a.com#日本: 东京');
check('含冒号的名称被加引号', i.includes('"日本: 东京 · 家宽"'));
check('场景组名也被加引号', i.includes('name: "🎚 日本: 东京 场景"'));

// —— J. ?scene=0 关闭展开 ——
const j = await gen('hysteria2://p@142.91.106.165:24443?sni=a.com#日本2', 'https://x/sub?target=clash&scene=0');
check('scene=0 不展开', (j.match(/"name":"日本2/g) || []).length === 1 && !j.includes('场景'));

// —— K. Base64 订阅同时展开 ——
const env2 = makeEnv({ vpn_links: 'hysteria2://p@142.91.106.165:24443?sni=a.com&obfs=salamander&obfs-password=z#日本2', sub_token: TOKEN });
const kres = await worker.fetch(new Request(`https://x/sub?token=${TOKEN}`), env2);
const ktext = Buffer.from(await kres.text(), 'base64').toString('utf8');
const klines = ktext.split('\n').filter(Boolean);
check('Base64 订阅展开为 3 行', klines.length === 3, klines.length);
check('Base64 行含 up/down 参数', klines[0].includes('up=30%20Mbps') && klines[0].includes('down=80%20Mbps'), klines[0]);
check('Base64 行名称正确编码', klines[0].endsWith('#' + encodeURIComponent('日本2 · 家宽')));
check('BBR 档不加带宽参数', !klines[2].includes('up='));

// —— L. 后台页面仍可渲染（注入防护未被破坏）——
const envAdmin = makeEnv({ admin_password: 'x', vpn_links: 'hysteria2://p@a.com:443#A', sub_token: TOKEN });
const login = await worker.fetch(new Request('https://x/admin'), envAdmin);
check('未登录跳登录页', (await login.text()).includes('管理员登录'));
const dash = await worker.fetch(new Request('https://x/admin', { headers: { Cookie: adminCookie('x') } }), envAdmin);
const html = await dash.text();
check('登录后正常返回后台 HTML', html.includes('SubLink Pro') && dash.status === 200, `status=${dash.status}`);
check('后台注入防护仍在', html.includes('rawLinks = `hysteria2://p@a.com:443#A`'));
check('后台展示 token 与含 token 的订阅地址', html.includes(TOKEN) && html.includes('token=' + TOKEN));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
