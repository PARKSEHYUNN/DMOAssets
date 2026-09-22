/**
 * @file config.js
 * @author PARKSEHYUNN <parksehyun2024@gmail.com>
 * @created 2026-09-22
 */

// 테스트에서 쓸 DMO 설치 폴더 (Data 폴더) 경로
// 프로젝트 루트의 .env에 적는다 (.env.example 참고). npm test가 --env-file-if-exists 로 읽어 들인다.
// 값이 없으면 빈 문자열이 되고, 설치 폴더가 필요한 테스트는 skip 된다.

export const KDMO_DIR = process.env.DMO_KDMO_DIR ?? '';
export const GDMO_DIR = process.env.DMO_GDMO_DIR ?? '';