# DMO 클라이언트 포맷 명세

Digimon Masters Online 신 클라이언트 (인덱스 버전 0x13, KDMO / GDMO Steam) 의 팩, 테이블, 모델 형식. [DMOAssets](../README.md) 구현의 기준 문서다.

- 모든 값은 KDMO 2026-09-17 빌드에서 확인했다. 확인 못 한 것은 "미확인" 이라고 적었다.
- 정수는 모두 **리틀엔디안**. `u8/u16/u32/u64` 부호 없음, `i32` 부호 있음, `f32` float.
- 경로 구분자는 역슬래시 `\`.

## 1. 설치 폴더와 팩

KDMO `Data\`:
```
pack01.hf / pack01.pf    리소스 (모델, 텍스처, 애니, UI, 맵)   51,006개, pf 약 23 GB
Pack02.hf / Pack02.pf    게임 테이블 (.bin)                     295개,    pf 약 23 MB
interface\ Music\ Sound\ StaticSound\ Shaders\ NP\            팩 밖의 일반 파일
```
GDMO Steam: 리소스 `Pack01` (51,830개), 테이블 `Pack03` (909개).

- 팩은 항상 `.hf` (인덱스) 와 `.pf` (데이터) 한 쌍.
- 두 클라이언트는 팩 안의 **경로가 같고** 어느 팩에 있는지만 다르다. 팩 번호로 분기하지 말고 폴더의 `.hf` 를 전부 열어 경로 해시로 찾는다.
- 리소스 팩 항목은 **평문**, 테이블 팩 항목은 **암호화**. 판별은 팩 번호가 아니라 항목 내용으로 한다 (5-1).
- 팩은 빌드마다 **새 키로 재암호화**된다. 빌드 비교는 복호 결과로 한다.
- 라이브 설치본은 패치로 바뀐다. 항목 수를 고정값으로 가정하지 않는다.

### GDMO Steam 차이
- 팩 이름만 다르다 (위). 형식, 복호, 경로 규칙은 같다.
- **SVN 충돌 사본**: 접미사 `.r<숫자>` 또는 `.mine` 인 항목은 개발사 SVN 충돌 사본이다. 게임은 쓰지 않으므로 목록에서 숨긴다. KDMO 에는 없다.
  - 2026-09-23 기준 543개: 테이블 팩 541개 (`.r4363` 254, `.r4146` 160, `.r4050` 94, `.mine` 33) + 리소스 팩 2개 (`data\map\realworld_r\02_datsbase\3\map_data\3.nif.r9076`, `.r9429`).
  - 접미사 번호는 목록으로 고정하지 말고 `.r\d+` 패턴으로 거른다.
  - 걸러낸 뒤 테이블 팩은 368개 (`.bin` 367 + `data\bin\table\recompense.txt` 1).
- **문자열 표 폴더**: KDMO 는 `data\bin\language\korea\` (67개) + `koreaorg\skill_str.bin` (1개). GDMO 는 `language\english\` 와 `language\spanish\`. 같은 표 이름이 폴더만 바꿔 들어 있다.
  - GDMO 영어판 표 안에도 번역 안 된 한글 문자열이 남아 있다 (`quest_str.bin`, `digimonridingcomment_str.bin` 등).
- **테이블 목록 차이**: 대부분 같다. GDMO 에만 있는 표가 있다 (`cashshop_steam_main.bin`, `cashshop_steam_category.bin`, `dm_ranking_dungeon-ranktype_str.bin` 등). KDMO 에만 있는 것은 `dm_luckydraw_info-luckydrawinfo.bin`. 같은 이름 표의 레코드 형식 차이는 미확인 (표 파서를 만들 때 확인).
- 맵 UI 는 `data\interface\map\__map_eng\<이름>` 에서 찾는다.

## 2. HF 인덱스

```
+0  u32 version   = 0x13
+4  u32 blobLen   = 뒤따르는 암호화 blob 길이 (= 파일 크기 - 8)
+8  blob
```

### 2-1. blob 복호
1. blob 을 u32 배열로 읽는다. 길이가 4의 배수가 아니면 남는 1~3바이트는 **버린다** (넣으면 zlib 체크섬 실패). KDMO pack01.hf blob 593,916 B, Pack02.hf 3,559 B. 둘 다 3바이트 꼬리가 있다.
2. 배열 `a[0..n-1]` 에 차례로 적용 (모두 mod 2^32):
   - **RvsFull**: `a = reverse(a); a[i] = ~a[i]`
   - **Twist**: `a[i] = rotr32(a[i], (i % 31) + 1)`
   - **RvsHalf**: i 짝수면 `a[i] ^= 0xFFFF0000`, 홀수면 `a[i] ^= 0x0000FFFF`
   - **XorTwist**: `st = 78695`, 각 i 에서 `x = a[i]; a[i] = x ^ st; st = (x + st) * 52845 + 22719`. 상태 갱신에는 **복호 전 값** x 를 쓴다.
3. 결과를 zlib 으로 푼다. 꼬리를 버려서 스트림 끝 (adler32) 이 잘려 있으므로 Node 에서는 `zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH })` 로 푼다. 기본 옵션이면 `unexpected end of file` 이 난다. 풀린 길이 검사 (2-2) 로 완전성을 확인한다.

### 2-2. 풀린 인덱스
```
+0  u32 count
+4  count x 24 B:
    +0   u32 hash     경로 해시 (3절)
    +4   u32 flags    항상 0
    +8   u64 offset   .pf 안에서 데이터 시작 위치
    +16  u32 size     데이터 길이 (이만큼 읽는다)
    +20  u32 alloc    할당 길이. size 보다 클 수 있다 (pack01 에 171개). 무시.
