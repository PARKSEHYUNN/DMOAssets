/**
 * @file nif.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-23
 */

/**
 * NIF (Gamebryo 20.3.0.9) 파서 (FORMAT 9).
 *
 * 헤더의 블록 크기 표 덕분에 모르는 블록은 건너뛸 수 있다. 그래서 모델에 필요한 블록
 * (노드, 형상, 재질, 텍스처) 만 읽고 나머지 (파티클, 컨트롤러, CsNiNode) 는 크기만큼 넘긴다.
 * 파싱한 블록은 배열 인덱스로 서로를 가리킨다 (nif 의 ref 는 블록 번호다).
 */

import { decodeDXT, decodeMasked } from "./image.js";

/** nif 파일 첫 줄 (개행 앞까지) */
export const NIF_HEADER = "Gamebryo File Format, Version 20.3.0.9";
/** 헤더 다음의 버전 u32 (FORMAT 9) */
export const NIF_VERSION = 0x14030009;

/**
 * 버퍼를 앞에서부터 읽는 커서. nif 는 정렬이 없는 연속 필드라 위치를 하나만 들고 다닌다.
 */
class Reader {
    /**
     * @param {Buffer} buf 읽을 버퍼
     * @param {number} [pos] 시작 위치
     */
    constructor(buf, pos = 0) {
        this.buf = buf;
        this.pos = pos;
    }

    /** @returns {number} u8 하나 */
    u8() {
        return this.buf[this.pos++];
    }

    /** @returns {boolean} u8 하나를 참/거짓으로 */
    bool() {
        return this.u8() !== 0;
    }

    /** @returns {number} u16 하나 */
    u16() {
        const v = this.buf.readUInt16LE(this.pos);
        this.pos += 2;
        return v;
    }

    /** @returns {number} u32 하나 */
    u32() {
        const v = this.buf.readUInt32LE(this.pos);
        this.pos += 4;
        return v;
    }

    /** @returns {number} i32 하나 */
    i32() {
        const v = this.buf.readInt32LE(this.pos);
        this.pos += 4;
        return v;
    }

    /** @returns {number} f32 하나 */
    f32() {
        const v = this.buf.readFloatLE(this.pos);
        this.pos += 4;
        return v;
    }

    /**
     * 블록 번호 (ref). -1 은 "없음" 이라 null 로 바꾼다.
     * @returns {number | null}
     */
    ref() {
        const v = this.i32();
        return v < 0 ? null : v;
    }

    /**
     * float 여러 개를 배열로 읽는다.
     * @param {number} n 개수
     * @returns {number[]}
     */
    floats(n) {
        const a = new Array(n);
        for (let i = 0; i < n; i++) a[i] = this.f32();
        return a;
    }

    /**
     * u32 여러 개를 배열로 읽는다.
     * @param {number} n 개수
     * @returns {number[]}
     */
    u32s(n) {
        const a = new Array(n);
        for (let i = 0; i < n; i++) a[i] = this.u32();
        return a;
    }

    /**
     * ref 여러 개를 배열로 읽는다.
     * @param {number} n 개수
     * @returns {(number | null)[]}
     */
    refs(n) {
        const a = new Array(n);
        for (let i = 0; i < n; i++) a[i] = this.ref();
        return a;
    }

    /**
     * 길이가 앞에 붙은 문자열 (u32 길이 + 바이트) 을 읽는다. 헤더의 타입/문자열 표에 쓴다.
     * @returns {string}
     */
    sized() {
        const n = this.u32();
        const s = this.buf.toString("latin1", this.pos, this.pos + n);
        this.pos += n;
        return s;
    }

    /**
     * 바이트를 그대로 잘라 온다 (복사 없음).
     * @param {number} n 바이트 수
     * @returns {Buffer}
     */
    bytes(n) {
        const b = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return b;
    }
}

/**
 * 문자열 표에서 이름을 꺼낸다. nif 의 이름 필드는 문자열 번호 (u32) 이고 -1 은 이름 없음이다.
 * @param {Reader} r 커서
 * @param {string[]} strings 헤더의 문자열 표
 * @returns {string | null}
 */
function nameOf(r, strings) {
    const i = r.i32();
    return i < 0 ? null : (strings[i] ?? null);
}

