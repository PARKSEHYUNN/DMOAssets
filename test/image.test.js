import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { decodeDXT, decodeMasked, decodeDDS, decodeTGA, decodeImage, encodePNG } from "../core/image.js";
import { PackFolder } from "../core/pack.js";
import { KDMO_DIR } from "./config.js";

/**
 * 이미지에서 픽셀 하나를 [R, G, B, A] 로 꺼낸다.
 * @param {{width: number, data: Buffer}} img 이미지
 * @param {number} x 가로 위치
 * @param {number} y 세로 위치
 * @returns {number[]}
 */
const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

// 빨강 (0xF800) 과 파랑 (0x001F) 을 끝점으로 하는 DXT1 블록. 인덱스는 0, 1, 2, 3 을 차례로 쓴다
const DXT1_BLOCK = Buffer.from([0x00, 0xf8, 0x1f, 0x00, 0b11100100, 0, 0, 0]);

// 4x4 한 블록을 풀어 끝점 색과 보간 색이 맞는지 본다
test("decodeDXT: DXT1 endpoints and interpolated colors", () => {
  const img = decodeDXT(DXT1_BLOCK, 4, 4, 1);
  // 인덱스 0, 1 은 끝점 그대로 (5비트 0x1F 가 255 로 늘어난다)
  assert.deepEqual(px(img, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(img, 1, 0), [0, 0, 255, 255]);
  // 인덱스 2 는 2/3 지점, 3 은 1/3 지점
  assert.deepEqual(px(img, 2, 0), [170, 0, 85, 255]);
  assert.deepEqual(px(img, 3, 0), [85, 0, 170, 255]);
});

// c0 <= c1 이면 3색 + 투명 모드다
test("decodeDXT: DXT1 punch-through alpha when c0 <= c1", () => {
  // 끝점을 뒤집어 c0 (파랑) < c1 (빨강) 로 만든다
  const block = Buffer.from([0x1f, 0x00, 0x00, 0xf8, 0b11100100, 0, 0, 0]);
  const img = decodeDXT(block, 4, 4, 1);
  // 인덱스 2 는 두 색의 중간, 인덱스 3 은 완전 투명
  assert.deepEqual(px(img, 2, 0), [127, 0, 127, 255]);
  assert.deepEqual(px(img, 3, 0), [0, 0, 0, 0]);
});

// DXT5 는 알파 끝점 2개와 3비트 인덱스를 쓴다
test("decodeDXT: DXT5 alpha", () => {
  // 알파 끝점 255, 0 (a0 > a1 이므로 6개 보간). 인덱스는 전부 0 -> 알파 255
  const alpha = Buffer.from([255, 0, 0, 0, 0, 0, 0, 0]);
  const opaque = decodeDXT(Buffer.concat([alpha, DXT1_BLOCK]), 4, 4, 5);
  assert.equal(px(opaque, 0, 0)[3], 255);
  // 3비트 인덱스를 전부 1 로 채우면 (0b001 반복 = 0x249249249249) 알파는 두 번째 끝점 (0) 이 된다
  const idx1 = Buffer.from([255, 0, 0x49, 0x92, 0x24, 0x49, 0x92, 0x24]);
  const clear = decodeDXT(Buffer.concat([idx1, DXT1_BLOCK]), 4, 4, 5);
  assert.equal(px(clear, 0, 0)[3], 0);
  // 마지막 인덱스 (7) 는 마지막 보간값이다 (a0 * 1/7 = 36)
  const idx7 = Buffer.from([255, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.equal(px(decodeDXT(Buffer.concat([idx7, DXT1_BLOCK]), 4, 4, 5), 0, 0)[3], 73);
});

// 4의 배수가 아닌 크기는 마지막 블록의 남는 픽셀을 버린다
test("decodeDXT: non-multiple-of-4 size", () => {
  const img = decodeDXT(DXT1_BLOCK, 3, 2, 1);
  assert.equal(img.width, 3);
  assert.equal(img.data.length, 3 * 2 * 4);
  assert.deepEqual(px(img, 0, 0), [255, 0, 0, 255]);
});

// 마스크 변환: DDS 의 32비트 BGRA 한 픽셀
test("decodeMasked: 32-bit BGRA", () => {
  const src = Buffer.from([0x30, 0x20, 0x10, 0x80]); // B, G, R, A
  const img = decodeMasked(src, 1, 1, 32, { r: 0xff0000, g: 0xff00, b: 0xff, a: 0xff000000 });
  assert.deepEqual(px(img, 0, 0), [0x10, 0x20, 0x30, 0x80]);
});

// 알파 마스크가 없으면 불투명이어야 한다
test("decodeMasked: missing alpha mask means opaque", () => {
  const img = decodeMasked(Buffer.from([0x30, 0x20, 0x10]), 1, 1, 24, { r: 0xff0000, g: 0xff00, b: 0xff, a: 0 });
  assert.deepEqual(px(img, 0, 0), [0x10, 0x20, 0x30, 255]);
});

/**
 * 테스트용 TGA 파일을 만든다.
 * @param {number} type 이미지 타입 (2 = 비압축 트루컬러, 10 = RLE)
 * @param {number} bpp 픽셀 비트 수
 * @param {number} width 가로
 * @param {number} height 세로
 * @param {number[]} body 픽셀 (또는 RLE) 바이트
 * @param {number} [descriptor] 서술 바이트 (0x20 이면 위에서 아래로)
 * @returns {Buffer}
 */
function tga(type, bpp, width, height, body, descriptor = 0) {
  const head = Buffer.alloc(18);
  head[2] = type;
  head.writeUInt16LE(width, 12);
  head.writeUInt16LE(height, 14);
  head[16] = bpp;
  head[17] = descriptor;
  return Buffer.concat([head, Buffer.from(body)]);
}

// TGA 는 기본이 아래에서 위로 저장이라 줄을 뒤집어야 한다
test("decodeTGA: 24-bit bottom-up is flipped", () => {
  // 1x2 이미지. 파일의 첫 픽셀 (빨강) 이 아래쪽 줄이다
  const buf = tga(2, 24, 1, 2, [0x00, 0x00, 0xff, 0x00, 0xff, 0x00]);
  const img = decodeTGA(buf);
  assert.deepEqual(px(img, 0, 0), [0, 255, 0, 255]); // 위쪽 줄 = 파일의 두 번째 픽셀
  assert.deepEqual(px(img, 0, 1), [255, 0, 0, 255]);
});

// 서술 바이트의 비트 5 가 서 있으면 뒤집지 않는다
test("decodeTGA: top-down flag", () => {
  const buf = tga(2, 24, 1, 2, [0x00, 0x00, 0xff, 0x00, 0xff, 0x00], 0x20);
  assert.deepEqual(px(decodeTGA(buf), 0, 0), [255, 0, 0, 255]);
});

// 16비트는 X1R5G5B5. 최상위 비트는 알파로 쓰지 않는다 (팩 안 파일이 모두 0)
test("decodeTGA: 16-bit is opaque", () => {
  // 0x7C00 = 빨강 최대
  const buf = tga(2, 16, 1, 1, [0x00, 0x7c], 0x20);
  assert.deepEqual(px(decodeTGA(buf), 0, 0), [255, 0, 0, 255]);
});

// RLE: 압축 묶음 (0x80 | n) 과 생 묶음 (n) 을 모두 푼다
test("decodeTGA: RLE packets", () => {
  // 압축 묶음: 파랑 2개, 생 묶음: 초록 1개
  const buf = tga(10, 32, 3, 1, [0x81, 0xff, 0x00, 0x00, 0xff, 0x00, 0x00, 0xff, 0x00, 0xff], 0x20);
  const img = decodeTGA(buf);
  assert.deepEqual(px(img, 0, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(img, 1, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(img, 2, 0), [0, 255, 0, 255]);
});

// DDS 헤더를 만들어 fourCC 경로와 오류 메시지를 확인한다
test("decodeDDS: DXT1 header and unsupported formats", () => {
  const head = Buffer.alloc(128);
  head.write("DDS ", 0, "latin1");
  head.writeUInt32LE(4, 12); // height
  head.writeUInt32LE(4, 16); // width
  head.writeUInt32LE(0x4, 80); // ddspf.dwFlags = FOURCC
  head.write("DXT1", 84, "latin1");
  const img = decodeDDS(Buffer.concat([head, DXT1_BLOCK]));
  assert.deepEqual(px(img, 0, 0), [255, 0, 0, 255]);

  // DX10 확장 헤더는 지원하지 않는다 (팩에 BC7 2개뿐)
  head.write("DX10", 84, "latin1");
  assert.throws(() => decodeDDS(Buffer.concat([head, Buffer.alloc(32)])), /DX10/);
  assert.throws(() => decodeImage(Buffer.from("not an image")), /Unsupported image format/);
});

// PNG 인코더: 서명, IHDR, 그리고 IDAT 를 풀면 줄마다 필터 바이트 0 + 픽셀이 나와야 한다
test("encodePNG: structure and pixel data", () => {
  const img = { width: 2, height: 1, data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) };
  const png = encodePNG(img);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString("latin1", 12, 16), "IHDR");
  assert.equal(png.readUInt32BE(16), 2); // 가로
  assert.equal(png.readUInt32BE(20), 1); // 세로
  assert.equal(png[24], 8); // 비트 깊이
  assert.equal(png[25], 6); // RGBA
  // IDAT 내용을 풀어 원본과 비교한다 (IHDR 청크는 8 + 13 + 4 = 25 B)
  const idatStart = 8 + 25 + 8;
  const idatLen = png.readUInt32BE(8 + 25);
  const raw = zlib.inflateSync(png.subarray(idatStart, idatStart + idatLen));
  assert.deepEqual([...raw], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(png.toString("latin1", png.length - 8, png.length - 4), "IEND");
});

// 실제 팩의 이미지를 형식별로 풀어 본다
describe("image decoding on KDMO", { skip: !KDMO_DIR && "KDMO folder not set" }, () => {
  /** @type {PackFolder} */
  let folder;
  before(() => {
    folder = new PackFolder(KDMO_DIR);
  });
  after(() => folder?.close());

  // 확장자별로 앞에서 100개씩 풀어 오류가 없는지 본다 (전체는 느리다)
  test("decodes real DDS and TGA files", () => {
    for (const ext of ["dds", "tga"]) {
      const list = folder.entries.filter((e) => e.name.toLowerCase().endsWith(`.${ext}`)).slice(0, 100);
      assert.ok(list.length > 0);
      for (const e of list) {
        const img = decodeImage(folder.read(e), e.name);
        assert.ok(img.width > 0 && img.height > 0, e.name);
        assert.equal(img.data.length, img.width * img.height * 4, e.name);
      }
    }
  });

  // 디지몬 카드 텍스처 하나를 PNG 로 만들어 본다 (크기와 서명만 확인)
  test("encodes a real texture to PNG", () => {
    const e = folder.entries.find((x) => /siriusmon\.dds$/i.test(x.name));
    assert.ok(e, "sample texture not found");
    const img = decodeImage(folder.read(e), e.name);
    const png = encodePNG(img);
    assert.equal(png.toString("latin1", 1, 4), "PNG");
    assert.ok(png.length > 1000);
  });
});