```
확인: 풀린 길이 `== 4 + count * 24`.

엔트리는 offset 순서가 아니다. pf 안에 어떤 엔트리도 가리키지 않는 빈 공간이 있다 (pack01 첫 데이터는 offset 6,348,712). 항상 offset 으로 찾아간다.

## 3. 경로 해시 (DJB2 변형)

```
h = 5381
for c in lowercase(path):
    if c is '.' or '\' or '/': skip
    h = (h * 33 + c) mod 2^32
```

| 경로 | 해시 |
|---|---|
| `data\model.dat` | `0xE0F0F4E9` |
| `data\bin\table\digimonlistdata.bin` | `0x8C2E8C36` |
| `data\digimon\agumon\agumon.nif` (대소문자 무관) | `0x57E6B6F1` |

## 4. PF 데이터와 파일 이름

```
+0  u32 0x10
+4  u32 0
이후 파일마다 [268 B 경로 청크][데이터], 사이사이 빈 공간
```
인덱스 offset 은 청크 **다음**을 가리킨다.
```
offset - 268 : u8[260] 경로. 바이트마다 XOR 0xD0, 뒤는 0
offset -   8 : u32     flags (0)
offset -   4 : u32     경로 길이 L (1..260)
offset       : 데이터
```
- 모든 항목에 청크가 있어 이름 목록 파일 없이 **이름을 전부 복원**할 수 있다. KDMO pack01 51,006개와 Pack02 295개 전부 청크 경로의 해시가 인덱스 해시와 일치.
- 방어 코드: `0 < L <= 260`, 경로가 인쇄 가능한 ASCII (0x20~0x7E) 이고 Windows 파일 이름에 못 쓰는 문자 (`< > : " | ? *`) 가 없으며, **경로의 해시가 인덱스 해시와 같을 때** 믿는다. 아니면 `_unnamed\<HASH>.bin`.
  - 실제 경로에 `#` `+` `&` 가 있다 (pack01 에 23개, 예: `...\structure\map #387.dds`, `...\263_stair+_ao.dds`, `...\people&velox.dds`). 문자 목록을 좁게 잡으면 이 항목들을 놓친다.
- 경로 대소문자는 항목마다 섞여 있다 (`Data\Digimon\...` / `data\digimon\...`). 비교는 소문자로.

## 5. 항목 복호

### 5-1. 판별
1. 앞 2바이트가 **진짜 zlib 헤더**인지 본다: `b[0] == 0x78 && ((b[0] << 8) | b[1]) % 31 == 0`. 아니면 **평문** (리소스 nif, dds, tga ... 는 전부 여기).
2. zlib 으로 푼다. 결과를 `outer` 라 한다.
3. 다음 셋을 모두 만족하면 **봉투** (5-2). 아니면 `outer` 가 평문.
   - `outer.length >= 72`
   - `outer[0]` 이 `0x10 0x11 0x12 0x13 0x6A 0x6C` 중 하나
   - `outer[68..71]` 의 u32 payLen 이 `0 < payLen <= outer.length - 72`

헤더 없는 raw deflate 로 "혹시" 풀어보는 코드는 넣지 않는다. 아무 데이터에서나 1~2바이트를 뱉으며 성공한 것처럼 보인다.

### 5-2. 72바이트 봉투
```
outer[0]       타입 코드
outer[4..67]   64 B 키 (Shuffle 용)
outer[68..71]  u32 payLen (= 8 + padded)
outer[72..]    payload
```
1. **Shuffle**: payload 를 16 B 블록으로 나눈다 (끝의 16 미만 조각은 그대로). 블록마다 키 바이트 k 를 **0번부터 63번까지** 순서대로 보며 `x = k & 0x0F`, `y = k >> 4` 두 칸을 맞바꾼다.
2. **RvsHalf** (2-1 과 같음. u32 단위, 꼬리 바이트는 그대로).
3. 앞 8바이트를 부헤더로 읽는다: `u32 orig`, `u32 padded`. 확인: `padded == ceil(orig / 8) * 8` 이고 `8 + padded <= 길이`.
4. **Blowfish ECB 복호**: 대상 `[8, 8 + padded)`. 복호 후 앞 `orig` 바이트만 남긴다.
   - 키: ASCII `%D*F-JaNdRgUkXp2s5v8y/B?E(H+MbPe` (32바이트).
   - 표준 Blowfish (P/S 박스 초기값, 키 스케줄 표준).
   - **다른 점 하나: 블록의 두 u32 (L, R) 를 리틀엔디안으로 읽고 쓴다.** 표준 구현은 빅엔디안.
5. **XorTwist (꼬리 포함)**:
   - 앞의 `floor(orig / 4)` 개 u32 는 2-1 과 똑같이 푼다.
   - 남는 t = `orig % 4` 바이트는 마지막 u32 처리 후의 상태 `st` 로 푼다: `out[i] = in[i] ^ ((st >>> (8 * (4 - t + i))) & 0xFF)`, i = 0..t-1. 꼬리를 u32 의 **상위 바이트** 자리에 놓고 XOR 하는 셈.
   - 틀리면 파일 마지막 1~3바이트만 조용히 깨진다. Steam 테이블 882개 중 363개가 해당.
   - 확인 (2026-09-23): 길이가 4의 배수가 아닌 문자열 표 (KDMO korea 37개, GDMO english 36개) 의 파일 끝 문자열이 모두 정상 텍스트로 읽힌다 (예: `디마와 함께!`, `Good luck to you!`).
6. 결과가 다시 진짜 zlib 헤더로 시작하면 한 번 더 푼다 (inner zlib, 있기도 없기도 함). 풀린 길이가 입력보다 짧으면 오탐이므로 풀기 전 값을 쓴다.

테스트 (KDMO Pack02 `data\bin\table\digimonlistdata.bin`): 저장 184,108 B → outer 187,936 B, 타입 0x10, payLen 187,864 → 최종 187,856 B, 첫 u32 = 876.

## 6. Node.js 구현 메모

