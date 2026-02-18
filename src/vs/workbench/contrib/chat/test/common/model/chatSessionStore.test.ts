/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../../platform/telemetry/common/telemetryUtils.js';
import { IUserDataProfilesService, toUserDataProfile } from '../../../../../../platform/userDataProfile/common/userDataProfile.js';
import { IAnyWorkspaceIdentifier, IWorkspaceContextService, WorkspaceFolder } from '../../../../../../platform/workspace/common/workspace.js';
import { TestWorkspace, Workspace } from '../../../../../../platform/workspace/test/common/testWorkspace.js';
import { ILifecycleService } from '../../../../../services/lifecycle/common/lifecycle.js';
import { IDidEnterWorkspaceEvent, IWorkspaceEditingService } from '../../../../../services/workspaces/common/workspaceEditing.js';
import { InMemoryTestFileService, TestContextService, TestLifecycleService, TestStorageService } from '../../../../../test/common/workbenchTestServices.js';
import { ChatModel, IChatRequestModel, ISerializableChatData3 } from '../../../common/model/chatModel.js';
import { ChatSessionStore, IChatTransfer } from '../../../common/model/chatSessionStore.js';
import { LocalChatSessionUri } from '../../../common/model/chatUri.js';
import { MockChatModel } from './mockChatModel.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';

function createMockChatModel(sessionResource: URI, options?: { customTitle?: string; nonEmpty?: boolean }): ChatModel {
	const sessionId = LocalChatSessionUri.parseLocalSessionId(sessionResource);
	if (!sessionId) {
		throw new Error('createMockChatModel requires a local session URI');
	}
	const model = new MockChatModel(sessionResource);
	model.sessionId = sessionId;
	if (options?.customTitle) {
		model.customTitle = options.customTitle;
	}
	if (options?.nonEmpty) {
		// Override getRequests to return a dummy request so sessions are not
		// considered empty by getSessionMetadata / flushGlobalIndex.
		const dummyRequest = { id: 'req-1', timestamp: Date.now() } as unknown as IChatRequestModel;
		model.getRequests = () => [dummyRequest];
		(model as unknown as { requests: IChatRequestModel[] }).requests = [dummyRequest];
	}
	// Cast to ChatModel - the mock implements enough of the interface for testing
	return model as unknown as ChatModel;
}

class MockWorkspaceEditingService extends Disposable implements Partial<IWorkspaceEditingService> {
	private readonly _onDidEnterWorkspace = this._register(new Emitter<IDidEnterWorkspaceEvent>());
	readonly onDidEnterWorkspace = this._onDidEnterWorkspace.event;

	fireWorkspaceTransition(oldWorkspace: IAnyWorkspaceIdentifier, newWorkspace: IAnyWorkspaceIdentifier): Promise<void> {
		const promises: Promise<void>[] = [];
		const event: IDidEnterWorkspaceEvent = {
			oldWorkspace,
			newWorkspace,
			join: (promise: Promise<void>) => promises.push(promise)
		};
		this._onDidEnterWorkspace.fire(event);
		return Promise.all(promises).then(() => { });
	}
}

