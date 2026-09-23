# SubLink Pro

一个部署在 Cloudflare Workers 上的轻量级订阅管理工具。它使用 Workers KV 保存节点链接，提供可视化管理后台，并能根据客户端类型返回 Base64 通用订阅或 Clash YAML 配置。

## 功能

- 在网页后台中添加、编辑和删除节点
- 从带 `#节点名称` 的链接中自动解析名称
- 普通请求返回 Base64 编码的原始订阅
- 可将订阅转换为 Clash/Mihomo 使用的 YAML 配置
- 支持中文节点名称，并自动处理 Clash 节点重名
- Clash 转换支持 VLESS、Trojan 和 Hysteria2/Hy2
- Hysteria2 支持 `mport` 参数和 `host:起始端口-结束端口` 两种端口跳跃写法
- 分场景节点副本：同一节点按带宽档位展开为多个副本，适配家宽 / 移动 / 弱网
- 订阅地址带 token 鉴权：没有 token 拿不到任何节点内容
- token 轮换带宽限期，换 token 不用一次性改完所有设备

## 工作方式

| 地址 | 用途 |
| --- | --- |
| `/`、`/sub` | 返回订阅；默认是 Base64，Clash User-Agent 自动返回 YAML。**必须带 token** |
| `/sub?token=xxx` | 带 token 的订阅地址（后台里可直接复制现成的） |
| `/sub/<token>` | 同上，路径写法 |
| `/sub?token=xxx&target=clash` | 强制返回 Clash YAML |
| `/sub?token=xxx&scene=0` | 关闭分场景节点副本，返回原始节点 |
| `/admin` | 管理后台；首次访问时设置管理密码 |
| `/admin/logout` | 退出登录 |
| `POST /update-links` | 保存节点（需登录） |
| `POST /admin/token` | 轮换 / 自定义订阅 token（需登录） |

KV 里的键：

| 键 | 内容 |
| --- | --- |
| `vpn_links` | 节点链接 |
| `admin_password` | 管理密码 |
| `sub_token` | 当前订阅 token |
| `sub_token_prev` | 轮换前旧 token 及其失效时间（宽限期用） |

## 部署

### 前置条件

- Cloudflare 账号
- Node.js 和 npm

### 1. 登录 Cloudflare

```bash
npx wrangler login
```

### 2. 创建 KV 命名空间

在项目目录执行：

```bash
npx wrangler kv namespace create sub
```

命令会返回一个 KV 命名空间 ID。打开 `wrangler.toml`，将 `id` 替换为你自己的 ID；`binding` 必须保持为 `sub`：

```toml
name = "soft-unit-b360"
main = "worker.js"
compatibility_date = "2025-01-01"

[[kv_namespaces]]
binding = "sub"
id = "你的_KV_NAMESPACE_ID"
```

`name` 是 Worker 名称，可以按需修改。仓库中已有的 KV ID 属于原部署账号，复制项目后必须替换。

### 3. 发布 Worker

```bash
npx wrangler deploy
```

发布完成后，Wrangler 会输出类似下面的访问地址：

```text
https://你的-worker.你的子域.workers.dev
```

也可以在 Cloudflare Dashboard 中为 Worker 配置自定义域名。

### 4. 初始化后台

部署后立即访问：

```text
https://你的域名/admin
```

首次访问会显示密码设置页。设置完成后即可进入后台，添加节点并点击“保存所有更改”。

后台进来后先看顶部的「订阅鉴权」面板：如果之前没配过 token，这里会自动生成一个，并给出两条已经带好 token 的订阅地址，直接复制到客户端即可。**在此之前，不带 token 的订阅地址会返回 403。**

## 使用订阅

订阅地址必须带 token。最省事的做法是直接打开后台，把「订阅鉴权」面板里的两条地址复制走 —— 那里已经带好了 token。

### Base64 通用订阅

```text
https://你的域名/sub?token=<你的 token>
```

### Clash/Mihomo 订阅

```text
https://你的域名/sub?token=<你的 token>&target=clash
```

