/**
 * @file gltf.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-23
 */

/**
 * NIF 을 glTF 2.0 (GLB) 로 바꾼다 (FORMAT 9, 10).
 *
 * 뼈와 애니는 아직 넣지 않는다. 스킨 모델도 정점이 바인드 자세 그대로 들어 있어서
 * 노드 변환만 따라가면 모양은 맞는다 (FORMAT 10-3).
 * 텍스처는 nif 안에 들어 있으면 그대로 꺼내 PNG 로 넣고, 외부 파일이면 찾아 주는 함수를 받아서 쓴다.
 */

import { decodeImage, encodePNG } from "./image.js";
import { decodePixelData, kfmKfNames, kfmNifName, parseNif } from "./nif.js";
import { sampleAnimations } from "./kf.js";

/** glTF 상수: 실수 3개 배열 등 */
const FLOAT = 5126;
const U16 = 5123;
const U32 = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/**
 * 정규화한 3x3 회전 행렬 (행 순서) 을 사원수로 바꾼다.
 * 대각합이 양수면 바로 구할 수 있고, 아니면 가장 큰 대각 성분을 기준으로 나눈다 (0 으로 나누는 것을 피한다).
 * @param {number[]} m 행렬 9개 (m00 m01 m02 m10 ...)
 * @returns {number[]} 사원수 [x, y, z, w]
 */
function toQuaternion(m) {
    const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
    const trace = m00 + m11 + m22;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
    }
    if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        return [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    }
    if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        return [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
    }
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    return [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
}

/**
 * nif 의 변환 (이동, 3x3 회전, 배율) 을 glTF 노드 필드로 바꾼다.
 * nif 는 열벡터 규칙 (v' = R * v * scale + t) 이고 행렬을 행 순서로 저장한다.
 *
 * 행렬을 그대로 쓰지 않고 이동/회전/배율로 나눠 적는다. nif 의 회전 행렬은 내보내기 때
 * 값이 조금씩 어긋나 있어서 (길이가 0.9993 인 경우 등) 행렬로 적으면 glTF 검사기가
 * "TRS 로 나눌 수 없다" 고 본다. 열 길이를 배율로 빼내고 회전만 정규화해서 넣는다.
 * @param {object} node 파싱한 NiAVObject
 * @returns {object} glTF 노드에 넣을 translation, rotation, scale (기본값이면 넣지 않는다)
 */
function nodeTransform(node) {
    const m = node.rotation;
    // 열벡터 규칙이라 각 열이 원래 축이 가는 자리다. 열의 길이가 그 축의 배율이다
    const columns = [0, 1, 2].map((c) => Math.hypot(m[c], m[c + 3], m[c + 6]));
    const normalized = [];
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) normalized.push(columns[c] ? m[r * 3 + c] / columns[c] : r === c ? 1 : 0);
    }
    // 뒤집힌 (거울) 행렬이면 행렬식이 음수다. 첫 축의 배율을 음수로 돌려 회전만 남긴다
    const det =
        normalized[0] * (normalized[4] * normalized[8] - normalized[5] * normalized[7]) -
        normalized[1] * (normalized[3] * normalized[8] - normalized[5] * normalized[6]) +
        normalized[2] * (normalized[3] * normalized[7] - normalized[4] * normalized[6]);
    if (det < 0) {
        columns[0] = -columns[0];
        for (const r of [0, 1, 2]) normalized[r * 3] = -normalized[r * 3];
    }

    const out = {};
    const t = node.translation;
    if (t[0] || t[1] || t[2]) out.translation = t;
    const q = toQuaternion(normalized);
    if (q[0] || q[1] || q[2] || q[3] !== 1) out.rotation = q;
    // nif 의 배율은 축 구분 없이 하나다. 행렬에서 빼낸 길이와 곱해 축별 배율로 적는다
    const scale = columns.map((c) => c * node.scale);
    if (scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1) out.scale = scale;
    return out;
}

/**
 * 색 값을 0~1 로 자른다.
 * 이펙트 재질은 알파나 색을 0아래 또는 1 위로 넣어 두기도 하는데 (애니메이션으로 오르내린다),
 * glTF 는 0~1 만 받는다.
 * @param {number[]} values 색 성분
 * @returns {number[]} 잘라 낸 값
 */
function clamp01(values) {
    return values.map((v) => Math.min(1, Math.max(0, v)));
}

/**
 * NiAlphaProperty 의 합성 방식을 알아낸다 (FORMAT 9-2)
 * flags 비트 0 이 합성 여부, 비트 1~4 가 원본 계수, 비트 5~8 이 도착지 계수다.
 * 계수 번호 0 ONE, 1 ZERO, 2 SRC_COLOR, 3 INV_SRC_COLOR, 6 SRC_ALPHA, 7 INV_SRC_ALPHA.
 * @param {object | null} alpha NiAlphaProperty 블록
 * @returns {"none" | "normal" | "add" | "multiply"} 합성 방식
 */
