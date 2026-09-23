/**
 * SubLink Pro - 可视化管理完整修复版
 * 功能：可视化节点编辑、自动解析链接名称、中文乱码修复、Clash 配置分发
 *      分场景节点副本（同一节点按带宽档位展开为多个副本）
 */

const SESSION_COOKIE = "__Host-sublink_session";

/**
 * ============================================================
 *  分场景节点副本
 * ------------------------------------------------------------
 *  为什么需要：
 *  hysteria2 的 up / down 是「硬上限」，而且只有客户端主动声明了带
 *  宽，才会启用 Brutal 拥塞控制；不声明就退回 BBR，在高 RTT 链路上
 *  单流速度会差一个数量级（实测 5.3 → 66 Mbps）。
 *
 *  麻烦在于：同一个订阅会同时被家宽、手机 4G、弱网热点等不同网络
 *  使用，写死单一档位必然顾此失彼——
 *    按家宽填 → 手机上超发，持续重传、白烧流量、连接不稳；
 *    按手机填 → 家宽白白损失一半以上速度。
 *
 *  解决办法：在生成侧把每个 hysteria2 节点的多个档位各做成一个独立
 *  节点，各端按当前网络挑对应档位即可（切节点即切场景），
 *  不需要给每台设备单独改配置。
 *
 *  订阅地址加 ?scene=0 可临时关闭本功能，返回原始节点。
 * ============================================================
 */
// 导出是为了让测试能切换 matchMode；Cloudflare Worker 只取 default 导出，
// 多一个命名导出不影响部署
export const SCENE = {
    enabled: true,

    // 命中方式：
    //   "all"  → 所有 hysteria2 / hy2 节点（默认）。新增节点会自动纳入，
    //            不需要回来改配置，也就不会再出现「漏配某个节点」的情况。
    //   "list" → 只处理下面 matchNames / matchServers 白名单里的节点
    matchMode: "all",

    // 仅 matchMode: "list" 时生效：节点名称或服务器地址，任一命中即可
    matchNames: ["日本2", "奔哥专用"],
    matchServers: ["142.91.106.165", "142.91.106.178"],

    // 档位列表：会为每个命中节点各生成一份副本
    //   up / down 为 null 时不写该字段 → 该副本走 BBR（自适应，适合抖动大的链路）
    //   auto: true 的档位会纳入「⚡ 自动选择」测速组。同一服务器的各档位
    //   延迟完全相同，全部纳入会让测速组随机挑到慢档位，所以只放一个
    tiers: [
        { tag: "家宽", up: "30 Mbps", down: "80 Mbps", auto: true },
        { tag: "移动", up: "10 Mbps", down: "50 Mbps", auto: false },
        { tag: "BBR", up: null, down: null, auto: false }
    ],

    // 副本名分隔符，以及场景选择组名模板（{name} 替换为原节点名）
    nameSeparator: " · ",
    groupNameTemplate: "🎚 {name} 场景",

    // 是否额外保留原始节点（不带带宽）。默认 false：由上面的档位副本取代
    keepOriginal: false,

    // 是否把副本一并写入 Base64 通用订阅。
    // mihomo 系客户端能从 hysteria2 链接的 up / down 参数读到带宽，
    // 其它客户端会忽略这两个参数，只是多出几个同名副本
    applyToPlainSubscription: true
};

/**
 * ============================================================
 *  订阅鉴权
 * ------------------------------------------------------------
 *  / 和 /sub 是公开可读的：只要知道 URL，任何人都能把全部节点
 *  拉走。域名（sub.susie.one/sub 这种）很好猜、也很容易从别处
 *  泄漏出去，所以真正需要保密的不是路径，而是 URL 里那段随机串。
 *
 *  加 token 之后，URL 本身就是密码：
 *    https://sub.susie.one/sub?token=<32 位随机串>
 *
 *  没有 token、或 token 不对 → 一律 403，不返回任何节点内容。
 *  也就是说这是「失败即关闭」：token 没配好时订阅是拉不动的，
 *  不会退化成谁都能读。
 *
 *  轮换（rotate）时旧 token 会保留 graceHours 小时的宽限期，
 *  这样换 token 不用一次性把所有设备都改完。宽限期设为 0 即
 *  立即失效。
 *
 *  想临时关掉整套鉴权（比如调试），把 enabled 改成 false。
 * ============================================================
 */
