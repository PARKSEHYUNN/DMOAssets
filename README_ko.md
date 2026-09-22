# DMOAssets

[English](README.md)

디지몬 마스터즈 온라인 (DMO) 클라이언트의 리소스를 보고 추출하는 도구입니다.

> **상태: 개발 중.** 아직 사용할 수 있는 기능이 없습니다.

## 기능 (계획)

- **GUI** (설치 없는 Windows EXE): DMO 설치 폴더를 지정하면 `.hf`/`.pf` 팩 안의 모든 파일을 탐색하고, 모델과 UI 이미지를 미리 보고, 추출할 수 있습니다.
- **CLI** (단일 EXE): 명령줄에서 팩을 풀고 모델을 변환합니다.
- **모델 내보내기**: GLB (glTF 2.0) 와 바이너리 FBX. 뼈, 스킨, 애니메이션을 포함합니다.
- **이미지 미리보기**: DDS (DXT1/3/5), TGA, PNG, BMP, JPG.

## 지원 클라이언트

| 클라이언트 | 상태 |
|---|---|
| KDMO (한국, MoveInteractive) | 지원 목표 |
| GDMO (글로벌, Steam) | 지원 목표 |
| 구 GDMO 클라이언트 (인덱스 버전 0x10, 사설 서버) | 지원 안 함 |

## 사용법 (계획)

```
dmoassets list    <DMO 폴더> [--filter <패턴>]
dmoassets extract <DMO 폴더> [--filter <패턴>] [-o <출력>]
dmoassets convert <.nif 또는 .kfm> -f glb|fbx [-o <출력>]
```

실행 전에 게임을 종료하세요. KDMO 는 실행 중에 팩 파일을 잠급니다.

## 개발

- Node.js 24, ESM, JavaScript + JSDoc 타입, 빌드 단계 없음
- GUI 는 Electron, CLI 는 Node SEA
- 테스트: `npm test` (`node --test`)

포맷 명세: [docs/FORMAT.md](docs/FORMAT.md).

## 라이선스

소스 코드는 [MIT 라이선스](LICENSE) 를 따릅니다. 이 라이선스는 이 프로젝트의 코드에만 적용되며 게임 리소스에는 적용되지 않습니다.

## 면책

비공식 팬 프로젝트입니다. Bandai Namco, MoveInteractive 등 디지몬 마스터즈 온라인 운영사와 관계가 없으며 승인받지 않았습니다. 게임 리소스의 저작권은 각 권리자에게 있습니다. 이 도구는 설치된 클라이언트의 파일을 읽기만 하고 수정하지 않습니다. 추출한 리소스는 개인 학습 용도로만 쓰고 재배포하지 마세요.