function blendMode(alpha) {
    if (!alpha || !(alpha.flags & 0x1)) return "none";
    const src = (alpha.flags >> 1) & 0xf;
    const dst = (alpha.flags >> 5) & 0xf;
    // 도착지 계수가 ONE 이면 더하기 합성이다 (빛, 오라). 팩에서 제일 흔하다
    if (dst === 0) return "add";
    // ZERO -> INV_SRC_COLOR 는 밝은 곳일수록 어둡게 만드는 합성이다
    if (src === 1 && dst === 3) return "multiply";
    return "normal";
}

/**
 * glTF 에 없는 합성 방식을 알파로 흉내 낸다.
 * glTF 는 일반 합성만 있어서, 더하기/곱하기 레이어를 그대로 두면 모델을 통째로 덮어 버린다.
 * - 더하기: 검은 곳은 더해도 변화가 없다. 밝기를 알파로 옮기면 검은 곳이 비친다
 * - 곱하기: (ZERO -> INV_SRC_COLOR): 밝은 곳일수록 뒤를 어둡게 만든다. 색을 검게 두고 밝기를 알파로 쓴다
 * @param {import("./image.js").Image} img 푼 텍스처 (그 자리에서 고친다)
 * @param {"none" | "normal" | "add" | "multiply"} mode 합성 방식
 * @returns {import("./image.js").Image} 같은 이미지
 */
function fakeBlend(img, mode) {
    if (mode !== "add" && mode !== "multiply") return img;
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        // 사람 눈에 맞춘 밝기 (0~1)
        const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
        if (mode === "add") {
            d[i + 3] = Math.round(d[i + 3] * lum);
        } else {
            d[i + 3] = Math.round(lum * 255);
            d[i] = 0;
            d[i + 1] = 0;
            d[i + 2] = 0;
        }
    }
    return img;
}


/**
 * nif 변환 (이동, 회전, 배율) 을 glTF 의 4x4 행렬로 만든다 (열 순서).
 * 스킨의 바인드 행렬처럼 노드가 아니라 값으로 넣어야 하는 곳에 쓴다.
 * @param {{ rotation: number[], translation: number[], scale: number }} t nif 변환
 * @returns {number[]} 행렬 16개
 */
function toMatrix(t) {
    const m = t.rotation;
    const s = t.scale;
    return [
        m[0] * s, m[3] * s, m[6] * s, 0,
        m[1] * s, m[4] * s, m[7] * s, 0,
        m[2] * s, m[5] * s, m[8] * s, 0,
        t.translation[0], t.translation[1], t.translation[2], 1,
    ];
}

/**
 * 뼈 마다 흩어져 있는 가중치를 정점별로 모아 glTF 형식으로 만든다.
 * glTF 는 정점 하나에 뼈 4개까지 쓰므로, 더 많으면 큰 것 4개만 남기고 합이 1이 되게 고친다.
 * @param {object[]} bones NiSkinData 의 뼈 목록
 * @param {number} numVertices 정점 수
 * @returns {{ joints: number[], weights: number[] }} 정점당 4개씩 이어 붙인 배열
 */
function skinAttributes(bones, numVertices) {
    // 정점마다 [뼈 번호, 가중치] 목록을 모은다
    const perVertex = Array.from({ length: numVertices }, () => []);
    for (let b = 0; b < bones.length; b ++) {
        for (const w of bones[b].weights) {
            if (w.vertex < numVertices && w.weight > 0) perVertex[w.vertex].push([b, w.weight]);
        }
    }

    const joints = new Array(numVertices * 4).fill(0);
    const weights = new Array(numVertices * 4).fill(0);
    for (let v = 0; v < numVertices; v ++) {
        // 가중치가 큰 것부터 4개만 쓴다 (잘려 나가는 것은 0.3% 정도이고 값도 작다)
        const list = perVertex[v].sort((a, b) => b[1] - a[1]).slice(0, 4);
        const total = list.reduce((sum, x) => sum + x[1], 0);
        for (let i = 0; i < list.length; i ++) {
            joints[v * 4 + i] = list[i][0];
            // 4개만 남기고 나면 합이 1보다 작아진다. 다시 1로 맞춘다 (glTF 규칙)
            weights[v * 4 + i] = total > 0 ? list[i][1] / total : 0;
        }
    }

    return { joints, weights };
}

/**
 * GLB 를 만드는 동안 쓰는 상태를 들고 있는다.
 */
