/**
 * @file cipher.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-22
 */

/**
 * DMO 팩 복호 (FORMAT 2-1, 5).
 * HF 인덱스 blob 복호와 팩 항목 (테이블 봉투) 복호를 담당한다.
 */
import zlib from "node:zlib";
import { Blowfish } from "./blowfish.js";

// 테이블 봉투의 Blowfish 키 (FORMAT 5-2 4단계). 모든 빌드에서 같다
const TABLE_KEY = Buffer.from("%D*F-JaNdRgUkXp2s5v8y/B?E(H+MbPe", "latin1");
// 키 스케줄은 무거우므로 한 번만 만든다
const tableCipher = new Blowfish(TABLE_KEY);

// 봉투 타입 코드로 허용되는 값 (FORMAT 5-1 3단계)
const ENVELOPE_TYPES = new Set([0x10, 0x11, 0x12, 0x13, 0x6a, 0x6c]);

/**
 * u32 오른쪽 회전.
 * @param {number} x u32
 * @param {number} n 회전 비트 수 (1~31)
 * @returns {number} u32
 */
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/**
 * RvsHalf (FORMAT 2-1): 짝수 번째 u32 는 상위 16비트, 홀수 번째는 하위 16비트를 반전한다.
 * 배열을 그 자리에서 바꾼다.
 * @param {Uint32Array} a u32 배열
 */
function rvsHalf(a) {
    for (let i = 0; i < a.length; i ++) a[i] ^= i & 1 ? 0x0000ffff : 0xffff0000;
}

/**
 * XorTwist (FORMAT 2-1, 5-2 5단계): 상태 st 로 u32 를 XOR 하고, st 는 복호 전 값 으로 갱신한다.
 * 배열을 그 자리에서 바꾼다.
 * @param {Uint32Array} a u32 배열
 * @returns {number} 마지막 u32 까지 처리한 뒤의 상태 st (꼬리 바이트 복호에 쓴다)
 */
function xorTwist(a) {
    let st = 78695;
    for (let i = 0; i < a.length; i ++) {
        // 복호 전 값을 보관해 둔다 (상태 갱신에 필요)
        const x = a[i];
        a[i] = (x ^ st) >>> 0;
        // st = (x + st) * 52845 + 22719 (mod 2^32)
        st = (Math.imul((x + st) >>> 0, 52845) + 22719) >>> 0;
    }
    return st;
}

/**
 * 버퍼의 앞 부분을 리틀엔디안 u32 배열로 복사한다. 4의 배수를 넘는 꼬리 바이트는 포함하지 않는다.
 * @param {Buffer} buf 원본
 * @returns {Uint32Array} 복사본 (원본과 메모리를 공유하지 않는다)
 */
function toU32(buf) {
    const a = new Uint32Array(buf.length >>> 2);
    for (let i = 0; i < a.length; i ++) a[i] = buf.readUInt32LE(i * 4);
    return a;
}

/**
 * u32 배열을 리틀엔디안 바이트로 버퍼에 다시 쓴다.
 * @param {Uint32Array} a u32 배열
 * @param {Buffer} buf 대상 버퍼 (a.length * 4 바이트 이상)
 */
function fromU32(a, buf) {
    for (let i = 0; i < a.length; i ++) buf.writeUInt32LE(a[i], i * 4);
}

/**
 * 앞 2바이트가 진짜 zlib 헤더인지 본다 (FORMAT 5-1 1단계).
 * 0x78 로 시작하고 (CMF << 8 | FLG) 가 31의 배수여야 한다.
 * @param {Buffer} b 데이터
 * @returns {boolean}
 */
export function isZlib(b) {
    return b.length >= 2 && b[0] === 0x78 && ((b[0] << 8) | b[1]) % 31 === 0;
}

/**
 * HF 파일 뒤의 암호화 blob 을 풀어 인덱스 바이트를 돌려준다 (FORMAT 2-1)
 * @param {Buffer} blob HF 파일의 +8 부터 끝까지
 * @returns {Buffer} 풀린 인덱스 (u32 count + count x 24 B)
 */
