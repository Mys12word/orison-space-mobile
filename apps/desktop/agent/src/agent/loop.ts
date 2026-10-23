import { randomUUID } from 'node:crypto';
import { SESSION_NUDGE_PREFIX } from '../types';
import type { ChildStreamEvent, SessionMessage, SkillExecutorRef, ToolCall, ToolContext, ToolDefinition } from '../types';
import type { CacheConfig, ContextState } from '../context/contextManager';
import type { SummarizationGenerateFn } from '../context/summarizer';
import type { PinnedContextItem } from '../context/pinnedContext';
import { prepareContext, createDefaultContextState } from '../context/contextManager';
import { logger } from '../logger';
import { assertToolAllowed, filterToolsForPolicy, type SessionPermissionMode } from '../runtime/toolPolicy';
import { appendToolDescriptions } from '../prompt/render';

interface ActiveSkillMetadata {
  name?: string;
  allowedTools?: string[];
  permission?: SessionPermissionMode;
}

export interface LoopOptions {
  sessionId: string;
  projectPath: string;
  messages: SessionMessage[];
  systemPrompt: string;
  tools: ToolDefinition[];
  maxSteps: number;
  generate: (messages: SessionMessage[], system: string, tools: ToolDefinition[], abort: AbortSignal, cacheConfig?: CacheConfig) => Promise<{
    content: string;
    toolCalls?: ToolCall[];
    finishReason: string;
  }>;
  onMessage?: (msg: SessionMessage) => void;
  abort: AbortSignal;
  skillExecutor?: SkillExecutorRef;
  spawnDepth?: number;
  emitChildEvent?: (event: ChildStreamEvent) => void;
  emitConfirmation?: (pending: import('../types').PendingConfirmationState) => void;
  permissionMode?: SessionPermissionMode;
  contextState?: ContextState;
  pinnedContext?: PinnedContextItem[];
  onContextStateUpdate?: (state: ContextState) => void;
  onCompaction?: (compactedCount: number) => void;
}

