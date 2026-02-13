/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../../platform/notification/common/notification.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { CrossWorkspaceAgentSessionsController } from '../../../browser/agentSessions/crossWorkspaceAgentSessionsController.js';
import { IAgentSession } from '../../../browser/agentSessions/agentSessionsModel.js';
import { IChatWidgetService } from '../../../browser/chat.js';
import { ICrossWorkspaceSessionDetail, IChatService, ResponseModelState } from '../../../common/chatService/chatService.js';
import { ChatSessionStatus, IChatSessionsService } from '../../../common/chatSessionsService.js';
import { ISerializedChatData, ISerializedChatDataReference } from '../../../common/model/chatModel.js';
import { LocalChatSessionUri } from '../../../common/model/chatUri.js';
import { MockChatSessionsService } from '../../common/mockChatSessionsService.js';
import { Event } from '../../../../../../base/common/event.js';

// Minimal mock that implements only what CrossWorkspaceAgentSessionsController needs
class CrossWorkspaceMockChatService {
	chatModels = observableValue('chatModels', []);
	requestInProgressObs = observableValue('name', false);
	edits2Enabled = false;
	_serviceBrand: undefined;
	editingSessions = [];
	transferredSessionResource = undefined;
	readonly onDidSubmitRequest = Event.None;
	readonly onDidCreateModel = Event.None;
	readonly onDidPerformUserAction = Event.None;
	readonly onDidReceiveQuestionCarouselAnswer = Event.None;
	readonly onDidDisposeSession = Event.None;

	private _crossWorkspaceItems: ICrossWorkspaceSessionDetail[] = [];
	private _crossWorkspaceSessionData: Map<string, ISerializedChatDataReference> = new Map();
	private _loadSessionResult: { object: { sessionResource: URI }; dispose: () => void } | undefined;
	loadSessionFromContentCalled = false;
	readCrossWorkspaceSessionCalled = false;
	lastReadSessionId: string | undefined;
	lastReadStorageRoot: string | undefined;

	setCrossWorkspaceItems(items: ICrossWorkspaceSessionDetail[]): void {
		this._crossWorkspaceItems = items;
	}

	setCrossWorkspaceSessionData(sessionId: string, data: ISerializedChatDataReference): void {
		this._crossWorkspaceSessionData.set(sessionId, data);
	}

	setLoadSessionResult(result: { object: { sessionResource: URI }; dispose: () => void } | undefined): void {
		this._loadSessionResult = result;
	}

	async getCrossWorkspaceHistoryItems(): Promise<ICrossWorkspaceSessionDetail[]> {
		return this._crossWorkspaceItems;
	}

	async readCrossWorkspaceSession(sessionId: string, storageRoot: string): Promise<ISerializedChatDataReference | undefined> {
		this.readCrossWorkspaceSessionCalled = true;
		this.lastReadSessionId = sessionId;
		this.lastReadStorageRoot = storageRoot;
		return this._crossWorkspaceSessionData.get(sessionId);
	}

	loadSessionFromContent(_data: unknown): { object: { sessionResource: URI }; dispose: () => void } | undefined {
		this.loadSessionFromContentCalled = true;
		return this._loadSessionResult;
	}

