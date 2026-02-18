/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as paths from '../../../base/common/path.js';
import './media/sdkChatWidget.css';
import * as dom from '../../../base/browser/dom.js';
import { Codicon } from '../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { type ICopilotModelInfo, ICopilotSdkService } from '../../../platform/copilotSdk/common/copilotSdkService.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import { URI } from '../../../base/common/uri.js';
import { ITerminalService, ITerminalGroupService } from '../../../workbench/contrib/terminal/browser/terminal.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { SdkChatModel, type ISdkChatModelChange } from './sdkChatModel.js';
import { SdkContentPartRenderer, type IRenderedContentPart } from './sdkContentPartRenderer.js';
import { CopilotSdkDebugLog } from '../copilotSdkDebugLog.js';

const $ = dom.$;

interface IRenderedTurn {
	readonly turnId: string;
	readonly valueContainer: HTMLElement;
	readonly partSlots: Map<number, IRenderedContentPart>;
}

/**
 * Chat widget powered by the Copilot SDK. Renders using
 * `SdkContentPartRenderer` which produces DOM matching VS Code's
 * chat design language (using `ChatContentMarkdownRenderer`,
 * chat CSS classes, etc.).
 */
export class SdkChatWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly _messagesContainer: HTMLElement;
	private readonly _welcomeContainer: HTMLElement;
	private readonly _inputArea: HTMLElement;
	private readonly _textarea: HTMLTextAreaElement;
	private readonly _sendBtn: HTMLButtonElement;
	private readonly _abortBtn: HTMLButtonElement;
	private readonly _modelSelect: HTMLSelectElement;
	private readonly _modelLabel: HTMLElement;
	private readonly _folderBtn: HTMLSelectElement;
	private readonly _folderLabel: HTMLElement;
	private _folderPath: string | undefined;
	private readonly _statusBar: HTMLElement;
	private readonly _statusText: HTMLElement;
	private readonly _debugLinkLabel: HTMLElement;
	private readonly _worktreeBar: HTMLElement;
	private readonly _worktreeLabel: HTMLElement;
	private _worktreePath: string | undefined;

	private readonly _model: SdkChatModel;
	private readonly _partRenderer: SdkContentPartRenderer;
	private readonly _renderedTurns = new Map<string, IRenderedTurn>();

	private _sessionId: string | undefined;
	private _isStreaming = false;
	private _autoScroll = true;

	private readonly _eventDisposables = this._register(new DisposableStore());

	constructor(
		container: HTMLElement,
		@ICopilotSdkService private readonly _sdk: ICopilotSdkService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IStorageService private readonly _storageService: IStorageService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
	) {
		super();

		this._model = this._register(new SdkChatModel());
		this._partRenderer = this._instantiationService.createInstance(SdkContentPartRenderer);

		this.element = dom.append(container, $('.sdk-chat-widget'));

		// Welcome (centered hero - just a large VS Code Insiders icon + INPUT)
		this._welcomeContainer = dom.append(this.element, $('.sdk-chat-welcome'));
		const welcomeHero = dom.append(this._welcomeContainer, $('.sdk-chat-welcome-hero'));
		const heroIcon = dom.append(welcomeHero, $('.sdk-chat-welcome-icon'));
		dom.append(heroIcon, $(`span${ThemeIcon.asCSSSelector(Codicon.vscodeInsiders)}`)).classList.add('codicon');

		// Input area - built once, lives in welcome initially, moves to bottom on first send
		this._inputArea = dom.append(this._welcomeContainer, $('.sdk-chat-input-area'));
		const inputBox = dom.append(this._inputArea, $('.sdk-chat-input-box'));
		this._textarea = dom.append(inputBox, $('textarea.sdk-chat-textarea')) as HTMLTextAreaElement;
		this._textarea.placeholder = localize('sdkChat.placeholder', "Describe what to build next");
		this._textarea.rows = 1;
		const inputToolbar = dom.append(inputBox, $('.sdk-chat-input-toolbar'));

		// Left: pickers (folder + model)
		const pickerGroup = dom.append(inputToolbar, $('.sdk-chat-picker-group'));

		// Folder picker with history dropdown
		const folderPicker = dom.append(pickerGroup, $('.sdk-chat-picker.sdk-chat-model-picker'));
		dom.append(folderPicker, $(`span${ThemeIcon.asCSSSelector(Codicon.folder)}`)).classList.add('codicon');
		this._folderLabel = dom.append(folderPicker, $('span.sdk-chat-picker-label'));
		this._folderBtn = dom.append(folderPicker, $('select.sdk-chat-picker-select')) as HTMLSelectElement;
		this._initDefaultFolder();
		this._populateFolderHistory();
		this._register(dom.addDisposableListener(this._folderBtn, 'change', () => {
			const val = this._folderBtn.value;
			if (val === '__browse__') {
				this._pickFolder();
				// Reset select to current folder
				this._folderBtn.value = this._folderPath ?? '';
			} else {
				this._folderPath = val || undefined;
				this._folderLabel.textContent = val ? this._labelForPath(val) : localize('sdkChat.selectFolder', "Select folder");
				if (val) { this._addFolderToHistory(val); }
			}
		}));

		// Model picker
		const modelPicker = dom.append(pickerGroup, $('.sdk-chat-picker.sdk-chat-model-picker'));
		dom.append(modelPicker, $(`span${ThemeIcon.asCSSSelector(Codicon.vm)}`)).classList.add('codicon');
		this._modelLabel = dom.append(modelPicker, $('span.sdk-chat-picker-label'));
		this._modelLabel.textContent = localize('sdkChat.selectModel', "Select model");
		this._modelSelect = dom.append(modelPicker, $('select.sdk-chat-picker-select')) as HTMLSelectElement;
		this._register(dom.addDisposableListener(this._modelSelect, 'change', () => {
			const opt = this._modelSelect.options[this._modelSelect.selectedIndex];
			this._modelLabel.textContent = opt?.textContent ?? '';
		}));

		// Right: send/abort buttons
		const buttonGroup = dom.append(inputToolbar, $('.sdk-chat-input-buttons'));
		this._sendBtn = dom.append(buttonGroup, $('button.sdk-chat-send-btn')) as HTMLButtonElement;
		dom.append(this._sendBtn, $(`span${ThemeIcon.asCSSSelector(Codicon.arrowUp)}`)).classList.add('codicon');
		this._abortBtn = dom.append(buttonGroup, $('button.sdk-chat-abort-btn')) as HTMLButtonElement;
		dom.append(this._abortBtn, $(`span${ThemeIcon.asCSSSelector(Codicon.debugStop)}`)).classList.add('codicon');
		this._abortBtn.style.display = 'none';

		// Messages (hidden until first send)
		this._messagesContainer = dom.append(this.element, $('.sdk-chat-messages'));
		this._messagesContainer.style.display = 'none';
		this._register(dom.addDisposableListener(this._messagesContainer, 'scroll', () => {
			const { scrollTop, scrollHeight, clientHeight } = this._messagesContainer;
			this._autoScroll = scrollHeight - scrollTop - clientHeight < 50;
		}));

		// Worktree info bar (hidden until a session with a worktree is loaded)
		this._worktreeBar = dom.append(this.element, $('.sdk-chat-worktree-bar'));
		this._worktreeBar.style.display = 'none';
		const worktreeIcon = dom.append(this._worktreeBar, $(`span${ThemeIcon.asCSSSelector(Codicon.gitBranch)}`));
		worktreeIcon.classList.add('codicon');
		this._worktreeLabel = dom.append(this._worktreeBar, $('span.sdk-chat-worktree-label'));
		// Quick action: open in terminal
		const wtTermBtn = dom.append(this._worktreeBar, $('button.sdk-chat-worktree-action'));
		wtTermBtn.title = localize('sdkChat.worktree.openTerminal', "Open Terminal");
		dom.append(wtTermBtn, $(`span${ThemeIcon.asCSSSelector(Codicon.terminal)}`)).classList.add('codicon');
		this._register(dom.addDisposableListener(wtTermBtn, 'click', () => {
			const worktreePath = this._worktreePath;
			if (!worktreePath) { return; }
			this._instantiationService.invokeFunction(accessor => {
				const terminalService = accessor.get(ITerminalService);
				const terminalGroupService = accessor.get(ITerminalGroupService);
				terminalService.createTerminal({ config: { cwd: URI.file(worktreePath) } }).then(instance => {
					if (instance) { terminalService.setActiveInstance(instance); }
					terminalGroupService.showPanel(true);
				}, err => this._logService.error('[SdkChatWidget] Failed to create terminal', err));
			});
		}));
		// Quick action: open in VS Code
		const wtVscBtn = dom.append(this._worktreeBar, $('button.sdk-chat-worktree-action'));
		wtVscBtn.title = localize('sdkChat.worktree.openVSCode', "Open in VS Code");
		dom.append(wtVscBtn, $(`span${ThemeIcon.asCSSSelector(Codicon.window)}`)).classList.add('codicon');
		this._register(dom.addDisposableListener(wtVscBtn, 'click', () => {
			const worktreePath = this._worktreePath;
			if (!worktreePath) { return; }
			this._instantiationService.invokeFunction(accessor => {
				const hostService = accessor.get(IHostService);
				hostService.openWindow([{ folderUri: URI.file(worktreePath) }], { forceNewWindow: true });
			});
		}));

		// Status
		this._statusBar = dom.append(this.element, $('.sdk-chat-status'));
		this._statusText = dom.append(this._statusBar, $('span.sdk-chat-status-text'));
		this._statusText.textContent = localize('sdkChat.status.initializing', "Initializing...");
		const debugLink = dom.append(this._statusBar, $('a.sdk-chat-debug-link'));
		dom.append(debugLink, $(`span${ThemeIcon.asCSSSelector(Codicon.clippy)}`)).classList.add('codicon');
		this._debugLinkLabel = dom.append(debugLink, $('span'));
		this._debugLinkLabel.textContent = localize('sdkChat.copyDebug', "Copy Debug");
		this._register(dom.addDisposableListener(debugLink, 'click', () => this._copyDebugInfo()));

		// Wire input events
		this._register(dom.addDisposableListener(this._textarea, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._handleSend(); }
		}));
		this._register(dom.addDisposableListener(this._textarea, 'input', () => this._autoResizeTextarea()));
		this._register(dom.addDisposableListener(this._sendBtn, 'click', () => this._handleSend()));
		this._register(dom.addDisposableListener(this._abortBtn, 'click', () => this._handleAbort()));

		// Model changes -> rendering
		this._register(this._model.onDidChange(change => this._onModelChange(change)));

		// SDK events -> model
		this._subscribeToSdkEvents();

		// Init
		this._initialize();
	}

	focus(): void { this._textarea.focus(); }

	// --- Init ---

	private async _initialize(): Promise<void> {
		try {
			this._logService.info('[SdkChatWidget] Initializing - calling sdk.start()...');
			CopilotSdkDebugLog.instance?.addEntry('\u2192', 'widget.start', '');
			await this._sdk.start();
			this._logService.info('[SdkChatWidget] sdk.start() completed successfully');
			CopilotSdkDebugLog.instance?.addEntry('\u2190', 'widget.start', 'OK');

			// Check auth status
			try {
				const auth = await this._sdk.getAuthStatus();
				CopilotSdkDebugLog.instance?.addEntry('\u2190', 'widget.authStatus', auth.isAuthenticated ? `${auth.login} (${auth.authType})` : 'not authenticated');
			} catch { /* non-critical */ }

			// Load models
			this._logService.info('[SdkChatWidget] Calling sdk.listModels()...');
			CopilotSdkDebugLog.instance?.addEntry('\u2192', 'widget.listModels', '');
			const models = await this._sdk.listModels();
			this._logService.info(`[SdkChatWidget] listModels returned ${models.length} models`);
			CopilotSdkDebugLog.instance?.addEntry('\u2190', 'widget.listModels', `${models.length} models`);
			this._populateModelSelect(models);
			this._setStatus(localize('sdkChat.status.ready', "Ready"));
			this._textarea.disabled = false;
			this._sendBtn.disabled = false;
		} catch (err) {
			const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
			this._logService.error(`[SdkChatWidget] Init failed: ${msg}`);
			CopilotSdkDebugLog.instance?.addEntry('X', 'widget.init', msg);
			this._setStatus(localize('sdkChat.status.error', "Failed to connect to Copilot SDK"));
		}
	}

	private _populateModelSelect(models: ICopilotModelInfo[]): void {
		dom.clearNode(this._modelSelect);
		for (const m of models) {
			const opt = document.createElement('option');
			opt.value = m.id;
			opt.textContent = m.name ?? m.id;
			this._modelSelect.appendChild(opt);
		}
		const preferred = models.find(m => m.id === 'claude-sonnet-4') ?? models.find(m => m.id === 'gpt-4.1') ?? models[0];
		if (preferred) {
			this._modelSelect.value = preferred.id;
			this._modelLabel.textContent = preferred.name ?? preferred.id;
		}
	}

	private _initDefaultFolder(): void {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			this._folderPath = folders[0].uri.fsPath;
		}
	}

	private async _pickFolder(): Promise<void> {
		const result = await this._fileDialogService.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			title: localize('sdkChat.pickFolder', "Select Working Directory"),
		});
		if (result && result.length > 0) {
			this._folderPath = result[0].fsPath;
			this._folderLabel.textContent = this._labelForPath(result[0].fsPath);
			this._addFolderToHistory(result[0].fsPath);
			this._populateFolderHistory();
		}
	}

	private static readonly FOLDER_HISTORY_KEY = 'sdkChat.folderHistory';
	private static readonly MAX_FOLDER_HISTORY = 10;

	private _getFolderHistory(): string[] {
		const raw = this._storageService.get(SdkChatWidget.FOLDER_HISTORY_KEY, StorageScope.PROFILE, '[]');
		try { return JSON.parse(raw); } catch { return []; }
	}

	private _addFolderToHistory(path: string): void {
		const history = this._getFolderHistory().filter(p => p !== path);
		history.unshift(path);
		if (history.length > SdkChatWidget.MAX_FOLDER_HISTORY) { history.length = SdkChatWidget.MAX_FOLDER_HISTORY; }
		this._storageService.store(SdkChatWidget.FOLDER_HISTORY_KEY, JSON.stringify(history), StorageScope.PROFILE, StorageTarget.USER);
	}

	private _labelForPath(fsPath: string): string {
		return paths.basename(fsPath) || fsPath;
	}

	private _populateFolderHistory(): void {
		const select = this._folderBtn;
		dom.clearNode(select);
		const history = this._getFolderHistory();

		// Add current folder if not in history
		if (this._folderPath && !history.includes(this._folderPath)) {
			history.unshift(this._folderPath);
		}

		for (const p of history) {
			const opt = document.createElement('option');
			opt.value = p;
			opt.textContent = this._labelForPath(p);
			select.appendChild(opt);
		}

		if (history.length === 0) {
			const opt = document.createElement('option');
			opt.value = '';
			opt.textContent = localize('sdkChat.selectFolder', "Select folder");
			select.appendChild(opt);
		}

		// "Browse..." option at the end
		const browseOpt = document.createElement('option');
		browseOpt.value = '__browse__';
		browseOpt.textContent = localize('sdkChat.browse', "Browse...");
		select.appendChild(browseOpt);

		if (this._folderPath) {
			select.value = this._folderPath;
			this._folderLabel.textContent = this._labelForPath(this._folderPath);
		}
	}

	// --- SDK events -> model ---

	private _subscribeToSdkEvents(): void {
		this._eventDisposables.clear();
		this._eventDisposables.add(this._sdk.onSessionEvent(event => {
			if (this._sessionId && event.sessionId !== this._sessionId) { return; }
			this._model.handleEvent(event);

			// Update status bar with usage info
			if (event.type === 'assistant.usage') {
				const { model, inputTokens, outputTokens } = event.data;
				const input = inputTokens ?? 0;
				const output = outputTokens ?? 0;
				this._setStatus(`${model} - ${input + output} tokens (${input} in, ${output} out)`);
			}

			// When session becomes idle, refresh worktree metadata
			// (the CLI may have created a worktree during this turn)
			if (event.type === 'session.idle' && this._sessionId) {
				this._refreshWorktreeMetadata();
			}
		}));
	}

	private async _refreshWorktreeMetadata(): Promise<void> {
		if (!this._sessionId) { return; }
		try {
			const sessions = await this._sdk.listSessions();
			const meta = sessions.find(s => s.sessionId === this._sessionId);
			if (meta) {
				this._updateWorktreeBar(meta.workspacePath, meta.repository, meta.branch);
				if (meta.workspacePath && meta.workspacePath !== this._folderPath) {
					this._folderPath = meta.workspacePath;
					this._folderLabel.textContent = this._labelForPath(meta.workspacePath);
					this._addFolderToHistory(meta.workspacePath);
				}
			}
		} catch { /* non-critical */ }
	}

	// --- Model -> DOM (using SdkContentPartRenderer) ---

	private _onModelChange(change: ISdkChatModelChange): void {
		if (this._model.turns.length > 0) {
			this._welcomeContainer.style.display = 'none';
			this._messagesContainer.style.display = '';
			// Move input from welcome to bottom of widget
			if (this._inputArea.parentElement === this._welcomeContainer) {
				this.element.appendChild(this._inputArea);
			}
		}

		switch (change.type) {
			case 'turnAdded': this._renderTurn(change.turnId); break;
			case 'partAdded': this._renderPart(change.turnId, change.partIndex!); break;
			case 'partUpdated': this._updatePart(change.turnId, change.partIndex!); break;
			case 'turnCompleted': this._finalizeTurn(change.turnId); break;
		}
		this._scrollToBottom();
	}

	private _renderTurn(turnId: string): void {
		const turn = this._model.turns.find(t => t.id === turnId);
		if (!turn) { return; }

		const roleClass = turn.role === 'user' ? 'sdk-chat-request' : 'sdk-chat-response';
		const turnEl = dom.append(this._messagesContainer, $(`.sdk-chat-turn.${roleClass}`));

		// Header with avatar
		const header = dom.append(turnEl, $('.sdk-chat-header'));
		const headerUser = dom.append(header, $('.sdk-chat-header-user'));
		const avatar = dom.append(headerUser, $('.sdk-chat-avatar'));
		const headerIcon = turn.role === 'user' ? Codicon.account : Codicon.sparkle;
		dom.append(avatar, $(`span${ThemeIcon.asCSSSelector(headerIcon)}`)).classList.add('codicon');
		const username = dom.append(headerUser, $('h3.sdk-chat-username'));
		username.textContent = turn.role === 'user'
			? localize('sdkChat.you', "You")
			: localize('sdkChat.copilot', "Copilot");

		// Value container for content parts
		const valueContainer = dom.append(turnEl, $('.sdk-chat-value'));

		const rendered: IRenderedTurn = { turnId, valueContainer, partSlots: new Map() };
		this._renderedTurns.set(turnId, rendered);

		for (let i = 0; i < turn.parts.length; i++) {
			this._appendPart(turn, i, rendered);
		}
	}

	private _renderPart(turnId: string, partIndex: number): void {
		const rendered = this._renderedTurns.get(turnId);
		const turn = this._model.turns.find(t => t.id === turnId);
		if (!rendered || !turn) { return; }
		this._appendPart(turn, partIndex, rendered);
	}

	private _appendPart(turn: { parts: readonly import('./sdkChatModel.js').SdkChatPart[] }, partIndex: number, rendered: IRenderedTurn): void {
		const part = turn.parts[partIndex];
		if (!part) { return; }
		const renderedPart = this._partRenderer.render(part);
		rendered.valueContainer.appendChild(renderedPart.domNode);
		rendered.partSlots.set(partIndex, renderedPart);
	}

	private _updatePart(turnId: string, partIndex: number): void {
		const rendered = this._renderedTurns.get(turnId);
		const turn = this._model.turns.find(t => t.id === turnId);
		if (!rendered || !turn) { return; }
		const part = turn.parts[partIndex];
		const existing = rendered.partSlots.get(partIndex);
		if (!part || !existing) { return; }

		// Try in-place update; if not possible, re-render
		if (!this._partRenderer.update(part, existing)) {
			existing.dispose();
			const newPart = this._partRenderer.render(part);
			existing.domNode.replaceWith(newPart.domNode);
			rendered.partSlots.set(partIndex, newPart);
		}
	}

	private _finalizeTurn(turnId: string): void {
		const rendered = this._renderedTurns.get(turnId);
		const turn = this._model.turns.find(t => t.id === turnId);
		if (rendered) {
			// Remove streaming cursors
			for (const slot of rendered.partSlots.values()) {
				slot.domNode.classList.remove('sdk-chat-streaming-cursor');
			}

			// Collapse completed tool calls into a summary
			if (turn) {
				const toolParts = turn.parts
					.map((p, i) => ({ part: p, index: i }))
					.filter(({ part }) => part.kind === 'toolInvocation' && part.state === 'complete');

				if (toolParts.length > 1) {
					// Hide individual tool call nodes
					for (const { index } of toolParts) {
						const slot = rendered.partSlots.get(index);
						if (slot) {
							slot.domNode.style.display = 'none';
						}
					}

					// Add a summary line
					const summaryEl = dom.append(rendered.valueContainer, $('.sdk-chat-tool-summary'));
					const iconEl = dom.append(summaryEl, $(`span${ThemeIcon.asCSSSelector(Codicon.check)}`));
					iconEl.classList.add('codicon');
					const textEl = dom.append(summaryEl, $('span.sdk-chat-tool-summary-text'));
					textEl.textContent = localize('sdkChat.tool.summary', "Used {0} tools", toolParts.length);

					// Click to expand/collapse
					let expanded = false;
					dom.addDisposableListener(summaryEl, 'click', () => {
						expanded = !expanded;
						for (const { index } of toolParts) {
							const slot = rendered.partSlots.get(index);
							if (slot) {
								slot.domNode.style.display = expanded ? '' : 'none';
							}
						}
						summaryEl.classList.toggle('expanded', expanded);
					});
				}
			}
		}
		this._setStreaming(false);
		this._setStatus(localize('sdkChat.status.ready', "Ready"));
	}

	// --- Send / Abort ---

	private async _handleSend(): Promise<void> {
		const prompt = this._textarea.value.trim();
		if (!prompt || this._isStreaming) { return; }

		this._textarea.value = '';
		this._autoResizeTextarea();
		this._model.addUserMessage(prompt);
		this._setStreaming(true);

		try {
			if (!this._sessionId) {
				const model = this._modelSelect.value;
				const workingDirectory = this._folderPath || undefined;
				if (workingDirectory) { this._addFolderToHistory(workingDirectory); }
				this._setStatus(localize('sdkChat.status.creating', "Creating session..."));
				CopilotSdkDebugLog.instance?.addEntry('\u2192', 'widget.createSession', JSON.stringify({ model, workingDirectory }));
				this._sessionId = await this._sdk.createSession({ model, streaming: true, workingDirectory });
				CopilotSdkDebugLog.instance?.addEntry('\u2190', 'widget.createSession', this._sessionId.substring(0, 8));

			}

			this._setStatus(localize('sdkChat.status.thinking', "Thinking..."));
			CopilotSdkDebugLog.instance?.addEntry('\u2192', 'widget.send', prompt.substring(0, 80));
			await this._sdk.send(this._sessionId, prompt);
			CopilotSdkDebugLog.instance?.addEntry('\u2190', 'widget.send', 'queued');
		} catch (err) {
			this._logService.error('[SdkChatWidget] Send failed:', err);
			this._setStreaming(false);
			this._setStatus(localize('sdkChat.status.sendFailed', "Send failed"));
		}
	}

	private async _handleAbort(): Promise<void> {
		if (!this._sessionId) { return; }
		try {
			CopilotSdkDebugLog.instance?.addEntry('\u2192', 'widget.abort', this._sessionId.substring(0, 8));
			await this._sdk.abort(this._sessionId);
			CopilotSdkDebugLog.instance?.addEntry('\u2190', 'widget.abort', 'OK');
		} catch (err) {
			this._logService.error('[SdkChatWidget] Abort failed:', err);
		}
	}

	// --- UI helpers ---

	private _setStreaming(streaming: boolean): void {
		this._isStreaming = streaming;
		this._sendBtn.style.display = streaming ? 'none' : '';
		this._abortBtn.style.display = streaming ? '' : 'none';
		this._textarea.disabled = streaming;
	}

	private _setStatus(text: string): void {
		this._statusText.textContent = text;
	}

	private async _copyDebugInfo(): Promise<void> {
		const debug: Record<string, unknown> = {
			sessionId: this._sessionId,
			isStreaming: this._isStreaming,
			turns: this._model.turns.map(t => ({
				id: t.id,
				role: t.role,
				isComplete: t.isComplete,
				parts: t.parts.map(p => {
					switch (p.kind) {
						case 'markdownContent': return { kind: p.kind, length: p.content.value.length, isStreaming: p.isStreaming, preview: p.content.value.substring(0, 100) };
						case 'thinking': return { kind: p.kind, length: p.content.length, isStreaming: p.isStreaming };
						case 'toolInvocation': return { kind: p.kind, toolName: p.toolName, state: p.state, toolCallId: p.toolCallId };
						case 'progress': return { kind: p.kind, message: p.message };
					}
				}),
			})),
		};
		if (this._sessionId) {
			try {
				const events = await this._sdk.getMessages(this._sessionId);
				debug.rawEvents = events.map(e => ({ type: e.type, data: e.data }));
				debug.rawEventCount = events.length;
			} catch { /* session may be destroyed */ }
		}
		await this._clipboardService.writeText(JSON.stringify(debug, null, 2));
		const original = this._debugLinkLabel.textContent;
		this._debugLinkLabel.textContent = localize('sdkChat.copied', "Copied!");
		setTimeout(() => { this._debugLinkLabel.textContent = original; }, 1500);
	}

	private _updateWorktreeBar(workspacePath?: string, repository?: string, branch?: string): void {
		this._worktreePath = workspacePath;
		if (workspacePath || repository) {
			this._worktreeBar.style.display = '';
			const parts: string[] = [];
			if (repository) { parts.push(repository); }
			if (branch) { parts.push(branch); }
			if (workspacePath) { parts.push(workspacePath); }
			this._worktreeLabel.textContent = parts.join(' - ');
		} else {
			this._worktreeBar.style.display = 'none';
		}
	}

	private _scrollToBottom(): void {
		if (this._autoScroll) { this._messagesContainer.scrollTop = this._messagesContainer.scrollHeight; }
	}

	private _autoResizeTextarea(): void {
		this._textarea.style.height = 'auto';
		this._textarea.style.height = `${Math.min(this._textarea.scrollHeight, 200)}px`;
	}

	// --- Public API ---

	async newSession(): Promise<void> {
		if (this._sessionId) {
			try { await this._sdk.destroySession(this._sessionId); } catch { /* best-effort */ }
		}
		this._sessionId = undefined;
		this._model.clear();
		this._disposeRenderedTurns();
		dom.clearNode(this._messagesContainer);
		this._messagesContainer.style.display = 'none';
		this._welcomeContainer.style.display = '';
		// Move input back into welcome center
		this._welcomeContainer.appendChild(this._inputArea);
		this._setStreaming(false);
		this._setStatus(localize('sdkChat.status.ready', "Ready"));
		this._updateWorktreeBar();
		this._textarea.focus();
	}

	async loadSession(sessionId: string): Promise<void> {
		if (this._sessionId === sessionId) { return; }

		this._model.clear();
		this._disposeRenderedTurns();
		dom.clearNode(this._messagesContainer);

		this._sessionId = sessionId;

		try {
			CopilotSdkDebugLog.instance?.addEntry('\u2192', 'widget.loadSession', sessionId.substring(0, 8));
			await this._sdk.resumeSession(sessionId, { streaming: true });

			// Update folder picker from session metadata
			const sessions = await this._sdk.listSessions();
			const meta = sessions.find(s => s.sessionId === sessionId);
			if (meta?.workspacePath) {
				this._folderPath = meta.workspacePath;
				this._folderLabel.textContent = this._labelForPath(meta.workspacePath);
				this._addFolderToHistory(meta.workspacePath);
				this._populateFolderHistory();
			}
			// Show worktree info bar
			this._updateWorktreeBar(meta?.workspacePath, meta?.repository, meta?.branch);
			if (meta?.repository) {
				const repoInfo = meta.branch ? `${meta.repository}:${meta.branch}` : meta.repository;
				this._setStatus(`${repoInfo} - ${meta.workspacePath ?? 'no worktree'}`);
			}

			const events = await this._sdk.getMessages(sessionId);
			CopilotSdkDebugLog.instance?.addEntry('\u2190', 'widget.loadSession', `${events.length} events`);

			this._welcomeContainer.style.display = 'none';
			this._messagesContainer.style.display = '';
			// Move input from welcome to bottom of widget
			if (this._inputArea.parentElement === this._welcomeContainer) {
				this.element.appendChild(this._inputArea);
			}

			for (const event of events) { this._model.handleEvent(event); }
			this._setStreaming(false);
			this._setStatus(localize('sdkChat.status.ready', "Ready"));
		} catch (err) {
			this._logService.error(`[SdkChatWidget] Load session failed:`, err);
			this._setStatus(localize('sdkChat.status.loadFailed', "Failed to load session"));
		}
		this._scrollToBottom();
	}

	private _disposeRenderedTurns(): void {
		for (const turn of this._renderedTurns.values()) {
			for (const slot of turn.partSlots.values()) {
				slot.dispose();
			}
		}
		this._renderedTurns.clear();
	}

	override dispose(): void {
		this._disposeRenderedTurns();
		super.dispose();
	}
}