class Builder {
    /**
     * @param {import("./nif.js").Nif} nif 파싱한 nif
     * @param {object} [options] 설정
     * @param {(fileName: string) => Buffer | null} [options.resolveTexture] 외부 텍스처 파일을 찾아 주는 함수
     * @param {boolean} [options.skipEffects] 빛 (더하기) 과 어둡게 합성 레이어를 아예 빼고 만든다
     */
    constructor(nif, options = {}) {
        this.nif = nif;
        this.options = options;
        /** @type {string[]} 텍스처를 못 찾은 것 같은 경고 (FORMAT 10-3 2번) */
        this.warnings = [];
        /** @type {Buffer[]} GLB 뒤쪽 바이너리 조각 */
        this.bin = [];
        this.binLength = 0;
        this.json = {
            asset: { version: "2.0", generator: "DMOAssets" },
            scene: 0,
            scenes: [{ nodes: [0] }],
            nodes: [],
            meshes: [],
            skins: [],
            materials: [],
            textures: [],
            images: [],
            samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
            accessors: [],
            bufferViews: [],
            buffers: [],
        };
        /** @type {Map<number, number | null>} NiSourceTexture 블록 번호 -> glTF 텍스처 번호 */
        this.textureCache = new Map();
        /** @type {Map<string, number>} 재질 조합 -> glTF 재질 번호 */
        this.materialCache = new Map();
        /** @type {Map<string, number>} 형상 데이터 + 재질 -> glTF 메시 번호 */
        this.meshCache = new Map();
        /** @type {Set<number>} 뼈로 쓰이는 블록 번호. 빈 노드라도 지우면 안 된다 */
        this.boneBlocks = new Set();
        /** @type {Map<number, number>} 블록 번호 -> glTF 노드 번호 (뼈를 찾을 때 쓴다)*/
        this.nodeIndex = new Map();
        /** @type {{ skin: object, bones: (number | null)[] }[]} 노드 번호가 다 정해진 뒤에 채울 스킨들 */
        this.pendingSkins = [];
        /** @type {number[]} 스킨이 붙은 메시 노드. glTF 는 이런 노드의 변환을 무시하므로 뿌리에 단다 */
        this.skinnedNodes = [];
    }

    /**
     * 바이너리 조각을 붙이고 bufferView 를 만든다. 시작 위치는 4의 배수로 맞춘다.
     * @param {Buffer} buf 데이터
     * @param {number} [target] ARRAY_BUFFER 또는 ELEMENT_ARRAY_BUFFER
     * @returns {number} bufferView 번호
     */
    addView(buf, target) {
        const pad = (4 - (this.binLength % 4)) % 4;
        if (pad > 0) {
            this.bin.push(Buffer.alloc(pad));
            this.binLength += pad;
        }
        const index = this.json.bufferViews.length;
        this.json.bufferViews.push({ buffer: 0, byteOffset: this.binLength, byteLength: buf.length, ...(target ? { target } : {}) });
        this.bin.push(buf);
        this.binLength += buf.length;
        return index;
    }

    /**
     * float 배열을 accessor 로 만든다.
     * @param {number[]} values 값 (성분이 이어 붙은 형태)
     * @param {"VEC2"|"VEC3"|"VEC4"} type 성분 묶음
     * @param {boolean} [bounds] 최소/최대를 같이 적는다 (POSITION 은 필수다)
     * @returns {number} accessor 번호
     */
    addFloats(values, type, bounds) {
        const size = { VEC2: 2, VEC3: 3, VEC4: 4 }[type];
        const count = values.length / size;
        const buf = Buffer.alloc(values.length * 4);
        for (let i = 0; i < values.length; i++) buf.writeFloatLE(values[i], i * 4);
        const accessor = { bufferView: this.addView(buf, ARRAY_BUFFER), componentType: FLOAT, count, type };
        if (bounds) {
            // glTF 명세상 POSITION 에는 min, max 가 있어야 한다
            const min = new Array(size).fill(Infinity);
            const max = new Array(size).fill(-Infinity);
            for (let i = 0; i < values.length; i++) {
                const c = i % size;
                if (values[i] < min[c]) min[c] = values[i];
                if (values[i] > max[c]) max[c] = values[i];
            }
            accessor.min = min;
            accessor.max = max;
        }
        this.json.accessors.push(accessor);
        return this.json.accessors.length - 1;
    }

    /**
     * 삼각형 번호 목록을 accessor 로 만든다. 정점이 65536개 미만이면 u16 으로 줄인다.
     * @param {number[]} indices 정점 번호
     * @param {number} vertexCount 정점 수
     * @returns {number} accessor 번호
     */
    addIndices(indices, vertexCount) {
        const small = vertexCount < 65536;
        const buf = Buffer.alloc(indices.length * (small ? 2 : 4));
        for (let i = 0; i < indices.length; i++) {
            if (small) buf.writeUInt16LE(indices[i], i * 2);
            else buf.writeUInt32LE(indices[i], i * 4);
        }
        this.json.accessors.push({
            bufferView: this.addView(buf, ELEMENT_ARRAY_BUFFER),
            componentType: small ? U16 : U32,
            count: indices.length,
            type: "SCALAR",
        });
        return this.json.accessors.length - 1;
    }

    /**
     * 정점당 뼈 번호 4개를 accessor 로 만든다. 뼈는 많아야 수십 개라 u16이면 넉넉하다.
     * @param {number[]} values 뼈 번호 (정점당 4개씩)
     * @returns {number} accessor 번호
     */
    addJoints(values) {
        const buf = Buffer.alloc(values.length * 2);
        for (let i = 0; i < values.length; i ++) buf.writeUInt16LE(values[i], i * 2);
        this.json.accessors.push({
            bufferView: this.addView(buf, ARRAY_BUFFER),
            componentType: U16,
            count: values.length / 4,
            type: "VEC4",
        });
        return this.json.accessors.length - 1;
    }

