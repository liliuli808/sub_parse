/**
 * SubLink Pro - 可视化管理完整修复版
 * 功能：可视化节点编辑、自动解析链接名称、中文乱码修复、Clash 配置分发
 */

const SESSION_COOKIE = "__Host-sublink_session";

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/$/, "") || "/";
        const userAgent = (request.headers.get("User-Agent") || "").toLowerCase();

        try {
            // --- 1. 订阅分发逻辑 ---
            if (path === "/" || path === "/sub") {
                const kv = env.sub;
                if (!kv) return new Response("错误：请在 Settings -> Bindings 中绑定名为 'sub' 的 KV 空间", { status: 503 });

                const rawContent = await kv.get("vpn_links") || "";

                // 如果是 Clash 客户端或带有 target=clash 参数
                if (userAgent.includes("clash") || url.searchParams.get("target") === "clash") {
                    return generateClashResponse(rawContent);
                }

                // 普通订阅返回 Base64（支持中文）
                const base64 = btoa(unescape(encodeURIComponent(rawContent)));
                return new Response(base64, {
                    headers: { "content-type": "text/plain; charset=utf-8" }
                });
            }

            // --- 2. 管理后台路由 ---
            if (path === "/admin") {
                const kv = env.sub;
                const passwordEntry = await kv.get("admin_password");
                // 首次运行设置密码
                if (!passwordEntry) return new Response(getAuthHTML("setup"), { headers: { "content-type": "text/html; charset=UTF-8" } });

                const cookie = request.headers.get("Cookie") || "";
                if (!cookie.includes(SESSION_COOKIE)) return new Response(getAuthHTML("login"), { headers: { "content-type": "text/html; charset=UTF-8" } });

                const links = await kv.get("vpn_links") || "";
                return new Response(getDashboardHTML(links), { headers: { "content-type": "text/html; charset=UTF-8" } });
            }

            // 登录与初始化密码处理
            if (path === "/admin/login" || path === "/admin/setup") {
                const form = await request.formData();
                const password = form.get("password");
                if (path === "/admin/setup") {
                    await env.sub.put("admin_password", password);
                } else {
                    const saved = await env.sub.get("admin_password");
                    if (password !== saved) return new Response("密码错误", { status: 403 });
                }
                return new Response("验证成功", {
                    headers: {
                        "set-cookie": `${SESSION_COOKIE}=valid; Path=/; Max-Age=604800; Secure; HttpOnly; SameSite=Strict`,
                        "location": "/admin"
                    },
                    status: 303
                });
            }

            // API: 更新链接（需登录）
            if (path === "/update-links") {
                const cookie = request.headers.get("Cookie") || "";
                if (!cookie.includes(SESSION_COOKIE)) return new Response("未授权", { status: 401 });
                const body = await request.json();
                await env.sub.put("vpn_links", body.links);
                return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
            }

            return new Response("Not Found", { status: 404 });

        } catch (e) {
            return new Response("Internal Error: " + e.message, { status: 500 });
        }
    }
};

/**
 * 生成 Clash YAML 配置
 */
function generateClashResponse(rawContent) {
    const lines = rawContent.split(/\r?\n/);
    const proxies = [];
    const usedNames = new Set();

    lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes("://")) return;
        try {
            const url = new URL(trimmed);
            const protocol = url.protocol.replace(":", "");
            const params = url.searchParams;
            let name = `节点-${i + 1}`;
            try { name = decodeURIComponent(url.hash.replace("#", "")) || name; } catch (_) {}

            // 名称去重：重名时自动追加序号，避免 Clash 报 duplicate name
            if (usedNames.has(name)) {
                let n = 2;
                while (usedNames.has(`${name}-${n}`)) n++;
                name = `${name}-${n}`;
            }
            usedNames.add(name);

            let p = {
                name, type: protocol, server: url.hostname, port: parseInt(url.port),
                udp: true, "skip-cert-verify": true
            };

            // hysteria2 / hy2 协议解析
            if (protocol === "hysteria2" || protocol === "hy2") {
                p.type = "hysteria2";
                p.password = decodeURIComponent(url.username || url.password || "");
                if (params.get("sni")) p.sni = params.get("sni");
                // salamander 混淆（可选）
                if (params.get("obfs") === "salamander" && params.get("obfs-password")) {
                    p.obfs = "salamander";
                    p["obfs-password"] = params.get("obfs-password");
                }
                // 端口跳跃（可选），Clash 字段为 ports
                if (params.get("mport")) p.ports = params.get("mport");
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
            proxies.push(p);
        } catch (e) {}
    });

    const proxyNames = proxies.length > 0 ? proxies.map(p => p.name) : ["DIRECT"];

    const yaml = [
        `mixed-port: 7890`,
        `allow-lan: true`,
        `mode: Rule`,
        `log-level: info`,
        `proxies:`,
        ...proxies.map(p => `  - ${JSON.stringify(p)}`),
        `proxy-groups:`,
        `  - { name: 🚀 节点选择, type: select, proxies: [⚡ 自动选择, ${proxyNames.join(", ")}, DIRECT] }`,
        `  - { name: ⚡ 自动选择, type: url-test, proxies: [${proxyNames.join(", ")}], url: http://www.gstatic.com/generate_204, interval: 300 }`,
        `  - { name: 🎥 奈飞视频, type: select, proxies: [🚀 节点选择, ${proxyNames.join(", ")}] }`,
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
function getDashboardHTML(links) {
    // 处理数据中的反引号和换行，防止 JS 注入错误
    const safeLinks = links.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$").replace(/\r/g, "");

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>可视化管理后台</title>
    <style>
      :root { --primary: #20d0a8; --bg: #090b0f; --panel: #111620; --text: #fff; }
      body { background: var(--bg); color: var(--text); padding: 2rem; font-family: sans-serif; }
      .container { max-width: 1000px; margin: 0 auto; }
      header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
      .node-card { background: var(--panel); border: 1px solid #263244; border-radius: 8px; padding: 16px; margin-bottom: 12px; position: relative; }
      .input-group { display: flex; gap: 10px; margin-bottom: 8px; }
      .input-group div { flex: 1; }
      label { display: block; font-size: 11px; color: #9aa7b8; margin-bottom: 4px; }
      input { width: 100%; padding: 8px; background: #000; color: var(--primary); border: 1px solid #263244; border-radius: 4px; box-sizing: border-box; outline: none; }
      input:focus { border-color: var(--primary); }
      .btn { padding: 10px 20px; border-radius: 4px; border: 0; font-weight: bold; cursor: pointer; transition: opacity 0.2s; }
      .btn:hover { opacity: 0.8; }
      .btn-save { background: var(--primary); color: #000; }
      .btn-add { background: transparent; border: 1px dashed #263244; color: #9aa7b8; width: 100%; margin-top: 10px; }
      .btn-del { background: #e65c53; color: #fff; padding: 6px 12px; font-size: 12px; margin-top: 8px; }
    </style>
  </head>
  <body>
    <div class="container">
      <header>
        <h1>SubLink Pro 可视化管理</h1>
        <button onclick="saveAll()" id="saveBtn" class="btn btn-save">保存所有更改</button>
      </header>
      <div id="nodeList"></div>
      <button onclick="addNode('', '')" class="btn btn-add">+ 添加新节点</button>
    </div>

    <script>
      let nodes = [];
      const rawLinks = \`${safeLinks}\`;

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

