import { useRef, useState } from 'react';
import styles from '../styles/input.module.css';

export default function WordInput({ onAdd }) {
  const [text, setText] = useState('');
  const [added, setAdded] = useState(false);
  const feedbackTimer = useRef(null);

  const parseWords = (raw) =>
    raw
      .split(/[\n,，\s]+/)
      .map(w => w.trim().toLowerCase())
      .filter(w => w.length > 0 && /^[a-z][a-z\s'-]*$/.test(w));

  const submit = () => {
    const words = parseWords(text);
    if (words.length === 0) return;
    words.forEach(w => onAdd(w));
    setText('');
    setAdded(true);
    clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setAdded(false), 1200);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === ',') { e.preventDefault(); submit(); }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text');
    const words = parseWords(pasted);
    if (words.length > 0) { words.forEach(w => onAdd(w)); setText(''); }
  };

  return (
    <div className={styles.container}>
      <div className={styles.row}>
        <input
          className={styles.input}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="영단어 입력 후 Enter 또는 콤마로 추가 (예: cause, effect, result)"
        />
        <button className={styles.btn} onClick={submit} disabled={!text.trim()}>
          추가
        </button>
      </div>
    </div>
  );
}
