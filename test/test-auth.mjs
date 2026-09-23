// ============================================================
//  鉴权测试：订阅 token + 后台会话
// ------------------------------------------------------------
//  这里覆盖的是「改动之前属于漏洞」的部分：
//    - /sub 不带任何凭据就能拉走全部节点
//    - 后台只判断 cookie 存不存在，值固定是 "valid"，谁都能手搓
//    - /admin/setup 可被重复调用，等于谁先来谁能改掉管理员密码
//  所以这些用例是回归防线，不能因为「订阅拉不动了」而被删掉。
// ============================================================
import './bootstrap.mjs';            // 先补齐 WebCrypto（Node 18 没有全局 crypto）
import worker from './worker.mjs';
import { makeEnv, adminCookie, adminTicket } from './kv.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
}

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LINKS = 'hysteria2://p@1.2.3.4:443?sni=a.com#日本2';

const mkEnv = (seed = {}) => makeEnv({ vpn_links: LINKS, ...seed });

async function hit(url, e, headers = {}) {
    const res = await worker.fetch(new Request(url, { headers }), e);
    return { status: res.status, body: await res.text() };
}

function post(path, body, cookie, ctype = 'application/json') {
    const headers = { 'content-type': ctype };
    if (cookie) headers.Cookie = cookie;
    return new Request('https://x' + path, {
        method: 'POST', headers,
        body: ctype === 'application/json' ? JSON.stringify(body) : body
    });
}

const okClash = (r) => r.status === 200 && r.body.includes('proxies:');

// —— A. 没配 token 时 fail closed（绝不能退化成谁都能读）——
const eEmpty = mkEnv();
const a1 = await hit('https://x/sub?target=clash', eEmpty);
check('未配置 token 时拒绝访问', a1.status === 403 && !a1.body.includes('proxies:'), `status=${a1.status}`);
check('未配置 token 时提示去 /admin', a1.body.includes('/admin'));
const a2 = await hit('https://x/sub?target=clash&token=anything', eEmpty);
check('未配置 token 时给了 token 也拒绝', a2.status === 403, `status=${a2.status}`);

// —— B. 缺 token / 错 token ——
const e = mkEnv({ sub_token: TOKEN });
const b1 = await hit('https://x/sub?target=clash', e);
check('缺 token → 403 且不含节点', b1.status === 403 && !b1.body.includes('proxies:'), `status=${b1.status}`);
const b2 = await hit('https://x/sub?target=clash&token=wrong', e);
check('错 token → 403', b2.status === 403, `status=${b2.status}`);
const b3 = await hit('https://x/sub?target=clash&token=' + TOKEN.slice(0, -1), e);
check('token 少一位 → 403', b3.status === 403, `status=${b3.status}`);
const b4 = await hit('https://x/sub?target=clash&token=' + TOKEN + 'x', e);
check('token 多一位 → 403', b4.status === 403, `status=${b4.status}`);
const b5 = await hit('https://x/sub?target=clash&token=' + TOKEN.toUpperCase(), e);
check('token 大小写不同 → 403', b5.status === 403, `status=${b5.status}`);
const b6 = await hit('https://x/sub?target=clash&token=', e);
check('token 参数为空 → 403', b6.status === 403, `status=${b6.status}`);

// —— C. 三种传法都认 ——
const c1 = await hit('https://x/sub?target=clash&token=' + TOKEN, e);
check('?token= 传参通过', okClash(c1), `status=${c1.status}`);
const c2 = await hit('https://x/sub/' + TOKEN + '?target=clash', e);
check('/sub/<token> 路径写法通过', okClash(c2), `status=${c2.status}`);
const c2b = await hit('https://x/sub/not-the-token?target=clash', e);
check('/sub/<错 token> → 403', c2b.status === 403, `status=${c2b.status}`);
const c3 = await hit('https://x/sub?target=clash', e, { Authorization: 'Bearer ' + TOKEN });
check('Authorization: Bearer 通过', okClash(c3), `status=${c3.status}`);
const c3b = await hit('https://x/sub?target=clash', e, { Authorization: 'Bearer wrong' });
check('Bearer 里 token 不对 → 403', c3b.status === 403, `status=${c3b.status}`);
const c4 = await hit('https://x/?target=clash&token=' + TOKEN, e);
check('根路径受同样保护且可通过', okClash(c4), `status=${c4.status}`);
const c5 = await hit('https://x/?target=clash', e);
check('根路径无 token → 403', c5.status === 403, `status=${c5.status}`);
const c6 = await hit('https://x/sub/', e);
check('/sub/ 尾斜杠同样要鉴权', c6.status === 403, `status=${c6.status}`);