	// Stub all other methods that IChatService requires
	setSaveModelsEnabled(): void { }
	isEnabled(): boolean { return true; }
	hasSessions(): boolean { return false; }
	getProviderInfos(): [] { return []; }
	startSession(): any { throw new Error('Not implemented'); }
	addSession(): void { }
	getSession(): undefined { return undefined; }
	getOrRestoreSession(): Promise<any> { throw new Error('Not implemented'); }
	getSessionTitle(): undefined { return undefined; }
	loadSessionForResource(): Promise<any> { throw new Error('Not implemented'); }
	getActiveSessionReference(): undefined { return undefined; }
	setTitle(): void { }
	appendProgress(): void { }
	processPendingRequests(): void { }
	sendRequest(): Promise<any> { throw new Error('Not implemented'); }
	resendRequest(): Promise<void> { throw new Error('Not implemented'); }
	adoptRequest(): Promise<void> { throw new Error('Not implemented'); }
	removeRequest(): Promise<void> { throw new Error('Not implemented'); }
	cancelCurrentRequestForSession(): void { }
	setYieldRequested(): void { }
	removePendingRequest(): void { }
	setPendingRequests(): void { }
	addCompleteRequest(): void { }
	async getLocalSessionHistory(): Promise<[]> { return []; }
	async clearAllHistoryEntries(): Promise<void> { }
	async removeHistoryEntry(): Promise<void> { }
	notifyUserAction(): void { }
	notifyQuestionCarouselAnswer(): void { }
	async transferChatSession(): Promise<void> { }
	setChatSessionTitle(): void { }
	isEditingLocation(): boolean { return false; }
	getChatStorageFolder(): URI { return URI.file('/tmp'); }
	logChatIndex(): void { }
	activateDefaultAgent(): Promise<void> { return Promise.resolve(); }
	getChatSessionFromInternalUri(): undefined { return undefined; }
	async getLiveSessionItems(): Promise<[]> { return []; }
	async getHistorySessionItems(): Promise<[]> { return []; }
	waitForModelDisposals(): Promise<void> { return Promise.resolve(); }
	getMetadataForSession(): Promise<undefined> { return Promise.resolve(undefined); }
}

// Minimal mock for IChatWidgetService
class MockChatWidgetService {
	_serviceBrand: undefined;
	openSessionCalled = false;
	lastOpenedResource: URI | undefined;

	async openSession(sessionResource: URI): Promise<undefined> {
		this.openSessionCalled = true;
		this.lastOpenedResource = sessionResource;
		return undefined;
	}

	// Stub other methods
	getWidgetByInputUri(): undefined { return undefined; }
	getWidgetByLocation(): undefined { return undefined; }
	getFocusedWidget(): undefined { return undefined; }
	getWidgetBySessionId(): undefined { return undefined; }
	getWidgetBySessionResource(): undefined { return undefined; }
	readonly lastFocusedWidget = undefined;
	getAllWidgets(): [] { return []; }
}

// Minimal mock for INotificationService that tracks calls
class MockNotificationService {
	_serviceBrand: undefined;
	infoCalled = false;
	warnCalled = false;
	errorCalled = false;
	lastInfoMessage: string | undefined;
	lastWarnMessage: string | undefined;
	lastErrorMessage: string | undefined;

	info(message: string): void {
		this.infoCalled = true;
		this.lastInfoMessage = message;
	}

	warn(message: string): void {
		this.warnCalled = true;
		this.lastWarnMessage = message;
	}

	error(message: string): void {
		this.errorCalled = true;
		this.lastErrorMessage = message;
	}

	prompt(): any { return { dispose() { } }; }
	status(): any { return { dispose() { } }; }
	notify(): any { return { dispose() { } }; }
	setFilter(): void { }
	getFilter(): Severity { return Severity.Ignore; }
	getFilters(): [] { return []; }
	readonly onDidAddNotification = Event.None;
	readonly onDidRemoveNotification = Event.None;
	readonly onDidChangeFilter = Event.None;
}

function createTestEntry(overrides?: Partial<ICrossWorkspaceSessionDetail>): ICrossWorkspaceSessionDetail {
	return {
		sessionId: overrides?.sessionId ?? 'session-1',
		title: overrides?.title ?? 'Test Chat',
		lastMessageDate: overrides?.lastMessageDate ?? Date.now(),
		timing: overrides?.timing ?? { created: Date.now(), lastRequestStarted: Date.now(), lastRequestEnded: Date.now() },
		lastResponseState: overrides?.lastResponseState ?? ResponseModelState.Complete,
		workspaceId: overrides?.workspaceId ?? 'other-workspace',
		workspaceName: overrides?.workspaceName ?? 'Other Project',
		storageRoot: overrides?.storageRoot ?? 'file:///test/other/chatSessions',
	};
}