/**
 * NiObjectNET 부분을 읽는다: 이름, 추가 데이터 목록, 컨트롤러.
 * NiAVObject, 속성 (NiMaterialProperty 등), NiSourceTexture 가 모두 이 앞부분을 공유한다.
 * @param {Reader} r 커서
 * @param {string[]} strings 문자열 표
 * @returns {{ name: string | null, extraData: (number | null)[], controller: number | null }}
 */
function readObjectNET(r, strings) {
    const name = nameOf(r, strings);
    // 추가 데이터 (NiStringExtraData 등) 목록. 모델 변환에는 쓰지 않지만 위치를 넘겨야 한다
    const extraData = r.refs(r.u32());
    const controller = r.ref();
    return { name, extraData, controller };
}

/**
 * NiAVObject 부분을 읽는다: NiObjectNET + 변환 + 속성 목록.
 * 회전은 3x3 행렬 9개를 행 순서 (m11 m12 m13 m21 ...) 로 저장한다.
 * @param {Reader} r 커서
 * @param {string[]} strings 문자열 표
 * @returns {object} NiAVObject 공통 필드
 */
function readAVObject(r, strings) {
    const o = readObjectNET(r, strings);
    // 플래그는 u16 이다 (숨김 비트 0x1 등). 20.3.0.9 에서 u32 가 아니다
    const flags = r.u16();
    const translation = r.floats(3);
    const rotation = r.floats(9);
    const scale = r.f32();
    // 속성 (재질, 텍스처, 알파 등) 목록
    const properties = r.refs(r.u32());
    const collisionObject = r.ref();
    return { ...o, flags, translation, rotation, scale, properties, collisionObject };
}

/**
 * NiNode / NiBillboardNode 를 읽는다. NiAVObject 뒤에 자식과 이펙트 목록이 붙는다.
 * @param {Reader} r 커서
 * @param {string[]} strings 문자열 표
 * @param {boolean} billboard NiBillboardNode 면 끝에 u16 이 하나 더 있다
 * @returns {object}
 */
function readNode(r, strings, billboard) {
    const o = readAVObject(r, strings);
    const children = r.refs(r.u32());
    const effects = r.refs(r.u32());
    if (billboard) r.u16();
    return { ...o, children, effects };
}

/**
 * NiTriShape / NiTriStrips 를 읽는다 (NiGeometry).
 * 실제 정점은 data 가 가리키는 NiTriShapeData / NiTriStripsData 에 있다.
 * @param {Reader} r 커서
 * @param {string[]} strings 문자열 표
 * @returns {object}
 */
function readGeometry(r, strings) {
    const o = readAVObject(r, strings);
    const data = r.ref();
    const skinInstance = r.ref();
    // MaterialData: 재질 이름 목록과 "지금 쓰는 재질" 번호. 우리는 속성 목록만 쓰므로 넘긴다
    const numMaterials = r.u32();
    for (let i = 0; i < numMaterials; i++) r.i32(); // 재질 이름 (문자열 번호)
    for (let i = 0; i < numMaterials; i++) r.i32(); // 재질 추가 데이터
    r.i32(); // activeMaterial
    r.u8(); // materialNeedsUpdate
    return { ...o, data, skinInstance };
}

/**
 * NiTransform 하나를 읽는다 (스킨 블록에서 쓴다).
 * NiAVObject 와 달리 회전이 먼저 온다: 회전 9f -> 이동 3f -> 배율 1f (FORMAT 9-1).
 * @param {Reader} r 커서
 * @returns {{ rotation: number[], translation: number[], scale: number }}
 */
function readTransform(r) {
    const rotation = r.floats(9);
    const translation = r.floats(3);
    const scale = r.f32();
    return { rotation, translation, scale };
}

/**
 * NiSkinInstance 를 읽는다. 이 메시를 움직이는 뼈 목록이 들어 있다.
 * NiObjectNET 을 거치지 않고 바로 시작한다.
 * @param {Reader} r 커서
 * @returns {object}
 */
function readSkinInstance(r) {
    const data = r.ref();
    const skinPartition = r.ref();
    const skeletonRoot = r.ref();
    // 뼈 순서가 NiSkinData 의 뼈 순서와 같다
    const bones = r.refs(r.u32());
    return { data, skinPartition, skeletonRoot, bones };
}

/**
 * NiSkinData 를 읽는다. 뼈마다 바인드 변환과 정점 가중치가 들어 있다.
 * @param {Reader} r 커서
 * @returns {object}
 */