const AUTH = {
    enabled: true,

    // 查询参数名：?token=xxx
    param: "token",

    // 是否接受 /sub/<token> 这种路径写法（两种写法等价）
    allowPathToken: true,

    // 是否接受 Authorization: Bearer <token> 头（给 curl / 脚本用）
    allowBearerHeader: true,

    // 轮换宽限期（小时）。0 = 旧 token 立即失效
    graceHours: 24
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/$/, "") || "/";
        const userAgent = (request.headers.get("User-Agent") || "").toLowerCase();

        // ?scene=0 / off / false 时关闭分场景副本
        const sceneFlag = (url.searchParams.get("scene") || "").toLowerCase();
        const useScene = SCENE.enabled && !["0", "off", "false", "no"].includes(sceneFlag);

        try {
            // --- 1. 订阅分发逻辑（/ 、/sub 、/sub/<token>）---
            if (path === "/" || path === "/sub" || path.startsWith("/sub/")) {
                const kv = env.sub;
                if (!kv) return new Response("错误：请在 Settings -> Bindings 中绑定名为 'sub' 的 KV 空间", { status: 503 });

                // /sub/<token> 写法：把路径里的那段交给鉴权，其它逻辑与 /sub 完全一致
                const pathToken = path.startsWith("/sub/") ? path.slice("/sub/".length) : "";
                const guard = await checkSubToken(env, request, url, pathToken);
                if (!guard.ok) return tokenDenied(guard.reason);

                const rawContent = await kv.get("vpn_links") || "";

                // 如果是 Clash 客户端或带有 target=clash 参数
                if (userAgent.includes("clash") || url.searchParams.get("target") === "clash") {
                    return generateClashResponse(rawContent, { scene: useScene });
                }

                // 普通订阅返回 Base64（支持中文）
                const entries = expandSceneEntries(rawContent, useScene && SCENE.applyToPlainSubscription);
                const plain = entries.map(e => `${e.body}#${encodeURIComponent(e.name)}`).join("\n");
                const base64 = btoa(unescape(encodeURIComponent(plain)));
                return new Response(base64, {
                    headers: { "content-type": "text/plain; charset=utf-8" }
                });
            }

            // --- 2. 管理后台路由 ---
            if (path === "/admin") {
                const kv = env.sub;
                if (!kv) return new Response("错误：请先绑定名为 'sub' 的 KV 空间", { status: 503 });

                const passwordEntry = await kv.get("admin_password");
                // 首次运行设置密码
                if (!passwordEntry) return new Response(getAuthHTML("setup"), { headers: { "content-type": "text/html; charset=UTF-8" } });

                if (!(await isAdmin(env, request, passwordEntry))) return new Response(getAuthHTML("login"), { headers: { "content-type": "text/html; charset=UTF-8" } });

                // 首次进入后台时自动补一个订阅 token。
                // 否则部署完忘记配 token，订阅直接 403，还得翻文档才知道去哪拿。
                let token = await kv.get("sub_token");
                let generated = false;
                if (!token) {
                    token = randomToken();
                    await kv.put("sub_token", token);
                    generated = true;
                }

                const links = await kv.get("vpn_links") || "";
                const grace = await readGrace(kv);
                return new Response(getDashboardHTML({ links, token, generated, grace, origin: url.origin }), { headers: { "content-type": "text/html; charset=UTF-8" } });
            }

            // 退出登录（票据无状态，清 cookie 即可）
            if (path === "/admin/logout") {
                return new Response(null, {
                    status: 303,
                    headers: {
                        "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`,
                        "location": "/admin"
                    }
                });
            }

            // 登录与初始化密码处理
            if (path === "/admin/login" || path === "/admin/setup") {
                const form = await request.formData();
                const password = form.get("password");
                if (path === "/admin/setup") {
                    // 已经设过密码就不允许再初始化，否则谁先来谁能改掉管理员密码
                    if (await env.sub.get("admin_password")) return new Response("已初始化，请直接登录", { status: 403 });
                    if (!password) return new Response("密码不能为空", { status: 400 });
                    await env.sub.put("admin_password", password);
                } else {
                    const saved = await env.sub.get("admin_password");
                    if (!saved || password !== saved) return new Response("密码错误", { status: 403 });
                }
                return new Response("验证成功", {
                    headers: {
                        "set-cookie": `${SESSION_COOKIE}=${await sessionTicket(password)}; Path=/; Max-Age=604800; Secure; HttpOnly; SameSite=Strict`,
                        "location": "/admin"
                    },
                    status: 303
                });
            }

            // API: 更新链接（需登录）
            if (path === "/update-links") {
                if (!(await isAdmin(env, request))) return new Response("未授权", { status: 401 });
                const body = await request.json();
                await env.sub.put("vpn_links", body.links);
                return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
            }

            // API: 修改管理密码（需登录）
            // 因为 /admin/setup 设过一次就不再放行，改密必须走这条路 ——
            // 否则密码一旦泄漏就没法在后台换掉了。
            if (path === "/admin/password") {
                if (!(await isAdmin(env, request))) return new Response("未授权", { status: 401 });

                const body = await request.json().catch(() => ({}));
                const next = String((body && body.password) || "");
                if (next.length < 6) {
                    return new Response(JSON.stringify({ ok: false, error: "密码至少 6 位" }), {
                        status: 400, headers: { "content-type": "application/json" }
                    });
                }

                await env.sub.put("admin_password", next);
                return new Response(JSON.stringify({ ok: true }), {
                    headers: {
                        "content-type": "application/json",
                        // 旧票据由旧密码派生，改密后必然失效。
                        // 这里顺带换发一张，否则改完当前标签页自己就被踢出去了。
                        "set-cookie": `${SESSION_COOKIE}=${await sessionTicket(next)}; Path=/; Max-Age=604800; Secure; HttpOnly; SameSite=Strict`
                    }
                });
            }

            // API: 轮换 / 自定义订阅 token（需登录）
            if (path === "/admin/token") {
                if (!(await isAdmin(env, request))) return new Response("未授权", { status: 401 });

                const body = await request.json().catch(() => ({}));
                let next;
                if (body && body.action === "set") {
                    next = String(body.token || "").trim();
                    // 严格白名单：这段字符串会进 URL 和后台 HTML，不能带奇怪字符
                    if (!/^[A-Za-z0-9_-]{8,128}$/.test(next)) {
                        return new Response(JSON.stringify({ ok: false, error: "token 需为 8-128 位的字母、数字、- 或 _" }), {
                            status: 400, headers: { "content-type": "application/json" }
                        });
                    }
                } else {
                    next = randomToken();
                }

                const current = await env.sub.get("sub_token");
                let graceUntil = 0;
                // 轮换时把旧 token 留进宽限期，避免所有设备同时掉线
                if (current && current !== next && AUTH.graceHours > 0) {
                    graceUntil = Date.now() + AUTH.graceHours * 3600 * 1000;
                    await env.sub.put("sub_token_prev", JSON.stringify({ token: current, until: graceUntil }));
                }
                await env.sub.put("sub_token", next);

                return new Response(JSON.stringify({ ok: true, token: next, graceUntil }), { headers: { "content-type": "application/json" } });
            }

            return new Response("Not Found", { status: 404 });

        } catch (e) {
            return new Response("Internal Error: " + e.message, { status: 500 });
        }
    }
};

