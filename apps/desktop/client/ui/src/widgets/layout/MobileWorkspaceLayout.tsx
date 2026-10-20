import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { ProjectTree } from '../../features/project-tree/ProjectTree';
import { AgentPanel } from '../../features/agent-panel/AgentPanel';
import { PageSkeleton } from '../../shared/components/PageSkeleton';
import { ErrorBoundary } from '../../shared/components/ErrorBoundary';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAutoSave } from '../../shared/hooks/useAutoSave';
import { openWriting } from '../../features/editor/openWriting';

const SearchPanel = lazy(() => import('../../features/search-panel/SearchPanel').then((m) => ({ default: m.SearchPanel })));
const TimelinePanel = lazy(() => import('../../features/timeline/TimelinePanel').then((m) => ({ default: m.TimelinePanel })));
const OverviewPage = lazy(() => import('../../features/overview/OverviewPage').then((m) => ({ default: m.OverviewPage })));
const OutlineEditor = lazy(() => import('../../features/editor/OutlineEditor').then((m) => ({ default: m.OutlineEditor })));
const WritingStart = lazy(() => import('../../features/editor/WritingStart').then((m) => ({ default: m.WritingStart })));
const ChapterStrip = lazy(() => import('../../features/editor/ChapterStrip').then((m) => ({ default: m.ChapterStrip })));
const ImageGenEditor = lazy(() => import('../../features/editor/ImageGenEditor').then((m) => ({ default: m.ImageGenEditor })));
const AssetsPanel = lazy(() => import('../../features/assets/AssetsPanel').then((m) => ({ default: m.AssetsPanel })));
const FileTabBar = lazy(() => import('../../features/editor/FileTabBar').then((m) => ({ default: m.FileTabBar })));
const FileEditor = lazy(() => import('../../features/editor/FileEditor').then((m) => ({ default: m.FileEditor })));

type TabId = 'tree' | 'overview' | 'outline' | 'write' | 'assets' | 'agent';

/**
 * Phone layout: one column, bottom tab bar, slide-over file tree and a
 * full-screen Agent sheet. Reuses every existing panel; only the composition
 * changes, so desktop and mobile share all state and behaviour.
 */
