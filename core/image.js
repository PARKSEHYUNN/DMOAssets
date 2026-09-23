/**
 * @file image.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-23
 */

/**
 * 이미지 디코더와 PNG 인코더 (FORMAT 6-5, 9).
 * 
 * 팩 안의 텍스처는 DDS (대부분 DXT1/3/5) 와 TGA 다. 브라우저가 못 여는 형식이라 직접 RGBA 로 푼다.
 * NIF 내장 텍스처 (FORMAT 9) 도 같은 DXT 디코더와 마스크 변환을 쓴다.
 */

import zlib from "node:zlib";

/**
 * @typedef {object} Image   푼 이미지 (RGBA 8비트, 위에서 아래로)
 * @property {number} width  가로 픽셀 수
 * @property {number} height 세로 픽셀 수
 * @property {Buffer} data   width * height * 4 바이트 (R, G, B, A 순서)
 */

/**
 * 빈 RGBA 이미지를 만든다.
 * @param {number} width 가로
 * @param {number} height 세로
 * @returns {Image}
 */
function newImage(width, height) {
    if (!(width > 0 && height > 0 && width <= 16384 && height <= 16384)) {
        throw new Error(`Bad image size ${width}x${height}`);
    }
    return { width, height, data: Buffer.alloc(width * height * 4) };
}

/**
 * RGB565 한 값을 R, G, B 바이트로 푼다.
 * 5비트와 6비트 값을 8비트로 늘릴 때는 상위 비트를 아래로 복사해 0~255 전체 범위를 쓰게 한다.
 * @param {number} c u16 색
 * @returns {[number, number, number]} R, G, B
 */
