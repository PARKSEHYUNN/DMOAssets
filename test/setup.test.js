/**
 * @file setup.test.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-22
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { KDMO_DIR, GDMO_DIR } from "./config.js";

// DMO_KDMO_DIR 이 가르키는 폴더에 KDMO 리소스 팩 인덱스 (pack01.hf) 가 있는지 확인한다.
// 경로 설정이 제대로 됬는지 보는 테스트다. 경로가 없으면 skip 된다.
test("KDMO folder has pack01.hf", { skip: !KDMO_DIR && "DMO_KDMO_DIR not set" }, () => {
    assert.ok(fs.existsSync(path.join(KDMO_DIR, "pack01.hf")));
});

// DMO_GDMO_DIR 이 가리키는 폴더에 GDMO Steam 리소스 팩 인덱스 (Pack01.hf) 가 있는지 확인한다.
test("GDMO folder has Pack01.hf", { skip: !GDMO_DIR && "DMO_GDMO_DIR not set" }, () => {
    assert.ok(fs.existsSync(path.join(GDMO_DIR, "Pack01.hf")));
});