/**
 * ============================================================
 *  链接解析与分场景展开
 * ============================================================
 */

// 端口跳跃链接（host:起始-结束）不符合 URL 规范，先拆出端口段再解析，
// 否则 new URL 会抛异常导致节点被丢弃
const PORT_RANGE_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+):(\d+)-(\d+)([/?#].*)?$/;

/**
 * 拆出 # 后的名称片段。
 * 不用 new URL 是因为端口跳跃链接会解析失败，而名称必须能拿到。
 */
function splitFragment(raw) {
    const idx = raw.indexOf("#");
    if (idx < 0) return { body: raw, name: "" };
    return { body: raw.slice(0, idx), name: raw.slice(idx + 1) };
}

function decodeName(fragment) {
    const s = (fragment || "").replace(/^#/, "");
    if (!s) return "";
    try { return decodeURIComponent(s); } catch (_) { return s; }
}

/**
 * 解析链接主体，返回 URL、协议名与端口跳跃段。
 */
function parseLinkBody(body) {
    const m = body.match(PORT_RANGE_RE);
    const portRange = m ? `${m[2]}-${m[3]}` : null;
    const normalized = m ? `${m[1]}:${m[2]}${m[4] || ""}` : body;
    const url = new URL(normalized);
    return { url, protocol: url.protocol.replace(":", ""), portRange };
}

/**
 * 往链接主体追加查询参数（保持原有参数不变）。
 */
function appendQuery(body, params) {
    const keys = Object.keys(params || {});
    if (keys.length === 0) return body;
    const qs = keys
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
        .join("&");
    // 主体已有参数用 &，没有则用 ?，末尾已是分隔符则不重复追加
    const sep = body.indexOf("?") < 0 ? "?" : (/[?&]$/.test(body) ? "" : "&");
    return `${body}${sep}${qs}`;
}

/**
 * 摘掉链接主体里的指定查询参数。
 *
 * 分场景副本要在链接上写 up / down，但 URLSearchParams.get() 只返回
 * 第一个同名参数——如果原链接里已经带了 up / down，直接 append 的话
 * 档位会被原值压住（取到的是原值而非档位值）。所以先摘干净再追加。
 */
function stripQueryKeys(body, keys) {
    const qi = body.indexOf("?");
    if (qi < 0) return body;
    const head = body.slice(0, qi);
    const kept = body.slice(qi + 1).split("&").filter(pair => {
        if (!pair) return false;
        let k = pair.split("=")[0];
        try { k = decodeURIComponent(k); } catch (_) { /* 保持原样 */ }
        return keys.indexOf(k.toLowerCase()) < 0;
    });
    return kept.length > 0 ? `${head}?${kept.join("&")}` : head;
}

/**
 * 判断该节点是否属于分场景副本的目标。
 * 只有 hysteria 系列才有 up / down 字段，其它协议直接跳过。
 */
function isSceneTarget(parsed, name) {
    const proto = parsed.protocol;
    if (proto !== "hysteria2" && proto !== "hy2") return false;
    // 默认 matchMode: "all" —— 所有 hy2 节点都展开
    if (SCENE.matchMode !== "list") return true;
    if (SCENE.matchNames.indexOf(name) >= 0) return true;
    return SCENE.matchServers.indexOf(parsed.url.hostname) >= 0;
}

/**
 * 把原始订阅内容展开为条目列表。
 * 命中分场景规则的节点会被展开成多个副本，其余原样保留。
 *
 * 带宽通过链接的 up / down 参数携带——mihomo 的 hysteria2 链接解析器
 * 会读取这两个参数（common/convert/converter.go），因此 Clash 侧和
 * Base64 通用订阅可以共用同一份展开结果。
 *
 * @returns {Array<{body: string, name: string, up: string|null, down: string|null, scene: string|null, auto: boolean}>}
 */
function expandSceneEntries(rawContent, useScene) {
    const lines = String(rawContent || "").split(/\r?\n/);
    const entries = [];

    lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes("://")) return;

        const frag = splitFragment(trimmed);
        const name = decodeName(frag.name) || `节点-${i + 1}`;

        let parsed = null;
        try { parsed = parseLinkBody(frag.body); } catch (_) { parsed = null; }

        // 解析失败的链接仍然原样输出，只是不做副本展开
        if (useScene && parsed && isSceneTarget(parsed, name)) {
            const tiers = (SCENE.tiers || []).filter(t => t && t.tag);
            // 档位配空了就退回原节点，避免节点凭空消失
            if (tiers.length > 0) {
                // 链接里原本就带 up / down 时先摘掉，否则档位会被原值压住
                const baseBody = stripQueryKeys(frag.body, ["up", "down"]);
                tiers.forEach(t => {
                    const params = {};
                    if (t.up) params.up = t.up;
                    if (t.down) params.down = t.down;
                    entries.push({
                        body: appendQuery(baseBody, params),
                        name: name + SCENE.nameSeparator + t.tag,
                        up: t.up || null,
                        down: t.down || null,
                        scene: name,
                        auto: !!t.auto
                    });
                });
                if (SCENE.keepOriginal) {
                    entries.push({ body: frag.body, name, up: null, down: null, scene: null, auto: false });
                }
                return;
            }
        }

        entries.push({ body: frag.body, name, up: null, down: null, scene: null, auto: false });
    });

    return entries;
}

