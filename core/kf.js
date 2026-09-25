/**
 * @file kf.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-25
 */

/**
 * kf 애니메이션을 시간 표본으로 바꾼다 (FORMAT 9-3).
 * 
 * kf 파일은 nif 와 같은 형식이라 파싱은 nif.js 가 한다. 여기서는 파싱된 블록에서
 * "노드 이름마다 시간별 이동/회전/크기" 를 뽑는다.
 * 
 * 곡선 종류가 네 가지 (선형 키, 2차 키, 오일러 XYZ 키, B-spline 압축) 인데,
 * glTF 는 이 중 어느 것도 그대로 담지 못한다. 그래서 전부 30fps 로 값을 떠서
 * 선형 키로 낸다. 원본이 30fps 로 만들어진 데이터라 (FORMAT 9-3) 표본이 원래 키와 거의 겹친다.
 */

/** 초당 표본 수. 원본 애니가 30fps 기준이다 (FORMAT 9-3) */
export const ANIM_FPS = 30;
/** Gamebryo B-spline 차수 (항상 3차) */
const DEGREE = 3;
/** 채널을 쓰지 않는다는 표시 (B-spline 오프셋) */
const NO_OFFSET = 0xffff;
/** 짧은 정수 제어점의 최대값 (FORMAT 9-3) */
const SHORT_MAX = 32767;
/** 보간 종류: 1 선형, 2 2차 (에르미트), 3 TBC, 4 오일러 XYZ */
const QUADRATIC = 2;

/**
 * "값 없음" 표시인지 본다. 안 쓰는 기본값 자리는 NaN 이나 FLT_MAX 로 채워져 있다 (FORMAT 9-3)
 * @param {number} v 검사할 값
 * @returns {boolean} 값이 없다는 뜻이면 true
 */
function unset(v) {
    return Number.isNaN(v) || Math.abs(v) > 3.0e38;
}

/** 
 * 3차 B-spline 을 드 부어 (de Boor) 로 평가한다.
 * 노트 벡터는 양끝이 물린 균등 노트다: 앞뒤로 차수+1 개가 겹치고 가운데는 1씩 늘어난다.
 * 그래서 매개변수 범위가 0 부터 (제어점 수 - 차수) 까지다.
 * @param {number[]} cps 제어점 (성분이 이어 붙은 형태)
 * @param {number} width 성분 수 (이동 3, 회전 4, 크기 1)
 * @param {number} u 매개변수 (0 ~ 제어점 수 - 3)
 * @returns {number[]} 그 지점의 값
*/
function deBoor(cps, width, u) {
    const n = cps.length / width;
    // 노트 값: 앞 4개는 0, 뒤 4개는 n-3, 가운데는 i-3
    const knot = (i) => (i <= DEGREE ? 0 : i >= n ? n - DEGREE : i - DEGREE);
    // u 가 들어가는 구간을 찾는다
    let k = DEGREE;
    while (k < n - 1 && u >= knot(k + 1)) k ++;
    // 그 구간에 영향을 주는 제어점 4개만 가져와 섞는다
    const d = [];
    for (let j = 0; j <= DEGREE; j ++) {
        const at = (k - DEGREE + j) * width;
        d.push(cps.slice(at, at + width));
    }
    for (let r = 1; r <= DEGREE; r ++) {
        for (let j = DEGREE; j >= r; j --) {
            const i = k - DEGREE + j;
            const lo = knot(i);
            const hi = knot(i + DEGREE - r + 1);
            const a = hi === lo ? 0 : (u - lo) / (hi - lo);
            d[j] = d[j].map((v, c) => (1 - a) * d[j - 1][c] + a * v);
        }
    }
    return d[DEGREE];
}

/**
 * B-spline 채널 하나의 표본 함수를 만든다.
 * 제어점은 짧은 정수로 눌려 있다: 값 = 정수 / 32767 * 배율 + 치우침 (FORMAT 9-3).
 * @param {object} data NiBSplineData 블록
 * @param {number} count 제어점 수 (NiBSplineBasisData)
 * @param {number} offset 이 채널의 제어점 시작 위치 (짧은 정수 개수 단위)
 * @param {number} width 성분 수
 * @param {number} bias 치우침
 * @param {number} multiplier 배율
 * @param {number} start 애니 시작 시각
 * @param {number} stop 애니 끝 시각
 * @returns {(t: number) => number[]} 시간을 주면 값을 내는 함수
 */
