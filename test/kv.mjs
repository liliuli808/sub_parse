// ============================================================
//  测试用最小 KV / 鉴权辅助
// ------------------------------------------------------------
//  用 Map 存数据，行为对齐真实 Workers KV 的关键两点：
//    1. 键不存在时 get() 返回 null（而不是 undefined 或空串）
//    2. put() 存的是字符串
//  另外提供 adminTicket() / adminCookie()，按 worker 里的算法算出
//  合法的后台会话票据，让测试不必依赖实现细节就能以管理员身份发请求。
// ============================================================
import crypto from 'node:crypto';

export function makeKV(seed = {}) {
    const store = new Map(Object.entries(seed));
    return {
        store,
        get: async (k) => (store.has(k) ? store.get(k) : null),
        put: async (k, v) => { store.set(k, String(v)); }
    };
}

export function makeEnv(seed = {}) {
    return { sub: makeKV(seed) };
}

/**
 * 后台会话票据，算法与 worker.js 的 sessionTicket() 一致：
 *   hex(HMAC-SHA256(key = 管理密码, msg = "sublink-admin-session-v1"))
 * 注意 HMAC 的 key 就是密码明文（Node 与 WebCrypto 都按 UTF-8 处理）。
 */
export function adminTicket(password) {
    return crypto
        .createHmac('sha256', String(password))
        .update('sublink-admin-session-v1')
        .digest('hex');
}

export function adminCookie(password) {
    return `__Host-sublink_session=${adminTicket(password)}`;
}
