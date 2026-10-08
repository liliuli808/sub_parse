import sys, yaml, json

path = sys.argv[1] if len(sys.argv) > 1 else 'out.yaml'
d = yaml.safe_load(open(path, encoding='utf-8'))

proxies = d.get('proxies', [])
groups = d.get('proxy-groups', [])
proxy_names = [p['name'] for p in proxies]
group_names = [g['name'] for g in groups]

print(f"YAML 解析: OK   顶层键={sorted(d.keys())}")
print(f"节点数={len(proxies)}   组数={len(groups)}")

print("\n--- 节点清单 ---")
for p in proxies:
    band = f"up={p.get('up','-')} down={p.get('down','-')}"
    extra = ''
    if p.get('ports'): extra += f"  ports={p['ports']}"
    if p.get('insecure') is not None: extra += f" insecure={p['insecure']}"
    print(f"  {p['name']:<22} {p['type']:<10} {p.get('server','')}:{p.get('port','')}  {band}{extra}")

print("\n--- 代理组 ---")
for g in groups:
    print(f"  {g['name']:<16} {g['type']:<9} -> {g['proxies']}")

problems = []

# 1. 所有组引用必须存在
known = set(proxy_names) | set(group_names) | {'DIRECT', 'REJECT', 'PASS', 'GLOBAL'}
for g in groups:
    for m in g['proxies']:
        if m not in known:
            problems.append(f"组 [{g['name']}] 引用了不存在的成员: {m}")

# 2. 节点名与组名不能重名
dup = set(proxy_names) & set(group_names)
if dup:
    problems.append(f"节点名与组名冲突: {dup}")

# 3. 名称唯一
if len(set(proxy_names)) != len(proxy_names):
    problems.append("存在重复节点名")

# 4. 分场景副本断言（matchMode: all → 每个 hy2 节点都展开）
SCENE_NODES = ['日本2', '美国2', '奔哥专用']
expect = {}
for _n in SCENE_NODES:
    expect[f'{_n} · 家宽'] = ('30 Mbps', '80 Mbps')
    expect[f'{_n} · 移动'] = ('10 Mbps', '50 Mbps')
    expect[f'{_n} · BBR'] = (None, None)

by_name = {p['name']: p for p in proxies}
for name, (u, dn) in expect.items():
    p = by_name.get(name)
    if not p:
        problems.append(f"缺少副本: {name}")
        continue
    if p.get('up') != u or p.get('down') != dn:
        problems.append(f"{name} 带宽不符: up={p.get('up')} down={p.get('down')}，期望 {u}/{dn}")

# 非 hysteria 节点原样保留且不应带带宽（美国1 是 vless）
for n in ['美国1']:
    p = by_name.get(n)
    if not p:
        problems.append(f"缺少原始节点: {n}")
    elif p.get('up') or p.get('down'):
        problems.append(f"{n} 不应带带宽: up={p.get('up')} down={p.get('down')}")

# keepOriginal=false 时，hy2 节点的原名不应再作为独立节点存在
for n in SCENE_NODES:
    cnt = proxy_names.count(n)
    if cnt != 0:
        problems.append(f"节点 {n} 出现 {cnt} 次，期望 0 次（keepOriginal=false）")

# 5. 场景组断言：每个 hy2 节点一个
need_groups = [f'🎚 {n} 场景' for n in SCENE_NODES]
for gn in need_groups:
    g = next((x for x in groups if x['name'] == gn), None)
    if not g:
        problems.append(f"缺少场景组: {gn}")
    elif len(g['proxies']) != 3:
        problems.append(f"{gn} 成员数 {len(g['proxies'])}，期望 3")

# 6. 自动选择只含家宽档 + 普通节点
auto = next((g for g in groups if g['name'] == '⚡ 自动选择'), None)
if not auto:
    problems.append("缺少 ⚡ 自动选择 组")
