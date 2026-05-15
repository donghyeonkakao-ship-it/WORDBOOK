import fs   from 'fs';
import path from 'path';

const CACHE_DIR = path.join(process.cwd(), '.vocab-cache');
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30일

function readCache(word) {
  try {
    const file = path.join(CACHE_DIR, `${word.toLowerCase()}.json`);
    if (!fs.existsSync(file)) return null;
    const { cachedAt, data } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - cachedAt > CACHE_TTL) return null;
    return data;
  } catch { return null; }
}

function writeCache(word, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(CACHE_DIR, `${word.toLowerCase()}.json`),
      JSON.stringify({ cachedAt: Date.now(), data })
    );
  } catch (e) { console.error('cache write error:', e.message); }
}

export default async function handler(req, res) {
  const { word } = req.query;
  if (!word) return res.status(400).json({ error: 'word required' });

  // 캐시 히트 시 즉시 반환
  const cached = readCache(word);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }

  try {
    // 1. 발음은 Free Dictionary API, 정의는 Wiktionary (병렬 요청)
    const [dictRes, wikiMeanings] = await Promise.all([
      fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`),
      fetchWiktionary(word),
    ]);

    if (!dictRes.ok) return res.status(404).json({ error: `"${word}" 단어를 찾을 수 없습니다.` });
    const [entry] = await dictRes.json();
    const pronunciation = entry.phonetics?.find(p => p.text)?.text?.replace(/\//g, '') || '';

    // 2. 정의 소스: Wiktionary 우선, 실패 시 Free Dictionary 폴백
    const allGroups = (wikiMeanings && wikiMeanings.length > 0)
      ? wikiMeanings
      : entry.meanings.slice(0, 4).map(m => ({
          pos: m.partOfSpeech,
          defs: m.definitions
            .filter(d => d.definition && d.definition.length > 15)
            .slice(0, 6)
            .map(d => ({ definition: d.definition, labels: [], example: d.example || null })),
        })).filter(m => m.defs.length > 0);

    if (allGroups.length === 0) {
      return res.status(404).json({ error: `"${word}" 정의를 찾을 수 없습니다.` });
    }

    // 3. Groq: 정의 선택 + 한국어 번역 + 예문 생성 (Groq가 자율 선택)
    let groqData = await groqEnrich(word, allGroups);

    // 4. 품사 불일치 + 중복 한국어 교정
    if (groqData) {
      const failIdx = [];
      const seenKorean = new Set();
      groqData.forEach((item, i) => {
        const k = item.korean;
        const invalid   = !isValidKorean(k, item.pos);
        const duplicate = k && seenKorean.has(k);
        if (invalid || duplicate) {
          failIdx.push({ gi: i, pos: item.pos, english: item.englishShort, existing: [...seenKorean] });
        } else if (k) {
          seenKorean.add(k);
        }
      });
      if (failIdx.length > 0) {
        const corrections = await groqCorrect(word, failIdx);
        if (corrections) {
          failIdx.forEach(({ gi: i }, ci) => {
            if (corrections[ci]) groqData[i].korean = cleanField(corrections[ci]);
          });
        }
      }
    }

    // 5. 최종 필터: "하다" 단독 / 비정상 항목 제거
    if (groqData) {
      groqData = groqData.filter(item => item.korean && item.korean.trim() !== '하다');
    }

    // 6. 결과 조합: groqData의 pos 기준으로 그룹핑
    const posOrder = [];
    const posBuckets = {};
    for (const item of groqData || []) {
      const p = item.pos || 'noun';
      if (!posBuckets[p]) { posBuckets[p] = []; posOrder.push(p); }
      posBuckets[p].push(item);
    }
    // groqData 없으면 allGroups 원문 그대로 폴백
    const assembled = posOrder.length > 0
      ? posOrder.map(p => ({
          pos: posAbbr(p),
          definitions: posBuckets[p].map(g => ({
            korean:  g.korean || word,
            english: g.englishShort || '',
            synonym: '',
            example: g.exampleEn
              ? { en: splitExample(g.exampleEn, word), ko: g.exampleKo || '' }
              : null,
            subNote: null,
          })),
        }))
      : allGroups.slice(0, 2).map(m => ({
          pos: posAbbr(m.pos),
          definitions: m.defs.slice(0, 4).map(d => ({
            korean: word, english: truncateDef(d.definition), synonym: '', example: null, subNote: null,
          })),
        }));

    // 6. exampleKo에 한자가 남아 있으면 해당 예문만 재번역
    const retranslateTargets = [];
    assembled.forEach((m, mi) =>
      m.definitions.forEach((def, di) => {
        if (def.example?.ko && /[一-鿿㐀-䶿]/.test(def.example.ko)) {
          retranslateTargets.push({ mi, di, en: joinEn(def.example.en) });
        }
      })
    );
    if (retranslateTargets.length > 0) {
      const fixes = await retranslateExamples(retranslateTargets);
      fixes.forEach(({ mi, di, ko }) => {
        assembled[mi].definitions[di].example.ko = ko;
      });
    }

    const result = { word: entry.word, pronunciation, related: [], meanings: assembled };

    // Groq 결과가 있을 때만 캐시 저장 (폴백 원문은 저장 안 함)
    if (groqData) writeCache(word, result);

    res.setHeader('X-Cache', 'MISS');
    res.json(result);
  } catch (e) {
    console.error('lookup error:', e);
    res.status(500).json({ error: e.message });
  }
}

// ── 품사-형태 검증 ────────────────────────────────────────────────
// 한국어 headword가 품사에 맞는 형태인지 확인
function isValidKorean(korean, pos) {
  if (!korean) return false;
  const k = korean.trim();
  if (k.length > 14) return false;
  // 한자, 일본어, 태국어 등 비한글 문자 포함 시 교정
  if (/[一-鿿㐀-䶿฀-๿Ѐ-ӿ؀-ۿ]/.test(k)) return false;
  // 순수 한글이 전혀 없으면 교정
  if (!/[가-힣ᄀ-ᇿ㄰-㆏]/.test(k)) return false;

  // 콤마로 묶인 경우 각 부분을 개별 검증
  const parts = k.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length > 2) return false;
  return parts.every(p => isValidKoreanWord(p, pos));
}

function isValidKoreanWord(k, pos) {
  if (!k) return false;
  if (k.includes(' ')) return false;
  if (k.length > 8) return false;

  if (pos === 'adjective') {
    if (k.endsWith('하다')) return false;
    return /[한는인적]$/.test(k) || /스럽다$/.test(k) || /없다$/.test(k) || /있다$/.test(k);
  }
  if (pos === 'verb') {
    if (k === '하다') return false; // 어미만 단독으로 나온 경우
    return k.endsWith('다');
  }
  if (pos === 'noun') {
    return !k.endsWith('하다') && !k.endsWith('적인') && !k.endsWith('는');
  }
  if (pos === 'adverb') {
    // 부사: 동사/형용사형 거부 (하다, 이다, 한, 는 어미)
    if (k.endsWith('하다') || k.endsWith('이다')) return false;
    if (k.endsWith('한') || k.endsWith('는')) return false;
    return true;
  }
  return true;
}

// ── Groq fetch with key rotation + 429 retry ─────────────────────
const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean);

async function groqFetch(payload) {
  for (const key of GROQ_KEYS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (resp.status === 429) {
        const msg = data.error?.message || '';
        // TPD(일일 한도) 초과 → 다음 키로 전환
        if (msg.includes('tokens_per_day') || msg.includes('per_day') || msg.includes('Daily')) break;
        // TPM(분당 한도) → 잠깐 기다리고 같은 키로 재시도
        if (attempt === 2) break; // 재시도 3번 실패 시 다음 키로
        const m = msg.match(/try again in (\d+\.?\d*)s/);
        await new Promise(r => setTimeout(r, m ? Math.ceil(parseFloat(m[1]) * 1000) + 300 : 7000));
        continue;
      }
      if (!resp.ok) throw new Error(`Groq API error ${resp.status}: ${data.error?.message || JSON.stringify(data)}`);
      return data;
    }
  }
  throw new Error('All Groq API keys exhausted (rate limit)');
}

// ── Groq 2차: 품사 불일치 항목만 교정 ───────────────────────────
async function groqCorrect(word, failItems) {
  try {
    const lines = failItems.map(({ pos, english, existing }, i) => {
      const rule =
        pos === 'adjective' ? '형용사 → 반드시 ~한/~는/~적인/~스러운 형태 (예: 빈정대는, 효율적인, 모호한)' :
        pos === 'verb'      ? '동사 → 실제 한국어 동사 ~하다 형태 (야기하다, 초래하다, 수반하다). "명사+하다" 조합 금지' :
        pos === 'adverb'    ? '부사 → 부사 형태 (~히, ~게, ~적으로, ~이, 또는 독립 부사). 예: 불가피하게, 필연적으로, 당연히, 결국. 동사/형용사형(~하다/~한) 절대 금지' :
                              '명사 → 단일 명사, ~하다/~적인 금지 (예: 원인, 근거)';
      const dupNote = existing?.length
        ? ` ⚠ DUPLICATE DETECTED — existing words already used: [${existing.join(', ')}]. Choose a COMPLETELY DIFFERENT word.`
        : '';
      return `[${i + 1}] ${pos} | "${english}" | ${rule}${dupNote}`;
    }).join('\n');

    const prompt =
`Fix the Korean headword for each entry. The word is "${word}".

${lines}

Return ONLY a JSON array of corrected Korean strings, same order:
["교정된 한국어1", "교정된 한국어2", ...]

Rules: SHORT (1 word max), Naver Dictionary headword style, match part of speech exactly.
Hangul (한글) ONLY — NO Chinese/Hanja. No explanation. JSON only.
CRITICAL: NEVER return just "하다" alone — always return a full meaningful verb like 일탈하다, 벗어나다, 포함하다.`;

    const data    = await groqFetch({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.1,
    });

    const content = data.choices?.[0]?.message?.content || '';
    const match   = content.match(/\[[\s\S]*?\]/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('Groq correction error:', e.message);
    return null;
  }
}

// ── Groq: 정의 자율 선택 + 한국어 번역 ──────────────────────────
async function groqEnrich(word, allGroups) {
  try {
    // 각 POS 그룹의 정의를 라벨 포함해 나열 (최대 8개/그룹)
    const defsByPos = allGroups.map(({ pos, defs }) => {
      const lines = defs.slice(0, 8).map((d, i) => {
        const tag = d.labels?.length ? `(${d.labels.join(', ')}) ` : '';
        const ex  = d.example ? ` | e.g. "${d.example.slice(0, 70)}"` : '';
        return `  ${i + 1}. ${tag}${d.definition.slice(0, 110)}${ex}`;
      }).join('\n');
      return `[${pos}]\n${lines}`;
    }).join('\n\n');

    const prompt =
`You are a Korean-English vocabulary textbook editor (능률보카, 수능영단어 style).

For the English word "${word}", below are ALL available definitions grouped by part of speech.

YOUR TASK — two steps:
STEP 1 · SELECT the 3–6 most important definitions for Korean high school / college entrance exam (수능) preparation.
  Selection priority (highest first):
  1. Grammar / linguistic terms → ALWAYS include if present (e.g. 보어 for grammatical complement — this is CRITICAL in Korean EFL education)
  2. High-frequency everyday meanings — abstract, academic, literary contexts
  3. Domain-specific meanings students encounter (set theory → 여집합, optics/color → 보색, nautical full-crew → 정원)
  4. SKIP: highly technical computing, biochemistry, music-instrument, electronics definitions
  5. SKIP: archaic, rare, or obsolete usages
  6. If the word has both important noun AND verb uses, include BOTH parts of speech
  7. Within each POS, order selected meanings by frequency (most common first)

STEP 2 · For each selected definition, fill in the JSON fields.

ALL AVAILABLE DEFINITIONS:
${defsByPos}

Return ONLY a JSON array — each entry MUST include "pos":
[
  {
    "pos": "noun",
    "korean": "핵심 한국어 의미",
    "englishShort": "concise English definition (max 70 chars)",
    "exampleEn": "example sentence using ${word}",
    "exampleKo": "한국어 번역"
  }
]

RULES for "korean" — part of speech form MUST match:
- adjective → ~한/~는/~적인/~스러운 (모호한, 효율적인, 비꼬는)
- verb      → ~하다 using ONLY real Korean verbs (포함하다 ✓, 결과하다 ✗)
              CRITICAL: 야기하다/초래하다 means "cause/bring about" ONLY — NEVER use for show/reflect/produce/imagine/conceive
              Examples: reflect→반영하다, yield→산출하다, conceive→상상하다, manifest→나타내다
- noun      → concise single noun, no ~하다/~적인 suffix (원인, 근거, 보어, 정원)
- adverb    → ~히/~게/~적으로 or standalone (불가피하게, 당연히, 결국)
- MAX 12 characters, Hangul ONLY (no Chinese/Hanja/English)
- Every "korean" in the array MUST be UNIQUE — no repeats across all entries
- Comma pair allowed for very close synonyms: "야기하다, 초래하다"

RULES for "englishShort":
- Plain concise rewrite, max 70 chars
- Add domain label in brackets when helpful: [grammar], [set theory], [color theory], [nautical]

RULES for "exampleEn":
- MUST contain "${word}" (exact or inflected form)
- MUST use "${word}" in the SAME part of speech as this definition
- MINIMUM 12 words, real-world context (who/where/why)

RULES for "exampleKo":
- Natural, colloquial Korean — Hangul ONLY, no Chinese characters

No other text. JSON array only.`;

    const data = await groqFetch({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1600,
      temperature: 0.15,
    });

    const content = data.choices?.[0]?.message?.content || '';
    if (!content) throw new Error(`Empty Groq response: ${JSON.stringify(data)}`);

    const match = content.match(/\[[\s\S]*\]/);
    if (!match) throw new Error(`No JSON in Groq response: ${content.slice(0, 200)}`);

    const parsed = JSON.parse(match[0]);
    return parsed.map(item => ({
      pos:          (item.pos || 'noun').toLowerCase(),
      korean:       cleanField(item.korean),
      englishShort: cleanField(item.englishShort),
      exampleEn:    cleanField(item.exampleEn),
      exampleKo:    cleanField(item.exampleKo),
    }));
  } catch (e) {
    console.error('Groq error, falling back:', e.message);
    return null;
  }
}

const HANJA_MAP = {
  '管':'관','洪水':'홍수','原因':'원인','理由':'이유','結果':'결과','問題':'문제',
  '人':'인','水':'수','火':'화','山':'산','國':'국','大':'대','小':'소',
};

function joinEn(parts) {
  if (!parts) return '';
  return Array.isArray(parts) ? parts.join('') : parts;
}

async function retranslateExamples(targets) {
  try {
    const lines = targets.map(({ en }, i) => `[${i + 1}] ${en}`).join('\n');
    const prompt =
`Translate each English sentence to natural, colloquial Korean.
Use Hangul ONLY — absolutely no Chinese characters (漢字) or Hanja.

${lines}

Return ONLY a JSON array of Korean strings, same order:
["번역1", "번역2"]
No explanation. JSON only.`;

    const data    = await groqFetch({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0.1,
    });
    const content = data.choices?.[0]?.message?.content || '';
    const match   = content.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const results = JSON.parse(match[0]);
    return targets.map(({ mi, di }, i) => ({
      mi, di, ko: cleanField(results[i] || ''),
    }));
  } catch (e) {
    console.error('retranslate error:', e.message);
    return [];
  }
}

function cleanField(str) {
  if (!str) return '';
  let s = str.replace(/\*\*/g, '').replace(/^["']|["']$/g, '').trim();
  for (const [hanja, hangul] of Object.entries(HANJA_MAP)) {
    s = s.replaceAll(hanja, hangul);
  }
  // 한자 및 일본어 가나 제거 (단어 사이 독립적인 경우만 공백 유지, 단어 내부는 그냥 제거)
  s = s.replace(/\s[一-鿿㐀-䶿぀-ヿ]+\s/g, ' ');
  s = s.replace(/[一-鿿㐀-䶿぀-ヿ]/g, '');
  // 공백 정리
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

// Groq 실패 시 폴백: 단어 경계에서 자르기
function truncateDef(text, max = 70) {
  if (!text || text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + '…';
}

function posAbbr(pos) {
  return (
    { noun:'n.', verb:'v.', adjective:'adj.', adverb:'adv.',
      preposition:'prep.', conjunction:'conj.', pronoun:'pron.', interjection:'interj.' }[pos] || pos
  );
}

// ── Wiktionary API ───────────────────────────────────────────────
async function fetchWiktionary(word) {
  try {
    const url = `https://en.wiktionary.org/w/api.php?action=parse&page=${encodeURIComponent(word.toLowerCase())}&prop=wikitext&format=json&origin=*`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'VocabApp/1.0 (educational)' } });
    if (!resp.ok) return null;
    const data = await resp.json();
    const wikitext = data?.parse?.wikitext?.['*'];
    return wikitext ? parseWiktionaryMeanings(wikitext) : null;
  } catch (e) {
    console.error('Wiktionary error:', e.message);
    return null;
  }
}

const VALID_POS   = new Set(['noun', 'verb', 'adjective', 'adverb', 'preposition', 'conjunction', 'pronoun', 'interjection']);
// Groq가 선택을 담당하므로 명백히 부적절한 것(고어/희귀어)만 코드에서 제거
const SKIP_LABELS = new Set(['obsolete', 'archaic', 'dated', 'rare', 'dialectal', 'historical', 'now rare', 'now obsolete']);

function cleanWikitext(text) {
  return text
    .replace(/\{\{lb\|en\|[^}]+\}\}/g, '')
    .replace(/\{\{ux\|en\|([^|{}]+)[^}]*\}\}/g, (_, s) => s)
    .replace(/\{\{(?:w|l|m|U|u|link)\|(?:[^|]+\|)?([^|}]+)[^}]*\}\}/g, '$1')
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
    .replace(/'{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseWiktionaryMeanings(text) {
  const engMatch = text.match(/==English==([\s\S]*?)(?=\n==[^=]|$)/);
  if (!engMatch) return null;
  const eng = engMatch[1];

  // h4에 유효 POS가 있으면 h4(Etymology 포함 단어), 없으면 h3
  const h4 = [...eng.matchAll(/====([^=]+)====([\s\S]*?)(?=\n====|n===|$)/g)];
  const h3 = [...eng.matchAll(/===([^=]+)===([\s\S]*?)(?=\n===|$)/g)];
  const h4HasPos = h4.some(([, pos]) => VALID_POS.has(pos.trim().toLowerCase()));
  const sections = h4HasPos ? h4 : h3;

  const posMap = new Map();

  for (const [, posRaw, content] of sections) {
    const pos = posRaw.trim().toLowerCase();
    if (!VALID_POS.has(pos)) continue;

    const lines = content.split('\n');
    const defs = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/^# (?![*:])/.test(line)) continue;

      const labelMatch = line.match(/\{\{(?:lb|label)\|en\|([^}]+)\}\}/);
      const labels = labelMatch ? labelMatch[1].split('|').map(s => s.trim().toLowerCase()) : [];
      if (labels.some(l => SKIP_LABELS.has(l))) continue;

      const defText = cleanWikitext(line.slice(2));
      if (!defText || defText.length < 12) continue;

      // 바로 다음 라인에서 예문 추출
      let example = null;
      if (i + 1 < lines.length && /^#[*:]/.test(lines[i + 1])) {
        const exMatch = lines[i + 1].match(/\{\{ux\|en\|([^|{}]+)/);
        if (exMatch) example = cleanWikitext(exMatch[1]);
      }

      defs.push({ definition: defText, example, labels });
    }

    if (defs.length === 0) continue;

    // 라벨 없는 일반 정의를 앞에 배치, 나머지는 원순서 유지 → 최대 8개
    const noLabel = defs.filter(d => d.labels.length === 0);
    const labeled = defs.filter(d => d.labels.length > 0);
    const ordered = [...noLabel, ...labeled].slice(0, 8);

    if (!posMap.has(pos)) posMap.set(pos, []);
    posMap.get(pos).push(...ordered);
  }

  // Groq에 넘길 모든 POS 그룹 (최대 4 POS, 각 최대 8개)
  const result = [...posMap.entries()]
    .filter(([, defs]) => defs.length > 0)
    .slice(0, 4)
    .map(([pos, defs]) => ({ pos, defs: defs.slice(0, 8) }));

  return result.length > 0 ? result : null;
}

function splitExample(sentence, word) {
  const idx = sentence.toLowerCase().indexOf(word.toLowerCase());
  if (idx === -1) return [sentence];
  return [
    sentence.slice(0, idx),
    sentence.slice(idx, idx + word.length),
    sentence.slice(idx + word.length),
  ];
}
