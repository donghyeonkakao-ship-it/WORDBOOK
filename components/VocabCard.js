import { useRef, useState } from 'react';
import styles from '../styles/card.module.css';

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥'];

function ExSentence({ parts }) {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  if (parts.length === 1) return <span>{parts[0]}</span>;
  return (
    <span>
      {parts[0]}<strong>{parts[1]}</strong>{parts[2] || ''}
    </span>
  );
}

function CardBody({ data, num, onDelete, onEdit, onRefresh, printMode }) {
  const cls = printMode ? styles.cardPrint : styles.card;
  const leftCls = styles.leftCol;
  const rightCls = styles.rightCol;
  const [confirming, setConfirming] = useState(false);
  const timer = useRef(null);

  const handleDelete = () => {
    if (!confirming) {
      setConfirming(true);
      timer.current = setTimeout(() => setConfirming(false), 2000);
    } else {
      clearTimeout(timer.current);
      onDelete();
    }
  };

  return (
    <div className={cls}>
      {!printMode && (
        <div className={styles.actions}>
          <button className={styles.refreshBtn} onClick={onRefresh} title="재생성">↻</button>
          <button className={styles.editBtn} onClick={onEdit} title="수정">✐</button>
          <button
            className={confirming ? styles.delBtnConfirm : styles.delBtn}
            onClick={handleDelete}
            title={confirming ? '한 번 더 클릭하면 삭제' : '삭제'}
          >
            {confirming ? '삭제?' : '✕'}
          </button>
        </div>
      )}

      {/* ── 왼쪽: 번호 · 표제어 · 발음 · 관련어 ── */}
      <div className={leftCls}>
        <div className={styles.num}>{String(num).padStart(4, '0')}</div>
        <div
          className={styles.headword}
          style={data.word.length > 9 ? { fontSize: data.word.length > 11 ? '18px' : '21px' } : undefined}
        >{data.word}</div>
        {data.pronunciation && (
          <div className={styles.phon}>[{data.pronunciation}]</div>
        )}
        {data.related?.length > 0 && (
          <div className={styles.relatedList}>
            {data.related.map((r, i) => (
              <div key={i} className={styles.relItem}>
                <span className={styles.relWord}>{r.word}</span> {r.meaning}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 오른쪽: 뜻 · 예문 ── */}
      <div className={rightCls}>
        {data.meanings?.map((m, mi) => (
          <div key={mi} className={styles.posGroup}>
            <div className={styles.posLine}>
              <span className={styles.pos}>{m.pos}</span>
            </div>
            {m.definitions?.map((def, di) => (
              <div key={di} className={styles.defItem}>
                <div className={styles.defLine}>
                  <span className={styles.circle}>{CIRCLED[di]}</span>
                  <span className={styles.kor}>{def.korean}</span>
                  {def.english && (
                    <span className={styles.engDef}>[{def.english}]</span>
                  )}
                  {def.synonym && (
                    <span className={styles.syn}>
                      = <span className={styles.synWord}>{def.synonym}</span>
                    </span>
                  )}
                </div>

                {def.example && (
                  <div className={styles.exBox}>
                    <div className={styles.exEn}>
                      <ExSentence parts={def.example.en} />
                    </div>
                    {def.example.ko && (
                      <div className={styles.exKo}>{def.example.ko}</div>
                    )}
                  </div>
                )}

                {def.subNote && (
                  <div className={styles.subNote}>
                    <span>└</span>
                    <span className={styles.relWord}>{def.subNote.word}</span>
                    <span>{def.subNote.meaning}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function VocabCard({ entry, index, onDelete, onEdit, onRefresh, printMode = false }) {
  const { word, status, data, error } = entry;

  if (status === 'loading') {
    return (
      <div className={styles.loadingCard}>
        <div className={styles.loadingLeft}>
          <div className={styles.loadingWord}>{word}</div>
          <div className={`${styles.skeleton} ${styles.short}`} />
        </div>
        <div className={styles.loadingRight}>
          <div className={`${styles.skeleton} ${styles.medium}`} />
          <div className={`${styles.skeleton} ${styles.long}`} />
          <div className={`${styles.skeleton} ${styles.medium}`} />
          <div className={`${styles.skeleton} ${styles.long}`} />
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={styles.errorCard}>
        <span className={styles.errorWord}>{word}</span>
        <span className={styles.errorMsg}>{error}</span>
        <div className={styles.errorActions}>
          <button className={styles.retryBtn} onClick={onRefresh}>재시도</button>
          <button className={styles.deleteBtn} onClick={onDelete}>삭제</button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <CardBody data={data} num={index + 1} onDelete={onDelete} onEdit={onEdit} onRefresh={onRefresh} printMode={printMode} />
  );
}