/**
 * 名称去重，避免 Clash 报 duplicate name。
 */
function uniqueName(used, base) {
    let name = base;
    let n = 2;
    while (used.has(name)) { name = `${base}-${n++}`; }
    used.add(name);
    return name;
}

/**
 * YAML 流式标量安全输出：只在必要时加双引号。
 * 节点名来自用户输入，出现「,」「:」「#」等字符时不加引号会破坏配置结构。
 * JSON 字符串本身是合法的 YAML 双引号标量，可直接复用。
 */
function yq(value) {
    const s = String(value);
    if (s === "" || /[,:\[\]{}#&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) {
        return JSON.stringify(s);
    }
    return s;
}

/**
 * 生成 Clash YAML 配置
 */
function generateClashResponse(rawContent, options) {
    const opts = options || {};
    const entries = expandSceneEntries(rawContent, opts.scene !== false);

    const usedNames = new Set();
    const proxies = [];
    // 每个命中节点一个场景选择组，保持出现顺序
    const sceneGroups = [];
    const sceneGroupMap = new Map();
    const autoNames = [];        // 纳入 ⚡ 自动选择
    const standaloneNames = [];  // 未命中规则的普通节点

    entries.forEach(entry => {
        let proxy;
        try {
            proxy = buildProxy(entry);
        } catch (_) {
            return;  // 单条链接解析失败不影响其余节点
        }
        if (!proxy) return;

        proxy.name = uniqueName(usedNames, entry.name);
        proxies.push(proxy);

        if (entry.scene) {
            let group = sceneGroupMap.get(entry.scene);
            if (!group) {
                group = {
                    name: String(SCENE.groupNameTemplate || "{name} 场景").replace("{name}", entry.scene),
                    members: []
                };
                sceneGroupMap.set(entry.scene, group);
                sceneGroups.push(group);
            }
            group.members.push(proxy.name);
            if (entry.auto) autoNames.push(proxy.name);
        } else {
            standaloneNames.push(proxy.name);
            autoNames.push(proxy.name);
        }
    });

    // 场景组名去重（与原节点名或彼此撞车时不会破坏配置）
    const usedGroupNames = new Set();
    sceneGroups.forEach(g => { g.name = uniqueName(usedGroupNames, g.name); });

    const sceneGroupNames = sceneGroups.map(g => g.name);
    const autoMembers = autoNames.length > 0 ? autoNames : ["DIRECT"];
    const innerMembers = [...sceneGroupNames, ...standaloneNames];

    const yaml = [
        `mixed-port: 7890`,
        `allow-lan: true`,
        `mode: Rule`,
        `log-level: info`,
        `proxies:`,
        ...proxies.map(p => `  - ${JSON.stringify(p)}`),
        `proxy-groups:`,
        `  - { name: 🚀 节点选择, type: select, proxies: [${["⚡ 自动选择", ...innerMembers, "DIRECT"].map(yq).join(", ")}] }`,
        `  - { name: ⚡ 自动选择, type: url-test, proxies: [${autoMembers.map(yq).join(", ")}], url: http://www.gstatic.com/generate_204, interval: 300 }`,
        ...sceneGroups.map(g => `  - { name: ${yq(g.name)}, type: select, proxies: [${g.members.map(yq).join(", ")}] }`),
        `  - { name: 🎥 奈飞视频, type: select, proxies: [${["🚀 节点选择", ...innerMembers].map(yq).join(", ")}] }`,
        `  - { name: 📲 电报消息, type: select, proxies: [🚀 节点选择, DIRECT] }`,
        `  - { name: 🍎 苹果服务, type: select, proxies: [DIRECT, 🚀 节点选择] }`,
        `  - { name: 🐟 漏网之鱼, type: select, proxies: [🚀 节点选择, DIRECT] }`,
        `rules:`,
        `  - DOMAIN-SUFFIX,google.com,🚀 节点选择`,
        `  - DOMAIN-SUFFIX,netflix.com,🎥 奈飞视频`,
        `  - DOMAIN-SUFFIX,telegram.org,📲 电报消息`,
        `  - DOMAIN-KEYWORD,apple,🍎 苹果服务`,
        `  - GEOIP,CN,DIRECT`,
        `  - MATCH,🐟 漏网之鱼`
    ].join("\n");

    return new Response(yaml, { headers: { "content-type": "text/yaml; charset=utf-8" } });
}

/**
 * 由展开后的条目构造单个 Clash 节点对象
 */
function buildProxy(entry) {
    const parsed = parseLinkBody(entry.body);
    const url = parsed.url;
    const params = url.searchParams;
    const protocol = parsed.protocol;
    const portRange = parsed.portRange;

    let p = {
        name: entry.name, type: protocol, server: url.hostname, port: parseInt(url.port),
        udp: true, "skip-cert-verify": true
    };

    // hysteria2 / hy2 协议解析
    if (protocol === "hysteria2" || protocol === "hy2") {
        p.type = "hysteria2";
        p.password = decodeURIComponent(url.username || url.password || "");
        p["skip-cert-verify"] = ["1", "true"].includes((params.get("insecure") || "").toLowerCase());
        if (params.get("sni")) p.sni = params.get("sni");
        // 上行/下行带宽声明：分场景副本会带上，手动写在链接里也支持。
        // 只有声明了带宽才会启用 Brutal，否则退回 BBR
        if (params.get("up")) p.up = params.get("up");
        if (params.get("down")) p.down = params.get("down");
        // salamander 混淆（可选）
        if (params.get("obfs") === "salamander" && params.get("obfs-password")) {
            p.obfs = "salamander";
            p["obfs-password"] = params.get("obfs-password");
        }
        // 端口跳跃（可选），Clash 字段为 ports；支持 ?mport= 参数和 host:起始-结束 两种写法
        if (params.get("mport")) p.ports = params.get("mport");
        if (portRange) p.ports = portRange;
    } else if (protocol === "vless") {
        p.uuid = url.username;
        p.tls = params.get("security") === "tls" || params.get("security") === "reality";
        p.network = params.get("type") || "tcp";
        if (params.get("sni")) p.servername = params.get("sni");
        if (params.get("flow")) p.flow = params.get("flow");
        if (params.get("security") === "reality") {
            p["reality-opts"] = { "public-key": params.get("pbk"), "short-id": params.get("sid") || "" };
            p["client-fingerprint"] = params.get("fp") || "chrome";
        }
        if (p.network === "ws") {
            p["ws-opts"] = { path: params.get("path") || "/", headers: { Host: params.get("host") || url.hostname } };
        }
    } else if (protocol === "trojan") {
        p.password = url.username;
        p.tls = true;
        if (params.get("sni")) p.sni = params.get("sni");
    }

    return p;
}

/**
 * 身份验证页面
 */
function getAuthHTML(mode) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>身份验证</title></head><body style="background:#090b0f;color:#fff;display:grid;place-items:center;height:100vh;font-family:sans-serif;">
    <form method="POST" action="/admin/${mode}" style="background:#111620;padding:2rem;border-radius:8px;border:1px solid #263244;">
      <h2 style="margin-top:0;">${mode === 'setup' ? '设置管理密码' : '管理员登录'}</h2>
      <input name="password" type="password" placeholder="请输入密码" style="width:100%;padding:10px;margin:1rem 0;background:#000;color:#fff;border:1px solid #263244;border-radius:4px;">
      <button type="submit" style="width:100%;padding:10px;background:#20d0a8;border:0;border-radius:4px;font-weight:bold;cursor:pointer;">确认</button>
    </form>
  </body></html>`;
}

/**
 * 可视化管理后台页面
 */
function getDashboardHTML(data) {
    const d = data || {};
    const links = String(d.links || "");
    const token = String(d.token || "");
    // origin 由请求 Host 推出，异常值（如 "null"）直接丢弃，避免拼出坏链接
    const origin = /^https?:\/\/[A-Za-z0-9.\-:\[\]]+$/.test(String(d.origin || "")) ? String(d.origin) : "";
    const graceUntil = d.grace && Number(d.grace.until) > Date.now() ? Number(d.grace.until) : 0;
    const generated = !!d.generated;

    const subUrl = `${origin}/sub?token=${encodeURIComponent(token)}`;

    // 处理数据中的反引号和换行，防止 JS 注入错误
    const safeLinks = links.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$").replace(/\r/g, "");

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>可视化管理后台</title>
    <style>
      :root { --primary: #20d0a8; --bg: #090b0f; --panel: #111620; --text: #fff; --line: #263244; --dim: #9aa7b8; --warn: #e6a23c; }
      body { background: var(--bg); color: var(--text); padding: 2rem; font-family: sans-serif; }
      .container { max-width: 1000px; margin: 0 auto; }
      header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; gap: 12px; }
      header h1 { margin: 0; font-size: 20px; }
      .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 20px; }
      .panel h2 { margin: 0 0 12px; font-size: 14px; color: var(--primary); letter-spacing: 0.5px; }
      .node-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 12px; position: relative; }
      .input-group { display: flex; gap: 10px; margin-bottom: 8px; align-items: flex-end; }
      .input-group div { flex: 1; }
      label { display: block; font-size: 11px; color: var(--dim); margin-bottom: 4px; }
      input { width: 100%; padding: 8px; background: #000; color: var(--primary); border: 1px solid var(--line); border-radius: 4px; box-sizing: border-box; outline: none; font-family: ui-monospace, monospace; font-size: 12px; }
      input:focus { border-color: var(--primary); }
      .btn { padding: 10px 20px; border-radius: 4px; border: 0; font-weight: bold; cursor: pointer; transition: opacity 0.2s; font-size: 13px; }
      .btn:hover { opacity: 0.8; }
      .btn-save { background: var(--primary); color: #000; }
      .btn-ghost { background: transparent; border: 1px solid var(--line); color: var(--dim); padding: 8px 14px; }
      .btn-add { background: transparent; border: 1px dashed var(--line); color: var(--dim); width: 100%; margin-top: 10px; }
      .btn-del { background: #e65c53; color: #fff; padding: 6px 12px; font-size: 12px; margin-top: 8px; }
      .hint { font-size: 12px; color: var(--dim); margin: 8px 0 0; line-height: 1.6; }
      .warn { font-size: 12px; color: var(--warn); margin: 0 0 10px; }
      .actions { display: flex; gap: 10px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
      .actions input { flex: 1; min-width: 220px; }
      a { color: var(--primary); font-size: 13px; text-decoration: none; }
    </style>
  </head>
  <body>
    <div class="container">
      <header>
        <h1>SubLink Pro 可视化管理</h1>
        <div style="display:flex;gap:10px;align-items:center;">
          <a href="/admin/logout">退出登录</a>
          <button onclick="saveAll()" id="saveBtn" class="btn btn-save">保存所有更改</button>
        </div>
      </header>

      <div class="panel">
        <h2>订阅鉴权</h2>
        ${generated ? `<p class="warn">原先没有配置 token，已自动生成一个。请立刻把下面的订阅地址换到各客户端上 —— 旧地址（不带 token）现在已经拉不到节点了。</p>` : ``}
        <div class="input-group">
          <div>
            <label>当前 token（这个就是密钥，不要外传）</label>
            <input id="tokenBox" value="${esc(token)}" readonly onclick="this.select()">
          </div>
          <button type="button" class="btn btn-ghost" onclick="copyVal('tokenBox', this)">复制</button>
        </div>
        <div class="input-group">
          <div>
            <label>通用订阅地址（Base64）</label>
            <input id="subUrl" value="${esc(subUrl)}" readonly onclick="this.select()">
          </div>
          <button type="button" class="btn btn-ghost" onclick="copyVal('subUrl', this)">复制</button>
        </div>
        <div class="input-group">
          <div>
            <label>Clash / Mihomo 订阅地址</label>
            <input id="clashUrl" value="${esc(subUrl + "&target=clash")}" readonly onclick="this.select()">
          </div>
          <button type="button" class="btn btn-ghost" onclick="copyVal('clashUrl', this)">复制</button>
        </div>
        <div class="actions">
          <button type="button" class="btn btn-ghost" onclick="rotateToken()">重新生成 token</button>
          <input id="customToken" placeholder="自定义 token（8-128 位：字母 / 数字 / - / _）">
          <button type="button" class="btn btn-ghost" onclick="setToken()">保存自定义</button>
        </div>
        <p class="hint" id="graceTip"></p>
        <p class="hint">
          换 token 之后旧 token 会保留一段宽限期，各设备可以慢慢换，不用一次性全部改完。<br>
          也支持 <code>/sub/&lt;token&gt;</code> 这种路径写法，以及 <code>Authorization: Bearer &lt;token&gt;</code> 请求头。
        </p>
      </div>

      <div class="panel">
        <h2>管理密码</h2>
        <div class="actions">
          <input id="newPwd" type="password" placeholder="新管理密码（至少 6 位）">
          <button type="button" class="btn btn-ghost" onclick="changePwd()">修改</button>
        </div>
        <p class="hint">修改后所有旧登录状态立即失效，其它设备需要重新登录。管理密码在 KV 里是明文存的，别复用重要密码。</p>
      </div>

      <h2 style="font-size:14px;color:#9aa7b8;">节点列表</h2>
      <div id="nodeList"></div>
      <button onclick="addNode('', '')" class="btn btn-add">+ 添加新节点</button>
    </div>

    <script>
      let nodes = [];
      const rawLinks = \`${safeLinks}\`;
      const graceUntil = ${graceUntil};

      const graceTip = document.getElementById('graceTip');
      graceTip.textContent = graceUntil > Date.now()
        ? '旧 token 宽限至 ' + new Date(graceUntil).toLocaleString() + '，之后自动失效'
        : '旧 token 已失效（当前只有上面这一个 token 可用）';

      function copyVal(id, btn) {
        const el = document.getElementById(id);
        el.select();
        const text = el.value;
        const done = () => { const t = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = t; }, 1500); };
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => { document.execCommand('copy'); done(); });
        else { document.execCommand('copy'); done(); }
      }

      async function postToken(payload) {
        const res = await fetch('/admin/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) { alert(j.error || '操作失败'); return; }
        location.reload();
      }

      function rotateToken() {
        if (!confirm('重新生成后，旧 token 只在一段宽限期内仍然可用。继续？')) return;
        postToken({ action: 'rotate' });
      }

      function setToken() {
        const v = document.getElementById('customToken').value.trim();
        if (!v) { alert('请先填写要使用的 token'); return; }
        postToken({ action: 'set', token: v });
      }

      async function changePwd() {
        const input = document.getElementById('newPwd');
        const v = input.value;
        if (v.length < 6) { alert('密码至少 6 位'); return; }
        const res = await fetch('/admin/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: v })
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) { alert(j.error || '修改失败'); return; }
        input.value = '';
        alert('已修改。其它设备需要重新登录。');
      }

      function init() {
        const lines = rawLinks.split('\\n').filter(l => l.trim());
        if (lines.length === 0) {
          addNode('', '');
        } else {
          lines.forEach(line => {
            const parts = line.split('#');
            const link = parts[0];
            let name = '新节点';
            try { name = parts[1] ? decodeURIComponent(parts[1]) : '新节点'; } catch (_) {}
            nodes.push({ id: Math.random(), name, link });
          });
          render();
        }
      }

      function addNode(name, link) {
        nodes.push({ id: Math.random(), name, link });
        render();
      }

      function removeNode(id) {
        nodes = nodes.filter(n => n.id !== id);
        render();
      }

      function updateNode(id, field, value) {
        const node = nodes.find(n => n.id === id);
        if (field === 'link' && value.includes('#')) {
            const parts = value.split('#');
            node.link = parts[0];
            try { node.name = decodeURIComponent(parts[1]); } catch (_) { node.name = parts[1]; }
            render();
        } else {
            node[field] = value;
        }
      }

      function render() {
        const container = document.getElementById('nodeList');
        container.innerHTML = nodes.map(n => \`
          <div class="node-card">
            <div class="input-group">
              <div style="flex: 0.3;">
                <label>节点名称</label>
                <input type="text" value="\${n.name}" oninput="updateNode(\${n.id}, 'name', this.value)">
              </div>
              <div>
                <label>节点链接 (粘贴带#的链接自动解析)</label>
                <input type="text" value="\${n.link}" oninput="updateNode(\${n.id}, 'link', this.value)">
              </div>
            </div>
            <button class="btn btn-del" onclick="removeNode(\${n.id})">删除节点</button>
          </div>
        \`).join('');
      }

      async function saveAll() {
        const saveBtn = document.getElementById('saveBtn');
        saveBtn.innerText = '正在保存...';
        saveBtn.disabled = true;

        const finalLinks = nodes
          .filter(n => n.link.trim())
          .map(n => n.link.trim() + '#' + encodeURIComponent(n.name || '未命名'))
          .join('\\n');

        try {
          const res = await fetch('/update-links', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ links: finalLinks })
          });
          if (res.ok) saveBtn.innerText = '保存成功！';
          else saveBtn.innerText = '保存失败';
        } catch (e) {
          saveBtn.innerText = '网络错误';
        }

        setTimeout(() => {
          saveBtn.innerText = '保存所有更改';
          saveBtn.disabled = false;
        }, 2000);
      }

      init();
    </script>
  </body></html>`;
}