### 6-1. 32비트 연산
비트 연산 결과는 **부호 있는** 32비트다. u32 가 필요한 곳은 `>>> 0`. 곱셈은 `Math.imul`.
```js
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

function djb2(path) {
  let h = 5381;
  for (const ch of path.toLowerCase()) {
    if (ch === '.' || ch === '\\' || ch === '/') continue;
    h = (Math.imul(h, 33) + ch.charCodeAt(0)) >>> 0;
  }
  return h;
}

// XorTwist 한 단계 (st, x 는 u32)
const out = (x ^ st) >>> 0;
st = (Math.imul((x + st) >>> 0, 52845) + 22719) >>> 0;
```

### 6-2. Buffer
- `readUInt32LE`, `readInt32LE`, `readUInt16LE`, `readFloatLE`. u64 는 `Number(buf.readBigUInt64LE(o))` (offset 은 2^53 미만).
- u32 배열은 `new Uint32Array(buf.buffer, buf.byteOffset, n)`. byteOffset 이 4의 배수가 아니면 `Buffer.from(buf)` 로 복사 후 사용. 리틀엔디안 PC (x86) 에서만 그대로 맞는다.
- 문자열: 표시 문자열 `'utf16le'`, 경로와 ASCII 문자열 `'latin1'`.
- zlib: `zlib.inflateSync(buf)`. 5-1 헤더 검사 먼저.

### 6-3. 큰 파일
- pf 는 23 GB. `readFileSync` 금지 (Buffer 최대 크기 초과).
- `fs.openSync(pf, 'r')` 후 항목마다 `fs.readSync(fd, buf, 0, len, position)`.
- 이름 복원은 51,006번 읽는다. offset 순으로 정렬해서 읽고, GUI 에서는 워커 스레드.
- **KDMO 게임 (`DigimonMasters.exe`) 실행 중에는 `.pf` 가 잠겨 `EBUSY` 로 열리지 않는다** (2026-09-22 확인). `.hf` 는 열린다. GDMO Steam 은 미확인.
  - 결정: `EBUSY` 면 "Close the game and try again." 로 안내하고 끝낸다. 우회 (VSS, 게임 핸들 복제, 메모리 읽기) 는 하지 않는다. 핸들 복제와 메모리 읽기는 안티치트 (XIGNCODE) 제재 위험이 있다.

### 6-4. Blowfish
- Node 17+ (OpenSSL 3) 에서 `bf-ecb` 는 legacy provider 로 빠져 `createDecipheriv` 가 안 될 수 있다. **JS 로 직접 구현** (P 18개, S 4x256 표준 상수, 약 100줄).
- 블록을 `L = readUInt32LE(o)`, `R = readUInt32LE(o + 4)` 로 읽고 결과도 LE 로 쓴다.
- 표준 테스트 벡터 (빅엔디안) 로 먼저 검증한 뒤 LE 로 바꾼다.

### 6-5. 이미지
`.png` `.jpg` `.bmp` 는 브라우저가 바로 연다. `.dds` 와 `.tga` 는 직접 디코드한다.

팩 안의 형식 (KDMO pack01 기준, 2026-09-23):
| 형식 | 개수 | 비고 |
|---|---|---|
| DDS DXT1 / DXT5 / DXT3 | 7,095 / 1,962 / 351 | 4x4 블록 압축 |
| DDS 비압축 | 185 | 32비트 BGRA 145, 24비트 BGR 28, 32비트 BGRX 11, 8비트 1. 채널 마스크가 헤더에 있다 |
| DDS DX10 | 2 | DXGI 98 = BC7. **지원하지 않는다** (파일 2개뿐이라 디코더 값어치가 없다) |
| TGA 타입 2 (비압축) | 4,945 | 32비트 2,996 + 207 (top-down), 24비트 1,717, 16비트 232 |
| TGA 타입 10 (RLE) | 83 | 32비트 62, 24비트 21 |
| TGA 타입 1 (팔레트) | 2 | 8비트, 팔레트는 24/32비트 |

- **TGA 16비트는 X1R5G5B5 로 다룬다.** 최상위 비트가 알파 자리지만 232개 파일 전부 0 이다. 알파로 쓰면 이미지가 통째로 투명해진다.
- TGA 는 서술 바이트 (+17) 의 비트 5 가 0 이면 **아래에서 위로** 저장된 것이라 줄을 뒤집어야 한다. 대부분 이쪽이다.
- 밉맵은 0단계 (원본 크기) 만 쓴다. 가로/세로가 4의 배수가 아닌 DXT 이미지가 있으므로 가장자리 블록의 남는 픽셀은 버린다.
- 깨진 파일이 섞여 있다 (`data\map\digitalworld\world_07\object_data\structure\1300_castle_lightingmap02.dds` 는 72 B 쓰레기). 형식 판별 실패는 오류로 보고하고 넘어간다.
- 확인 (2026-09-23): KDMO 14,833개 중 14,830개, GDMO 15,241개 중 15,237개 디코드 성공. 실패는 BC7 과 깨진 파일뿐이다.

## 7. 테이블

모델 연결 (10-1) 과 이름 표시에 필요한 것만 적는다.

### 7-1. 공통 규칙
- 거의 모든 표가 `[u32 count]` + 레코드. 레코드는 고정 길이와 가변 길이 (개수 + 배열, 길이 + 문자열) 가 섞여 있다.
- **파서는 끝까지 읽었을 때 정확히 파일 끝이어야 한다.** 모든 파서에 이 검사를 넣는다.
- 맵별 표가 많다: `[u32 nmap] x (u32 map, u32 k, k x 레코드)`.
- 문자열: ASCII `u32 len + len 바이트` (latin1), 표시 문자열 `u32 chars + chars x 2 바이트` (UTF-16LE), 고정 길이 `char[N]`/`wchar[N]` (0 종료).
- 표시 문자열은 `data\bin\language\korea\<이름>_str.bin` 에 따로 있다.
- 몇몇 표는 첫 배열 뒤에 블록이 더 붙어 있다.

