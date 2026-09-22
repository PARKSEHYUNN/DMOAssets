/**
 * @file hash.test.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-22
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { djb2 } from "../core/hash.js";

// FORMAT 3 의 확인 값 3개
test("djb2 matches known path hashes", () => {
    assert.equal(djb2("data\\model.dat"), 0xe0f0f4e9);
    assert.equal(djb2("data\\bin\\table\\digimonlistdata.bin"), 0x8c2e8c36);
    assert.equal(djb2("data\\digimon\\agumon\\agumon.nif"), 0x57e6b6f1);
});

// 대소문자, 구분자 종류 (\ /) 가 달려고 같은 해시여야 한다
test("djb2 ignores case and separator kind", () => {
    assert.equal(djb2("Data/Digimon/Agumon/AGUMON.nif"), 0x57e6b6f1);
});