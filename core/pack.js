/**
 * @file pack.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-22
 */

/**
 * DMO 팩 (.hf 인덱스 + .pf 데이터) 읽기 (FORMAT 1, 2, 4).
 * 팩은 읽기 전용으로만 연다. 쓰기 기능은 없다.
 */
import fs from "node:fs";
import path from "node:path";
import { djb2 } from "./hash.js";
import { decryptIndex, decodeEntry } from "./cipher.js";


// 신 클라이언트 인덱스 버전 (FORMAT 2)
const HF_VERSION = 0x13;
// pf 안에서 데이터 바로 앞에 붙는 경로 청크 크기 (FORMAT 4)
const CHUNK_SIZE = 268;
// 경로 청크의 경로를 믿어도 되는 문자 (FORMAT 4 방어 코드).
// 인쇄 가능한 ASCII 중 Windows 파일 이름에 못 쓰는 문자 (< > : " | ? *) 만 뺀다.
// 실제 경로에 # + & 가 있다. 진짜 판별은 해시 일치 검사가 한다
const PATH_CHARS = /^[\x20-\x7e]+$/;
const BAD_CHARS = /[<>:"|?*]/;

// GDMO 팩에 섞인 개발사 SVN 충돌 사본 (FORMAT 1 GDMO 차이). 예: skill_str.bin.r4363, 3.nif.mine
// 게임은 쓰지 않는 파일이라 목록에서 뺀다
const SVN_LEFTOVER = /\.(r\d+|mine)$/i;

/**
 * @typedef  {object} Entry   팩 항목 하나
 * @property {number} hash    경로 해시 (FORMAT 3)
 * @property {number} offset  pf 안에서 데이터가 시작하는 위치
 * @property {number} size    데이터 길이
 * @property {string} name    팩 안의 경로. 복원 못 하면 "_unnamed\<HASH>.bin"
 * @property {Pack}   pack    이 항목이 들어 있는 팩
 */

/**
 * 게임이 pf 를 잠갔을 때 던지는 오류 (FORMAT 6-3)
 */
export class PackLockedError extends Error {
    /**
     * @param {string} pfPath 잠긴 pf 경로
     * @param {Error} cause 원래 오류 (EBUSY)
     */
    constructor(pfPath, cause) {
        super(`Pack file is locked: ${pfPath}. Close the game and try again.`, { cause });
        this.name = "PackLockedError";
        this.code = "PACK_LOCKED";
    }
}

/**
 * .hf 파일을 읽어 인덱스 항목 목록을 만든다 (FORMAT 2).
 * @param {string} hfPath .hf 경로
 * @returns {{ hash: number, offset: number, size: number}[]}
 */
export function readIndex(hfPath) {
    const hf = fs.readFileSync(hfPath);
    // 헤더: +0 u32 version, +4 u32 blobLen (= 파일 크기 - 8)
    const version = hf.readUInt32LE(0);
    const blobLen = hf.readUInt32LE(4);
    if (version !== HF_VERSION) throw new Error(`Unsupported hf version 0x${version.toString(16)}: ${hfPath}`);
    if (blobLen !== hf.length - 8) throw new Error(`Bad hf blob length ${blobLen}: ${hfPath}`);

    // blob 을 풀면 u32 count + count x 24 B 엔트리
    const idx = decryptIndex(hf.subarray(8));
    const count = idx.readUInt32LE(0);
    // 풀린 길이가 정확히 맞아야 한다 (FORMAT 2-2 확인)
    if (idx.length !== 4 + count * 24) throw new Error(`Bad index length ${idx.length} for ${count} entries: ${hfPath}`);

    const entries = [];
    for (let i = 0; i < count; i ++) {
        const o = 4 + i * 24;
        entries.push({
            hash: idx.readUInt32LE(o), // +0 경로 해시
            // +4 flags (항상 0) 는 건너뛴다
            offset: Number(idx.readBigUInt64LE(o + 8)), // +8 u64 offset. 2^53 보다 작아서 Number 로 안전하다
            size: idx.readUInt32LE(o + 16),
            // +20 alloc 은 무시한다
        });
    }
    return entries;
}

/**
 * pf 를 읽기 전용으로 연다. 게임이 잠갔으면 PackLockedError 를 던진다.
 * @param {string} pfPath .pf 경로
 * @returns {number} 파일 디스크립터
 */
function openPf(pfPath) {
    try {
        return fs.openSync(pfPath, "r");
    } catch (e) {
        if (e.code === "EBUSY") throw new PackLockedError(pfPath, e);
        throw e;
    }
}

/**
 * pf 의 경로 청크에서 파일 이름을 읽는다 (FORMAT 4).
 * 길이, 문자, 해시가 모두 맞을 때만 믿고, 아니면 null.
 * @param {Buffer} chunk offset - 268 부터 읽은 268 B
 * @param {number} hash 인덱스의 경로 해시
 * @returns {string | null}
 */
function parseChunk(chunk, hash) {
    // offset - 4 위치 (청크 + 264) 의 u32 가 경로 길이 L
    const len = chunk.readUInt32LE(264);
    if (len === 0 || len > 260) return null;
    // 경로 바이트는 하나씩 0xD0 과 XOR로 되어 있다
    let name = "";
    for (let i = 0; i < len; i ++) name += String.fromCharCode(chunk[i] ^ 0xd0);
    // 허용 문자만 있고, 그 경로의 해시 와 같아야 한다
    if (!PATH_CHARS.test(name) || BAD_CHARS.test(name) || djb2(name) !== hash) return null;
    return name;
}

/**
 * 팩 한 쌍 (.hf + .pf)
 */
export class Pack {
    /**
     * 인덱스를 읽고, pf 를 열어 모든 항목의 이름을 복원한다.
     * @param {string} hfPath .hf 경로. .pf 는 같은 폴더, 같은 이름이다
     */
    constructor(hfPath) {
        this.hfPath = hfPath;
        this.pfPath = hfPath.replace(/\.hf$/i, ".pf");
        // pf 를 먼저 연다. 게임이 켜져 있으면 여기서 PackLockedError 가 난다
        this.fd = openPf(this.pfPath);
        try {
            /** @type {Entry[]} */
            this.entries = readIndex(hfPath).map((e) => ({ ...e, name: "", pack: this }));
            this.readNames();
        } catch (e) {
            // 인덱스가 깨졌으면 연 pf 를 닫고 오류를 그대로 던진다
            this.close();
            throw e;
        }
    }

    /**
     * 모든 항목의 경로 청크를 읽어 이름을 채운다 (FORMAT 4).
     * 디스크를 앞에서 읽도록 offset 순으로 정렬해서 읽는다.
     */
    readNames() {
        const chunk = Buffer.alloc(CHUNK_SIZE);
        const sorted = [...this.entries].sort((a, b) => a.offset - b.offset);
        for (const e of sorted) {
            // 청크는 데이터 바로 앞 268 B 에 있다
            const n = e.offset >= CHUNK_SIZE ? fs.readSync(this.fd, chunk, 0, CHUNK_SIZE, e.offset - CHUNK_SIZE) : 0;
            const name = n === CHUNK_SIZE ? parseChunk(chunk, e.hash) : null;
            // 복원 못 하면 해시로 임시 이름을 만든다
            e.name = name ?? `_unnamed\\${e.hash.toString(16).toUpperCase().padStart(8, "0")}.bin`;
        }
    }

    /**
     * 항목의 데이터를 pf 에서 그대로 읽는다 (복호하지 않음).
     * @param {Entry} e 항목
     * @returns {Buffer}
     */
    readRaw(e) {
        const buf = Buffer.alloc(e.size);
        const n = fs.readSync(this.fd, buf, 0, e.size, e.offset);
        if (n !== e.size) throw new Error(`Short read ${n}/${e.size}: ${e.name}`);
        return buf;
    }

    /**
     * 항목을 원본 파일 내용으로 읽는다 (필요하면 복호, FORMAT 5).
     * @param {Entry} e 항목
     * @returns {Buffer}
     */
    read(e) {
        return decodeEntry(this.readRaw(e));
    }

    /** pf 파일을 닫는다 */
    close() {
        fs.closeSync(this.fd);
    }
}

/** 
 * DMO Data 폴더 모든 팩을 연다 (FORMAT 1).
 * 팩 번호나 이름으로 분기하지 않고, 폴더의 .hf 를 전부 연다. KDMO 와 GDMO 가 같은 코드로 동작한다.
 */
export class PackFolder {
    /**
     * @param {string} dir DMO 설치 폴더의 Data 폴더
     */
    constructor(dir) {
        // 확장자가 .hf 인 파일 (대소문자 무관) 을 찾아 이름순으로 연다
        const hfs = fs.readdirSync(dir).filter((f) => /\.hf$/i.test(f)).sort();
        if (hfs.length === 0) throw new Error(`No .hf files in ${dir}`);
        /** @type {Pack[]} */
        this.packs = [];
        try {
            for (const f of hfs) this.packs.push(new Pack(path.join(dir, f)));
        } catch (e) {
            // 중간에 실패하면 이미 연 팩을 닫고 오류를 그대로 던진다
            this.close();
            throw e;
        }
        /** @type {Entry[]} 모든 팩의 항목 (SVN 충돌 사본은 뺀다) */
        this.entries = this.packs.flatMap((p) => p.entries).filter((e) => !SVN_LEFTOVER.test(e.name));
        // 경로 해시로 항목을 찾는 표
        this.byHash = new Map(this.entries.map((e) => [e.hash, e]));
    }

    /**
     * 팩 안에 경로로 항목을 찾는다. 대소문자와 구분자 (\ /) 는 상관없다.
     * @param {string} p 경로. 예: "data\\model.dat"
     * @returns {Entry | undefined}
     */
    find(p) {
        return this.byHash.get(djb2(p));
    }

    /**
     * 항목을 원본 파일 내용으로 읽는다.
     * @param {Entry} e 항목
     * @returns {Buffer}
     */
    read(e) {
        return e.pack.read(e);
    }

    /**
     * 모든 팩을 닫는다.
     */
    close() {
        for (const p of this.packs) p.close();
    }
}