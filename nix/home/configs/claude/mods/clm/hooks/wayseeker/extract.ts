import { append, type Ledger } from './store'
import { printLine } from './syntax'

/**
 * Per-user-message extraction: Sonnet turns one user message (with the
 * assistant reply it answers) into wayseeker L1 lines, and each line lands in
 * the ledger through store.append on its own, so one invalid line never costs
 * the turn its valid ones. Design: wayseeker-lang page, U3 and L1/L2.
 */

export type ExtractIo = {
  complete: (request: { model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }) => Promise<{ isAnswered: boolean; text: string; reason: string }>
}

/**
 * Few-shot cases. U3 keeps the prompt open: whenever an utterance is extracted
 * wrongly, append the utterance and its correct lines here (and adjust
 * EXTRACT_SYSTEM if a rule was missing). Numbering in a case starts at @1 and
 * stands for "the next id"; the prompt says so.
 */
export type ExtractCase = { assistant?: string; user: string; lines: string[]; why: string }

export const EXTRACT_CASES: ExtractCase[] = [
  {
    user: '뭘 써야할까?',
    lines: ['@1 user: ask(use(server, ?x))'],
    why: 'A fill-in question: the blank is a named variable.',
  },
  {
    user: 'sglang 써볼까?',
    lines: ['@1 user: try(use(server, sglang))'],
    why: 'A "shall we try" from the user stays a proposal, not a directive.',
  },
  {
    assistant: 'sglang 어때요?',
    user: 'ㅇㅇ 그걸로',
    lines: ['@1 agent: try(use(server, sglang))', '@2 user: accept(@1)'],
    why: 'A short reply picks the proposal it answers: record the assistant proposal as an agent line, then accept it by number.',
  },
  {
    user: '아 sglang 말고 vllm',
    lines: ['@1 user: say(use(server, vllm))'],
    why: 'A correction is a new say; the key of use replaces the old value.',
  },
  {
    user: '우리에겐 Suspense가 있다… isLoading을 굳이 상태로?',
    lines: [
      'decl have(feature) key(feature) "{feature}을 갖추고 있다"',
      'decl need(thing) key(thing) "{thing}이 필요하다"',
      'suspense := "React Suspense"',
      'isloading_state := "isLoading을 컴포넌트 상태로 두는 것"',
      '@1 user: say(have(suspense) -> not(need(isloading_state)))',
    ],
    why: 'A Socratic question asserts the claim it aims at; extract that claim, not an ask.',
  },
  {
    user: '그거 아직 안 끝났잖아?',
    lines: ['@1 user: say(not(done(migration)))'],
    why: 'A rhetorical "~잖아?" asserts its content: say(p).',
  },
  {
    user: '와 정말 대단한 성능이네 ㅋㅋ 10초 걸리는 게',
    lines: ['@1 user: say(not(acceptable(latency)))'],
    why: 'Sarcasm is extracted by what the user means, here a complaint about latency.',
  },
  {
    assistant: 'vllm으로 바꿔 볼까요?',
    user: '일단 해봐',
    lines: ['@1 agent: try(use(server, vllm))', '@2 user: try(use(server, vllm)) -> report'],
    why: 'Try it and report back, then wait for acceptance. Use report whenever the nuance is unclear.',
  },
  {
    assistant: 'vllm으로 바꿔 볼까요?',
    user: '해보고 잘되면 바로 ㄱㄱ',
    lines: ['@1 agent: try(use(server, vllm))', '@2 user: try(use(server, vllm)) -> proceed'],
    why: 'An explicit "if it works, go ahead" proceeds without reporting.',
  },
  {
    user: 'python이면 fastapi 쓰고 django는 쓰지 마',
    lines: [
      '@1 user: use(lang, python) -> use(framework, fastapi)',
      '@1 user: use(lang, python) -> not(use(framework, django))',
    ],
    why: 'A condition is written p -> q; one message may yield several lines under the same @n.',
  },
  {
    user: '언어 바뀌는 건 꼭 물어봐',
    lines: ['@1 user: say(raise_on(lang))'],
    why: 'Feedback on conflict handling is an utterance too: raise_on(key) to ask, not(raise_on(key)) to resolve silently.',
  },
  {
    user: '테스트 러너는 그냥 알아서 바꿔',
    lines: ['@1 user: say(not(raise_on(test)))'],
    why: 'Resolve conflicts on this key by speaker rank without asking.',
  },
  {
    user: '릴리스는 빌드랑 문서 끝나야 해',
    lines: [
      '@1 user: want(done(release))',
      '@1 user: done(build), done(docs) -> ready(release)',
      '@1 user: ready(release) -> done(release)',
    ],
    why: 'A goal blocked by tasks: one want, the blockers as premises, and ready(g) -> done(g) for a goal that only groups tasks.',
  },
  {
    user: '테스트도 먼저 해야 돼',
    lines: ['@1 user: done(test) -> @12'],
    why: 'Adding a blocker to the live rule @12 puts its number in the conclusion slot.',
  },
  {
    user: '이 에러 로그대로 해 (retry 최대 3번이라고 적힌 로그)',
    lines: [
      'paste_1 := "retry 최대 3번"',
      '@1 paste_1: say(max(retry, 3))',
      '@2 user: want(follow(paste_1))',
    ],
    why: 'Pasted material is a speaker: an atom glossed with the text, its claims as its own lines; the user adopts it separately.',
  },
]

