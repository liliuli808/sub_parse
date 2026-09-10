#!/bin/sh
# ============================================================
#  sub_parse 测试入口
# ------------------------------------------------------------
#  用法：  sh test/run.sh
#
#  跑什么：
#    1. test.mjs              端到端生成三份订阅输出（Clash / Base64 / scene=0）
#    2. test-edge.mjs         边界与异常路径（30 项）
#    3. test-profile-script.mjs  Clash Verge 扩展脚本回归（可选，需 profile-script.js）
#    4. verify_yaml.py        用 YAML 解析器校验生成结果的结构与引用完整性
#
#  为什么要把 worker.js 复制成 worker.mjs：
#    worker.js 用的是 ESM（export default），但项目根目录没有 package.json
#    声明 type=module，Node 会按 CommonJS 解析它。复制成 .mjs 即可绕开，
#    这样不必为了跑测试去动部署用的 wrangler 配置。
# ============================================================
set -e
cd "$(dirname "$0")"

# 任何退出路径（含中途失败）都清理生成物
trap 'rm -f worker.mjs out.yaml out_off.yaml out_plain.txt profile-script.js test-log.txt' EXIT INT TERM

cp ../worker.js worker.mjs

echo "=============== 1/4 端到端生成 ==============="
node test.mjs

echo
echo "=============== 2/4 边界与异常 ==============="
node test-edge.mjs

echo
echo "=============== 3/4 扩展脚本回归 ==============="
PROFILE_SCRIPT="${PROFILE_SCRIPT:-/mnt/c/Users/Administrator/AppData/Roaming/io.github.clash-verge-rev.clash-verge-rev/profiles/skOmeZg8yzL2.js}"
if [ -f "$PROFILE_SCRIPT" ]; then
    cp "$PROFILE_SCRIPT" profile-script.js
    node test-profile-script.mjs
else
    echo "  跳过：未找到扩展脚本（可用 PROFILE_SCRIPT=路径 指定）"
fi

echo
echo "=============== 4/4 YAML 结构校验 ==============="
RC=0
if command -v python3 >/dev/null 2>&1 && python3 -c "import yaml" 2>/dev/null; then
    # 注意不能用 `cmd || echo 跳过`：那样会把真实的校验失败伪装成「跳过」
    python3 verify_yaml.py out.yaml || RC=$?
else
    echo "  跳过：未安装 python3 或缺少 pyyaml（pip install pyyaml）"
fi

# 生成物由上面的 trap 统一清理

if [ "$RC" -ne 0 ]; then
    echo
    echo "测试失败（YAML 结构校验未通过）"
    exit "$RC"
fi

echo
echo "全部测试完成。"
