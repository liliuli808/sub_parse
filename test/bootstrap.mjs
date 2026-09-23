// ============================================================
//  测试环境补齐：WebCrypto
// ------------------------------------------------------------
//  worker.js 的会话票据用了 WebCrypto（crypto.subtle），这在
//  Cloudflare Workers 里是内置全局，不需要任何 import。
//
//  但本机 WSL 跑的是 Node 18，Node 要 19 才默认暴露全局 crypto，
//  于是 worker 里一调就 "crypto is not defined" → 500。
//
//  生产代码不该为了迁就测试环境打补丁，所以补在测试这一侧：
//  所有测试文件第一行 import 本模块即可。
// ============================================================
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto || !globalThis.crypto.subtle) {
    globalThis.crypto = webcrypto;
}

export const webcryptoReady = !!(globalThis.crypto && globalThis.crypto.subtle);