function rgb565(c) {
    const r = (c >> 11) & 0x1f;
    const g = (c >> 5) & 0x3f;
    const b = c & 0x1f;
    return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/**
 * DXT (BC1/BC2/BC3) 로 압축된 데이터를 RGBA 로 푼다.
 * 블록은 4x4 픽셀이고, 가로/세로가 4의 배수가 아니면 마지막 블록에 남는 픽셀은 버린다.
 * @param {Buffer} src 압축 데이터 (밉맵 0단계만)
 * @param {number} width 가로
 * @param {number} height 세로
 * @param {1|3|5} format DXT 번호 (1 = BC1, 3 = BC2, 5 = BC3)
 * @returns {Image}
 */
export function decodeDXT(src, width, height, format) {
    const img = newImage(width, height);
    const out = img.data;
    // DXT1 은 블록당 8바이트, DXT3/5는 알파 8바이트가 앞에 붙어 16바이트
    const blockSize = format === 1 ? 8 : 16;
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    if (src.length < bw * bh * blockSize) {
        throw new Error(`DXT${format} data too short: ${src.length} < ${bw * bh * blockSize}`);
    }

    // 블록 하나 풀 때 쓰는 임시 배열 (색 4개 x RGB, 픽셀 16개의 알파)
    const color = [0, 0, 0, 0].map(() => [0, 0, 0]);
    const alpha = new Uint8Array(16);

    for (let by = 0; by < bh; by ++) {
        for (let bx = 0; bx < bw; bx ++) {
            let o = (by * bw + bx) * blockSize;

            // 알파 블록 먼저 (DXT3, DXT5)
            if (format === 3) {
                // DXT3: 픽셀마다 4비트 알파. 4비트를 8비트로 늘린다 (0xF -> 0xFF)
                for (let i = 0; i < 16; i += 2) {
                    const b = src[o + (i >> 1)];
                    alpha[i] = (b & 0x0f) * 17;
                    alpha[i + 1] = (b >> 4) * 17;
                }
                o += 8;
            } else if (format === 5) {
                // DXT5: 알파 끝점 2개 + 3비트 인덱스 16개 (6바이트)
                const a0 = src[o];
                const a1 = src[o + 1];
                const lut = [a0, a1];
                if (a0 > a1) {
                    // 6개 중간값 (보간)
                    for (let i = 1; i <= 6; i ++) lut.push(Math.round((a0 * (8 - i) + a1 * i) / 7));
                } else {
                    // 4개 중간값 + 완전 투명 (0) + 완전 불투명 (255)
                    for (let i = 1; i <= 4; i ++) lut.push(Math.round((a0 * (6 - i) + a1 * i) / 5));
                    lut.push(0, 255);
                }
                // 인덱스 6바이트를 48비트 정수로 읽어 3비트씩 꺼낸다 (2^48 은 float64 로 정확히 다룰 수 있다)
                const bits = src.readUIntLE(o + 2, 6);
                for (let i = 0; i < 16; i ++) alpha[i] = lut[Math.floor(bits / 2 ** (3 * i)) & 7];
                o += 8;
            } else {
                // DXT1: 알파 없음 (색 블록에서 투명 픽셀만 따로 처리한다)
                alpha.fill(255);
            }

            // 색 블록: 끝점 2개 (RGB565) + 2비트 인덱스 16개
            const c0 = src.readUInt16LE(o);
            const c1 = src.readUInt16LE(o + 2);
            const [r0, g0, b0] = rgb565(c0);
            const [r1, g1, b1] = rgb565(c1);
            color[0] = [r0, g0, b0];
            color[1] = [r1, g1, b1];
            // DXT1 에서 c0 <= c1 이면 3색 + 투명 모드. DT3/5 는 항상 4색 모드다
            const punchThrough = format === 1 && c0 <= c1;
            if (punchThrough) {
                color[2] = [(r0 + r1) >> 1, (g0 + g1) >> 1, (b0 + b1) >> 1];
                color[3] = [0, 0, 0];
            } else {
                color[2] = [Math.round((2 * r0 + r1) / 3), Math.round((2 * g0 + g1) / 3), Math.round((2 * b0 + b1) / 3)];
                color[3] = [Math.round((r0 + 2 * r1) / 3), Math.round((g0 + 2 * g1) / 3), Math.round((b0 + 2 * b1) / 3)];
            }
            const idx = src.readUInt32LE(o + 4);

            // 블록 안 16픽셀을 이미지에 쓴다 (가장자리 블록은 이미지 밖 픽셀을 건너뛴다)
            for (let i = 0; i < 16; i ++) {
                const x = bx * 4 + (i & 3);
                const y = by * 4 + (i >> 2);
                if (x >= width || y >= height) continue;
                const sel = (idx >> (2 * i)) & 3;
                const [r, g, b] = color[sel];
                const p = (y * width + x) * 4;
                out[p] = r;
                out[p + 1] = g;
                out[p + 2] = b;
                // 3색 모드의 인덱스 3 은 완전 투명이다
                out[p + 3] = punchThrough && sel === 3 ? 0 : alpha[i];
            }
        }
    }
    return img;
}

/**
 * 비트 마스크 하나에서 시작 비트와 비트 수를 구한다.
 * @param {number} mask 채널 마스크. 예: 0x00ff0000
 * @returns {{ shift: number, bits: number }}
 */
function maskInfo(mask) {
    if (!mask) return { shift: 0, bits: 0 };
    let shift = 0;
    while (!((mask >>> shift) & 1)) shift++;
    let bits = 0;
    while ((mask >>> (shift + bits)) & 1) bits++;
    return { shift, bits };
}

/**
 * 채널 값을 8비트로 늘린다 (5비트 0x1F -> 255 처럼 최대값이 255가 되게)
 * @param {number} v 채널 값
 * @param {number} bits 채널 비트 수
 * @returns {number} 0~255
 */
function scaleTo8(v, bits) {
    if (bits === 8) return v;
    if (bits === 0) return 255;
    return Math.round((v * 255) / ((1 << bits) - 1));
}

/**
 * 마스크로 표현된 비압축 픽셀 데이터를 RGBA 로 바꾼다 (DDS 비압축, TGA 16비트 등에 쓴다)
 * @param {Buffer} src 픽셀 데이터
 * @param {number} width 가로
 * @param {number} height 세로
 * @param {number} bpp 픽셀당 비트 수 (8, 16, 24, 32)
 * @param {{r: number, g: number, b: number, a: number}} masks 채널 마스크
 * @returns {Image}
 */
export function decodeMasked(src, width, height, bpp, masks) {
    const img = newImage(width, height);
    const out = img.data;
    const bytes = bpp / 8;
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > 4) throw new Error(`Unsupported bit depth ${bpp}`);
    if (src.length < width * height * bytes) throw new Error(`Pixel data too short: ${src.length}`);
    // 채널마다 시작 비트와 비트 수를 미리 구해 둔다
    const ch = [masks.r, masks.g, masks.b, masks.a].map(maskInfo);

    for (let i = 0; i < width * height; i ++) {
        // 픽셀 하나를 정수로 읽는다 (리틀엔디안)
        const px = src.readUIntLE(i * bytes, bytes);
        const p = i * 4;
        for (let c = 0; c < 4; c ++) {
            const { shift, bits } = ch[c];
            // 마스크가 없는 채널은 255 (알파가 없으면 불투명)
            out[p + c] = bits === 0 ? (c === 3 ? 255 : 0) : scaleTo8((px >>> shift) & ((1 << bits) - 1), bits);
        }
    }
    return img;
}

/**
 * DDS 파일을 푼다. 밉맵은 0단계 (원본 크기) 만 쓴다.
 * DX1/3/5 와 마스크가 있는 비압축 형식을 지원한다. DX10 확장 헤더 (BC7 등) 는 지원하지 않는다.
 * @param {Buffer} buf DOS 파일 전체
 * @returns {Image}
 */
