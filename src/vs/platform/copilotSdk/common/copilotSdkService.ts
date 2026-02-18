/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';

// #region Service Identifiers

export const ICopilotSdkService = createDecorator<ICopilotSdkService>('copilotSdkService');

/**
 * Main process service identifier. The main process implementation manages
 * the utility process lifecycle and proxies the channel.
 */
export const ICopilotSdkMainService = createDecorator<ICopilotSdkMainService>('copilotSdkMainService');

/**
 * IPC channel name used to register the Copilot SDK service.
 * Defined in the common layer so both main and renderer can reference it
 * without importing the utility process host module.
 */
export const CopilotSdkChannel = 'copilotSdk';

// #endregion

// #region Session Types

export interface ICopilotSessionConfig {
	readonly model?: string;
	readonly reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
	readonly streaming?: boolean;
	readonly systemMessage?: { readonly content: string; readonly mode?: 'append' | 'replace' };
	readonly workingDirectory?: string;
}

export interface ICopilotResumeSessionConfig {
	readonly streaming?: boolean;
}

export interface ICopilotSendOptions {
	readonly attachments?: readonly ICopilotAttachment[];
	readonly mode?: 'enqueue' | 'immediate';
}

export interface ICopilotAttachment {
	readonly type: 'file';
	readonly path: string;
	readonly displayName?: string;
}

// #endregion

// #region Session Metadata

export interface ICopilotSessionMetadata {
	readonly sessionId: string;
	readonly summary?: string;
	readonly startTime?: string;
	readonly modifiedTime?: string;
	readonly isRemote?: boolean;
	readonly workspacePath?: string;
	readonly repository?: string;
	readonly branch?: string;
}

// #endregion

// #region Events

/**
 * Common base fields for all session events crossing the IPC boundary.
 * These are VS Code's own types -- deliberately curated from the SDK.
 */
export interface ICopilotSessionEventBase {
	readonly sessionId: string;
	readonly id: string;
	readonly timestamp: string;
}

/**
 * Discriminated union of session event types the browser layer consumes.
 * Each variant has a `type` discriminant and typed `data` payload.
 *
 * This is the stable VS Code contract -- the mapper in the node layer
 * converts SDK events into these types. New event types are added here
 * as the browser needs them.
 */
export type ICopilotSessionEvent =
	| ICopilotUserMessageEvent
	| ICopilotAssistantMessageEvent
	| ICopilotAssistantDeltaEvent
	| ICopilotReasoningEvent
	| ICopilotReasoningDeltaEvent
	| ICopilotTurnStartEvent
	| ICopilotTurnEndEvent
	| ICopilotUsageEvent
	| ICopilotToolStartEvent
	| ICopilotToolCompleteEvent
	| ICopilotSessionIdleEvent
	| ICopilotCompactionStartEvent
	| ICopilotCompactionCompleteEvent
	| ICopilotUsageInfoEvent;

export type CopilotSessionEventType = ICopilotSessionEvent['type'];

// --- Per-event interfaces ---
// Each includes base fields (sessionId, id, timestamp) for discriminated union narrowing.

export interface ICopilotUserMessageEvent extends ICopilotSessionEventBase {
	readonly type: 'user.message';
	readonly data: {
		readonly content: string;
		readonly transformedContent?: string;
	};
}

export interface ICopilotAssistantMessageEvent extends ICopilotSessionEventBase {
	readonly type: 'assistant.message';
	readonly data: {
		readonly messageId: string;
		readonly content: string;
		readonly parentToolCallId?: string;
	};
}

export interface ICopilotAssistantDeltaEvent extends ICopilotSessionEventBase {
	readonly type: 'assistant.message_delta';
	readonly data: {
		readonly messageId: string;
		readonly deltaContent: string;
		readonly parentToolCallId?: string;
	};
}

export interface ICopilotReasoningEvent extends ICopilotSessionEventBase {
	readonly type: 'assistant.reasoning';
	readonly data: {
		readonly reasoningId: string;
		readonly content: string;
	};
}

export interface ICopilotReasoningDeltaEvent extends ICopilotSessionEventBase {
	readonly type: 'assistant.reasoning_delta';
	readonly data: {
		readonly reasoningId: string;
		readonly deltaContent: string;
	};
}

export interface ICopilotTurnStartEvent extends ICopilotSessionEventBase {
	readonly type: 'assistant.turn_start';
	readonly data: {
		readonly turnId: string;
	};
}

export interface ICopilotTurnEndEvent extends ICopilotSessionEventBase {
	readonly type: 'assistant.turn_end';
	readonly data: {
		readonly turnId: string;
	};
}

export interface ICopilotUsageEvent extends ICopilotSessionEventBase {
	readonly type: 'assistant.usage';
	readonly data: {
		readonly model: string;
		readonly inputTokens?: number;
		readonly outputTokens?: number;
		readonly cacheReadTokens?: number;
	};
}

export interface ICopilotToolStartEvent extends ICopilotSessionEventBase {
	readonly type: 'tool.execution_start';
	readonly data: {
		readonly toolCallId: string;
		readonly toolName: string;
		readonly arguments?: Record<string, unknown>;
		readonly mcpServerName?: string;
		readonly parentToolCallId?: string;
	};
}

export interface ICopilotToolCompleteEvent extends ICopilotSessionEventBase {
	readonly type: 'tool.execution_complete';
	readonly data: {
		readonly toolCallId: string;
		readonly success: boolean;
		readonly result?: { readonly content: string };
		readonly error?: { readonly message: string };
		readonly parentToolCallId?: string;
	};
}

