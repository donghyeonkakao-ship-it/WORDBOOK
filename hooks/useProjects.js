import { useState, useEffect, useCallback } from 'react';

const KEY = 'vocab_projects_v1';

export default function useProjects() {
  const [projects, setProjects] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (stored?.projects?.length) {
        setProjects(stored.projects);
        setActiveId(stored.activeId || stored.projects[0].id);
      } else {
        const p = { id: crypto.randomUUID(), name: '기본 프로젝트', words: [] };
        setProjects([p]);
        setActiveId(p.id);
      }
    } catch {
      const p = { id: crypto.randomUUID(), name: '기본 프로젝트', words: [] };
      setProjects([p]);
      setActiveId(p.id);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(KEY, JSON.stringify({ projects, activeId }));
  }, [projects, activeId, ready]);

  const activeProject = projects.find(p => p.id === activeId) ?? null;

  const createProject = useCallback((name) => {
    const p = { id: crypto.randomUUID(), name, words: [] };
    setProjects(prev => [...prev, p]);
    setActiveId(p.id);
  }, []);

  const deleteProject = useCallback((id) => {
    setProjects(prev => {
      const next = prev.filter(p => p.id !== id);
      if (next.length === 0) {
        const fallback = { id: crypto.randomUUID(), name: '기본 프로젝트', words: [] };
        setActiveId(fallback.id);
        return [fallback];
      }
      setActiveId(a => (a === id ? next[0].id : a));
      return next;
    });
  }, []);

  const renameProject = useCallback((id, name) => {
    setProjects(prev => prev.map(p => (p.id === id ? { ...p, name } : p)));
  }, []);

  const addWord = useCallback((projectId, entry) => {
    setProjects(prev =>
      prev.map(p => (p.id === projectId ? { ...p, words: [...p.words, entry] } : p))
    );
  }, []);

  const updateWord = useCallback((projectId, wordId, changes) => {
    setProjects(prev =>
      prev.map(p =>
        p.id === projectId
          ? { ...p, words: p.words.map(w => (w.id === wordId ? { ...w, ...changes } : w)) }
          : p
      )
    );
  }, []);

  const deleteWord = useCallback((projectId, wordId) => {
    setProjects(prev =>
      prev.map(p =>
        p.id === projectId ? { ...p, words: p.words.filter(w => w.id !== wordId) } : p
      )
    );
  }, []);

  return {
    projects, activeId, setActiveId, activeProject,
    createProject, deleteProject, renameProject,
    addWord, updateWord, deleteWord,
  };
}
