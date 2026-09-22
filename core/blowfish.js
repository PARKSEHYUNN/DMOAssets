/**
 * @file blowfish.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-22
 */

/**
 * 표준 Blowfish (FORMAT 5-2 4단계, 6-4).
 * 
 * Node 24 (OpenSSL 3) 와 Electron (BoringSSL) 에서는 내장 "bf-ecb"를 쓸 수 없어서 직접 구현한다.
 * 블록 함수는 L, R 두 u32 를 받아 처리하고, 바이트 순서 (표준은 빅엔디안, DMO 는 리틀엔디안) 는 부르는 쪽이 정한다.
 */

/**
 * Blowfish 초기 상수를 만든다.
 * 표준 P 배열 (18개) 과 S 박스 (4 x 256개) 는 원주율 π 의 소수부 16진수 자릿수를 순서대로 잘라 쓴 값이다.
 * 1,042개 상수를 소스에 적는 대신 π 를 BigInt 로 직접 계산한다 (수십 ms, 모듈을 처음 불러올 때 한번).
 * 결과가 맞는지는 test/blowfish.test.js 의 표준 테스트 벡터가 확인한다.
 * @returns {Uint32Array} P 18개 + S 1,024개 = 1,042개 u32
 */
function piWords() {
    // 필요한 16진수 자릿수: u32 1,042개 x 8자리. 끝자리 오차를 막으려고 16자리를 더 계산한다
    const digits = 1042 * 8;
    const one = 1n << BigInt(4 * (digits + 16));

    // arctan(1/x) 를 고정소수점 (one = 1.0) 으로 계산한다: 1/x - 1/(3x^3) + 1/(5x^5) - ...
    const arctanInv = (x) => {
        const x2 = x * x;
        let power = one / x; // 현재 항의 1/x^(2k+1)
        let sum = power;
        for (let n = 3n, sign = -1n; power !== 0n; n += 2n, sign = -sign) {
            power /= x2;
            sum += sign * (power / n);
        }
        return sum;
    };

    // 마친 공식: π = 16·arctan(1/5) - 4·arctan(1/239)
    const pi = 16n * arctanInv(5n) - 4n * arctanInv(239n);
    // 정수부 3 을 빼고 소수부만 16진수 문자열로 바꾼다 (앞자리 0 이 빠지기 않게 채운다)
    const hex = (pi - 3n * one).toString(16).padStart(digits + 16, "0");

    // 8자리씩 잘라 u32 로 만든다. 첫 값은 0x243F6A88
    const words = new Uint32Array(1042);
    for (let i = 0; i < 1042; i ++) words[i] = parseInt(hex.slice(i * 8, i * 8 + 8), 16);
    return words;
}

// 모든 Blowfish 인스턴스가 공유하는 초기 상수
const PI_WORDS = piWords();

export class Blowfish {
    /**
     * 키 스케줄을 수행해 P 배열과 S 박스를 만든다 (표준 알고리즘 그대로).
     * @param {Uint8Array} key 키 바이트 (1~56 B)
     */
    constructor(key) {
        // P 배열 18개, S 박스 4개 (각 256개) 를 π 상수로 초기화한다
        this.p = PI_WORDS.slice(0, 18);
        this.s = [0, 1, 2, 3].map((i) => PI_WORDS.slice(18 + i * 256, 18 + (i + 1) * 256));

        // 키 바이트 순환하며 4바이트씩 빅엔디안 u32 로 묶어 P 배열에 XOR 한다
        let k = 0;
        for (let i = 0; i < 18; i ++) {
            let w = 0;
            for (let j = 0; j < 4; j ++) {
                w = ((w << 8) | key[k]) >>> 0;
                k = (k + 1) % key.length;
            }
            this.p[i] ^= w;
        }

        // 0 블록을 계속 암호화하면서 그 결과로 P 배열, 이어서 S 박스 전체를 차례로 덮어쓴다
        let l = 0;
        let r = 0;
        for (let i = 0; i < 18; i += 2) {
            [l, r] = this.encryptBlock(l, r);
            this.p[i] = l;
            this.p[i + 1] = r;
        }
        for (const box of this.s) {
            for (let i = 0; i < 256; i += 2) {
                [l, r] = this.encryptBlock(l, r);
                box[i] = l;
                box[i + 1] = r;
            }
        }
    }

    /**
     * Blowfish F 함수: x 를 바이트 4개 (a b c d, 상위부터) 로 나눠 ((S0[a] + S1[b]) ^ S2[c]) + S3[d].
     * @param {number} x u32
     * @returns {number} u32
     */
    f(x) {
        const [s0, s1, s2, s3] = this.s;
        return ((((s0[x >>> 24] + s1[(x >>> 16) & 0xff]) >>> 0) ^ s2[(x >>> 8) & 0xff]) + s3[x & 0xff]) >>> 0;
    }

    /**
     * 한 블록 (L, R) 을 암호화한다. 16라운드 페이스텔 구조.
     * @param {number} l 왼쪽 u32
     * @param {number} r 오른쪽 u32
     * @returns {[number, number]} 암호화된 [L, R]
     */
    encryptBlock(l, r) {
        const p = this.p;
        // 라운드마다 L에 P[i] 를 XOR 하고, R 에 F(L) 을 XOR 한 뒤 둘을 맞바꾼다
        for (let i = 0; i < 16; i ++) {
            l = (l ^ p[i]) >>> 0;
            r = (r ^ this.f(l)) >>> 0;
            [l, r] = [r, l];
        }
        // 마지막 라운드의 맞바꿈을 되돌리고 P[16], P[17] 을 XOR 한다
        [l, r] = [r, l];
        r = (r ^ p[16]) >>> 0;
        l = (l ^ p[17]) >>> 0;
        return [l, r];
    }

    /**
     * 한 블록 (L, R) 을 복호한다. 암호화와 같은 구조로 P 배열을 거꾸로 쓴다.
     * @param {number} l 왼쪽 u32
     * @param {number} r 오른쪽 u32
     * @returns {[number, number]} 복호된  [L, R]
     */
    decryptBlock(l, r) {
        const p = this.p;
        for (let i = 17; i > 1; i--) {
            l = (l ^ p[i]) >>> 0;
            r = (r ^ this.f(l)) >>> 0;
            [l, r] = [r, l];
        }
        [l, r] = [r, l];
        r = (r ^ p[1]) >>> 0;
        l = (l ^ p[0]) >>> 0;
        return [l, r];
    }

    /**
     * DMO 방식 ECB 복호 (FORMAT 5-2 4단계): 8바이트 블록의 L, R 을 리틀엔디안 으로 읽고 쓴다.
     * 버퍼를 그 자리에서 바꾼다. 길이는 8의 배수여야 한다.
     * @param {Buffer} buf 복호할 데이터
     */
    decryptLE(buf) {
        for (let o = 0; o < buf.length; o += 8) {
            const [l, r] = this.decryptBlock(buf.readUInt32LE(o), buf.readUInt32LE(o + 4));
            buf.writeUInt32LE(l, o);
            buf.writeUInt32LE(r, o + 4);
        }
    }
}