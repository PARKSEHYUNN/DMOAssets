/**
 * @file cli.test.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-23
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../cli/main.js";
import { KDMO_DIR } from "./config.js";

// 인자가 없으면 사용법을 보여 주고 1, -h 는 0 으로 끝나야 한다
test("main: usage and help exit codes", () => {
    assert.equal(main([]), 1);
    assert.equal(main(["-h"]), 0);
});

// 실제 폴더에서 list 가 오류 없이 끝나야 한다 (인자 해석부터 출력까지 한 번에 확인)
test("main: list runs on KDMO", { skip: !KDMO_DIR && "KDMO folder not set" }, () => {
    assert.equal(main(["list", KDMO_DIR, "-f", "data\\model.dat"]), 0);
});