function bsplineSampler(data, count, offset, width, bias, multiplier, start, stop) {
    const cps = new Array(count * width);
    for (let i = 0; i < cps.length; i ++) cps[i] = (data.shorts[offset + i] / SHORT_MAX) * multiplier + bias;
    const span = stop - start;
    return (t) => {
        // 시간을 매개변수 범위 (0 ~ 제어점 수 - 3) 로 옮긴다
        const f = span > 0 ? (t - start) / span : 0;
        return deBoor(cps, width, Math.min(1, Math.max(0, f)) * (count - DEGREE));
    };
}

/**
 * 키 목록에서 시간 t 의 값을 뽑는다.
 * 2차 키는 앞 키의 forward 와 뒤 키의 backward 를 접선으로 쓰는 에르미트 곡선이다.
 * @param {object} group KeyGroup (interpolation, keys)
 * @param {number} width 성분 수
 * @param {number} t 시각
 * @returns {number[]} 값
 */
function keyValue(group, width, t) {
    const keys = group.keys;
    if (t <= keys[0].time) return keys[0].value;
    const last = keys[keys.length - 1];
    if (t >= last.time) return last.value;
    // 키가 많아야 수백 개라 앞에서부터 찾아도 된다
    let i = 1;
    while (i < keys.length - 1 && keys[i].time < t) i ++;
    const a = keys[i - 1];
    const b = keys[i];
    const dt = b.time - a.time;
    const f = dt > 0 ? (t - a.time) / dt : 0;
    if (group.interpolation === QUADRATIC && a.tangents && b.tangents) {
        // 에르미트 기저: h1 은 앞 값, h2 는 뒤 값, h3 은 앞 키의 나가는 접선, h4 는 뒤 키의 들어오는 접선
        const f2 = f * f;
        const f3 = f2 * f;
        const h1 = 2 * f3 - 3 * f2 + 1;
        const h2 = -2 * f3 + 3 * f2;
        const h3 = f3 - 2 * f2 + f;
        const h4 = f3 - f2;
        const out = new Array(width);
        for (let c = 0; c < width; c++) out[c] = h1 * a.value[c] + h2 * b.value[c] + h3 * a.tangents[0][c] + h4 * b.tangents[1][c];
        return out;
    }
    const out = new Array(width);
    for (let c = 0; c < width; c ++) out[c] = a.value[c] + (b.value[c] - a.value[c]) * f;
    return out;
}

/**
 * 사원수 두 개를 보간한다. 둘 다 [x, y, z, w] 순서다.
 * @param {number[]} a 앞 사원수
 * @param {number[]} b 뒤 사원수
 * @param {number} f 0~1
 * @returns {number[]} 보간한 사원수
 */
function slerp(a, b, f) {
    let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    // 짧은 쪽으로 돌도록 한쪽 부호를 뒤집는다 (사원수는 q 와 -q 가 같은 회전이다)
    let q = b;
    if (dot < 0) {
        q = b.map((v) => -v);
        dot = -dot;
    }
    // 거의 같은 방향이면 선형 보간해도 차이가 없다 (각이 0 이면 나눗셈이 터진다)
    if (dot > 0.9995) return a.map((v, i) => v + (q[i] - v) * f);
    const theta = Math.acos(dot);
    const sin = Math.sin(theta);
    const wa = Math.sin((1 - f) * theta) / sin;
    const wb = Math.sin(f * theta) / sin;
    return a.map((v, i) => v * wa + q[i] * wb);
}

/**
 * 축 하나를 도는 사원수 [x, y, z, w].
 * @param {number} axis 0 = X, 1 = Y, 2 = Z
 * @param {number} angle 라디안
 * @returns {number[]}
 */
function axisQuat(axis, angle) {
    const s = Math.sin(angle / 2);
    const c = Math.cos(angle / 2);
    return axis === 0 ? [s, 0, 0, c] : axis === 1 ? [0, s, 0, c] : [0, 0, s, c];
}

