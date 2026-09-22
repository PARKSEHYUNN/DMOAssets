/**
 * @file extract.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-23
 */

/**
 * 팩 항목 고르기와 파일로 풀기. CLI 와 GUI 가 같이 쓴다.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {import("./pack.js").Entry} Entry
 * @typedef {import("./pack.js").PackFolder} PackFolder
 */

/**
 * 패턴에 맞는 항목만 고른다. 대소문자는 무시한다.
 * - 와일드카드 (* ? [ {) 가 없으면 경로에 그 문자열이 들어 있는지 본다. 예: "agumon"
 * - 있으면 glob 으로 본다. 구분자는 \ / 둘 다 된다. 예 "data/digimon/**\/*.nif"
 * @param {Entry[]} entries 항목 목록
 * @param {string} [pattern] 패턴. 비어있으면 전부 고른다
 * @returns {Entry[]}
 */
export function filterEntries(entries, pattern) {
    if (!pattern) return entries;
    const p = pattern.toLowerCase();
    // 와일드 카드가 없으면 부분 문자열 검색 (구분자는 \ 로 맞춘다)
    if (!/[*?[{]/.test(p)) {
        const needle = p.replaceAll("/", "\\");
        return entries.filter((e) => e.name.toLowerCase().includes(needle));
    }
    // glob: 팩 경로는 Windows 형식이라 win32 규칙으로 맞춘다 (\ / 모두 구분자).
    // matchesGlob 은 대소문자를 구분하므로 양쪽 다 소문자로 바꿔 비교한다
    return entries.filter((e) => path.win32.matchesGlob(e.name.toLowerCase(), p));
}

/**
 * 팩 경로를 출력 폴더 안의 파일 경로로 바꾼다.
 * 팩 경로에 ".." 나 절대 경로가 들어 있어 출력 폴더 밖으로 나가면 null (쓰지 않는다).
 * @param {string} outDir 출력 폴더
 * @param {string} name 팩 안의 경로. 예: "data\\model.data"
 * @returns {string | null} 쓸 파일의 전체 경로
 */
export function outputPath(outDir, name) {
    const root = path.resolve(outDir);
    // 팩 경로 구분자 \ 를 현재 OS 구분자로 바꿔 출력 폴더 아래에 붙인다
    const target = path.resolve(root, ...name.split(/[\\/]+/));
    // 결과가 출력 폴더 안이어야 한다 (경로 탈출 방지)
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return target;
}

/**
 * @typedef {object} ExtractResult
 * @property {number} files 성공한 파일 수
 * @property {number} bytes 쓴 바이트 합계
 * @property {{ name: string, error: string }[]} failed 실패한 항목과 이유
 */

/**
 * 항목들을 원본 파일 내용으로 풀어 출력 폴더에 쓴다.
 * 한 항목이 실패해도 멈추지 않고 실패 목록에 모은다.
 * @param {PackFolder} folder 열린 팩 폴더
 * @param {Entry[]} entries 풀 항목
 * @param {string} outDir 출력 폴더
 * @param {(done: number, total: number) => void} [onProgress] 항목 하나를 처리할 때마다 불린다
 * @returns {ExtractResult}
 */
export function extractEntries(folder, entries, outDir, onProgress) {
    /** @type {ExtractResult} */
    const result = { files: 0, bytes: 0, failed: [] };
    // 디스크를 앞에서부터 읽도록 팩별, offset 순으로 정렬한다
    const packIndex = new Map(folder.packs.map((p, i) => [p, i]));
    const sorted = [...entries].sort((a, b) => packIndex.get(a.pack) - packIndex.get(b.pack) || a.offset - b.offset);
    // 이미 만든 폴더는 다시 mkdir 하지 않는다
    const made = new Set();

    sorted.forEach((e, i) => {
        try {
            const file = outputPath(outDir, e.name);
            if (!file) throw new Error("path escapes output folder");
            // 복호까지 끝난 원본 내용
            const data = folder.read(e);
            const dir = path.dirname(file);
            if (!made.has(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                made.add(dir);
            }
            fs.writeFileSync(file, data);
            result.files++;
            result.bytes += data.length;
        } catch(err) {
            result.failed.push({ name: e.name, error: err.message });
        }
        onProgress?.(i + 1, sorted.length);
    });
    return result;
}