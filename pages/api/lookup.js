export default async function handler(req, res) {
  const { word } = req.query;
  if (!word) return res.status(400).json({ error: 'word required' });

  try {
    // 1. 영어 사전 데이터
    const dictRes = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`
    );
    if (!dictRes.ok) return res.status(404).json({ error: `"${word}" 단어를 찾을 수 없습니다.` });
    const [entry] = await dictRes.json();

    const pronunciation = entry.phonetics?.find(p => p.text)?.text?.replace(/\//g, '') || '';

    // 2. 품사 그룹 선택 (예문 있는 그룹 우선)
    const allGroups = entry.meanings.slice(0, 4).map(m => {
      const withEx    = m.definitions.filter(d => d.example?.trim());
      const withoutEx = m.definitions.filter(d => !d.example?.trim());
      return {
        pos:        m.partOfSpeech,
        defs:       [...withEx, ...withoutEx].slice(0, withEx.length >= 2 ? 2 : 1),
        hasExample: withEx.length > 0,
      };
    }).filter(m => m.defs.length > 0);

    const groupsWithEx = allGroups.filter(m => m.hasExample);
    const rawMeanings  = (groupsWithEx.length > 0 ? groupsWithEx : allGroups).slice(0, 2);

    if (rawMeanings.length === 0) {
      return res.status(404).json({ error: `"${word}" 정의를 찾을 수 없습니다.` });
    }

    // 3. Groq 1차: 한국어 키워드 + 예문 생성
    let groqData = await groqEnrich(word, rawMeanings);

    // 4. 이중 체크: 품사-형태 불일치 항목 교정
    if (groqData) {
      const failIdx = [];
      let gi = 0;
      for (const m of rawMeanings) {
        for (const d of m.defs) {
          const item = groqData[gi];
          if (item && !isValidKorean(item.korean, m.pos)) {
            failIdx.push({ gi, pos: m.pos, english: d.definition });
          }
          gi++;
        }
      }
      if (failIdx.length > 0) {
        const corrections = await groqCorrect(word, failIdx);
        if (corrections) {
          failIdx.forEach(({ gi: i }, ci) => {
            if (corrections[ci]) groqData[i].korean = cleanField(corrections[ci]);
          });
        }
      }
    }

    // 5. 결과 조합
    let gi = 0;
    const assembled = rawMeanings.map(m => ({
      pos: posAbbr(m.pos),
      definitions: m.defs.map(d => {
        const g       = groqData?.[gi++] || {};
        const exEn    = g.exampleEn?.trim() || d.example?.trim() || '';
        const english = g.englishShort?.trim() || truncateDef(d.definition);
        return {
          korean:  g.korean  || word,
          english,
          synonym: d.synonyms?.[0] || '',
          example: exEn
            ? { en: splitExample(exEn, word), ko: g.exampleKo || '' }
            : null,
          subNote: null,
        };
      }),
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

    const meanings = assembled;

    res.json({ word: entry.word, pronunciation, related: [], meanings });
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
  if (/[一-鿿㐀-䶿]/.test(k)) return false; // 한자 포함 시 교정

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
    return k.endsWith('다');
  }
  if (pos === 'noun') {
    return !k.endsWith('하다') && !k.endsWith('적인') && !k.endsWith('는');
  }
  return true;
}

// ── Groq 2차: 품사 불일치 항목만 교정 ───────────────────────────
async function groqCorrect(word, failItems) {
  try {
    const lines = failItems.map(({ pos, english }, i) => {
      const rule =
        pos === 'adjective' ? '형용사 → 반드시 ~한/~는/~적인/~스러운 형태 (예: 빈정대는, 효율적인, 모호한)' :
        pos === 'verb'      ? '동사 → 실제 한국어 동사 ~하다 형태 (야기하다, 초래하다, 수반하다). "명사+하다" 조합 금지 — 결과하다/원인하다처럼 명사에 하다 붙인 것 사용 불가' :
                              '명사 → 단일 명사, ~하다/~적인 금지 (예: 원인, 근거)';
      return `[${i + 1}] ${pos} | "${english}" | ${rule}`;
    }).join('\n');

    const prompt =
`Fix the Korean headword for each entry. The word is "${word}".

${lines}

Return ONLY a JSON array of corrected Korean strings, same order:
["교정된 한국어1", "교정된 한국어2", ...]

Rules: SHORT (1 word max), Naver Dictionary headword style, match the part of speech form exactly.
Hangul (한글) ONLY — absolutely NO Chinese characters or Hanja (漢字).
No explanation. JSON only.`;

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.1,
      }),
    });

    const data    = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    const match   = content.match(/\[[\s\S]*?\]/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('Groq correction error:', e.message);
    return null;
  }
}

// ── Groq 1차: 한국어 + 예문 생성 ────────────────────────────────
async function groqEnrich(word, meanings) {
  try {
    let idx = 0;
    const defLines = meanings.flatMap(m =>
      m.defs.map(d => {
        idx++;
        const ex = d.example?.trim() ? `\n   예문: ${d.example.trim()}` : '';
        return `[${idx}] ${m.pos} — ${d.definition}${ex}`;
      })
    ).join('\n\n');

    const prompt =
`You are a Korean-English vocabulary textbook editor (능률보카, 수능영단어 style).
For the English word "${word}", provide Korean dictionary content for each definition below.

${defLines}

Respond with a JSON array in the same order:
[
  {
    "korean": "핵심 한국어 의미",
    "englishShort": "concise English definition",
    "exampleEn": "example sentence",
    "exampleKo": "한국어 번역"
  }
]

STRICT RULES for "korean" field — part of speech MUST match:
- adjective → MUST end in ~한/~는/~적인/~스러운 (비꼬는, 효율적인, 모호한, 탄력있는)
- verb      → MUST end in ~하다, using ONLY established Korean verbs
              Good: 야기하다, 초래하다, 지속하다, 발생하다, 적용하다, 수반하다, 초과하다
              BAD (forbidden): stem = direct Korean translation of the English word + 하다
              e.g. result→결과하다 ✗ (결과 is a noun, not a verb stem), apply→적용하다 ✓ (real verb)
              If no natural ~하다 verb exists, use a different verb form (초래하다, 낳다, 생기다)
- noun      → single concise noun, NO verb/adj suffix (원인, 근거, 이유, 발판)
- MAX 2 words joined by comma (e.g. "야기하다, 초래하다"), MAX 12 characters total
- NEVER: long phrases, English words, Chinese/Japanese characters (漢字), definitions as headword
- MUST use Hangul (한글) ONLY — no 漢字, no Hanja, no Chinese, no Japanese
- Every entry's "korean" MUST be distinct from all others in the array. No word may appear in more than one entry.
  Check carefully: if entry [1] uses 적용, then entry [2] MUST NOT use 적용 at all — use 활용, 응용, 지원 etc.
- If two senses are genuinely close, use a comma pair of near-synonyms (야기하다, 초래하다) for ONE entry, and a different word for the other.
- "적용시키기", "결과물내기" style nominalizations are NOT valid headwords — use concise nouns only.

RULES for "englishShort":
- A concise rewrite of the definition above — plain English, max 70 characters
- Must be semantically consistent with "korean" (same meaning, same sense)
- No parenthetical qualifications, no "especially", no "as in ..."
- Example good: "Expressing bitter or mocking humor"
- Example bad:  "Marked by or given to using irony in order to mock or convey contempt (as in sarcastic remarks)"

RULES for "exampleEn":
- The sentence MUST contain the word "${word}" (exact form or natural inflection)
- The word MUST be used in the same part of speech as the definition (verb def → use "${word}" as a verb; noun def → as a noun)
  BAD: verb def for "result" but example says "The result of planning" (noun usage) ✗
  GOOD: verb def for "result" → "Poor planning resulted in widespread delays." ✓
- MINIMUM 12 words. Short sentences like "He gave an ambiguous answer." are NOT acceptable.
- The sentence must show a REAL-WORLD CONTEXT — who, where, or why — so a learner understands when this word is used.
  BAD: "He gave an ambiguous answer." (no context, too short)
  GOOD: "The politician's ambiguous statements about the tax policy left voters confused and frustrated."
- If a provided example is long enough (12+ words) and contains "${word}", reproduce it exactly.
- Otherwise write a NEW sentence of 12–20 words that is vivid, contextual, and uses "${word}" naturally.

RULES for "exampleKo":
- Natural Korean translation of exampleEn
- Colloquial and fluid, not literal
- Hangul (한글) ONLY — absolutely NO Chinese characters or Hanja (漢字/한자)

Respond with ONLY the JSON array. No other text.`;

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 700,
        temperature: 0.15,
      }),
    });

    const data    = await resp.json();

    if (!resp.ok) {
      throw new Error(`Groq API error ${resp.status}: ${data.error?.message || JSON.stringify(data)}`);
    }

    const content = data.choices?.[0]?.message?.content || '';
    if (!content) {
      throw new Error(`Empty response from Groq: ${JSON.stringify(data)}`);
    }

    const match   = content.match(/\[[\s\S]*\]/);
    if (!match) {
      throw new Error(`JSON not found in Groq response: ${content.slice(0, 200)}`);
    }

    const parsed  = JSON.parse(match[0]);

    return parsed.map(item => ({
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

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400,
        temperature: 0.1,
      }),
    });
    const data    = await resp.json();
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

function splitExample(sentence, word) {
  const idx = sentence.toLowerCase().indexOf(word.toLowerCase());
  if (idx === -1) return [sentence];
  return [
    sentence.slice(0, idx),
    sentence.slice(idx, idx + word.length),
    sentence.slice(idx + word.length),
  ];
}
