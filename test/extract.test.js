/**
 * @file extract.test.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-23
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filterEntries, outputPath, extractEntries } from "../core/extract.js";
import { PackFolder } from "../core/pack.js";
import { KDMO_DIR } from "./config.js";

// 필터 검사용 가짜 항목 (이름만 있으면 된다)
const FAKE = [
    "Data\\Digimon\\Agumon\\agumon.nif",
    "data\\digimon\\agumon_black\\0031043_agumon_black.kfm",
    "data\\bin\\table\\digimonlistdata.bin",
    "data\\map\\structure\\map #387.dds",
].map((name) => ({ name }));

/**
 * 필터 결과의 이름만 뽑는다.
 * @param {string} pattern 필터 패턴
 * @returns {string[]}
 */
const names = (pattern) => filterEntries(FAKE, pattern).map((e) => e.name);

// 와일드카드가 없으면 대소문자 무시 부분 문자열 검색
test("filterEntries: substring, case-insensitive", () => {
    assert.equal(names("AGUMON").length, 2);
    assert.deepEqual(names("map #387"), ["data\\map\\structure\\map #387.dds"]);
});

// 부분 문자열에서도 / 를 \ 로 맞춰 찾는다
test("filterEntries: substring accepts / as separator", () => {
    assert.deepEqual(names("bin/table/"), ["data\\bin\\table\\digimonlistdata.bin"]);
});

// 와일드카드가 있으면 glob. 대소문자와 구분자 종류는 상관없다
test("filterEntries: glob", () => {
    assert.deepEqual(names("data/digimon/*/*.nif"), ["Data\\Digimon\\Agumon\\agumon.nif"]);
    assert.equal(names("**/*.bin").length, 1);
    assert.equal(names("DATA\\DIGIMON\\**").length, 2);
});

// 패턴이 없으면 전부
test("filterEntries: empty pattern returns all", () => {
    assert.equal(names("").length, FAKE.length);
    assert.equal(names(undefined).length, FAKE.length);
});

// 팩 경로가 출력 폴더 밖으로 나가면 null 이어야 한다 (경로 탈출 방지)
test("outputPath blocks paths outside the output folder", () => {
    const out = path.resolve("out");
    assert.equal(outputPath(out, "data\\model.dat"), path.join(out, "data", "model.dat"));
    assert.equal(outputPath(out, "..\\evil.dll"), null);
    assert.equal(outputPath(out, "data\\..\\..\\evil.dll"), null);
    assert.equal(outputPath(out, ""), null);
    // 맨 앞 구분자는 버려저 출력 폴더 아래가 된다 (드라이브 문자 ":" 는 pack.js 가 이름에서 이미 막는다)
    assert.equal(outputPath(out, "\\Windows\\evil.dll"), path.join(out, "Windows", "evil.dll"));
});

// 실제 팩에서 몇 개를 풀어, 쓴 파일이 read() 결과와 같은지 확인한다
describe("extractEntries on KDMO", { skip: !KDMO_DIR && "KDMO folder not set" }, () => {
    /** @type {PackFolder} */
    let folder;
    let outDir;

    before(() => {
        folder = new PackFolder(KDMO_DIR);
        // 테스트마다 새 임시 폴더에 푼다
        outDir = fs.mkdtempSync(path.join(os.tmpdir(), "dmoassets-"));
    });
    after(() => {
        folder?.close();
        if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
    });

    // 테이블 (복호 필요) 과 리소스 (평문) 를 같이 푼다
    test("writes decoded files that match read()", () => {
        const entries = filterEntries(folder.entries, "data/bin/table/digimon*").concat(filterEntries(folder.entries, "data\\model.dat"));
        assert.ok(entries.length > 1);
        let calls = 0;
        const r = extractEntries(folder, entries, outDir, () => calls++);
        assert.deepEqual(r.failed, []);
        assert.equal(r.files, entries.length);
        // 진행 콜백은 항목마다 한 번씩 불린다
        assert.equal(calls, entries.length);
        for (const e of entries) {
            assert.ok(fs.readFileSync(outputPath(outDir, e.name)).equals(folder.read(e)), e.name);
        }
    });
});