/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Maps SDK types (from the generated mirror) to VS Code interfaces (from common/).
 * This is the single absorption point for SDK type changes -- when the SDK bumps,
 * compile errors appear HERE, not in the browser layer.
 *
 * The browser never imports from this file or from the generated types. It only
 * sees the stable VS Code interfaces from `copilotSdkService.ts`.
 */

import type {
	SdkSessionEvent,
	SdkSessionEventType,
	SdkModelInfo,
	SdkSessionMetadata,
	SdkGetStatusResponse,
	SdkGetAuthStatusResponse,
	SdkSessionLifecycleEvent,
} from './generated/sdkTypes.generated.js';
import type {
	ICopilotSessionEvent,
	ICopilotModelInfo,
	ICopilotSessionMetadata,
	ICopilotStatusInfo,
	ICopilotAuthStatus,
	ICopilotSessionLifecycleEvent,
} from '../common/copilotSdkService.js';

/** Event types the VS Code common layer handles. Others are silently dropped. */
const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set<SdkSessionEventType>([
	'user.message',
	'assistant.message',
	'assistant.message_delta',
	'assistant.reasoning',
	'assistant.reasoning_delta',
	'assistant.turn_start',
	'assistant.turn_end',
	'assistant.usage',
	'tool.execution_start',
	'tool.execution_complete',
	'session.idle',
	'session.compaction_start',
	'session.compaction_complete',
	'session.usage_info',
]);

/**
 * Map an SDK `SessionEvent` to a VS Code `ICopilotSessionEvent`.
 * Returns `undefined` for event types the browser doesn't handle.
 */
export function mapSessionEvent(sessionId: string, sdkEvent: SdkSessionEvent): ICopilotSessionEvent | undefined {
	if (!HANDLED_EVENT_TYPES.has(sdkEvent.type)) {
		return undefined;
	}

	const base = {
		sessionId,
		id: sdkEvent.id,
		timestamp: sdkEvent.timestamp,
	};

	switch (sdkEvent.type) {
		case 'user.message':
			return { ...base, type: sdkEvent.type, data: { content: sdkEvent.data.content, transformedContent: sdkEvent.data.transformedContent } };

		case 'assistant.message':
			return { ...base, type: sdkEvent.type, data: { messageId: sdkEvent.data.messageId, content: sdkEvent.data.content, parentToolCallId: sdkEvent.data.parentToolCallId } };

		case 'assistant.message_delta':
			return { ...base, type: sdkEvent.type, data: { messageId: sdkEvent.data.messageId, deltaContent: sdkEvent.data.deltaContent, parentToolCallId: sdkEvent.data.parentToolCallId } };

		case 'assistant.reasoning':
			return { ...base, type: sdkEvent.type, data: { reasoningId: sdkEvent.data.reasoningId, content: sdkEvent.data.content } };

		case 'assistant.reasoning_delta':
			return { ...base, type: sdkEvent.type, data: { reasoningId: sdkEvent.data.reasoningId, deltaContent: sdkEvent.data.deltaContent } };

		case 'assistant.turn_start':
		case 'assistant.turn_end':
			return { ...base, type: sdkEvent.type, data: { turnId: sdkEvent.data.turnId } };

		case 'assistant.usage':
			return { ...base, type: sdkEvent.type, data: { model: sdkEvent.data.model, inputTokens: sdkEvent.data.inputTokens, outputTokens: sdkEvent.data.outputTokens, cacheReadTokens: sdkEvent.data.cacheReadTokens } };

		case 'tool.execution_start':
			return {
				...base, type: sdkEvent.type, data: {
					toolCallId: sdkEvent.data.toolCallId,
					toolName: sdkEvent.data.toolName,
					arguments: sdkEvent.data.arguments as Record<string, unknown> | undefined,
					mcpServerName: sdkEvent.data.mcpServerName,
					parentToolCallId: sdkEvent.data.parentToolCallId,
				}
			};

		case 'tool.execution_complete':
			return {
				...base, type: sdkEvent.type, data: {
					toolCallId: sdkEvent.data.toolCallId,
					success: sdkEvent.data.success,
					result: sdkEvent.data.result ? { content: sdkEvent.data.result.content } : undefined,
					error: sdkEvent.data.error ? { message: sdkEvent.data.error.message } : undefined,
					parentToolCallId: sdkEvent.data.parentToolCallId,
				}
			};

		case 'session.idle':
		case 'session.compaction_start':
			return { ...base, type: sdkEvent.type, data: {} };

		case 'session.compaction_complete':
			return { ...base, type: sdkEvent.type, data: { success: sdkEvent.data.success, preCompactionTokens: sdkEvent.data.preCompactionTokens, postCompactionTokens: sdkEvent.data.postCompactionTokens } };

		case 'session.usage_info':
			return { ...base, type: sdkEvent.type, data: { tokenLimit: sdkEvent.data.tokenLimit, currentTokens: sdkEvent.data.currentTokens, messagesLength: sdkEvent.data.messagesLength } };

		default:
			return undefined;
	}
}

