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

## 工作方式

| 地址 | 用途 |
| --- | --- |
| `/`、`/sub` | 返回订阅；默认是 Base64，Clash User-Agent 自动返回 YAML |
| `/sub?target=clash` | 强制返回 Clash YAML |
| `/sub?scene=0` | 关闭分场景节点副本，返回原始节点 |
| `/admin` | 管理后台；首次访问时设置管理密码 |

节点数据保存在 KV 的 `vpn_links` 键中，管理密码保存在 `admin_password` 键中。

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

## 使用订阅

### Base64 通用订阅

```text
https://你的域名/sub
```

### Clash/Mihomo 订阅

```text
https://你的域名/sub?target=clash
```

当请求的 User-Agent 中包含 `clash` 时，`/` 和 `/sub` 也会自动返回 Clash YAML。需要稳定指定格式时，建议显式添加 `?target=clash`。

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

订阅地址加 `?scene=0`（或 `off` / `false` / `no`）即可临时关闭，返回原始节点列表。

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

会依次跑：端到端生成（Clash YAML / Base64 / `?scene=0`）、边界与异常路径（37 项）、扩展脚本回归（17 项）、以及用 YAML 解析器做的结构校验。

`test/run.sh` 会把 `worker.js` 复制成 `worker.mjs` 再跑 —— 因为项目根目录没有 `package.json` 声明 `type=module`，Node 会按 CommonJS 解析 `.js`。复制成 `.mjs` 可以绕开，不必为了跑测试去动部署用的 wrangler 配置。

验证生成结果是否被真实内核接受，可以用 mihomo 自带的配置检查：

```bash
mihomo -t -f out.yaml
# configuration file out.yaml test is successful
```

注意 `-d` 指向的目录会被写入 `geoip.metadb`，建议用临时目录。

## 安全提示

- 管理密码和节点内容当前以明文保存在 KV 中；请勿复用重要密码。
- 首次部署后应尽快完成密码初始化，避免他人抢先设置管理员密码。
- 当前鉴权适合个人或轻量使用。公网长期使用时，建议在 `/admin*` 和 `/update-links` 前增加 Cloudflare Access 等额外访问控制。
- 请妥善保管订阅地址；任何获得该地址的人都能读取其中的节点信息。

## 常见问题

### 页面提示没有绑定 `sub` KV

确认 `wrangler.toml` 中存在 `binding = "sub"`，且 `id` 是当前 Cloudflare 账号下真实存在的 KV 命名空间 ID，然后重新执行 `npx wrangler deploy`。

### Clash 没有收到 YAML

将订阅地址改为 `/sub?target=clash`，不要只依赖客户端 User-Agent 自动识别。

### 本地后台看不到线上节点

这是正常现象。`wrangler dev` 默认使用独立的本地 KV，不会读取生产环境的数据。

## 相关文档

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Workers KV 入门](https://developers.cloudflare.com/kv/get-started/)
- [Wrangler 命令参考](https://developers.cloudflare.com/workers/wrangler/commands/)