export const EXTRACT_SYSTEM = [
  'You convert one user chat message into wayseeker L1 ledger lines. Extract what the user means, read through the assistant reply the message answers.',
  '',
  'Line forms:',
  '- Utterance: @n speaker: kind(content). speaker is user, agent, or a pasted-material atom.',
  '- Condition utterance: @n speaker: p1, p2 -> q. The conclusion q is a fact, not(fact), report, proceed, or @m (adds premises to the live rule @m).',
  '- Declaration: decl name(col1, col2) key(col1) "sentence". The gloss is one Korean sentence that names every column as a {column} placeholder, e.g. decl use(role, tool) key(role) "{role}에 {tool}을 쓴다"; the ledger renders each fact by filling the placeholders with its atoms\' glosses. Key columns pick the slot: a new value with the same key replaces the old one. key() means one value for the whole predicate; listing every column makes a set.',
  '- Gloss: atom := "meaning". One gloss per atom; text lives only in glosses.',
  '',
  'The seven kinds, used only as the outermost wrapper:',
  '- say(p): assertion. Also evaluations, preferences, corrections (a new say), and denials as say(not(p)).',
  '- ask(p): question. A blank is a named variable like ?x; with no variable it is a yes/no question.',
  '- try(p): proposal. "~해볼까?" from the user stays a try.',
  '- want(p): directive or goal.',
  '- guess(p): estimate or suspicion.',
  '- accept(@n): adopts the proposal in utterance n. Short replies such as "ㅇㅇ", "ok", "A." become accept of the proposal they pick.',
  '- reject(@n): withdraws utterance n.',
  '',
  'Rules:',
  '- Write a fact as name(atom, atom). Arguments are bare atoms (lowercase snake_case, e.g. sglang, python) or named variables (?x, ?y). Give every variable a name.',
  '- Keep content to at most two levels: kind(not(fact)) or kind(fact). Put a kind only at the outermost position; when a guess belongs to a condition, write guess(p -> q).',
  '- Reuse a declared predicate or a glossed atom whenever its meaning fits, even when the user words it differently. Add a new decl line only when no declared predicate fits, with its gloss written as a {column} sentence, and a gloss line for each new atom.',
  '- Put decl and gloss lines before the utterances that use them.',
  '- Number the user message as @FIRST (given below); every line of that one message shares that number. When the message accepts, rejects or answers a proposal or question in the assistant reply that is not yet in the ledger, first record that assistant line as agent with @FIRST and give the user message @FIRST+1.',
  '- Read rhetorical, Socratic and sarcastic questions by their meaning: extract the claim they make with say, or the question they aim at.',
  '- "Try it" phrasing: try(p) -> report when the user wants results reported first; try(p) -> proceed only for an explicit "go ahead if it works". Choose report when the nuance is unclear.',
  '- Feedback about which conflicts to ask about becomes say(raise_on(key)) or say(not(raise_on(key))).',
  '- Withdrawal is reject(@n) of the earlier utterance.',
  '- When the message carries no claim, question, proposal or directive, output an empty block.',
  '',
  'Output: one fenced code block holding only L1 lines, one per line, with no commentary inside or outside the block.',
].join('\n')

