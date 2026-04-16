import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CodexAppServerBridge } from '../codex-app-server.js';
import { PendingPermissions } from '../permission-gateway.js';

function parseSSEChunks(chunks: string[]): Array<{ type: string; data: string }> {
  return chunks
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

function setupBridgeState() {
  const pendingPerms = new PendingPermissions();
  const bridge = new CodexAppServerBridge(pendingPerms, new Map<string, string>());
  const chunks: string[] = [];
  const controller = {
    enqueue: (chunk: string) => chunks.push(chunk),
  } as unknown as ReadableStreamDefaultController<string>;

  const state = (bridge as any).createTurnState('session-1', 'thread-1', controller);
  ((bridge as any).activeTurns as Map<string, unknown>).set('thread-1', state);

  return { bridge, pendingPerms, state, chunks };
}

describe('CodexAppServerBridge streaming', () => {
  it('streams agent deltas immediately when no approval is pending', () => {
    const { bridge, chunks } = setupBridgeState();

    (bridge as any).handleNotification({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        itemId: 'msg-1',
        delta: 'Hello',
      },
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data, 'Hello');
  });

  it('flushes buffered text after approvals are fully settled', () => {
    const { bridge, state, chunks } = setupBridgeState();
    state.approvalRequested = true;
    state.pendingApprovalCount = 1;

    (bridge as any).handleNotification({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        itemId: 'msg-2',
        delta: 'Buffered text',
      },
    });

    assert.equal(chunks.length, 0, 'Text should stay buffered while approval is pending');
    assert.equal(state.bufferedAgentMessageDeltas.get('msg-2'), 'Buffered text');

    state.pendingApprovalCount = 0;
    (bridge as any).flushBufferedAgentText(state);

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data, 'Buffered text');
    assert.equal(state.bufferedAgentMessageDeltas.size, 0);
  });

  it('releases buffered deltas as soon as approval request resolves', async () => {
    const { bridge, pendingPerms, state, chunks } = setupBridgeState();

    const approvalPromise = (bridge as any).requestApproval(
      state,
      'approval-1',
      'Bash',
      { command: 'echo hi' },
    );

    (bridge as any).handleNotification({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        itemId: 'msg-3',
        delta: 'after-approval',
      },
    });

    assert.equal(chunks.length, 1, 'permission_request should be emitted immediately');

    const resolved = pendingPerms.resolve('approval-1', { behavior: 'allow' });
    assert.equal(resolved, true);
    await approvalPromise;

    const events = parseSSEChunks(chunks);
    const textEvent = events.find((event) => event.type === 'text');
    assert.ok(textEvent, 'Buffered delta should be flushed when approval resolves');
    assert.equal(textEvent?.data, 'after-approval');
    assert.equal(state.pendingApprovalCount, 0);
  });
});
