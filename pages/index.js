import { useCallback, useEffect, useRef, useState } from 'react';
import useProjects from '../hooks/useProjects';
import Sidebar from '../components/Sidebar';
import WordInput from '../components/WordInput';
import VocabCard from '../components/VocabCard';
import EditModal from '../components/EditModal';
import styles from '../styles/app.module.css';

export default function Home() {
  const {
    projects, activeId, setActiveId, activeProject,
    createProject, deleteProject, renameProject,
    addWord, updateWord, deleteWord,
  } = useProjects();

  const printRef = useRef(null);
  const cardsRef = useRef(null);
  const [exporting, setExporting] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const lookup = useCallback(async (word, projectId, entryId) => {
    try {
      const res = await fetch(`/api/lookup?word=${encodeURIComponent(word)}`);
      const data = await res.json();
      if (res.ok) {
        updateWord(projectId, entryId, { status: 'loaded', data });
      } else {
        updateWord(projectId, entryId, { status: 'error', error: data.error });
      }
    } catch {
      updateWord(projectId, entryId, { status: 'error', error: '네트워크 오류' });
    }
  }, [updateWord]);

  const handleAddWord = useCallback((word) => {
    if (!activeProject) return;
    if (activeProject.words.some(w => w.word === word && w.status !== 'error')) return;
    const entry = { id: crypto.randomUUID(), word, status: 'loading', data: null, error: null };
    addWord(activeProject.id, entry);
    lookup(word, activeProject.id, entry.id);
    setTimeout(() => {
      cardsRef.current?.scrollTo({ top: cardsRef.current.scrollHeight, behavior: 'smooth' });
    }, 60);
  }, [activeProject, addWord, lookup]);

  const handleExportPdf = async () => {
    if (!printRef.current || exporting) return;
    setExporting(true);

    const el = printRef.current;
    // Bring on-screen so html2canvas can render it (covered by export overlay).
    el.style.cssText =
      'position:fixed;top:0;left:0;z-index:9999;width:680px;background:#fff;';

    try {
      await new Promise(r => setTimeout(r, 200));
      // 폰트 로딩이 완료되기 전에 html2canvas가 실행되면 공백 폭이 0이 됨
      await document.fonts.ready;

      const html2canvas = (await import('html2canvas')).default;
      const { jsPDF }   = await import('jspdf');

      const canvas  = await html2canvas(el, {
        scale: 3,
        useCORS: true,
        logging: false,
        onclone: (_doc) => {
          const style = _doc.createElement('style');
          // Noto Sans KR로 영어를 렌더링하면 html2canvas가 공백을 드롭함.
          // Arial을 앞에 두면: 영어 → Arial(공백 정상), 한국어 → Noto Sans KR 폴백(정상).
          style.textContent = `
            * {
              font-family: Arial, Helvetica, 'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif !important;
              letter-spacing: 0 !important;
              word-spacing: normal !important;
            }
            [class*="headword"] { font-weight: 800 !important; }
            [class*="pos"]      { font-style: italic !important; }
            [class*="kor"]      { font-weight: 700 !important; }
          `;
          _doc.head.appendChild(style);
        },
      });
      const imgData = canvas.toDataURL('image/jpeg', 0.95);

      const pdf      = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      const margin   = 15;
      const pageW    = pdf.internal.pageSize.getWidth();
      const pageH    = pdf.internal.pageSize.getHeight();
      const contentW = pageW - margin * 2;
      const imgH     = (canvas.height * contentW) / canvas.width; // total rendered height in mm

      const usableH  = pageH - margin * 2;
      let remaining  = imgH;
      let srcY       = 0; // mm into the image we've printed so far

      while (remaining > 0) {
        const sliceH = Math.min(remaining, usableH);

        // crop a horizontal slice of the canvas
        const sliceCanvas  = document.createElement('canvas');
        sliceCanvas.width  = canvas.width;
        sliceCanvas.height = Math.round((sliceH / imgH) * canvas.height);
        const ctx = sliceCanvas.getContext('2d');
        ctx.drawImage(
          canvas,
          0, Math.round((srcY / imgH) * canvas.height),
          canvas.width, sliceCanvas.height,
          0, 0,
          canvas.width, sliceCanvas.height,
        );

        if (srcY > 0) pdf.addPage();
        pdf.addImage(
          sliceCanvas.toDataURL('image/jpeg', 0.95),
          'JPEG',
          margin, margin,
          contentW, sliceH,
        );

        srcY      += sliceH;
        remaining -= sliceH;
      }

      pdf.save(`${activeProject?.name || 'vocabulary'}.pdf`);
    } catch (e) {
      console.error('PDF 생성 실패:', e);
      alert('PDF 생성에 실패했습니다.');
    } finally {
      el.style.cssText =
        'position:absolute;left:-9999px;top:0;width:680px;background:#fff;';
      setExporting(false);
    }
  };

  const loadedWords = activeProject?.words.filter(w => w.status === 'loaded') || [];

  const [editingEntry, setEditingEntry] = useState(null);

  const handleSaveEdit = useCallback((entry, newData) => {
    updateWord(activeProject.id, entry.id, { data: newData });
  }, [activeProject, updateWord]);

  const [coverDate, setCoverDate] = useState('');
  useEffect(() => {
    setCoverDate(new Date().toLocaleDateString('ko-KR', {
      year: 'numeric', month: 'long', day: 'numeric',
    }));
  }, []);

  return (
    <>
      <div className={styles.layout}>
        <Sidebar
          projects={projects}
          activeId={activeId}
          onSelect={setActiveId}
          onCreate={createProject}
          onDelete={deleteProject}
          onRename={renameProject}
          mobileOpen={mobileMenuOpen}
          onMobileClose={() => setMobileMenuOpen(false)}
        />

        <main className={styles.main}>
          {activeProject ? (
            <>
              <div className={styles.toolbar}>
                <h2 className={styles.projectTitle}>{activeProject.name}</h2>
                <span className={styles.wordCount}>{activeProject.words.length}개 단어</span>
                <button
                  className={styles.pdfBtn}
                  onClick={handleExportPdf}
                  disabled={exporting || loadedWords.length === 0}
                >
                  {exporting ? '생성 중...' : 'PDF 다운로드'}
                </button>
              </div>

              <WordInput onAdd={handleAddWord} />

              <div className={styles.cards} ref={cardsRef}>
                {activeProject.words.map((entry, i) => (
                  <VocabCard
                    key={entry.id}
                    entry={entry}
                    index={i}
                    onDelete={() => deleteWord(activeProject.id, entry.id)}
                    onEdit={() => setEditingEntry(entry)}
                  />
                ))}
                {activeProject.words.length === 0 && (
                  <div className={styles.empty}>
                    영단어를 입력하면 자동으로 카드가 생성됩니다
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className={styles.empty}>
              프로젝트를 선택하거나 새로 만드세요
            </div>
          )}
        </main>

        {/* ── Mobile top navigation ── */}
        <nav className={styles.bottomNav}>
          <button
            className={styles.bnBtn}
            onClick={() => setMobileMenuOpen(true)}
            title="프로젝트"
          >
            <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
              <rect width="18" height="2" rx="1" fill="currentColor"/>
              <rect y="6" width="18" height="2" rx="1" fill="currentColor"/>
              <rect y="12" width="18" height="2" rx="1" fill="currentColor"/>
            </svg>
          </button>

          <div className={styles.bnCenter}>
            {activeProject ? (
              <>
                <div className={styles.bnProjectName}>{activeProject.name}</div>
                <div className={styles.bnProjectSub}>{activeProject.words.length}개 단어</div>
              </>
            ) : (
              <div className={styles.bnProjectName} style={{ opacity: 0.4 }}>프로젝트 없음</div>
            )}
          </div>

          <button
            className={`${styles.bnBtn} ${styles.accent}`}
            onClick={handleExportPdf}
            disabled={exporting || loadedWords.length === 0}
            title="PDF 다운로드"
          >
            {exporting ? '⏳' : '📄'}
          </button>
        </nav>
      </div>

      {/* ── Edit modal ── */}
      {editingEntry && (
        <EditModal
          entry={editingEntry}
          onSave={newData => handleSaveEdit(editingEntry, newData)}
          onClose={() => setEditingEntry(null)}
        />
      )}

      {/* ── PDF export overlay ── */}
      {exporting && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10000,
          background: 'rgba(255,255,255,0.92)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 12, fontFamily: 'inherit',
        }}>
          <div style={{ fontSize: 28 }}>📄</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#1a1a2e' }}>PDF 생성 중...</div>
          <div style={{ fontSize: 12, color: '#aaa' }}>잠시만 기다려주세요</div>
        </div>
      )}

      {/* ── Print area (outside layout to avoid overflow:hidden clipping) ── */}
      <div className={styles.printArea} ref={printRef}>
        {/* Cover page */}
        <div className={styles.printCover}>
          <div className={styles.coverAccent} />
          <div className={styles.coverBody}>
            <div className={styles.coverEyebrow}>VOCABULARY BOOK</div>
            <div className={styles.coverTitle}>{activeProject?.name}</div>
            <div className={styles.coverRule} />
            <div className={styles.coverMeta}>
              <span>{loadedWords.length}개 단어</span>
              <span className={styles.coverDot}>·</span>
              <span>{coverDate}</span>
            </div>
          </div>
          <div className={styles.coverFooter}>단어장 앱으로 제작되었습니다</div>
        </div>

        {/* Word cards */}
        {loadedWords.map((entry, i) => (
          <VocabCard key={entry.id} entry={entry} index={i} printMode />
        ))}
      </div>
    </>
  );
}
