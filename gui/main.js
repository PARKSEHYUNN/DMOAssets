/**
 * @file main.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-23
 */

/**
 * Electron 메인 프로세스.
 * 
 * 창을 만들고, 렌더러의 요청을 워커 (gui/packWorker.js) 로 넘긴다.
 * 무거운 작업은 모두 워커에서 하므로 여기서는 폴더 선택 창만 직접 띄운다.
 */

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Worker | null} */
let worker = null;
// 워커에 보낸 요청의 답을 기다리는 곳 (id -> resolve/reject)
const pending = new Map();
let nextId = 1;

/**
 * 워커를 띄우고 메시지 처리를 붙인다.
 */
function startWorker() {
    worker = new Worker(path.join(here, "packWorker.js"));
    worker.on("message", (msg) => {
        // 진행 상황은 답이 아니라 알림이다. 참으로 그대로 보낸다
        if (msg.progress) {
            win?.webContents.send("progress", msg.progress);
            return;
        }
        const slot = pending.get(msg.id);
        if (!slot) return;
        pending.delete(msg.id);
        if (msg.ok) slot.resolve(msg.result);
        else slot.reject(Object.assign(new Error(msg.error), { locked: msg.locked }));
    });
    // 워커가 죽으면 기다리던 요청을 모두 실패로 끝낸다 (렌더러가 멈춰 있지 않게)
    worker.on("error", (e) => {
        for (const slot of pending.values()) slot.reject(e);
        pending.clear();
    });
}

/**
 * 워커에 요청을 보내고 답을 기다린다.
 * @param {string} type 요청 종류 (packWorker.js 의 handlers 참고)
 * @param {object} [args] 인자
 * @returns {Promise<any>}
 */
function callWorker(type, args) {
    return new Promise((resolve, reject) => {
        const id = nextId ++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, type, args });
    });
}

/**
 * 앱 창을 만든다.
 */
function createWindow() {
    win = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "DMO Assets",
        webPreferences: {
            // 랜더러에서 Node 를 쓰지 않는다. 필요한 기능만 preload 가 열어 준다.
            // ESM perload 는 확장자가 .mjs 여야 하고 sandbox 를 꺼야 한다 (Electron 규칙)
            preload: path.join(here, "preload.mjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(here, "index.html"));
}

// 랜더러 -> 워커 요청을 그대로 넘긴다
ipcMain.handle("call", async (_event, type, args) => {
    try {
        return { ok: true, result: await callWorker(type, args) };
    } catch (e) {
        // 오류는 값으로 돌려준다 (렌더러에서 메시지를 그대로 보여 주기 위해)
        return { ok: false, error: e.message, locked: e.locked === true };
    }
});

// 폴더 고르기 창 (DMO 설치 폴더, 추출 위치)
ipcMain.handle("chooseFolder", async (_event, title) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ["openDirectory"] });
    return r.canceled ? null : r.filePaths[0];
});

app.whenReady().then(() => {
    startWorker();
    createWindow();
    // macOS 에서 독 아이콘을 눌렀을 때 창을 다시 만든다
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// 창을 모두 닫으면 끝낸다 (macOS 는 관례상 그대로 둔다)
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});