import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeStore } from '../../lib/bridge/host';
import type { ChannelBinding, OutboundMessage, SendResult } from '../../lib/bridge/types';

function createMockStore(): BridgeStore & {
  bindings: Map<string, ChannelBinding>;
  sessions: Map<string, { id: string; working_directory: string; model: string }>;
} {
  const bindings = new Map<string, ChannelBinding>();
  const sessions = new Map<string, { id: string; working_directory: string; model: string }>();
  let nextId = 1;

  return {
    bindings,
    sessions,
    getSetting(key: string) {
      if (key === 'bridge_default_work_dir') return '/tmp/test';
      if (key === 'bridge_default_model') return 'gpt-5-codex';
      if (key === 'bridge_default_provider_id') return '';
      return null;
    },
    getChannelBinding(channelType: string, chatId: string) {
      return bindings.get(`${channelType}:${chatId}`) ?? null;
    },
    upsertChannelBinding(data) {
      const key = `${data.channelType}:${data.chatId}`;
      const existing = bindings.get(key);
      const binding: ChannelBinding = {
        id: existing?.id ?? `binding-${nextId++}`,
        channelType: data.channelType,
        chatId: data.chatId,
        codepilotSessionId: data.codepilotSessionId,
        sdkSessionId: data.sdkSessionId ?? existing?.sdkSessionId ?? '',
        workingDirectory: data.workingDirectory,
        model: data.model,
        mode: (data.mode as ChannelBinding['mode']) ?? existing?.mode ?? 'code',
        permissionProfile: data.permissionProfile ?? existing?.permissionProfile ?? 'ask',
        active: existing?.active ?? true,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      bindings.set(key, binding);
      return binding;
    },
    updateChannelBinding(id: string, updates: Partial<ChannelBinding>) {
      for (const [key, binding] of bindings) {
        if (binding.id === id) {
          bindings.set(key, { ...binding, ...updates });
          return;
        }
      }
    },
    listChannelBindings(channelType?: string) {
      const all = Array.from(bindings.values());
      return channelType ? all.filter((binding) => binding.channelType === channelType) : all;
    },
    getSession(id: string) {
      return sessions.get(id) ?? null;
    },
    listSessions(limit?: number) {
      const all = Array.from(sessions.values()).reverse();
      return limit ? all.slice(0, limit) : all;
    },
    createSession(_name: string, model: string, _systemPrompt?: string, cwd?: string) {
      const session = { id: `session-${nextId++}`, working_directory: cwd || '', model };
      sessions.set(session.id, session);
      return session;
    },
    updateSessionProviderId() {},
    updateSessionWorkingDirectory(sessionId: string, workingDirectory: string) {
      const session = sessions.get(sessionId);
      if (session) {
        session.working_directory = workingDirectory;
      }
      for (const [key, binding] of bindings) {
        if (binding.codepilotSessionId === sessionId) {
          bindings.set(key, { ...binding, workingDirectory });
        }
      }
    },
    addMessage() {},
    getMessages() { return { messages: [] }; },
    acquireSessionLock() { return true; },
    renewSessionLock() {},
    releaseSessionLock() {},
    setSessionRuntimeStatus() {},
    updateSdkSessionId() {},
    updateSessionModel() {},
    syncSdkTasks() {},
    getProvider() { return undefined; },
    getDefaultProviderId() { return null; },
    insertAuditLog() {},
    checkDedup() { return false; },
    insertDedup() {},
    cleanupExpiredDedup() {},
    insertOutboundRef() {},
    insertPermissionLink() {},
    getPermissionLink() { return null; },
    markPermissionLinkResolved() { return false; },
    listPendingPermissionLinksByChat() { return []; },
    getChannelOffset() { return '0'; },
    setChannelOffset() {},
  };
}

function createAdapter(sentMessages: OutboundMessage[]): BaseChannelAdapter {
  return {
    channelType: 'telegram',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: async (msg: OutboundMessage): Promise<SendResult> => {
      sentMessages.push(msg);
      return { ok: true, messageId: `msg-${sentMessages.length}` };
    },
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;
}

describe('/permission command', () => {
  let store: ReturnType<typeof createMockStore>;
  let sentMessages: OutboundMessage[];

  beforeEach(() => {
    store = createMockStore();
    sentMessages = [];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
  });

  it('sets the current chat to full access mode', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-1',
      address: { channelType: 'telegram', chatId: 'chat-1', userId: 'user-1' },
      text: '/permission full',
      timestamp: Date.now(),
    });

    const binding = store.bindings.get('telegram:chat-1');
    assert.equal(binding?.permissionProfile, 'full');
    assert.ok(sentMessages.some((message) => message.text.includes('当前: <b>full</b>')));
  });

  it('reports the current permission profile', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-1',
      address: { channelType: 'telegram', chatId: 'chat-1', userId: 'user-1' },
      text: '/permission full',
      timestamp: Date.now(),
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-2',
      address: { channelType: 'telegram', chatId: 'chat-1', userId: 'user-1' },
      text: '/permission status',
      timestamp: Date.now(),
    });

    assert.ok(sentMessages.some((message) => message.text.includes('当前: <b>full</b>')));
  });

  it('restores ask mode for the current chat', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-1',
      address: { channelType: 'telegram', chatId: 'chat-1', userId: 'user-1' },
      text: '/permission full',
      timestamp: Date.now(),
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-2',
      address: { channelType: 'telegram', chatId: 'chat-1', userId: 'user-1' },
      text: '/permission ask',
      timestamp: Date.now(),
    });

    const binding = store.bindings.get('telegram:chat-1');
    assert.equal(binding?.permissionProfile, 'ask');
    assert.ok(sentMessages.some((message) => message.text.includes('当前: <b>ask</b>')));
  });
});