    /**
     * 애니메이션 표본을 accessor 로 만든다.
     * 정점 속성이 아니므로 bufferView 에 target 을 붙이지 않는다 (glTF 규칙).
     * @param {number[]} values 값 (속성이 이어 붙은 형태)
     * @param {"SCALAR"|"VEC3"|"VEC4"} type 성분 묵음
     * @param {boolean} [bounds] 최소/최대를 적는다 (시간 accessor 에는 필수다)
     * @returns {number} accessor 번호
     */
    addSamples(values, type, bounds) {
        const size = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
        const buf = Buffer.alloc(values.length * 4);
        for (let i = 0; i < values.length; i ++) buf.writeFloatLE(values[i], i * 4);
        const accessor = { bufferView: this.addView(buf), componentType: FLOAT, count: values.length / size, type };
        if (bounds) {
            // 시간 accessor 는 min, max 가 없으면 검사기가 오류로 본다
            accessor.min = [values.reduce((a, b) => Math.min(a, b), Infinity)];
            accessor.max = [values.reduce((a, b) => Math.max(a, b), -Infinity)];
        }
        this.json.accessors.push(accessor);
        return this.json.accessors.length - 1;
    }

    /**
     * 4x4 행렬 목록을 accessor 로 만든다 (역바인드 행렬용).
     * 정점 속성이 아니므로 bufferView 에 target 을 붙이지 않는다 (glTF 규칙).
     * @param {number[]} values 행렬 값 (행렬마다 16개)
     * @returns {number} accessor 번호
     */
    addMatrices(values) {
        const buf = Buffer.alloc(values.length * 4);
        for (let i = 0; i < values.length; i ++) buf.writeFloatLE(values[i], i * 4);
        this.json.accessors.push({
            bufferView: this.addView(buf),
            componentType: FLOAT,
            count: values.length / 16,
            type: "MAT4",
        });
        return this.json.accessors.length - 1;
    }

    /**
     * NiSourceTexture 한 장을 glTF 텍스처로 만든다. 같은 블록은 한 번만 만든다.
     * @param {number} sourceIndex NiSourceTexture 블록 번호
     * @param {"none" | "normal" | "add" | "multiply"} mode 이 텍스처를 쓰는 재질의 합성 방식
     * @returns {number | null} glTF 텍스처 번호. 못 만들면 null
     */
    addTexture(sourceIndex, mode) {
        // 같은 그림이라도 합성 방식이 다르면 알파를 다르게 굽는다
        const key = `${sourceIndex}|${mode}`;
        if (this.textureCache.has(key)) return this.textureCache.get(key);
        const source = this.nif.blocks[sourceIndex];
        let png = null;
        try {
            if (source?.pixelData != null) {
                // 내장 텍스처 (FORMAT 9): 픽셀 블록을 그대로 풀어서 PNG 로 만든다
                const block = this.nif.blocks[source.pixelData];
                const palette = block.palette != null ? this.nif.blocks[block.palette] : undefined;
                png = encodePNG(fakeBlend(decodePixelData(block, palette), mode));
            } else if (source?.fileName) {
                // 외부 텍스처: nif 의 이름과 팩 안의 이름이 다를 수 있다 (FORMAT 10-2)
                const file = this.options.resolveTexture?.(source.fileName) ?? null;
                if (file) png = encodePNG(fakeBlend(decodeImage(file, source.fileName), mode));
                else this.warnings.push(`Texture not found: ${source.fileName}`);
            }
        } catch (e) {
            this.warnings.push(`Texture failed (${source?.fileName ?? sourceIndex}): ${e.message}`);
        }
        if (!png) {
            this.textureCache.set(key, null);
            return null;
        }
        const image = this.json.images.length;
        this.json.images.push({ bufferView: this.addView(png), mimeType: "image/png", name: source.fileName ?? undefined });
        const texture = this.json.textures.length;
        this.json.textures.push({ sampler: 0, source: image });
        this.textureCache.set(key, texture);
        return texture;
    }

