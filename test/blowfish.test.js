/**
 * @file blowfish.test.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-22
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Blowfish } from "../core/blowfish.js";

// Blowfish 표준 테스트 벡터 (Eric Young / Schneier). 값은 빅엔디안 기준이다.
// [키, 평문, 암호문] (16진수)
const VECTORS = [
  ["0000000000000000", "0000000000000000", "4EF997456198DD78"],
  ["FFFFFFFFFFFFFFFF", "FFFFFFFFFFFFFFFF", "51866FD5B85ECB8A"],
  ["3000000000000000", "1000000000000001", "7D856F9A613063F2"],
  ["0123456789ABCDEF", "1111111111111111", "61F9C3802281B096"],
  ["FEDCBA9876543210", "0123456789ABCDEF", "0ACEAB0FC6A0A28D"],
];

// 벡터마다 빅엔디안으로 암호화, 복호가 표준 결과와 같은지 확인한다.
// π 로 만든 상수와 키 스케줄이 맞는지 여기서 드러난다.
test("Blowfish standard test vectors (big-endian)", () => {
    for (const [key, plain, cipher] of VECTORS) {
        const bf = new Blowfish(Buffer.from(key, "hex"));
        const p = Buffer.from(plain, "hex");
        const c = Buffer.from(cipher, "hex");
        // 암호화: 평문 -> 암호문
        assert.deepEqual(bf.encryptBlock(p.readUInt32BE(0), p.readUInt32BE(4)), [c.readUInt32BE(0), c.readUInt32BE(4)], key);
        // 복호: 암호문 -> 평문
        assert.deepEqual(bf.decryptBlock(c.readUInt32BE(0), c.readUInt32BE(4)), [p.readUInt32BE(0), p.readUInt32BE(4)], key);
    }
});

// decryptLE 는 같은 블록을 리틀엔디안 u32 로 읽는다. 바이트를 u32 마다 뒤집어 넣으면 표준 결과가 나와야 한다.
test("decryptLE reads blocks as little-endian u32", () => {
    const [key, plain, cipher] = VECTORS[3];
    const bf = new Blowfish(Buffer.from(key, "hex"));
    // 암호문을 u32 단위로 바이트 반전 (빅엔디안 -> 리틀엔디안 배치)
    const buf = Buffer.from(cipher, "hex").swap32();
    bf.decryptLE(buf);
    // 결과를 다시 u32 단위로 뒤집으면 표준 평문이다
    assert.equal(buf.swap32().toString("hex").toUpperCase(), plain);
});