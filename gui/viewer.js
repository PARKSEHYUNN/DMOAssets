/**
 * @file viewer.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-23
 */

/**
 * three.js 모델 뷰어 (렌더러 쪽 코드).
 *
 * core 가 만든 GLB 를 그대로 띄운다. 내보내기와 미리보기가 같은 길을 쓰므로,
 * 화면에서 이상하게 보이면 내보낸 파일도 이상한 것이다.
 * 계속 그리면 GPU 를 계속 먹으므로 카메라가 움직였을 때와 창 크기가 바뀔 때만 다시 그린다.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/** @type {THREE.WebGLRenderer | null} 한 번만 만들어 두고 계속 쓴다 */
let renderer = null;
/** @type {THREE.Scene | null} */
let scene = null;
/** @type {THREE.PerspectiveCamera | null} */
let camera = null;
/** @type {OrbitControls | null} */
let controls = null;
/** @type {THREE.Object3D | null} 지금 올라가 있는 모델 */
let model = null;

/**
 * 한 번만 하는 준비: 렌더러, 조명, 카메라, 궤도 조작.
 * @param {HTMLCanvasElement} canvas 그릴 캔버스
 */
function init(canvas) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);

    scene = new THREE.Scene();
    // 배경은 화면 색과 맞춘다 (index.html 의 --bg)
    scene.background = new THREE.Color(0x1e1e22);
    // 게임 조명을 흉내 내는 것이 아니라 모양을 보기 위한 조명이다.
    // 위/아래에서 오는 빛 + 정면 빛이면 어느 각도에서도 검게 죽지 않는다
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 2.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(1, 2, 3);
    scene.add(key);

    // near/far 는 모델을 올릴 때 크기에 맞춰 다시 정한다 (모델이 수 백 단위라 기본값이면 잘린다)
    camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100000);
    controls = new OrbitControls(camera, canvas);
    // 관성을 끄면 움직인 순간에만 다시 그리면 된다
    controls.enableDamping = false;
    controls.addEventListener("change", render);

    // 캔버스 크기가 바뀌면 렌더러와 카메라 비율을 맞춘다
    new ResizeObserver(resize).observe(canvas);
}

/**
 * 한 장 그린다.
 */
function render() {
    if (renderer && scene && camera) renderer.render(scene, camera);
}

/**
 * 캔버스 크기에 맞춰 렌더러와 카메라를 고친다.
 */
export function resize() {
    if (!renderer) return;
    const canvas = renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    // 세 번째 인자 false: CSS 크기는 건드리지 않고 그리기 해상도만 맞춘다
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
}

/**
 * 올라가 있는 모델을 치우고 GPU 메모리를 돌려준다.
 * three.js 는 지오메트리, 재질, 텍스처를 직접 버려야 한다 (안 하면 모델을 볼수록 메모리가 쌓인다).
 */
export function clearModel() {
    if (!model) return;
    scene.remove(model);
    model.traverse((o) => {
        o.geometry?.dispose();
        for (const m of [o.material].flat()) {
            if (!m) continue;
            m.map?.dispose();
            m.dispose();
        }
    });
    model = null;
    render();
}

/**
 * GLB 한 덩어리를 띄운다.
 * @param {HTMLCanvasElement} canvas 그릴 캔버스
 * @param {Uint8Array} bytes GLB 내용
 * @returns {Promise<{ size: number[], meshes: number }>} 모델 크기와 메시 수 (상태 줄에 쓴다)
 */
export async function showModel(canvas, bytes) {
    if (!renderer) init(canvas);
    clearModel();

    // 파일로 저장하지 않고 메모리에서 바로 읽는다
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const gltf = await new GLTFLoader().parseAsync(buffer, "");
    model = gltf.scene;
    scene.add(model);

    // 모델 크기에 맞춰 카메라를 잡는다. 가장 긴 변의 두 배쯤 떨어져서 살짝 위에서 본다
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) || 1;
    camera.near = radius / 100;
    camera.far = radius * 100;
    camera.position.set(center.x, center.y + radius * 0.25, center.z + radius * 2);
    controls.target.copy(center);
    controls.update();
    resize();

    let meshes = 0;
    model.traverse((o) => {
        if (o.isMesh) meshes++;
    });
    return { size: [size.x, size.y, size.z], meshes };
}