suite('CrossWorkspaceAgentSessionsController', () => {
	const disposables = new DisposableStore();
	let mockChatService: CrossWorkspaceMockChatService;
	let mockChatSessionsService: MockChatSessionsService;
	let mockChatWidgetService: MockChatWidgetService;
	let mockNotificationService: MockNotificationService;
	let instantiationService: TestInstantiationService;

	setup(() => {
		mockChatService = new CrossWorkspaceMockChatService();
		mockChatSessionsService = new MockChatSessionsService();
		mockChatWidgetService = new MockChatWidgetService();
		mockNotificationService = new MockNotificationService();
		instantiationService = disposables.add(workbenchInstantiationService(undefined, disposables));
		instantiationService.stub(IChatService, mockChatService as unknown as IChatService);
		instantiationService.stub(IChatSessionsService, mockChatSessionsService);
		instantiationService.stub(IChatWidgetService, mockChatWidgetService as unknown as IChatWidgetService);
		instantiationService.stub(INotificationService, mockNotificationService as unknown as INotificationService);
		instantiationService.stub(ILogService, NullLogService);
	});

	teardown(() => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	function createController(): CrossWorkspaceAgentSessionsController {
		return disposables.add(instantiationService.createInstance(CrossWorkspaceAgentSessionsController));
	}

	// --- Registration & Identity ---

	test('should have correct session type "cross-workspace"', () => {
		const controller = createController();
		assert.strictEqual(controller.chatSessionType, 'cross-workspace');
	});

	test('should have correct static ID', () => {
		assert.strictEqual(CrossWorkspaceAgentSessionsController.ID, 'workbench.contrib.crossWorkspaceAgentSessionsController');
	});

	test('should register itself with chat sessions service', async () => {
		const controller = createController();

		const results = await mockChatSessionsService.getChatSessionItems(undefined, CancellationToken.None);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].chatSessionType, controller.chatSessionType);
	});

	// --- Refresh & Items Loading ---

	test('should provide empty items when no cross-workspace sessions exist', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([]);

		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items.length, 0);
	});

	test('should load cross-workspace items from chat service', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({ sessionId: 'cx-1', title: 'Chat from Project A' }),
			createTestEntry({ sessionId: 'cx-2', title: 'Chat from Project B' }),
		]);

		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items.length, 2);
	});

	test('should replace items on subsequent refresh calls', async () => {
		const controller = createController();

		// First refresh with 2 items
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({ sessionId: 'cx-1' }),
			createTestEntry({ sessionId: 'cx-2' }),
		]);
		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items.length, 2);

		// Second refresh with 1 item
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({ sessionId: 'cx-3' }),
		]);
		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items.length, 1);
		assert.strictEqual(controller.items[0].label, 'Test Chat');
	});

	// --- Item Conversion ---

	test('should set label from entry title', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({ title: 'My Custom Title' }),
		]);

		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items[0].label, 'My Custom Title');
	});

	test('should set description with workspace name', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({ workspaceName: 'My Awesome Project' }),
		]);

		await controller.refresh(CancellationToken.None);
		const description = controller.items[0].description;
		assert.ok(typeof description === 'string');
		assert.ok((description as string).includes('My Awesome Project'), `Description "${description}" should contain workspace name`);
	});

	test('should use Codicon.globe as icon', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([createTestEntry()]);

		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items[0].iconPath, Codicon.globe);
	});

	test('should carry cross-workspace metadata', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({
				workspaceId: 'ws-123',
				workspaceName: 'Test WS',
				storageRoot: 'file:///storage/ws-123/chatSessions',
			}),
		]);

		await controller.refresh(CancellationToken.None);
		const metadata = controller.items[0].metadata;
		assert.ok(metadata);
		assert.strictEqual(metadata!['crossWorkspace'], true);
		assert.strictEqual(metadata!['workspaceId'], 'ws-123');
		assert.strictEqual(metadata!['workspaceName'], 'Test WS');
		assert.strictEqual(metadata!['storageRoot'], 'file:///storage/ws-123/chatSessions');
	});

	test('should preserve timing from entry', async () => {
		const controller = createController();
		const timing = { created: 1700000000000, lastRequestStarted: 1700000001000, lastRequestEnded: 1700000002000 };
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({ timing }),
		]);

		await controller.refresh(CancellationToken.None);
		assert.deepStrictEqual(controller.items[0].timing, timing);
	});

	// --- Sorting ---

	test('should sort items by lastRequestEnded descending (newest first)', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({
				sessionId: 'old',
				title: 'Old Chat',
				timing: { created: 1000, lastRequestStarted: 1000, lastRequestEnded: 2000 },
			}),
			createTestEntry({
				sessionId: 'new',
				title: 'New Chat',
				timing: { created: 3000, lastRequestStarted: 3000, lastRequestEnded: 4000 },
			}),
			createTestEntry({
				sessionId: 'mid',
				title: 'Middle Chat',
				timing: { created: 2000, lastRequestStarted: 2000, lastRequestEnded: 3000 },
			}),
		]);

		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items[0].label, 'New Chat');
		assert.strictEqual(controller.items[1].label, 'Middle Chat');
		assert.strictEqual(controller.items[2].label, 'Old Chat');
	});

	test('should handle undefined lastRequestEnded in sorting', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({
				sessionId: 'has-end',
				title: 'Has End',
				timing: { created: 1000, lastRequestStarted: 1000, lastRequestEnded: 5000 },
			}),
			createTestEntry({
				sessionId: 'no-end',
				title: 'No End',
				timing: { created: 2000, lastRequestStarted: undefined, lastRequestEnded: undefined },
			}),
		]);

		await controller.refresh(CancellationToken.None);
		// Item with defined lastRequestEnded should come first
		assert.strictEqual(controller.items[0].label, 'Has End');
		assert.strictEqual(controller.items[1].label, 'No End');
	});

	// --- Response State to Status Mapping ---

	test('should map ResponseModelState.Complete to ChatSessionStatus.Completed', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({ lastResponseState: ResponseModelState.Complete }),
		]);

		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items[0].status, ChatSessionStatus.Completed);
	});

	test('should map ResponseModelState.Cancelled to ChatSessionStatus.Completed', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({ lastResponseState: ResponseModelState.Cancelled }),
		]);

		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items[0].status, ChatSessionStatus.Completed);
	});

	test('should map ResponseModelState.Failed to ChatSessionStatus.Failed', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({ lastResponseState: ResponseModelState.Failed }),
		]);

		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items[0].status, ChatSessionStatus.Failed);
	});

	test('should map ResponseModelState.Pending to ChatSessionStatus.InProgress', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({ lastResponseState: ResponseModelState.Pending }),
		]);

		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items[0].status, ChatSessionStatus.InProgress);
	});

	test('should map ResponseModelState.NeedsInput to ChatSessionStatus.NeedsInput', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({ lastResponseState: ResponseModelState.NeedsInput }),
		]);

		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items[0].status, ChatSessionStatus.NeedsInput);
	});

	// --- Error Handling ---

	test('should handle errors from getCrossWorkspaceHistoryItems gracefully', async () => {
		const controller = createController();

		// Override to throw
		const originalFn = mockChatService.getCrossWorkspaceHistoryItems;
		mockChatService.getCrossWorkspaceHistoryItems = async () => {
			throw new Error('Simulated network error');
		};

		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items.length, 0, 'Should return empty items on error');

		// Restore
		mockChatService.getCrossWorkspaceHistoryItems = originalFn;
	});

	test('should recover after error on next refresh', async () => {
		const controller = createController();

		// First refresh fails
		mockChatService.getCrossWorkspaceHistoryItems = async () => {
			throw new Error('Temporary failure');
		};
		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items.length, 0);

		// Second refresh succeeds
		mockChatService.getCrossWorkspaceHistoryItems = async () => [createTestEntry()];
		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items.length, 1, 'Should recover after error');
	});

	// --- Session Resource URI ---

	test('should create valid LocalChatSessionUri for each item', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({ sessionId: 'unique-session-abc' }),
		]);

		await controller.refresh(CancellationToken.None);
		const resource = controller.items[0].resource;
		assert.ok(resource, 'Resource should be set');
		assert.ok(resource.toString().length > 0, 'Resource URI should be non-empty');
	});

	// --- Multiple Workspaces ---

	test('should correctly handle items from multiple different workspaces', async () => {
		const controller = createController();
		mockChatService.setCrossWorkspaceItems([
			createTestEntry({ sessionId: 's1', workspaceId: 'ws-a', workspaceName: 'Project Alpha' }),
			createTestEntry({ sessionId: 's2', workspaceId: 'ws-b', workspaceName: 'Project Beta' }),
			createTestEntry({ sessionId: 's3', workspaceId: 'ws-a', workspaceName: 'Project Alpha' }),
		]);

		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items.length, 3);

		const alphaItems = controller.items.filter(i => i.metadata?.['workspaceName'] === 'Project Alpha');
		const betaItems = controller.items.filter(i => i.metadata?.['workspaceName'] === 'Project Beta');
		assert.strictEqual(alphaItems.length, 2, 'Should have 2 items from Project Alpha');
		assert.strictEqual(betaItems.length, 1, 'Should have 1 item from Project Beta');
	});

	// --- Large Dataset ---

	test('should handle large number of cross-workspace sessions', async () => {
		const controller = createController();

		const items: ICrossWorkspaceSessionDetail[] = [];
		for (let i = 0; i < 200; i++) {
			items.push(createTestEntry({
				sessionId: `bulk-session-${i}`,
				title: `Bulk Chat ${i}`,
				workspaceId: `ws-${i % 10}`,
				workspaceName: `Workspace ${i % 10}`,
				timing: { created: i * 1000, lastRequestStarted: i * 1000, lastRequestEnded: (i + 1) * 1000 },
			}));
		}
		mockChatService.setCrossWorkspaceItems(items);

		await controller.refresh(CancellationToken.None);
		assert.strictEqual(controller.items.length, 200);

		// Verify sorting - newest first (highest lastRequestEnded)
		assert.strictEqual(controller.items[0].label, 'Bulk Chat 199');
		assert.strictEqual(controller.items[199].label, 'Bulk Chat 0');
	});

	// --- Session Opener Participant (handleOpenSession) ---

	function createMockAgentSession(overrides?: Partial<IAgentSession>): IAgentSession {
		const sessionId = overrides?.resource
			? LocalChatSessionUri.parseLocalSessionId(overrides.resource) ?? 'test-session'
			: 'test-session';
		return {
			resource: overrides?.resource ?? LocalChatSessionUri.forSession(sessionId),
			label: overrides?.label ?? 'Test Session',
			status: (overrides?.status as unknown as string) ?? 'completed',
			icon: Codicon.globe,
			timing: overrides?.timing ?? { created: Date.now() },
			providerType: overrides?.providerType ?? 'cross-workspace',
			providerLabel: 'Cross-Workspace',
			metadata: overrides?.metadata ?? {
				crossWorkspace: true,
				workspaceId: 'other-ws',
				workspaceName: 'Other Workspace',
				storageRoot: 'file:///storage/other/chatSessions',
			},
			isArchived: () => false,
			setArchived: () => { },
			isRead: () => false,
			setRead: () => { },
			...overrides,
		} as unknown as IAgentSession;
	}

	function createMockSerializedData(sessionId: string): ISerializedChatDataReference {
		return {
			value: {
				sessionId,
				creationDate: Date.now(),
				lastMessageDate: Date.now(),
				requests: [],
				initialLocation: undefined,
			} as unknown as ISerializedChatData,
			serializer: {
				operations: [],
				apply: (v: unknown) => v,
			} as unknown as ISerializedChatDataReference['serializer'],
		};
	}

	test('should return false for non-cross-workspace sessions', async () => {
		const controller = createController();
		const session = createMockAgentSession({
			metadata: undefined, // no cross-workspace metadata
		});

		const handled = await instantiationService.invokeFunction(
			accessor => controller.handleOpenSession(accessor, session)
		);
		assert.strictEqual(handled, false, 'Should not handle non-cross-workspace sessions');
	});

	test('should return false when metadata.crossWorkspace is not true', async () => {
		const controller = createController();
		const session = createMockAgentSession({
			metadata: { crossWorkspace: false },
		});

		const handled = await instantiationService.invokeFunction(
			accessor => controller.handleOpenSession(accessor, session)
		);
		assert.strictEqual(handled, false);
	});

	test('should return false when storageRoot is missing', async () => {
		const controller = createController();
		const session = createMockAgentSession({
			metadata: { crossWorkspace: true, workspaceId: 'ws', workspaceName: 'WS' },
		});

		const handled = await instantiationService.invokeFunction(
			accessor => controller.handleOpenSession(accessor, session)
		);
		assert.strictEqual(handled, false, 'Should fall through when storageRoot is missing');
	});

	test('should read cross-workspace session data with correct sessionId and storageRoot', async () => {
		const controller = createController();
		const sessionId = 'cx-session-123';
		const storageRoot = 'file:///workspace/other/chatSessions';

		const session = createMockAgentSession({
			resource: LocalChatSessionUri.forSession(sessionId),
			metadata: {
				crossWorkspace: true,
				workspaceId: 'other-ws',
				workspaceName: 'Other',
				storageRoot,
			},
		});

		await instantiationService.invokeFunction(
			accessor => controller.handleOpenSession(accessor, session)
		);

		assert.ok(mockChatService.readCrossWorkspaceSessionCalled, 'Should call readCrossWorkspaceSession');
		assert.strictEqual(mockChatService.lastReadSessionId, sessionId);
		assert.strictEqual(mockChatService.lastReadStorageRoot, storageRoot);
	});

	test('should show warning when session data is not found', async () => {
		const controller = createController();
		// Don't set any session data → readCrossWorkspaceSession returns undefined

		const session = createMockAgentSession();

		const handled = await instantiationService.invokeFunction(
			accessor => controller.handleOpenSession(accessor, session)
		);

		assert.strictEqual(handled, true, 'Should return true (handled with error)');
		assert.ok(mockNotificationService.warnCalled, 'Should show warning notification');
		assert.ok(!mockChatWidgetService.openSessionCalled, 'Should not open widget');
	});

	test('should load session from content and open widget on success', async () => {
		const controller = createController();
		const sessionId = 'cx-session-456';
		const loadedResource = LocalChatSessionUri.forSession(sessionId);

		// Setup: session data available, load succeeds
		mockChatService.setCrossWorkspaceSessionData(sessionId, createMockSerializedData(sessionId));
		mockChatService.setLoadSessionResult({
			object: { sessionResource: loadedResource },
			dispose: () => { },
		});

		const session = createMockAgentSession({
			resource: LocalChatSessionUri.forSession(sessionId),
			metadata: {
				crossWorkspace: true,
				workspaceId: 'ws-x',
				workspaceName: 'Project X',
				storageRoot: 'file:///storage/ws-x/chatSessions',
			},
		});

		const handled = await instantiationService.invokeFunction(
			accessor => controller.handleOpenSession(accessor, session)
		);

		assert.strictEqual(handled, true, 'Should return true (handled)');
		assert.ok(mockChatService.loadSessionFromContentCalled, 'Should call loadSessionFromContent');
		assert.ok(mockChatWidgetService.openSessionCalled, 'Should open the widget');
		assert.strictEqual(
			mockChatWidgetService.lastOpenedResource?.toString(),
			loadedResource.toString(),
			'Should open with the loaded session resource'
		);
	});

	test('should show info notification with workspace name on success', async () => {
		const controller = createController();
		const sessionId = 'cx-session-info';
		const loadedResource = LocalChatSessionUri.forSession(sessionId);

		mockChatService.setCrossWorkspaceSessionData(sessionId, createMockSerializedData(sessionId));
		mockChatService.setLoadSessionResult({
			object: { sessionResource: loadedResource },
			dispose: () => { },
		});

		const session = createMockAgentSession({
			resource: LocalChatSessionUri.forSession(sessionId),
			metadata: {
				crossWorkspace: true,
				workspaceId: 'ws-y',
				workspaceName: 'My Cool Project',
				storageRoot: 'file:///storage/ws-y/chatSessions',
			},
		});

		await instantiationService.invokeFunction(
			accessor => controller.handleOpenSession(accessor, session)
		);

		assert.ok(mockNotificationService.infoCalled, 'Should show info notification');
		assert.ok(
			mockNotificationService.lastInfoMessage?.includes('My Cool Project'),
			`Info message should contain workspace name, got: "${mockNotificationService.lastInfoMessage}"`
		);
	});

	test('should mark session as read after opening', async () => {
		const controller = createController();
		const sessionId = 'cx-session-read';
		const loadedResource = LocalChatSessionUri.forSession(sessionId);

		mockChatService.setCrossWorkspaceSessionData(sessionId, createMockSerializedData(sessionId));
		mockChatService.setLoadSessionResult({
			object: { sessionResource: loadedResource },
			dispose: () => { },
		});

		let wasSetRead = false;
		const session = createMockAgentSession({
			resource: LocalChatSessionUri.forSession(sessionId),
			setRead: (read: boolean) => { wasSetRead = read; },
		});

		await instantiationService.invokeFunction(
			accessor => controller.handleOpenSession(accessor, session)
		);

		assert.ok(wasSetRead, 'Should call setRead(true) on the session');
	});

	test('should show warning when loadSessionFromContent returns undefined', async () => {
		const controller = createController();
		const sessionId = 'cx-session-load-fail';

		// Session data available but loadSessionFromContent fails
		mockChatService.setCrossWorkspaceSessionData(sessionId, createMockSerializedData(sessionId));
		mockChatService.setLoadSessionResult(undefined); // load fails

		const session = createMockAgentSession({
			resource: LocalChatSessionUri.forSession(sessionId),
		});

		const handled = await instantiationService.invokeFunction(
			accessor => controller.handleOpenSession(accessor, session)
		);

		assert.strictEqual(handled, true);
		assert.ok(mockNotificationService.warnCalled, 'Should show warning when load fails');
		assert.ok(!mockChatWidgetService.openSessionCalled, 'Should not open widget');
	});

	test('should dispose model reference after opening', async () => {
		const controller = createController();
		const sessionId = 'cx-session-dispose';
		const loadedResource = LocalChatSessionUri.forSession(sessionId);

		let disposed = false;
		mockChatService.setCrossWorkspaceSessionData(sessionId, createMockSerializedData(sessionId));
		mockChatService.setLoadSessionResult({
			object: { sessionResource: loadedResource },
			dispose: () => { disposed = true; },
		});

		const session = createMockAgentSession({
			resource: LocalChatSessionUri.forSession(sessionId),
		});

		await instantiationService.invokeFunction(
			accessor => controller.handleOpenSession(accessor, session)
		);

		assert.ok(disposed, 'Should dispose modelRef after widget opens');
	});

	test('should handle readCrossWorkspaceSession error gracefully', async () => {
		const controller = createController();

		// Make readCrossWorkspaceSession throw
		mockChatService.readCrossWorkspaceSession = async () => {
			throw new Error('Storage I/O error');
		};

		const session = createMockAgentSession();

		const handled = await instantiationService.invokeFunction(
			accessor => controller.handleOpenSession(accessor, session)
		);

		assert.strictEqual(handled, true, 'Should return true (handled with error)');
		assert.ok(mockNotificationService.errorCalled, 'Should show error notification');
	});

	test('should dispose model reference even if openSession throws', async () => {
		const controller = createController();
		const sessionId = 'cx-session-open-error';
		const loadedResource = LocalChatSessionUri.forSession(sessionId);

		let disposed = false;
		mockChatService.setCrossWorkspaceSessionData(sessionId, createMockSerializedData(sessionId));
		mockChatService.setLoadSessionResult({
			object: { sessionResource: loadedResource },
			dispose: () => { disposed = true; },
		});

		// Make openSession throw
		mockChatWidgetService.openSession = async () => {
			throw new Error('Widget creation error');
		};

		const session = createMockAgentSession({
			resource: LocalChatSessionUri.forSession(sessionId),
		});

		await instantiationService.invokeFunction(
			accessor => controller.handleOpenSession(accessor, session)
		);

		assert.ok(disposed, 'Should dispose model reference even when openSession throws');
	});
});