    /**
     * 속성 블록들 (재질, 텍스처, 알파) 로 glTF 재질을 만든다.
     * @param {object} props 이 형상에 걸린 속성 (종류별 블록 번호)
     * @returns {number} glTF 재질 번호
     */
    addMaterial(props) {
        const key = `${props.material}|${props.texturing}|${props.alpha}`;
        if (this.materialCache.has(key)) return this.materialCache.get(key);

        const material = props.material != null ? this.nif.blocks[props.material] : null;
        const texturing = props.texturing != null ? this.nif.blocks[props.texturing] : null;
        const alpha = props.alpha != null ? this.nif.blocks[props.alpha] : null;
        // 합성 방식에 따라 텍스처의 알파를 다르게 굽는다 (더하기/곱하기는 glTF 에 없다)
        const mode = blendMode(alpha);
        const texture = texturing?.base?.source != null ? this.addTexture(texturing.base.source, mode) : null;

        // glTF 는 PBR 이다. 금속도 0, 거칠기 1 로 두어야 원래 색이 나온다 (FORMAT 10-3 3번)
        const diffuse = material?.diffuse ?? [1, 1, 1];
        const pbr = {
            baseColorFactor: clamp01([diffuse[0], diffuse[1], diffuse[2], material?.alpha ?? 1]),
            metallicFactor: 0,
            roughnessFactor: 1,
        };
        if (texture != null) pbr.baseColorTexture = { index: texture };
        const out = { name: material?.name ?? undefined, pbrMetallicRoughness: pbr, doubleSided: true };
        // 스스로 내는 빛. 어둡게 하는 레이어에서 빼야 한다 (흰 빛이 그대로 남아 모델을 덮는다)
        const emissive = mode === "multiply" ? null : material?.emissive;
        if (emissive && (emissive[0] || emissive[1] || emissive[2])) out.emissiveFactor = clamp01(emissive);
        // 더하기 합성은 빛이라 조명을 받지 않는다. 같은 그림을 발광으로 걸어 어두운 곳에서도 밝게 보이게 한다
        if (mode === "add" && texture != null) {
            out.emissiveTexture = { index: texture };
            out.emissiveFactor = [1, 1, 1];
        }

        // 합성이 있으면 반투명, 없고 비트 9 만 서있으면 임계값으로 잘라 낸다
        if (mode !== "none") out.alphaMode = "BLEND";
        else if (alpha && alpha.flags & 0x200) {
            out.alphaMode = "MASK";
            out.alphaCutoff = alpha.threshold / 255;
        }

        const index = this.json.materials.length;
        this.json.materials.push(out);
        this.materialCache.set(key, index);
        return index;
    }

    /**
     * NiSkinInstance 를 glTF 스킨으로 만든다.
     * 뼈 노드 번호는 트리를 다 돌아야 알 수 있으므로 나중에 채운다 (pendingSkins).
     * @param {number} skinInstanceIndex NiSkinInstance 블록 번호
     * @param {number} numVertices 이 메시의 정점 수
     * @returns {{ index: number, joints: number[], weights: number[] } | null} 스킨 번호와 정점 속성. 못 만들면 null
     */
    addSkin(skinInstanceIndex, numVertices) {
        const instance = this.nif.blocks[skinInstanceIndex];
        const data = instance?.data != null ? this.nif.blocks[instance.data] : null;
        if (!data || data.bones.length !== instance.bones.length) return null;
        // 뼈가 트리 밖에 있으면 노드를 만들 수 없다. 스킨을 포기하고 굳은 메시로 둔다
        if (instance.bones.some((b) => b == null ||  !this.reachable.has(b))) {
            this.warnings.push(`Skin skipped: ${instance.bones.length} bones are not in the node tree`);
            return null;
        }

        const { joints, weights } = skinAttributes(data.bones, numVertices);
        // 역바인드 행렬은 뼈마다의 스킨 변환 그대로다.
        // nif 에서 "뼈 월드 변환 * 뼈 스킨 변환" 이 바인드 자세라서 (FORMAT 9-2), glTF 가 바라는 값과 같다
        const matrices = data.bones.flatMap((b) => toMatrix(b.transform));
        const skin = { inverseBindMatrices: this.addMatrices(matrices), joints: [] };
        const index = this.json.skins.length;
        this.json.skins.push(skin);
        this.pendingSkins.push({ skin, bones: instance.bones });
        return { index, joints, weights };
    }
    
    /**
     * NiTriShape / NiTriStrips 를 glTF 메시로 만든다. 같은 데이터 + 재질 + 스킨이면 다시 쓴다.
     * @param {object} shape 형상 블록
     * @param {object} props 이 형상에 걸린 속성
     * @returns {{ mesh: number, skin?: number } | null} 메시 번호 (스킨이 있으면 스킨 번호도). 그릴 것이 없으면 null
     */
    addMesh(shape, props) {
        const data = shape.data != null ? this.nif.blocks[shape.data] : null;
        if (!data?.vertices || !data.triangles?.length) return null;
        // 빛/어둡게 레이어 빼기 옵션. 본체를 덮는 껍데기 메시라 Blender 에서 만질 때 거슬린다
        if (this.options.skipEffects) {
            const mode = blendMode(props.alpha != null ? this.nif.blocks[props.alpha] : null);
            if (mode === "add" || mode === "multiply") return null;
        }
        const materialIndex = this.addMaterial(props);
        const key = `${shape.data}|${materialIndex}|${shape.skinInstance ?? -1}`;
        if (this.meshCache.has(key)) return this.meshCache.get(key);

        const skin = shape.skinInstance != null ? this.addSkin(shape.skinInstance, data.numVertices) : null;
        const attributes = { POSITION: this.addFloats(data.vertices, "VEC3", true) };
        if (data.normals) attributes.NORMAL = this.addFloats(data.normals, "VEC3");
        // UV 는 첫 세트만 쓴다. nif 의 v 축 방향은 glTF 와 같아서 그대로 넣는다
        if (data.uvSets.length > 0) attributes.TEXCOORD_0 = this.addFloats(data.uvSets[0], "VEC2");
        if (data.colors) attributes.COLOR_0 = this.addFloats(data.colors, "VEC4");
        if (skin) {
            attributes.JOINTS_0 = this.addJoints(skin.joints);
            attributes.WEIGHTS_0 = this.addFloats(skin.weights, "VEC4");
        }

        const mesh = this.json.meshes.length;
        this.json.meshes.push({
            name: shape.name ?? undefined,
            primitives: [{ attributes, indices: this.addIndices(data.triangles, data.numVertices), material: materialIndex }],
        });
        const built = { mesh, ...(skin ? { skin: skin.index } : {})};
        this.meshCache.set(key, built);
        return built;
    }

