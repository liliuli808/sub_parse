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

## 工作方式

| 地址 | 用途 |
| --- | --- |
| `/`、`/sub` | 返回订阅；默认是 Base64，Clash User-Agent 自动返回 YAML |
| `/sub?target=clash` | 强制返回 Clash YAML |
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

## 本地开发

```bash
npx wrangler dev
```

按终端输出的本地地址访问 `/admin`。Wrangler 本地开发默认使用本地 KV 数据，因此本地设置的密码和节点不会影响线上环境。

项目结构：

```text
.
├── worker.js       # 路由、鉴权页面、管理后台和订阅转换逻辑
├── wrangler.toml   # Worker 与 KV 绑定配置
└── README.md
```

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
