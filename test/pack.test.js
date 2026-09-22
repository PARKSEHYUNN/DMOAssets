/**
 * @file pack.test.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-22
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PackFolder } from "../core/pack.js";
import { KDMO_DIR, GDMO_DIR } from "./config.js";

// 라이브 설치본은 패치로 항목 수가 바뀌므로 고정 개수 대신 구조를 검사한다 (CLAUDE.md 검증 절)
// 두 클라이언트에 같은 검사를 돌린다
for (const [label, dir] of [["KDMO", KDMO_DIR], ["GDMO", GDMO_DIR]]) {
    describe(`${label} packs`, { skip: !dir && `${label} folder not set` }, () => {
        /** @type {PackFolder} */
        let folder;

        // 폴더의 모든 팩을 한 번만 연다 (인덱스 복호 + 이름 복원, 수 초 걸린다)
        before(() => {
            folder = new PackFolder(dir);
        });
        after(() => folder?.close());

        // 인덱스의 풀린 길이 검사는 readIndex 안에서 한다. 여기서는 팩이 둘 이상 열렸는지만 본다 (리소스 + 테이블)
        test("opens resource and table packs", () => {
            assert.ok(folder.packs.length >= 2);
            assert.ok(folder.entries.length > 0);
        });

        // FORMAT 4: 모든 항목의 경로 청크가 해시와 일치해 이름이 복원돼야 한다
        test("restores every entry name from path chunks", () => {
            const unnamed = folder.entries.filter((e) => e.name.startsWith("_unnamed"));
            assert.deepEqual(unnamed.map((e) => e.hash.toString(16)), []);
        });

        // 서로 다은 팩에 같은 해시가 있으면 경로로 찾기가 모호해진다
        test("has no duplicate path hashes", () => {
            assert.equal(new Set(folder.entries.map((e) => e.hash)).size, folder.entries.length);
        });

        // FORMAT 5: 테이블 팩 (data\bin\) 의 모든 항목이 오류 없이 복호돼야 한다
        test("decodes every table entry", () => {
            const tables = folder.entries.filter((e) => /^data\\bin\\/i.test(e.name));
            assert.ok(tables.length > 0);
            for (const e of tables) assert.doesNotThrow(() => folder.read(e), e.name);
        });

        // FORMAT 5-2 테스트 항목: 복호 결과가 [u32 count] 로 시작하는 디지몬 표여야 한다
        test("decodes digimonlistdata.bin", () => {
            const e = folder.find("data\\bin\\table\\digimonlistdata.bin");
            assert.ok(e, "digimonlistdata.bin not found");
            const data = folder.read(e);
            const count = data.readUInt32LE(0);
            // 디지몬 수는 수백개다. 복호가 틀리면 쓰레기 값이 나온다
            assert.ok(count > 100 && count < 10000, `count ${count}`);
        });

        // FORMAT 5-1: 리소스는 평문. model.dat 은 [i32 n] 으로 시작한다 (FORMAT 7-4)
        test("reads plain resource data\\model.dat", () => {
            const e = folder.find("Data/Model.dat");
            assert.ok(e, "model.dat not found");
            const n = folder.read(e).readInt32LE(0);
            assert.ok(n > 100 && n < 10000, `model count ${n}`);
        });
    });
}