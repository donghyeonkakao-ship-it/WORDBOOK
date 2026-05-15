import styles from "../styles/vocabulary.module.css";
import vocabulary from "../data/vocabulary.js";

function ExampleSentence({ parts }) {
  return (
    <span>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <strong key={i} className={styles.exampleKeyword}>
            {part}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}

function Definition({ def, index }) {
  const circled = ["①", "②", "③", "④", "⑤"];
  return (
    <div className={styles.definition}>
      <div className={styles.meaningRow}>
        <span className={styles.defNumber}>{circled[index]}</span>
        <span className={styles.koreanMeaning}>{def.korean}</span>
        {def.english && (
          <span className={styles.englishDef}>[{def.english}]</span>
        )}
        {def.synonym && (
          <span className={styles.synonym}>
            = <span className={styles.synonymWord}>{def.synonym}</span>
          </span>
        )}
      </div>
      {def.example && (
        <div className={styles.example}>
          <div className={styles.exampleEn}>
            <ExampleSentence parts={def.example.en} />
          </div>
          <div className={styles.exampleKo}>{def.example.ko}</div>
        </div>
      )}
      {def.subNote && (
        <div className={styles.subNote}>
          <span className={styles.subNoteArrow}>└</span>
          <span className={styles.subNoteWord}>{def.subNote.word}</span>
          <span>{def.subNote.meaning}</span>
        </div>
      )}
    </div>
  );
}

function VocabEntry({ entry }) {
  return (
    <div className={styles.entry}>
      <div className={styles.entryNumber}>
        {String(entry.id).padStart(4, "0")}
      </div>
      <div className={styles.headRow}>
        <span className={styles.headword}>{entry.word}</span>
        <span className={styles.pronunciation}>[{entry.pronunciation}]</span>
      </div>
      {entry.related?.length > 0 && (
        <div className={styles.related}>
          {entry.related.map((r) => (
            <span key={r.word} className={styles.relatedItem}>
              <span className={styles.relatedWord}>{r.word}</span> {r.meaning}
            </span>
          ))}
        </div>
      )}
      {entry.meanings.map((group, gi) => (
        <div key={gi} className={styles.posGroup}>
          <div className={styles.pos}>{group.pos}</div>
          {group.definitions.map((def, di) => (
            <Definition key={di} def={def} index={di} />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function VocabularyPage() {
  return (
    <div className={styles.page}>
      <h2>단어장</h2>
      {vocabulary.map((entry) => (
        <VocabEntry key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
