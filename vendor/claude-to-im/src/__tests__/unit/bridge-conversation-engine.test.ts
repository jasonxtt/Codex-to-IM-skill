import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import { processMessage } from '../../lib/bridge/conversation-engine';
import type {
  BridgeApiProvider,
  BridgeSession,
  BridgeStore,
  LLMProvider,
  StreamChatParams,
} from '../../lib/bridge/host';
import type { ChannelBinding } from '../../lib/bridge/types';

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
    upsertChannelBinding: () => ({} as any),
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

describe('conversation-engine runtime options', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('passes configured runtime options through to the host LLM provider', async () => {
    const llm = new CapturingLLM();
    initBridgeContext({
      store: createMockStore({
        bridge_codex_approval_policy: 'never',
        bridge_codex_sandbox_mode: 'danger-full-access',
        bridge_codex_network_access: 'true',
        bridge_codex_additional_directories: '/tmp,/var/tmp',
      }),
      llm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const result = await processMessage(binding, 'inspect repo');

    assert.equal(result.hasError, false);
    assert.ok(llm.params);
    assert.equal(llm.params?.approvalPolicy, 'never');
    assert.equal(llm.params?.sandboxMode, 'danger-full-access');
    assert.equal(llm.params?.networkAccessEnabled, true);
    assert.deepEqual(llm.params?.additionalDirectories, ['/tmp', '/var/tmp']);
  });

  it('maps permissionProfile full to never + danger-full-access', async () => {
    const llm = new CapturingLLM();
    initBridgeContext({
      store: createMockStore({
        bridge_codex_approval_policy: 'on-request',
        bridge_codex_sandbox_mode: 'workspace-write',
      }),
      llm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    await processMessage({ ...binding, permissionProfile: 'full' }, 'inspect repo');

    assert.equal(llm.params?.approvalPolicy, 'never');
    assert.equal(llm.params?.sandboxMode, 'danger-full-access');
  });

  it('maps permissionProfile ask to on-request + workspace-write', async () => {
    const llm = new CapturingLLM();
    initBridgeContext({
      store: createMockStore({
        bridge_codex_approval_policy: 'never',
        bridge_codex_sandbox_mode: 'danger-full-access',
      }),
      llm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    await processMessage({ ...binding, permissionProfile: 'ask' }, 'inspect repo');

    assert.equal(llm.params?.approvalPolicy, 'on-request');
    assert.equal(llm.params?.sandboxMode, 'workspace-write');
  });

  it('ignores invalid runtime option settings', async () => {
    const llm = new CapturingLLM();
    initBridgeContext({
      store: createMockStore({
        bridge_approval_policy: 'always',
        bridge_sandbox_mode: 'unsafe',
        bridge_network_access_enabled: 'sometimes',
        bridge_additional_directories: '   ',
      }),
      llm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    await processMessage(binding, 'inspect repo');

    assert.ok(llm.params);
    assert.equal(llm.params?.approvalPolicy, undefined);
    assert.equal(llm.params?.sandboxMode, undefined);
    assert.equal(llm.params?.networkAccessEnabled, undefined);
    assert.equal(llm.params?.additionalDirectories, undefined);
  });

  it('accepts JSON arrays for additional directories', async () => {
    const llm = new CapturingLLM();
    initBridgeContext({
      store: createMockStore({
        bridge_additional_directories: '["/tmp","/opt/work"]',
      }),
      llm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    await processMessage(binding, 'inspect repo');

    assert.deepEqual(llm.params?.additionalDirectories, ['/tmp', '/opt/work']);
  });
});
