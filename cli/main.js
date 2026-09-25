/**
 * @file main.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-23
 */

/**
 * DMOAssets 명령줄 도구.
 * 
 *   node cli/main.js list    <DMO Data 폴더> [-f 패턴]
 *   node cli/main.js extract <DMO Data 폴더> [-f 패턴] [-o 출력 폴더]
 *   node cli/main.js convert <DMO Data 폴더> <팩 안의 nif 또는 kfm 경로> [-o 출력]
 * 
 * 종료 코드: 0 성공, 1 실패 (일부 항목 실패 포함), 2 게임이 팩을 잠금.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PackFolder, PackLockedError } from "../core/pack.js";
import { filterEntries, extractEntries } from "../core/extract.js";
import { convertPackModel } from "../core/gltf.js";

const USAGE = `Usage:
  dmoassets list    <DMO Data folder> [-f <pattern>]
    dmoassets extract <DMO Data folder> [-f <pattern>] [-o <output folder>]
  dmoassets convert <DMO Data folder> <path in pack> [-o <output file or folder>]

Options:
  -f, --filter <pattern>  Substring (e.g. agumon) or glob (e.g. data/digimon/**/*.nif). Case-insensitive.
  -o, --output <path>     Output folder for extract (default: ./extracted), file or folder for convert
      --format <format>   Model format for convert: glb (default)
      --no-effects        Convert without the glow and darkening layers that sit on top of the model
      -- no-anim          Convert without the animations a .kfm points at
  -h, --help              Show this help

Convert takes a .nif, or a .kfm that names the model's .nif.`;


/**
 * 진행 상황을 한 줄에 덮어써서 보여 주는 함수를 만든다.
 * 터미널이 아니면 (파일로 리다이렉트 등) 아무것도 하지 않는다. 너무 자주 그리지 않도록 0.2초에 한 번만 갱신한다.
 * @returns {(done: number, total: number) => void}
 */
function progressPrinter() {
    if (!process.stderr.isTTY) return () => {};
    let last = 0;
    return (done, total) => {
        const now = Date.now();
        if (done !== total && now - last < 200) return;
        last = now;
        process.stderr.write(`\r${done}/${total} (${Math.floor((done / total) * 100)}%)`);
        if (done === total) process.stderr.write("\n");
    };
}

/**
 * list 명령: 고른 항목의 경로와 크기를 한 줄에 하나씩 표준 출력으로 쓴다 (경로<TAB>바이트).
 * @param {PackFolder} folder 열린 팩 폴더
 * @param {string} [filter] 필터 패턴
 * @returns {number} 종료 코드
 */
function list(folder, filter) {
    const entries = filterEntries(folder.entries, filter);
    // 이름순으로 정렬해 보기 좋게 출력한다
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    process.stdout.write(sorted.map((e) => `${e.name}\t${e.size}`).join("\n") + (sorted.length ? "\n" : ""));
    // 개수 요약은 표준 에러로 보내서 파이프로 넘기는 목록에 섞이지 않게 한다
    console.error(`${sorted.length} entries`);
    return 0;
}

/**
 * extract 명령: 고른 항목을 원본 파일로 풀어 출력 폴더에 쓴다.
 * @param {PackFolder} folder 열린 팩 폴더
 * @param {string} [filter] 필터 패턴
 * @param {string} outDir 출력 폴더
 * @returns {number} 종료 코드 (실패한 항목이 있으면 1)
 */
function extract(folder, filter, outDir) {
    const entries = filterEntries(folder.entries, filter);
    if (entries.length === 0) {
        console.error("No entries match.");
        return 1;
    }

    const r = extractEntries(folder, entries, outDir, progressPrinter());
    console.error(`Extracted ${r.files} files (${(r.bytes / 1024 / 1024).toFixed(1)} MB) to ${outDir}`);
    // 실패한 항목은 이유와 함께 모두 보여 준다
    if (r.failed.length) {
        console.error(`Failed ${r.failed.length}:`);
        for (const f of r.failed) console.error(`  ${f.name}: ${f.error}`);
        return 1;
    }
    return 0;
}

