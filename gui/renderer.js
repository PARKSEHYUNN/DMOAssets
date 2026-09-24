/**
 * @file renderer.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-23
 */

/**
 * 화면 쪽 코드, Node 접근 권한이 없고, perload 가 열어 준 window.api 만 쓴다.
 * 
 * 하는 일: 팩 폴더 열기, 파일 트리 그리기, 검색, 미리보기 (이미지와 모델), 추출, GLB 내보내기
 */

import { showModel, clearModel } from "./viewer.js";

const $ = (id) => document.getElementById(id);
const treeEl = $("tree");
const infoEl = $("info");
const statusEl = $("status");
const searchEl = $("search");
const extractBtn = $("extractBtn");
const exportBtn = $("exportBtn");
const noEffectsEl = $("noEffects");
const viewerEl = $("viewer");
const previewEl = $("preview");

/** 모델로 열 수 있는 확장자. kfm 은 안에 적힌 nif 를 따라간다 (FORMAT 10-1) */
const MODEL_EXTS = new Set([".nif", ".kfm"]);

/** @type {{ name: string, size: number }[]} 열린 팩의 모든 항목 */
let entries = [];
/** @type {string | null} 지금 고른 항목 (파일) 또는 폴더 경로 */
let selected = null;
/** @type {boolean} 고른 것이 폴더인지 */
let selectedIsFolder = false;
/** @type {string | null} 지금 보여 주는 이미지의 blob 주소 (바꿀 때 풀어 준다) */
let previewUrl = null;

/**
 * 아래쪽 상태 줄에 글을 쓴다.
 * @param {string} text 보여 줄 글
 */
function setStatus(text) {
    statusEl.textContent = text;
}

/**
 * 바이트 수를 읽기 좋은 단위로 바꾼다.
 * @param {number} n 바이트
 * @returns {string} 예: "1.2 MB"
 */