当请求的 User-Agent 中包含 `clash` 时，`/` 和 `/sub` 也会自动返回 Clash YAML。需要稳定指定格式时，建议显式添加 `&target=clash`。

也支持另外两种传法，适合脚本和 curl：

```bash
# 路径写法
curl 'https://你的域名/sub/<你的 token>?target=clash'

# 请求头写法
curl -H 'Authorization: Bearer <你的 token>' 'https://你的域名/sub?target=clash'
```

## 订阅鉴权

### 为什么需要

原来订阅地址就是「域名 + /sub」。域名好猜，链接也容易从浏览器记录、同步软件、截图里泄漏出去，而一旦泄漏就等于把全部节点交出去了 —— 路径本身不构成任何秘密。

所以真正需要保密的应该是 URL 里的随机串。加了 token 之后，**URL 本身就是密码**。

### 行为

- 没有 token、或 token 不对 → 一律 `403`，不返回任何节点内容
- **失败即关闭**：token 没配好时订阅是拉不动的，不会退化成谁都能读
- 鉴权在订阅入口统一处理，Clash 的 User-Agent 识别和 `?scene=0` 都不能绕过

### 轮换

后台「订阅鉴权」面板可以一键重新生成，也可以填一个自定义 token（8-128 位，只允许字母、数字、`-`、`_`）。

轮换后旧 token 会保留一段宽限期（默认 24 小时）仍然可用，这样不必一次性把所有设备都改完。宽限期在 `worker.js` 的 `AUTH.graceHours` 里改，设为 `0` 即立即失效。

首次进入后台时，如果还没有配过 token，会自动生成一个并提示你立刻替换客户端地址 —— 免得部署完忘了配，订阅直接 403 还不知道去哪拿 token。

### 关掉鉴权

调试时可以把 `worker.js` 顶部的 `AUTH.enabled` 改成 `false`。**不建议在公网长期这样跑。**

## 节点格式

后台每个节点包含“节点名称”和“节点链接”。也可以直接粘贴带名称的完整 URI，后台会自动拆分 `#` 后的名称。

示例（均为虚构数据）：

```text
vless://00000000-0000-0000-0000-000000000000@example.com:443?security=reality&sni=example.com&pbk=PUBLIC_KEY&sid=SHORT_ID&type=tcp#香港节点
trojan://password@example.com:443?sni=example.com#新加坡节点
hysteria2://password@example.com:443?sni=example.com#日本节点
hysteria2://password@example.com:20000-30000?sni=example.com#端口跳跃节点
```

Clash 转换目前针对以下内容做了专门处理：

- VLESS：TLS、Reality、TCP、WebSocket、SNI、Flow
- Trojan：密码、TLS、SNI
- Hysteria2/Hy2：密码、SNI、Salamander 混淆、端口跳跃

其他 URI 仍会保留在 Base64 原始订阅中，但不保证能正确转换为可用的 Clash 节点。

## 分场景节点副本

### 为什么需要

hysteria2 的 `up` / `down`（带宽声明）有两个性质：

- 它是**硬上限**，实际速率取「声明值」与「服务端限制值」的较小值 —— 填低就是白白限速
- 只有客户端声明了带宽才会启用 **Brutal** 拥塞控制，不声明则退回 BBR —— 在高 RTT 链路上单流速度差一个数量级

而同一个订阅会同时被家宽、手机 4G、弱网热点等不同网络使用，写死单一档位必然顾此失彼：

| 填法 | 家宽 | 手机 4G |
| --- | --- | --- |
| 按家宽填（30/80） | 正常 | 超发，持续重传、白烧流量 |
| 按手机填（10/50） | 白损失一半以上速度 | 正常 |

### 做法

在生成侧把每个 hysteria2 节点的多个档位各做成一个独立节点，各端按当前网络挑对应档位即可（切节点即切场景），不需要给每台设备单独改配置。

