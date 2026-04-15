/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

import type {
  BridgeStatus,
  ChannelBinding,
  InboundMessage,
  OutboundMessage,
  PermissionProfile,
  StreamingPreviewState,
  ToolCallInfo,
} from './types.js';
import type { BridgeSession } from './host.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver, deliverRendered } from './delivery-layer.js';
import { markdownToTelegramChunks } from './markdown/telegram.js';
import { markdownToDiscordChunks } from './markdown/discord.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
  validatePermissionProfile,
  validateModel,
} from './security/validators.js';

const GLOBAL_KEY = '__bridge_manager__';
const CWD_INPUT_TTL_MS = 5 * 60 * 1000;
const KNOWN_SLASH_COMMANDS = new Set([
  '/start',
  '/new',
  '/import',
  '/resume',
  '/bind',
  '/cwd',
  '/mode',
  '/model',
  '/permission',
  '/status',
  '/sessions',
  '/stop',
  '/perm',
  '/help',
]);
const MODEL_PANEL_PRESETS = [
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Spark' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 Thinking' },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
] as const;
const MODEL_DEFAULT_CALLBACK = 'ui:model:default';
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = 5_000;
const EXTERNAL_CODEX_SCAN_TTL_MS = 60 * 1000;
const EXTERNAL_CODEX_INDEX_MAX = 500;

interface ExternalCodexSessionSummary {
  id: string;
  cwd: string;
  updatedAt: string;
  threadName: string;
}

interface ModelOption {
  id: string;
  label: string;
}

interface ModelCatalog {
  models: ModelOption[];
  source: 'dynamic' | 'fallback';
}