/**
 * 사원수 곱 (행렬 곱과 같은 순서: 결과는 b 를 먼저, a 를 나중에 적용한 회전).
 * @param {number[]} a 나중에 적용할 회전
 * @param {number[]} b 먼저 적용할 회전
 * @returns {number[]}
 */
function mulQuat(a, b) {
    return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
}

/**
 * nif 사원수 [w, x, y, z] 를 glTF 순서 [x, y, z, w] 로 바꾼다.
 * @param {number[]} q nif 사원수
 * @returns {number[]}
 */
function toGltfQuat(q) {
    return [q[1], q[2], q[3], q[0]];
}

/**
 * 컨트롤러 하나 (노드 하나) 의 이동/회전/크기 표본 함수를 만든다.
 * 곡선이 없는 채널은 보간기에 적힌 기본값으로 고정한다. 기본값마저 없으면 (NaN) null 을 준다.
 * @param {import("./nif.js").Nif} kf 파싱한 kf
 * @param {object} interp 보간기 블록
 * @returns {{ translation: Function | null, rotation: Function | null, scale: Function | null, fixed: object }} 채널별 표본 함수와, 곡선 없이 고정값인지 표시
 */
function transformSamplers(kf, interp) {
    const fixed = { translation: false, rotation: false, scale: false };
    let translation = null;
    let rotation = null;
    let scale = null;

    if (interp.type === "NiTransformInterpolator") {
        const data = interp.data != null ? kf.blocks[interp.data] : null;
        if (data?.translations.keys.length) {
            translation = (t) => keyValue(data.translations, 3, t);
        } else if (!unset(interp.translation[0])) {
            translation = () => interp.translation;
            fixed.translation = true;
        }
        if (data?.euler) {
            // 오일러 XYZ 키: 축마다 곡선이 따로 있다. X 를 먼저, 그 다음 Y, 마지막 Z 를 적용한다 (FORMAT 9-3)
            rotation = (t) => {
                const x = data.euler[0].keys.length ? keyValue(data.euler[0], 1, t)[0] : 0;
                const y = data.euler[1].keys.length ? keyValue(data.euler[1], 1, t)[0] : 0;
                const z = data.euler[2].keys.length ? keyValue(data.euler[2], 1, t)[0] : 0;
                return mulQuat(axisQuat(2, z), mulQuat(axisQuat(1, y), axisQuat(0, x)));
            };
        } else if (data?.rotations.length) {
            const keys = data.rotations;
            rotation = (t) => {
                if (t <= keys[0].time) return toGltfQuat(keys[0].value);
                const last = keys[keys.length - 1];
                if (t >= last.time) return toGltfQuat(last.value);
                let i = 1;
                while (i < keys.length - 1 && keys[i].time < t) i ++;
                const a = keys[i - 1];
                const b = keys[i];
                const dt = b.time - a.time;
                return slerp(toGltfQuat(a.value), toGltfQuat(b.value), dt > 0 ? (t - a.time) / dt : 0);
            };
        } else if (!unset(interp.rotation[0])) {
            const q = toGltfQuat(interp.rotation);
            rotation = () => q;
            fixed.rotation = true;
        }
        if (data?.scales.keys.length) {
            scale = (t) => keyValue(data.scales, 1, t);
        } else if (!unset(interp.scale)) {
            scale = () => [interp.scale];
            fixed.scale = true;
        }
    } else if (interp.type === "NiBSplineCompTransformInterpolator") {
        const data = interp.splineData != null ? kf.blocks[interp.splineData] : null;
        const basis = interp.basisData != null ? kf.blocks[interp.basisData] : null;
        const count = basis?.controlPoints ?? 0;
        const has = (offset) => data && count > DEGREE && offset !== NO_OFFSET;
        if (has(interp.translationOffset)) {
            translation = bsplineSampler(data, count, interp.translationOffset, 3, interp.translationBias, interp.translationMultiplier, interp.start, interp.stop);
        } else if (!unset(interp.translation[0])) {
            translation = () => interp.translation;
            fixed.translation = true;
        }
        if (has(interp.rotationOffset)) {
            const raw = bsplineSampler(data, count, interp.rotationOffset, 4, interp.rotationBias, interp.rotationMultiplier, interp.start, interp.stop);
            // 곡선으로 섞은 사원수는 길이가 1 이 아니다. 길이를 맞춰야 회전만 남는다
            rotation = (t) => {
                const q = toGltfQuat(raw(t));
                const len = Math.hypot(q[0], q[1], q[2], q[3]);
                return len > 0 ? q.map((v) => v / len) : [0, 0, 0, 1];
            };
        } else if (!unset(interp.rotation[0])) {
            const q = toGltfQuat(interp.rotation);
            rotation = () => q;
            fixed.rotation = true;
        }
        if (has(interp.scaleOffset)) {
            scale = bsplineSampler(data, count, interp.scaleOffset, 1, interp.scaleBias, interp.scaleMultiplier, interp.start, interp.stop);
        } else if (!unset(interp.scale)) {
            scale = () => [interp.scale];
            fixed.scale = true;
        }
    }
    return { translation, rotation, scale, fixed };
}

