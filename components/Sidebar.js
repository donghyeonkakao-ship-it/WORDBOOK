import { useRef, useState } from 'react';
import styles from '../styles/sidebar.module.css';

const AVATAR_COLORS = ['#5b84c4', '#7c7deb', '#5bbcca', '#ca8a5b', '#7eb87e', '#c45b8a'];

function getColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function ProjectItem({ p, isActive, onSelect, onRename, onDelete }) {
  const [editing, setEditing]   = useState(false);
  const [editName, setEditName] = useState('');
  const cancelledRef            = useRef(false);

  const startEdit = (e) => {
    e?.stopPropagation();
    cancelledRef.current = false;
    setEditName(p.name);
    setEditing(true);
  };

  const commitRename = () => {
    if (cancelledRef.current) return;
    const name = editName.trim();
    if (name && name !== p.name) onRename(p.id, name);
    setEditing(false);
  };

  const cancelEdit = () => {
    cancelledRef.current = true;
    setEditing(false);
  };

  if (editing) {
    return (
      <li className={`${styles.item} ${isActive ? styles.active : ''} ${styles.itemEditing}`}>
        <div className={styles.avatar} style={{ background: getColor(p.name) }}>
          {p.name.charAt(0)}
        </div>
        <input
          className={styles.renameInput}
          value={editName}
          onChange={e => setEditName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === 'Enter')  { e.preventDefault(); commitRename(); }
            if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
          }}
          onClick={e => e.stopPropagation()}
          autoFocus
          selectAll
        />
        <button className={styles.renameOk}  onMouseDown={e => { e.preventDefault(); commitRename(); }}>✓</button>
        <button className={styles.renameCancel} onMouseDown={e => { e.preventDefault(); cancelEdit(); }}>✕</button>
      </li>
    );
  }

  return (
    <li
      className={`${styles.item} ${isActive ? styles.active : ''}`}
      onClick={() => onSelect(p.id)}
      onDoubleClick={startEdit}
      title="더블클릭하여 이름 변경"
    >
      <div className={styles.avatar} style={{ background: getColor(p.name) }}>
        {p.name.charAt(0)}
      </div>
      <span className={styles.projectName}>{p.name}</span>
      <span className={styles.badge}>{p.words.length}</span>
      <div className={styles.actions}>
        <button title="이름 변경" onClick={startEdit}>✐</button>
        <button
          title="삭제"
          onClick={e => {
            e.stopPropagation();
            if (window.confirm(`"${p.name}" 삭제할까요?`)) onDelete(p.id);
          }}
        >✕</button>
      </div>
    </li>
  );
}

function CreateForm({ onCreate, onCancel }) {
  const [name, setName] = useState('');
  const submit = () => { if (name.trim()) onCreate(name.trim()); };

  return (
    <div className={styles.createForm}>
      <input
        className={styles.createInput}
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
        placeholder="프로젝트 이름"
        autoFocus
      />
      <div className={styles.createButtons}>
        <button className={styles.confirmBtn} onClick={submit}>추가</button>
        <button className={styles.cancelBtn}  onClick={onCancel}>취소</button>
      </div>
    </div>
  );
}

export default function Sidebar({
  projects, activeId, onSelect, onCreate, onDelete, onRename,
  mobileOpen, onMobileClose,
}) {
  const [creating, setCreating] = useState(false);

  const handleCreate = (name) => {
    onCreate(name);
    setCreating(false);
    if (onMobileClose) onMobileClose();
  };

  return (
    <>
      {/* ── Desktop sidebar ── */}
      <aside className={styles.sidebar}>
        <div className={styles.logo}>
          <div className={styles.logoMark}>📖</div>
          <span className={styles.logoText}>단어장</span>
          <button className={styles.addBtn} onClick={() => setCreating(c => !c)} title="새 프로젝트">+</button>
        </div>

        <div className={styles.sectionLabel}>프로젝트</div>

        <ul className={styles.list}>
          {projects.map(p => (
            <ProjectItem
              key={p.id}
              p={p}
              isActive={p.id === activeId}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </ul>

        {creating && <CreateForm onCreate={handleCreate} onCancel={() => setCreating(false)} />}
      </aside>

      {/* ── Mobile drawer ── */}
      {mobileOpen && (
        <div className={styles.overlay} onClick={onMobileClose}>
          <div className={styles.drawer} onClick={e => e.stopPropagation()}>
            <div className={styles.drawerHandle} />
            <div className={styles.drawerHeader}>
              <span className={styles.drawerTitle}>프로젝트</span>
              <button className={styles.addBtn} onClick={() => setCreating(c => !c)}>+</button>
            </div>
            <ul className={styles.drawerList}>
              {projects.map(p => (
                <ProjectItem
                  key={p.id}
                  p={p}
                  isActive={p.id === activeId}
                  onSelect={(id) => { onSelect(id); onMobileClose(); }}
                  onRename={onRename}
                  onDelete={onDelete}
                />
              ))}
            </ul>
            {creating && (
              <div className={styles.drawerCreateForm}>
                <CreateForm onCreate={handleCreate} onCancel={() => setCreating(false)} />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