    /**
     * 블록 하나를 glTF 노드로 만들고, 자식까지 따라간다.
     * nif 는 속성 (재질 등) 을 부모에서 물려받으므로, 내려가면서 덮어쓴다.
     * @param {number} blockIndex 블록 번호
     * @param {object} inherited 부모에서 물려받은 속성
     * @returns {number | null} glTF 노드 번호. 만들 것이 없으면 null
     */
    addNode(blockIndex, inherited) {
        const block = this.nif.blocks[blockIndex];
        // 읽지 않은 블록 (파티클, CsNiNode 등) 은 통째로 건너뛴다
        if (!block?.rotation) return null;
        // 뼈로 쓰이는 노드는 숨김이든 비어 있든 남긴다 (스킨이 가리키기 때문이다)
        const isBone = this.boneBlocks.has(blockIndex);
        // 숨김 비트가 선 노드는 게임에서도 안 보인다 (FORMAT 9-2)
        if (block.flags & 0x1 && !isBone) return null;

        // 이 노드에 걸린 속성으로 물려받은 것을 덮어쓴다
        const props = { ...inherited };
        for (const p of block.properties) {
            const t = this.nif.blocks[p]?.type;
            if (t === "NiMaterialProperty") props.material = p;
            else if (t === "NiTexturingProperty") props.texturing = p;
            else if (t === "NiAlphaProperty") props.alpha = p;
        }

        const node = { name: block.name ?? undefined, ...nodeTransform(block) };

        if (block.type === "NiTriShape" || block.type === "NiTriStrips") {
            const built = this.addMesh(block, props);
            if (!built) return null;
            node.mesh = built.mesh;
            if (built.skin != null) {
                node.skin = built.skin;
                // glTF 는 스킨이 붙은 메시 노드의 변환을 무시한다 (뼈가 자리를 다 정한다).
                // 변환을 지우고 뿌리에 달아서, 읽는 쪽이 헷갈리지 않게 한다
                delete node.translation;
                delete node.rotation;
                delete node.scale;
                const index = this.pushNode(blockIndex, node);
                this.skinnedNodes.push(index);
                // 부모의 자식 목록에는 넣지 않는다
                return null;
            }
        } else {
            const children = [];
            for (const c of block.children ?? []) {
                if (c == null) continue;
                const child = this.addNode(c, props);
                if (child != null) children.push(child);
            }
            // 메시도 자식도 없는 노드는 빈 껍데기라 버린다 (뼈는 남긴다)
            if (children.length === 0 && !isBone) return null;
            if (children.length > 0) node.children = children;
        }

        return this.pushNode(blockIndex, node);
    }

    /**
     * 만든 노드를 목록에 넣고, 블록 번호와 노드 번호를 이어 둔다 (뼈를 찾을 때 쓴다).
     * @param {number} blockIndex nif 블록 번호
     * @param {object} node glTF 노드
     * @returns {number} glTF 노드 번호
     */
    pushNode(blockIndex, node) {
        const index = this.json.nodes.length;
        this.json.nodes.push(node);
        this.nodeIndex.set(blockIndex, index);
        return index;
    }

    /**
     * 표본으로 뜬 kf 애니메이션을 glTF animation 으로 만든다 (FORMAT 9-3).
     * kf 는 대상을 노드 이름으로 적으므로 이름으로 노드를 찾는다. 같은 이름이 여럿이면 먼저 나온 것을 쓴다.
     * 모델에 없는 이름 (이펙트용 더미 등) 을 가리키는 트랙은 버린다.
     */
    addAnimations() {
        const list = this.options.animations ?? [];
        if (list.length === 0) return;
        /** @type {Map<string, number>} 노드 이름 -> glTF 노드 번호 */
        const byName = new Map();
        for (const [block, index] of this.nodeIndex) {
            const name = this.nif.blocks[block].name;
            if (name != null && !byName.has(name)) byName.set(name, index);
        }

        const animations = [];
        for (const anim of list) {
            const samplers = [];
            const channels = [];
            for (const track of anim.tracks) {
                const node = byName.get(track.node);
                if (node == null) continue;
                for (const [path, channel] of [["translation", track.translation], ["rotation", track.rotation], ["scale", track.scale]]) {
                    if (!channel) continue;
                    // nif 의 크기는 값 하나지만 glTF 는 축마다 따로라 세 번 적는다
                    const values = path === "scale" ? channel.values.flatMap((s) => [s, s, s]) : channel.values;
                    const input = this.addSamples(channel.times, "SCALAR", true);
                    const output = this.addSamples(values, path === "rotation" ? "VEC4" : "VEC3");
                    channels.push({ sampler: samplers.length, target: { node, path } });
                    samplers.push({ input, output, interpolation: "LINEAR" });
                }
            }
            // 쓸 채널이 하나도 없는 동작은 넣지 않는다 (빈 animation 은 glTF 오류다)
            if (channels.length > 0) animations.push({ name: anim.name, samplers, channels });
        }
        if (animations.length > 0) this.json.animations = animations; 
    }