/**
 * 표본을 떠서 채널 하나 만든다. 값이 내내 같으면 키 하나로 줄인다 (뼈 대부분은 이동과 크기 고정이다).
 * @param {Function} sampler 시간을 주면 값을 내는 함수
 * @param {number[]} times 표본 시각
 * @param {number} width 성분 수
 * @param {boolean} fixed 곡선 없이 고정값인 채널
 * @returns {{ times: number[], values: number[] }}
 */
function sampleChannel(sampler, times, width, fixed) {
    if (fixed) return { times: [0], values: sampler(times[0]).slice() };
    const values = [];
    for (const t of times) values.push(...sampler(t));
    // 사원수는 이웃끼리 같은 반구에 있어야 짧은 쪽으로 돈다 (glTF는 부호까지 그대로 읽는다)
    if (width === 4) {
        for (let i = 4; i < values.length; i += 4) {
            let dot = 0;
            for (let c = 0; c < 4; c ++) dot += values[i - 4 + c] * values[i + c];
            if (dot < 0) for (let c = 0; c < 4; c ++) values[i + c] = -values[i + c];
        }
    }
    // 값이 모두 같으면 키 하나로 충분하다
    const same = values.every((v, i) => Math.abs(v - values[i % width]) < 1e-6);
    if (same) return { times: [0], values: values.slice(0, width) };
    return { times: times.map((t) => t - times[0]), values };
}

/**
 * NiControllerSequence 하나를 표본 트랙으로 바꾼다.
 * @param {import("./nif.js").Nif} kf 파싱한 kf
 * @param {object} seq NiControllerSequence 블록
 * @param {number} [fps] 초당 표본 수
 * @returns {{ name: string, duration: number, tracks: object[] }} 애니메이션 하나
 */
export function sampleSequence(kf, seq, fps = ANIM_FPS) {
    const duration = Math.max(0, seq.stop - seq.start);
    // 표본 시각: 시작부터 끝까지 1/fps 간격. 길이가 0이면 한 장만 뜬다
    const steps = Math.max(1, Math.round(duration * fps));
    const times = [];
    for (let i = 0; i <= steps; i ++) times.push(seq.start + (duration * i) / steps);
    
    const tracks = [];
    for (const cb of seq.controlled) {
        const interp = cb.interpolator != null ? kf.blocks[cb.interpolator] : null;
        if (!interp || !cb.node) continue;
        const { translation, rotation, scale, fixed } = transformSamplers(kf, interp);
        if (!translation && !rotation && !scale) continue;
        tracks.push({
            node: cb.node,
            translation: translation ? sampleChannel(translation, times, 3, fixed.translation) : null,
            rotation: rotation ? sampleChannel(rotation, times, 4, fixed.rotation) : null,
            scale: scale ? sampleChannel(scale, times, 1, fixed.scale) : null,
        });
    }
    return { name: seq.name ?? "anim", duration, tracks };
}

/**
 * kf 파일 하나에 들어 있는 모든 시퀀스를 표본으로 바꾼다 (보통 하나다).
 * @param {import("./nif.js").Nif} kf 파싱한 kf
 * @param {number} [fps] 초당 표본 수
 * @returns {object[]} 애니메이션 목록
 */
export function sampleAnimations(kf, fps = ANIM_FPS) {
    return kf.blocks.filter((b) => b.type === "NiControllerSequence").map((seq) => sampleSequence(kf, seq, fps));
}