export function decodeDDS(buf) {
    // 헤더: "DDS" + 124 B. +12 height, +16 width, +76 부터 픽셀 형식
    if (buf.length < 128 || buf.toString("latin1", 0, 4) !== "DDS ") throw new Error("Not a DDS file");
    const height = buf.readUInt32LE(12);
    const width = buf.readUInt32LE(16);
    const pfFlags = buf.readUInt32LE(80);
    const fourCC = buf.toString("latin1", 84, 88);
    const data = buf.subarray(128);

    // pfFlags  의 0x4 (FOURCC) 가 서 있으면 압축 형식이다
    if (pfFlags & 0x4) {
        if (fourCC === "DXT1") return decodeDXT(data, width, height, 1);
        if (fourCC === "DXT3") return decodeDXT(data, width, height, 3);
        if (fourCC === "DXT5") return decodeDXT(data, width, height, 5);
        // DX10 헤더는 뒤에 20바이트가 더 있고 DXGI 번호로 형식을 정한다 (팩에 2개뿐이고 BC7 이라 건너뛴다)
        if (fourCC === "DX10") throw new Error(`Unsupported DDS format DX10 (DXGI ${buf.readUInt32LE(128)})`);
        throw new Error(`Unsupported DDS fourCC ${JSON.stringify(fourCC)}`);
    }

    // 비압축: 픽셀당 비트 수와 채널 마스크가 헤더에 있다
    const bpp = buf.readUInt32LE(88);
    const masks = { r: buf.readUInt32LE(92), g: buf.readUInt32LE(96), b: buf.readUInt32LE(100), a: buf.readUInt32LE(104) };
    return decodeMasked(data, width, height, bpp, masks);
}

/**
 * TGA 파일을 푼다.
 * 지원: 타입 1 (팔레트), 2 (비압축 트루컬러), 3 (흑백), 9/10/11 (같은 형식의 RLE 압축).
 * @param {Buffer} buf TGA 파일 전체
 * @returns {Image}
 */
export function decodeTGA(buf) {
    if (buf.length < 18) throw new Error("Not a TGA file");
    // 헤더 18 B: +0 id 길이, +1 팔레트 여부, +2 타입, +3 팔레트 시작, +5 팔레트 개수,
    // +7 팔레트 한 칸 비트 수, +12 가로, +14 세로, +16 픽셀 비트 수, +17 서술 바이트
    const idLength = buf[0];
    const hasMap = buf[1] === 1;
    const type = buf[2];
    const mapFirst = buf.readUInt16LE(3);
    const mapCount = buf.readUInt16LE(5);
    const mapBits = buf[7];
    const width = buf.readUInt16LE(12);
    const height = buf.readUInt16LE(14);
    const bpp = buf[16];
    const descriptor = buf[17];
    // 비트가 5 가 서 있으면 첫 줄이 위쪽 줄이다. 꺼져 있으면 아래에서 위로 저장된 것이라 뒤집어야 한다
    const topDown = (descriptor & 0x20) !== 0;

    const rle = type >= 9 && type <= 11;
    const base = type % 8; // 9 -> 1, 10 -> 2, 11 -> 3
    if (![1, 2, 3].includes(base)) throw new Error(`Unsupported TGA type ${type}`);

    let o = 18 + idLength;
    // 팔레트를 RGBA 로 미리 풀어 둔다
    let palette = null;
    if (hasMap) {
        const entryBytes = mapBits / 8;
        palette = decodeMasked(buf.subarray(o, o + mapCount * entryBytes), mapCount, 1, mapBits, tgaMasks(mapBits));
        o += mapCount * entryBytes;
    }

    const pixelBytes = bpp / 8;
    if (!Number.isInteger(pixelBytes) || pixelBytes < 1 || pixelBytes > 4) throw new Error(`Unsupported TGA depth ${bpp}`);

    // 픽셀 데이터를 (필요하면 RLE 를 풀어) 연속된 바이트로 만든다
    let pixels;
    if (rle) {
        pixels = Buffer.alloc(width * height * pixelBytes);
        let w = 0;
        while (w < pixels.length && o < buf.length) {
            const header = buf[o++];
            const count = (header & 0x7f) + 1;
            if (header & 0x80) {
                // 압축 묶음: 픽셀 하나를 count 번 반복한다
                for (let i = 0; i < count && w < pixels.length; i++, w += pixelBytes) {
                    buf.copy(pixels, w, o, o + pixelBytes);
                }
                o += pixelBytes;
            } else {
                // 생 묶음: 픽셀 count 개가 그대로 들어 있다
                const n = Math.min(count * pixelBytes, pixels.length - w);
                buf.copy(pixels, w, o, o + n);
                w += n;
                o += count * pixelBytes;
            }
        }
    } else {
        pixels = buf.subarray(o, o + width * height * pixelBytes);
    }

    // 픽셀을 RGBA 로 바꾼다
    let img;
    if (base === 1) {
        // 팔레트: 픽셀 값이 팔레트 번호다
        img = newImage(width, height);
        for (let i = 0; i < width * height; i++) {
            const e = (pixels.readUIntLE(i * pixelBytes, pixelBytes) - mapFirst) * 4;
            palette.data.copy(img.data, i * 4, e, e + 4);
        }
    } else if (base === 3) {
        // 흑백: 한 값을 R, G, B 에 그대로 넣는다
        img = newImage(width, height);
        for (let i = 0; i < width * height; i++) {
            const v = pixels[i * pixelBytes];
            img.data.set([v, v, v, 255], i * 4);
        }
    } else {
        img = decodeMasked(pixels, width, height, bpp, tgaMasks(bpp));
    }

    // 아래에서 위로 저장된 이미지는 줄 순서를 뒤집는다
    if (!topDown) flipVertical(img);
    return img;
}

