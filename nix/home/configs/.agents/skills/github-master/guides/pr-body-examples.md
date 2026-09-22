# PR body — worked examples

Specimens for the principles in `pr.md`. Read one when a principle there is clear but its shape is not; the principles alone are enough for a routine body.

## The work repos' template, verbatim

Four top-level headers, checklist boilerplate included. A body adds no `##` of its own, and anything extra goes in as a `###` under one of these.

```
## 개요
## 작업 내역
## 관련 카드
## 변경 체크리스트
- [ ] 변경 후 확인이 필요한 기능을 명시해주세요
- [ ] Ex) 작품이 iOS에서 재생
```

## 작업 내역 — one line per commit group

Three groups, one line each. Only the third earned a `리뷰 포인트:`, because the anchor choice is invisible in the diff.

```markdown
- 캐시 경로만이 문제였으므로 경로를 수정하고 캐시 히트를 확인
- 원격 빌드 캐시를 추가로 사용한다
- 리스트를 비반전 FlatList + 꼬리 500행 상주 창으로 구현
  - 리뷰 포인트: 창 고정 앵커를 길이가 아닌 머리 행 id로 잡은 이유(포화 시 길이 파생
    창은 읽던 행이 밀림)
```

## A measurement — one `A -> B (-N%p)` line

The user's own notation, including `%p` for a ratio change. Evidence is a link line, never a paragraph explaining which number came from what.

```markdown
### 실측 결과

- 빌드 시간 : 20분 -> 10분 (-50%p)
- 캐시 적중 태스크 : 700개 -> 450개 (-36%p)

증거: 1회차 (링크), 2회차 (링크)
```

A table earns its place only from three columns up, with a different kind of thing per row.

## 개조식 folded by cause

The root cause stands alone at the top level and every action it forced is indented under it.

```
- 테스트 러너 없음 -> vitest 구성
  - addon-vitest는 Vite 전용 -> webpack 쓰던 nextjs 대신 nextjs-vite로 교체
  - jest 계열 의존성 제거 -> happy-dom 사용 및 코드 정리
  - 테스트 코드 타입 검사 추가
  - 불필요한 playwright가 CI 타임 잡아먹음 -> 로컬 전용으로 격리 (unit + storybook 2 프로젝트 구성)
  - 기존 *-self-check.mjs 마이그레이션
```

The 개요 of that same body compresses the whole chain into one line: `저장소에 vitest 누락 -> pnpm test 실패 -> 도입해 해결 (+ 테스트 환경 표준화)`.

## What the size difference looks like

The user once rewrote an agent's body by hand: about 2,900 bytes became about 400, the same scope in a seventh of the space. The before-and-after shape is in `docs/src/agent-incidents.md` under the 2026-09-22 entry.
