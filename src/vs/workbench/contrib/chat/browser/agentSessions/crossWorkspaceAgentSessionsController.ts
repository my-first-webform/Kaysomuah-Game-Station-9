/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ACTIVE_GROUP } from '../../../../services/editor/common/editorService.js';
import { ICrossWorkspaceSessionDetail, IChatService, ResponseModelState } from '../../common/chatService/chatService.js';
import { ChatSessionStatus, IChatSessionItem, IChatSessionItemController, IChatSessionsService } from '../../common/chatSessionsService.js';
import { LocalChatSessionUri } from '../../common/model/chatUri.js';
import { ChatViewPaneTarget, IChatWidgetService } from '../chat.js';
import { IAgentSession } from './agentSessionsModel.js';
import { ISessionOpenOptions, ISessionOpenerParticipant, sessionOpenerRegistry } from './agentSessionsOpener.js';

/**
 * The session type used for cross-workspace chat sessions.
 * These sessions originate from other workspaces on the same machine.
 */
const crossWorkspaceChatSessionType = 'cross-workspace';

export class CrossWorkspaceAgentSessionsController extends Disposable implements IChatSessionItemController, ISessionOpenerParticipant, IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.crossWorkspaceAgentSessionsController';

	readonly chatSessionType = crossWorkspaceChatSessionType;

	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	readonly onDidChangeChatSessionItems = this._onDidChangeChatSessionItems.event;

	constructor(
		@IChatService private readonly chatService: IChatService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.chatSessionsService.registerChatSessionItemController(this.chatSessionType, this));
		this._register(sessionOpenerRegistry.registerParticipant(this));
	}

	private _items: IChatSessionItem[] = [];
	get items(): readonly IChatSessionItem[] {
		return this._items;
	}

	async refresh(token: CancellationToken): Promise<void> {
		try {
			const crossWorkspaceEntries = await this.chatService.getCrossWorkspaceHistoryItems();
			this._items = crossWorkspaceEntries
				.map(entry => this.toChatSessionItem(entry))
				.sort((a, b) => (b.timing.lastRequestEnded ?? 0) - (a.timing.lastRequestEnded ?? 0));

			this.logService.trace(`[cross-workspace sessions] Loaded ${this._items.length} sessions from other workspaces`);
		} catch (error) {
			this.logService.error('[cross-workspace sessions] Error loading cross-workspace sessions', error);
			this._items = [];
		}
	}

	/**
	 * Handles opening a cross-workspace session. Instead of trying to load from
	 * local workspace storage (which would fail since the session lives in another
	 * workspace), this reads the session data from the source workspace's storage
	 * and loads it as an imported session in the current workspace.
	 *
	 * The loaded session is a local copy - the original session in the other
	 * workspace is never modified. Any messages sent by the user are appended
	 * to this local copy only.
	 */
	async handleOpenSession(accessor: ServicesAccessor, session: IAgentSession, openOptions?: ISessionOpenOptions): Promise<boolean> {
		if (!session.metadata?.crossWorkspace) {
			return false; // Not a cross-workspace session, let the default handler process it
		}

		const chatWidgetService = accessor.get(IChatWidgetService);
		const notificationService = accessor.get(INotificationService);

		const sessionId = LocalChatSessionUri.parseLocalSessionId(session.resource);
		const storageRoot = session.metadata.storageRoot as string | undefined;
		const workspaceName = session.metadata.workspaceName as string | undefined;

		if (!sessionId || !storageRoot) {
			this.logService.error('[cross-workspace sessions] Missing sessionId or storageRoot for cross-workspace session');
			return false; // Fall through to default handler
		}

		try {
			// Read the session data from the source workspace's storage
			const dataRef = await this.chatService.readCrossWorkspaceSession(sessionId, storageRoot);
			if (!dataRef) {
				notificationService.warn(localize(
					'crossWorkspace.sessionNotFound',
					"Could not load cross-workspace session. The source workspace storage may have been deleted."
				));
				return true; // Handled (with error), don't fall through
			}

			// Load the session data as an in-memory model in the current workspace.
			// loadSessionFromContent creates a new ChatModel from the serialized data,
			// effectively creating a local read-only copy of the cross-workspace session.
			const modelRef = this.chatService.loadSessionFromContent(dataRef.value);
			if (!modelRef) {
				notificationService.warn(localize(
					'crossWorkspace.loadFailed',
					"Failed to load cross-workspace session data."
				));
				return true;
			}

			try {
				// Mark as read in the tree view
				session.setRead(true);

				// Open the session in the chat widget
				const target = openOptions?.sideBySide ? ACTIVE_GROUP : ChatViewPaneTarget;
				await chatWidgetService.openSession(modelRef.object.sessionResource, target, {
					...openOptions?.editorOptions,
					revealIfOpened: true,
				});

				// Inform the user this is a cross-workspace view
				notificationService.info(localize(
					'crossWorkspace.readOnlyNotice',
					"Viewing session from workspace \"{0}\". Any messages you send will be saved to the current workspace only.",
					workspaceName ?? localize('crossWorkspace.unknownWorkspace', "Unknown")
				));
			} finally {
				// The widget holds its own reference to the model after openSession.
				// Release our reference so the model's lifecycle is managed by the widget.
				modelRef.dispose();
			}

			return true; // Successfully handled
		} catch (error) {
			this.logService.error('[cross-workspace sessions] Error opening cross-workspace session', error);
			notificationService.error(localize(
				'crossWorkspace.openError',
				"Failed to open cross-workspace session: {0}",
				error instanceof Error ? error.message : String(error)
			));
			return true; // Handled (with error)
		}
	}

	private toChatSessionItem(entry: ICrossWorkspaceSessionDetail): IChatSessionItem {
		const sessionResource = LocalChatSessionUri.forSession(entry.sessionId);

		return {
			resource: sessionResource,
			label: entry.title,
			description: localize('crossWorkspace.from', "From: {0}", entry.workspaceName),
			status: this.responseStateToStatus(entry.lastResponseState),
			iconPath: Codicon.globe,
			timing: entry.timing,
			metadata: {
				crossWorkspace: true,
				workspaceId: entry.workspaceId,
				workspaceName: entry.workspaceName,
				storageRoot: entry.storageRoot,
			},
		};
	}

	private responseStateToStatus(state: ResponseModelState): ChatSessionStatus {
		switch (state) {
			case ResponseModelState.Cancelled:
			case ResponseModelState.Complete:
				return ChatSessionStatus.Completed;
			case ResponseModelState.Failed:
				return ChatSessionStatus.Failed;
			case ResponseModelState.Pending:
				return ChatSessionStatus.InProgress;
			case ResponseModelState.NeedsInput:
				return ChatSessionStatus.NeedsInput;
		}
	}
}
