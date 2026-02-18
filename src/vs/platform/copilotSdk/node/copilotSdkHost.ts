/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { Server as UtilityProcessServer } from '../../../base/parts/ipc/node/ipc.mp.js';
import {
	CopilotSdkChannel,
	type ICopilotAssistantMessage,
	type ICopilotAuthStatus,
	type ICopilotModelInfo,
	type ICopilotResumeSessionConfig,
	type ICopilotSdkService,
	type ICopilotSendOptions,
	type ICopilotSessionConfig,
	type ICopilotSessionEvent,
	type ICopilotSessionLifecycleEvent,
	type ICopilotSessionMetadata,
	type ICopilotStatusInfo,
} from '../common/copilotSdkService.js';
import type { SdkSessionEvent, SdkModelInfo, SdkGetStatusResponse, SdkGetAuthStatusResponse } from './generated/sdkTypes.generated.js';
import { mapSessionEvent, mapModelInfo, mapSessionMetadata, mapStatusResponse, mapAuthStatusResponse, mapSessionLifecycleEvent, type SdkSessionMetadataRuntime } from './copilotSdkMapper.js';

/**
 * The Copilot SDK host runs in a utility process and wraps the
 * `@github/copilot-sdk` `CopilotClient`. It implements `ICopilotSdkService`
 * so that `ProxyChannel.fromService()` can auto-generate an IPC channel
 * from it -- all methods become RPC calls and all `onFoo` events are
 * forwarded over the channel automatically.
 */
/**
 * Use `import()` for the SDK at runtime; these types are only for
 * typing the local variables that hold SDK objects.
 */
type SdkClient = import('@github/copilot-sdk').CopilotClient;
type SdkSession = import('@github/copilot-sdk').CopilotSession;

class CopilotSdkHost extends Disposable implements ICopilotSdkService {
	declare readonly _serviceBrand: undefined;

	private _client: SdkClient | undefined;
	private readonly _sessions = new Map<string, SdkSession>();
	private _githubToken: string | undefined;
	private _originalStderrWrite: typeof process.stderr.write | undefined;
	private readonly _sessionDisposables = new Map<string, DisposableStore>();

	// --- Events ---
	private readonly _onSessionEvent = this._register(new Emitter<ICopilotSessionEvent>());
	readonly onSessionEvent: Event<ICopilotSessionEvent> = this._onSessionEvent.event;

	private readonly _onSessionLifecycle = this._register(new Emitter<ICopilotSessionLifecycleEvent>());
	readonly onSessionLifecycle: Event<ICopilotSessionLifecycleEvent> = this._onSessionLifecycle.event;

	private readonly _onProcessOutput = this._register(new Emitter<{ stream: 'stdout' | 'stderr'; data: string }>());
	readonly onProcessOutput: Event<{ stream: 'stdout' | 'stderr'; data: string }> = this._onProcessOutput.event;

	// --- Lifecycle ---