function humanSize(n) {
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

/**
 * 경로 목록으로 폴더 트리를 만든다.
 * 폴더는 Map (이름 -> 하위 트리), 파일은 항목 객체로 둔다.
 * @param {{ name: string, size: number }[]} list 항목 목록
 * @returns {Map<string, any>} 트리 뿌리
 */
function buildTree(list) {
    const root = new Map();
    for (const e of list) {
        const parts = e.name.split("\\");
        let node = root;
        // 마지막 조각 앞까지는 폴더다
        for (let i = 0; i < parts.length - 1; i ++) {
            if (!node.has(parts[i])) node.set(parts[i], new Map());
            node = node.get(parts[i]);
        }
        node.set(parts.at(-1), e);
    }
    return root;
}

/**
 * 트리 한 단계를 화면에 그린다. 폴더는 펼칠 때 안쪽을 만든다 (항목이 5만 개라 미리 만들면 느리다).
 * @param {Map<string, any>} node 이 단계의 트리
 * @param {string} prefix 여기까지의 경로
 * @returns {DocumentFragment}
 */
function renderLevel(node, prefix) {
    const frag = document.createDocumentFragment();
    // 폴더 먼저, 그 다음 파일. 각각 이름순
    const items = [...node.entries()].sort((a, b) => {
        const aDir = a[1] instanceof Map;
        const bDir = b[1] instanceof Map;
        return aDir === bDir ? a[0].localeCompare(b[0]) : aDir ? -1 : 1;
    });

    for (const [name, value] of items) {
        const path = prefix ? `${prefix}\\${name}` : name;
        if (value instanceof Map) {
            // 폴더: details 를 쓰면 펼치기/접기를 브라우저가 해 준다
            const details = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = name;
            summary.onclick = () => select(path, true);
            const box = document.createElement("div");
            details.append(summary, box);
            // 처음 펼칠 때만 안쪽을 만든다
            details.addEventListener(
                "toggle",
                () => {
                    if (details.open && !box.hasChildNodes()) box.append(renderLevel(value, path));
                },
                { once: false },
            );
            frag.append(details);
        } else {
            // 파일
            const div = document.createElement("div");
            div.className = "file";
            div.dataset.path = path;
            div.textContent = name;
            const size = document.createElement("span");
            size.className = "size";
            size.textContent = humanSize(value.size);
            div.append(size);
            div.onclick = () => {
                select(path, false);
                showPreview(path);
            };
            frag.append(div);
        }
    }
    return frag;
}

/**
 * 항목을 고른 상태로 만든다.
 * @param {string} path 팩 안의 경로 (폴더면 폴더 경로)
 * @param {boolean} isFolder 폴더인지
 */
function select(path, isFolder) {
    selected = path;
    selectedIsFolder = isFolder;
    for (const el of treeEl.querySelectorAll(".file.sel")) el.classList.remove("sel");
    if (!isFolder) treeEl.querySelector(`.file[data-path="${CSS.escape(path)}"]`)?.classList.add("sel");
    extractBtn.disabled = false;
    extractBtn.textContent = isFolder ? "Extract folder…" : "Extract file…";

    // GLB 내보내기는 모델 파일을 골랐을 때만 쓸 수 있다
    exportBtn.disabled = isFolder || !isModel(path);
}

/**
 * 모델로 열 수 있는 파일인지 본다.
 * @param {string} name 팩 안의 경로
 * @returns {boolean}
 */
function isModel(name) {
    return MODEL_EXTS.has(name.slice(name.lastIndexOf(".")).toLowerCase());
}

/**
 * 오른쪽 미리보기를 비운다 (이미지 주소를 풀고, 모델을 치운다).
 */
function resetPreview() {
    // 이전 이미지 주소를 풀어 준다 (안 하면 메모리가 쌓인다)
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    previewEl.querySelector("img")?.remove();
    viewerEl.hidden = true;
    clearModel();
}

/**
 * 고른 모델을 GLB 로 바꿔 뷰어에 띄운다.
 * 워커가 만든 GLB 를 그대로 쓰므로, 여기서 제대로 보이면 내보낸 파일도 같다.
 * @param {string} name 팩 안의 nif 또는 kfm 경로
 */
async function showModelPreview(name) {
    setStatus(`Converting ${name}…`);
    const r = await window.api.convert(name, noEffectsEl.checked);
    resetPreview();
    if (!r.ok) {
        infoEl.textContent = `${name}\n\nError: ${r.error}`;
        setStatus("Ready");
        return;
    }

    viewerEl.hidden = false;
    try {
        const { size, meshes } = await showModel(viewerEl, r.result.bytes);
        const dim = size.map((v) => Math.round(v)).join(" x ");
        setStatus(`${r.result.path} — ${meshes} meshes, ${dim}, ${humanSize(r.result.bytes.length)} GLB`);
    } catch (e) {
        viewerEl.hidden = true;
        infoEl.textContent = `${name}\n\nError: ${e.message}`;
        setStatus("Ready");
        return;
    }
    // 텍스처를 못 찾았으면 알려 준다 (FORMAT 10-3 2번)
    infoEl.textContent = r.result.warnings.length ? `${name}\n\n${r.result.warnings.join("\n")}` : name;
}

/**
 * 고른 파일을 오른쪽에 보여 준다
 * @param {string} name 팩 안의 경로
 */
async function showPreview(name) {
    // nif, kfm 은 모델이라 GLB 로 바꿔 뷰어에 띄운다
    if (isModel(name)) return showModelPreview(name);

    setStatus(`Reading ${name}…`);
    const r = await window.api.preview(name);
    resetPreview();

    if (!r.ok) {
        infoEl.textContent = `${name}\n\nError: ${r.error}`;
        setStatus("Ready");
        return;
    }
    if (r.result.kind === "image") {
        // 워커가 보낸 바이트를 blob 으로 만들어 img 에 건다
        previewUrl = URL.createObjectURL(new Blob([r.result.bytes], { type: r.result.mime }));
        const img = document.createElement("img");
        img.src = previewUrl;
        img.onload = () => setStatus(`${name} — ${img.naturalWidth}x${img.naturalHeight}`);
        previewEl.append(img);
        infoEl.textContent = name;
    } else {
        // 이미지가 아니면 크기만 (또는 미리보기 못 하는 이유를) 보여 준다
        infoEl.textContent = `${name}\n\n${humanSize(r.result.size)}${r.result.reason ? `\nNo preview: ${r.result.reason}` : '\nNo preview for this file type.'}`;
        setStatus("Ready");
    }
}

/**
 * 검색어에 맞는 항목만 평평한 목록으로 보여 준다. 비우면 트리로 돌아간다.
 * @param {string} query 검색어 (경로의 일부, 대소문자 무시)
 */
function showSearch(query) {
  const q = query.trim().toLowerCase().replaceAll('/', '\\');
  if (!q) {
    treeEl.replaceChildren(renderLevel(buildTree(entries), ''));
    setStatus(`${entries.length} entries`);
    return;
  }
  const hits = entries.filter((e) => e.name.toLowerCase().includes(q));
  // 너무 많으면 앞에서 자른다 (5만 줄을 그리면 화면이 멈춘다)
  const shown = hits.slice(0, 500);
  const frag = document.createDocumentFragment();
  for (const e of shown) {
    const div = document.createElement('div');
    div.className = 'file';
    div.dataset.path = e.name;
    div.textContent = e.name;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = humanSize(e.size);
    div.append(size);
    div.onclick = () => {
      select(e.name, false);
      showPreview(e.name);
    };
    frag.append(div);
  }
  treeEl.replaceChildren(frag);
  setStatus(`${hits.length} matches${hits.length > shown.length ? ` (showing ${shown.length})` : ''}`);
}

// 폴더 열기: 폴더를 고르고 워커에 넘긴 뒤 트리를 그린다
$('openBtn').onclick = async () => {
  const dir = await window.api.chooseFolder('Select the DMO Data folder');
  if (!dir) return;
  setStatus(`Opening ${dir}…`);
  const r = await window.api.open(dir);
  if (!r.ok) {
    // 게임이 켜져 있으면 pf 가 잠긴다 (FORMAT 6-3)
    infoEl.textContent = r.locked ? 'Pack files are locked because the game is running.\nClose the game and try again.' : `Error: ${r.error}`;
    setStatus('Failed to open folder');
    return;
  }
  entries = r.result.entries;
  $('dir').textContent = r.result.dir;
  searchEl.disabled = false;
  searchEl.value = '';
  showSearch('');
// 다른 팩을 열면 보고 있던 이미지나 모델은 치운다
  resetPreview();
  exportBtn.disabled = true;
  infoEl.textContent = 'Select a file to preview it.';
};

// 옵션을 바꾸면 보고 있던 모델을 다시 변환해서 바로 비교할 수 있게 한다
noEffectsEl.onchange = () => {
    if (selected && !selectedIsFolder && isModel(selected)) showModelPreview(selected);
};

// 검색어를 칠 때마다 다시 그린다
searchEl.oninput = () => showSearch(searchEl.value);

// 추출: 고른 파일 하나, 또는 고른 폴더 아래 전부
extractBtn.onclick = async () => {
  const outDir = await window.api.chooseFolder('Select the output folder');
  if (!outDir) return;
  // 폴더를 골랐으면 그 경로로 시작하는 항목을 모두 고른다
  const names = selectedIsFolder ? entries.filter((e) => e.name.toLowerCase().startsWith(`${selected.toLowerCase()}\\`)).map((e) => e.name) : [selected];
  extractBtn.disabled = true;
  setStatus(`Extracting ${names.length} files…`);
  const r = await window.api.extract(names, outDir);
  extractBtn.disabled = false;
  if (!r.ok) {
    setStatus(`Extract failed: ${r.error}`);
    return;
  }
  const { files, bytes, failed } = r.result;
  setStatus(`Extracted ${files} files (${humanSize(bytes)}) to ${outDir}${failed.length ? ` — ${failed.length} failed` : ''}`);
  // 실패한 항목이 있으면 오른쪽에 목록을 보여 준다
  if (failed.length) infoEl.textContent = `Failed:\n${failed.map((f) => `${f.name}: ${f.error}`).join('\n')}`;
};

// 내보내기: 고른 모델을 GLB 파일로 저장한다 (미리보기와 같은 변환을 쓴다)
exportBtn.onclick = async () => {
    const outDir = await window.api.chooseFolder("Select the output folder");
    if (!outDir) return;
    exportBtn.disabled = true;
    setStatus(`Converting ${selected}…`);
    const r = await window.api.exportModel(selected, outDir, noEffectsEl.checked);
    exportBtn.disabled = false;
    if (!r.ok) {
        setStatus(`Export failed: ${r.error}`);
        return;
    }
    setStatus(`Wrote ${r.result.file} (${humanSize(r.result.bytes)})`);
    // 텍스처를 못 찾았으면 알려 준다 (FORMAT 10-3 2번)
    if (r.result.warnings.length) infoEl.textContent = `${selected}\n\n${r.result.warnings.join("\n")}`;
};

// 추출 진행 상황
window.api.onProgress(({ done, total }) => setStatus(`Extracting ${done}/${total} (${Math.floor((done / total) * 100)}%)`));