export async function runLoop(opts: LoopOptions): Promise<SessionMessage[]> {
  const { systemPrompt, tools, maxSteps, generate, onMessage, abort } = opts;
  const result: SessionMessage[] = [];
  let steps = 0;
  let contextState = opts.contextState ?? createDefaultContextState();
  let consecutiveLengthHits = 0;
  // Nudges are runtime scaffolding, not something the user typed: the marker
  // lets the chat UI hide them (the provider strips it before sending).
  const nudge = (content: string): SessionMessage => ({
    id: randomUUID(),
    role: 'user',
    content: `${SESSION_NUDGE_PREFIX}${content}`,
    createdAt: Date.now(),
  });
  // A relay can drop a stream and hand back an empty completion; silently
  // ending there looks like the agent "stopped halfway through".
  let consecutiveEmptyResponses = 0;
  const MAX_EMPTY_RESPONSE_RETRIES = 2;
  // Some models end a step by *describing* the next action ("I will check the
  // worldbuilding doc first") instead of calling the tool — or the relay loses
  // the tool-call delta but still reports finish_reason=tool_calls. Either way
  // the run would end with nothing done, so nudge the model to act.
  let consecutiveIntentOnly = 0;
  const MAX_INTENT_ONLY_RETRIES = 2;
  let consecutiveToolErrors = 0;
  const initialActiveSkill = await resolveLatestActiveSkillMetadata(opts, readLatestActiveSkillMetadata(opts.messages));
  let activeSkillAllowedTools: string[] | undefined = initialActiveSkill?.allowedTools;
  let activeSkillPermission: SessionPermissionMode | undefined = initialActiveSkill?.permission;
  const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

  // Snapshot the base messages at entry — `opts.messages` may be a live reference
  // to session.messages that gets mutated by onMessage → addMessage. We must NOT
  // re-read it on each iteration.
  let baseMessages: SessionMessage[] = [...opts.messages];

  // Build a summarization generate function that reuses the same model (no tools)
  const summarizationGenerate: SummarizationGenerateFn = async (msgs, system, abortSignal) => {
    const res = await generate(msgs, system, [], abortSignal);
    return { content: res.content };
  };

  while (steps < maxSteps) {
    throwIfAborted(abort);
    steps++;

    const visibleTools = filterToolsForPolicy({
      tools,
      sessionMode: opts.permissionMode,
      activeSkillAllowedTools,
      activeSkillPermission,
    });
    const effectiveSystemPrompt = appendToolDescriptions(systemPrompt, visibleTools);

    // --- Context management: check budget and compact if needed ---
    let allMessages = [...baseMessages, ...result];

    const prepared = await prepareContext({
      systemPrompt: effectiveSystemPrompt,
      messages: allMessages,
      contextState,
      pinnedContext: opts.pinnedContext,
      generate: summarizationGenerate,
      abort,
    });

    if (prepared.compactionOccurred) {
      // After compaction, `prepared.messages` is the retained tail.
      // We need to replace both `baseMessages` and `result` with this new set
      // so that subsequent iterations only see the compacted view.
      // Split retained messages back: those from the original base vs those from result.
      const baseIds = new Set(baseMessages.map(m => m.id));
      const newBase = prepared.messages.filter(m => baseIds.has(m.id));
      const newResult = prepared.messages.filter(m => !baseIds.has(m.id));

      baseMessages = newBase;
      result.splice(0, result.length, ...newResult);
      allMessages = prepared.messages;
      contextState = prepared.contextState;
      opts.onContextStateUpdate?.(contextState);
      opts.onCompaction?.(prepared.compactedCount);
      logger.info({ compactedCount: prepared.compactedCount }, 'in-loop compaction applied');
    }

    const cacheConfig = prepared.cacheConfig;

    const response = await generate(
      allMessages,
      effectiveSystemPrompt,
      visibleTools,
      abort,
      cacheConfig,
    );
    // A cancelled response with tool calls must still persist the assistant turn
    // and synthetic tool results as a valid pair. Plain late text is discarded.
    if (abort.aborted && !response.toolCalls?.length) throwIfAborted(abort);

    const assistantMsg: SessionMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
      createdAt: Date.now(),
    };
    result.push(assistantMsg);
    onMessage?.(assistantMsg);

    if (!response.toolCalls?.length) {
      if (response.finishReason === 'length') {
        consecutiveLengthHits++;
        if (consecutiveLengthHits >= 3) break;
        const contMsg = nudge('Continue from where you left off. Execute the next step using the appropriate tool.');
        result.push(contMsg);
        onMessage?.(contMsg);
        continue;
      }

      // Empty completion (no text, no tools) — usually a truncated stream from
      // the relay. Nudge the model to continue instead of ending the run.
      if (!String(response.content ?? '').trim()) {
        consecutiveEmptyResponses++;
        if (consecutiveEmptyResponses <= MAX_EMPTY_RESPONSE_RETRIES) {
          const emptyNudge = nudge('Your previous turn came back empty. Continue the task from exactly where you left off.');
          result.push(emptyNudge);
          onMessage?.(emptyNudge);
          continue;
        }
        const note: SessionMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: '（上游连续返回空内容：可能是中转断流，或模型只输出思考而没有正文。可以先重试一次，或换个模型再试。）',
          createdAt: Date.now(),
        };
        result.push(note);
        onMessage?.(note);
        logger.warn({ finishReason: response.finishReason }, 'model returned empty responses repeatedly');
        break;
      }

      // No tool calls but the reply reads like a plan rather than an answer
      // (or upstream claimed tool use that never arrived). One bounded nudge
      // per occurrence so a normal chat reply is never delayed.
      const droppedToolCalls = response.finishReason === 'tool_use';
      if (droppedToolCalls || looksLikeIntentOnly(response.content)) {
        consecutiveIntentOnly++;
        if (consecutiveIntentOnly <= MAX_INTENT_ONLY_RETRIES) {
          logger.warn(
            { finishReason: response.finishReason, droppedToolCalls, snippet: String(response.content ?? '').slice(0, 200) },
            'model described its next step without calling a tool — nudging',
          );
          const intentNudge = nudge(
            droppedToolCalls
              ? 'Your previous reply announced a tool call, but no call reached the runtime (the tool-call block was lost in transit). Repeat it now: actually call the tool with real arguments and continue the task.'
              : 'Your previous reply only described what you were about to do — no tool was called, so nothing actually happened. Do it now: call the tool with real arguments and continue the task. If the work is already finished, reply with the final result instead of a plan.',
          );
          result.push(intentNudge);
          onMessage?.(intentNudge);
          continue;
        }
        logger.warn(
          { finishReason: response.finishReason, attempts: consecutiveIntentOnly },
          'model kept narrating without acting; ending run',
        );
        // Make the stall visible instead of ending on a plan-only reply.
        const note: SessionMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: '（模型只说明了计划，没有真正执行工具，本次已停止。可以再发一条消息继续。）',
          createdAt: Date.now(),
        };
        result.push(note);
        onMessage?.(note);
      }
      break;
    }
    consecutiveLengthHits = 0;
    consecutiveEmptyResponses = 0;
    consecutiveIntentOnly = 0;

    // Execute tool calls in parallel
    const ctx: ToolContext = {
      sessionId: opts.sessionId,
      projectPath: opts.projectPath,
      abort,
      skillExecutor: opts.skillExecutor,
      spawnDepth: opts.spawnDepth ?? 0,
      emitChildEvent: opts.emitChildEvent,
      emitConfirmation: opts.emitConfirmation,
    };

    let terminal = false;

    if (abort.aborted) {
      for (const call of response.toolCalls) {
        const cancelOutput = 'Tool call cancelled: the run was stopped by the user before this tool executed.';
        const toolMsg: SessionMessage = {
          id: randomUUID(),
          role: 'tool',
          content: cancelOutput,
          toolResults: [{ toolCallId: call.id, toolName: call.name, output: cancelOutput }],
          createdAt: Date.now(),
        };
        result.push(toolMsg);
        onMessage?.(toolMsg);
      }
      throwIfAborted(abort);
    }

    const toolMessages = await Promise.all(response.toolCalls.map(async (call) => {
      try {
        assertToolAllowed({
          toolName: call.name,
          sessionMode: opts.permissionMode,
          activeSkillAllowedTools,
          activeSkillPermission,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          id: randomUUID(),
          role: 'tool' as const,
          content: `Error: ${errMsg}`,
          toolResults: [{ toolCallId: call.id, toolName: call.name, output: `Error: ${errMsg}` }],
          createdAt: Date.now(),
        };
      }

      const tool = visibleTools.find(t => t.id === call.name);
      if (!tool) {
        return {
          id: randomUUID(),
          role: 'tool' as const,
          content: `Error: tool "${call.name}" not found`,
          toolResults: [{ toolCallId: call.id, toolName: call.name, output: `Error: tool "${call.name}" not found` }],
          createdAt: Date.now(),
        };
      }

      try {
        let params: any;
        try {
          params = JSON.parse(call.arguments);
        } catch {
          // 某些 provider（如 DashScope/Qwen）偶尔返回畸形 arguments，
          // 例如 "{}{"name":"story",...}" — 尝试提取最后一个有效 JSON 对象
          const lastBrace = call.arguments.lastIndexOf('{');
          if (lastBrace > 0) {
            try {
              params = JSON.parse(call.arguments.slice(lastBrace));
            } catch {
              params = {};
            }
          } else {
            params = {};
          }
          // 修正存储的 arguments，防止畸形字符串进入会话历史导致后续 JSON.parse 报错
          call.arguments = JSON.stringify(params);
        }
        // 兼容某些 provider 将参数作为 JSON 字符串嵌套传入的情况
        if (typeof params === 'string') {
          try { params = JSON.parse(params); } catch { /* 保持原样 */ }
        }
        params = unwrapDoubleEncodedParams(params);
        const toolResult = await tool.execute(params, ctx);
        return {
          id: randomUUID(),
          role: 'tool' as const,
          content: toolResult.output,
          toolResults: [{
            toolCallId: call.id,
            toolName: call.name,
            output: toolResult.output,
            metadata: toolResult.metadata,
          }],
          createdAt: Date.now(),
          _terminal: toolResult.terminal,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ tool: call.name, err: errMsg }, 'tool execution failed');
        return {
          id: randomUUID(),
          role: 'tool' as const,
          content: `Error: ${errMsg}`,
          toolResults: [{ toolCallId: call.id, toolName: call.name, output: `Error: ${errMsg}` }],
          createdAt: Date.now(),
        };
      }
    }));
    throwIfAborted(abort);

    for (const msg of toolMessages) {
      const { _terminal, ...toolMsg } = msg as any;
      result.push(toolMsg);
      onMessage?.(toolMsg);
      if (_terminal) terminal = true;
      for (const toolResult of toolMsg.toolResults ?? []) {
        const nextActiveSkill = readActiveSkillMetadata(toolResult.metadata);
        if (nextActiveSkill) {
          activeSkillAllowedTools = nextActiveSkill.allowedTools;
          activeSkillPermission = nextActiveSkill.permission;
        }
      }
    }

    // 检测连续 tool 错误：所有 tool 结果都是 Error 开头则计数
    const allErrors = toolMessages.every((m: any) => m.content?.startsWith('Error:'));
    if (allErrors) {
      consecutiveToolErrors++;
      if (consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
        logger.warn('too many consecutive tool errors, breaking loop');
        break;
      }
    } else {
      consecutiveToolErrors = 0;
    }

    // 本轮存在 terminal 工具（如 skill）：它已直接对用户说完话，
    // 不再让模型基于同样的 tool 结果生成一段重复收尾，直接结束本次运行。
    if (terminal) {
      break;
    }
  }

  return result;
}

