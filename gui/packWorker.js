/**
 * @file packWorker.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-23
 */

/**
 * 팩을 다루는 워커 스레드.
 * 
 * 인덱싱 (수 초), 항목 읽기, 추출은 모두 여기서 한다. Electron 메인 프로세스가 멈추지 않게 하려는 것이다.
 * 메인과는 메세지로만 주고 받는다: 요청 { id, type, args }, 답 { id, ok, result | error }, 진행 { progress }.
 */

import fs from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import { PackFolder, PackLockedError } from "../core/pack.js";
import { filterEntries, extractEntries } from "../core/extract.js";
import { decodeImage, encodePNG } from "../core/image.js";
import { convertPackModel } from "../core/gltf.js";

// 브라우저가 그대로 열 수 있는 이미지 확장자 (디코드 없이 바이트를 그대로 넘긴다)
const BROWSER_IMAGES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".bmp": "image/bmp", ".gif": "image/gif" };

/** @type {PackFolder | null} 지금 열려있는 팩 폴더 */
let folder = null;

/**
 * 팩 폴더를 열고 항목 목록을 돌려준다.
 * @param {string} dir DMO 설치 폴더의 Data 폴더
 * @returns {{ dir: string, entries: { name: string, size: number }[] }}
 */
function open(dir) {
    folder?.close();
    folder = new PackFolder(dir);
    // 랜더러에 넘길 것은 이름과 크기뿐이다 (팩 객체는 워커에만 둔다)
    return { dir, entries: folder.entries.map((e) => ({ name: e.name, size: e.size })) };
}

/**
 * 항목 하나를 미리보기용으로 읽는다.
 * 이미지면 브라우저가 열 수 있는 형태로 바꾸고, 아니면 종류만 알려준다.
 * @param {string} name 팩 안의 경로
 * @returns {{ kind: "image", mime: string, bytes: Uint8Array } | { kind: "none", size: number, reason?: string }}
 */
function preview(name) {
    const entry = folder?.find(name);
    if (!entry) throw new Error(`Entry not found: ${name}`);
    const data = folder.read(entry);
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();

    // png/jpg/bmp 는 그대로 넘긴다
    if (BROWSER_IMAGES[ext]) return { kind: "image", mime: BROWSER_IMAGES[ext], bytes: data };

    // dds/tga는 풀어서 PNG 로 다시 만든다 (FORMAT 6-5)
    if (ext === ".dds" || ext === ".tga") {
        try {
            return { kind: "image", mime: "image/png", bytes: encodePNG(decodeImage(data, name)) };
        } catch (e) {
            // BC7 이나 깨진 파일은 미리보기만 포기하고 이유를 보여 준다
            return { kind: "none", size: data.length, reason: e.message };
        }
    }
    return { kind: "none", size: data.length };
}

/**
 * 고른 항목들을 풀어 쓴다. 진행 상황은 메인에 따로 보낸다.
 * @param {string[]} names 팩 안에 경로 목록
 * @param {string} outDir 출력 폴더
 * @returns {import("../core/extract.js").ExtractResult}
 */
function extract(names, outDir) {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    const entries = folder.entries.filter((e) => wanted.has(e.name.toLowerCase()));
    let last = 0;
    return extractEntries(folder, entries, outDir, (done, total) => {
        // 진행 메세지는 0.1초에 한 번만 보낸다 (메시지가 너무 잦으면 UI 가 느려진다)
        const now = Date.now();
        if (done !== total && now - last < 100) return;
        last = now;
        parentPort.postMessage({ progress: { done, total } });
    });
}

/**
 * 모델 하나를 GLB 로 바꿔 렌더러에 넘긴다 (미리보기용).
 * @param {string} name 팩 안의 nif 또는 kfm 경로
 * @param {boolean} [skipEffects] 빛/어둡게 레이어를 빼고 만든다
 * @returns {{ path: string, bytes: Buffer, warnings: string[] }} 실제로 쓴 nif 경로와 GLB
 */
function convert(name, skipEffects) {
    if (!folder) throw new Error("No pack folder is open");
    const model = convertPackModel(folder, name, { skipEffects });
    return { path: model.path, bytes: model.glb, warnings: model.warnings };
}

/**
 * 모델 하나를 GLB 파일로 저장한다 (내보내기).
 * @param {string} name 팩 안의 nif 또는 kfm 경로
 * @param {string} outDir 출력 폴더
 * @param {boolean} [skipEffects] 빛/어둡게 레이어를 빼고 만든다
 * @returns {{ file: string, bytes: number, warnings: string[] }}
 */
function exportModel(name, outDir, skipEffects) {
    if (!folder) throw new Error("No pack folder is open");
    const model = convertPackModel(folder, name, { skipEffects });
    // 팩 안 이름 그대로, 확장자만 바꿔 저장한다
    const file = path.join(outDir, path.basename(model.path).replace(/\.nif$/i, ".glb"));
    fs.writeFileSync(file, model.glb);
    return { file, bytes: model.glb.length, warnings: model.warnings };
}

// 메인이 보낸 요청을 종류에 따라 처리하고 결과를 돌려준다
const handlers = {
    open: ({ dir }) => open(dir),
    preview: ({ name }) => preview(name),
    convert: ({ name, skipEffects }) => convert(name, skipEffects),
    exportModel: ({ name, outDir, skipEffects }) => exportModel(name, outDir, skipEffects),
    extract: ({ names, outDir }) => extract(names, outDir),
    // 패턴에 맞는 항목 이름만 돌려준다 (glob 검색용. 화면 검색은 렌더러가 직접 한다)
    find: ({ pattern }) => filterEntries(folder.entries, pattern).map((e) => e.name),
};

parentPort.on("message", ({ id, type, args }) => {
    try {
        parentPort.postMessage({ id, ok: true, result: handlers[type](args ?? {}) });
    } catch (e) {
        // 게임이 팩을 잠근 경우는 렌더러가 따로 안내할 수 있게 표시해서 보낸다
        parentPort.postMessage({ id, ok: false, error: e.message, locked: e instanceof PackLockedError });
    }
});