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

## 개요 and 작업 내역 — the user's own body

The shape comes from the user's hand rewrite of an agent's draft (<repo> PR <n>, 2026-11-12). The 개요 gives the origin of the change. Each item is `영역 라벨: 한 문장` in 한다체. The breaking item's sub-items give each legacy case its own background and reason, so two cases never blur into one sentence. The last item states its cause once with the resulting actions under it.

```markdown
## 개요

v2 문서에 있는 VideoSource 개념을 사전 도입해 HttpSource, unstable_LocalSource를 구현한다.

## 작업 내역

- JS → Native: `source`를 Externally Tagged `{ http } | { local }` Union으로 전송한다.
- iOS DRM Key 리팩토링: Online/Offline DRM struct 각각이 ContentKeyResponder를 구현하도록 추상화한다.
- **[BREAKING]** 키 없는 오프라인 재생을 만료로 처리한다.
  - 저장된 키가 없는 보호 다운로드는 저장된 토큰으로 Online DRM 라이선스를 받아 재생되고 있었다.
  - 이는 오프라인 재생을 예상하는 사용자에게 혼동을 주므로 만료 처리한다.
- 네이티브 Source 형태가 바뀌었기 때문에
  - 네이티브 계약 버전을 1 올린다.
  - 기존 prop을 변환하는 경로를 추가한다.
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

## What the size difference looks like

The user once rewrote an agent's body by hand: about 2,900 bytes became about 400, the same scope in a seventh of the space. The before-and-after shape is in `docs/src/agent-incidents.md` under the 2026-09-22 entry "the user rewrote an agent's PR body and cut it to a seventh".