export function decryptIndex(blob) {
    // 1단계: u32 배열로 읽는다. 4의 배수를 넘는 꼬리 1~3바이트는 버린다
    const a = toU32(blob);
    // 2단계 RvsFull: 순서를 뒤집고 각 원소를 비트 반전한다
    a.reverse();
    for (let i = 0; i < a.length; i ++) a[i] = ~a[i] >>> 0;
    // 2단계 Twist: i 번째 원소를 (i % 31) + 1비트 오른쪽 회전
    for (let i = 0; i < a.length; i ++) a[i] = rotr(a[i], (i % 31) + 1);
    // 2단계 RvsHalf, XorTwist
    rvsHalf(a);
    xorTwist(a);
    // 3단계: zlib 으로 푼다. 꼬리를 버려서 스트림 끝 (adler32) 이 잘려 있으므로 Z_SYNC_FLUSH 로 푼다
    const out = Buffer.alloc(a.length * 4);
    fromU32(a, out);
    return zlib.inflateSync(out, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
}

/**
 * zlib 을 풀어 본 데이터가 72바이트 봉투인지 판별한다 (FORMAT 5-1 3단계)
 * @param {Buffer} outer zlib 을 푼 데이터
 * @returns {boolean}
 */
function isEnvelope(outer) {
    if (outer.length < 72 || !ENVELOPE_TYPES.has(outer[0])) return false;
    // payLen 은 0보다 크고 72바이트 헤더 뒤에 들어가야 한다
    const payLen = outer.readUInt32LE(68);
    return payLen > 0 && payLen <= outer.length - 72;
}

/**
 * 72바이트 봉투를 푼다 (FORMAT 5-2).
 * @param {Buffer} outer 봉투 전체 (zlib 을 푼 데이터)
 * @returns {Buffer} 원본 데이터
 */
function openEnvelope(outer) {
    // 봉투 헤더: +4 64 B Shuffle 키, +68 u32 payLen, +72 payload
    const key = outer.subarray(4, 68);
    const payLen = outer.readUInt32LE(68);
    // payload 를 복사해서 작업한다 (원본은 건드리지 않는다)
    const pay = Buffer.from(outer.subarray(72, 72 + payLen));

    // 1단계 Shuffle: 16 B 블록마다 키 바이트 64개를 차례로 보며 두 칸 (하위 4비트, 상위 4비트) 을 맞바꾼다.
    // 끝의 16 B 미만 조각은 그대로 둔다
    for (let o = 0; o + 16 <= pay.length; o += 16) {
        for (const k of key) {
            const x = o + (k & 0x0f);
            const y = o + (k >> 4);
            const t = pay[x];
            pay[x] = pay[y];
            pay[y] = t;
        }
    }

    // 2단계 RvsHalf: u32 단위. 꼬리 바이트는 그대로 둔다
    const words = toU32(pay);
    rvsHalf(words);
    fromU32(words, pay);

    // 3단계: 부해더 u32 orig (원래 길이), u32 padded (8의 배수로 올린 길이)
    const orig = pay.readUInt32LE(0);
    const padded = pay.readUInt32LE(4);
    if (padded !== Math.ceil(orig / 8) * 8 || 8 + padded > pay.length) {
        throw new Error(`Bad envelope sub-header: orig=${orig} padded=${padded} len=${pay.length}`);
    }

    // 4단계 Blowfish ECB (리틀엔디안 블록): [8, 8 + padded] 를 풀고 앞 orig 바이트만 남긴다
    const body = pay.subarray(8, 8 + padded);
    tableCipher.decryptLE(body);
    const data = Buffer.from(body.subarray(0, orig));

    // 5단계 XorTwist: 앞의 floor(orig / 4) 개 u32를 푼다
    const w = toU32(data);
    const st = xorTwist(w);
    fromU32(w, data);
    // 남는 t = orig % 4 바이트는 마지막 상태 st 의 상위 바이트 자리로 XOR 한다.
    // 틀리면 파일 마지막 1~3바이트만 조용히 깨진다
    const t = orig % 4;
    const tail = orig - t;
    for (let i = 0; i < t; i ++) data[tail + i] ^= (st >>> (8 * (4 - t + i))) & 0xff;

    return data;
}

/**
 * 팩 항목 하나를 원본 파일 내용으로 되돌린다 (FORMAT 5).
 * 리소스 (nif, dds ...) 는 평문이라 그래도, 테이블은 zlib + 봉투를 푼다.
 * @param {Buffer} raw pf 에서 읽은 그대로의 데이터
 * @returns {Buffer} 원본 파일 내용
 */
export function decodeEntry(raw) {
    // 5-1 1단계: 진짜 zlib 헤더가 아니면 평문이다
    if (!isZlib(raw)) return raw;
    // 5-1 2단계: zlib 을 푼다.
    const outer = zlib.inflateSync(raw);
    // 5-1 3단계: 봉투 조건을 만족하지 않으면 zlib 을 푼 결과가 원본이다
    if (!isEnvelope(outer)) return outer;
    const data = openEnvelope(outer);
    // 5-2 6단계: 결과가 다시 zlib 이면 한 번 더 푼다 (inner zlib).
    // 풀린 길이가 입력보다 짧거나 풀리지 않으면 우연히 헤더처럼 보인 것이므로 풀기 전 값을 쓴다
    if (isZlib(data)) {
        try {
            const inner = zlib.inflateSync(data);
            if (inner.length >= data.length) return inner;
        } catch {
            // zlib 이 아니었다. 아래에서 그대로 돌려준다
        }
    }
    return data;
}