export interface ICopilotSessionIdleEvent extends ICopilotSessionEventBase {
	readonly type: 'session.idle';
	readonly data: Record<string, never>;
}

export interface ICopilotCompactionStartEvent extends ICopilotSessionEventBase {
	readonly type: 'session.compaction_start';
	readonly data: Record<string, never>;
}

export interface ICopilotCompactionCompleteEvent extends ICopilotSessionEventBase {
	readonly type: 'session.compaction_complete';
	readonly data: {
		readonly success: boolean;
		readonly preCompactionTokens?: number;
		readonly postCompactionTokens?: number;
	};
}

export interface ICopilotUsageInfoEvent extends ICopilotSessionEventBase {
	readonly type: 'session.usage_info';
	readonly data: {
		readonly tokenLimit: number;
		readonly currentTokens: number;
		readonly messagesLength: number;
	};
}

/**
 * Session lifecycle events fired by the SDK client (not per-session).
 */
export type CopilotSessionLifecycleType =
	| 'session.created'
	| 'session.deleted'
	| 'session.updated';

export interface ICopilotSessionLifecycleEvent {
	readonly type: CopilotSessionLifecycleType;
	readonly sessionId: string;
}

// #endregion

// #region Model Info

export interface ICopilotModelInfo {
	readonly id: string;
	readonly name?: string;
	readonly capabilities?: {
		readonly supports?: { readonly vision?: boolean; readonly reasoningEffort?: boolean };
		readonly limits?: { readonly max_context_window_tokens?: number };
	};
	readonly policy?: { readonly state?: string };
	readonly billing?: { readonly multiplier?: number };
	readonly supportedReasoningEfforts?: string[];
	readonly defaultReasoningEffort?: string;
}

export interface ICopilotStatusInfo {
	readonly version: string;
	readonly protocolVersion: number;
}

export interface ICopilotAuthStatus {
	readonly isAuthenticated: boolean;
	readonly authType?: string;
	readonly host?: string;
	readonly login?: string;
	readonly statusMessage?: string;
}

// #endregion

// #region Assistant Message

export interface ICopilotAssistantMessage {
	readonly content: string;
}

export interface ICopilotProcessOutput {
	readonly stream: 'stdout' | 'stderr';
	readonly data: string;
}

// #endregion

// #region Service Interface

export interface ICopilotSdkService {
	readonly _serviceBrand: undefined;

	// --- Lifecycle ---

	/**
	 * Start the SDK client. Spawns the Copilot CLI if not already running.
	 * Called automatically on first use if the utility process is alive.
	 */
	start(): Promise<void>;

	/**
	 * Stop the SDK client and the underlying CLI process.
	 */
	stop(): Promise<void>;

	// --- Sessions ---

	/** Create a new session. Returns the session ID. */
	createSession(config: ICopilotSessionConfig): Promise<string>;

	/** Resume an existing session by ID. */
	resumeSession(sessionId: string, config?: ICopilotResumeSessionConfig): Promise<void>;

	/** Destroy a session (free resources, but don't delete from disk). */
	destroySession(sessionId: string): Promise<void>;

	/** List all available sessions. */
	listSessions(): Promise<ICopilotSessionMetadata[]>;

	/** Delete a session and its data from disk. */
	deleteSession(sessionId: string): Promise<void>;

	// --- Messaging ---

	/** Send a message to a session. Returns the message ID. */
	send(sessionId: string, prompt: string, options?: ICopilotSendOptions): Promise<string>;

	/** Send a message and wait until the session is idle. */
	sendAndWait(sessionId: string, prompt: string, options?: ICopilotSendOptions): Promise<ICopilotAssistantMessage | undefined>;

	/** Abort the active response in a session. */
	abort(sessionId: string): Promise<void>;

	/** Get all events/messages from a session. */
	getMessages(sessionId: string): Promise<ICopilotSessionEvent[]>;

	// --- Events ---

	/**
	 * Fires for all session events (streaming deltas, tool calls, idle, etc.).
	 * Multiplexed by sessionId -- consumers filter by the session they care about.
	 */
	readonly onSessionEvent: Event<ICopilotSessionEvent>;

	/**
	 * Fires for session lifecycle changes (created, deleted, updated).
	 */
	readonly onSessionLifecycle: Event<ICopilotSessionLifecycleEvent>;

	/**
	 * Fires for raw CLI process output (stdout/stderr from the utility process).
	 * Used for debugging -- shows the Copilot CLI's raw output.
	 */
	readonly onProcessOutput: Event<ICopilotProcessOutput>;

	// --- Models ---

	/** List available models. */
	listModels(): Promise<ICopilotModelInfo[]>;

	/** Get CLI status (version, protocol). */
	getStatus(): Promise<ICopilotStatusInfo>;

	/** Get authentication status. */
	getAuthStatus(): Promise<ICopilotAuthStatus>;

	/** Ping the CLI to check connectivity. */
	ping(message?: string): Promise<string>;

	// --- Authentication ---

	/** Set the GitHub token used by the SDK for authentication. */
	setGitHubToken(token: string): Promise<void>;
}

// #endregion

// #region Main Process Service Interface

/**
 * Main process service that manages the Copilot SDK utility process.
 * Registered as a DI service in the main process and exposed via
 * `ProxyChannel.fromService()` for the renderer to consume.
 */
export interface ICopilotSdkMainService {
	readonly _serviceBrand: undefined;

	/**
	 * Get the IServerChannel for registering on the Electron IPC server.
	 * The channel lazily spawns the utility process on first use.
	 */
	getServerChannel(): IServerChannel<string>;
}

// #endregion
