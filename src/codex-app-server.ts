import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions, PermissionResult } from './permission-gateway.js';
import { sseEvent } from './sse-utils.js';

export interface CodexThreadOptions {
  model?: string;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-request' | 'on-failure' | 'never';
  networkAccessEnabled?: boolean;
  additionalDirectories?: string[];
}

interface JsonRpcRequestMessage {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotificationMessage {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponseMessage {
  jsonrpc?: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface ActiveTurnState {
  sessionId: string;
  threadId: string;
  turnId: string | null;
  controller: ReadableStreamDefaultController<string>;
  streamedAgentMessageIds: Set<string>;
  itemSnapshots: Map<string, Record<string, unknown>>;
  bufferedAgentMessageDeltas: Map<string, string>;
  approvalRequested: boolean;
  pendingApprovalCount: number;
  syntheticFallbackTriggered: boolean;
  syntheticFallbackCompleted: boolean;
  pendingSyntheticTasks: number;
  turnCompletionPending: boolean;
  latestUsage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  };
  settled: boolean;
  resolveDone: () => void;
  rejectDone: (error: Error) => void;
  done: Promise<void>;
}

class JsonRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private requestHandlers = new Map<string, (message: JsonRpcRequestMessage) => Promise<unknown>>();
  private notificationHandlers = new Set<(message: JsonRpcNotificationMessage) => void>();
  private closeHandlers = new Set<(error: Error) => void>();
  private stderrHandlers = new Set<(line: string) => void>();
  private initialized: Promise<void>;
  private closed = false;