function readSkinData(r) {
    // 메시 전체에 걸리는 변환. 뼈 변환과 함께 쓰면 바인드 자세가 나온다 (FORMAT 9-2)
    const transform = readTransform(r);
    const numBones = r.u32();
    const hasWeights = r.bool();
    const bones = [];
    for (let i = 0; i < numBones; i ++) {
        const boneTransform = readTransform(r);
        r.floats(4); // 뼈가 움직이는 범위의 바운딩 구 (안 쓴다)
        const weights = [];
        if (hasWeights) {
            // 이 뼈가 움직이는 정점 번호와 가중치
            const count = r.u16();
            for (let v = 0; v < count; v ++) weights.push({ vertex: r.u16(), weight: r.f32() });
        }
        bones.push({ transform: boneTransform, weights });
    }
    return { transform, bones };
}

/**
 * NiGeometryData 공통 부분 (정점, 법선, 색, UV) 을 읽는다.
 * @param {Reader} r 커서
 * @returns {object}
 */
function readGeometryData(r) {
    r.i32(); // groupID
    const numVertices = r.u16();
    r.u8(); // keepFlags
    r.u8(); // compressFlags
    // 정점: 있으면 numVertices * 3 float
    const vertices = r.bool() ? r.floats(numVertices * 3) : null;
    // vectorFlags: 하위 6비트가 UV 세트 수, 0x1000 이 서면 탄젠트/바이탄젠트가 법선 뒤에 붙는다
    const vectorFlags = r.u16();
    const hasNormals = r.bool();
    const normals = hasNormals ? r.floats(numVertices * 3) : null;
    if (hasNormals && vectorFlags & 0x1000) {
        r.floats(numVertices * 3); // 탄젠트
        r.floats(numVertices * 3); // 바이탄젠트
    }
    r.floats(4); // 바운딩 구 (중심 3 + 반지름 1)
    const colors = r.bool() ? r.floats(numVertices * 4) : null;
    // UV 세트: 세트마다 정점당 (u, v)
    const uvCount = vectorFlags & 0x3f;
    const uvSets = [];
    for (let i = 0; i < uvCount; i++) uvSets.push(r.floats(numVertices * 2));
    r.u16(); // consistencyFlags
    r.ref(); // additionalData
    return { numVertices, vertices, normals, colors, uvSets };
}

/**
 * 삼각형 목록을 가진 NiTriShapeData 를 읽는다.
 * @param {Reader} r 커서
 * @returns {object}
 */
function readTriShapeData(r) {
    const o = readGeometryData(r);
    const numTriangles = r.u16();
    r.u32(); // numTrianglePoints (numTriangles * 3)
    const triangles = [];
    if (r.bool()) {
        for (let i = 0; i < numTriangles * 3; i++) triangles.push(r.u16());
    }
    // 같은 자리에 있는 정점끼리 묶은 표 (법선을 부드럽게 할 때 쓰는 힌트다). 건너뛴다
    const numMatchGroups = r.u16();
    for (let i = 0; i < numMatchGroups; i++) {
        const n = r.u16();
        for (let j = 0; j < n; j++) r.u16();
    }
    return { ...o, triangles };
}

/**
 * 스트립을 가진 NiTriStripsData 를 읽고, 그 자리에서 삼각형 목록으로 바꾼다.
 * 스트립은 정점을 이어 붙인 형식이라 한 칸씩 밀면서 삼각형을 만든다 (홀수 번째는 감는 방향이 뒤집힌다).
 * @param {Reader} r 커서
 * @returns {object}
 */
function readTriStripsData(r) {
    const o = readGeometryData(r);
    r.u16(); // numTriangles (스트립에서 다시 세므로 쓰지 않는다)
    const numStrips = r.u16();
    const lengths = [];
    for (let i = 0; i < numStrips; i++) lengths.push(r.u16());
    const triangles = [];
    if (r.bool()) {
        for (const len of lengths) {
            const strip = new Array(len);
            for (let i = 0; i < len; i++) strip[i] = r.u16();
            for (let i = 0; i + 2 < len; i++) {
                const [a, b, c] = i & 1 ? [strip[i + 1], strip[i], strip[i + 2]] : [strip[i], strip[i + 1], strip[i + 2]];
                // 같은 번호가 겹친 삼각형은 스트립을 잇는 용도라 넓이가 0 이다. 버린다
                if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
            }
        }
    }
    return { ...o, triangles };
}

/**
 * NiMaterialProperty 를 읽는다 (색과 불투명도).
 * @param {Reader} r 커서
 * @param {string[]} strings 문자열 표
 * @returns {object}
 */