/**
 * Map an SDK `ModelInfo` to a VS Code `ICopilotModelInfo`.
 */
export function mapModelInfo(sdk: SdkModelInfo): ICopilotModelInfo {
	return {
		id: sdk.id,
		name: sdk.name,
		capabilities: {
			supports: {
				vision: sdk.capabilities.supports.vision,
				reasoningEffort: sdk.capabilities.supports.reasoningEffort,
			},
			limits: {
				max_context_window_tokens: sdk.capabilities.limits.max_context_window_tokens,
			},
		},
		policy: sdk.policy ? { state: sdk.policy.state } : undefined,
		billing: sdk.billing ? { multiplier: sdk.billing.multiplier } : undefined,
		supportedReasoningEfforts: sdk.supportedReasoningEfforts,
		defaultReasoningEffort: sdk.defaultReasoningEffort,
	};
}

/**
 * The SDK's `listSessions()` returns objects with more fields than the typed
 * `SessionMetadata` interface declares (e.g., `context` with cwd/repository/branch).
 * This interface captures the runtime shape for type-safe mapping.
 */
export interface SdkSessionMetadataRuntime extends SdkSessionMetadata {
	readonly context?: {
		readonly cwd?: string;
		readonly repository?: string;
		readonly branch?: string;
	};
}

/**
 * Map an SDK session metadata object to a VS Code `ICopilotSessionMetadata`.
 * Converts `Date` objects to ISO strings for IPC serialization.
 */
export function mapSessionMetadata(sdk: SdkSessionMetadataRuntime): ICopilotSessionMetadata {
	return {
		sessionId: sdk.sessionId,
		summary: sdk.summary,
		startTime: sdk.startTime?.toISOString(),
		modifiedTime: sdk.modifiedTime?.toISOString(),
		isRemote: sdk.isRemote,
		workspacePath: sdk.context?.cwd,
		repository: sdk.context?.repository,
		branch: sdk.context?.branch,
	};
}

/**
 * Map an SDK `GetStatusResponse` to a VS Code `ICopilotStatusInfo`.
 */
export function mapStatusResponse(sdk: SdkGetStatusResponse): ICopilotStatusInfo {
	return {
		version: sdk.version,
		protocolVersion: sdk.protocolVersion,
	};
}

/**
 * Map an SDK `GetAuthStatusResponse` to a VS Code `ICopilotAuthStatus`.
 */
export function mapAuthStatusResponse(sdk: SdkGetAuthStatusResponse): ICopilotAuthStatus {
	return {
		isAuthenticated: sdk.isAuthenticated,
		authType: sdk.authType,
		host: sdk.host,
		login: sdk.login,
		statusMessage: sdk.statusMessage,
	};
}

/**
 * Map an SDK `SessionLifecycleEvent` to a VS Code `ICopilotSessionLifecycleEvent`.
 */
export function mapSessionLifecycleEvent(sdk: SdkSessionLifecycleEvent): ICopilotSessionLifecycleEvent | undefined {
	// Only forward the lifecycle types VS Code handles
	const type = sdk.type;
	if (type === 'session.created' || type === 'session.deleted' || type === 'session.updated') {
		return { type, sessionId: sdk.sessionId };
	}
	return undefined;
}