  constructor(skipGitRepoCheck: boolean) {
    const args = ['app-server', '--listen', 'stdio://'];
    if (skipGitRepoCheck) {
      args.push('-c', 'skip_git_repo_check=true');
    }

    this.child = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');

    const stdout = readline.createInterface({ input: this.child.stdout });
    stdout.on('line', (line) => {
      this.handleLine(line);
    });

    this.child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) {
        console.warn('[codex-app-server] stderr:', text);
        for (const handler of this.stderrHandlers) {
          handler(text);
        }
      }
    });

    const handleClose = (error: Error) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      for (const [, pending] of this.pending) {
        pending.reject(error);
      }
      this.pending.clear();
      for (const handler of this.closeHandlers) {
        handler(error);
      }
    };

    this.child.once('error', (error) => {
      handleClose(error);
    });
    this.child.once('close', (code, signal) => {
      handleClose(new Error(`codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
    });

    this.initialized = this.sendRequest('initialize', {
      clientInfo: {
        name: 'codex_to_im',
        title: 'codex-to-im',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    }).then(() => {
      this.sendNotification('initialized');
    });
  }

  async ready(): Promise<void> {
    await this.initialized;
  }

  onNotification(handler: (message: JsonRpcNotificationMessage) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onRequest(method: string, handler: (message: JsonRpcRequestMessage) => Promise<unknown>): () => void {
    this.requestHandlers.set(method, handler);
    return () => {
      const current = this.requestHandlers.get(method);
      if (current === handler) {
        this.requestHandlers.delete(method);
      }
    };
  }

  onClose(handler: (error: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  onStderr(handler: (line: string) => void): () => void {
    this.stderrHandlers.add(handler);
    return () => {
      this.stderrHandlers.delete(handler);
    };
  }

  async sendRequest<T>(method: string, params?: unknown): Promise<T> {
    if (method === 'initialize') {
      return await this.sendRequestInternal<T>(method, params);
    }
    await this.initialized;
    return await this.sendRequestInternal<T>(method, params);
  }

  sendNotification(method: string, params?: unknown): void {
    this.writeMessage({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  respond(id: string | number, result: unknown): void {
    this.writeMessage({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  respondError(id: string | number, code: number, message: string, data?: unknown): void {
    this.writeMessage({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(data !== undefined ? { data } : {}),
      },
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.child.kill('SIGTERM');
  }

  private async sendRequestInternal<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      throw new Error('codex app-server is not running');
    }

    const id = String(this.nextId++);
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });

    this.writeMessage({
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });

    return await promise;
  }

  private writeMessage(message: unknown): void {
    if (this.closed) {
      throw new Error('codex app-server is not running');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage;
    } catch (error) {
      console.warn('[codex-app-server] Failed to parse stdout line:', trimmed, error);
      return;
    }

    if ('id' in message && ('result' in message || 'error' in message) && !('method' in message)) {
      this.handleResponse(message);
      return;
    }

    if ('method' in message && 'id' in message) {
      this.handleServerRequest(message as JsonRpcRequestMessage);
      return;
    }

    if ('method' in message) {
      for (const handler of this.notificationHandlers) {
        handler(message as JsonRpcNotificationMessage);
      }
    }
  }

  private handleResponse(message: JsonRpcResponseMessage): void {
    const pending = this.pending.get(String(message.id));
    if (!pending) {
      return;
    }
    this.pending.delete(String(message.id));

    if (message.error) {
      pending.reject(new JsonRpcError(
        message.error.message || 'JSON-RPC request failed',
        message.error.code,
        message.error.data,
      ));
      return;
    }

    pending.resolve(message.result);
  }

  private handleServerRequest(message: JsonRpcRequestMessage): void {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this.respondError(message.id, -32601, `Method not supported: ${message.method}`);
      return;
    }

    void (async () => {
      try {
        const result = await handler(message);
        this.respond(message.id, result);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.respondError(message.id, -32000, err.message);
      }
    })();
  }
}

export class CodexAppServerBridge {
  private client: CodexAppServerClient | null = null;
  private activeTurns = new Map<string, ActiveTurnState>();
  private turnToThread = new Map<string, string>();
  private unregisterFns: Array<() => void> = [];

  constructor(
    private pendingPerms: PendingPermissions,
    private threadIds: Map<string, string>,
  ) {}

  async streamChat(
    params: StreamChatParams,
    controller: ReadableStreamDefaultController<string>,
    threadOptions: CodexThreadOptions,
    input: Array<Record<string, unknown>>,
  ): Promise<void> {
    const client = await this.ensureClient(threadOptions.skipGitRepoCheck === true);
    const threadId = await this.resolveThread(client, params, threadOptions);

    controller.enqueue(sseEvent('status', { session_id: threadId }));

    const state = this.createTurnState(params.sessionId, threadId, controller);
    this.activeTurns.set(threadId, state);

    let abortHandler: (() => void) | undefined;

    try {
      const turnResult = await client.sendRequest<{ turn?: { id?: string | null } }>('turn/start', {
        threadId,
        input,
        ...(threadOptions.workingDirectory ? { cwd: threadOptions.workingDirectory } : {}),
        ...(threadOptions.approvalPolicy ? { approvalPolicy: threadOptions.approvalPolicy } : {}),
        approvalsReviewer: 'user',
        ...(buildTurnSandboxPolicy(threadOptions) ? { sandboxPolicy: buildTurnSandboxPolicy(threadOptions) } : {}),
        ...(threadOptions.model ? { model: threadOptions.model } : {}),
      });

      const turnId = turnResult.turn?.id ?? null;
      if (turnId) {
        state.turnId = turnId;
        this.turnToThread.set(turnId, threadId);
      }

      if (params.abortController?.signal) {
        const signal = params.abortController.signal;
        abortHandler = () => {
          if (state.turnId) {
            void client.sendRequest('turn/interrupt', {
              threadId,
              turnId: state.turnId,
            }).catch((error) => {
              console.warn('[codex-app-server] Failed to interrupt turn:', error);
            });
          }
        };
        signal.addEventListener('abort', abortHandler, { once: true });
        if (signal.aborted) {
          abortHandler();
        }
      }

      await state.done;
    } finally {
      if (params.abortController?.signal && abortHandler) {
        params.abortController.signal.removeEventListener('abort', abortHandler);
      }
      this.activeTurns.delete(threadId);
      if (state.turnId) {
        this.turnToThread.delete(state.turnId);
      }
    }
  }

  close(): void {
    for (const unregister of this.unregisterFns) {
      unregister();
    }
    this.unregisterFns = [];
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }

  private createTurnState(
    sessionId: string,
    threadId: string,
    controller: ReadableStreamDefaultController<string>,
  ): ActiveTurnState {
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    return {
      sessionId,
      threadId,
      turnId: null,
      controller,
      streamedAgentMessageIds: new Set(),
      itemSnapshots: new Map(),
      bufferedAgentMessageDeltas: new Map(),
      approvalRequested: false,
      pendingApprovalCount: 0,
      syntheticFallbackTriggered: false,
      syntheticFallbackCompleted: false,
      pendingSyntheticTasks: 0,
      turnCompletionPending: false,
      settled: false,
      resolveDone,
      rejectDone,
      done,
    };
  }

  private async ensureClient(skipGitRepoCheck: boolean): Promise<CodexAppServerClient> {
    if (this.client) {
      return this.client;
    }

    const client = new CodexAppServerClient(skipGitRepoCheck);
    this.client = client;
    await client.ready();

    this.unregisterFns.push(
      client.onNotification((message) => {
        this.handleNotification(message);
      }),
      client.onRequest('item/commandExecution/requestApproval', (message) => this.handleCommandApprovalRequest(message)),
      client.onRequest('item/fileChange/requestApproval', (message) => this.handleFileChangeApprovalRequest(message)),
      client.onRequest('item/permissions/requestApproval', (message) => this.handlePermissionsApprovalRequest(message)),
      client.onRequest('execCommandApproval', (message) => this.handleLegacyExecApprovalRequest(message)),
      client.onRequest('applyPatchApproval', (message) => this.handleLegacyPatchApprovalRequest(message)),
      client.onRequest('item/tool/requestUserInput', async () => {
        throw new Error('Codex user-input requests are not supported by codex-to-im');
      }),
      client.onRequest('item/tool/call', async () => {
        throw new Error('Codex app tool calls are not supported by codex-to-im');
      }),
      client.onRequest('mcpServer/elicitation/request', async () => {
        throw new Error('MCP elicitation requests are not supported by codex-to-im');
      }),
      client.onClose((error) => {
        this.client = null;
        for (const [, state] of this.activeTurns) {
          this.failTurn(state, error.message);
        }
      }),
      client.onStderr((line) => {
        this.handleStderr(line);
      }),
    );

    return client;
  }

  private async resolveThread(
    client: CodexAppServerClient,
    params: StreamChatParams,
    threadOptions: CodexThreadOptions,
  ): Promise<string> {
    const inMemoryThreadId = this.threadIds.get(params.sessionId);
    let savedThreadId = inMemoryThreadId || params.sdkSessionId || undefined;
    let retryFresh = false;

    while (true) {
      try {
        if (savedThreadId) {
          const resumed = await client.sendRequest<{ thread: { id: string } }>('thread/resume', {
            threadId: savedThreadId,
            ...(threadOptions.model ? { model: threadOptions.model } : {}),
            ...(threadOptions.workingDirectory ? { cwd: threadOptions.workingDirectory } : {}),
            ...(threadOptions.approvalPolicy ? { approvalPolicy: threadOptions.approvalPolicy } : {}),
            approvalsReviewer: 'user',
            ...(threadOptions.sandboxMode ? { sandbox: threadOptions.sandboxMode } : {}),
            ...(buildThreadConfig(threadOptions) ? { config: buildThreadConfig(threadOptions) } : {}),
            persistExtendedHistory: true,
          });
          this.threadIds.set(params.sessionId, resumed.thread.id);
          return resumed.thread.id;
        }

        const started = await client.sendRequest<{ thread: { id: string } }>('thread/start', {
          ...(threadOptions.model ? { model: threadOptions.model } : {}),
          ...(threadOptions.workingDirectory ? { cwd: threadOptions.workingDirectory } : {}),
          ...(threadOptions.approvalPolicy ? { approvalPolicy: threadOptions.approvalPolicy } : {}),
          approvalsReviewer: 'user',
          ...(threadOptions.sandboxMode ? { sandbox: threadOptions.sandboxMode } : {}),
          ...(buildThreadConfig(threadOptions) ? { config: buildThreadConfig(threadOptions) } : {}),
          experimentalRawEvents: false,
          persistExtendedHistory: true,
        });
        this.threadIds.set(params.sessionId, started.thread.id);
        return started.thread.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!threadOptions.skipGitRepoCheck && shouldRetryWithSkipGitRepoCheck(message)) {
          console.warn('[codex-app-server] Working directory is not trusted, retrying with skipGitRepoCheck:', message);
          this.close();
          const retryClient = await this.ensureClient(true);
          return await this.resolveThread(retryClient, params, { ...threadOptions, skipGitRepoCheck: true });
        }
        if (savedThreadId && !retryFresh && shouldRetryFreshThread(message)) {
          savedThreadId = undefined;
          retryFresh = true;
          continue;
        }
        throw error;
      }
    }
  }

  private handleNotification(message: JsonRpcNotificationMessage): void {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    const turn = asRecord(params.turn);
    const turnId = typeof turn?.id === 'string' ? turn.id : undefined;
    const state = this.findState(threadId, turnId);

    if (!state) {
      return;
    }

    switch (message.method) {
      case 'turn/started': {
        if (turnId) {
          state.turnId = turnId;
          this.turnToThread.set(turnId, state.threadId);
        }
        break;
      }

      case 'item/started': {
        const item = asRecord(params.item);
        if (item && typeof item.id === 'string') {
          state.itemSnapshots.set(item.id, item);
        }
        break;
      }

      case 'item/agentMessage/delta': {
        const delta = params.delta;
        const itemId = params.itemId;
        if (typeof delta === 'string' && delta) {
          if (typeof itemId === 'string' && shouldBufferAgentText(state)) {
            const previous = state.bufferedAgentMessageDeltas.get(itemId) ?? '';
            state.bufferedAgentMessageDeltas.set(itemId, previous + delta);
          } else {
            if (typeof itemId === 'string') {
              state.streamedAgentMessageIds.add(itemId);
            }
            state.controller.enqueue(sseEvent('text', delta));
          }
        }
        break;
      }

      case 'thread/tokenUsage/updated': {
        const tokenUsage = asRecord(params.tokenUsage);
        const last = asRecord(tokenUsage?.last);
        if (last) {
          state.latestUsage = {
            input_tokens: toNumber(last.inputTokens),
            output_tokens: toNumber(last.outputTokens),
            cache_read_input_tokens: toNumber(last.cachedInputTokens),
          };
        }
        break;
      }

      case 'item/completed': {
        const item = asRecord(params.item);
        if (item && typeof item.id === 'string') {
          state.itemSnapshots.set(item.id, item);
          this.emitCompletedItem(state, item);
        }
        break;
      }

      case 'turn/completed': {
        const completedTurn = asRecord(params.turn);
        const status = completedTurn?.status;
        const error = asRecord(completedTurn?.error);
        if (status === 'failed') {
          this.failTurn(state, typeof error?.message === 'string' ? error.message : 'Turn failed');
          return;
        }
        state.turnCompletionPending = true;
        if (state.pendingSyntheticTasks === 0) {
          this.completeTurn(state);
        }
        break;
      }

      case 'error': {
        const error = asRecord(params.error);
        const messageText = typeof error?.message === 'string' ? error.message : 'Turn failed';
        this.failTurn(state, messageText);
        break;
      }

      default:
        break;
    }
  }

  private emitCompletedItem(state: ActiveTurnState, item: Record<string, unknown>): void {
    switch (item.type) {
      case 'agentMessage': {
        const itemId = typeof item.id === 'string' ? item.id : '';
        const text = typeof item.text === 'string' ? item.text : '';
        if (text && !state.streamedAgentMessageIds.has(itemId) && !shouldBufferAgentText(state)) {
          state.controller.enqueue(sseEvent('text', text));
          if (itemId) {
            state.streamedAgentMessageIds.add(itemId);
          }
        }
        break;
      }

      case 'commandExecution': {
        const toolId = typeof item.id === 'string' ? item.id : `tool-${Date.now()}`;
        const command = typeof item.command === 'string' ? item.command : '';
        const aggregatedOutput = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
        const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
        const status = typeof item.status === 'string' ? item.status : undefined;
        const cwd = typeof item.cwd === 'string' ? item.cwd : undefined;
        const isError = status === 'failed' || status === 'declined' || (exitCode !== undefined && exitCode !== 0);

        if (status === 'failed' && isSandboxBootstrapFailure(aggregatedOutput, command) && !state.syntheticFallbackTriggered) {
          state.syntheticFallbackTriggered = true;
          state.pendingSyntheticTasks += 1;
          void this.handleSyntheticCommandFallback(state, {
            toolId,
            command,
            cwd,
            aggregatedOutput,
          }).finally(() => {
            state.pendingSyntheticTasks = Math.max(0, state.pendingSyntheticTasks - 1);
            state.syntheticFallbackCompleted = true;
            if (state.turnCompletionPending && state.pendingSyntheticTasks === 0) {
              this.completeTurn(state);
            }
          });
          break;
        }

        state.controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Bash',
          input: {
            command,
            cwd,
          },
        }));
        state.controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: aggregatedOutput || (status === 'declined' ? 'Denied by user' : exitCode !== undefined ? `Exit code: ${exitCode}` : 'Done'),
          is_error: isError,
        }));
        break;
      }

      case 'fileChange': {
        const toolId = typeof item.id === 'string' ? item.id : `tool-${Date.now()}`;
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const summary = changes
          .map((change) => {
            const fileChange = asRecord(change);
            if (!fileChange) {
              return null;
            }
            const changePath = typeof fileChange.path === 'string' ? fileChange.path : '';
            const kind = typeof fileChange.kind === 'string' ? fileChange.kind : 'change';
            return `${kind}: ${changePath}`;
          })
          .filter((line): line is string => !!line)
          .join('\n');
        const status = typeof item.status === 'string' ? item.status : undefined;

        state.controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Edit',
          input: { files: changes },
        }));
        state.controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: summary || (status === 'declined' ? 'Denied by user' : 'File changes applied'),
          is_error: status === 'failed' || status === 'declined',
        }));
        break;
      }

      case 'mcpToolCall': {
        const toolId = typeof item.id === 'string' ? item.id : `tool-${Date.now()}`;
        const server = typeof item.server === 'string' ? item.server : 'unknown';
        const tool = typeof item.tool === 'string' ? item.tool : 'unknown';
        const result = asRecord(item.result);
        const error = asRecord(item.error);
        const content = result?.content ?? result?.structuredContent ?? 'Done';
        state.controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: `mcp__${server}__${tool}`,
          input: item.arguments ?? {},
        }));
        state.controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: typeof content === 'string' ? content : JSON.stringify(content),
          is_error: !!error,
        }));
        break;
      }

      default:
        break;
    }
  }

  private failTurn(state: ActiveTurnState, message: string): void {
    if (state.settled) {
      return;
    }
    state.settled = true;
    state.controller.enqueue(sseEvent('error', message));
    state.resolveDone();
  }

  private completeTurn(state: ActiveTurnState): void {
    if (state.settled) {
      return;
    }
    this.flushBufferedAgentText(state);
    state.controller.enqueue(sseEvent('result', {
      ...(state.latestUsage ? { usage: state.latestUsage } : {}),
      session_id: state.threadId,
    }));
    state.settled = true;
    state.resolveDone();
  }

  private findState(threadId?: string, turnId?: string): ActiveTurnState | undefined {
    if (threadId) {
      return this.activeTurns.get(threadId);
    }
    if (turnId) {
      const mappedThreadId = this.turnToThread.get(turnId);
      if (mappedThreadId) {
        return this.activeTurns.get(mappedThreadId);
      }
    }
    return undefined;
  }

  private findStateForFallback(commandFromLog?: string): ActiveTurnState | undefined {
    if (this.activeTurns.size === 1) {
      return [...this.activeTurns.values()][0];
    }

    if (!commandFromLog) {
      return undefined;
    }

    for (const [, state] of this.activeTurns) {
      if (findCommandSnapshot(state, commandFromLog)) {
        return state;
      }
    }

    return undefined;
  }

  private async handleCommandApprovalRequest(message: JsonRpcRequestMessage): Promise<unknown> {
    const params = asRecord(message.params);
    const state = this.findState(
      typeof params?.threadId === 'string' ? params.threadId : undefined,
      typeof params?.turnId === 'string' ? params.turnId : undefined,
    );
    const command = typeof params?.command === 'string' ? params.command : '';
    const resolution = await this.requestApproval(
      state,
      message.id,
      'Bash',
      {
        command,
        cwd: typeof params?.cwd === 'string' ? params.cwd : undefined,
        reason: typeof params?.reason === 'string' ? params.reason : undefined,
      },
    );

    return {
      decision: resolution.behavior === 'allow'
        ? (resolution.grantScope === 'session' ? 'acceptForSession' : 'accept')
        : 'decline',
    };
  }

  private async handleFileChangeApprovalRequest(message: JsonRpcRequestMessage): Promise<unknown> {
    const params = asRecord(message.params);
    const state = this.findState(
      typeof params?.threadId === 'string' ? params.threadId : undefined,
      typeof params?.turnId === 'string' ? params.turnId : undefined,
    );
    const itemId = typeof params?.itemId === 'string' ? params.itemId : '';
    const snapshot = itemId ? state?.itemSnapshots.get(itemId) : undefined;
    const changes = Array.isArray(snapshot?.changes) ? snapshot.changes : [];
    const reason = typeof params?.reason === 'string' ? params.reason : undefined;
    const commandSnapshot = state ? findLatestCommandSnapshot(state) : undefined;
    const looksLikeSandboxRetry = isSandboxRetryReason(reason);

    const resolution = await this.requestApproval(
      state,
      message.id,
      looksLikeSandboxRetry && commandSnapshot ? 'Bash' : 'Edit',
      looksLikeSandboxRetry && commandSnapshot
        ? {
          command: commandSnapshot.command,
          cwd: commandSnapshot.cwd,
          reason: '当前 Linux 沙箱启动失败。是否允许我在沙箱外重跑这条命令？',
        }
        : {
          files: changes,
          reason,
          grantRoot: typeof params?.grantRoot === 'string' ? params.grantRoot : undefined,
        },
    );

    return {
      decision: resolution.behavior === 'allow'
        ? (resolution.grantScope === 'session' ? 'acceptForSession' : 'accept')
        : 'decline',
    };
  }

  private async handlePermissionsApprovalRequest(message: JsonRpcRequestMessage): Promise<unknown> {
    const params = asRecord(message.params);
    const state = this.findState(
      typeof params?.threadId === 'string' ? params.threadId : undefined,
      typeof params?.turnId === 'string' ? params.turnId : undefined,
    );
    const requestedPermissions = asRecord(params?.permissions) ?? {};
    const resolution = await this.requestApproval(
      state,
      message.id,
      'Permissions',
      {
        reason: typeof params?.reason === 'string' ? params.reason : undefined,
        permissions: requestedPermissions,
      },
    );

    return {
      ...(resolution.grantScope === 'session' ? { scope: 'session' } : { scope: 'turn' }),
      permissions: resolution.behavior === 'allow' ? requestedPermissions : {},
    };
  }

  private async handleLegacyExecApprovalRequest(message: JsonRpcRequestMessage): Promise<unknown> {
    const params = asRecord(message.params);
    const conversationId = typeof params?.conversationId === 'string' ? params.conversationId : undefined;
    const resolution = await this.requestApproval(
      this.findState(conversationId),
      message.id,
      'Bash',
      {
        command: Array.isArray(params?.command) ? params.command.join(' ') : '',
        cwd: typeof params?.cwd === 'string' ? params.cwd : undefined,
        reason: typeof params?.reason === 'string' ? params.reason : undefined,
      },
    );

    return {
      decision: resolution.behavior === 'allow' ? 'allow' : 'deny',
    };
  }

  private async handleLegacyPatchApprovalRequest(message: JsonRpcRequestMessage): Promise<unknown> {
    const params = asRecord(message.params);
    const conversationId = typeof params?.conversationId === 'string' ? params.conversationId : undefined;
    const resolution = await this.requestApproval(
      this.findState(conversationId),
      message.id,
      'Edit',
      {
        files: params?.fileChanges ?? {},
        reason: typeof params?.reason === 'string' ? params.reason : undefined,
        grantRoot: typeof params?.grantRoot === 'string' ? params.grantRoot : undefined,
      },
    );

    return {
      decision: resolution.behavior === 'allow' ? 'allow' : 'deny',
    };
  }

  private async requestApproval(
    state: ActiveTurnState | undefined,
    requestId: string | number,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<PermissionResult> {
    if (!state) {
      return {
        behavior: 'deny',
        message: 'No active bridge session for approval request',
      };
    }

    state.approvalRequested = true;
    state.pendingApprovalCount += 1;
    state.bufferedAgentMessageDeltas.clear();

    state.controller.enqueue(sseEvent('permission_request', {
      permissionRequestId: String(requestId),
      toolName,
      toolInput,
      suggestions: [],
    }));

    try {
      return await this.pendingPerms.waitFor(String(requestId));
    } finally {
      state.pendingApprovalCount = Math.max(0, state.pendingApprovalCount - 1);
      if (state.pendingApprovalCount === 0 && !state.settled) {
        this.flushBufferedAgentText(state);
      }
    }
  }

  private flushBufferedAgentText(state: ActiveTurnState): void {
    if (state.pendingApprovalCount > 0) {
      return;
    }

    if (state.syntheticFallbackTriggered) {
      state.bufferedAgentMessageDeltas.clear();
      return;
    }

    for (const [itemId, text] of state.bufferedAgentMessageDeltas) {
      if (!text || state.streamedAgentMessageIds.has(itemId)) {
        continue;
      }
      state.controller.enqueue(sseEvent('text', text));
      state.streamedAgentMessageIds.add(itemId);
    }

    for (const [itemId, item] of state.itemSnapshots) {
      if (state.streamedAgentMessageIds.has(itemId) || item.type !== 'agentMessage') {
        continue;
      }
      const text = typeof item.text === 'string' ? item.text : '';
      if (!text) {
        continue;
      }
      state.controller.enqueue(sseEvent('text', text));
      state.streamedAgentMessageIds.add(itemId);
    }

    state.bufferedAgentMessageDeltas.clear();
  }

  private async handleSyntheticCommandFallback(
    state: ActiveTurnState,
    command: {
      toolId: string;
      command: string;
      cwd?: string;
      aggregatedOutput: string;
    },
  ): Promise<void> {
    const sessionApproved = syntheticEscalationSessionApprovals.has(state.sessionId);

    let resolution: PermissionResult;
    if (sessionApproved) {
      resolution = { behavior: 'allow', grantScope: 'session' };
    } else {
      resolution = await this.requestApproval(
        state,
        `bridge-escalation:${state.threadId}:${command.toolId}`,
        'Bash',
        {
          command: command.command,
          cwd: command.cwd,
          reason: '当前 Linux 沙箱启动失败。是否允许我在沙箱外重跑这条命令？',
        },
      );
    }

    state.controller.enqueue(sseEvent('tool_use', {
      id: command.toolId,
      name: 'Bash',
      input: {
        command: command.command,
        cwd: command.cwd,
      },
    }));

    if (resolution.behavior !== 'allow') {
      state.controller.enqueue(sseEvent('tool_result', {
        tool_use_id: command.toolId,
        content: resolution.message || 'Denied by user',
        is_error: true,
      }));
      state.controller.enqueue(sseEvent('text', '未执行成功。当前沙箱无法启动，且这次沙箱外重跑请求未获批准。'));
      return;
    }

    if (resolution.grantScope === 'session') {
      syntheticEscalationSessionApprovals.add(state.sessionId);
    }

    const rerun = await runCommandOutsideSandbox(command.command, command.cwd);
    state.controller.enqueue(sseEvent('tool_result', {
      tool_use_id: command.toolId,
      content: rerun.output || (rerun.exitCode === 0 ? 'Done' : `Exit code: ${rerun.exitCode}`),
      is_error: rerun.exitCode !== 0,
    }));

    if (rerun.exitCode === 0) {
      state.controller.enqueue(sseEvent('text', '已按批准结果在沙箱外重跑该命令，并执行成功。'));
    } else {
      state.controller.enqueue(sseEvent('text', `已按批准结果在沙箱外重跑该命令，但仍失败了。退出码: ${rerun.exitCode}`));
    }
  }

  private handleStderr(line: string): void {
    if (!isSandboxBootstrapFailure(line, '')) {
      return;
    }

    const commandFromLog = extractFailedCommand(line);
    const state = this.findStateForFallback(commandFromLog);
    if (!state || state.approvalRequested || state.syntheticFallbackTriggered || state.settled) {
      return;
    }

    const commandSnapshot = findCommandSnapshot(state, commandFromLog);
    if (!commandSnapshot) {
      return;
    }

    state.syntheticFallbackTriggered = true;
    state.pendingSyntheticTasks += 1;
    void this.handleSyntheticCommandFallback(state, {
      toolId: commandSnapshot.toolId,
      command: commandSnapshot.command,
      cwd: commandSnapshot.cwd,
      aggregatedOutput: line,
    }).finally(() => {
      state.pendingSyntheticTasks = Math.max(0, state.pendingSyntheticTasks - 1);
      state.syntheticFallbackCompleted = true;
      if (state.turnCompletionPending && state.pendingSyntheticTasks === 0) {
        this.completeTurn(state);
      }
    });
  }
}

function buildThreadConfig(options: CodexThreadOptions): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};

  if (options.skipGitRepoCheck) {
    config.skip_git_repo_check = true;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function shouldRetryWithSkipGitRepoCheck(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('not inside a trusted directory') ||
    (lower.includes('working directory') && lower.includes('git repository')) ||
    (lower.includes('skip-git-repo-check') && lower.includes('git'))
  );
}

function buildTurnSandboxPolicy(options: CodexThreadOptions): Record<string, unknown> | undefined {
  switch (options.sandboxMode) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };

    case 'read-only':
      return {
        type: 'readOnly',
        access: { type: 'fullAccess' },
        networkAccess: options.networkAccessEnabled === true,
      };

    case 'workspace-write': {
      const roots = uniqueAbsolutePaths([
        options.workingDirectory,
        ...(options.additionalDirectories ?? []),
      ]);
      return {
        type: 'workspaceWrite',
        writableRoots: roots,
        readOnlyAccess: { type: 'fullAccess' },
        networkAccess: options.networkAccessEnabled === true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    }

    default:
      return undefined;
  }
}

function uniqueAbsolutePaths(paths: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const candidate of paths) {
    if (!candidate) {
      continue;
    }
    const normalized = path.resolve(candidate);
    out.add(normalized);
  }
  return [...out];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function shouldBufferAgentText(state: ActiveTurnState): boolean {
  return state.syntheticFallbackTriggered || state.pendingApprovalCount > 0;
}

const syntheticEscalationSessionApprovals = new Set<string>();

function isSandboxBootstrapFailure(output: string, command: string): boolean {
  const text = `${output}\n${command}`.toLowerCase();
  return (
    text.includes('bwrap: loopback: failed rtm_newaddr: operation not permitted') ||
    text.includes('sandbox failed to start') ||
    text.includes('bubblewrap')
  );
}

function extractFailedCommand(line: string): string | undefined {
  const match = line.match(/failed for `([^`]+)`/);
  return match?.[1];
}

function findCommandSnapshot(
  state: ActiveTurnState,
  commandFromLog?: string,
): { toolId: string; command: string; cwd?: string } | undefined {
  const snapshots = [...state.itemSnapshots.values()].reverse();
  for (const snapshot of snapshots) {
    if (snapshot.type !== 'commandExecution') {
      continue;
    }
    const command = typeof snapshot.command === 'string' ? snapshot.command : undefined;
    if (!command) {
      continue;
    }
    if (commandFromLog && command !== commandFromLog) {
      continue;
    }
    return {
      toolId: typeof snapshot.id === 'string' ? snapshot.id : `tool-${Date.now()}`,
      command,
      cwd: typeof snapshot.cwd === 'string' ? snapshot.cwd : undefined,
    };
  }
  return undefined;
}

function findLatestCommandSnapshot(
  state: ActiveTurnState,
): { toolId: string; command: string; cwd?: string } | undefined {
  return findCommandSnapshot(state);
}

function isSandboxRetryReason(reason?: string): boolean {
  if (!reason) {
    return false;
  }
  const normalized = reason.toLowerCase();
  return normalized.includes('retry without sandbox')
    || normalized.includes('command failed')
    || normalized.includes('without sandbox');
}

async function runCommandOutsideSandbox(command: string, cwd?: string): Promise<{ exitCode: number; output: string }> {
  return await new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        output: `${stdout}${stderr}`.trim(),
      });
    });
    child.once('error', (error) => {
      resolve({
        exitCode: 1,
        output: String(error),
      });
    });
  });
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    lower.includes('thread not found') ||
    (lower.includes('resume') && lower.includes('session'))
  );
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}