/**
 * TGA 트루컬러 채널 마스크 (BGRA 순서로 저장된다).
 * @param {number} bpp 픽셀 비트 수 (16, 24, 32)
 * @returns {{r: number, g: number, b: number, a: number}}
 */
function tgaMasks(bpp) {
    // 16비트는 X1R5G5B5. 최상위 비트는 알파로 쓰이지만 팩 안에 232개 파일 모두 이 비트가 0이다.
    // 알파로 쓰면 이미지 전체가 투명해지므로 무시하고 불투명으로 둔다
    if (bpp === 16) return { r: 0x7c00, g: 0x03e0, b: 0x001f, a: 0 };
    if (bpp === 24) return { r: 0xff0000, g: 0x00ff00, b: 0x0000ff, a: 0 };
    if (bpp === 32) return { r: 0x00ff0000, g: 0x0000ff00, b: 0x000000ff, a: 0xff000000 };
    throw new Error(`Unsupported TGA depth ${bpp}`);
}

/**
 * 이미지의 줄 순서를 뒤집는다 (그 자리에서).
 * @param {Image} img 이미지
 */
function flipVertical(img) {
    const stride = img.width * 4;
    const row = Buffer.alloc(stride);
    for (let y = 0; y < img.height >> 1; y++) {
        const top = y * stride;
        const bottom = (img.height - 1 - y) * stride;
        img.data.copy(row, 0, top, top + stride);
        img.data.copy(img.data, top, bottom, bottom + stride);
        row.copy(img.data, bottom);
    }
}

/**
 * 파일 내용을 보고 DDS 인지 TGA 인지 판별해서 본다.
 * png/jpg/bmp 는 브라우저가 직접 열 수 있으므로 여기서 다루지 않는다.
 * @param {Buffer} buf 파일 전체
 * @param {string} [name] 파일 이름 (오류 메시지와 TGA 판별에 쓴다)
 * @returns {Image}
 */
export function decodeImage(buf, name = "") {
    if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "DDS ") return decodeDDS(buf);
    // TGA 는 매직 넘버가 없다. 끝 18바이트의 서명이나 확장자로 판별한다
    if (buf.length >= 18 && (buf.toString("latin1", buf.length - 18, buf.length - 1) === "TRUEVISION-XFILE." || /\.tga$/i.test(name))) {
        return decodeTGA(buf);
    }
    throw new Error(`Unsupported image format: ${name || "unknown"}`);
}

// PNG 청크 CRC 계산용 표 (처음 쓸 때 한 번 만든다)
let crcTable = null;

/**
 * PNG 청크용 CRC-32 를 구한다.
 * @param {Buffer} buf 대상 바이트
 * @returns {number} u32 CRC
 */
function crc32(buf) {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
            crcTable[n] = c;
        }
    }
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xffffffff) >>> 0;
}

/**
 * PNG 청크 하나를 만든다 (길이 + 종류 + 내용 + CRC)
 * @param {string} type 청크 종류. 예: "IHDR"
 * @param {Buffer} data 청크 내용
 * @returns {Buffer}
 */
function pngChunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    // CRC 는 종류와 내용을 합쳐서 계산한다
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}

/**
 * RGBA 이미지를 PNG 파일로 만든다 (8비트 RGBA, 필터 없음).
 * @param {Image} img 이미지
 * @returns {Buffer} PNG 파일 내용
 */
export function encodePNG(img) {
    const { width, height, data } = img;
    // IHDR: 가로, 세로, 비트 깊이 8, 색 종류 6 (RGBA), 압축/필터/인터레이스 0
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);

    // 픽셀 데이터: 줄마다 앞에서 필터 종류 바이트 (0 = 필터 없음) 를 붙인다
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 서명
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", zlib.deflateSync(raw)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}