### 7-2. 문자열 표 (`language\korea\*_str.bin`)
| 형태 | 구조 | 예 |
|---|---|---|
| 1개짜리 | `[u32 n] n x (u32 id, u32 chars, UTF-16)` | `digimonname_str.bin` |
| 2개짜리 | `[u32 n] n x (u32 id, u32 chars, UTF-16, u32 chars, UTF-16)` 이름 + 설명 | `skill_str.bin` |
| 맵 지역 | `[u32 n] n x (u32 map, u32 k, k x (i32 x, i32 y, u32 chars, UTF-16))` | `mapregion_str.bin` |
| 3개짜리 | 짧은 이름, 이름, 설명 | `areamapinfo_str.bin` |

표마다 필드 수가 다르다. 끝까지 읽기 검사로 형태를 확인한다.

### 7-3. digimonlistdata.bin (Pack02 `data\bin\table\`, 876개)
```
[u32 count] 가변 길이 레코드:
+0   u32 id
+4   10 x u16 스탯: HP DS DE EV MS CR AT AS AR HT
+24  u32 id (반복)
+28  u32 모델 id              -> model.dat
+32  f32 선택창 크기
+36  u32 기본 레벨
+40  u16 디지몬 타입
+42  u16 ?   +44 u16 ?
+46  u8  크기   +47 u8 플래그   +48 u8 진화 타입   +49 u16 ?   +51 u8 속성
이어서:
u32 n + n x u16      계열 (항상 3)
u16                  자연 속성
u32 n + n x u16      자연 속성 목록 (항상 3)
u32 n + n 바이트     이름 (ASCII, 로마자)
u32 n + n 바이트     진화 이펙트 경로
u32 n + n x (u32 슬롯, u32 스킬 id, u32 스킬 레벨)   (항상 6, 6번째는 비어 있음)
3 x f32              (항상 300)
u32 등급, u32 ?
```
한글 이름은 `digimonname_str.bin` (1개짜리).

### 7-4. model.dat (pack01 `data\model.dat`)
```
[i32 n] n 개:
+0    i32 모델 id
+4    char[160] .kfm 경로
+164  3 x f32  scale, height, width
+176  i32 nseq
+180  16 B (보통 0)
+196  nseq 개 시퀀스:
        i32 시퀀스 id, i32 nevent, i32 nloop, i32 nshader
        nevent  x 200 B  이벤트: +4 i32 타입, +12 char[128] 텍스트 (.nif 는 data\effect, .wav/.mp3 는 data\sound 기준)
        nshader x 68 B   셰이더
```
KDMO 1,111개, 7,798,812 B. 이벤트 타입 5 는 mp4 컷신.

### 7-5. maplist.bin (257개)
`[u32 n] n x (u32 id, i32 w, i32 h, u32 부활 맵, 5 x u16 피로도, u16 카메라, u8, u8, 3 x (i32 len + ASCII): 경로, 이름, bgm)`. 경로 필드가 맵 폴더를 가리킨다.

## 8. 리소스 폴더 규칙 (pack01)

