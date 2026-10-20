import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { normalizePath } from '../../shared/utils/paths';
import { openWriting } from './openWriting';

/**
 * Horizontal chapter strip for the phone editor: with one chapter open there
 * was no way to jump to another one without digging into the file drawer.
 */
export function ChapterStrip() {
  const { currentProject, novelChapters, activeFilePath, resolvedLocale } = useAppStore(useShallow((s) => ({
    currentProject: s.currentProject,
    novelChapters: s.novelChapters,
    activeFilePath: s.activeFilePath,
    resolvedLocale: s.resolvedLocale,
  })));
  const { t } = useI18n(resolvedLocale);

  const activeId = useMemo(() => {
    if (!currentProject?.path || !activeFilePath) return null;
    const base = normalizePath(currentProject.path).replace(/\/+$/, '');
    const current = normalizePath(activeFilePath);
    const hit = novelChapters.find((ch) => {
      const contentFile = ch.sections?.[0]?.contentFile;
      return contentFile ? normalizePath(`${base}/${contentFile}`) === current : false;
    });
    return hit?.id ?? null;
  }, [currentProject?.path, activeFilePath, novelChapters]);

  if (novelChapters.length === 0) return null;

  return (
    <div className="chapter-strip" role="tablist" aria-label={t('writing.switchChapter')}>
      {novelChapters.map((chapter, index) => (
        <button
          key={chapter.id}
          type="button"
          role="tab"
          aria-selected={chapter.id === activeId}
          className={`chapter-chip${chapter.id === activeId ? ' is-active' : ''}`}
          onClick={() => {
            if (chapter.id === activeId) return;
            useAppStore.getState().selectChapter(chapter.id);
            void openWriting(chapter);
          }}
        >
          <span className="chapter-chip-index">{index + 1}</span>
          <span className="chapter-chip-title">{chapter.title || `第 ${index + 1} 章`}</span>
        </button>
      ))}
    </div>
  );
}