// Base64 通用订阅这条路也要拦（它不是 Clash 分支）
const c7 = await hit('https://x/sub', e);
check('Base64 订阅无 token → 403', c7.status === 403, `status=${c7.status}`);
const c8 = await hit('https://x/sub?token=' + TOKEN, e);
const c8text = Buffer.from(c8.body, 'base64').toString('utf8');
check('Base64 订阅带 token 正常', c8.status === 200 && c8text.includes('hysteria2://'), `status=${c8.status}`);

// Clash 客户端 UA 不能成为绕过手段
const c9 = await hit('https://x/sub?target=clash', e, { 'User-Agent': 'mihomo/1.19.29' });
check('Clash UA 无 token 一样 403', c9.status === 403, `status=${c9.status}`);
const c10 = await hit('https://x/sub?target=clash&scene=0', e);
check('?scene=0 不绕过鉴权', c10.status === 403, `status=${c10.status}`);

// —— D. 轮换宽限期 ——
const OLD = 'old-token-111111111111111111111111';
const NEW = 'new-token-222222222222222222222222';
const now = Date.now();
const eGrace = mkEnv({ sub_token: NEW, sub_token_prev: JSON.stringify({ token: OLD, until: now + 3600 * 1000 }) });
const d1 = await hit(`https://x/sub?target=clash&token=${OLD}`, eGrace);
check('宽限期内旧 token 仍可用', okClash(d1), `status=${d1.status}`);
const d2 = await hit(`https://x/sub?target=clash&token=${NEW}`, eGrace);
check('轮换后新 token 可用', okClash(d2), `status=${d2.status}`);

const eExpired = mkEnv({ sub_token: NEW, sub_token_prev: JSON.stringify({ token: OLD, until: now - 1000 }) });
const d3 = await hit(`https://x/sub?target=clash&token=${OLD}`, eExpired);
check('宽限期过后旧 token 失效', d3.status === 403, `status=${d3.status}`);

const eDirty = mkEnv({ sub_token: TOKEN, sub_token_prev: '这不是 JSON' });
const d4 = await hit('https://x/sub?target=clash&token=' + TOKEN, eDirty);
check('prev 是脏数据不影响正常鉴权', okClash(d4), `status=${d4.status}`);

// —— E. 后台会话：伪造 cookie 必须进不去 ——
const eAdmin = mkEnv({ admin_password: 'hunter2' });
const e1 = await hit('https://x/admin', eAdmin, { Cookie: '__Host-sublink_session=valid' });
check('固定值 "valid" 的 cookie 不再放行', e1.body.includes('管理员登录'), `status=${e1.status}`);
const e2 = await hit('https://x/admin', eAdmin, { Cookie: '__Host-sublink_session=' });
check('空 value 的 cookie 不放行', e2.body.includes('管理员登录'), `status=${e2.status}`);
const e3 = await hit('https://x/admin', eAdmin, { Cookie: 'x__Host-sublink_session=' + adminTicket('hunter2') });
check('同后缀的其它 cookie 名不被误判', e3.body.includes('管理员登录'), `status=${e3.status}`);
const e4 = await hit('https://x/admin', eAdmin, { Cookie: adminCookie('wrong-password') });
check('按错误密码算出的票据不认', e4.body.includes('管理员登录'), `status=${e4.status}`);
const e5 = await hit('https://x/admin', eAdmin, { Cookie: 'other=1; ' + adminCookie('hunter2') + '; another=2' });
check('多个 cookie 混在一起仍能正确取到', e5.body.includes('SubLink Pro'), `status=${e5.status}`);

