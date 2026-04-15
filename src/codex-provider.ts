/**
 * Codex Provider — LLMProvider implementation backed by @openai/codex-sdk.
 *
 * Maps Codex SDK thread events to the SSE stream format consumed by
 * the bridge conversation engine, making Codex a drop-in alternative
 * to the Claude Code SDK backend.
 *
 * Requires `@openai/codex-sdk` to be installed (optionalDependency).
 * The provider lazily imports the SDK at first use and throws a clear
 * error if it is not available.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';
import { CodexAppServerBridge, type CodexThreadOptions } from './codex-app-server.js';
import { sseEvent } from './sse-utils.js';

/** MIME → file extension for temp image files. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// All SDK types kept as `any` because @openai/codex-sdk is optional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreadInstance = any;

/**
 * Map bridge permission modes to Codex approval policies.
 * - 'acceptEdits' (code mode) → 'on-failure' (auto-approve most things)
 * - 'plan' → 'on-request' (ask before executing)
 * - 'default' (ask mode) → 'on-request'
 */
function toApprovalPolicy(permissionMode?: string): string {
  switch (permissionMode) {
    case 'acceptEdits': return 'on-failure';
    case 'plan': return 'on-request';
    case 'default': return 'on-request';
    default: return 'on-request';
  }
}

/** Whether to forward bridge model to Codex CLI. Default: false (use Codex current/default model). */
function shouldPassModelToCodex(): boolean {
  return process.env.CTI_CODEX_PASS_MODEL === 'true';
}

/** Allow Codex to run outside a trusted Git repository when explicitly enabled. */
function shouldSkipGitRepoCheck(): boolean {
  return process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK === 'true';
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    (lower.includes('resume') && lower.includes('session'))
  );
}

function shouldRetryWithSkipGitRepoCheck(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('not inside a trusted directory') ||
    (lower.includes('working directory') && lower.includes('git repository')) ||
    (lower.includes('skip-git-repo-check') && lower.includes('git'))
  );
}

export class CodexProvider implements LLMProvider {
  private sdk: CodexModule | null = null;
  private codex: CodexInstance | null = null;
  private appServer: CodexAppServerBridge | null = null;

  /** Maps session IDs to Codex thread IDs for resume. */
  private threadIds = new Map<string, string>();

  constructor(private pendingPerms: PendingPermissions) {}

  private getAppServerBridge(): CodexAppServerBridge {
    if (!this.appServer) {
      this.appServer = new CodexAppServerBridge(this.pendingPerms, this.threadIds);
    }
    return this.appServer;
  }