/**
 * convert 명령: 팩 안의 모델 하나를 GLB 파일로 만든다.
 * @param {PackFolder} folder 열린 팩 폴더
 * @param {string} packPath 팩 안의 nif 또는 kfm 경로
 * @param {string} [output] 출력 위치 (.glb 로 끝나면 파일, 아니면 폴더). 없으면 현재 폴더
 * @param {string} format 출력 형식
 * @param {boolean} [skipEffects] 빛 (더하기) 과 어둡게 합성 레이어를 빼고 만든다
 * @param {boolean} [skipAnimations] kfm 이 가리키는 동작을 넣지 않는다
 * @returns {number} 종료 코드
 */
function convert(folder, packPath, output, format, skipEffects, skipAnimations) {
    // FBX 는 10단계에서 넣는다. 지금은 GLB 만 만든다
    if (format !== "glb") {
        console.error(`Unsupported format ${JSON.stringify(format)}. Only "glb" is available.`);
        return 1;
    }

    const model = convertPackModel(folder, packPath, { skipEffects, skipAnimations });
    // 출력이 .glb 로 끝나면 파일 이름으로, 아니면 폴더로 본다
    const name = path.basename(model.path).replace(/\.nif$/i, ".glb");
    const file = output && /\.glb$/i.test(output) ? output : path.join(output ?? ".", name);
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, model.glb);

    const anims = model.animations ? `, ${model.animations} animations` : "";
    console.error(`Wrote ${file} (${(model.glb.length / 1024 / 1024).toFixed(1)} MB${anims}) from ${model.path}`);
    // 텍스처를 못 찾으면 모델이 민짜로 나온다. 조용히 넘기지 않고 알린다 (FORMAT 10-3 2번)
    for (const w of model.warnings) console.error(`  ${w}`);
    return 0;
}


/**
 * 인자를 해석해 명령을 실행한다.
 * @param {string[]} argv 명령줄 인자 (node 와 스크립트 경로 제외)
 * @returns {number} 종료 코드
 */
export function main(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            filter: { type: "string", short: "f" },
            output: { type: "string", short: "o" },
            "no-effects": { type: "boolean" },
            "no-anim": { type: "boolean" },
            format: { type: "string", default: "glb" },
            help: { type: "boolean", short: "h" },
        },
    });
    const [command, dir, target] = positionals;
    // 명령과 폴더가 없거나 도움말을 요청하면 사용법을 보여 준다.
    // convert 는 팩 안의 경로까지 있어야 한다
    if (values.help || !command || !dir || !["list", "extract", "convert"].includes(command) || (command === "convert" && !target)) {
        console.error(USAGE);
        return values.help ? 0 : 1;
    }

    let folder;
    try {
        folder = new PackFolder(dir);
    } catch (e) {
        // 게임이 켜져 있어 pf 가 잠긴 경우는 안내만 하고 별도 종료 코드로 끝낸다 (FORMAT 6-3)
        if (e instanceof PackLockedError) {
            console.error("Pack files are locked because the game is running. Close the game and try again.");
            return 2;
        }
        throw e;
    }
    try {
        if (command === "list") return list(folder, values.filter);
        if (command === "convert") return convert(folder, target, values.output, values.format, values["no-effects"], values["no-anim"]);
        return extract(folder, values.filter, values.output ?? "extracted");
    } finally {
        folder.close();
    }
}

// 이 파일을 직접 실행했을 때만 main 을 부른다 (테스트에서 import 할 때는 실행하지 않는다)
if (import.meta.main) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (e) {
        // 알 수 없는 오류는 메세지만 보여 주고 1로 끝낸다
        console.error(`Error: ${e.message}`);
        process.exitCode = 1;
    }
}