// /update-links 同样不能靠伪造 cookie 混过去
const u1 = await worker.fetch(post('/update-links', { links: 'x' }, '__Host-sublink_session=valid'), eAdmin);
check('/update-links 伪造 cookie → 401', u1.status === 401, `status=${u1.status}`);
const u2 = await worker.fetch(post('/update-links', { links: 'trojan://x@a.com:443#新节点' }, adminCookie('hunter2')), eAdmin);
check('/update-links 合法会话 → 200', u2.status === 200, `status=${u2.status}`);
check('/update-links 真的写进 KV 了', String(eAdmin.sub.store.get('vpn_links')).includes('新节点'));

// —— F. /admin/setup 不能被重复初始化 ——
const f1 = await worker.fetch(post('/admin/setup', 'password=hijack', null, 'application/x-www-form-urlencoded'), eAdmin);
check('已设过密码后 setup 被拒（防抢占改密）', f1.status === 403, `status=${f1.status}`);
check('原密码没被改掉', eAdmin.sub.store.get('admin_password') === 'hunter2', eAdmin.sub.store.get('admin_password'));
const f2 = await worker.fetch(post('/admin/setup', 'password=first', null, 'application/x-www-form-urlencoded'), mkEnv());
check('首次 setup 仍可用', f2.status === 303, `status=${f2.status}`);
const f3 = await worker.fetch(post('/admin/login', 'password=wrong', null, 'application/x-www-form-urlencoded'), eAdmin);
check('密码错误登录被拒', f3.status === 403, `status=${f3.status}`);
const f4 = await worker.fetch(post('/admin/login', 'password=hunter2', null, 'application/x-www-form-urlencoded'), eAdmin);
check('密码正确登录返回 303 + 会话 cookie', f4.status === 303 && (f4.headers.get('set-cookie') || '').includes('__Host-sublink_session=' + adminTicket('hunter2')), f4.headers.get('set-cookie'));
check('会话 cookie 带 HttpOnly / Secure / SameSite', /HttpOnly/.test(f4.headers.get('set-cookie')) && /Secure/.test(f4.headers.get('set-cookie')) && /SameSite=Strict/.test(f4.headers.get('set-cookie')));

// —— G. token 轮换 API ——
const OLD2 = 'old-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const eRot = mkEnv({ admin_password: 'pw', sub_token: OLD2 });
const cookie = adminCookie('pw');

const g0 = await worker.fetch(post('/admin/token', { action: 'rotate' }, null), eRot);
check('未登录调 /admin/token → 401', g0.status === 401, `status=${g0.status}`);

const g1 = await worker.fetch(post('/admin/token', { action: 'rotate' }, cookie), eRot);
const g1j = await g1.json();
check('轮换成功并返回新 token', g1.status === 200 && g1j.ok && /^[0-9a-f]{32}$/.test(g1j.token), JSON.stringify(g1j));
check('新 token 已写入 KV', eRot.sub.store.get('sub_token') === g1j.token);
check('旧 token 进入宽限期', JSON.parse(eRot.sub.store.get('sub_token_prev')).token === OLD2);
check('返回的宽限时间在未来', g1j.graceUntil > Date.now());

const g2 = await hit(`https://x/sub?target=clash&token=${OLD2}`, eRot);
check('轮换后旧 token 宽限期内仍可用', okClash(g2), `status=${g2.status}`);
const g3 = await hit(`https://x/sub?target=clash&token=${g1j.token}`, eRot);
check('轮换后新 token 立即可用', okClash(g3), `status=${g3.status}`);

