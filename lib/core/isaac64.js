/**
 * WeChat Channels (视频号) video decryption: ISAAC64 keystream XOR over the
 * first encLimit bytes (encLimit = 131072, i.e. 128KB).
 * Ported from ltaoo/wx_channels_download -> Hanson/WechatSphDecrypt, verified
 * in the wxdown Electron prototype (old-electron/src/main/services/sphDecrypt.ts).
 * Keystream blocks are written BigEndian; uint64 math uses BigInt.
 */
const MASK64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c13n;
import { openSync, fstatSync, readSync, writeSync, fsyncSync, closeSync } from 'node:fs';
function mix(v) {
    let a = v[0], b = v[1], c = v[2], d = v[3], e = v[4], f = v[5], g = v[6], h = v[7];
    a = (a - e) & MASK64;
    f = (f ^ (h >> 9n)) & MASK64;
    h = (h + a) & MASK64;
    b = (b - f) & MASK64;
    g = (g ^ (a << 9n)) & MASK64;
    a = (a + b) & MASK64;
    c = (c - g) & MASK64;
    h = (h ^ (b >> 23n)) & MASK64;
    b = (b + c) & MASK64;
    d = (d - h) & MASK64;
    a = (a ^ (c << 15n)) & MASK64;
    c = (c + d) & MASK64;
    e = (e - a) & MASK64;
    b = (b ^ (d >> 14n)) & MASK64;
    d = (d + e) & MASK64;
    f = (f - b) & MASK64;
    c = (c ^ (e << 20n)) & MASK64;
    e = (e + f) & MASK64;
    g = (g - c) & MASK64;
    d = (d ^ (f >> 17n)) & MASK64;
    f = (f + g) & MASK64;
    h = (h - d) & MASK64;
    e = (e ^ (g << 14n)) & MASK64;
    g = (g + h) & MASK64;
    v[0] = a;
    v[1] = b;
    v[2] = c;
    v[3] = d;
    v[4] = e;
    v[5] = f;
    v[6] = g;
    v[7] = h;
}
function isaac64Gen(ctx) {
    ctx.cc = (ctx.cc + 1n) & MASK64;
    ctx.bb = (ctx.bb + ctx.cc) & MASK64;
    for (let i = 0; i < 256; i++) {
        switch (i % 4) {
            case 0:
                ctx.aa = (~(ctx.aa ^ (ctx.aa << 21n))) & MASK64;
                break;
            case 1:
                ctx.aa = (ctx.aa ^ (ctx.aa >> 5n)) & MASK64;
                break;
            case 2:
                ctx.aa = (ctx.aa ^ (ctx.aa << 12n)) & MASK64;
                break;
            default:
                ctx.aa = (ctx.aa ^ (ctx.aa >> 33n)) & MASK64;
                break;
        }
        ctx.aa = (ctx.aa + ctx.mm[(i + 128) % 256]) & MASK64;
        const x = ctx.mm[i];
        const y = (ctx.mm[Number((x >> 3n) % 256n)] + ctx.aa + ctx.bb) & MASK64;
        ctx.mm[i] = y;
        ctx.bb = (ctx.mm[Number((y >> 11n) % 256n)] + x) & MASK64;
        ctx.seed[i] = ctx.bb;
    }
}
export function createIsaacInst(encKey) {
    const ctx = {
        randCnt: 255n,
        seed: new Array(256).fill(0n),
        mm: new Array(256).fill(0n),
        aa: 0n,
        bb: 0n,
        cc: 0n,
    };
    ctx.seed[0] = encKey;
    let v = [GOLDEN, GOLDEN, GOLDEN, GOLDEN, GOLDEN, GOLDEN, GOLDEN, GOLDEN];
    for (let i = 0; i < 4; i++)
        mix(v);
    for (let i = 0; i < 256; i += 8) {
        v[0] = (v[0] + ctx.seed[i]) & MASK64;
        v[1] = (v[1] + ctx.seed[i + 1]) & MASK64;
        v[2] = (v[2] + ctx.seed[i + 2]) & MASK64;
        v[3] = (v[3] + ctx.seed[i + 3]) & MASK64;
        v[4] = (v[4] + ctx.seed[i + 4]) & MASK64;
        v[5] = (v[5] + ctx.seed[i + 5]) & MASK64;
        v[6] = (v[6] + ctx.seed[i + 6]) & MASK64;
        v[7] = (v[7] + ctx.seed[i + 7]) & MASK64;
        mix(v);
        ctx.mm[i] = v[0];
        ctx.mm[i + 1] = v[1];
        ctx.mm[i + 2] = v[2];
        ctx.mm[i + 3] = v[3];
        ctx.mm[i + 4] = v[4];
        ctx.mm[i + 5] = v[5];
        ctx.mm[i + 6] = v[6];
        ctx.mm[i + 7] = v[7];
    }
    for (let i = 0; i < 256; i += 8) {
        v[0] = (v[0] + ctx.mm[i]) & MASK64;
        v[1] = (v[1] + ctx.mm[i + 1]) & MASK64;
        v[2] = (v[2] + ctx.mm[i + 2]) & MASK64;
        v[3] = (v[3] + ctx.mm[i + 3]) & MASK64;
        v[4] = (v[4] + ctx.mm[i + 4]) & MASK64;
        v[5] = (v[5] + ctx.mm[i + 5]) & MASK64;
        v[6] = (v[6] + ctx.mm[i + 6]) & MASK64;
        v[7] = (v[7] + ctx.mm[i + 7]) & MASK64;
        mix(v);
        ctx.mm[i] = v[0];
        ctx.mm[i + 1] = v[1];
        ctx.mm[i + 2] = v[2];
        ctx.mm[i + 3] = v[3];
        ctx.mm[i + 4] = v[4];
        ctx.mm[i + 5] = v[5];
        ctx.mm[i + 6] = v[6];
        ctx.mm[i + 7] = v[7];
    }
    isaac64Gen(ctx);
    return ctx;
}
function isaacRandom(ctx) {
    const result = ctx.seed[Number(ctx.randCnt)];
    if (ctx.randCnt === 0n) {
        isaac64Gen(ctx);
        ctx.randCnt = 255n;
    }
    else {
        ctx.randCnt--;
    }
    return result;
}
export const DECRYPT_PREFIX_LEN = 131072;
/** XOR-decrypt the first encLen bytes of `data` in place. Returns true if any bytes were decrypted. */
export function decryptBuffer(data, encLen, key) {
    const limit = Math.min(encLen, data.length);
    if (limit <= 0)
        return false;
    const ctx = createIsaacInst(typeof key === 'bigint' ? key : BigInt(key));
    const block = Buffer.alloc(8);
    for (let i = 0; i < limit; i += 8) {
        block.writeBigUInt64BE(isaacRandom(ctx));
        const end = Math.min(i + 8, limit);
        for (let j = i; j < end; j++)
            data[j] ^= block[j - i];
    }
    return true;
}
/** True when the 4-byte box type at offset 4 is not ftyp (i.e. the file is still encrypted). */
export function isEncryptedMp4(header) {
    return header.length < 12 || header.toString('latin1', 4, 8) !== 'ftyp';
}
/** Decrypt the first encLen bytes of a file in place (stream-friendly enough for typical files under a few hundred MB). */
export function decryptFileInPlace(filePath, encLen, key) {
    try {
        const fd = openSync(filePath, 'r+');
        try {
            const size = fstatSync(fd).size;
            const limit = Math.min(encLen, size);
            if (limit <= 0)
                return { ok: true };
            const buf = Buffer.alloc(limit);
            readSync(fd, buf, 0, limit, 0);
            decryptBuffer(buf, limit, key);
            writeSync(fd, buf, 0, limit, 0);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
//# sourceMappingURL=isaac64.js.map