suite('ChatSessionStore', () => {
	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	let instantiationService: TestInstantiationService;
	let mockWorkspaceEditingService: MockWorkspaceEditingService;

	function createChatSessionStore(isEmptyWindow: boolean = false): ChatSessionStore {
		const workspace = isEmptyWindow ? new Workspace('empty-window-id', []) : TestWorkspace;
		instantiationService.stub(IWorkspaceContextService, new TestContextService(workspace));
		return testDisposables.add(instantiationService.createInstance(ChatSessionStore));
	}

	setup(() => {
		instantiationService = testDisposables.add(new TestInstantiationService(new ServiceCollection()));
		instantiationService.stub(IStorageService, testDisposables.add(new TestStorageService()));
		instantiationService.stub(ILogService, NullLogService);
		instantiationService.stub(ITelemetryService, NullTelemetryService);
		instantiationService.stub(IFileService, testDisposables.add(new InMemoryTestFileService()));
		instantiationService.stub(IEnvironmentService, { workspaceStorageHome: URI.file('/test/workspaceStorage') });
		instantiationService.stub(ILifecycleService, testDisposables.add(new TestLifecycleService()));
		instantiationService.stub(IUserDataProfilesService, { defaultProfile: toUserDataProfile('default', 'Default', URI.file('/test/userdata'), URI.file('/test/cache')) });
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		mockWorkspaceEditingService = testDisposables.add(new MockWorkspaceEditingService());
		instantiationService.stub(IWorkspaceEditingService, mockWorkspaceEditingService as unknown as IWorkspaceEditingService);
	});

	test('hasSessions returns false when no sessions exist', () => {
		const store = createChatSessionStore();

		assert.strictEqual(store.hasSessions(), false);
	});

	test('getIndex returns empty index initially', async () => {
		const store = createChatSessionStore();

		const index = await store.getIndex();
		assert.deepStrictEqual(index, {});
	});

	test('getChatStorageFolder returns correct path for workspace', () => {
		const store = createChatSessionStore(false);

		const storageFolder = store.getChatStorageFolder();
		assert.ok(storageFolder.path.includes('workspaceStorage'));
		assert.ok(storageFolder.path.includes('chatSessions'));
	});

	test('getChatStorageFolder returns correct path for empty window', () => {
		const store = createChatSessionStore(true);

		const storageFolder = store.getChatStorageFolder();
		assert.ok(storageFolder.path.includes('emptyWindowChatSessions'));
	});

	test('isSessionEmpty returns true for non-existent session', () => {
		const store = createChatSessionStore();

		assert.strictEqual(store.isSessionEmpty('non-existent-session'), true);
	});

	test('readSession returns undefined for non-existent session', async () => {
		const store = createChatSessionStore();

		const session = await store.readSession('non-existent-session');
		assert.strictEqual(session, undefined);
	});

	test('deleteSession handles non-existent session gracefully', async () => {
		const store = createChatSessionStore();

		// Should not throw
		await store.deleteSession('non-existent-session');

		assert.strictEqual(store.hasSessions(), false);
	});

	test('storeSessions persists session to index', async () => {
		const store = createChatSessionStore();
		const model = testDisposables.add(createMockChatModel(LocalChatSessionUri.forSession('session-1')));

		await store.storeSessions([model]);

		assert.strictEqual(store.hasSessions(), true);
		const index = await store.getIndex();
		assert.ok(index['session-1']);
		assert.strictEqual(index['session-1'].sessionId, 'session-1');
	});

	test('storeSessions persists custom title', async () => {
		const store = createChatSessionStore();
		const model = testDisposables.add(createMockChatModel(LocalChatSessionUri.forSession('session-1'), { customTitle: 'My Custom Title' }));

		await store.storeSessions([model]);

		const index = await store.getIndex();
		assert.strictEqual(index['session-1'].title, 'My Custom Title');
	});

	test('readSession returns stored session data', async () => {
		const store = createChatSessionStore();
		const model = testDisposables.add(createMockChatModel(LocalChatSessionUri.forSession('session-1')));

		await store.storeSessions([model]);
		const session = await store.readSession('session-1');

		assert.ok(session);
		assert.strictEqual((session.value as ISerializableChatData3).sessionId, 'session-1');
	});

	test('deleteSession removes session from index', async () => {
		const store = createChatSessionStore();
		const model = testDisposables.add(createMockChatModel(LocalChatSessionUri.forSession('session-1')));

		await store.storeSessions([model]);
		assert.strictEqual(store.hasSessions(), true);

		await store.deleteSession('session-1');

		assert.strictEqual(store.hasSessions(), false);
		const index = await store.getIndex();
		assert.strictEqual(index['session-1'], undefined);
	});

	test('clearAllSessions removes all sessions', async () => {
		const store = createChatSessionStore();
		const model1 = testDisposables.add(createMockChatModel(LocalChatSessionUri.forSession('session-1')));
		const model2 = testDisposables.add(createMockChatModel(LocalChatSessionUri.forSession('session-2')));

		await store.storeSessions([model1, model2]);
		assert.strictEqual(Object.keys(await store.getIndex()).length, 2);

		await store.clearAllSessions();

		const index = await store.getIndex();
		assert.deepStrictEqual(index, {});
	});

	test('setSessionTitle updates existing session title', async () => {
		const store = createChatSessionStore();
		const model = testDisposables.add(createMockChatModel(LocalChatSessionUri.forSession('session-1'), { customTitle: 'Original Title' }));

		await store.storeSessions([model]);
		await store.setSessionTitle('session-1', 'New Title');

		const index = await store.getIndex();
		assert.strictEqual(index['session-1'].title, 'New Title');
	});

	test('setSessionTitle does nothing for non-existent session', async () => {
		const store = createChatSessionStore();

		// Should not throw
		await store.setSessionTitle('non-existent', 'Title');

		const index = await store.getIndex();
		assert.strictEqual(index['non-existent'], undefined);
	});

	test('multiple stores can be created with different workspaces', async () => {
		const store1 = createChatSessionStore(false);
		const store2 = createChatSessionStore(true);

		const folder1 = store1.getChatStorageFolder();
		const folder2 = store2.getChatStorageFolder();

		assert.notStrictEqual(folder1.toString(), folder2.toString());
	});

	suite('transferred sessions', () => {
		function createSingleFolderWorkspace(folderUri: URI): Workspace {
			const folder = new WorkspaceFolder({ uri: folderUri, index: 0, name: 'test' });
			return new Workspace('single-folder-id', [folder]);
		}

		function createChatSessionStoreWithSingleFolder(folderUri: URI): ChatSessionStore {
			instantiationService.stub(IWorkspaceContextService, new TestContextService(createSingleFolderWorkspace(folderUri)));
			return testDisposables.add(instantiationService.createInstance(ChatSessionStore));
		}

		function createTransferData(toWorkspace: URI, sessionResource: URI, timestampInMilliseconds?: number): IChatTransfer {
			return {
				toWorkspace,
				sessionResource,
				timestampInMilliseconds: timestampInMilliseconds ?? Date.now(),
			};
		}

		test('getTransferredSessionData returns undefined for empty window', () => {
			const store = createChatSessionStore(true); // empty window

			const result = store.getTransferredSessionData();

			assert.strictEqual(result, undefined);
		});

		test('getTransferredSessionData returns undefined when no transfer exists', () => {
			const folderUri = URI.file('/test/workspace');
			const store = createChatSessionStoreWithSingleFolder(folderUri);

			const result = store.getTransferredSessionData();

			assert.strictEqual(result, undefined);
		});

		test('storeTransferSession stores and retrieves transfer data', async () => {
			const folderUri = URI.file('/test/workspace');
			const store = createChatSessionStoreWithSingleFolder(folderUri);
			const sessionResource = LocalChatSessionUri.forSession('transfer-session');
			const model = testDisposables.add(createMockChatModel(sessionResource));

			const transferData = createTransferData(folderUri, sessionResource);
			await store.storeTransferSession(transferData, model);

			const result = store.getTransferredSessionData();
			assert.ok(result);
			assert.strictEqual(result.toString(), sessionResource.toString());
		});

		test('readTransferredSession returns session data', async () => {
			const folderUri = URI.file('/test/workspace');
			const store = createChatSessionStoreWithSingleFolder(folderUri);
			const sessionResource = LocalChatSessionUri.forSession('transfer-session');
			const model = testDisposables.add(createMockChatModel(sessionResource));

			const transferData = createTransferData(folderUri, sessionResource);
			await store.storeTransferSession(transferData, model);

			const sessionData = await store.readTransferredSession(sessionResource);
			assert.ok(sessionData);
			assert.strictEqual((sessionData.value as ISerializableChatData3).sessionId, 'transfer-session');
		});

		test('readTransferredSession cleans up after reading', async () => {
			const folderUri = URI.file('/test/workspace');
			const store = createChatSessionStoreWithSingleFolder(folderUri);
			const sessionResource = LocalChatSessionUri.forSession('transfer-session');
			const model = testDisposables.add(createMockChatModel(sessionResource));

			const transferData = createTransferData(folderUri, sessionResource);
			await store.storeTransferSession(transferData, model);

			// Read the session
			await store.readTransferredSession(sessionResource);

			// Transfer should be cleaned up
			const result = store.getTransferredSessionData();
			assert.strictEqual(result, undefined);
		});

		test('getTransferredSessionData returns undefined for expired transfer', async () => {
			const folderUri = URI.file('/test/workspace');
			const store = createChatSessionStoreWithSingleFolder(folderUri);
			const sessionResource = LocalChatSessionUri.forSession('transfer-session');
			const model = testDisposables.add(createMockChatModel(sessionResource));

			// Create transfer with timestamp 10 minutes in the past (expired)
			const expiredTimestamp = Date.now() - (10 * 60 * 1000);
			const transferData = createTransferData(folderUri, sessionResource, expiredTimestamp);
			await store.storeTransferSession(transferData, model);

			const result = store.getTransferredSessionData();
			assert.strictEqual(result, undefined);
		});

		test('expired transfer cleans up index and file', async () => {
			const folderUri = URI.file('/test/workspace');
			const store = createChatSessionStoreWithSingleFolder(folderUri);
			const sessionResource = LocalChatSessionUri.forSession('transfer-session');
			const model = testDisposables.add(createMockChatModel(sessionResource));

			// Create transfer with timestamp 100 minutes in the past (expired)
			const expiredTimestamp = Date.now() - (100 * 60 * 1000);
			const transferData = createTransferData(folderUri, sessionResource, expiredTimestamp);
			await store.storeTransferSession(transferData, model);

			// Assert cleaned up
			const data = store.getTransferredSessionData();
			assert.strictEqual(data, undefined);
		});

		test('readTransferredSession returns undefined for invalid session resource', async () => {
			const folderUri = URI.file('/test/workspace');
			const store = createChatSessionStoreWithSingleFolder(folderUri);

			// Use a non-local session URI
			const invalidResource = URI.parse('file:///invalid/session');

			const result = await store.readTransferredSession(invalidResource);
			assert.strictEqual(result, undefined);
		});

		test('storeTransferSession deletes preexisting transferred session file', async () => {
			const folderUri = URI.file('/test/workspace');
			const store = createChatSessionStoreWithSingleFolder(folderUri);
			const fileService = instantiationService.get(IFileService);

			// Store first session
			const session1Resource = LocalChatSessionUri.forSession('transfer-session-1');
			const model1 = testDisposables.add(createMockChatModel(session1Resource));
			const transferData1 = createTransferData(folderUri, session1Resource);
			await store.storeTransferSession(transferData1, model1);

			// Verify first session file exists
			const userDataProfile = instantiationService.get(IUserDataProfilesService).defaultProfile;
			const storageLocation1 = URI.joinPath(
				userDataProfile.globalStorageHome,
				'transferredChatSessions',
				'transfer-session-1.json'
			);
			const exists1 = await fileService.exists(storageLocation1);
			assert.strictEqual(exists1, true, 'First session file should exist');

			// Store second session for the same workspace
			const session2Resource = LocalChatSessionUri.forSession('transfer-session-2');
			const model2 = testDisposables.add(createMockChatModel(session2Resource));
			const transferData2 = createTransferData(folderUri, session2Resource);
			await store.storeTransferSession(transferData2, model2);

			// Verify first session file is deleted
			const exists1After = await fileService.exists(storageLocation1);
			assert.strictEqual(exists1After, false, 'First session file should be deleted');

			// Verify second session file exists
			const storageLocation2 = URI.joinPath(
				userDataProfile.globalStorageHome,
				'transferredChatSessions',
				'transfer-session-2.json'
			);
			const exists2 = await fileService.exists(storageLocation2);
			assert.strictEqual(exists2, true, 'Second session file should exist');

			// Verify only the second session is retrievable
			const result = store.getTransferredSessionData();
			assert.ok(result);
			assert.strictEqual(result.toString(), session2Resource.toString());
		});
	});

	suite('workspace migration', () => {
		test('migration is triggered when onDidEnterWorkspace fires', async () => {
			const fileService = instantiationService.get(IFileService) as InMemoryTestFileService;

			// Create store with empty window
			const store = createChatSessionStore(true);
			const model = testDisposables.add(createMockChatModel(LocalChatSessionUri.forSession('session-1')));

			// Store a session in empty window
			await store.storeSessions([model]);
			assert.strictEqual(store.hasSessions(), true);

			// Get the file path for the session in empty window storage
			const emptyWindowStorageRoot = store.getChatStorageFolder();
			const sessionFile = URI.joinPath(emptyWindowStorageRoot, 'session-1.json');
			const fileExists = await fileService.exists(sessionFile);
			assert.strictEqual(fileExists, true, 'Session file should exist in empty window storage');

			// Simulate workspace transition via the onDidEnterWorkspace event
			const oldWorkspace: IAnyWorkspaceIdentifier = { id: 'empty-window-id' };
			const newWorkspace: IAnyWorkspaceIdentifier = { id: TestWorkspace.id, uri: URI.file('/test/folder') };

			// Fire the workspace transition event - migration happens synchronously via join()
			await mockWorkspaceEditingService.fireWorkspaceTransition(oldWorkspace, newWorkspace);

			// Verify file was copied to new location
			const newStorageRoot = store.getChatStorageFolder();
			const migratedSessionFile = URI.joinPath(newStorageRoot, 'session-1.json');
			const migratedFileExists = await fileService.exists(migratedSessionFile);
			assert.strictEqual(migratedFileExists, true, 'Session file should be migrated to workspace storage');
		});

		test('migration handles non-existent old storage location gracefully', async () => {
			// Create store with a workspace
			const store = createChatSessionStore(false);

			// Simulate workspace transition from a non-existent workspace
			const oldWorkspace: IAnyWorkspaceIdentifier = { id: 'non-existent-workspace-id' };
			const newWorkspace: IAnyWorkspaceIdentifier = { id: 'new-workspace-id' };

			// Fire the workspace transition event - should not crash
			await mockWorkspaceEditingService.fireWorkspaceTransition(oldWorkspace, newWorkspace);

			// Store should work normally
			assert.strictEqual(store.hasSessions(), false);
		});

		test('storage root is updated after workspace transition', async () => {
			// Create store with empty window
			const store = createChatSessionStore(true);

			const initialStorageRoot = store.getChatStorageFolder();
			assert.ok(initialStorageRoot.path.includes('emptyWindowChatSessions'), 'Initial storage should be empty window location');

			// Simulate workspace transition - use proper identifier types
			// Empty workspace only has 'id', single folder has 'uri' property too
			const oldWorkspace: IAnyWorkspaceIdentifier = { id: 'empty-window-id' };
			const newWorkspace: IAnyWorkspaceIdentifier = { id: 'new-workspace-id', uri: URI.file('/test/folder') };

			await mockWorkspaceEditingService.fireWorkspaceTransition(oldWorkspace, newWorkspace);

			const newStorageRoot = store.getChatStorageFolder();
			assert.ok(newStorageRoot.path.includes('new-workspace-id'), 'Storage root should be updated to new workspace location');
		});
	});

	suite('global cross-workspace index', () => {
		test('getGlobalIndex returns empty when no global index exists', async () => {
			const store = createChatSessionStore();
			const entries = await store.getGlobalIndex();
			assert.deepStrictEqual(entries, []);
		});

		test('storeSessions populates the global index for non-empty-window workspace', async () => {
			const store = createChatSessionStore(false);
			const model = testDisposables.add(createMockChatModel(LocalChatSessionUri.forSession('session-g1'), { customTitle: 'Global Test', nonEmpty: true }));

			await store.storeSessions([model]);

			// The global index should be written - but since we are the current workspace,
			// getGlobalIndex filters us out. Verify by checking storage directly.
			const storageService = instantiationService.get(IStorageService);
			const raw = storageService.get('chat.ChatSessionStore.globalIndex', StorageScope.APPLICATION, undefined);
			assert.ok(raw, 'Global index should be stored in APPLICATION scope');

			const parsed = JSON.parse(raw!);
			assert.strictEqual(parsed.version, 1);
			assert.ok(Object.keys(parsed.workspaces).length > 0, 'Should have at least one workspace in global index');
		});

		test('storeSessions does NOT populate global index for empty window', async () => {
			const store = createChatSessionStore(true);
			const model = testDisposables.add(createMockChatModel(LocalChatSessionUri.forSession('session-empty')));

			await store.storeSessions([model]);

			const storageService = instantiationService.get(IStorageService);
			const raw = storageService.get('chat.ChatSessionStore.globalIndex', StorageScope.APPLICATION, undefined);
			assert.strictEqual(raw, undefined, 'Empty window should not write to global index');
		});

		test('getGlobalIndex filters out current workspace entries', async () => {
			const store = createChatSessionStore(false);
			const model = testDisposables.add(createMockChatModel(LocalChatSessionUri.forSession('session-self')));

			await store.storeSessions([model]);

			// getGlobalIndex should return empty because the only workspace is the current one
			const entries = await store.getGlobalIndex();
			assert.strictEqual(entries.length, 0, 'Should not include current workspace sessions');
		});

		test('getGlobalIndex returns sessions from other workspaces written to storage', async () => {
			const storageService = instantiationService.get(IStorageService) as TestStorageService;

			// Manually inject a global index entry for another workspace
			const otherWorkspaceIndex: { version: 1; workspaces: Record<string, unknown> } = {
				version: 1,
				workspaces: {
					'other-workspace-id': {
						workspaceName: 'Other Project',
						storageRoot: 'file:///test/workspaceStorage/other-workspace-id/chatSessions',
						entries: {
							'session-x1': {
								sessionId: 'session-x1',
								title: 'Cross Workspace Chat',
								lastMessageDate: 1700000000000,
								timing: { created: 1700000000000, lastRequestStarted: 1700000000000, lastRequestEnded: 1700000001000 },
								lastResponseState: 3, // ResponseModelState.Complete
							},
							'session-x2': {
								sessionId: 'session-x2',
								title: 'Another Chat',
								lastMessageDate: 1700000002000,
								timing: { created: 1700000002000, lastRequestStarted: 1700000002000, lastRequestEnded: 1700000003000 },
								lastResponseState: 3,
							},
						},
					},
				},
			};
			storageService.store('chat.ChatSessionStore.globalIndex', JSON.stringify(otherWorkspaceIndex), StorageScope.APPLICATION, StorageTarget.MACHINE);

			const store = createChatSessionStore(false);
			const entries = await store.getGlobalIndex();

			assert.strictEqual(entries.length, 2, 'Should return 2 sessions from other workspace');
			assert.strictEqual(entries[0].workspaceName, 'Other Project');
			assert.strictEqual(entries[0].workspaceId, 'other-workspace-id');
			assert.ok(entries.some(e => e.sessionId === 'session-x1'));
			assert.ok(entries.some(e => e.sessionId === 'session-x2'));
		});

		test('getGlobalIndex handles corrupt global index gracefully', async () => {
			const storageService = instantiationService.get(IStorageService) as TestStorageService;

			// Store invalid JSON
			storageService.store('chat.ChatSessionStore.globalIndex', 'not-valid-json{{[', StorageScope.APPLICATION, StorageTarget.MACHINE);

			const store = createChatSessionStore(false);
			const entries = await store.getGlobalIndex();

			assert.deepStrictEqual(entries, [], 'Should gracefully return empty array for corrupt index');
		});

		test('getGlobalIndex handles wrong version gracefully', async () => {
			const storageService = instantiationService.get(IStorageService) as TestStorageService;

			storageService.store('chat.ChatSessionStore.globalIndex', JSON.stringify({ version: 99, workspaces: {} }), StorageScope.APPLICATION, StorageTarget.MACHINE);

			const store = createChatSessionStore(false);
			const entries = await store.getGlobalIndex();

			assert.deepStrictEqual(entries, [], 'Should return empty for unrecognized version');
		});

		test('getGlobalIndex skips workspace entries with empty entries object', async () => {
			const storageService = instantiationService.get(IStorageService) as TestStorageService;

			const index = {
				version: 1,
				workspaces: {
					'stale-workspace': {
						workspaceName: 'Stale Project',
						storageRoot: 'file:///test/stale',
						entries: {},
					},
					'valid-workspace': {
						workspaceName: 'Valid Project',
						storageRoot: 'file:///test/valid',
						entries: {
							'session-v1': {
								sessionId: 'session-v1',
								title: 'Valid Chat',
								lastMessageDate: Date.now(),
								timing: { created: Date.now(), lastRequestStarted: undefined, lastRequestEnded: Date.now() },
								lastResponseState: 3,
							},
						},
					},
				},
			};
			storageService.store('chat.ChatSessionStore.globalIndex', JSON.stringify(index), StorageScope.APPLICATION, StorageTarget.MACHINE);

			const store = createChatSessionStore(false);
			const entries = await store.getGlobalIndex();

			assert.strictEqual(entries.length, 1, 'Should only return entries from non-empty workspaces');
			assert.strictEqual(entries[0].workspaceName, 'Valid Project');
		});

		test('getGlobalIndex skips malformed workspace entries (no workspaceName)', async () => {
			const storageService = instantiationService.get(IStorageService) as TestStorageService;

			const index = {
				version: 1,
				workspaces: {
					'malformed-workspace': {
						// missing workspaceName
						storageRoot: 'file:///test/malformed',
						entries: {
							's1': {
								sessionId: 's1',
								title: 'Chat',
								lastMessageDate: Date.now(),
								timing: { created: Date.now(), lastRequestStarted: undefined, lastRequestEnded: Date.now() },
								lastResponseState: 3,
							},
						},
					},
				},
			};
			storageService.store('chat.ChatSessionStore.globalIndex', JSON.stringify(index), StorageScope.APPLICATION, StorageTarget.MACHINE);

			const store = createChatSessionStore(false);
			const entries = await store.getGlobalIndex();

			assert.strictEqual(entries.length, 0, 'Should skip malformed workspace entries');
		});

		test('flushGlobalIndex removes workspace entry when all sessions are cleared', async () => {
			const store = createChatSessionStore(false);
			const model = testDisposables.add(createMockChatModel(LocalChatSessionUri.forSession('session-del'), { nonEmpty: true }));

			await store.storeSessions([model]);

			// Verify it exists in global index
			const storageService = instantiationService.get(IStorageService);
			let raw = storageService.get('chat.ChatSessionStore.globalIndex', StorageScope.APPLICATION, undefined);
			let parsed = JSON.parse(raw!);
			const workspaceId = Object.keys(parsed.workspaces)[0];
			assert.ok(workspaceId, 'Should have workspace entry');

			// Delete the session and store again with empty sessions
			await store.clearAllSessions();

			// After clearing, global index should have the workspace entry removed
			raw = storageService.get('chat.ChatSessionStore.globalIndex', StorageScope.APPLICATION, undefined);
			parsed = JSON.parse(raw!);
			assert.strictEqual(parsed.workspaces[workspaceId], undefined, 'Workspace entry should be removed when all sessions are cleared');
		});

		test('readCrossWorkspaceSession returns undefined for empty sessionId', async () => {
			const store = createChatSessionStore(false);
			const result = await store.readCrossWorkspaceSession('', 'file:///test/storage');
			assert.strictEqual(result, undefined);
		});

		test('readCrossWorkspaceSession returns undefined for empty storageRoot', async () => {
			const store = createChatSessionStore(false);
			const result = await store.readCrossWorkspaceSession('session-1', '');
			assert.strictEqual(result, undefined);
		});

		test('readCrossWorkspaceSession returns undefined for non-existent session file', async () => {
			const store = createChatSessionStore(false);
			const result = await store.readCrossWorkspaceSession('non-existent-session', 'file:///test/workspaceStorage/other/chatSessions');
			assert.strictEqual(result, undefined);
		});

		test('readCrossWorkspaceSession reads valid session from another workspace storage', async () => {
			// Disable log session storage to avoid InMemoryTestFileService returning
			// default content for non-existent .jsonl files (real file service throws FILE_NOT_FOUND).
			const configService = instantiationService.get(IConfigurationService) as TestConfigurationService;
			configService.setUserConfiguration('chat', { useLogSessionStorage: false });
			const store = createChatSessionStore(false);
			const fileService = instantiationService.get(IFileService);

			// Write a session file to a mock cross-workspace storage location
			const crossStorageRoot = URI.file('/test/workspaceStorage/cross-workspace/chatSessions');
			const sessionData = {
				version: 3,
				sessionId: 'cross-session-1',
				creationDate: Date.now(),
				requests: [],
				responderUsername: 'agent',
			};
			const sessionFile = URI.joinPath(crossStorageRoot, 'cross-session-1.json');
			await fileService.writeFile(sessionFile, VSBuffer.fromString(JSON.stringify(sessionData)));

			const result = await store.readCrossWorkspaceSession('cross-session-1', crossStorageRoot.toString());
			assert.ok(result, 'Should return deserialized session data');
			assert.strictEqual((result!.value as unknown as { sessionId: string }).sessionId, 'cross-session-1');
		});

		test('multiple workspace entries are returned correctly', async () => {
			const storageService = instantiationService.get(IStorageService) as TestStorageService;

			const index = {
				version: 1,
				workspaces: {
					'workspace-a': {
						workspaceName: 'Project A',
						storageRoot: 'file:///test/a',
						entries: {
							'sa1': { sessionId: 'sa1', title: 'A Chat 1', lastMessageDate: 1000, timing: { created: 1000, lastRequestStarted: 1000, lastRequestEnded: 2000 }, lastResponseState: 3 },
						},
					},
					'workspace-b': {
						workspaceName: 'Project B',
						storageRoot: 'file:///test/b',
						entries: {
							'sb1': { sessionId: 'sb1', title: 'B Chat 1', lastMessageDate: 3000, timing: { created: 3000, lastRequestStarted: 3000, lastRequestEnded: 4000 }, lastResponseState: 3 },
							'sb2': { sessionId: 'sb2', title: 'B Chat 2', lastMessageDate: 5000, timing: { created: 5000, lastRequestStarted: 5000, lastRequestEnded: 6000 }, lastResponseState: 3 },
						},
					},
				},
			};
			storageService.store('chat.ChatSessionStore.globalIndex', JSON.stringify(index), StorageScope.APPLICATION, StorageTarget.MACHINE);

			const store = createChatSessionStore(false);
			const entries = await store.getGlobalIndex();

			assert.strictEqual(entries.length, 3, 'Should return 3 entries from 2 workspaces');
			assert.ok(entries.some(e => e.workspaceName === 'Project A'));
			assert.ok(entries.some(e => e.workspaceName === 'Project B'));
		});

		test('getGlobalIndex correctly carries storageRoot in entries', async () => {
			const storageService = instantiationService.get(IStorageService) as TestStorageService;

			const storageRootA = 'file:///workspaces/a/chatSessions';
			const index = {
				version: 1,
				workspaces: {
					'ws-a': {
						workspaceName: 'WS A',
						storageRoot: storageRootA,
						entries: {
							's1': { sessionId: 's1', title: 'Chat', lastMessageDate: Date.now(), timing: { created: Date.now(), lastRequestStarted: undefined, lastRequestEnded: Date.now() }, lastResponseState: 3 },
						},
					},
				},
			};
			storageService.store('chat.ChatSessionStore.globalIndex', JSON.stringify(index), StorageScope.APPLICATION, StorageTarget.MACHINE);

			const store = createChatSessionStore(false);
			const entries = await store.getGlobalIndex();

			assert.strictEqual(entries.length, 1);
			assert.strictEqual(entries[0].storageRoot, storageRootA, 'storageRoot should be preserved from global index');
		});
	});
});