let modelCatalogCache: { catalog: ModelCatalog; expiresAt: number } | null = null;
let modelCatalogInflight: Promise<ModelCatalog> | null = null;
let externalCodexSessionsCache: { sessions: ExternalCodexSessionSummary[]; expiresAt: number } | null = null;

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * feishu/qq channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq' && channelType !== 'weixin') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types.js';

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(responseText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(responseText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  /** Chat-level state: waiting for the next absolute path as /cwd input */
  pendingCwdInput: Map<string, number>;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      sessionLocks: new Map(),
      pendingCwdInput: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  if (!g[GLOBAL_KEY].pendingCwdInput) {
    g[GLOBAL_KEY].pendingCwdInput = new Map();
  }
  return g[GLOBAL_KEY];
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes.
  // Suppress rejection on the cleanup chain — callers handle errors on `current` directly.
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (store.getSetting(settingKey) !== 'true') continue;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.pendingCwdInput.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for feishu/qq MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId)
        ) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission/session/settings buttons)
  if (msg.callbackData) {
    const handled = msg.callbackData.startsWith('perm:')
      ? broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId)
      : await handleUiCallback(adapter, msg, msg.callbackData);
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // Handle attachment-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    const rawData = msg.raw as {
      imageDownloadFailed?: boolean;
      attachmentDownloadFailed?: boolean;
      failedCount?: number;
      failedLabel?: string;
      userVisibleError?: string;
    } | undefined;
    if (rawData?.userVisibleError) {
      await deliver(adapter, {
        address: msg.address,
        text: rawData.userVisibleError,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    } else if (rawData?.imageDownloadFailed || rawData?.attachmentDownloadFailed) {
      const failureLabel = rawData.failedLabel || (rawData.imageDownloadFailed ? 'image(s)' : 'attachment(s)');
      await deliver(adapter, {
        address: msg.address,
        text: `下载 ${rawData.failedCount ?? 1} 个${failureLabel}失败，请重试。`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (feishu/qq/weixin only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (
    adapter.channelType === 'feishu'
    || adapter.channelType === 'qq'
    || adapter.channelType === 'weixin'
  ) {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[123]$/.test(normalized)) {
      const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId);
      if (pendingLinks.length === 1) {
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
        const label = normalized === '1' ? '允许一次' : normalized === '2' ? '本会话允许' : '拒绝';
        if (handled) {
          await deliver(adapter, {
            address: msg.address,
            text: `${label}: 已记录。`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: '未找到对应权限请求，或该请求已处理。',
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliver(adapter, {
          address: msg.address,
          text: `当前有 ${pendingLinks.length} 条待处理权限，快捷数字无法判断。\n请使用完整命令：\n/perm allow|allow_session|deny <id>`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // If /cwd chooser is active for this chat, allow one-shot absolute path input
  // without requiring "/cwd /path". Known slash commands still keep their normal behavior.
  if (isAwaitingCwdInput(msg.address) && !hasAttachments) {
    const firstToken = rawText.split(/\s+/)[0].split('@')[0].toLowerCase();
    if (firstToken === '/cancel') {
      clearPendingCwdInput(msg.address);
      await deliver(adapter, {
        address: msg.address,
        text: '已取消目录输入。',
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }

    if (!isKnownSlashCommand(firstToken)) {
      const result = switchWorkingDirectory(msg.address, rawText);
      if (result.ok) {
        clearPendingCwdInput(msg.address);
        await deliver(adapter, {
          address: msg.address,
          text: result.text,
          parseMode: 'HTML',
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      await deliver(adapter, {
        address: msg.address,
        text: `${result.text}\n请发送绝对路径（例如 /home/tom/项目），或发送 /cancel 取消。`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  // Build the preview onPartialText callback (or undefined if preview not supported)
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  // ── Streaming card setup (Feishu CardKit v2) ──────────────────
  // If the adapter supports streaming cards (e.g. Feishu), wire up
  // onStreamText, onToolEvent, and onStreamEnd callbacks.
  // These run in parallel with the existing preview system — Feishu
  // uses cards instead of message edit for streaming.
  const hasStreamingCards = typeof adapter.onStreamText === 'function';
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onStreamCardText = hasStreamingCards ? (fullText: string) => {
    try { adapter.onStreamText!(msg.address.chatId, fullText); } catch { /* non-critical */ }
  } : undefined;

  const onToolEvent = hasStreamingCards ? (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (toolName) {
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      // tool_result doesn't carry name — update existing entry's status
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      adapter.onToolEvent!(msg.address.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
  } : undefined;

  // Combined partial text callback: streaming preview + streaming cards
  const onPartialText = (previewOnPartialText || onStreamCardText) ? (fullText: string) => {
    if (previewOnPartialText) previewOnPartialText(fullText);
    if (onStreamCardText) onStreamCardText(fullText);
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');

    const result = await engine.processMessage(binding, promptText, async (perm) => {
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, onToolEvent);

    // Finalize streaming card if adapter supports it.
    // onStreamEnd awaits any in-flight card creation and returns true if a card
    // was actually finalized (meaning content is already visible to the user).
    let cardFinalized = false;
    if (hasStreamingCards && adapter.onStreamEnd) {
      try {
        const status = result.hasError ? 'error' : 'completed';
        cardFinalized = await adapter.onStreamEnd(msg.address.chatId, status, result.responseText);
      } catch (err) {
        console.warn('[bridge-manager] Card finalize failed:', err instanceof Error ? err.message : err);
      }
    }

    // Send response text — render via channel-appropriate format.
    // Skip if streaming card was finalized (content already in card).
    if (result.responseText) {
      if (!cardFinalized) {
        await deliverResponse(adapter, msg.address, result.responseText, binding.codepilotSessionId, msg.messageId);
      }
    } else if (result.hasError) {
      const errorResponse: OutboundMessage = {
        address: msg.address,
        text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
        parseMode: 'HTML',
        replyToMessageId: msg.messageId,
      };
      await deliver(adapter, errorResponse);
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
        if (update !== null) {
          store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } finally {
    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    // If task was aborted and streaming card is still active, finalize as interrupted
    if (hasStreamingCards && adapter.onStreamEnd && taskAbort.signal.aborted) {
      try {
        await adapter.onStreamEnd(msg.address.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }

    state.activeTasks.delete(binding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address.chatId);
    // Commit the offset only after full processing (success or failure)
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: '命令已拒绝：检测到非法输入。',
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';
  let responseButtons: OutboundMessage['inlineButtons'];

  switch (command) {
    case '/start':
      response = [
        '<b>Codex TG 桥接</b>',
        '',
        '发送任意消息即可继续对话。',
        '',
        '<b>常用命令</b>',
        '/new [路径] - 新建会话',
        '/import &lt;codex_session_id&gt; - 导入 Codex CLI 会话',
        '/resume [会话ID|external] - 恢复会话（默认当前目录最近一条）',
        '/cwd [路径] - 目录面板或直接切换并新建会话',
        '/sessions [all|external] - 查看会话（默认当前目录）',
        '/mode [plan|code|ask] - 查看或切换模式',
        '/model [模型名称] - 查看或切换模型',
        '/permission [ask|full|status] - 权限模式',
        '/status - 查看当前状态',
        '/stop - 停止当前任务',
        '/help - 查看完整命令',
      ].join('\n');
      break;

    case '/new': {
      // Abort any running task on the current session before creating a new one
      const oldBinding = router.resolve(msg.address);
      const st = getState();
      const oldTask = st.activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        st.activeTasks.delete(oldBinding.codepilotSessionId);
      }

      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = '路径无效。必须是绝对路径，且不能包含路径穿越。';
          break;
        }
        workDir = validated;
      }
      const binding = router.createBinding(msg.address, workDir);
      response = [
        '已新建会话。',
        `会话: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `目录: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
      ].join('\n');
      break;
    }

    case '/import': {
      const currentBinding = router.resolve(msg.address);
      const rawCodexSessionId = args.trim();
      if (!rawCodexSessionId) {
        response = '用法: /import &lt;codex_session_id&gt;';
        break;
      }
      if (!validateSessionId(rawCodexSessionId)) {
        response = 'Codex 会话 ID 格式无效，应为 32-64 位 hex/UUID。';
        break;
      }

      const st = getState();
      const currentTask = st.activeTasks.get(currentBinding.codepilotSessionId);
      if (currentTask) {
        currentTask.abort();
        st.activeTasks.delete(currentBinding.codepilotSessionId);
      }

      const imported = importCodexSessionForAddress(
        msg.address,
        rawCodexSessionId,
        currentBinding,
      );
      if (!imported) {
        response = '导入失败，请稍后重试。';
        break;
      }

      const permissionProfile = getPermissionProfile(imported.binding.permissionProfile);
      response = [
        imported.reused ? '已绑定已导入会话。' : '已导入 Codex CLI 会话。',
        `会话: <code>${imported.binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `Codex: <code>${escapeHtml(rawCodexSessionId)}</code>`,
        `目录: <code>${escapeHtml(imported.binding.workingDirectory || '~')}</code>`,
        `模式: <b>${imported.binding.mode}</b>`,
        `权限: <b>${permissionProfile}</b>`,
      ].join('\n');
      break;
    }

    case '/bind': {
      if (!args) {
        response = '用法: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = '会话 ID 格式无效，应为 32-64 位 hex/UUID。';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `已绑定会话 <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = '未找到会话。';
      }
      break;
    }

    case '/resume': {
      const currentBinding = router.resolve(msg.address);
      const st = getState();
      const currentTask = st.activeTasks.get(currentBinding.codepilotSessionId);
      if (currentTask) {
        currentTask.abort();
        st.activeTasks.delete(currentBinding.codepilotSessionId);
      }

      const allSessions = store.listSessions();
      const currentCwd = currentBinding.workingDirectory || '';
      let targetSession: BridgeSession | null = null;

      const requestedSession = args.trim();
      if (!requestedSession) {
        targetSession = allSessions.find((session) => (
          session.id !== currentBinding.codepilotSessionId
          && normalizeWorkingDirectory(session.working_directory) === normalizeWorkingDirectory(currentCwd)
        )) || null;
        if (!targetSession) {
          const external = findLatestExternalCodexSessionByCwd(currentCwd);
          if (external) {
            const imported = importCodexSessionForAddress(
              msg.address,
              external.id,
              currentBinding,
            );
            if (!imported) {
              response = '恢复外部会话失败，请稍后重试。';
              break;
            }
            const permissionProfile = getPermissionProfile(imported.binding.permissionProfile);
            response = [
              '已恢复外部 Codex CLI 会话。',
              `会话: <code>${imported.binding.codepilotSessionId.slice(0, 8)}...</code>`,
              `Codex: <code>${escapeHtml(external.id)}</code>`,
              `目录: <code>${escapeHtml(imported.binding.workingDirectory || '~')}</code>`,
              `来源: <i>${escapeHtml(external.threadName || '未命名')}</i>`,
              `权限: <b>${permissionProfile}</b>`,
            ].join('\n');
            break;
          }
          response = '当前目录下没有可恢复的历史会话。\n可用 /sessions all 或 /sessions external 查看其他会话。';
          break;
        }
      } else {
        if (requestedSession === 'external') {
          const external = findLatestExternalCodexSessionByCwd(currentCwd);
          if (!external) {
            response = '当前目录下没有可恢复的外部 Codex CLI 会话。';
            break;
          }
          const imported = importCodexSessionForAddress(
            msg.address,
            external.id,
            currentBinding,
          );
          if (!imported) {
            response = '恢复外部会话失败，请稍后重试。';
            break;
          }
          const permissionProfile = getPermissionProfile(imported.binding.permissionProfile);
          response = [
            '已恢复外部 Codex CLI 会话。',
            `会话: <code>${imported.binding.codepilotSessionId.slice(0, 8)}...</code>`,
            `Codex: <code>${escapeHtml(external.id)}</code>`,
            `目录: <code>${escapeHtml(imported.binding.workingDirectory || '~')}</code>`,
            `来源: <i>${escapeHtml(external.threadName || '未命名')}</i>`,
            `权限: <b>${permissionProfile}</b>`,
          ].join('\n');
          break;
        }
        const resolved = resolveSessionSelection(allSessions, requestedSession);
        if (resolved.error) {
          response = resolved.error;
          break;
        }
        targetSession = resolved.session;
      }

      const rebound = targetSession
        ? router.bindToSession(msg.address, targetSession.id)
        : null;
      if (!rebound) {
        response = '未找到会话。';
        break;
      }

      const permissionProfile = getPermissionProfile(rebound.permissionProfile);
      response = [
        '已恢复会话。',
        `会话: <code>${rebound.codepilotSessionId.slice(0, 8)}...</code>`,
        `目录: <code>${escapeHtml(rebound.workingDirectory || '~')}</code>`,
        `权限: <b>${permissionProfile}</b>`,
      ].join('\n');
      break;
    }

    case '/cwd': {
      if (!args) {
        const binding = router.resolve(msg.address);
        const chooser = buildCwdChooserView(store, binding);
        response = chooser.text;
        responseButtons = chooser.inlineButtons;
        markPendingCwdInput(msg.address);
        break;
      }
      const result = switchWorkingDirectory(msg.address, args);
      response = result.text;
      if (result.ok) {
        clearPendingCwdInput(msg.address);
      }
      break;
    }

    case '/mode': {
      const binding = router.resolve(msg.address);
      const requestedMode = args.trim().toLowerCase();
      if (!requestedMode) {
        const panel = buildModePanel(binding.mode);
        response = panel.text;
        responseButtons = panel.inlineButtons;
        break;
      }
      if (!validateMode(requestedMode)) {
        response = '用法: /mode [plan|code|ask]';
        break;
      }
      router.updateBinding(binding.id, { mode: requestedMode });
      const panel = buildModePanel(requestedMode);
      response = panel.text;
      responseButtons = panel.inlineButtons;
      break;
    }

    case '/model': {
      const binding = router.resolve(msg.address);
      const requestedModel = normalizeModelSelection(args);
      if (requestedModel === null) {
        const panel = await loadModelPanel(binding.model);
        response = panel.text;
        responseButtons = panel.inlineButtons;
        break;
      }
      if (requestedModel !== '' && !validateModel(requestedModel)) {
        response = [
          '用法: /model <模型名称>',
          '例如: /model gpt-5.4',
          '恢复默认模型: /model default',
        ].join('\n');
        break;
      }
      applyModelSelection(binding, requestedModel);
      const panel = await loadModelPanel(requestedModel);
      response = panel.text;
      responseButtons = panel.inlineButtons;
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      const permissionProfile = getPermissionProfile(binding.permissionProfile);
      const allSessions = store.listSessions();
      const sameDirSessions = allSessions.filter((session) => (
        normalizeWorkingDirectory(session.working_directory) === normalizeWorkingDirectory(binding.workingDirectory)
      ));
      const recoverableCount = sameDirSessions.filter((session) => session.id !== binding.codepilotSessionId).length;
      const summary = summarizeSessionPreview(store, binding.codepilotSessionId);
      response = [
        '<b>当前状态</b>',
        '',
        `会话: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `目录: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `模式: <b>${binding.mode}</b>`,
        `权限: <b>${permissionProfile}</b>`,
        `模型: <code>${binding.model || 'default'}</code>`,
        `最近摘要: <i>${escapeHtml(summary)}</i>`,
        `当前目录可恢复会话: <b>${recoverableCount}</b>`,
      ].join('\n');
      responseButtons = [
        [
          { text: '查看当前目录会话', callbackData: 'ui:sessions:cwd' },
          { text: '模式设置', callbackData: 'ui:mode:menu' },
        ],
        [
          { text: '权限设置', callbackData: 'ui:permission:menu' },
          { text: '模型设置', callbackData: 'ui:model:menu' },
        ],
        [
          { text: '切换目录', callbackData: 'ui:cwd:menu' },
        ],
      ];
      break;
    }

    case '/sessions': {
      const currentBinding = router.resolve(msg.address);
      const requestedScope = args.trim().toLowerCase();
      if (requestedScope === 'external') {
        const externalView = buildExternalSessionsView(currentBinding.workingDirectory);
        response = externalView.text;
        break;
      }
      const showAll = requestedScope === 'all';
      const view = buildSessionsView(store, currentBinding, showAll);
      response = view.text;
      responseButtons = view.inlineButtons;
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        response = '正在停止当前任务...';
      } else {
        response = '当前没有运行中的任务。';
      }
      break;
    }

    case '/permission': {
      const binding = router.resolve(msg.address);
      const requestedProfile = args.toLowerCase();
      if (!requestedProfile) {
        const panel = buildPermissionPanel(getPermissionProfile(binding.permissionProfile));
        response = panel.text;
        responseButtons = panel.inlineButtons;
        break;
      }
      if (!validatePermissionProfile(requestedProfile)) {
        response = '用法: /permission ask|full|status';
        break;
      }
      if (requestedProfile === 'status') {
        const profile = getPermissionProfile(binding.permissionProfile);
        const panel = buildPermissionPanel(profile);
        response = panel.text;
        responseButtons = panel.inlineButtons;
        break;
      }

      router.updateBinding(binding.id, { permissionProfile: requestedProfile });
      const panel = buildPermissionPanel(getPermissionProfile(requestedProfile));
      response = panel.text;
      responseButtons = panel.inlineButtons;
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = '用法: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `权限操作 ${permAction}：已记录。`;
      } else {
        response = '未找到权限请求，或该请求已处理。';
      }
      break;
    }

    case '/help':
      response = [
        '<b>命令帮助</b>',
        '',
        '/new [路径] - 新建会话',
        '/import &lt;codex_session_id&gt; - 导入 Codex CLI 会话',
        '/resume [会话ID|external] - 恢复会话（默认当前目录最近一条）',
        '/cwd [路径] - 打开目录选择，或直接切换并新建会话',
        '/sessions [all|external] - 查看会话（默认当前目录）',
        '/mode [plan|code|ask] - 查看或切换模式',
        '/model [模型名称] - 查看或切换模型',
        '/permission [ask|full|status] - 查看或切换权限模式',
        '/status - 查看当前状态',
        '/stop - 停止当前任务',
        '/perm allow|allow_session|deny &lt;id&gt; - 处理权限请求',
        '/bind &lt;session_id&gt; - 高级：手动绑定会话',
        '1/2/3 - 快捷处理权限（飞书/QQ/微信，且仅 1 条待处理）',
        '/help - 查看帮助',
      ].join('\n');
      break;

    default:
      response = `未知命令: ${escapeHtml(command)}\n可输入 /help 查看可用命令。`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      inlineButtons: responseButtons,
      replyToMessageId: msg.messageId,
    });
  }
}

async function handleUiCallback(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  callbackData: string,
): Promise<boolean> {
  const { store } = getBridgeContext();
  const replyToMessageId = msg.callbackMessageId || msg.messageId;

  if (callbackData === 'ui:sessions:cwd' || callbackData === 'ui:sessions:all') {
    const currentBinding = router.resolve(msg.address);
    const showAll = callbackData.endsWith(':all');
    const view = buildSessionsView(store, currentBinding, showAll);
    await deliver(adapter, {
      address: msg.address,
      text: view.text,
      parseMode: 'HTML',
      inlineButtons: view.inlineButtons,
      replyToMessageId,
    });
    return true;
  }

  if (callbackData === 'ui:cwd:menu') {
    const binding = router.resolve(msg.address);
    const chooser = buildCwdChooserView(store, binding);
    markPendingCwdInput(msg.address);
    await deliver(adapter, {
      address: msg.address,
      text: chooser.text,
      parseMode: 'HTML',
      inlineButtons: chooser.inlineButtons,
      replyToMessageId,
    });
    return true;
  }

  if (callbackData === 'ui:cwd:cancel') {
    clearPendingCwdInput(msg.address);
    await deliver(adapter, {
      address: msg.address,
      text: '已取消目录输入。',
      parseMode: 'plain',
      replyToMessageId,
    });
    return true;
  }

  if (callbackData.startsWith('ui:cwd:session:')) {
    const sessionId = callbackData.slice('ui:cwd:session:'.length).trim();
    if (!sessionId) return false;
    const session = store.getSession(sessionId);
    if (!session) {
      await deliver(adapter, {
        address: msg.address,
        text: '目录来源会话不存在，请重新打开 /cwd。',
        parseMode: 'plain',
        replyToMessageId,
      });
      return true;
    }
    const result = switchWorkingDirectory(msg.address, session.working_directory);
    await deliver(adapter, {
      address: msg.address,
      text: result.text,
      parseMode: result.ok ? 'HTML' : 'plain',
      replyToMessageId,
    });
    if (result.ok) {
      clearPendingCwdInput(msg.address);
    }
    return true;
  }

  if (callbackData.startsWith('ui:resume:')) {
    const sessionId = callbackData.slice('ui:resume:'.length).trim();
    if (!sessionId) return false;

    const currentBinding = router.resolve(msg.address);
    const st = getState();
    const currentTask = st.activeTasks.get(currentBinding.codepilotSessionId);
    if (currentTask) {
      currentTask.abort();
      st.activeTasks.delete(currentBinding.codepilotSessionId);
    }

    const rebound = router.bindToSession(msg.address, sessionId);
    if (!rebound) {
      await deliver(adapter, {
        address: msg.address,
        text: '未找到要恢复的会话。',
        parseMode: 'plain',
        replyToMessageId,
      });
      return true;
    }

    const permissionProfile = getPermissionProfile(rebound.permissionProfile);
    await deliver(adapter, {
      address: msg.address,
      text: [
        '已恢复会话。',
        `会话: <code>${rebound.codepilotSessionId.slice(0, 8)}...</code>`,
        `目录: <code>${escapeHtml(rebound.workingDirectory || '~')}</code>`,
        `权限: <b>${permissionProfile}</b>`,
      ].join('\n'),
      parseMode: 'HTML',
      replyToMessageId,
    });
    return true;
  }

  if (callbackData === 'ui:permission:menu' || callbackData === 'ui:permission:status') {
    const binding = router.resolve(msg.address);
    const profile = getPermissionProfile(binding.permissionProfile);
    const panel = buildPermissionPanel(profile);
    await deliver(adapter, {
      address: msg.address,
      text: panel.text,
      parseMode: 'HTML',
      inlineButtons: panel.inlineButtons,
      replyToMessageId,
    });
    return true;
  }

  if (callbackData === 'ui:permission:ask' || callbackData === 'ui:permission:full') {
    const binding = router.resolve(msg.address);
    const nextProfile: PermissionProfile = callbackData.endsWith(':full') ? 'full' : 'ask';
    router.updateBinding(binding.id, { permissionProfile: nextProfile });
    const panel = buildPermissionPanel(nextProfile);
    await deliver(adapter, {
      address: msg.address,
      text: panel.text,
      parseMode: 'HTML',
      inlineButtons: panel.inlineButtons,
      replyToMessageId,
    });
    return true;
  }

  if (callbackData === 'ui:mode:menu' || callbackData === 'ui:mode:status') {
    const binding = router.resolve(msg.address);
    const panel = buildModePanel(binding.mode);
    await deliver(adapter, {
      address: msg.address,
      text: panel.text,
      parseMode: 'HTML',
      inlineButtons: panel.inlineButtons,
      replyToMessageId,
    });
    return true;
  }

  if (
    callbackData === 'ui:mode:plan'
    || callbackData === 'ui:mode:code'
    || callbackData === 'ui:mode:ask'
  ) {
    const binding = router.resolve(msg.address);
    const nextMode = callbackData.slice('ui:mode:'.length);
    if (!validateMode(nextMode)) return false;
    router.updateBinding(binding.id, { mode: nextMode });
    const panel = buildModePanel(nextMode);
    await deliver(adapter, {
      address: msg.address,
      text: panel.text,
      parseMode: 'HTML',
      inlineButtons: panel.inlineButtons,
      replyToMessageId,
    });
    return true;
  }

  // ui:model:* — model selection panel
  if (callbackData === 'ui:model:menu' || callbackData === 'ui:model:status') {
    const binding = router.resolve(msg.address);
    const panel = await loadModelPanel(binding.model);
    await deliver(adapter, {
      address: msg.address,
      text: panel.text,
      parseMode: 'HTML',
      inlineButtons: panel.inlineButtons,
      replyToMessageId,
    });
    return true;
  }

  if (callbackData === MODEL_DEFAULT_CALLBACK) {
    const binding = router.resolve(msg.address);
    applyModelSelection(binding, '');
    const panel = await loadModelPanel('');
    await deliver(adapter, {
      address: msg.address,
      text: panel.text,
      parseMode: 'HTML',
      inlineButtons: panel.inlineButtons,
      replyToMessageId,
    });
    return true;
  }

  if (callbackData.startsWith('ui:model:')) {
    const modelId = callbackData.slice('ui:model:'.length);
    if (!modelId || !validateModel(modelId)) {
      // Refresh panel on invalid model
      const binding = router.resolve(msg.address);
      const panel = await loadModelPanel(binding.model);
      await deliver(adapter, {
        address: msg.address,
        text: panel.text,
        parseMode: 'HTML',
        inlineButtons: panel.inlineButtons,
        replyToMessageId,
      });
      return true;
    }
    const binding = router.resolve(msg.address);
    applyModelSelection(binding, modelId);
    const panel = await loadModelPanel(modelId);
    await deliver(adapter, {
      address: msg.address,
      text: panel.text,
      parseMode: 'HTML',
      inlineButtons: panel.inlineButtons,
      replyToMessageId,
    });
    return true;
  }

  return false;
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) {
    return sdkSessionId;
  }
  if (hasError) {
    return '';
  }
  return null;
}

function getPermissionProfile(permissionProfile?: PermissionProfile): PermissionProfile {
  return permissionProfile === 'full' ? 'full' : 'ask';
}

function normalizeWorkingDirectory(workingDirectory?: string): string {
  return (workingDirectory || '').trim();
}

function buildPermissionPanel(profile: PermissionProfile): {
  text: string;
  inlineButtons: NonNullable<OutboundMessage['inlineButtons']>;
} {
  const text = [
    '<b>权限模式</b>',
    '',
    `当前: <b>${profile}</b>`,
    'ask: 需要审批时会询问你',
    'full: 会话内直接执行（谨慎使用）',
  ].join('\n');
  const inlineButtons: NonNullable<OutboundMessage['inlineButtons']> = [
    [
      {
        text: profile === 'ask' ? '✅ ask' : '切到 ask',
        callbackData: 'ui:permission:ask',
      },
      {
        text: profile === 'full' ? '✅ full' : '切到 full',
        callbackData: 'ui:permission:full',
      },
    ],
    [
      { text: '刷新状态', callbackData: 'ui:permission:status' },
    ],
  ];
  return { text, inlineButtons };
}

function buildModePanel(mode: 'plan' | 'code' | 'ask'): {
  text: string;
  inlineButtons: NonNullable<OutboundMessage['inlineButtons']>;
} {
  const text = [
    '<b>会话模式</b>',
    '',
    `当前: <b>${mode}</b>`,
    'code: 默认编码执行',
    'plan: 先给方案再改动',
    'ask: 更保守，关键操作前倾向询问',
  ].join('\n');
  const inlineButtons: NonNullable<OutboundMessage['inlineButtons']> = [
    [
      {
        text: mode === 'plan' ? '✅ plan' : '切到 plan',
        callbackData: 'ui:mode:plan',
      },
      {
        text: mode === 'code' ? '✅ code' : '切到 code',
        callbackData: 'ui:mode:code',
      },
    ],
    [
      {
        text: mode === 'ask' ? '✅ ask' : '切到 ask',
        callbackData: 'ui:mode:ask',
      },
      { text: '刷新状态', callbackData: 'ui:mode:status' },
    ],
  ];
  return { text, inlineButtons };
}

function normalizeModelSelection(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.toLowerCase() === 'default') {
    return '';
  }
  return trimmed;
}

function applyModelSelection(
  binding: { id: string; codepilotSessionId: string; model: string },
  nextModel: string,
): void {
  const { store } = getBridgeContext();
  if (binding.model === nextModel) {
    return;
  }
  router.updateBinding(binding.id, {
    model: nextModel,
    sdkSessionId: '',
  });
  store.updateSessionModel(binding.codepilotSessionId, nextModel);
  store.updateSdkSessionId(binding.codepilotSessionId, '');
}

async function loadModelPanel(currentModel?: string): Promise<{
  text: string;
  inlineButtons: NonNullable<OutboundMessage['inlineButtons']>;
}> {
  const catalog = await loadModelCatalog();
  return buildModelPanel(currentModel, catalog);
}

async function loadModelCatalog(): Promise<ModelCatalog> {
  if (modelCatalogCache && modelCatalogCache.expiresAt > Date.now()) {
    return modelCatalogCache.catalog;
  }

  if (!modelCatalogInflight) {
    modelCatalogInflight = fetchModelCatalog()
      .then((catalog) => {
        modelCatalogCache = {
          catalog,
          expiresAt: Date.now() + MODEL_CATALOG_TTL_MS,
        };
        return catalog;
      })
      .finally(() => {
        modelCatalogInflight = null;
      });
  }

  return await modelCatalogInflight;
}

async function fetchModelCatalog(): Promise<ModelCatalog> {
  try {
    const models = await queryCodexModelCatalog();
    if (models.length > 0) {
      return { models, source: 'dynamic' };
    }
  } catch (error) {
    console.warn('[bridge-manager] Failed to query Codex model catalog:', error);
  }

  return {
    models: MODEL_PANEL_PRESETS.map((model) => ({ ...model })),
    source: 'fallback',
  };
}

async function queryCodexModelCatalog(): Promise<ModelOption[]> {
  return await new Promise<ModelOption[]>((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const stdout = readline.createInterface({ input: child.stdout });
    let resolved = false;
    let initialized = false;
    let stderrBuffer = '';
    const timeout = setTimeout(() => {
      finishReject(new Error('Timed out while loading Codex models'));
    }, MODEL_LIST_TIMEOUT_MS);

    function cleanup(): void {
      clearTimeout(timeout);
      stdout.close();
      child.removeAllListeners();
    }

    function finishResolve(models: ModelOption[]): void {
      if (resolved) return;
      resolved = true;
      cleanup();
      child.kill('SIGTERM');
      resolve(models);
    }

    function finishReject(error: Error): void {
      if (resolved) return;
      resolved = true;
      cleanup();
      child.kill('SIGTERM');
      reject(error);
    }

    stdout.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return;
      }

      if (message.id === 1) {
        initialized = true;
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'model/list',
          params: { includeHidden: false },
        })}\n`);
        return;
      }

      if (message.id === 2) {
        if (message.error && typeof message.error === 'object') {
          const err = message.error as { message?: unknown };
          finishReject(new Error(typeof err.message === 'string' ? err.message : 'model/list failed'));
          return;
        }

        const result = message.result as { models?: unknown; data?: unknown } | undefined;
        const models = extractModelCatalogEntries(result);
        finishResolve(models);
      }
    });

    child.stderr.on('data', (chunk: string | Buffer) => {
      stderrBuffer += String(chunk).trim();
    });

    child.once('error', (error) => {
      finishReject(error);
    });

    child.once('close', () => {
      if (!resolved) {
        const suffix = stderrBuffer ? `: ${stderrBuffer}` : '';
        const phase = initialized ? 'while waiting for model/list' : 'before initialization';
        finishReject(new Error(`codex app-server exited ${phase}${suffix}`));
      }
    });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'codex_to_im_bridge',
          title: 'codex-to-im',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ['thread/started', 'item/agentMessage/delta'],
        },
      },
    })}\n`);
  });
}

function extractModelCatalogEntries(
  result: { models?: unknown; data?: unknown } | undefined,
): ModelOption[] {
  if (!result || typeof result !== 'object') {
    return [];
  }

  if (Array.isArray(result.data)) {
    return normalizeModelCatalog(result.data);
  }

  if (Array.isArray(result.models)) {
    return normalizeModelCatalog(result.models);
  }

  return [];
}

function normalizeModelCatalog(rawModels: unknown): ModelOption[] {
  if (!Array.isArray(rawModels)) {
    return [];
  }

  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const entry of rawModels) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string'
      ? record.id.trim()
      : typeof record.model === 'string'
        ? record.model.trim()
        : '';
    if (!id || !validateModel(id) || seen.has(id)) continue;
    seen.add(id);
    const label = typeof record.displayName === 'string' && record.displayName.trim()
      ? record.displayName.trim()
      : id;
    models.push({ id, label });
  }

  return models;
}

function buildModelPanel(currentModel?: string, catalog?: ModelCatalog): {
  text: string;
  inlineButtons: NonNullable<OutboundMessage['inlineButtons']>;
} {
  const activeModel = currentModel || '';
  const resolvedCatalog = catalog ?? {
    models: MODEL_PANEL_PRESETS.map((model) => ({ ...model })),
    source: 'fallback' as const,
  };
  const text = [
    '<b>模型选择</b>',
    '',
    `当前: <code>${activeModel || 'default'}</code>`,
    '',
    resolvedCatalog.source === 'dynamic'
      ? '当前列表已按本机 Codex CLI 可用模型动态同步。'
      : '当前显示常用模型预设；未能动态读取 Codex CLI 模型列表。',
    '点击按钮切换，或发送 /model &lt;模型名称&gt;。',
    '发送 /model default 可恢复默认模型。',
    '切换后从下一条消息开始生效。',
  ];

  const inlineButtons: NonNullable<OutboundMessage['inlineButtons']> = [];
  inlineButtons.push([
    {
      text: activeModel ? '切到 default' : '✅ default',
      callbackData: MODEL_DEFAULT_CALLBACK,
    },
    { text: '刷新状态', callbackData: 'ui:model:status' },
  ]);

  for (let i = 0; i < resolvedCatalog.models.length; i += 2) {
    const row: Array<{ text: string; callbackData: string }> = [];
    const m1 = resolvedCatalog.models[i];
    row.push({
      text: (activeModel === m1.id ? '✅ ' : '') + m1.label,
      callbackData: `ui:model:${m1.id}`,
    });
    if (i + 1 < resolvedCatalog.models.length) {
      const m2 = resolvedCatalog.models[i + 1];
      row.push({
        text: (activeModel === m2.id ? '✅ ' : '') + m2.label,
        callbackData: `ui:model:${m2.id}`,
      });
    }
    inlineButtons.push(row);
  }

  return { text: text.join('\n'), inlineButtons };
}

function buildSessionsView(
  store: {
    listSessions(limit?: number): BridgeSession[];
    getMessages(sessionId: string, opts?: { limit?: number }): { messages: Array<{ role: string; content: string }> };
  },
  currentBinding: { codepilotSessionId: string; workingDirectory: string },
  showAll: boolean,
): {
  text: string;
  inlineButtons?: OutboundMessage['inlineButtons'];
} {
  const allSessions = store.listSessions();
  const currentCwd = normalizeWorkingDirectory(currentBinding.workingDirectory);
  const sessions = (showAll
    ? allSessions
    : allSessions.filter((session) => normalizeWorkingDirectory(session.working_directory) === currentCwd)
  ).slice(0, 10);

  if (sessions.length === 0) {
    return {
      text: showAll
        ? '没有可显示的会话。'
        : '当前目录下没有会话。\n可点击下方按钮查看全部目录会话。',
      inlineButtons: showAll
        ? [[{ text: '只看当前目录', callbackData: 'ui:sessions:cwd' }]]
        : [[{ text: '显示全部目录', callbackData: 'ui:sessions:all' }]],
    };
  }

  const lines = [showAll ? '<b>全部目录会话</b>' : '<b>当前目录会话</b>', ''];
  const buttons: NonNullable<OutboundMessage['inlineButtons']> = [];

  for (const session of sessions) {
    const current = session.id === currentBinding.codepilotSessionId ? ' [当前]' : '';
    lines.push(`<code>${session.id.slice(0, 8)}...</code>${current} ${escapeHtml(session.working_directory || '~')}`);
    lines.push(`<i>${escapeHtml(summarizeSessionPreview(store, session.id))}</i>`);
    if (!current) {
      buttons.push([{ text: `恢复 ${session.id.slice(0, 8)}...`, callbackData: `ui:resume:${session.id}` }]);
    }
  }

  buttons.push([
    showAll
      ? { text: '只看当前目录', callbackData: 'ui:sessions:cwd' }
      : { text: '显示全部目录', callbackData: 'ui:sessions:all' },
  ]);

  return { text: lines.join('\n'), inlineButtons: buttons };
}

function buildCwdChooserView(
  store: { listSessions(limit?: number): BridgeSession[] },
  currentBinding: { workingDirectory: string },
): {
  text: string;
  inlineButtons: NonNullable<OutboundMessage['inlineButtons']>;
} {
  const currentCwd = normalizeWorkingDirectory(currentBinding.workingDirectory || '~');
  const recent = listRecentDirectories(store, currentCwd, 8);
  const lines = [
    '<b>切换工作目录</b>',
    '',
    `当前目录: <code>${escapeHtml(currentCwd || '~')}</code>`,
    '点击最近目录，或直接发送绝对路径（例如 /home/tom/项目）。',
    '也可继续使用 /cwd /路径。',
  ];

  if (recent.length > 0) {
    lines.push('');
    lines.push('<b>最近目录</b>');
    for (const item of recent) {
      const mark = item.isCurrent ? ' [当前]' : '';
      lines.push(`• <code>${escapeHtml(item.directory)}</code>${mark}`);
    }
  } else {
    lines.push('');
    lines.push('暂无最近目录记录。');
  }

  const inlineButtons: NonNullable<OutboundMessage['inlineButtons']> = [];
  for (const item of recent) {
    const label = `${item.isCurrent ? '当前' : '切换'}: ${truncatePreview(item.directory, 22)}`;
    inlineButtons.push([
      { text: label, callbackData: `ui:cwd:session:${item.sessionId}` },
    ]);
  }
  inlineButtons.push([
    { text: '刷新目录列表', callbackData: 'ui:cwd:menu' },
    { text: '取消输入', callbackData: 'ui:cwd:cancel' },
  ]);

  return { text: lines.join('\n'), inlineButtons };
}

function listRecentDirectories(
  store: { listSessions(limit?: number): BridgeSession[] },
  currentCwd: string,
  maxItems: number,
): Array<{ sessionId: string; directory: string; isCurrent: boolean }> {
  const items: Array<{ sessionId: string; directory: string; isCurrent: boolean }> = [];
  const seen = new Set<string>();
  for (const session of store.listSessions(50)) {
    const directory = normalizeWorkingDirectory(session.working_directory);
    if (!directory || seen.has(directory)) continue;
    seen.add(directory);
    items.push({
      sessionId: session.id,
      directory,
      isCurrent: directory === currentCwd,
    });
    if (items.length >= maxItems) break;
  }
  return items;
}

function switchWorkingDirectory(
  address: InboundMessage['address'],
  requestedPath: string,
): { ok: boolean; text: string } {
  const validatedPath = validateWorkingDirectory(requestedPath);
  if (!validatedPath) {
    return {
      ok: false,
      text: '路径无效。必须是绝对路径，且不能包含路径穿越或特殊字符。',
    };
  }

  const oldBinding = router.resolve(address);
  const st = getState();
  const oldTask = st.activeTasks.get(oldBinding.codepilotSessionId);
  if (oldTask) {
    oldTask.abort();
    st.activeTasks.delete(oldBinding.codepilotSessionId);
  }

  const binding = router.createBinding(address, validatedPath);
  router.updateBinding(binding.id, {
    mode: oldBinding.mode,
    model: oldBinding.model,
  });

  const permissionProfile = getPermissionProfile(binding.permissionProfile);
  return {
    ok: true,
    text: [
      '已切换工作目录并新建会话。',
      `会话: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
      `目录: <code>${escapeHtml(validatedPath)}</code>`,
      `权限: <b>${permissionProfile}</b>`,
    ].join('\n'),
  };
}

function getAddressKey(address: InboundMessage['address']): string {
  return `${address.channelType}:${address.chatId}`;
}

function markPendingCwdInput(address: InboundMessage['address']): void {
  getState().pendingCwdInput.set(getAddressKey(address), Date.now());
}

function clearPendingCwdInput(address: InboundMessage['address']): void {
  getState().pendingCwdInput.delete(getAddressKey(address));
}

function isAwaitingCwdInput(address: InboundMessage['address']): boolean {
  const key = getAddressKey(address);
  const timestamp = getState().pendingCwdInput.get(key);
  if (!timestamp) return false;
  if (Date.now() - timestamp > CWD_INPUT_TTL_MS) {
    getState().pendingCwdInput.delete(key);
    return false;
  }
  return true;
}

function isKnownSlashCommand(firstToken: string): boolean {
  return KNOWN_SLASH_COMMANDS.has(firstToken);
}

function resolveSessionSelection(
  sessions: BridgeSession[],
  rawSelection: string,
): { session: BridgeSession | null; error?: string } {
  const selection = rawSelection.trim();
  if (!selection) {
    return { session: null, error: '用法: /resume [session_id]' };
  }

  if (validateSessionId(selection)) {
    const exact = sessions.find((session) => session.id === selection) || null;
    return exact
      ? { session: exact }
      : { session: null, error: '未找到会话。' };
  }

  const prefix = selection.toLowerCase();
  const matches = sessions.filter((session) => session.id.toLowerCase().startsWith(prefix));
  if (matches.length === 1) {
    return { session: matches[0] };
  }
  if (matches.length > 1) {
    return { session: null, error: '匹配到多个会话，请提供更长的 ID 前缀。' };
  }
  return { session: null, error: '未找到会话。' };
}

function summarizeSessionPreview(
  store: { getMessages(sessionId: string, opts?: { limit?: number }): { messages: Array<{ role: string; content: string }> } },
  sessionId: string,
): string {
  const { messages } = store.getMessages(sessionId, { limit: 12 });
  const preferred = [...messages].reverse().find((message) => (
    message.role === 'user'
    && normalizePreviewText(message.content).length > 0
  ));
  const fallback = [...messages].reverse().find((message) => normalizePreviewText(message.content).length > 0);
  const text = normalizePreviewText(preferred?.content || fallback?.content || '');
  if (!text) {
    return '暂无消息';
  }
  return truncatePreview(text, 72);
}

function normalizePreviewText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim();
}

function truncatePreview(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, Math.max(0, maxLength - 3)).trimEnd() + '...';
}

function buildExternalSessionsView(currentWorkingDirectory: string): { text: string } {
  const currentDir = normalizeWorkingDirectory(currentWorkingDirectory);
  const externalSessions = loadExternalCodexSessions().filter((session) => (
    normalizeWorkingDirectory(session.cwd) === currentDir
  ));

  if (externalSessions.length === 0) {
    return {
      text: [
        '<b>外部 Codex CLI 会话</b>',
        '',
        `目录: <code>${escapeHtml(currentDir || '~')}</code>`,
        '当前目录没有发现外部会话。',
        '可用 /import &lt;codex_session_id&gt; 手动导入。',
      ].join('\n'),
    };
  }

  const lines = [
    '<b>外部 Codex CLI 会话</b>',
    '',
    `目录: <code>${escapeHtml(currentDir || '~')}</code>`,
    '',
  ];
  for (let i = 0; i < Math.min(10, externalSessions.length); i += 1) {
    const session = externalSessions[i];
    lines.push(`${i + 1}. <code>${session.id.slice(0, 8)}...</code> ${escapeHtml(session.threadName || '未命名')} (${formatRelativeTimeLabel(session.updatedAt)})`);
  }
  lines.push('');
  lines.push('使用 /resume external 恢复最新一条，或 /import &lt;id&gt; 导入指定会话。');

  return { text: lines.join('\n') };
}

function findLatestExternalCodexSessionByCwd(currentWorkingDirectory: string): ExternalCodexSessionSummary | null {
  const currentDir = normalizeWorkingDirectory(currentWorkingDirectory);
  if (!currentDir) return null;
  return loadExternalCodexSessions().find((session) => (
    normalizeWorkingDirectory(session.cwd) === currentDir
  )) || null;
}

function findExternalCodexSessionById(codexSessionId: string): ExternalCodexSessionSummary | null {
  const normalizedId = codexSessionId.trim();
  if (!normalizedId) return null;
  return loadExternalCodexSessions().find((session) => session.id === normalizedId) || null;
}

function loadExternalCodexSessions(): ExternalCodexSessionSummary[] {
  if (externalCodexSessionsCache && externalCodexSessionsCache.expiresAt > Date.now()) {
    return externalCodexSessionsCache.sessions;
  }
  const sessions = scanExternalCodexSessions();
  externalCodexSessionsCache = {
    sessions,
    expiresAt: Date.now() + EXTERNAL_CODEX_SCAN_TTL_MS,
  };
  return sessions;
}

function scanExternalCodexSessions(): ExternalCodexSessionSummary[] {
  const codexHome = resolveCodexHome();
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  const sessionsRoot = path.join(codexHome, 'sessions');
  if (!fs.existsSync(indexPath) || !fs.existsSync(sessionsRoot)) {
    return [];
  }

  const indexEntries = readExternalCodexIndex(indexPath);
  if (indexEntries.length === 0) {
    return [];
  }
  const fileMap = buildExternalCodexSessionFileMap(sessionsRoot);
  const sessions: ExternalCodexSessionSummary[] = [];
  for (const entry of indexEntries) {
    const filePath = fileMap.get(entry.id);
    if (!filePath) continue;
    const cwd = readExternalCodexSessionCwd(filePath);
    if (!cwd) continue;
    sessions.push({
      id: entry.id,
      cwd,
      updatedAt: entry.updatedAt,
      threadName: entry.threadName,
    });
  }

  sessions.sort((a, b) => toEpochMillis(b.updatedAt) - toEpochMillis(a.updatedAt));
  return sessions;
}

function readExternalCodexIndex(indexPath: string): Array<{ id: string; updatedAt: string; threadName: string }> {
  let raw = '';
  try {
    raw = fs.readFileSync(indexPath, 'utf-8');
  } catch {
    return [];
  }

  const byId = new Map<string, { id: string; updatedAt: string; threadName: string }>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || !validateSessionId(id)) continue;
    const updatedAt = typeof record.updated_at === 'string' ? record.updated_at : '';
    const threadName = typeof record.thread_name === 'string' ? record.thread_name : '';

    const existing = byId.get(id);
    if (!existing || toEpochMillis(updatedAt) >= toEpochMillis(existing.updatedAt)) {
      byId.set(id, { id, updatedAt, threadName });
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => toEpochMillis(b.updatedAt) - toEpochMillis(a.updatedAt))
    .slice(0, EXTERNAL_CODEX_INDEX_MAX);
}

function buildExternalCodexSessionFileMap(sessionsRoot: string): Map<string, string> {
  const fileMap = new Map<string, string>();
  const stack = [sessionsRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const match = entry.name.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
      if (!match) continue;
      const id = match[1];
      if (!fileMap.has(id)) {
        fileMap.set(id, fullPath);
      }
    }
  }
  return fileMap;
}

function readExternalCodexSessionCwd(sessionPath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(sessionPath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const header = buffer.toString('utf-8', 0, bytesRead);
    for (const line of header.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (record.type !== 'session_meta') continue;
      const payload = (record.payload && typeof record.payload === 'object')
        ? record.payload as Record<string, unknown>
        : null;
      const cwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : '';
      return cwd || null;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function findExternalCodexSessionCwdById(codexSessionId: string): string | null {
  const normalizedId = codexSessionId.trim();
  if (!normalizedId) return null;

  const fromCatalog = findExternalCodexSessionById(normalizedId);
  if (fromCatalog?.cwd) {
    return fromCatalog.cwd;
  }

  const codexHome = resolveCodexHome();
  const sessionsRoot = path.join(codexHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) {
    return null;
  }

  const sessionFiles = buildExternalCodexSessionFileMap(sessionsRoot);
  const sessionPath = sessionFiles.get(normalizedId);
  if (!sessionPath) {
    return null;
  }
  return readExternalCodexSessionCwd(sessionPath);
}

function resolveCodexHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv) return fromEnv;
  const home = process.env.HOME?.trim() || '';
  return home ? path.join(home, '.codex') : '.codex';
}

function toEpochMillis(raw: string): number {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatRelativeTimeLabel(updatedAt: string): string {
  if (!updatedAt) return '时间未知';
  const ts = toEpochMillis(updatedAt);
  if (!ts) return '时间未知';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function importCodexSessionForAddress(
  address: InboundMessage['address'],
  codexSessionId: string,
  currentBinding: ChannelBinding,
): { binding: ChannelBinding; reused: boolean } | null {
  const { store } = getBridgeContext();
  const normalizedCodexSessionId = codexSessionId.trim();
  const importedCwd = findExternalCodexSessionCwdById(normalizedCodexSessionId);
  const targetWorkingDirectory = normalizeWorkingDirectory(importedCwd || currentBinding.workingDirectory || '');
  const existingImported = store.listSessions().find((session) => (
    (session.sdk_session_id || '').trim() === normalizedCodexSessionId
  )) || null;

  if (existingImported) {
    if (
      targetWorkingDirectory
      && normalizeWorkingDirectory(existingImported.working_directory) !== targetWorkingDirectory
    ) {
      store.updateSessionWorkingDirectory(existingImported.id, targetWorkingDirectory);
    }
    const rebound = router.bindToSession(address, existingImported.id);
    if (!rebound) return null;
    router.updateBinding(rebound.id, {
      mode: currentBinding.mode,
      permissionProfile: getPermissionProfile(currentBinding.permissionProfile),
    });
    return { binding: router.resolve(address), reused: true };
  }

  const created = store.createSession(
    `Bridge Import: ${address.displayName || address.chatId}`,
    currentBinding.model || '',
    undefined,
    targetWorkingDirectory,
    currentBinding.mode,
  );
  store.updateSdkSessionId(created.id, normalizedCodexSessionId);

  const rebound = router.bindToSession(address, created.id);
  if (!rebound) return null;
  router.updateBinding(rebound.id, {
    mode: currentBinding.mode,
    permissionProfile: getPermissionProfile(currentBinding.permissionProfile),
  });
  return { binding: router.resolve(address), reused: false };
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = {
  handleMessage,
  extractModelCatalogEntries,
  resetExternalCodexSessionCache() {
    externalCodexSessionsCache = null;
  },
};