else:
    for n in SCENE_NODES:
        for tier in ['移动', 'BBR']:
            if f'{n} · {tier}' in auto['proxies']:
                problems.append(f"慢档位不应进入自动选择: {n} · {tier}")
    for n in [f'{_n} · 家宽' for _n in SCENE_NODES] + ['美国1']:
        if n not in auto['proxies']:
            problems.append(f"自动选择缺少: {n}")

# 7. 端口跳跃副本保留 ports
pj = by_name.get('美国2 · 家宽')
if not pj:
    problems.append("缺少端口跳跃副本: 美国2 · 家宽")
elif pj.get('ports') != '24500-24515':
    problems.append(f"端口跳跃节点 ports 丢失: {pj.get('ports')}")

# 8. 各档位副本必须继承原节点的全部关键字段（只差带宽）
FIELDS = ['password', 'sni', 'obfs', 'obfs-password', 'skip-cert-verify', 'port', 'server', 'ports', 'type']
for _n in SCENE_NODES:
    base = by_name.get(f'{_n} · 家宽', {})
    for other in ['移动', 'BBR']:
        o = by_name.get(f'{_n} · {other}', {})
        for f in FIELDS:
            if base.get(f) != o.get(f):
                problems.append(f"{_n} 副本字段不一致 {f}: 家宽={base.get(f)} {other}={o.get(f)}")
    # BBR 档必须完全不写带宽（否则就不是 BBR 了）
    bbr = by_name.get(f'{_n} · BBR', {})
    if 'up' in bbr or 'down' in bbr:
        problems.append(f"{_n} · BBR 不应带带宽字段")

# 9. 私有网段必须直连：漏掉会把内网流量送进代理，
#    在节点侧反复解析失败并刷爆服务端日志（曾占日志 88%）。
rules = d.get('rules', [])
rule_text = "\n".join(str(r) for r in rules)
need_cidr = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']
for cidr in need_cidr:
    if f'IP-CIDR,{cidr},DIRECT' not in rule_text:
        problems.append(f"rules 缺少私有网段直连: {cidr}")

# 10. 裸主机名（无点号，如 redis/db）必须直连，否则会进代理被解析失败。
#     用 DOMAIN-REGEX 匹配，DOMAIN-SUFFIX 拦不住单段主机名。
if 'DOMAIN-REGEX,^[^.]+$,DIRECT' not in rule_text:
    problems.append("rules 缺少无点号主机名直连: DOMAIN-REGEX,^[^.]+$,DIRECT")

# 11. 私有网段规则必须排在 GEOIP,CN 之前，且 MATCH 必须是最后一条
idx_match = next((i for i, r in enumerate(rules) if str(r).startswith('MATCH,')), -1)
if idx_match != len(rules) - 1:
    problems.append("MATCH 必须且只能是最后一条规则")
idx_private = next((i for i, r in enumerate(rules) if '192.168.0.0/16' in str(r)), -1)
idx_geoip = next((i for i, r in enumerate(rules) if str(r).startswith('GEOIP,')), -1)
if idx_private == -1 or (idx_geoip != -1 and idx_private > idx_geoip):
    problems.append("私有网段规则必须排在 GEOIP 之前")

# 12. skip-cert-verify 必须由链接声明驱动，不能无条件为 true。
#     历史 bug：buildProxy 默认给所有协议写 true，导致普通 TLS 节点
#     静默接受任意证书（可被中间人冒充，安全降级）。
#     测试数据里只有「奔哥专用」的链接带 insecure=1，故只有它应为 true。
#     这里按「行为契约」检查全部节点，而不只是 hysteria2 —— 否则
#     hy2 分支的显式覆盖会掩盖默认值被改回 true 的问题。
for p in proxies:
    expect_skip = '奔哥专用' in p['name']
    if p.get('skip-cert-verify') is not expect_skip:
        problems.append(
            f"{p['name']} skip-cert-verify={p.get('skip-cert-verify')}，"
            f"期望 {expect_skip}（应跟随链接的 insecure 参数）"
        )

print()
if problems:
    print(f"!!! {len(problems)} 个问题:")
    for x in problems:
        print("   -", x)
    sys.exit(1)
print("结构校验: 全部通过 ✔")
