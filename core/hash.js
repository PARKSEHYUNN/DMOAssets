/**
 * @file hash.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-22
 */

/**
 * 팩 안의 경로를 인덱스 해시로 바꾼다 (FORMAT 3: DJB2 변형).
 * 대소문자를 무시하고, 점 (.) 과 경로 구분자 (\ /) 는 계산에서 뺀다.
 * @param {string} path 팩 안의 경로. 예: "data\\model.dat"
 * @returns {number} u32 해시
 */
export function djb2(path) {
    // DJB2 초기값
    let h = 5381;
    for (const ch of path.toLowerCase()) {
        // 점과 구분자는 건너뛴다. 그래서 "data\\a.nif"와 "data/a.nif" 가 같은 해시가 된다
        if (ch === "." || ch === "\\" || ch === "/") continue;
        // h = h * 33 + c (mod 2^32). Math.imul 로 32비트 곱셈을 하고 >>> 0 으로 부호 없는 값으로 만든다
        h = (Math.imul(h, 33) + ch.charCodeAt(0)) >>> 0;
    }
    return h;
}