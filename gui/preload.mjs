/**
 * @file preload.mjs
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-23
 */

/**
 * preload: 렌더러에 필요한 기능만 골라서 열어 준다.
 * 렌더러는 Node 접근 권한이 없으므로 여기 있는 함수만 쓸 수 있다.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
    /**
     * 폴더 고르기 창을 띄운다.
     * @param {string} title 창 제목
     * @returns {Promise<string | null>} 고른 폴더. 취소하면 null
     */
    chooseFolder: (title) => ipcRenderer.invoke("chooseFolder", title),

    /**
     * 팩 폴더 연다.
     * @param {string} dir Data 폴더
     * @returns {Promise<{ ok: boolean, result?: object, error?: string, locked?: boolean }>}
     */
    open: (dir) => ipcRenderer.invoke("call", "open", { dir }),

    /**
     * 항목 하나를 미리보기용으로 읽는다.
     * @param {string} name 팩 안의 경로
     * @returns {Promise<{ ok: boolean, result?: object, error?: string }>}
     */
    preview: (name) => ipcRenderer.invoke("call", "preview", { name }),

    /**
     * 고른 항목들을 풀어 쓴다.
     * @param {string[]} names 팩 안의 경로 목록
     * @param {string} outDir 출력 폴더
     * @returns {Promise<{ ok: boolean, result?: object, error?:string }>}
     */
    extract: (names, outDir) => ipcRenderer.invoke("call", "extract", { names, outDir }),

    /**
     * 추출 진행 상황을 받는다.
     * @param {(p: { done: number, total: number }) => void} fn 진행마다 불릴 함수
     */
    onProgress: (fn) => ipcRenderer.on("progress", (_event, p) => fn(p)),
});