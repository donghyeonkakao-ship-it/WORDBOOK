const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const CACHE_TTL_MS      = 30 * 24 * 60 * 60 * 1000; // 30일

async function readCache(word) {
  if (!SUPABASE_URL) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/vocab_cache?word=eq.${encodeURIComponent(word.toLowerCase())}&select=data,cached_at`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows?.length) return null;
    const { data, cached_at } = rows[0];
    if (Date.now() - new Date(cached_at).getTime() > CACHE_TTL_MS) return null;
    return data;
  } catch { return null; }
}

async function writeCache(word, data) {
  if (!SUPABASE_URL) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/vocab_cache`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ word: word.toLowerCase(), data, cached_at: new Date().toISOString() }),
    });
  } catch (e) { console.error('cache write error:', e.message); }
}

export default async function handler(req, res) {
  const { word, refresh } = req.query;
  if (!word) return res.status(400).json({ error: 'word required' });

  if (!refresh) {
    const cached = await readCache(word);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }
  }

  try {
    const [dictRes, wikiMeanings] = await Promise.all([
      fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`),
      fetchWiktionary(word),
    ]);

    if (!dictRes.ok) return res.status(404).json({ error: `"${word}" 단어를 찾을 수 없습니다.` });
    const [entry] = await dictRes.json();
    const pronunciation = entry.phonetics?.find(p => p.text)?.text?.replace(/\//g, '') || '';

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

    let groqData = await groqEnrich(word, allGroups);

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

    if (groqData) {
      groqData = groqData.filter(item => item.korean && item.korean.trim() !== '하다');
    }

    const posOrder = [];
    const posBuckets = {};
    for (const item of groqData || []) {
      const p = item.pos || 'noun';
      if (!posBuckets[p]) { posBuckets[p] = []; posOrder.push(p); }
      posBuckets[p].push(item);
    }
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

    if (groqData) await writeCache(word, result);

    res.setHeader('X-Cache', 'MISS');
    res.json(result);
  } catch (e) {
    console.error('lookup error:', e);
    res.status(500).json({ error: e.message });
  }
}

// ── 품사-형태 검증 ─────────────────────────────────────────────────
function isValidKorean(korean, pos) {
  if (!korean) return false;
  const k = korean.trim();
  if (k.length > 14) return false;
  if (/[一-鿿㐀-䶿฀-๿Ѐ-ӿ؀-ۿ]/.test(k)) return false;
  if (!/[가-힣ᄀ-ᇿ㄰-㆏]/.test(k)) return false;

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
    if (k === '하다') return false;
    return k.endsWith('다');
  }
  if (pos === 'noun') {
    return !k.endsWith('하다') && !k.endsWith('적인') && !k.endsWith('는');
  }
  if (pos === 'adverb') {
    if (k.endsWith('하다') || k.endsWith('이다')) return false;
    if (k.endsWith('한') || k.endsWith('는')) return false;
    return true;
  }
  return true;
}

// ── Groq fetch with key rotation + 429 retry ──────────────────────
const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean);

async function groqFetch(payload) {
  const deterministicPayload = { ...payload, temperature: 0, seed: 42 };
  for (const key of GROQ_KEYS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(deterministicPayload),
      });
      const data = await resp.json();
      if (resp.status === 429) {
        const msg = data.error?.message || '';
        if (msg.includes('tokens_per_day') || msg.includes('per_day') || msg.includes('Daily')) break;
        if (attempt === 2) break;
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

// ── Groq 2차: 품사 불일치 항목만 교정 ────────────────────────────
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

// ── Groq: 정의 자율 선택 + 한국어 번역 ───────────────────────────
async function groqEnrich(word, allGroups) {
  try {
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
STEP 1 · SELECT the 3–5 most important definitions for Korean high school / college entrance exam (수능) preparation.
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
- Must be a DIRECT, LITERAL description of the meaning — never paraphrase loosely
- The "korean" field MUST be the exact Korean translation of this "englishShort"
  Examples: "establish identity of" → 확인하다, "feel connection with" → 공감하다, "disclose the identity of" → 신원을 밝히다, "recognize and locate" → 식별하다

RULES for "exampleEn":
- MUST contain "${word}" (exact or inflected form)
- MUST use "${word}" in the SAME part of speech AND same sense as this definition
- MUST use "${word}" in its most BASIC, STANDALONE usage — DO NOT use idiomatic collocations
  (e.g., if defining "feel connection with", write: "Many readers ${word} with the struggles described in the memoir."
   NOT: "${word} the concept and categorize it simultaneously" — that mixes two different verbs' meanings)
- MINIMUM 12 words, real-world context (who/where/why)
- The example must ONLY illustrate the one sense defined by "englishShort" — never blend meanings

RULES for "exampleKo":
- Translate "exampleEn" faithfully and naturally — Hangul ONLY, no Chinese characters
- The translation must match what "exampleEn" actually says, NOT a rephrasing of "korean"
- NEVER translate more loosely than the English allows

CRITICAL CONSISTENCY CHECK (verify before outputting each entry):
1. "korean" must be the Korean translation of "englishShort" — they must match perfectly
2. If "englishShort" = "disclose the identity of" → "korean" MUST be "신원을 밝히다" (NEVER "등장시키다")
3. If "englishShort" = "recognize and locate" → "korean" MUST be "식별하다" (NEVER "구분하다" — that is "distinguish")
4. If "englishShort" = "feel connection with" → "korean" MUST be "공감하다" or "동일시하다" (NEVER "인식하다")
5. "exampleKo" must translate "exampleEn", not paraphrase "korean"
6. Never let the example sentence define or override the "korean" label — the label comes from "englishShort"

No other text. JSON array only.`;

    const data = await groqFetch({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1600,
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
  s = s.replace(/\s[一-鿿㐀-䶿぀-ヿ]+\s/g, ' ');
  s = s.replace(/[一-鿿㐀-䶿぀-ヿ]/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

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

// ── Wiktionary API ────────────────────────────────────────────────
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

      let example = null;
      if (i + 1 < lines.length && /^#[*:]/.test(lines[i + 1])) {
        const exMatch = lines[i + 1].match(/\{\{ux\|en\|([^|{}]+)/);
        if (exMatch) example = cleanWikitext(exMatch[1]);
      }

      defs.push({ definition: defText, example, labels });
    }

    if (defs.length === 0) continue;

    const noLabel = defs.filter(d => d.labels.length === 0);
    const labeled = defs.filter(d => d.labels.length > 0);
    const ordered = [...noLabel, ...labeled].slice(0, 8);

    if (!posMap.has(pos)) posMap.set(pos, []);
    posMap.get(pos).push(...ordered);
  }

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