async function resolveLatestActiveSkillMetadata(opts: LoopOptions, metadata: ActiveSkillMetadata | undefined): Promise<ActiveSkillMetadata | undefined> {
  if (!metadata?.name || !opts.skillExecutor?.loadSkill) {
    return metadata;
  }
  const skill = await opts.skillExecutor.loadSkill(opts.sessionId, metadata.name);
  if (!skill) {
    return undefined;
  }
  return {
    name: skill.name,
    allowedTools: skill.allowedTools,
    permission: skill.permission,
  };
}

function readLatestActiveSkillMetadata(messages: SessionMessage[]): ActiveSkillMetadata | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'tool') continue;
    for (let resultIndex = (message.toolResults?.length ?? 0) - 1; resultIndex >= 0; resultIndex -= 1) {
      const activeSkill = readActiveSkillMetadata(message.toolResults?.[resultIndex]?.metadata);
      if (activeSkill) return activeSkill;
    }
  }
  return undefined;
}

function readActiveSkillMetadata(metadata: Record<string, unknown> | undefined): ActiveSkillMetadata | undefined {
  const activeSkill = metadata?.activeSkill;
  if (!activeSkill || typeof activeSkill !== 'object') return undefined;
  const name = (activeSkill as { name?: unknown }).name;
  const allowedTools = (activeSkill as { allowedTools?: unknown }).allowedTools;
  const permission = (activeSkill as { permission?: unknown }).permission;
  const normalizedPermission = permission === 'readonly' || permission === 'suggest' || permission === 'auto'
    ? permission
    : undefined;
  return {
    allowedTools: Array.isArray(allowedTools)
      ? allowedTools.filter((tool): tool is string => typeof tool === 'string')
      : undefined,
    name: typeof name === 'string' ? name : undefined,
    permission: normalizedPermission,
  };
}

