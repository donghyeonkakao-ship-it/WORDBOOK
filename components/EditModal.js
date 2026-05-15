import { useState } from 'react';
import styles from '../styles/editModal.module.css';

function joinEn(parts) {
  if (!parts) return '';
  return Array.isArray(parts) ? parts.join('') : parts;
}

function splitExEn(sentence, word) {
  if (!sentence) return [''];
  if (!word) return [sentence];
  const idx = sentence.toLowerCase().indexOf(word.toLowerCase());
  if (idx === -1) return [sentence];
  return [
    sentence.slice(0, idx),
    sentence.slice(idx, idx + word.length),
    sentence.slice(idx + word.length),
  ];
}

export default function EditModal({ entry, onSave, onClose }) {
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(entry.data)));

  const updateDef = (mi, di, field, value) => {
    setDraft(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      next.meanings[mi].definitions[di][field] = value;
      return next;
    });
  };

  const updateEx = (mi, di, field, value) => {
    setDraft(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const def = next.meanings[mi].definitions[di];
      if (!def.example) def.example = { en: [], ko: '' };
      if (field === 'en') {
        def.example.en = splitExEn(value, entry.data.word);
      } else {
        def.example.ko = value;
      }
      return next;
    });
  };

  return (
    <div className={styles.overlay} onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span className={styles.title}>{entry.data.word} 수정</span>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.body}>
          {draft.meanings.map((m, mi) => (
            <div key={mi} className={styles.posSection}>
              <div className={styles.posLabel}>{m.pos}</div>
              {m.definitions.map((def, di) => (
                <div key={di} className={styles.defBlock}>
                  <div className={styles.defNum}>({di + 1})</div>
                  <div className={styles.fields}>
                    <label className={styles.field}>
                      <span>한국어 뜻</span>
                      <input
                        value={def.korean}
                        onChange={e => updateDef(mi, di, 'korean', e.target.value)}
                      />
                    </label>
                    <label className={styles.field}>
                      <span>영어 정의</span>
                      <input
                        value={def.english || ''}
                        onChange={e => updateDef(mi, di, 'english', e.target.value)}
                      />
                    </label>
                    <label className={styles.field}>
                      <span>동의어</span>
                      <input
                        value={def.synonym || ''}
                        onChange={e => updateDef(mi, di, 'synonym', e.target.value)}
                      />
                    </label>
                    <label className={styles.field}>
                      <span>예문 (영어)</span>
                      <textarea
                        rows={2}
                        value={joinEn(def.example?.en)}
                        onChange={e => updateEx(mi, di, 'en', e.target.value)}
                      />
                    </label>
                    <label className={styles.field}>
                      <span>예문 (한국어)</span>
                      <textarea
                        rows={2}
                        value={def.example?.ko || ''}
                        onChange={e => updateEx(mi, di, 'ko', e.target.value)}
                      />
                    </label>
                  </div>
                </div>
              ))}
              {mi < draft.meanings.length - 1 && <hr className={styles.divider} />}
            </div>
          ))}
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose}>취소</button>
          <button className={styles.saveBtn} onClick={() => { onSave(draft); onClose(); }}>저장</button>
        </div>
      </div>
    </div>
  );
}