function readMaterial(r, strings) {
    const o = readObjectNET(r, strings);
    const ambient = r.floats(3);
    const diffuse = r.floats(3);
    const specular = r.floats(3);
    const emissive = r.floats(3);
    const glossiness = r.f32();
    const alpha = r.f32();
    return { ...o, ambient, diffuse, specular, emissive, glossiness, alpha };
}

/**
 * TexDesc (텍스처 한 장의 연결 정보) 를 읽는다.
 * @param {Reader} r 커서
 * @returns {{ source: number | null }}
 */
function readTexDesc(r) {
    const source = r.ref();
    r.u16(); // 필터/클램프 플래그
    // UV 변환이 있으면 이동 2, 배율 2, 회전 1, 변환 방식 1, 중심 2 가 더 붙는다
    if (r.bool()) {
        r.floats(5);
        r.u32();
        r.floats(2);
    }
    return { source };
}

/**
 * NiTexturingProperty 에서 base 텍스처만 읽는다. 뒤쪽 (dark, detail, glow 등) 은 쓰지 않는다.
 * @param {Reader} r 커서
 * @param {string[]} strings 문자열 표
 * @returns {object}
 */
function readTexturing(r, strings) {
    const o = readObjectNET(r, strings);
    r.u16(); // apply mode 플래그
    r.u32(); // 텍스처 칸 수 (보통 7 또는 9)
    const base = r.bool() ? readTexDesc(r) : null;
    return { ...o, base };
}

/**
 * NiAlphaProperty 를 읽는다. flags 의 비트로 블렌딩/알파 테스트 여부가 정해진다.
 * @param {Reader} r 커서
 * @param {string[]} strings 문자열 표
 * @returns {object}
 */
function readAlpha(r, strings) {
    const o = readObjectNET(r, strings);
    const flags = r.u16();
    const threshold = r.u8();
    return { ...o, flags, threshold };
}

/**
 * NiSourceTexture 를 읽는다. 팩 안의 텍스처는 대부분 내장 (pixelData) 이고,
 * 외부 파일이면 fileName 이 원래 작업 파일 이름이다 (FORMAT 10-2).
 * @param {Reader} r 커서
 * @param {string[]} strings 문자열 표
 * @returns {object}
 */
function readSourceTexture(r, strings) {
    const o = readObjectNET(r, strings);
    const useExternal = r.bool();
    const fileName = nameOf(r, strings);
    const pixelData = r.ref();
    r.u32(); // pixelLayout
    r.u32(); // useMipmaps
    r.u32(); // alphaFormat
    r.u8(); // isStatic
    r.u8(); // directRender
    r.u8(); // persistRenderData
    return { ...o, useExternal, fileName, pixelData };
}

/**
 * NiPixelData / NiPersistentSrcTextureRendererData 의 공통 앞부분 (ATextureRenderData).
 * @param {Reader} r 커서
 * @returns {object}
 */
function readTextureRenderData(r) {
    // FORMAT 9: 첫 u32 가 픽셀 형식 (0 RGB, 1 RGBA, 2 PAL, 3 PALA, 4 DXT1, 5 DXT3, 6 DXT5)
    const pixelFormat = r.u32();
    r.u8(); // bitsPerPixel
    r.i32(); // rendererHint
    r.u32(); // extraData
    r.u8(); // flags
    r.u32(); // tiling
    r.u8(); // sRGB 여부
    // 채널 4개: 무슨 채널인지 (0 R, 1 G, 2 B, 3 A), 저장 방식, 비트 수, 부호
    const channels = [];
    for (let i = 0; i < 4; i++) {
        const type = r.u32();
        const convention = r.u32();
        const bits = r.u8();
        const signed = r.u8();
        channels.push({ type, convention, bits, signed });
    }
    const palette = r.ref();
    const numMipmaps = r.u32();
    r.u32(); // bytesPerPixel
    // 밉맵 표: 단계마다 가로, 세로, 픽셀 데이터 안에서의 시작 위치
    const mipmaps = [];
    for (let i = 0; i < numMipmaps; i++) mipmaps.push({ width: r.u32(), height: r.u32(), offset: r.u32() });
    return { pixelFormat, channels, palette, mipmaps };
}

/**
 * NiPersistentSrcTextureRendererData 를 읽는다 (내장 텍스처, FORMAT 9).
 * @param {Reader} r 커서
 * @returns {object}
 */