function throwIfAborted(abort: AbortSignal): void {
  if (abort.aborted) {
    throw abort.reason instanceof DOMException
      ? abort.reason
      : new DOMException('Aborted', 'AbortError');
  }
}

/**
 * Heuristic for an "announcement-only" turn: the model writes one to three short
 * sentences about what it is about to do ("I should look at the docs first",
 * "我先看一下世界观设定") and ends the turn without calling any tool. Real
 * answers, questions back to the user and completion reports must not match —
 * a false positive only costs one extra round-trip, a false negative leaves the
 * user staring at a stopped agent.
 */
function looksLikeIntentOnly(content: unknown): boolean {
  const text = String(content ?? '').trim();
  if (!text || text.length > 400) return false;
  if (/[?？]\s*$/.test(text)) return false;
  if (/已(?:经)?(?:保存|写入|写好|完成)|保存到|写入到|\bsaved to\b|\bwritten to\b/i.test(text)) return false;
  const sentences = text.split(/[.!?。！？\n]+/).map(part => part.trim()).filter(Boolean);
  if (sentences.length === 0 || sentences.length > 3) return false;
  const head = sentences[0].replace(/^[*`"'\s]+|[*`"'\s]+$/g, '');
  if (!head) return false;
  const action = /\b(?:check|look|read|open|search|review|inspect|examine|explore|scan|list|start|begin|write|save|update|fetch|load|gather|see)\b/i.test(head);
  if (!action) return false;
  const announcing = /^(?:let me|let us)\b/i.test(head)
    || /\b(?:i|we)\b[^.]*\b(?:will|'ll|should|need to|am going to|'m going to|must|have to)\b/i.test(head)
    || /^(?:让我|我先|我会先|我这就|接下来我|现在我去|我准备|我马上|我需要先|先看|先读|先查|先去)/.test(head);
  return announcing;
}

/**
 * Some providers (observed with Claude relays) double-encode scalar arguments:
 * the model sends dirPath as a quoted string ( wrapped in quotes), so the
 * tool looks for a directory literally named ".". Unwrap one JSON layer for
 * short values; long fields (chapter content) are left alone because quoted
 * prose is legal.
 */
function unwrapDoubleEncodedParams(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key === 'content' || key === 'text' || key === 'markdown') return value;
    const trimmed = value.trim();
    if (trimmed.length < 200 && trimmed.startsWith(String.fromCharCode(34)) && trimmed.endsWith(String.fromCharCode(34))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string' && !parsed.includes(String.fromCharCode(10))) return parsed;
      } catch { /* keep as-is */ }
    }
    if (trimmed.length < 4000 && trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return unwrapDoubleEncodedParams(parsed, key);
      } catch { /* keep as-is */ }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => unwrapDoubleEncodedParams(item, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = unwrapDoubleEncodedParams(v, k);
    }
    return out;
  }
  return value;
}