const RECENT_UTTERANCES = 30
const FENCE = '\x60\x60\x60'

/** The ledger's vocabulary and recent lines, then the turn to convert. */
export function extractPrompt(ledger: Ledger, userMessage: string, prevAssistant: string, firstId: number): string {
  const decls = new Map(ledger.decls.map(decl => [decl.name, decl]))
  const glosses = new Map(ledger.glosses.map(item => [item.atom, item.gloss]))
  const declLines = [...decls.values()].map(decl => printLine(decl))
  const glossLines = [...glosses].map(([atom, gloss]) => atom + ' := ' + JSON.stringify(gloss))
  const recent = ledger.utterances.slice(-RECENT_UTTERANCES).map(utterance => printLine(utterance))
  const cases = EXTRACT_CASES.map((item, index) => [
    'Case ' + (index + 1) + ': ' + item.why,
    ...(item.assistant ? ['assistant: ' + item.assistant] : []),
    'user: ' + item.user,
    FENCE,
    ...item.lines,
    FENCE,
  ].join('\n'))
  return [
    '<declarations>', ...(declLines.length ? declLines : ['(none yet)']), '</declarations>',
    '<glosses>', ...(glossLines.length ? glossLines : ['(none yet)']), '</glosses>',
    '<recent_ledger>', ...(recent.length ? recent : ['(empty)']), '</recent_ledger>',
    '<cases note="@1 in a case stands for @FIRST, @2 for @FIRST+1">', cases.join('\n\n'), '</cases>',
    '<assistant_reply>', prevAssistant || '(none)', '</assistant_reply>',
    '<user_message>', userMessage, '</user_message>',
    'FIRST = ' + firstId + '. Write the L1 lines for this user message.',
  ].join('\n')
}

/** The lines inside the first fenced block; prose outside it never reaches the ledger. */
export function parseExtraction(text: string): string[] {
  const block = /\x60\x60\x60[^\n]*\n([\s\S]*?)\x60\x60\x60/.exec(text)
  if (!block?.[1]) return []
  return block[1].split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

const nextUtteranceId = (ledger: Ledger) => ledger.utterances.reduce((max, item) => Math.max(max, item.id), 0) + 1

export async function extractTurn(io: ExtractIo, ledger: Ledger, userMessage: string, prevAssistant: string): Promise<{ ledger: Ledger; appended: string[]; rejected: { line: string; errors: string[] }[] }> {
  const response = await io.complete({
    model: 'sonnet',
    system: EXTRACT_SYSTEM,
    prompt: extractPrompt(ledger, userMessage, prevAssistant, nextUtteranceId(ledger)),
    maxTokens: 2000,
    timeoutMs: 30_000,
  })
  if (!response.isAnswered) return { ledger, appended: [], rejected: [{ line: '', errors: ['not answered: ' + response.reason] }] }
  let current = ledger
  const appended: string[] = []
  const rejected: { line: string; errors: string[] }[] = []
  for (const line of parseExtraction(response.text)) {
    const result = append(current, line)
    if (result.ok) {
      current = result.ledger
      appended.push(line)
    } else {
      rejected.push({ line, errors: result.errors })
    }
  }
  return { ledger: current, appended, rejected }
}