	async start(): Promise<void> {
		if (this._client) {
			this._onProcessOutput.fire({ stream: 'stderr', data: '[SDK] start() called but client already exists' });
			return;
		}

		this._onProcessOutput.fire({ stream: 'stderr', data: '[SDK] start() called, importing @github/copilot-sdk...' });

		let sdk;
		try {
			sdk = await import('@github/copilot-sdk');
			this._onProcessOutput.fire({ stream: 'stderr', data: '[SDK] @github/copilot-sdk imported successfully' });
		} catch (importErr) {
			const msg = importErr instanceof Error ? `${importErr.message}\n${importErr.stack}` : String(importErr);
			this._onProcessOutput.fire({ stream: 'stderr', data: `[SDK] FAILED to import @github/copilot-sdk: ${msg}` });
			process.stderr.write(`[SDK-FATAL] Cannot import @github/copilot-sdk: ${msg}\n`);
			throw importErr;
		}

		// IMPORTANT: The CLI binary MUST come from the bundled
		// @github/copilot-{platform}-{arch} package. Do NOT use
		// PATH discovery, execFileSync, or any external binary.
		// This must work in a signed, ASAR-packed release build.
		let cliPath: string | undefined;
		try {
			const { fileURLToPath } = await import('node:url');
			const pkgName = `@github/copilot-${process.platform}-${process.arch}`;
			this._onProcessOutput.fire({ stream: 'stderr', data: `[SDK] Resolving bundled CLI: ${pkgName}` });
			cliPath = fileURLToPath(import.meta.resolve(pkgName));
			// In release builds, the ASAR packer puts native executables in
			// node_modules.asar.unpacked/ so they can be spawned as processes.
			cliPath = cliPath.replace(/\bnode_modules\.asar\b/, 'node_modules.asar.unpacked');
			this._onProcessOutput.fire({ stream: 'stderr', data: `[SDK] Resolved bundled CLI: ${cliPath}` });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this._onProcessOutput.fire({ stream: 'stderr', data: `[SDK] FAILED to resolve bundled CLI: ${msg}` });
			process.stderr.write(`[SDK-FATAL] Cannot resolve bundled CLI: ${msg}\n`);
			throw new Error(`Cannot resolve bundled CLI: ${msg}`);
		}

		// Build a clean environment for the CLI. Strip vars that interfere.
		const cliEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value === undefined) {
				continue;
			}
			// Skip VS Code internal vars
			if (key.startsWith('VSCODE_')) {
				continue;
			}
			// Skip Electron vars that would confuse the CLI's own Electron
			if (key.startsWith('ELECTRON_')) {
				continue;
			}
			cliEnv[key] = value;
		}
		// Tell the CLI to use stdio mode (no pty needed - avoids code signing issues)
		cliEnv['COPILOT_AGENT_DISABLE_PTY'] = '1';
		// Ensure the CLI doesn't inherit the Electron app's hardened runtime constraints
		delete cliEnv['__CFBundleIdentifier'];
		delete cliEnv['APP_SANDBOX_CONTAINER_ID'];

		this._onProcessOutput.fire({ stream: 'stderr', data: `[SDK] Creating CopilotClient with cliPath=${cliPath ?? 'default'}, useStdio=true` });

		try {
			this._client = new sdk.CopilotClient({
				autoStart: true,
				autoRestart: true,
				useStdio: true,
				...(cliPath ? { cliPath } : {}),
				env: cliEnv,
				...(this._githubToken ? { githubToken: this._githubToken } : {}),
			});
			this._onProcessOutput.fire({ stream: 'stderr', data: '[SDK] CopilotClient created, calling start()...' });
		} catch (createErr) {
			const msg = createErr instanceof Error ? `${createErr.message}\n${createErr.stack}` : String(createErr);
			this._onProcessOutput.fire({ stream: 'stderr', data: `[SDK] FAILED to create CopilotClient: ${msg}` });
			process.stderr.write(`[SDK-FATAL] Cannot create CopilotClient: ${msg}\n`);
			throw createErr;
		}

		try {
			// Add a timeout - if start() hangs for more than 30s, something is wrong
			const startPromise = this._client.start();
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('SDK client.start() timed out after 30 seconds')), 30000)
			);
			await Promise.race([startPromise, timeoutPromise]);
			this._onProcessOutput.fire({ stream: 'stderr', data: `[SDK] Client started, state=${this._client.getState()}` });
		} catch (startErr) {
			const msg = startErr instanceof Error ? `${startErr.message}\n${startErr.stack}` : String(startErr);
			this._onProcessOutput.fire({ stream: 'stderr', data: `[SDK] FAILED to start client: ${msg}` });
			process.stderr.write(`[SDK-FATAL] Cannot start client: ${msg}\n`);
			this._client = undefined;
			throw startErr;
		}

		// Intercept stderr to capture CLI subprocess output and forward as events.
		// The SDK writes CLI stderr lines to process.stderr via its internal
		// `[CLI subprocess]` handler.
		if (!this._originalStderrWrite) {
			this._originalStderrWrite = process.stderr.write.bind(process.stderr);
		}
		process.stderr.write = (chunk: string | Uint8Array, ...args: unknown[]): boolean => {
			const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
			if (text.trim()) {
				this._onProcessOutput.fire({ stream: 'stderr', data: text.trimEnd() });
			}
			return this._originalStderrWrite!(chunk, ...args as [BufferEncoding?, ((err?: Error | null) => void)?]);
		};

		// Forward client lifecycle events
		for (const eventType of ['session.created', 'session.deleted', 'session.updated'] as const) {
			this._client.on(eventType, (event) => {
				const mapped = mapSessionLifecycleEvent(event);
				if (mapped) {
					this._onSessionLifecycle.fire(mapped);
				}
			});
		}
	}

	async stop(): Promise<void> {
		if (!this._client) {
			return;
		}

		for (const [id, session] of this._sessions) {
			try { await session.destroy(); } catch (e) {
				this._onProcessOutput.fire({ stream: 'stderr', data: `[SDK] Failed to destroy session ${id}: ${e}` });
			}
		}
		this._sessions.clear();
		for (const store of this._sessionDisposables.values()) {
			store.dispose();
		}
		this._sessionDisposables.clear();

		await this._client.stop();
		this._client = undefined;
		if (this._originalStderrWrite) {
			process.stderr.write = this._originalStderrWrite;
			this._originalStderrWrite = undefined;
		}
	}

	// --- Sessions ---

	async createSession(config: ICopilotSessionConfig): Promise<string> {
		const client = await this._ensureClient();
		this._onProcessOutput.fire({ stream: 'stderr', data: `[SDK] createSession called, client state: ${client.getState()}` });
		const session = await client.createSession({
			model: config.model,
			reasoningEffort: config.reasoningEffort,
			streaming: config.streaming ?? true,
			systemMessage: config.systemMessage,
			workingDirectory: config.workingDirectory,
		});
		this._onProcessOutput.fire({ stream: 'stderr', data: `[SDK] session created: ${session.sessionId}, client state: ${client.getState()}` });

		this._sessions.set(session.sessionId, session);
		this._attachSessionEvents(session);

		return session.sessionId;
	}

	async resumeSession(sessionId: string, config?: ICopilotResumeSessionConfig): Promise<void> {
		const client = await this._ensureClient();
		const session = await client.resumeSession(sessionId, {
			streaming: config?.streaming ?? true,
		});

		this._sessions.set(session.sessionId, session);
		this._attachSessionEvents(session);
	}

	async destroySession(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (session) {
			await session.destroy();
			this._sessions.delete(sessionId);
			this._sessionDisposables.get(sessionId)?.dispose();
			this._sessionDisposables.delete(sessionId);
		}
	}

	async listSessions(): Promise<ICopilotSessionMetadata[]> {
		const client = await this._ensureClient();
		const sessions = await client.listSessions();
		return sessions.map(s => mapSessionMetadata(s as SdkSessionMetadataRuntime));
	}

	async deleteSession(sessionId: string): Promise<void> {
		const client = await this._ensureClient();
		this._sessions.delete(sessionId);
		this._sessionDisposables.get(sessionId)?.dispose();
		this._sessionDisposables.delete(sessionId);
		await client.deleteSession(sessionId);
	}

	// --- Messaging ---

	async send(sessionId: string, prompt: string, options?: ICopilotSendOptions): Promise<string> {
		const session = this._getSession(sessionId);
		const result = await session.send({
			prompt,
			attachments: options?.attachments?.map(a => ({ type: a.type as 'file', path: a.path, displayName: a.displayName })),
			mode: options?.mode,
		});
		return result;
	}

	async sendAndWait(sessionId: string, prompt: string, options?: ICopilotSendOptions): Promise<ICopilotAssistantMessage | undefined> {
		const session = this._getSession(sessionId);
		const result = await session.sendAndWait({
			prompt,
			attachments: options?.attachments?.map(a => ({ type: a.type as 'file', path: a.path, displayName: a.displayName })),
			mode: options?.mode,
		});
		if (!result) {
			return undefined;
		}
		return { content: result.data.content };
	}

	async abort(sessionId: string): Promise<void> {
		const session = this._getSession(sessionId);
		await session.abort();
	}

	async getMessages(sessionId: string): Promise<ICopilotSessionEvent[]> {
		const session = this._getSession(sessionId);
		const events = await session.getMessages();
		const result: ICopilotSessionEvent[] = [];
		for (const e of events) {
			const mapped = mapSessionEvent(sessionId, e as SdkSessionEvent);
			if (mapped) {
				result.push(mapped);
			}
		}
		return result;
	}

	// --- Models ---

	async listModels(): Promise<ICopilotModelInfo[]> {
		const client = await this._ensureClient();
		const models = await client.listModels();
		return models.map(m => mapModelInfo(m as SdkModelInfo));
	}

	async getStatus(): Promise<ICopilotStatusInfo> {
		const client = await this._ensureClient();
		try {
			const status = await client.getStatus();
			return mapStatusResponse(status as SdkGetStatusResponse);
		} catch {
			// CLI may not support this method yet
			return { version: 'unknown', protocolVersion: 0 };
		}
	}

	async getAuthStatus(): Promise<ICopilotAuthStatus> {
		const client = await this._ensureClient();
		try {
			const auth = await client.getAuthStatus();
			return mapAuthStatusResponse(auth as SdkGetAuthStatusResponse);
		} catch {
			// CLI may not support this method yet
			return { isAuthenticated: false, statusMessage: 'Auth status not available (CLI too old)' };
		}
	}

	async ping(message?: string): Promise<string> {
		const client = await this._ensureClient();
		try {
			const result = await client.ping(message ?? 'ping');
			return JSON.stringify(result);
		} catch {
			return 'pong (fallback - CLI does not support ping)';
		}
	}

	// --- Authentication ---

	async setGitHubToken(token: string): Promise<void> {
		this._githubToken = token;
	}

	// --- Private helpers ---

	private async _ensureClient(): Promise<SdkClient> {
		if (!this._client) {
			await this.start();
		}
		return this._client!;
	}

	private _getSession(sessionId: string): SdkSession {
		const session = this._sessions.get(sessionId);
		if (!session) {
			throw new Error(`No active session with ID: ${sessionId}`);
		}
		return session;
	}

	private _attachSessionEvents(session: SdkSession): void {
		const sessionId = session.sessionId;
		const store = new DisposableStore();
		const listener = session.on((event) => {
			const mapped = mapSessionEvent(sessionId, event as SdkSessionEvent);
			if (mapped) {
				this._onSessionEvent.fire(mapped);
			}
		});
		store.add(typeof listener === 'function' ? toDisposable(listener) : listener);
		this._sessionDisposables.set(sessionId, store);
	}
}

// --- Entry point ---
// Only start when running as an Electron utility process (not when imported by the main process).
import { isUtilityProcess } from '../../../base/parts/sandbox/node/electronTypes.js';
if (isUtilityProcess(process)) {
	process.stderr.write('[CopilotSdkHost] Utility process entry point reached\n');
	const disposables = new DisposableStore();
	const host = new CopilotSdkHost();
	disposables.add(host);
	const channel = ProxyChannel.fromService(host, disposables);
	const server = new UtilityProcessServer();
	server.registerChannel(CopilotSdkChannel, channel);
	process.stderr.write(`[CopilotSdkHost] Channel '${CopilotSdkChannel}' registered on server\n`);

	process.once('exit', () => {
		host.stop().catch(() => { /* best-effort cleanup */ });
		disposables.dispose();
	});
}