/**
 * ============================================================
 *  鉴权工具
 * ============================================================
 */

/** HTML 转义：token / origin 进 HTML 前统一过一遍 */
function esc(value) {
    return String(value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * 定长比较。
 * 不要用 === 直接比 token：逐字符短路会让「前几位猜对」和「完全不对」
 * 的耗时不一样，理论上能一位一位把 token 试出来。
 */
function safeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length === 0 || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/** 32 位十六进制随机串（16 字节 = 128 bit） */
function randomToken() {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    return Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 从 Cookie 头里精确取出某个 cookie。
 * 不能用 includes(SESSION_COOKIE)：那样叫 x__Host-sublink_session 的
 * 其它 cookie 也会被当成本会话。
 */
function readCookie(request, name) {
    const raw = request.headers.get("Cookie") || "";
    for (const part of raw.split(";")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return "";
}

/**
 * 后台会话票据 = HMAC-SHA256(管理密码, 固定盐)。
 *
 * 无状态：登录不必写 KV，也就没有「刚写完读不到」的一致性问题。
 * 签名密钥就是密码本身，所以改密码 = 所有旧会话立刻失效。
 *
 * 以前是把 cookie 值固定成 "valid" 并且只判存在性 —— 任何人手搓一个
 * 同名 cookie 就能进后台改节点。现在必须拿得出正确签名才认。
 */
async function sessionTicket(password) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw", enc.encode(String(password)),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode("sublink-admin-session-v1"));
    return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, "0")).join("");
}

/** 后台会话校验。password 可传入已读到的值，省一次 KV 读 */
async function isAdmin(env, request, password) {
    const pw = password === undefined ? await env.sub.get("admin_password") : password;
    if (!pw) return false;
    const ticket = readCookie(request, SESSION_COOKIE);
    if (!ticket) return false;
    return safeEqual(ticket, await sessionTicket(pw));
}

/** 读取宽限期内的旧 token；已过期或数据脏就当没有 */
async function readGrace(kv) {
    const raw = await kv.get("sub_token_prev");
    if (!raw) return null;
    try {
        const o = JSON.parse(raw);
        if (o && o.token && Number(o.until) > Date.now()) return { token: o.token, until: Number(o.until) };
    } catch (_) { /* 脏数据，忽略 */ }
    return null;
}

/**
 * 订阅请求的 token 校验，返回 { ok, reason }。
 * 支持的传法：?token=xxx、/sub/xxx、Authorization: Bearer xxx（可同时存在）
 */
async function checkSubToken(env, request, url, pathToken) {
    if (!AUTH.enabled) return { ok: true };

    const candidates = [];
    const q = url.searchParams.get(AUTH.param);
    if (q) candidates.push(q);

    if (AUTH.allowPathToken && pathToken) {
        try { candidates.push(decodeURIComponent(pathToken)); }
        catch (_) { candidates.push(pathToken); }
    }

    if (AUTH.allowBearerHeader) {
        const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
        if (m) candidates.push(m[1].trim());
    }

    const current = await env.sub.get("sub_token");
    // 没配 token 就拒绝一切：宁可订阅暂时拉不动，也不能退化成人人可读
    if (!current) return { ok: false, reason: "unset" };
    if (candidates.length === 0) return { ok: false, reason: "missing" };

    for (const c of candidates) if (safeEqual(c, current)) return { ok: true };

    // 轮换宽限期：旧 token 在新 token 生效后还能用一段时间
    if (AUTH.graceHours > 0) {
        const grace = await readGrace(env.sub);
        if (grace) {
            for (const c of candidates) if (safeEqual(c, grace.token)) return { ok: true, grace: true };
        }
    }

    return { ok: false, reason: "invalid" };
}

/** 鉴权失败响应：不返回任何节点内容 */
function tokenDenied(reason) {
    const msg = reason === "unset"
        ? "订阅 token 尚未配置。请登录 /admin 生成后再使用。"
        : "订阅 token 缺失或无效。";
    return new Response(msg, {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" }
    });
}
