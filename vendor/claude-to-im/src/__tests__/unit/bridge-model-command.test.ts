import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeSession, BridgeStore } from '../../lib/bridge/host';
import type { ChannelBinding, OutboundMessage, SendResult } from '../../lib/bridge/types';

function createMockStore(): BridgeStore & {
  bindings: Map<string, ChannelBinding>;
  sessions: Map<string, BridgeSession>;
  seedBinding(chatId: string, opts?: { model?: string; sdkSessionId?: string }): ChannelBinding;
} {
  const bindings = new Map<string, ChannelBinding>();
  const sessions = new Map<string, BridgeSession>();
  let nextId = 1;

  const store: BridgeStore & {
    bindings: Map<string, ChannelBinding>;
    sessions: Map<string, BridgeSession>;
    seedBinding(chatId: string, opts?: { model?: string; sdkSessionId?: string }): ChannelBinding;
  } = {
    bindings,
    sessions,
    getSetting(key: string) {
      if (key === 'bridge_default_work_dir') return '/tmp/test';
      if (key === 'bridge_default_model') return 'gpt-5.3-codex';
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
      const session: BridgeSession = {
        id: `session-${nextId++}`,
        working_directory: cwd || '/tmp/test',
        model,
        sdk_session_id: '',
      };
      sessions.set(session.id, session);
      return session;
    },
    updateSessionProviderId() {},
    addMessage() {},
    getMessages() { return { messages: [] }; },
    acquireSessionLock() { return true; },
    renewSessionLock() {},
    releaseSessionLock() {},
    setSessionRuntimeStatus() {},
    updateSdkSessionId(sessionId: string, sdkSessionId: string) {
      const session = sessions.get(sessionId);
      if (session) {
        session.sdk_session_id = sdkSessionId;
      }
      for (const [key, binding] of bindings) {
        if (binding.codepilotSessionId === sessionId) {
          bindings.set(key, { ...binding, sdkSessionId });
        }
      }
    },
    updateSessionModel(sessionId: string, model: string) {
      const session = sessions.get(sessionId);
      if (session) {
        session.model = model;
      }
    },
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
    seedBinding(chatId: string, opts?: { model?: string; sdkSessionId?: string }) {
      const model = opts?.model ?? 'gpt-5.3-codex';
      const sdkSessionId = opts?.sdkSessionId ?? 'sdk-thread-1';
      const session = this.createSession(`Bridge: ${chatId}`, model, undefined, '/tmp/test');
      session.sdk_session_id = sdkSessionId;
      return this.upsertChannelBinding({
        channelType: 'telegram',
        chatId,
        codepilotSessionId: session.id,
        sdkSessionId,
        workingDirectory: session.working_directory,
        model,
        mode: 'code',
        permissionProfile: 'ask',
      });
    },
  };

  return store;
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

describe('/model and /import command', () => {
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

  it('opens a model panel when /model is used without arguments', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-1',
      address: { channelType: 'telegram', chatId: 'chat-1', userId: 'user-1' },
      text: '/model',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('模型选择'));
    assert.ok(sentMessages[0].inlineButtons?.flat().some((button) => button.callbackData === 'ui:model:status'));
    assert.ok(sentMessages[0].inlineButtons?.flat().some((button) => button.callbackData.startsWith('ui:model:')));
  });

  it('switches the current chat model from /model and clears the sdk session id', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter(sentMessages);
    const binding = store.seedBinding('chat-2', { model: 'gpt-5.3-codex', sdkSessionId: 'sdk-old' });

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-1',
      address: { channelType: 'telegram', chatId: 'chat-2', userId: 'user-2' },
      text: '/model gpt-5.4',
      timestamp: Date.now(),
    });

    const updated = store.bindings.get('telegram:chat-2');
    const session = store.sessions.get(binding.codepilotSessionId);
    assert.equal(updated?.model, 'gpt-5.4');
    assert.equal(updated?.sdkSessionId, '');
    assert.equal(session?.model, 'gpt-5.4');
    assert.equal(session?.sdk_session_id, '');
    assert.ok(sentMessages.some((message) => message.text.includes('当前: <code>gpt-5.4</code>')));
  });

  it('switches the current chat model from callback buttons', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter(sentMessages);
    const binding = store.seedBinding('chat-3', { model: 'gpt-5.3-codex', sdkSessionId: 'sdk-old' });

    await _testOnly.handleMessage(adapter, {
      messageId: 'cb-1',
      callbackMessageId: 'origin-1',
      callbackData: 'ui:model:gpt-5.4',
      address: { channelType: 'telegram', chatId: 'chat-3', userId: 'user-3' },
      text: '',
      timestamp: Date.now(),
    });

    const updated = store.bindings.get('telegram:chat-3');
    const session = store.sessions.get(binding.codepilotSessionId);
    assert.equal(updated?.model, 'gpt-5.4');
    assert.equal(updated?.sdkSessionId, '');
    assert.equal(session?.model, 'gpt-5.4');
    assert.equal(session?.sdk_session_id, '');
    assert.ok(sentMessages.some((message) => message.text.includes('当前: <code>gpt-5.4</code>')));
  });

  it('imports an external Codex session and binds the current chat to it', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter(sentMessages);
    const original = store.seedBinding('chat-4', { model: 'gpt-5.3-codex', sdkSessionId: 'sdk-old' });
    const externalSessionId = '019d7833-fadc-7ac1-94e1-dc91a8d37506';

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-import-1',
      address: { channelType: 'telegram', chatId: 'chat-4', userId: 'user-4' },
      text: `/import ${externalSessionId}`,
      timestamp: Date.now(),
    });

    const updated = store.bindings.get('telegram:chat-4');
    assert.ok(updated);
    assert.notEqual(updated?.codepilotSessionId, original.codepilotSessionId);
    assert.equal(updated?.sdkSessionId, externalSessionId);
    const importedSession = updated ? store.sessions.get(updated.codepilotSessionId) : null;
    assert.equal(importedSession?.sdk_session_id, externalSessionId);
    assert.ok(sentMessages.some((message) => message.text.includes('已导入 Codex CLI 会话。')));
  });

  it('reuses an already imported Codex session when importing the same external id', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter(sentMessages);
    const externalSessionId = '019d7833-fadc-7ac1-94e1-dc91a8d37506';
    const imported = store.createSession('Imported', 'gpt-5.4', undefined, '/tmp/test');
    store.updateSdkSessionId(imported.id, externalSessionId);
    store.seedBinding('chat-5', { model: 'gpt-5.3-codex', sdkSessionId: 'sdk-old' });
    const beforeCount = store.sessions.size;

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-import-2',
      address: { channelType: 'telegram', chatId: 'chat-5', userId: 'user-5' },
      text: `/import ${externalSessionId}`,
      timestamp: Date.now(),
    });

    const updated = store.bindings.get('telegram:chat-5');
    assert.equal(updated?.codepilotSessionId, imported.id);
    assert.equal(updated?.sdkSessionId, externalSessionId);
    assert.equal(store.sessions.size, beforeCount);
    assert.ok(sentMessages.some((message) => message.text.includes('已绑定已导入会话。')));
  });

  it('accepts Codex app-server model/list responses that use result.data', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    const models = _testOnly.extractModelCatalogEntries({
      data: [
        { id: 'gpt-5.4', displayName: 'GPT-5.4' },
        { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex' },
      ],
    });

    assert.deepEqual(models, [
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    ]);
  });

  it('falls back to latest external Codex session when /resume has no local history in current cwd', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter(sentMessages);
    store.seedBinding('chat-6', { model: 'gpt-5.3-codex', sdkSessionId: 'sdk-old' });
    const externalSessionId = '019d7833-fadc-7ac1-94e1-dc91a8d37506';

    const oldHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-ext-home-'));
    try {
      process.env.HOME = tempHome;
      writeExternalCodexSession(tempHome, {
        id: externalSessionId,
        cwd: '/tmp/test',
        threadName: 'External Session',
        updatedAt: '2026-04-15T15:00:00.000Z',
      });
      _testOnly.resetExternalCodexSessionCache();

      await _testOnly.handleMessage(adapter, {
        messageId: 'msg-resume-external',
        address: { channelType: 'telegram', chatId: 'chat-6', userId: 'user-6' },
        text: '/resume',
        timestamp: Date.now(),
      });
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
      _testOnly.resetExternalCodexSessionCache();
    }

    const updated = store.bindings.get('telegram:chat-6');
    assert.equal(updated?.sdkSessionId, externalSessionId);
    assert.ok(sentMessages.some((message) => message.text.includes('已恢复外部 Codex CLI 会话。')));
  });

  it('shows external Codex sessions for current cwd via /sessions external', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter(sentMessages);
    store.seedBinding('chat-7', { model: 'gpt-5.3-codex', sdkSessionId: 'sdk-old' });
    const externalSessionId = '019d7833-fadc-7ac1-94e1-dc91a8d37506';

    const oldHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-ext-home-'));
    try {
      process.env.HOME = tempHome;
      writeExternalCodexSession(tempHome, {
        id: externalSessionId,
        cwd: '/tmp/test',
        threadName: 'External Session',
        updatedAt: '2026-04-15T15:00:00.000Z',
      });
      _testOnly.resetExternalCodexSessionCache();

      await _testOnly.handleMessage(adapter, {
        messageId: 'msg-sessions-external',
        address: { channelType: 'telegram', chatId: 'chat-7', userId: 'user-7' },
        text: '/sessions external',
        timestamp: Date.now(),
      });
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
      _testOnly.resetExternalCodexSessionCache();
    }

    assert.ok(sentMessages.some((message) => message.text.includes('<b>外部 Codex CLI 会话</b>')));
    assert.ok(sentMessages.some((message) => message.text.includes(`${externalSessionId.slice(0, 8)}...`)));
  });
});

function writeExternalCodexSession(
  tempHome: string,
  options: { id: string; cwd: string; threadName: string; updatedAt: string },
): void {
  const codexHome = path.join(tempHome, '.codex');
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '04', '15');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(indexPath, `${JSON.stringify({
    id: options.id,
    thread_name: options.threadName,
    updated_at: options.updatedAt,
  })}\n`, 'utf-8');
  const sessionPath = path.join(
    sessionsDir,
    `rollout-2026-04-15T00-00-00-${options.id}.jsonl`,
  );
  fs.writeFileSync(sessionPath, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: options.id,
      cwd: options.cwd,
    },
  })}\n`, 'utf-8');
}
