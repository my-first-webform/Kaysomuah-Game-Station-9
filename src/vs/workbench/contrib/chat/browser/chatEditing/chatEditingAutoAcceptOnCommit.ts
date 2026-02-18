/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ISCMRepository, ISCMService } from '../../../scm/common/scm.js';
import { IChatEditingService, ModifiedFileEntryState } from '../../common/editing/chatEditingService.js';

/**
 * Automatically accepts (keeps) pending chat edits for files that are committed
 * through the SCM (e.g., via `git commit`).
 *
 * Strategy: continuously track the set of staged file URIs. When the SCM
 * provider's commit command executes, accept any pending chat editing entries
 * whose URI was among the staged files.
 */
export class ChatEditingAutoAcceptOnCommit extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'chat.editing.autoAcceptOnCommit';

	constructor(
		@ISCMService private readonly scmService: ISCMService,
		@IChatEditingService private readonly chatEditingService: IChatEditingService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		for (const repo of this.scmService.repositories) {
			this._watchRepository(repo);
		}
		this._register(this.scmService.onDidAddRepository(repo => this._watchRepository(repo)));
		this._register(this.scmService.onDidRemoveRepository(repo => {
			this._repoDisposableMap.get(repo.id)?.dispose();
			this._repoDisposableMap.delete(repo.id);
		}));
	}

	private readonly _repoDisposableMap = new Map<string, DisposableStore>();

	private _watchRepository(repo: ISCMRepository): void {
		const repoStore = new DisposableStore();
		this._repoDisposableMap.set(repo.id, repoStore);
		this._register(repoStore);

		// Continuously track the set of staged file URIs
		let stagedUris = this._getStagedUris(repo);

		repoStore.add(repo.provider.onDidChangeResourceGroups(() => {
			stagedUris = this._getStagedUris(repo);
		}));
		repoStore.add(repo.provider.onDidChangeResources(() => {
			stagedUris = this._getStagedUris(repo);
		}));

		// When the commit command fires, auto-accept edits for staged files
		repoStore.add(this.commandService.onDidExecuteCommand(e => {
			const acceptCmd = repo.provider.acceptInputCommand;
			if (!acceptCmd || e.commandId !== acceptCmd.id) {
				return;
			}
			this._autoAcceptStagedFiles(stagedUris);
		}));
	}

	private _getStagedUris(repo: ISCMRepository): Set<string> {
		const indexGroup = repo.provider.groups.find(g => g.id === 'index');
		if (!indexGroup) {
			return new Set();
		}
		return new Set(indexGroup.resources.map(r => r.sourceUri.toString()));
	}

	private _autoAcceptStagedFiles(stagedUris: Set<string>): void {
		if (stagedUris.size === 0) {
			return;
		}

		for (const session of this.chatEditingService.editingSessionsObs.get()) {
			const urisToAccept: URI[] = [];

			for (const entry of session.entries.get()) {
				if (entry.state.get() !== ModifiedFileEntryState.Modified) {
					continue;
				}
				if (stagedUris.has(entry.modifiedURI.toString())) {
					urisToAccept.push(entry.modifiedURI);
				}
			}

			if (urisToAccept.length > 0) {
				this.logService.info(`[ChatEditingAutoAcceptOnCommit] Auto-accepting ${urisToAccept.length} file(s) on commit`);
				session.accept(...urisToAccept);
			}
		}
	}
}