| 폴더 | 개수 | 내용 |
|---|---|---|
| `data\digimon\<이름>\` | 20,273 | 디지몬 모델, 애니, 텍스처 |
| `data\map\` | 16,652 | 지형, 맵 오브젝트 |
| `data\effect\` | 4,907 | 이펙트 (.nif). `data\effect\system\digimon_evo.nif` = 모든 진화 연출 |
| `data\interface\` | 3,999 | UI 이미지 |
| `data\npc\<이름>\` | 2,550 | NPC 모델 |
| `data\tamer\` | 2,417 | 테이머 모델, 장비 |
| `data\etcobject\` `data\item\` `data\camera\` `data\font\` | 소수 | 기타 |
| `data\model.dat`, `data\effectsound.dat` | 1 | 모델 표, 이펙트 사운드 표 |

| 확장자 | 개수 | 형식 |
|---|---|---|
| `.kf` | 18,918 | Gamebryo 애니메이션 |
| `.nif` | 13,579 | Gamebryo 모델 |
| `.dds` | 9,596 | DirectDraw Surface, 대부분 DXT1/3/5 |
| `.tga` | 5,237 | Targa |
| `.kfm` | 1,137 | 모델 묶음, 헤더 `;Gamebryo KFM File Version 2.2.0.0b` |
| `.cst` `.csp` | 1,224 | 미확인 |
| `.png` `.bmp` `.jpg` | 648 | UI 이미지 |
| `.emr` `.xml` `.cmi` `.settings` `.lst` `.ini` | 소수 | 맵/카메라 설정 |

경로 규칙:
- 로딩 화면: `data\interface\loading\loading_<맵 id>.dds`
- 미니맵, 존 지도: `data\interface\map\<이름>` (글로벌은 `__map_eng\` 아래)

## 9. NIF / KF 구조 (pack01 전체 스캔, 2026-09-22)

- nif/kf 32,497개 전부 헤더 `Gamebryo File Format, Version 20.3.0.9\n`, 버전 u32 `0x14030009`, 엔디안 바이트 1, user version 0.
- 헤더 순서: 헤더 문자열, u32 version, u8 endian, u32 user version, u32 numBlocks, u16 numBlockTypes + (u32 len + 이름) 목록, numBlocks x u16 타입 인덱스 (`& 0x7FFF`), numBlocks x u32 블록 크기, u32 numStrings + u32 maxLen + (u32 len + 문자열) 목록, u32 numGroups + numGroups x u32, 이후 블록들, footer `u32 numRoots + numRoots x u32`.
- 블록 크기 표로 따라가면 nif 13,578개 전부 footer 까지 정확히 파일 끝과 맞는다. 모르는 블록은 크기 표로 건너뛴다.
- `NiMesh`/`NiDataStream` 없음. 형상은 `NiTriStrips` (13,245 파일) 와 `NiTriShape` (4,639 파일).
- DMO 전용 블록은 `CsNiNode` 하나. 맵 nif 203개에만 있다 (`data\map\...`).
- 스킨 블록 (`NiSkinInstance`/`NiSkinData`/`NiSkinPartition`) 이 있는 파일 3,251개. 나머지는 Bone Parent 강체 구조.
- 내장 텍스처: `NiPersistentSrcTextureRendererData`, `NiPixelData`. 첫 u32 픽셀 형식: 0 RGB, 1 RGBA, 2 PAL, 3 PALA, 4 DXT1, 5 DXT3, 6 DXT5 (형식 9 는 1개뿐).
- 파티클 (`NiParticleSystem`, `NiPSys*`) 은 이펙트 nif 에 많다. 모델 변환에서는 건너뛴다.
- kf 18,917개 중 18,370개가 `NiBSplineCompTransformInterpolator`. B-spline 디코더 필수. 그 외 `NiTransformInterpolator`, `NiFloatInterpolator`, `NiPoint3Interpolator` 등.
- 예외: `data\digimon\cake\cake.nif`, `cake.kf` 는 빅엔디안 (엔디안 바이트 0). 건너뛴다.

### 9-1. 블록 필드 배치 (2026-09-23 확인)

nif.xml 은 버전마다 필드가 달라서, 아래 배치는 팩 전체로 확인한 것이다. 읽은 바이트 수가 블록 크기 표와
정확히 같아야 통과하게 검사했고, nif 13,583개의 해당 블록 전부가 통과한다. 정렬은 없다 (필드가 그냥 이어진다).

공통 조각:
- `NiObjectNET` = u32 이름 (문자열 번호, -1 은 없음) + u32 개수 + 개수 x u32 추가 데이터 ref + u32 컨트롤러 ref
- `NiAVObject` = NiObjectNET + **u16 flags** (u32 아니다) + 3f 이동 + 9f 회전 + 1f 배율 + u32 개수 + 속성 ref 들 + u32 충돌체 ref
- `NiTransform` (NiSkinData 등) 순서는 **회전 9f → 이동 3f → 배율 1f**. NiAVObject 와 순서가 다르다

블록별:
| 블록 | 배치 |
|---|---|
| `NiNode` | NiAVObject + u32 자식 수 + ref 들 + u32 이펙트 수 + ref 들 |
| `NiBillboardNode` | NiNode + u16 |
| `NiTriShape` / `NiTriStrips` | NiAVObject + u32 data ref + u32 skinInstance ref + u32 재질 수 + (이름 i32) x n + (추가 i32) x n + i32 activeMaterial + u8 |
| `NiGeometryData` | i32 groupID + u16 정점 수 + u8 keep + u8 compress + u8 있음 + 정점 3f + **u16 vectorFlags** + u8 법선 있음 + 법선 3f + (vectorFlags & 0x1000 이면 탄젠트, 바이탄젠트) + 바운딩 구 4f + u8 색 있음 + 색 4f + UV (vectorFlags & 0x3F 세트) + u16 + u32 ref |
| `NiTriShapeData` | NiGeometryData + u16 삼각형 수 + u32 점 수 + u8 있음 + 삼각형 3 x u16 + u16 그룹 수 + (u16 개수 + u16 들) |
| `NiTriStripsData` | NiGeometryData + u16 삼각형 수 + u16 스트립 수 + 스트립 길이 u16 들 + u8 있음 + 스트립마다 u16 정점 번호 |
| `NiMaterialProperty` | NiObjectNET + ambient 3f + diffuse 3f + specular 3f + emissive 3f + 광택 1f + 알파 1f (총 68 B) |
| `NiTexturingProperty` | NiObjectNET + u16 + u32 텍스처 칸 수 (7 또는 9) + u8 base 있음 + TexDesc + 나머지 칸들 |
| TexDesc | u32 source ref + u16 + u8 UV 변환 있음 (있으면 5f + u32 + 2f) |
| `NiAlphaProperty` | NiObjectNET + u16 flags + u8 임계값 (총 15 B). flags 비트 0 = 반투명 합성, 비트 9 = 알파 테스트 |
| `NiSourceTexture` | NiObjectNET + u8 외부 여부 + u32 파일 이름 (문자열 번호) + u32 pixelData ref + u32 레이아웃 + u32 밉맵 + u32 알파 형식 + u8 x 3 (총 36 B). **외부/내장 둘 다 파일 이름 필드가 있다** |
| `ATextureRenderData` (내장 텍스처 공통) | u32 픽셀 형식 + u8 bpp + i32 + u32 + u8 + u32 타일링 + **u8 (sRGB 로 추정)** + 채널 4개 x (u32 종류 + u32 방식 + u8 비트 + u8 부호) + u32 팔레트 ref + u32 밉맵 수 + u32 픽셀당 바이트 + 밉맵 (u32 가로, u32 세로, u32 시작 위치) |
| `NiPersistentSrcTextureRendererData` | 위 + u32 픽셀 수 + u32 pad + u32 면 수 + u32 플랫폼 + 픽셀 |
| `NiPixelData` | 위 + u32 픽셀 수 + u32 면 수 + 픽셀 |
| `NiPalette` | **NiObjectNET 없음.** u8 알파 여부 + u32 색 수 + 색 수 x 4 B (R, G, B, A) |
| `NiSkinInstance` | **NiObjectNET 없음.** u32 data ref + u32 partition ref + u32 skeletonRoot ref + u32 뼈 수 + 뼈 노드 ref 들 |
| `NiSkinData` | NiTransform (전체) + u32 뼈 수 + u8 가중치 있음 + 뼈마다 (NiTransform + 바운딩 구 16 B + u16 정점 수 + (u16 정점 번호 + f32 가중치) x n) |

- 채널 종류: 0 R, 1 G, 2 B, 3 A, 0x13 = 빈 칸. 압축 형식은 채널 0번이 종류 4 로 온다.
- 픽셀 수는 한 면의 밉맵 전부를 합친 바이트 수다 (256x256 팔레트면 87,381).

### 9-2. 변환 규칙과 함정

- **행렬 규칙**: 열벡터다 (`v' = R * v * scale + t`). 행렬은 행 순서 (m11 m12 m13 m21 ...) 로 저장한다.
  스킨 모델에서 `월드(뼈) * 뼈 변환` 이 모든 뼈에서 같은 값이 되는지로 확인했다 (같아야 맞다).
  이 조합에서 오차 0, 행벡터로 보거나 NiTransform 순서를 바꾸면 145 이상 어긋난다.