  /**
   * Lazily load the Codex SDK. Throws a clear error if not installed.
   */
  private async ensureSDK(): Promise<{ sdk: CodexModule; codex: CodexInstance }> {
    if (this.sdk && this.codex) {
      return { sdk: this.sdk, codex: this.codex };
    }

    try {
      this.sdk = await (Function('return import("@openai/codex-sdk")')() as Promise<CodexModule>);
    } catch {
      throw new Error(
        '[CodexProvider] @openai/codex-sdk is not installed. ' +
        'Install it with: npm install @openai/codex-sdk'
      );
    }

    // Resolve API key: CTI_CODEX_API_KEY > CODEX_API_KEY > OPENAI_API_KEY > (login auth)
    const apiKey = process.env.CTI_CODEX_API_KEY
      || process.env.CODEX_API_KEY
      || process.env.OPENAI_API_KEY
      || undefined;
    const baseUrl = process.env.CTI_CODEX_BASE_URL || undefined;

    const CodexClass = this.sdk.Codex;
    this.codex = new CodexClass({
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });

    return { sdk: this.sdk, codex: this.codex };
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const tempFiles: string[] = [];
          try {
            const { codex } = await self.ensureSDK();

            // Resolve or create thread
            const inMemoryThreadId = self.threadIds.get(params.sessionId);
            let savedThreadId = inMemoryThreadId || params.sdkSessionId || undefined;

            const passModel = shouldPassModelToCodex();
            let threadOptions = buildCodexThreadOptions({
              ...(passModel && params.model ? { model: params.model } : {}),
              ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
              ...(shouldSkipGitRepoCheck() ? { skipGitRepoCheck: true } : {}),
              ...(params.permissionMode ? { permissionMode: toLegacyPermissionMode(params.permissionMode) } : {}),
              ...(params.sandboxMode ? { sandboxMode: params.sandboxMode } : {}),
              ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
              ...(params.networkAccessEnabled !== undefined ? { networkAccessEnabled: params.networkAccessEnabled } : {}),
              ...(params.additionalDirectories ? { additionalDirectories: params.additionalDirectories } : {}),
            });

            // Build input: Codex SDK UserInput supports { type: "text" } and
            // { type: "local_image", path: string }. We write base64 data to
            // temp files so the SDK can read them as local images.
            const imageFiles = params.files?.filter(
              f => f.type.startsWith('image/')
            ) ?? [];

            let input: string | Array<Record<string, string>>;
            let appServerInput: Array<Record<string, unknown>>;
            if (imageFiles.length > 0) {
              const parts: Array<Record<string, string>> = [
                { type: 'text', text: params.prompt },
              ];
              const appParts: Array<Record<string, unknown>> = [
                { type: 'text', text: params.prompt, text_elements: [] },
              ];
              for (const file of imageFiles) {
                const ext = MIME_EXT[file.type] || '.png';
                const tmpPath = path.join(os.tmpdir(), `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
                fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
                tempFiles.push(tmpPath);
                parts.push({ type: 'local_image', path: tmpPath });
                appParts.push({ type: 'localImage', path: tmpPath });
              }
              input = parts;
              appServerInput = appParts;
            } else {
              input = params.prompt;
              appServerInput = [
                { type: 'text', text: params.prompt, text_elements: [] },
              ];
            }

            if (shouldUseCodexAppServer(threadOptions)) {
              while (true) {
                try {
                  await self.getAppServerBridge().streamChat(
                    params,
                    controller,
                    threadOptions,
                    appServerInput,
                  );
                  controller.close();
                  return;
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  if (!threadOptions.skipGitRepoCheck && shouldRetryWithSkipGitRepoCheck(message)) {
                    console.warn('[codex-provider] Working directory is not trusted, retrying with skipGitRepoCheck:', message);
                    threadOptions = { ...threadOptions, skipGitRepoCheck: true };
                    self.appServer?.close();
                    self.appServer = null;
                    continue;
                  }
                  throw error;
                }
              }
            }

            let retryFresh = false;

            while (true) {
              let thread: ThreadInstance;
              if (savedThreadId) {
                try {
                  thread = codex.resumeThread(savedThreadId, threadOptions);
                } catch {
                  thread = codex.startThread(threadOptions);
                }
              } else {
                thread = codex.startThread(threadOptions);
              }

              let sawAnyEvent = false;
              try {
                const { events } = await thread.runStreamed(input);

                for await (const event of events) {
                  sawAnyEvent = true;
                  if (params.abortController?.signal.aborted) {
                    break;
                  }

                  switch (event.type) {
                    case 'thread.started': {
                      const threadId = event.thread_id as string;
                      self.threadIds.set(params.sessionId, threadId);

                      controller.enqueue(sseEvent('status', {
                        session_id: threadId,
                      }));
                      break;
                    }

                    case 'item.completed': {
                      const item = event.item as Record<string, unknown>;
                      self.handleCompletedItem(controller, item);
                      break;
                    }

                    case 'turn.completed': {
                      const usage = event.usage as Record<string, unknown> | undefined;
                      const threadId = self.threadIds.get(params.sessionId);

                      controller.enqueue(sseEvent('result', {
                        usage: usage ? {
                          input_tokens: usage.input_tokens ?? 0,
                          output_tokens: usage.output_tokens ?? 0,
                          cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                        } : undefined,
                        ...(threadId ? { session_id: threadId } : {}),
                      }));
                      break;
                    }

                    case 'turn.failed': {
                      const error = (event as { message?: string }).message;
                      controller.enqueue(sseEvent('error', error || 'Turn failed'));
                      break;
                    }

                    case 'error': {
                      const error = (event as { message?: string }).message;
                      controller.enqueue(sseEvent('error', error || 'Thread error'));
                      break;
                    }

                    // item.started, item.updated, turn.started — no action needed
                  }
                }
                break;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (!sawAnyEvent && !threadOptions.skipGitRepoCheck && shouldRetryWithSkipGitRepoCheck(message)) {
                  console.warn('[codex-provider] Working directory is not trusted, retrying with skipGitRepoCheck:', message);
                  threadOptions = { ...threadOptions, skipGitRepoCheck: true };
                  continue;
                }
                if (savedThreadId && !retryFresh && !sawAnyEvent && shouldRetryFreshThread(message)) {
                  console.warn('[codex-provider] Resume failed, retrying with a fresh thread:', message);
                  savedThreadId = undefined;
                  retryFresh = true;
                  continue;
                }
                throw err;
              }
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[codex-provider] Error:', err instanceof Error ? err.stack || err.message : err);
            try {
              controller.enqueue(sseEvent('error', message));
              controller.close();
            } catch {
              // Controller already closed
            }
          } finally {
            // Clean up temp image files
            for (const tmp of tempFiles) {
              try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
          }
        })();
      },
    });
  }

  /**
   * Map a completed Codex item to SSE events.
   */
  private handleCompletedItem(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
  ): void {
    const itemType = item.type as string;

    switch (itemType) {
      case 'agent_message': {
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('text', text));
        }
        break;
      }

      case 'command_execution': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const command = item.command as string || '';
        const output = item.aggregated_output as string || '';
        const exitCode = item.exit_code as number | undefined;
        const isError = exitCode != null && exitCode !== 0;

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Bash',
          input: { command },
        }));

        const resultContent = output || (isError ? `Exit code: ${exitCode}` : 'Done');
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: resultContent,
          is_error: isError,
        }));
        break;
      }

      case 'file_change': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const changes = item.changes as Array<{ path: string; kind: string }> || [];
        const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n');

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Edit',
          input: { files: changes },
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: summary || 'File changes applied',
          is_error: false,
        }));
        break;
      }

      case 'mcp_tool_call': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const server = item.server as string || '';
        const tool = item.tool as string || '';
        const args = item.arguments as unknown;
        const result = item.result as { content?: unknown; structured_content?: unknown } | undefined;
        const error = item.error as { message?: string } | undefined;

        const resultContent = result?.content ?? result?.structured_content;
        const resultText = typeof resultContent === 'string' ? resultContent : (resultContent ? JSON.stringify(resultContent) : undefined);

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: `mcp__${server}__${tool}`,
          input: args,
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: error?.message || resultText || 'Done',
          is_error: !!error,
        }));
        break;
      }

      case 'reasoning': {
        // Reasoning is internal; emit as status
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('status', { reasoning: text }));
        }
        break;
      }
    }
  }
}

// ========== 权限配置解析函数 ==========

export function getCodexSandboxMode(): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined {
  const val = process.env.CTI_CODEX_SANDBOX_MODE;
  if (!val) return undefined;
  const valid = ['read-only', 'workspace-write', 'danger-full-access'];
  if (!valid.includes(val)) {
    console.warn(`[codex-to-im] Invalid CTI_CODEX_SANDBOX_MODE="${val}", ignoring. Valid: ${valid.join(', ')}`);
    return undefined;
  }
  return val as any;
}

export function getCodexApprovalPolicyOverride(): 'untrusted' | 'on-request' | 'on-failure' | 'never' | undefined {
  const val = process.env.CTI_CODEX_APPROVAL_POLICY;
  if (!val) return undefined;
  const valid = ['untrusted', 'on-request', 'on-failure', 'never'];
  if (!valid.includes(val)) {
    console.warn(`[codex-to-im] Invalid CTI_CODEX_APPROVAL_POLICY="${val}", ignoring. Valid: ${valid.join(', ')}`);
    return undefined;
  }
  return val as any;
}

export function getCodexNetworkAccessEnabled(): boolean | undefined {
  const val = process.env.CTI_CODEX_NETWORK_ACCESS;
  if (!val) return undefined;
  if (val !== 'true' && val !== 'false') {
    console.warn(`[codex-to-im] Invalid CTI_CODEX_NETWORK_ACCESS="${val}", ignoring. Use true/false.`);
    return undefined;
  }
  return val === 'true';
}

export function getCodexAdditionalDirectories(): string[] | undefined {
  const val = process.env.CTI_CODEX_ADDITIONAL_DIRECTORIES;
  if (!val) return undefined;
  const dirs = val.split(',').map(d => d.trim()).filter(d => d.length > 0);
  return dirs.filter(d => d.startsWith('/'));
}

export function buildCodexThreadOptions(params: {
  model?: string;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  permissionMode?: string;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-request' | 'on-failure' | 'never';
  networkAccessEnabled?: boolean;
  additionalDirectories?: string[];
}): CodexThreadOptions {
  const opts: CodexThreadOptions = {};

  // 基础配置
  if (params.model) opts.model = params.model;
  if (params.workingDirectory) opts.workingDirectory = params.workingDirectory;
  if (params.skipGitRepoCheck) opts.skipGitRepoCheck = true;

  // 权限配置
  if (params.sandboxMode) {
    opts.sandboxMode = params.sandboxMode;
  } else {
    const sandboxMode = getCodexSandboxMode();
    if (sandboxMode) opts.sandboxMode = sandboxMode;
  }

  const approvalPolicyOverride = getCodexApprovalPolicyOverride();
  if (params.approvalPolicy) {
    opts.approvalPolicy = params.approvalPolicy;
  } else if (approvalPolicyOverride) {
    opts.approvalPolicy = approvalPolicyOverride;
  } else if (params.permissionMode) {
    const approvalMap: Record<string, NonNullable<CodexThreadOptions['approvalPolicy']>> = {
      'trusted': 'never',
      'auto': 'on-failure',
      'bypass': 'never',
      'require-approval': 'on-request',
    };
    if (approvalMap[params.permissionMode]) {
      opts.approvalPolicy = approvalMap[params.permissionMode];
    }
  }

  if (params.networkAccessEnabled !== undefined) {
    opts.networkAccessEnabled = params.networkAccessEnabled;
  } else {
    const networkAccess = getCodexNetworkAccessEnabled();
    if (networkAccess !== undefined) opts.networkAccessEnabled = networkAccess;
  }

  if (params.additionalDirectories && params.additionalDirectories.length > 0) {
    opts.additionalDirectories = params.additionalDirectories;
  } else {
    const additionalDirs = getCodexAdditionalDirectories();
    if (additionalDirs && additionalDirs.length > 0) opts.additionalDirectories = additionalDirs;
  }

  return opts;
}

function toLegacyPermissionMode(permissionMode: string): string {
  switch (permissionMode) {
    case 'acceptEdits':
      return 'auto';
    case 'default':
    case 'plan':
      return 'require-approval';
    default:
      return permissionMode;
  }
}

function shouldUseCodexAppServer(threadOptions: CodexThreadOptions): boolean {
  return threadOptions.approvalPolicy === 'on-request' || threadOptions.approvalPolicy === 'untrusted';
}