function readPersistentTexture(r) {
    const o = readTextureRenderData(r);
    const numPixels = r.u32();
    r.u32(); // padNumPixels
    const numFaces = r.u32();
    r.u32(); // platform
    // 면 (큐브맵이면 6개) 마다 밉맵 전부가 이어져 있다. 첫 면만 쓴다
    const pixels = r.bytes(numPixels * numFaces);
    return { ...o, pixels };
}

/**
 * NiPixelData 를 읽는다 (내장 텍스처의 옛 형식).
 * @param {Reader} r 커서
 * @returns {object}
 */
function readPixelData(r) {
    const o = readTextureRenderData(r);
    const numPixels = r.u32();
    const numFaces = r.u32();
    const pixels = r.bytes(numPixels * numFaces);
    return { ...o, pixels };
}

/**
 * NiPalette 를 읽는다 (팔레트 텍스처용 색표).
 * @param {Reader} r 커서
 * @returns {object}
 */
function readPalette(r) {
    // NiPalette 은 NiObjectNET 을 거치지 않는다. 바로 알파 여부와 색 개수가 온다
    r.u8(); // hasAlpha
    const count = r.u32();
    // 색은 R, G, B, A 한 바이트씩
    const colors = r.bytes(count * 4);
    return { colors };
}

/** 블록 종류별 읽기 함수. 여기 없는 종류는 크기만큼 건너뛴다 */
const READERS = {
    NiNode: (r, s) => readNode(r, s, false),
    NiBillboardNode: (r, s) => readNode(r, s, true),
    NiTriShape: readGeometry,
    NiTriStrips: readGeometry,
    NiTriShapeData: readTriShapeData,
    NiTriStripsData: readTriStripsData,
    NiSkinInstance: readSkinInstance,
    NiSkinData: readSkinData,
    NiMaterialProperty: readMaterial,
    NiTexturingProperty: readTexturing,
    NiAlphaProperty: readAlpha,
    NiSourceTexture: readSourceTexture,
    NiPersistentSrcTextureRendererData: readPersistentTexture,
    NiPixelData: readPixelData,
    NiPalette: readPalette,
};

/** 앞부분만 읽고 나머지는 건너뛰는 블록 종류 (읽은 길이 검사에서 뺀다) */
const PARTIAL = new Set(["NiTexturingProperty"]);

/**
 * @typedef {object} Nif 파싱한 nif
 * @property {string[]} strings 헤더 문자열 표
 * @property {object[]} blocks 블록 목록 (번호가 ref 값이다). 안 읽은 블록은 `{ type }` 만 들어 있다
 * @property {number[]} roots 뿌리 블록 번호
 */

/**
 * nif 파일을 파싱한다 (FORMAT 9).
 * 헤더 -> 블록 크기 표 -> 문자열 표 -> 블록들 -> footer 순서다.
 * 블록은 크기 표대로 자리를 잡으므로, 읽기 함수가 있는 종류만 해석하고 나머지는 건너뛴다.
 * @param {Buffer} buf nif 파일 전체
 * @returns {Nif}
 */
export function parseNif(buf) {
    // 헤더 문자열은 개행으로 끝난다
    const nl = buf.indexOf(0x0a);
    if (nl < 0 || buf.toString("latin1", 0, nl) !== NIF_HEADER) throw new Error("Not a NIF 20.3.0.9 file");
    const r = new Reader(buf, nl + 1);
    const version = r.u32();
    if (version !== NIF_VERSION) throw new Error(`Unsupported NIF version 0x${version.toString(16)}`);
    // 엔디안 바이트: 1 이 리틀엔디안. 팩에 빅엔디안 파일이 하나 있다 (FORMAT 9)
    if (r.u8() !== 1) throw new Error("Big-endian NIF is not supported");
    r.u32(); // user version

    const numBlocks = r.u32();
    // 블록 종류 이름 표와, 블록마다의 종류 번호 (최상위 비트는 버린다)
    const numTypes = r.u16();
    const types = [];
    for (let i = 0; i < numTypes; i++) types.push(r.sized());
    const typeIndex = [];
    for (let i = 0; i < numBlocks; i++) typeIndex.push(r.u16() & 0x7fff);
    // 블록 크기 표. 이것 덕분에 모르는 블록을 건너뛸 수 있다
    const sizes = r.u32s(numBlocks);
    // 문자열 표 (이름, 파일 이름 등이 전부 여기 있다)
    const numStrings = r.u32();
    r.u32(); // maxStringLength
    const strings = [];
    for (let i = 0; i < numStrings; i++) strings.push(r.sized());
    // 그룹 (안 쓴다)
    const numGroups = r.u32();
    r.u32s(numGroups);

    const blocks = new Array(numBlocks);
    for (let i = 0; i < numBlocks; i++) {
        const type = types[typeIndex[i]];
        const start = r.pos;
        const read = READERS[type];
        blocks[i] = read ? { type, ...read(r, strings) } : { type };
        // 읽은 양이 크기 표와 다르면 해석이 틀린 것이다. 조용히 밀리면 안 되므로 확인한다
        if (read && r.pos - start !== sizes[i] && !PARTIAL.has(type)) {
            throw new Error(`Block ${i} ${type}: read ${r.pos - start} of ${sizes[i]} bytes`);
        }
        // 다음 블록 자리로 옮긴다 (일부만 읽는 종류가 있다)
        r.pos = start + sizes[i];
    }

    // footer: 뿌리 블록 번호
    const roots = r.u32s(r.u32());
    return { strings, blocks, roots };
}