- **숨김 플래그**: NiAVObject flags 비트 0 이 서 있으면 그리지 않는다. 형상의 55%가 여기 해당하는데,
  3ds Max 의 뼈/바이패드 헬퍼 지오메트리가 nif 에 그대로 들어가 있기 때문이다 (이름이 `Bone`, `Biped Object`).
  거르지 않으면 모델에 상자 뭉치가 붙는다. 본체 메시는 보통 `0x16`, 헬퍼는 `0x17` 이다.
- **속성 상속**: 재질/텍스처/알파 속성은 부모 노드에 걸려 있을 수 있다. 트리를 내려가며 물려받고, 같은 종류가 있으면 덮어쓴다.
- **스트립**: 홀수 번째 삼각형은 감는 방향이 뒤집힌다. 번호가 겹치는 (넓이 0) 삼각형은 스트립을 잇는 용도라 버린다.
- **파티클 전용 nif**: 이펙트 nif 중 532개는 그릴 형상이 전부 숨김이다. 메시가 `NiPSysMeshEmitter` 의 방출 틀이라 원래 안 보인다.
- **스킨**: `NiSkinData` 의 가중치는 항상 들어 있다 (`hasVertexWeights` 가 1). 그래서 `NiSkinPartition` 은 읽지 않아도 된다.
  정점 하나에 뼈가 최대 12개 붙지만 (5개 이상은 정점의 0.3%), glTF 는 4개까지라 큰 것 4개만 남기고 합을 1로 맞춘다.
  glTF 의 역바인드 행렬은 `NiSkinData` 의 뼈 변환을 그대로 쓰면 된다.
- **스킨 메시의 전체 변환**: `NiSkinData` 의 앞쪽 NiTransform 을 빼먹으면 어긋난다. 본체 메시는 대개 단위 행렬이지만
  (8,808개 중 5,379개가 단위 아님), 이펙트 판은 345~464 단위까지 밀려 있다.
- **강체 파츠 (Bone Parent)**: 노드 계층을 그대로 두면 뼈 노드의 자식으로 남아 애니메이션을 따라간다
  (예: 아구몬 눈 = `GeoSphere02 < Dummy02 < Bip01 Head`). 스키닝으로 굳이 바꾸지 않으면 10-3 1번 이중 변환 함정도 없다.
- **재질 색**: 이펙트 재질은 알파가 음수 (-0.8 등) 인 경우가 있다. glTF 는 0~1 만 받으므로 잘라야 검사기를 통과한다.
- **합성 방식**: `NiAlphaProperty` flags 는 비트 0 이 합성 여부, 비트 1~4 가 원본 계수, 비트 5~8 이 도착지 계수다
  (0 ONE, 1 ZERO, 2 SRC_COLOR, 3 INV_SRC_COLOR, 6 SRC_ALPHA, 7 INV_SRC_ALPHA).
  팩 전체 30,026개의 분포: 더하기 (도착지 ONE) 18,264, 일반 알파 6,447, 어둡게 (ZERO -> INV_SRC_COLOR) 3,743, 나머지 1,053.
  glTF 는 일반 알파 합성뿐이라, 더하기/어둡게 레이어를 그대로 두면 본체를 불투명하게 덮는다 (큰 모델이 검게 나오는 원인).
  더하기는 밝기를 알파로 옮기고 같은 그림을 발광으로도 걸고, 어둡게는 색을 검게 두고 밝기를 알파로 쓰며 재질 발광을 뺀다.
- **정지 상태에서 안 보이는 이펙트**: 이펙트 nif 는 재질 알파가 0 인 경우가 많다. 애니메이션이 알파를 올리는 구조라 정지 상태에서는 안 보이는 것이 맞다.

### 9-3. kf 애니메이션 (2026-09-25 확인)

kf 는 nif 와 같은 파일 형식이다 (헤더, 블록 크기 표, 문자열 표, footer 가 전부 같다). 그래서 같은 파서로 읽고,
블록 종류만 다르다. 아래 배치도 9-1 과 같은 방법으로 확인했다: 읽은 바이트 수가 블록 크기 표와 정확히 같아야
통과하게 두고, KDMO kf 18,919개 + GDMO kf 18,989개 전부가 통과한다 (못 읽는 것은 빅엔디안 `cake.kf` 하나).

