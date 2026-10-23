import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import type { AgentMessage } from '../../shared/store/agentSlice';
import { AgentMessageItem } from './AgentMessageItem';
import { ChildExecutionGroup } from './ChildExecutionGroup';
import { parseChildTag } from './toolMeta';

type Props = {
  messages: AgentMessage[];
  loading: boolean;
  error: string | null;
  /** Prose already streamed for the message being written, if any. */
  streaming?: string | null;
};

type MessageGroup =
  | { type: 'single'; message: AgentMessage; index: number }
  | { type: 'child-group'; source: 'skill' | 'subagent'; role: string; depth: number; messages: AgentMessage[] };

/** Must match SESSION_NUDGE_PREFIX in @orison/desktop-agent. */
const RUNTIME_NUDGE_PREFIX = '⟦nudge⟧ ';

function groupMessages(messages: AgentMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const tag = parseChildTag(msg.content ?? '');
    if (!tag) {
      groups.push({ type: 'single', message: msg, index: i });
      i++;
      continue;
    }
    const batch: AgentMessage[] = [msg];
    let j = i + 1;
    while (j < messages.length) {
      const nextTag = parseChildTag(messages[j].content ?? '');
      if (!nextTag || nextTag.source !== tag.source || nextTag.role !== tag.role || nextTag.depth !== tag.depth) break;
      batch.push(messages[j]);
      j++;
    }
    if (batch.length >= 2) {
      groups.push({ type: 'child-group', source: tag.source, role: tag.role, depth: tag.depth, messages: batch });
    } else {
      groups.push({ type: 'single', message: msg, index: i });
    }
    i = j;
  }
  return groups;
}

/** First line of a message, short enough to sit in the outline list. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

export function AgentMessages({ messages, loading, error, streaming }: Props) {
  const { resolvedLocale } = useAppStore(useShallow((s) => ({ resolvedLocale: s.resolvedLocale })));
  const { t } = useI18n(resolvedLocale);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const anchorsRef = useRef(new Map<string, HTMLDivElement>());
  const [atBottom, setAtBottom] = useState(true);
  const [outlineOpen, setOutlineOpen] = useState(false);

  // Runtime nudges ("continue from where you left off") are stored as user
  // messages so the model answers them, but the user never typed them.
  const visibleMessages = useMemo(
    () => messages.filter((m) => !(m.role === 'user' && (m.content ?? '').startsWith(RUNTIME_NUDGE_PREFIX))),
    [messages],
  );

  const grouped = useMemo(() => groupMessages(visibleMessages), [visibleMessages]);

  // Outline lists what the user actually sent — the assistant/tool noise stays out.
  const sentMessages = useMemo(
    () => visibleMessages.filter((m) => m.role === 'user' && (m.content ?? '').trim().length > 0),
    [visibleMessages],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, loading]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  const jumpToMessage = useCallback((id: string) => {
    setOutlineOpen(false);
    const target = anchorsRef.current.get(id);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const registerAnchor = (id: string) => (el: HTMLDivElement | null) => {
    if (el) anchorsRef.current.set(id, el);
    else anchorsRef.current.delete(id);
  };

  return (
    <div className="agent-messages-wrap">
      <div className="agent-messages" ref={containerRef} onScroll={handleScroll}>
        {messages.length === 0 && !loading && (
          <div className="agent-messages-empty">
            <span className="material-symbols-outlined">smart_toy</span>
            <p>{t('agent.emptyHint')}</p>
          </div>
        )}
        {grouped.map((group, gi) => {
          if (group.type === 'single') {
            return (
              <div key={group.message.id} ref={registerAnchor(group.message.id)} className="agent-msg-anchor">
                <AgentMessageItem
                  message={group.message}
                  isLatest={group.index === messages.length - 1}
                />
              </div>
            );
          }
          return (
            <div key={`child-${gi}-${group.source}-${group.role}`} ref={registerAnchor(group.messages[0].id)} className="agent-msg-anchor">
              <ChildExecutionGroup
                source={group.source}
                role={group.role}
                depth={group.depth}
                messages={group.messages}
                isLatestGroup={group.messages[group.messages.length - 1] === messages[messages.length - 1]}
              />
            </div>
          );
        })}
        {loading && !!streaming && (
          <div className="agent-msg-anchor">
            <AgentMessageItem
              message={{ id: "streaming", role: "assistant", content: streaming, createdAt: Date.now() }}
              isLatest
            />
          </div>
        )}
        {loading && !streaming && (
          <div className="agent-message-loading">
            <span className="agent-loading-dot" />
            <span className="agent-loading-dot" />
            <span className="agent-loading-dot" />
          </div>
        )}
        {error && (
          <div className="agent-message-error">
            {renderError(error, t)}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <button
        type="button"
        className="agent-outline-fab"
        onClick={() => setOutlineOpen(true)}
        title={t('agent.outlineTitle')}
        aria-label={t('agent.outlineTitle')}
      >
        <span className="material-symbols-outlined" aria-hidden="true">toc</span>
      </button>

      {!atBottom && (
        <button
          type="button"
          className="agent-jump-bottom"
          onClick={scrollToBottom}
          title={t('agent.jumpToLatest')}
          aria-label={t('agent.jumpToLatest')}
        >
          <span className="material-symbols-outlined" aria-hidden="true">arrow_downward</span>
        </button>
      )}

      {outlineOpen && (
        <div className="agent-outline-overlay" onClick={() => setOutlineOpen(false)}>
          <div
            className="agent-outline-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={t('agent.outlineTitle')}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="agent-outline-head">
              <span>{t('agent.outlineTitle')}</span>
              <button
                type="button"
                className="agent-panel-icon-btn"
                onClick={() => setOutlineOpen(false)}
                aria-label={t('agent.close')}
              >
                <span className="material-symbols-outlined" aria-hidden="true">close</span>
              </button>
            </div>
            <div className="agent-outline-list">
              {sentMessages.length === 0 ? (
                <p className="agent-outline-empty">{t('agent.outlineEmpty')}</p>
              ) : (
                sentMessages.map((message, index) => (
                  <button
                    key={message.id}
                    type="button"
                    className="agent-outline-item"
                    onClick={() => jumpToMessage(message.id)}
                  >
                    <span className="agent-outline-index">{index + 1}</span>
                    <span className="agent-outline-text">{snippet(message.content ?? '')}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// agentError holds either a raw backend message or an i18n key. Keys may carry a
// trailing detail as `agent.someKey: detail`; translate the key part and keep
// the detail. Anything not prefixed `agent.` is shown verbatim (backend text).
function renderError(error: string, t: (key: string) => string): string {
  if (!error.startsWith('agent.')) return error;
  const sep = error.indexOf(': ');
  if (sep === -1) return t(error);
  const key = error.slice(0, sep);
  const detail = error.slice(sep + 2);
  return `${t(key)}: ${detail}`;
}