const setTok = (t) => worker.fetch(post('/admin/token', { action: 'set', token: t }, cookie), eRot);
check('自定义 token 太短被拒', (await setTok('short')).status === 400);
check('自定义 token 含空格被拒', (await setTok('has space here')).status === 400);
check('自定义 token 含点号被拒', (await setTok('my.custom_Token-2026')).status === 400);
check('自定义 token 含中文被拒', (await setTok('中文token不是好主意')).status === 400);
check('自定义 token 含斜杠被拒', (await setTok('a/b/c/d/e/f')).status === 400);
check('合法自定义 token 保存成功', (await setTok('my-custom_Token-2026')).status === 200);
check('自定义 token 已生效', eRot.sub.store.get('sub_token') === 'my-custom_Token-2026');
const g4 = await hit('https://x/sub?target=clash&token=my-custom_Token-2026', eRot);
check('自定义 token 可用于订阅', okClash(g4), `status=${g4.status}`);

// —— H. 后台自动补 token（部署完忘记配也不会裸奔）——
const eAuto = mkEnv({ admin_password: 'pw' });
check('初始确实没有 sub_token', !eAuto.sub.store.get('sub_token'));
const h1 = await hit('https://x/admin', eAuto, { Cookie: adminCookie('pw') });
const autoToken = eAuto.sub.store.get('sub_token');
check('进入后台后自动生成 32 位 token', /^[0-9a-f]{32}$/.test(autoToken || ''), String(autoToken));
check('自动生成的 token 展示在页面上', h1.body.includes(autoToken));
check('页面给出了含 token 的订阅地址', h1.body.includes('token=' + autoToken));
const h2 = await hit(`https://x/sub?target=clash&token=${autoToken}`, eAuto);
check('自动生成的 token 立即可用于订阅', okClash(h2), `status=${h2.status}`);
const h3 = await hit('https://x/admin', eAuto, { Cookie: adminCookie('pw') });
check('再次进入后台不会重新生成（token 保持稳定）', eAuto.sub.store.get('sub_token') === autoToken && h3.status === 200);

// —— I. 退出登录 ——
const i1 = await worker.fetch(new Request('https://x/admin/logout'), eAdmin);
check('/admin/logout 清 cookie 并跳回 /admin', i1.status === 303 && /Max-Age=0/.test(i1.headers.get('set-cookie') || ''), i1.headers.get('set-cookie'));

// —— J. 修改管理密码（/admin/setup 设过一次就锁死了，改密只能走这里）——
const ePwd = mkEnv({ admin_password: 'oldpass', sub_token: TOKEN });
const p0 = await worker.fetch(post('/admin/password', { password: 'newpass123' }, null), ePwd);
check('未登录改密码 → 401', p0.status === 401, `status=${p0.status}`);
const p1 = await worker.fetch(post('/admin/password', { password: 'short' }, adminCookie('oldpass')), ePwd);
check('新密码太短被拒', p1.status === 400, `status=${p1.status}`);
check('密码未被改动', ePwd.sub.store.get('admin_password') === 'oldpass');

const p2 = await worker.fetch(post('/admin/password', { password: 'newpass123' }, adminCookie('oldpass')), ePwd);
check('改密码成功', p2.status === 200, `status=${p2.status}`);
check('新密码已写入 KV', ePwd.sub.store.get('admin_password') === 'newpass123');
check('改密后换发了新票据（当前页不会掉线）', (p2.headers.get('set-cookie') || '').includes(adminTicket('newpass123')), p2.headers.get('set-cookie'));
const p3 = await hit('https://x/admin', ePwd, { Cookie: adminCookie('oldpass') });
check('旧密码派生的票据立即失效', p3.body.includes('管理员登录'), `status=${p3.status}`);
const p4 = await hit('https://x/admin', ePwd, { Cookie: adminCookie('newpass123') });
check('新密码派生的票据可用', p4.body.includes('SubLink Pro'), `status=${p4.status}`);
const p5 = await hit(`https://x/sub?target=clash&token=${TOKEN}`, ePwd);
check('改密码不影响订阅 token', okClash(p5), `status=${p5.status}`);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