블록별 배치:
| 블록 | 배치 |
|---|---|
| `NiControllerSequence` | u32 이름 + u32 블록 수 + u32 arrayGrowBy + 블록들 + 1f 가중치 + u32 텍스트키 ref + u32 반복 종류 + 1f 주기 + 1f 시작 + 1f 끝 + u32 manager + u32 누적 뿌리 이름 + u32 (누적 축 플래그로 보임, 대개 0x40) |
| ControlledBlock (위의 "블록") | u32 보간기 ref + u32 컨트롤러 ref + u32 노드 이름 + u32 속성 종류 + u32 컨트롤러 종류 + u32 컨트롤러 id + u32 보간기 id (전부 문자열 번호) |
| `NiTextKeyExtraData` | u32 이름 + u32 키 수 + (1f 시각 + u32 문자열) x n |
| `NiTransformInterpolator` | 3f 이동 + 4f 회전 (w, x, y, z) + 1f 배율 + u32 data ref (36 B) |
| `NiTransformData` | u32 회전 키 수 + (키가 있으면) u32 회전 종류 + 회전 키 + 이동 KeyGroup\<3f\> + 배율 KeyGroup\<1f\> |
| KeyGroup\<T\> | u32 키 수 + (키가 있으면) u32 보간 종류 + 키들. 키 = 1f 시각 + 값, 보간 2 면 값 뒤에 나가는 접선 + 들어오는 접선, 보간 3 (TBC) 이면 3f |
| `NiBSplineCompTransformInterpolator` | 1f 시작 + 1f 끝 + u32 spline data ref + u32 basis data ref + 3f 이동 + 4f 회전 + 1f 배율 + u32 이동 오프셋 + u32 회전 오프셋 + u32 배율 오프셋 + 1f 이동 치우침 + 1f 이동 배율 + 1f 회전 치우침 + 1f 회전 배율 + 1f 배율 치우침 + 1f 배율 배율 (84 B) |
| `NiBSplineData` | u32 float 수 + float 들 + u32 short 수 + i16 들 |
| `NiBSplineBasisData` | u32 제어점 수 |

- 보간기 종류별 파일 수 (KDMO): `NiTransformInterpolator` 18,915, `NiBSplineCompTransformInterpolator` 18,372,
  `NiFloatInterpolator` 346, `NiPoint3Interpolator` 107, `NiBoolInterpolator` 14. 뿌리는 항상 `NiControllerSequence` 다.
- 컨트롤러 종류 (표본 156,563개): `NiTransformController` 155,969, `NiTextureTransformController` 284,
  `NiAlphaController` 104, 나머지는 파티클/재질용이다. 즉 노드 변환 애니가 거의 전부다.
- 대상 노드는 이름으로 적힌다. 표본에서 97.8% 가 모델 nif 안의 노드와 이름이 맞는다 (나머지는 모델에 없는 이펙트용 더미).
- 누적 뿌리와 `<이름> NonAccum` 이 쌍으로 나온다. 모델 nif 에도 두 노드가 다 있다 (표본 2,179개 중 2,121개 확인).

**회전 키 종류** (`NiTransformData`, KDMO 전체 블록 기준): 4 (축별 오일러) 259,720, 0 (회전 없음) 31,972,
1 (선형 사원수) 29,564, 3 (TBC) 2,597, 2 는 2개. 보간 종류는 2 (2차) 1,004,426, 1 (선형) 66,958, 3 은 9개.

- **오일러 키**: 종류가 4 면 회전 키 수 자리는 1 이고, 그 뒤에 X, Y, Z 곡선이 KeyGroup\<1f\> 로 이어 온다.
  값은 **라디안**이고, 합성 순서는 **X 를 먼저, 그 다음 Y, 마지막 Z** 다 (`q = qz * qy * qx`).
  확인 방법: 애니 시작 자세를 모델 nif 의 바인드 회전과 비교했다. 6가지 순서 중 이 순서만 중앙값 오차 0.01도이고
  나머지는 3.7~19.4도다. 단위도 같은 방법으로 봤다 (각이 0.5 라디안 넘는 표본 6,696개에서 라디안 0.01도, 도 103도).
- **사원수 키**: 값은 w, x, y, z 순서다 (보간기의 기본값 자리도 같다).
- **기본값 자리**: 곡선이 있으면 보간기의 이동/회전/배율 자리는 NaN (`0xffff7fff`) 으로 채워져 있다.
  B-spline 의 치우침/배율도 안 쓰면 FLT_MAX 다. 둘 다 "값 없음" 으로 보고 무시해야 한다.

**B-spline 압축** (kf 의 97%가 쓴다):
- 차수 3 고정. 노트 벡터는 양끝이 물린 균등 노트라, 매개변수 범위가 0 ~ (제어점 수 - 3) 이다.
  시간은 `(t - 시작) / (끝 - 시작)` 으로 0~1 로 만든 뒤 이 범위로 늘려 쓴다.
- 제어점은 `NiBSplineData` 의 i16 배열에 모든 채널이 한 줄로 들어 있고, 보간기의 오프셋이 시작 위치 (i16 개수 단위) 다.
  `0xffff` 는 그 채널이 없다는 뜻이다. 성분은 제어점마다 묶여 있다 (이동이면 x, y, z, x, y, z, ...).
- 복원 공식은 **`값 = i16 / 32767 * 배율 + 치우침`** 이다 (치우침이 가운데 값, 배율이 반폭).
  확인 방법 둘: (1) 뼈 1,099개의 이동 채널을 바인드 자세와 비교하면 중앙값 오차 0.017 (다른 후보 공식은 24.8),
  (2) 회전 채널 115,031개를 평가한 사원수 길이 중앙값이 0.9996 이다 (정규화 전 값).
- 제어점 수 = 프레임 수 + 2 다 (예: 3.3333초 = 30fps 로 100 프레임이면 102개).

**glTF 로 옮길 때**:
- glTF 애니메이션은 STEP/LINEAR/CUBICSPLINE 뿐이라 B-spline, 2차 키, 오일러 곡선을 그대로 담을 수 없다.
  전부 **30fps 로 값을 떠서 LINEAR 키**로 낸다 (원본이 30fps 로 만들어졌으므로 표본이 원래 키와 거의 겹친다).
- 값이 내내 같은 채널은 키 하나로 줄인다. 뼈는 대개 이동과 배율이 고정이라 이것만으로 용량이 크게 준다.
- 사원수 표본은 이웃끼리 부호를 맞춰야 한다 (`q` 와 `-q` 는 같은 회전이지만, 부호가 튀면 재생기가 먼 쪽으로 돈다).
- nif 의 배율은 값 하나지만 glTF 는 축마다 따로라 세 번 적는다.
- kfm 이 가리키는 kf 가 팩에 없는 경우가 있다 (1,137개 모델에서 84건). 그 동작만 빼고 나머지는 그대로 만든다.