    /**
     * 뿌리에서 닿을 수 있는 노드 블록을 모으고, 뼈로 쓰이는 블록도 모은다.
     * 메시를 만들기 전에 알아야 한다 (뼈가 트리 밖이면 스킨을 포기해야 하고, 뼈 노드는 지우면 안 된다).
     */
    scanTree() {
        /** @type {Set<number>} 뿌리에서 닿는 블록  */
        this.reachable = new Set();
        const walk = (index) => {
            const block = this.nif.blocks[index];
            if (!block?.rotation || this.reachable.has(index)) return;
            this.reachable.add(index);
            for (const c of block.children ?? []) if (c != null) walk(c);
        };
        for (const r of this.nif.roots) walk(r);

        // 스킨이 가리키는 뼈 (트리를 도는 중에는 이미 늦으므로 미리 모은다)
        for (const block of this.nif.blocks) {
            if (block.type !== "NiSkinInstance") continue;
            for (const b of block.bones) if (b != null) this.boneBlocks.add(b);
        }
    }

    /**
     * 전체를 만들고 GLB 바이트를 낸다.
     * @returns {Buffer} GLB 파일 내용
     */
    build() {
        // 0번 노드는 축을 바꾸는 껍데기다. nif 는 Z 가 위, glTF 는 Y 가 위라 X 축으로 -90도 돌린다
        // (사원수 [x, y, z, w] = [sin(-45도), 0, 0, cos(-45도)])
        this.json.nodes.push({ name: "root", rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] });
        // 트리를 먼저 훑어서 뼈와 닿는 노드를 알아 둔다
        this.scanTree();
        const children = [];
        for (const r of this.nif.roots) {
            const node = this.addNode(r, {});
            if (node != null) children.push(node);
        }
        // 뼈 노드는 비어있어도 남기므로, 노드 수가 아니라 만들어진 메시로 판단한다
        if (this.json.meshes.length === 0) throw new Error("No drawable geometry in this NIF");
        if (children.length > 0) this.json.nodes[0].children = children;
        // 스킨 메시는 장면 바로 밑에 둔다. 변환이 무시되는 노드라 축 바꾸기 껍데기 밑에 둘 이유가 없고,
        // 뼈가 껍데기 밑에 있으므로 결과는 똑같이 Y 가 위로 선다
        this.json.scenes = [{ nodes: [0, ...this.skinnedNodes] }];

        // 이제 노드 번호를 알 수 있으니 스킨의 뼈 목록을 채운다
        for (const { skin, bones } of this.pendingSkins) skin.joints = bones.map((b) => this.nodeIndex.get(b));
        // 애니메이션 노드 번호를 가리키므로 노드를 다 만든 뒤에 붙인다
        this.addAnimations();

        // 텍스처가 하나도 없으면 샘플러도 쓸 데가 없다
        if (this.json.textures.length === 0) this.json.samplers = [];
        // 빈 목록은 glTF 검사기가 오류로 본다. 지운다
        for (const k of ["meshes", "skins", "materials", "textures", "images", "samplers", "accessors", "bufferViews"]) {
            if (this.json[k].length === 0) delete this.json[k];
        }
        const bin = Buffer.concat(this.bin);
        this.json.buffers = [{ byteLength: bin.length }];
        return packGLB(this.json, bin);
    }
}

/**
 * glTF JSON 과 바이너리를 GLB 한 덩어리로 묶는다.
 * GLB: 12바이트 헤더 + (길이 + "JSON" + 내용) + (길이 + "BIN\0" + 내용). 각 덩어리는 4의 배수로 채운다.
 * @param {object} json glTF 문서
 * @param {Buffer} bin 바이너리 덩어리
 * @returns {Buffer}
 */
function packGLB(json, bin) {
    // JSON 은 공백 (0x20), 바이너리는 0 으로 채운다
    const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
    const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
    const binPad = (4 - (bin.length % 4)) % 4;
    const total = 12 + 8 + jsonBuf.length + jsonPad + (bin.length ? 8 + bin.length + binPad : 0);

    const out = Buffer.alloc(total);
    let p = 0;
    out.write("glTF", p, "latin1");
    p += 4;
    out.writeUInt32LE(2, p); // glTF 버전
    p += 4;
    out.writeUInt32LE(total, p);
    p += 4;
    // JSON 덩어리
    out.writeUInt32LE(jsonBuf.length + jsonPad, p);
    p += 4;
    out.write("JSON", p, "latin1");
    p += 4;
    jsonBuf.copy(out, p);
    p += jsonBuf.length;
    out.fill(0x20, p, p + jsonPad);
    p += jsonPad;
    // 바이너리 덩어리
    if (bin.length) {
        out.writeUInt32LE(bin.length + binPad, p);
        p += 4;
        out.write("BIN\0", p, "latin1");
        p += 4;
        bin.copy(out, p);
    }
    return out;
}