默认对**所有** `hysteria2` / `hy2` 节点生效 —— 以后往订阅里加新节点会自动带上档位，不会漏配。以 `日本2` 为例，会展开为：

```text
日本2 · 家宽     up: 30 Mbps  down: 80 Mbps
日本2 · 移动     up: 10 Mbps  down: 50 Mbps
日本2 · BBR      不写带宽 → 走 BBR 自适应
```

并自动生成一个场景选择组，挂到 `🚀 节点选择` 下：

```yaml
- { name: 🎚 日本2 场景, type: select, proxies: [日本2 · 家宽, 日本2 · 移动, 日本2 · BBR] }
```

### 配置

改 `worker.js` 顶部的 `SCENE` 常量：

| 字段 | 说明 |
| --- | --- |
| `matchMode` | `"all"`（默认）处理所有 hy2 节点；`"list"` 只处理下面的白名单 |
| `matchNames` / `matchServers` | 仅 `matchMode: "list"` 时生效，节点名称或服务器地址任一命中即可 |
| `tiers` | 档位列表，每个命中节点按此展开。`up` / `down` 为 `null` 时不写该字段（走 BBR） |
| `tiers[].auto` | 是否纳入 `⚡ 自动选择` 测速组。**同一服务器各档位延迟相同**，全部纳入会让测速组随机挑到慢档位，所以建议只放一个 |
| `nameSeparator` | 副本名分隔符，默认 ` · ` |
| `groupNameTemplate` | 场景组名模板，`{name}` 替换为原节点名 |
| `keepOriginal` | 是否额外保留不带带宽的原始节点，默认 `false` |
| `applyToPlainSubscription` | 是否把副本一并写入 Base64 通用订阅 |

带宽通过链接的 `up` / `down` 参数携带。mihomo 的 hysteria2 链接解析器会读取这两个参数，因此 Clash YAML 与 Base64 通用订阅可以共用同一份展开结果。

> 链接里原本就带 `up` / `down` 时，展开会先摘掉旧值再写入档位值 —— 因为 `URLSearchParams.get()` 只返回第一个同名参数，直接追加的话档位会被旧值压住。

### 各客户端的支持情况

| 客户端 | 是否生效 |
| --- | --- |
| Clash Verge / CMFA / FlClash | 走 Clash YAML，完整支持（含场景组） |
| Karing 等基于 mihomo 的客户端 | 走 Base64 订阅，能读到 `up` / `down` 参数 |
| Shadowrocket / Stash 等 | 会忽略参数，只是多出几个同名副本（可把 `applyToPlainSubscription` 设为 `false` 关掉） |

### 与 Clash Verge 扩展脚本的关系

如果同时使用了 Clash Verge 的「扩展脚本」给节点补带宽，需要让脚本跳过这里已经处理好的副本（`up` / `down` 已存在，或名字带档位后缀），否则会把各档位统一改写成同一个值。

注意 `BBR` 档是**故意不带** `up` / `down` 的，只判断「已有带宽」不够 —— 还必须跳过名字带档位后缀的节点。

脚本与订阅侧的默认口径已对齐：都是「所有 hysteria2 节点」。订阅侧正常工作时脚本什么都不做；一旦订阅侧回退（`?scene=0` 或没跟上），脚本按 `30/80` 给所有 hy2 节点兜底。

### 开关

订阅地址加 `?scene=0`（或 `off` / `false` / `no`）即可临时关闭，返回原始节点列表。注意 token 仍然要带，例如 `?token=xxx&scene=0`。

## 本地开发

```bash
npx wrangler dev
```

按终端输出的本地地址访问 `/admin`。Wrangler 本地开发默认使用本地 KV 数据，因此本地设置的密码和节点不会影响线上环境。

项目结构：

```text
.
├── worker.js       # 路由、鉴权页面、管理后台、订阅转换与分场景副本逻辑
├── wrangler.toml   # Worker 与 KV 绑定配置
├── test/           # 本地测试
└── README.md
```

### 测试

```bash
sh test/run.sh
```

会依次跑五步：

