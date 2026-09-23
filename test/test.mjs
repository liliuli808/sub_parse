// 端到端测试：把 worker.js 当真实模块调用，生成三份输出供校验
import './bootstrap.mjs';            // 先补齐 WebCrypto（Node 18 没有全局 crypto）
import fs from 'node:fs';
import worker from './worker.mjs';
import { makeEnv } from './kv.mjs';

// 模拟线上 KV 的 vpn_links（结构与真实一致，密钥用占位符）
const LINKS = [
    'vless://00000000-1111-2222-3333-444444444444@edge.susie.one:443?security=tls&sni=edge.susie.one&type=ws&path=/ws-947a5dca47da398410b1304667de7307&host=edge.susie.one#美国1',
    'hysteria2://pass1@142.91.106.165:24443?sni=hy2.susie.one&insecure=0&obfs=salamander&obfs-password=aaa#日本2',
    'hysteria2://pass2@hy.susie.one:24500-24515?sni=hy.susie.one&insecure=0&obfs=salamander&obfs-password=bbb#美国2',
    'hysteria2://pass3@142.91.106.178:24778?sni=www.bing.com&insecure=1&obfs=salamander&obfs-password=ccc#奔哥专用'
].join('\n');

const TOKEN = 'e2e-test-token-0123456789abcdef';
const env = makeEnv({ vpn_links: LINKS, sub_token: TOKEN });

async function call(url, headers = {}) {
    const res = await worker.fetch(new Request(url, { headers }), env);
    return { status: res.status, ctype: res.headers.get('content-type'), body: await res.text() };
}

const out = [];
function log(s) { out.push(s); console.log(s); }

// 订阅地址现在必须带 token，否则 403
const sub = `https://sub.susie.one/sub?token=${TOKEN}`;

// 1) Clash YAML（显式 target=clash）
const clash = await call(`${sub}&target=clash`);
fs.writeFileSync('out.yaml', clash.body);
log(`[1] Clash YAML      status=${clash.status} type=${clash.ctype} 字节=${clash.body.length}`);

// 2) Clash YAML（靠 UA 自动识别）
const clashUa = await call(`https://sub.susie.one/?token=${TOKEN}`, { 'User-Agent': 'ClashMetaForAndroid/2.11.1 mihomo/1.19.29' });
log(`[2] UA 自动识别      status=${clashUa.status} 首行=${clashUa.body.split('\n')[0]}`);

// 3) Base64 通用订阅
const plain = await call(sub);
const decoded = Buffer.from(plain.body, 'base64').toString('utf8');
fs.writeFileSync('out_plain.txt', decoded);
log(`[3] Base64 订阅      status=${plain.status} 解码后 ${decoded.split('\n').length} 行`);

// 4) ?scene=0 关闭
const off = await call(`${sub}&target=clash&scene=0`);
fs.writeFileSync('out_off.yaml', off.body);
log(`[4] ?scene=0 关闭    status=${off.status} 节点数=${(off.body.match(/^  - \{/gm) || []).length}`);

// 5) 鉴权闸门：没 token / token 不对都必须拿不到内容
const noTok = await call('https://sub.susie.one/sub?target=clash');
const badTok = await call('https://sub.susie.one/sub?token=wrong&target=clash');
log(`[5] 无 token=${noTok.status}  错 token=${badTok.status}（都应为 403）`);
if (noTok.status !== 403 || noTok.body.includes('proxies:')) throw new Error('无 token 竟然拉到了订阅');
if (badTok.status !== 403 || badTok.body.includes('proxies:')) throw new Error('错误 token 竟然拉到了订阅');

fs.writeFileSync('test-log.txt', out.join('\n'));