/**
 * 파싱한 nif 를 GLB 로 바꾼다.
 * @param {import("./nif.js").Nif} nif 파싱한 nif
 * @param {object} [options] 설정
 * @param {(fileName: string) => Buffer | null} [options.resolveTexture] 외부 텍스처를 찾아 주는 함수
 * @returns {{ glb: Buffer, warnings: string[] }} GLB 내용과 경고 (못 찾은 텍스처 등)
 * @param {boolean} [options.skipEffects] 빛과 어둡게 합성 레이어를 빼고 만든다
 * @param {object[]} [options.animations] kf.js 가 표본으로 뜬 애니메이션 목록
 */
export function nifToGLB(nif, options) {
    const builder = new Builder(nif, options);
    const glb = builder.build();
    return { glb, warnings: builder.warnings };
}

/**
 * 팩 안의 텍스처를 읽는다. nif 에 적힌 이름과 팩 안의 이름이 달라서 (FORMAT 10-2)
 * 폴더는 nif 가 있는 폴더로 고정하고, 파일 이름은 확장자를 바꿔 가며 찾는다.
 * @param {object} folder 열린 팩 폴더 (find, read 를 쓴다)
 * @param {string} dir nif 가 있는 팩 안의 폴더
 * @param {string} fileName nif 에 적힌 텍스처 이름 (작업 PC 의 전체 경로일 수도 있다)
 * @returns {Buffer | null} 파일 내용. 못 찾으면 null
 */
function readPackTexture(folder, dir, fileName) {
    const base = fileName.split(/[\\/]/).pop();
    // 확장자가 .tga, .bmp 로 적혀 있어도 팩에는 .dds 로 들어 있는 경우가 많다. 이름만 같으면 받아들인다
    const stem = base.replace(/\.[^.]*$/, "");
    for (const name of [base, `${stem}.dds`, `${stem}.tga`, `${stem}.png`]) {
        const entry = folder.find(`${dir}\\${name}`);
        if (entry) return folder.read(entry);
    }
    return null;
}

/**
 * kfm 이 적어 둔 kf 파일을 모두 읽어 애니메이션 표본으로 만든다 (FORMAT 10-1).
 * kf 하나가 깨져도 모델은 봐야 하므로, 실패한 동작은 경고로 남기고 건너뛴다.
 * @param {object} folder 열린 팩 폴더 (find, read 를 쓴다)
 * @param {string} dir kfm 이 있는 팩 안의 폴더
 * @param {Buffer} kfmBuf kfm 파일 내용
 * @param {string[]} warnings 경고를 모을 배열
 * @returns {object[]} 애니메이션 목록
 */
function readPackAnimations(folder, dir, kfmBuf, warnings) {
    const out = [];
    for (const name of kfmKfNames(kfmBuf)) {
        const entry = folder.find(`${dir}\\${name}`);
        if (!entry) {
            warnings.push(`Animation file not found in the pack: ${name}`);
            continue;
        }
        try {
            // kf 는 nif 와 같은 형식이라 같은 파서로 읽는다
            out.push(...sampleAnimations(parseNif(folder.read(entry))));
        } catch (e) {
            warnings.push(`Animation skipped (${name}): ${e.message}`);
        }
    }
    return out;
}

/**
 * 팩 안의 모델 하나를 GLB 로 바꾼다. kfm 을 주면 그 안에 적힌 nif 를 대신 쓴다 (FORMAT 10-1).
 * @param {object} folder 열린 팩 폴더 (find, read 를 쓴다)
 * @param {string} packPath 팩 안의 경로. 예: "data\\digimon\\agumon\\agumon.nif"
 * @param {object} [options] 설정. 지금은 skipEffects 하나뿐이다
 * @returns {{ glb: Buffer, warnings: string[], path: string }} GLB, 경고, 실제로 쓴 nif 경로
 */
export function convertPackModel(folder, packPath, options = {}) {
    // 팩 경로 구분자는 역슬래시다. 사용자가 / 로 적어도 받아 준다
    let target = packPath.replaceAll("/", "\\");
    const dir = target.slice(0, target.lastIndexOf("\\"));
    /** @type {object[]} kfm 이 알려 준 동작 (nif 만 주면 동작은 없다) */
    let animations = [];
    /** @type {string[]} 애니메이션을 읽다가 생긴 경고 */
    const warnings = [];
    if (/\.kfm$/i.test(target)) {
        const kfm = folder.find(target);
        if (!kfm) throw new Error(`Not found in the pack: ${target}`);
        const buf = folder.read(kfm);
        // kfm 은 모델 nif 이름을 알려 준다. nif 는 kfm 과 같은 폴더에 있다
        target = `${dir}\\${kfmNifName(buf)}`;
        if (!options.skipAnimations) animations = readPackAnimations(folder, dir, buf, warnings);
    }
    const entry = folder.find(target);
    if (!entry) throw new Error(`Not found in the pack: ${target}`);
    const result = nifToGLB(parseNif(folder.read(entry)), {
        ...options,
        animations,
        resolveTexture: (fileName) => readPackTexture(folder, dir, fileName),
    });
    return { ...result, warnings: [...warnings, ...result.warnings], path: target, animations: animations.length };
}