## 10. 모델과 텍스처

### 10-1. 디지몬 id 에서 파일까지
```
디지몬 id
 -> digimonlistdata.bin 레코드 +28 = 모델 id
 -> data\model.dat 에서 모델 id 의 .kfm 경로 (예: Data\Digimon\Vamdemon_Move\0010001_vamdemon.kfm)
 -> .kfm 안의 .nif 이름과 .kf 목록 (.\ = kfm 이 있는 폴더)
 -> 같은 폴더의 .tga / .dds
```
- .kfm 은 텍스트와 바이너리가 섞인 형식. **4자 이상 인쇄 가능한 ASCII 문자열만 뽑으면** 첫 `.nif` 와 `.kf` 목록이 나온다.
- nif 이름이 폴더 이름과 다를 수 있다 (`icedevimon2.nif`, `0093306_Agumon.nif`). 항상 kfm 을 따라간다.
- 한 폴더에 kfm 이 여럿 있을 수 있다 (디지몬판, NPC판).
- 파일 이름 규칙: `<모델id>_<이름>_<동작>.kf`, 스킬 애니 `<모델id><2자리>_...kf`, 텍스처 `<모델id>_<이름>s/l/xl.tga` (크기별) 와 `_evo.tga`.

### 10-2. nif 안의 텍스처와 뼈
- 텍스처는 대부분 **내장** (`NiPersistentSrcTextureRendererData`, 픽셀 앞에 u32 4개: 가로, 세로, face 수, 플랫폼).
- `NiSourceTexture` 의 이름은 원래 작업 파일명이다 (`agumon_x.dds`, `d:\digimonmasters\data\digimon\agumon\agumon_x.tga`). 팩 안의 실제 파일명과 **다르다**. 외부 텍스처가 필요하면 같은 폴더의 `.tga`/`.dds` 목록에서 고른다.
- 뼈 이름 규칙이 모델마다 다르다: `Bip01 *`, `Bip001 *`, `Bone*`.
- 모델 파츠는 스무스 스키닝이 아니라 뼈 하나에 강체로 붙은 구조 (Bone Parent) 가 많다.

### 10-3. glTF 변환 함정
1. **Bone Parent 이중 변환**: 스키닝으로 바꿀 때 현재 월드 위치를 **정점 데이터에** 굽고, 오브젝트 변환은 단위 행렬로 초기화한 뒤 다시 붙인다. 오브젝트 변환에만 옮기면 뼈 변형과 겹쳐 두 번 움직인다. 눈이나 손끝처럼 오프셋이 큰 뼈에서 드러난다.
2. **텍스처 이름 불일치** (10-2): 못 찾으면 빈 이미지로 조용히 대체되지 않게, 실제 파일로 바꿔 준다.
3. **재질**: glTF 는 PBR 이다. Base Color 에 텍스처를 잇고 Metallic 0 으로 둔다. 안 하면 새까맣게 나온다.

참고 도구: NifSkope (nif 20.3.0.9 열람, 내장 텍스처 추출), Blender 3.6 LTS + io_scene_niftools v0.1.1 (4.0 이상 미지원). 결과 대조용.

## 11. 함정

**팩, 복호**
- HF blob 의 4바이트 미정렬 꼬리는 **버리고**, 파일 payload 의 꼬리는 **상위 바이트 규칙으로 푼다**. 방향이 반대라 헷갈린다.
- Blowfish 는 리틀엔디안 블록. 표준 구현을 그대로 쓰면 쓰레기가 나온다.
- zlib 은 헤더 검사를 통과할 때만 푼다.

**표 해석**
- 파서는 항상 "정확히 파일 끝까지" 검사.
- 바이너리에서 값을 찾을 때는 **1바이트 간격**으로 훑는다. 정렬 안 된 레코드가 흔하다.
- 표 뒤에 블록이 더 붙어 있는 경우가 있다.
- KDMO 데이터에도 틀린 값이 있다 (model.dat 크기가 1/1/1 인 모델 등). 다른 레코드와 비교한다.

**리소스**
- 마젠타 단색 사각형 = 텍스처 파일을 못 찾은 것. 픽셀 형식보다 경로부터 본다. 코드 안 경로 문자열의 역슬래시 이스케이프 (`\a` 등) 주의.
- nif 문자열 표에 `g:\my projects\dmoprojects\...`, `d:\imagems\flame\...`, `c:\users\m\desktop\pack01` 같은 경로가 있으면 팬 리메이크 파일 (사설 서버 배포본). 원본은 KDMO pack01.

## 12. 구현 확인값

| 확인 | 기대값 |
|---|---|
| HF 헤더 | `version == 0x13`, `blobLen == 파일 크기 - 8` |
| 인덱스 | 풀린 길이 `4 + count*24`. KDMO pack01 51,006, Pack02 295 |
| 해시 | 3절 표의 3개 |
| 경로 청크 | 모든 항목에서 청크 경로의 해시 == 인덱스 해시 |
| 테이블 복호 | digimonlistdata.bin 187,856 B, 첫 u32 876 |
| XorTwist 꼬리 | `orig % 4 != 0` 인 표가 끝까지 읽기 검사를 통과 |
| model.dat | 1,111개, 파일 끝에서 정확히 끝남 |
| nif | 앞 38바이트 `Gamebryo File Format, Version 20.3.0.9`, 블록 크기 표 + footer 로 파일 끝 일치 |
| nif 블록 | 해석하는 블록은 읽은 바이트 수 == 크기 표 값 (9-1). KDMO 13,583개 전부 통과 (빅엔디안 1개 제외) |
| 내장 텍스처 | KDMO 68,378개 전부 디코드 성공 |
| GLB | glTF Validator 오류 0. KDMO nif 13,584개 중 12,795개 변환, 나머지는 파티클 전용 532, `CsNiNode` 맵 203, 형상 없음 53, 빅엔디안 1 |
