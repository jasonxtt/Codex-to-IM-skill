import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { initBridgeContext } from '../../lib/bridge/context';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeStore } from '../../lib/bridge/host';
import type { OutboundMessage, SendResult } from '../../lib/bridge/types';

function createStoreWithPermissionLink() {
  const links = new Map<string, {
    permissionRequestId: string;
    channelType: string;
    chatId: string;
    messageId: string;
    toolName: string;
    suggestions: string;
    resolved: boolean;
    createdAt: string;
  }>();

  const store: BridgeStore = {
    getSetting: () => null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({}) as any,
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    listSessions: () => [],
    createSession: () => ({ id: 'session-1' } as any),
    updateSessionProviderId: () => {},
    updateSessionWorkingDirectory: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: (link) => {
      links.set(link.permissionRequestId, {
        permissionRequestId: link.permissionRequestId,
        channelType: link.channelType,
        chatId: link.chatId,
        messageId: link.messageId,
        toolName: link.toolName,
        suggestions: link.suggestions ?? '',
        resolved: false,
        createdAt: new Date().toISOString(),
      });
    },
    getPermissionLink: (permissionRequestId) => {
      const link = links.get(permissionRequestId);
      return link ? { ...link } : null;
    },
    markPermissionLinkResolved: (permissionRequestId) => {
      const link = links.get(permissionRequestId);
      if (!link || link.resolved) return false;
      link.resolved = true;
      return true;
    },
    listPendingPermissionLinksByChat: (chatId) => {
      return [...links.values()].filter((link) => link.chatId === chatId && !link.resolved) as any;
    },
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };

  return { store, links };
}

function createMockTelegramAdapter(
  cleared: Array<{ chatId: string; messageId: string }>,
): BaseChannelAdapter {
  const send = async (_message: OutboundMessage): Promise<SendResult> => ({ ok: true, messageId: 'sent-1' });
  return {
    channelType: 'telegram',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send,
    answerCallback: async () => {},
    validateConfig: () => null,
    isAuthorized: () => true,
    clearInlineButtons: async (chatId: string, messageId: string) => {
      cleared.push({ chatId, messageId });
    },
  } as BaseChannelAdapter;
}

describe('bridge-manager telegram permission callback', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('clears inline buttons after a permission callback is resolved', async () => {
    const { store, links } = createStoreWithPermissionLink();
    links.set('perm-1', {
      permissionRequestId: 'perm-1',
      channelType: 'telegram',
      chatId: 'tg-chat-1',
      messageId: '100',
      toolName: 'Bash',
      suggestions: '',
      resolved: false,
      createdAt: new Date().toISOString(),
    });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => true },
      lifecycle: {},
    });

    const cleared: Array<{ chatId: string; messageId: string }> = [];
    const adapter = createMockTelegramAdapter(cleared);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'cb-1',
      address: { channelType: 'telegram', chatId: 'tg-chat-1', userId: 'u-1' },
      text: '',
      timestamp: Date.now(),
      callbackData: 'perm:allow:perm-1',
      callbackMessageId: '100',
    });

    assert.equal(cleared.length, 1, 'Inline buttons should be cleared once');
    assert.deepEqual(cleared[0], { chatId: 'tg-chat-1', messageId: '100' });
  });

  it('does not clear inline buttons when permission callback validation fails', async () => {
    const { store, links } = createStoreWithPermissionLink();
    links.set('perm-2', {
      permissionRequestId: 'perm-2',
      channelType: 'telegram',
      chatId: 'tg-chat-1',
      messageId: '101',
      toolName: 'Bash',
      suggestions: '',
      resolved: false,
      createdAt: new Date().toISOString(),
    });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => true },
      lifecycle: {},
    });

    const cleared: Array<{ chatId: string; messageId: string }> = [];
    const adapter = createMockTelegramAdapter(cleared);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'cb-2',
      address: { channelType: 'telegram', chatId: 'tg-chat-1', userId: 'u-1' },
      text: '',
      timestamp: Date.now(),
      callbackData: 'perm:allow:perm-2',
      callbackMessageId: 'different-message-id',
    });

    assert.equal(cleared.length, 0, 'Inline buttons should not be cleared for rejected callbacks');
  });
});