export function MobileWorkspaceLayout() {
  const {
    activePage, setActivePage,
    mainView, setMainView,
    openFiles, activeFilePath,
    projectTreeOpen, toggleProjectTree,
    activeSidebarPanel, setActiveSidebarPanel,
    agentPanelOpen, toggleAgentPanel,
    novelChapters,
    resolvedLocale,
  } = useAppStore(useShallow((s) => ({
    activePage: s.activePage,
    setActivePage: s.setActivePage,
    mainView: s.mainView,
    setMainView: s.setMainView,
    openFiles: s.openFiles,
    activeFilePath: s.activeFilePath,
    projectTreeOpen: s.projectTreeOpen,
    toggleProjectTree: s.toggleProjectTree,
    activeSidebarPanel: s.activeSidebarPanel,
    setActiveSidebarPanel: s.setActiveSidebarPanel,
    agentPanelOpen: s.agentPanelOpen,
    toggleAgentPanel: s.toggleAgentPanel,
    novelChapters: s.novelChapters,
    resolvedLocale: s.resolvedLocale,
  })));

  const { t } = useI18n(resolvedLocale);
  useAutoSave();

  const hasOpenFiles = openFiles.length > 0;

  // The desktop default keeps the tree open; on a phone it must start closed so
  // the manuscript gets the full width.
  const [treeOpen, setTreeOpen] = useState(false);
  const [sidebarPanel, setSidebarPanel] = useState(activeSidebarPanel);

  // Close the drawer whenever a file becomes active (tree tap → start reading).
  const lastActive = useRef(activeFilePath);
  useEffect(() => {
    if (activeFilePath && activeFilePath !== lastActive.current) setTreeOpen(false);
    lastActive.current = activeFilePath;
  }, [activeFilePath]);

  const openPanel = (id: TabId) => {
    if (id === 'tree') {
      setTreeOpen((open) => !open);
      return;
    }
    if (id === 'agent') {
      toggleAgentPanel();
      return;
    }
    setTreeOpen(false);
    if (id === 'write') {
      if (!hasOpenFiles) {
        // No manuscript yet: show the create-first-chapter surface instead of
        // silently bouncing back to the outline.
        if (novelChapters.length === 0) {
          setActivePage('write');
          return;
        }
        void openWriting();
        return;
      }
      setMainView('files');
      return;
    }
    setActivePage(id);
  };

  const isActive = (id: TabId): boolean => {
    if (id === 'tree') return treeOpen;
    if (id === 'agent') return agentPanelOpen;
    if (id === 'write') return mainView === 'files' && hasOpenFiles;
    return mainView === 'page' && activePage === id;
  };

  const tabs: Array<{ id: TabId; icon: string; label: string }> = [
    { id: 'tree', icon: 'folder_open', label: t('nav.explorer') },
    { id: 'overview', icon: 'dashboard', label: t('nav.overview') },
    { id: 'outline', icon: 'account_tree', label: t('nav.outline') },
    { id: 'write', icon: 'edit_note', label: t('nav.writing') },
    { id: 'assets', icon: 'style', label: t('nav.assets') },
    { id: 'agent', icon: 'auto_awesome', label: t('agent.title') },
  ];

  const renderMain = () => {
    if (mainView === 'files' && hasOpenFiles) {
      return (
        <>
          <FileTabBar />
          <Suspense fallback={null}>
            <ChapterStrip />
          </Suspense>
          <div className="workspace-content workspace-content--flush mobile-editor-surface" style={{ flex: 1, minWidth: 0 }}>
            <FileEditor />
          </div>
        </>
      );
    }
    switch (activePage) {
      case 'overview': return <div className="workspace-content workspace-content--flush"><OverviewPage /></div>;
      case 'outline': return <div className="workspace-content workspace-content--flush"><OutlineEditor /></div>;
      case 'novel':
      case 'script': return <div className="workspace-content workspace-content--flush"><OverviewPage /></div>;
      case 'write': return <div className="workspace-content workspace-content--flush"><WritingStart /></div>;
      case 'image_gen': return <div className="workspace-panel-content"><ImageGenEditor /></div>;
      case 'assets': return <div className="workspace-panel-content"><AssetsPanel /></div>;
      default: return <div className="workspace-content workspace-content--flush"><OverviewPage /></div>;
    }
  };

  const renderSidebar = () => {
    if (sidebarPanel === 'timeline') return <TimelinePanel />;
    if (sidebarPanel === 'search') return <SearchPanel />;
    return <ProjectTree />;
  };

  return (
    <div className="workspace-shell mobile-workspace">
      <div className="mobile-main">
        <div id="main-content" tabIndex={-1} className="workspace-main">
          <ErrorBoundary>
            <Suspense fallback={<PageSkeleton variant="page" />}>
              {renderMain()}
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>

      {treeOpen && createPortal(
        <div className="mobile-drawer-backdrop" onClick={() => setTreeOpen(false)}>
          <aside
            className="mobile-drawer"
            onClick={(event) => event.stopPropagation()}
            aria-label={t('nav.explorer')}
          >
            <div className="mobile-drawer-head">
              <div className="mobile-segmented" role="tablist">
                {([
                  ['explorer', 'folder', t('nav.explorer')],
                  ['search', 'search', t('nav.search')],
                  ['timeline', 'history', t('nav.timeline')],
                ] as const).map(([panel, icon, label]) => (
                  <button
                    key={panel}
                    type="button"
                    role="tab"
                    aria-selected={sidebarPanel === panel}
                    className={`mobile-segmented-btn${sidebarPanel === panel ? ' is-active' : ''}`}
                    onClick={() => {
                      setSidebarPanel(panel);
                      setActiveSidebarPanel(panel);
                    }}
                  >
                    <span className="material-symbols-outlined">{icon}</span>
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="mobile-icon-btn"
                onClick={() => setTreeOpen(false)}
                aria-label="关闭"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="mobile-drawer-body">
              <ErrorBoundary>
                <Suspense fallback={<PageSkeleton variant="sidebar" />}>
                  {renderSidebar()}
                </Suspense>
              </ErrorBoundary>
            </div>
          </aside>
        </div>,
        document.body,
      )}

      {agentPanelOpen && createPortal(
        <div className="mobile-sheet" role="dialog" aria-modal="true" aria-label={t('agent.title')}>
          <div className="mobile-sheet-head">
            <button type="button" className="mobile-sheet-close" onClick={toggleAgentPanel}>
              <span className="material-symbols-outlined">keyboard_arrow_down</span>
              <span>收起</span>
            </button>
          </div>
          <div className="mobile-sheet-body">
            <AgentPanel />
          </div>
        </div>,
        document.body,
      )}

      <nav className="mobile-tabbar" aria-label="主导航">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`mobile-tabbar-item${isActive(tab.id) ? ' is-active' : ''}`}
            aria-current={isActive(tab.id) ? 'page' : undefined}
            onClick={() => openPanel(tab.id)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">{tab.icon}</span>
            <span className="mobile-tabbar-label">{tab.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