/**
 * 내장 텍스처 블록의 픽셀을 RGBA 이미지로 바꾼다 (밉맵 0단계만).
 * @param {object} block NiPersistentSrcTextureRendererData 또는 NiPixelData
 * @param {object} [palette] 팔레트 블록 (형식 2, 3 일 때 필요)
 * @returns {import("./image.js").Image}
 */
export function decodePixelData(block, palette) {
    const mip = block.mipmaps[0];
    if (!mip) throw new Error("Embedded texture has no mipmap");
    const { width, height } = mip;
    const data = block.pixels.subarray(mip.offset);

    // 압축 형식은 image.js 의 DXT 디코더를 그대로 쓴다
    if (block.pixelFormat === 4) return decodeDXT(data, width, height, 1);
    if (block.pixelFormat === 5) return decodeDXT(data, width, height, 3);
    if (block.pixelFormat === 6) return decodeDXT(data, width, height, 5);

    // 팔레트 형식: 픽셀 하나가 색표의 번호다
    if (block.pixelFormat === 2 || block.pixelFormat === 3) {
        if (!palette) throw new Error("Palette texture without NiPalette");
        const out = Buffer.alloc(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            // 팔레트 색은 R, G, B, A 순서로 4바이트씩 들어 있다
            palette.colors.copy(out, i * 4, data[i] * 4, data[i] * 4 + 4);
        }
        return { width, height, data: out };
    }

    // 비압축: 채널 표에서 마스크를 만들어 image.js 에 넘긴다
    const masks = { r: 0, g: 0, b: 0, a: 0 };
    let shift = 0;
    for (const ch of block.channels) {
        if (ch.bits === 0) continue;
        const mask = ((1 << ch.bits) - 1) * 2 ** shift;
        // 채널 번호: 0 R, 1 G, 2 B, 3 A
        if (ch.type === 0) masks.r = mask;
        else if (ch.type === 1) masks.g = mask;
        else if (ch.type === 2) masks.b = mask;
        else if (ch.type === 3) masks.a = mask;
        shift += ch.bits;
    }
    const bpp = shift;
    if (!bpp) throw new Error(`Unsupported embedded pixel format ${block.pixelFormat}`);
    return decodeMasked(data, width, height, bpp, masks);
}

/**
 * kfm 파일에서 모델 nif 이름을 꺼낸다 (FORMAT 10-1).
 * kfm 은 텍스트와 바이너리가 섞인 형식이라, 4자 이상 인쇄 가능한 ASCII 만 뽑으면 첫 .nif 가 모델이다.
 * @param {Buffer} buf kfm 파일 전체
 * @returns {string} nif 파일 이름 (kfm 과 같은 폴더에 있다)
 */
export function kfmNifName(buf) {
    // 인쇄 가능한 글자가 4개 이상 이어진 곳만 문자열로 본다
    const found = buf.toString("latin1").match(/[\x20-\x7e]{4,}/g) ?? [];
    const hit = found.find((s) => /\.nif$/i.test(s));
    if (!hit) throw new Error("No .nif name found in this KFM file");
    // ".\name.nif" 처럼 kfm 폴더 기준 경로로 적혀 있다. 폴더 표시를 떼고 파일 이름만 쓴다
    return hit.split(/[\\/]/).pop();
}
