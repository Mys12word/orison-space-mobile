import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { useToastStore } from '../../shared/store/toastStore';
import { deriveChaptersFromDisk } from '../../shared/store/chapterDiskDerivation';
import { normalizePath } from '../../shared/utils/paths';

/**
 * The writing surface when the project has no chapters yet.
 *
 * A brand-new project ships with an empty `novel.chapters` and no `chapters/`
 * directory (chapters are normally created by the agent's `chapter_write`), so
 * the "writing" entry point used to bounce straight back to the outline with no
 * explanation. This view makes the next step explicit and creates the first
 * manuscript file on the spot.
 */
export function WritingStart() {
  const { currentProject, novelChapters, resolvedLocale } = useAppStore(useShallow((s) => ({
    currentProject: s.currentProject,
    novelChapters: s.novelChapters,
    resolvedLocale: s.resolvedLocale,
  })));
  const { t } = useI18n(resolvedLocale);
  const showToast = useToastStore((s) => s.showToast);
  const [creating, setCreating] = useState(false);

  const chapterCount = novelChapters.length;

  const handleCreate = async () => {
    const projectPath = currentProject?.path;
    if (!projectPath || creating) return;
    setCreating(true);
    const index = chapterCount + 1;
    try {
      const base = normalizePath(projectPath).replace(/\/+$/, '');
      const fileName = `ch-${String(index).padStart(3, '0')}.md`;
      const contentFile = `chapters/${fileName}`;
      const content = `# 第 ${index} 章\n\n`;
      await window.orisonDesktop?.writeFile(`${base}/${contentFile}`, content);

      const derived = await deriveChaptersFromDisk(base, useAppStore.getState().novelChapters);
      const state = useAppStore.getState();
      state.setNovelChapters(derived);

      const fresh = derived.find((ch) => ch.sections?.[0]?.contentFile === contentFile);
      if (fresh) state.selectChapter(fresh.id);
      state.openFile(`${base}/${contentFile}`, fileName, content);
      state.setMainView('files');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      showToast(t('writing.createFailed', { reason }), 'error');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="writing-start">
      <span className="material-symbols-outlined writing-start-icon" aria-hidden="true">edit_note</span>
      <h2 className="writing-start-title">{t('writing.emptyTitle')}</h2>
      <p className="writing-start-hint">{t('writing.emptyHint')}</p>
      <button
        type="button"
        className="writing-start-create"
        onClick={() => void handleCreate()}
        disabled={creating || !currentProject?.path}
      >
        <span className="material-symbols-outlined" aria-hidden="true">add</span>
        {creating
          ? t('writing.creating')
          : t(chapterCount === 0 ? 'writing.createFirst' : 'writing.createNext')}
      </button>
    </div>
  );
}
