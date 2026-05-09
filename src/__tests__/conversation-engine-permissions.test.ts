import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import { processMessage } from 'claude-to-im/src/lib/bridge/conversation-engine.js';
import type {
  BridgeApiProvider,
  BridgeSession,
  BridgeStore,
  LLMProvider,
  StreamChatParams,
} from 'claude-to-im/src/lib/bridge/host.js';
import type { ChannelBinding } from 'claude-to-im/src/lib/bridge/types.js';

function createMockStore(settings: Record<string, string> = {}): BridgeStore {
  const sessions = new Map<string, BridgeSession>([
    ['session-1', {
      id: 'session-1',
      working_directory: '/workspace/project',
      model: 'gpt-5-codex',
      provider_id: 'provider-1',
    }],
  ]);
  const messages = new Map<string, Array<{ role: string; content: string }>>();
  const provider: BridgeApiProvider = { id: 'provider-1', baseUrl: 'https://example.test' };

  return {
    getSetting: (key: string) => settings[key] ?? null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as never),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: (id: string) => sessions.get(id) ?? null,
    listSessions: () => Array.from(sessions.values()),
    createSession: () => ({ id: 'new-session', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    updateSessionWorkingDirectory: () => {},
    addMessage: (sessionId: string, role: string, content: string) => {
      const current = messages.get(sessionId) ?? [];
      current.push({ role, content });
      messages.set(sessionId, current);
    },
    getMessages: (sessionId: string) => ({ messages: messages.get(sessionId) ?? [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: (id: string) => (id === provider.id ? provider : undefined),
    getDefaultProviderId: () => provider.id,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

class CapturingLLM implements LLMProvider {
  params: StreamChatParams | null = null;

  streamChat(params: StreamChatParams): ReadableStream<string> {
    this.params = params;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'hello from codex' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'result',
          data: JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }),
        })}\n`);
        controller.close();
      },
    });
  }
}

const binding: ChannelBinding = {
  id: 'binding-1',
  channelType: 'telegram',
  chatId: 'chat-1',
  codepilotSessionId: 'session-1',
  sdkSessionId: 'sdk-session-1',
  workingDirectory: '/workspace/project',
  model: 'gpt-5-codex',
  mode: 'code',
  active: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('conversation-engine permission profile runtime mapping', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('maps auto-review to guardian_subagent with on-request approvals', async () => {
    const llm = new CapturingLLM();
    initBridgeContext({
      store: createMockStore(),
      llm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    await processMessage({ ...binding, permissionProfile: 'auto-review' }, 'inspect repo');

    assert.equal(llm.params?.approvalPolicy, 'on-request');
    assert.equal(llm.params?.sandboxMode, 'workspace-write');
    assert.equal(llm.params?.approvalsReviewer, 'guardian_subagent');
  });

  it('lets ask override a global guardian reviewer back to user approval', async () => {
    const llm = new CapturingLLM();
    initBridgeContext({
      store: createMockStore({
        bridge_codex_approvals_reviewer: 'guardian_subagent',
      }),
      llm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    await processMessage({ ...binding, permissionProfile: 'ask' }, 'inspect repo');

    assert.equal(llm.params?.approvalPolicy, 'on-request');
    assert.equal(llm.params?.sandboxMode, 'workspace-write');
    assert.equal(llm.params?.approvalsReviewer, 'user');
  });

  it('passes configured approvals reviewer through when no session profile overrides it', async () => {
    const llm = new CapturingLLM();
    initBridgeContext({
      store: createMockStore({
        bridge_codex_approvals_reviewer: 'guardian_subagent',
        bridge_codex_approval_policy: 'never',
      }),
      llm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    await processMessage(binding, 'inspect repo');

    assert.equal(llm.params?.approvalPolicy, 'never');
    assert.equal(llm.params?.approvalsReviewer, 'guardian_subagent');
  });
});
