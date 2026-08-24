# 제안 — 이름 붙은 자원의 용도를 규칙에 넣는다

상태: 제안. 적용하지 않았다.
대상: `nix/home/configs/.agents/AGENTS.md`, `## Clarify -> Read -> Diagnose -> Act` 절, 7번째 줄.

## 무엇을 고치는가

기존 자원 하나를 새 용도에 끌어 쓸 때, 에이전트가 이름 검색의 히트를 용도의 증거로 삼는 실패가 있었다. 버킷, 큐, 테이블, 시크릿, 채널, 프로젝트가 모두 같은 모양으로 당한다.

이 실패는 이미 있는 줄이 금지한다.

> read relevant files (never by filename alone)

이름만으로 고른 것이 파일이 아니라 자원이었을 뿐이다. 그래서 새 규칙을 만들지 않는다. 있는 줄에 사례를 붙인다.

## 왜 새 줄이나 새 훅이 아닌가

**새 줄이 아닌 이유.** 같은 금지를 다른 단어로 두 번 쓰면 규칙 파일이 희석된다. 어느 줄도 무게를 갖지 못한다.

**새 훅이 아닌 이유.** "이 자원이 내가 필요한 자원과 같은가"는 기계가 검사할 수 있는 술어가 아니다. `s3://` 패턴을 잡는 훅은 다음 사례가 큐나 채널일 때 침묵한다. 사건마다 훅을 하나씩 붙이는 것은 대책이 아니라 사건 목록이다.

**사례를 붙이는 이유.** 이 파일의 규칙들은 사건을 품어서 작동한다. `DO (restate)`는 "말귀를 못알아듣냐"를 품고, `DO (data)`는 "한 그룹이 아니신데요"를 품는다. 사건이 붙은 줄은 추상적이지 않아서 통과하기 어렵다. 이 줄에는 자원 선택 사례가 없다.

## 변경 전

```
- DO: clarify ambiguous referents -> read relevant files (never by filename alone) -> diagnose root cause -> act; on a bug fix, grep every caller of the function you touch and fix the shared function once, not just the one path the report names
```

## 변경 후

```
- DO: clarify ambiguous referents -> read relevant files (never by filename alone) -> diagnose root cause -> act; on a bug fix, grep every caller of the function you touch and fix the shared function once, not just the one path the report names
- DO (resource): before you put an existing named resource -- a bucket, a queue, a table, a secret, a channel, a project -- to a new use, quote the purpose it is documented for and say that purpose is the one you need; a name-search hit is evidence of a name, never of a purpose, and a doc's mechanical permission to share ("several fleets can share one bucket") is not semantic permission -- picking a bucket because its variable name matched `bucket` drew "vibe logs bucket은 다른 목표잖아. 의미론 안 따져?"
```

기존 줄은 그대로 둔다. 바로 아래에 `DO (resource):` 한 줄을 넣는다. 절 안의 다른 `DO (...)` 줄들과 같은 형태다.

## 한계

산문 규칙이고, 산문은 위반된다. 이 실패가 산문으로만 표현되는 종류라서 택한 것이다. 기계 검사로 옮길 수 있는 부분이 나중에 보이면 그때 훅으로 내린다.