| 步骤 | 内容 |
| --- | --- |
| 1 | 端到端生成（Clash YAML / Base64 / `?scene=0`）+ 鉴权闸门 |
| 2 | 鉴权回归：订阅 token、轮换宽限期、后台会话、改密、伪造 cookie（70 项） |
| 3 | 边界与异常路径（38 项） |
| 4 | Clash Verge 扩展脚本回归（17 项） |
| 5 | 用 YAML 解析器做结构校验 |

测试里用 `test/kv.mjs` 的内存 KV 替掉 Workers KV，用 `test/bootstrap.mjs` 补 WebCrypto。

`test/run.sh` 会把 `worker.js` 复制成 `worker.mjs` 再跑 —— 因为项目根目录没有 `package.json` 声明 `type=module`，Node 会按 CommonJS 解析 `.js`。复制成 `.mjs` 可以绕开，不必为了跑测试去动部署用的 wrangler 配置。

`bootstrap.mjs` 存在的原因：worker 用的 WebCrypto 在 Cloudflare Workers 里是内置全局，但 Node 要 19 才默认暴露全局 `crypto`。本机 WSL 是 Node 18，不补的话 worker 里一调就是 `crypto is not defined` → 500。生产代码不该为测试环境打补丁，所以补在测试这一侧。

验证生成结果是否被真实内核接受，可以用 mihomo 自带的配置检查：

```bash
mihomo -t -f out.yaml
# configuration file out.yaml test is successful
```

注意 `-d` 指向的目录会被写入 `geoip.metadb`，建议用临时目录。

## 安全提示

### 已经做了的

- **订阅鉴权**：`/` 和 `/sub` 都必须带 token，否则一律 403；Clash User-Agent 识别、`?scene=0` 都不能绕过。token 比较用定长实现，避免通过响应耗时逐位试探。
- **后台会话**：cookie 值不再是固定的 `valid`，而是 `HMAC-SHA256(管理密码, 固定盐)`，并且按 cookie 名精确匹配。改密码即让所有旧会话立即失效。
- **初始化密码一次性**：`/admin/setup` 在已设过密码后会被拒绝，避免被人抢先改掉管理员密码。
- **改密入口**：后台可改管理密码（`POST /admin/password`），改完自动换发新票据，当前页面不会掉线。

### 还需要注意的

- 管理密码和节点内容以**明文**保存在 KV 中；请勿复用重要密码。
- **token 就是密码**：任何拿到完整订阅 URL 的人都能读到全部节点。别把带 token 的地址发到公开场合、截图或同步到不可信的地方。
- 首次部署后请尽快访问 `/admin` 完成密码初始化。
- 登录接口没有做频率限制，弱密码仍可能被在线爆破；请用长一点的管理密码。
- 需要更强保护时，建议在 `/admin*` 前再加一层 Cloudflare Access。

## 常见问题

### 订阅返回 403

订阅请求必须带 token。到 `/admin` 顶部的「订阅鉴权」面板复制带 token 的完整地址；如果是刚部署还没配过 token，进一次后台就会自动生成。

### 改了 token 之后老设备连不上

轮换后旧 token 默认只保留 24 小时宽限期。过期后到后台重新复制地址换到设备上，或者把 `AUTH.graceHours` 调大。

### 页面提示没有绑定 `sub` KV

确认 `wrangler.toml` 中存在 `binding = "sub"`，且 `id` 是当前 Cloudflare 账号下真实存在的 KV 命名空间 ID，然后重新执行 `npx wrangler deploy`。

### Clash 没有收到 YAML

将订阅地址改为 `/sub?token=xxx&target=clash`，不要只依赖客户端 User-Agent 自动识别。

### 本地后台看不到线上节点

这是正常现象。`wrangler dev` 默认使用独立的本地 KV，不会读取生产环境的数据。

## 相关文档

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Workers KV 入门](https://developers.cloudflare.com/kv/get-started/)
- [Wrangler 命令参考](https://developers.cloudflare.com/workers/wrangler/commands/)
