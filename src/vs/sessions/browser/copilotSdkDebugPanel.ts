/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Temporary RPC debug UI for the Copilot SDK integration.
 * Shows the raw event stream and provides helper buttons for common RPC calls.
 * Delete this entire file to remove the debug panel.
 */

import './media/copilotSdkDebugPanel.css';
import * as dom from '../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import { ICopilotSdkService } from '../../platform/copilotSdk/common/copilotSdkService.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { CopilotSdkDebugLog, IDebugLogEntry } from './copilotSdkDebugLog.js';
import { IDialogService } from '../../platform/dialogs/common/dialogs.js';
import { localize } from '../../nls.js';

const $ = dom.$;

export class CopilotSdkDebugPanel extends Disposable {

	readonly element: HTMLElement;

	private readonly _rpcLogContainer: HTMLElement;
	private readonly _processLogContainer: HTMLElement;
	private readonly _sessionInfoContainer: HTMLElement;
	private readonly _inputArea: HTMLTextAreaElement;
	private readonly _statusBar: HTMLElement;
	private readonly _cwdInput: HTMLInputElement;
	private readonly _modelSelect: HTMLSelectElement;
	private _sessionId: string | undefined;
	private _activeTab: 'rpc' | 'process' | 'info' = 'rpc';

	private readonly _eventDisposables = this._register(new DisposableStore());
	private readonly _sessionInfoDisposables = this._register(new DisposableStore());

	constructor(
		container: HTMLElement,
		private readonly _debugLog: CopilotSdkDebugLog,
		@ICopilotSdkService private readonly _sdk: ICopilotSdkService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IDialogService private readonly _dialogService: IDialogService,
	) {
		super();

		this.element = dom.append(container, $('.copilot-sdk-debug-panel'));

		// Header
		const header = dom.append(this.element, $('.debug-panel-header'));
		dom.append(header, $('span')).textContent = 'Copilot SDK RPC Debug';
		const clearBtn = dom.append(header, $('button')) as HTMLButtonElement;
		clearBtn.textContent = 'Clear';
		clearBtn.style.cssText = 'margin-left:auto;font-size:11px;padding:2px 8px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;cursor:pointer;';
		this._register(dom.addDisposableListener(clearBtn, 'click', () => {
			if (this._activeTab === 'rpc') {
				dom.clearNode(this._rpcLogContainer);
				this._debugLog.clear('rpc');
			} else {
				dom.clearNode(this._processLogContainer);
				this._debugLog.clear('process');
			}
		}));

		const copyBtn = dom.append(header, $('button')) as HTMLButtonElement;
		copyBtn.textContent = 'Copy All';
		copyBtn.style.cssText = 'margin-left:4px;font-size:11px;padding:2px 8px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;cursor:pointer;';
		this._register(dom.addDisposableListener(copyBtn, 'click', () => {
			const stream = this._activeTab === 'rpc' ? 'rpc' : 'process';
			const lines = this._debugLog.entries
				.filter(e => e.stream === stream)
				.map(e => `${String(e.id).padStart(3, '0')} ${e.direction} ${e.tag ? `[${e.tag}] ` : ''}${e.method} ${e.detail} ${e.timestamp}`);
			this._clipboardService.writeText(lines.join('\n'));
			copyBtn.textContent = 'Copied!';
			setTimeout(() => { copyBtn.textContent = 'Copy All'; }, 1500);
		}));

		// Status
		this._statusBar = dom.append(this.element, $('.debug-panel-status'));
		this._statusBar.textContent = 'Not connected';

		// Config row: model + cwd
		const configRow = dom.append(this.element, $('.debug-panel-model-row'));
		dom.append(configRow, $('label')).textContent = 'Model:';
		this._modelSelect = dom.append(configRow, $('select.debug-panel-model-select')) as HTMLSelectElement;

		const cwdRow = dom.append(this.element, $('.debug-panel-model-row'));
		dom.append(cwdRow, $('label')).textContent = 'CWD:';
		this._cwdInput = dom.append(cwdRow, $('input.debug-panel-model-select')) as HTMLInputElement;
		this._cwdInput.type = 'text';
		this._cwdInput.placeholder = '/path/to/project';
		this._cwdInput.value = '/tmp';

		// Helper buttons - organized in rows
		const helpers = dom.append(this.element, $('.debug-panel-helpers'));
		// allow-any-unicode-next-line
		const btns: Array<{ label: string; fn: () => void }> = [
			// Lifecycle
			{ label: '> Start', fn: () => this._rpc('start') },
			{ label: 'Stop', fn: () => this._rpc('stop') },
			// Discovery
			{ label: 'List Models', fn: () => this._rpc('listModels') },
			{ label: 'List Sessions', fn: () => this._rpc('listSessions') },
			// Session management
			{ label: '+ Create Session', fn: () => this._rpc('createSession') },
			{ label: 'Resume Session', fn: () => this._rpc('resumeSession') },
			{ label: 'Get Messages', fn: () => this._rpc('getMessages') },
			{ label: 'Destroy Session', fn: () => this._rpc('destroySession') },
			{ label: 'Delete Session', fn: () => this._rpc('deleteSession') },
			// Messaging
			{ label: 'Send', fn: () => this._rpc('send') },
			{ label: 'Send + Wait', fn: () => this._rpc('sendAndWait') },
			{ label: 'Abort', fn: () => this._rpc('abort') },
			// Auth
			{ label: 'Set Token', fn: () => this._rpc('setGitHubToken') },
			// Status/Health
			{ label: 'Ping', fn: () => this._rpc('ping') },
			{ label: 'CLI Status', fn: () => this._rpc('getStatus') },
			{ label: 'Auth Status', fn: () => this._rpc('getAuthStatus') },
			// Debug
			{ label: 'Dump Sessions (JSON)', fn: () => this._dumpSessionsJson() },
			{ label: 'DELETE ALL SESSIONS', fn: () => this._deleteAllSessions() },
		];
		for (const { label, fn } of btns) {
			const btn = dom.append(helpers, $('button.debug-helper-btn')) as HTMLButtonElement;
			btn.textContent = label;
			this._register(dom.addDisposableListener(btn, 'click', fn));
		}

		// Tab bar
		const tabBar = dom.append(this.element, $('.debug-panel-tabs'));
		const rpcTab = dom.append(tabBar, $('button.debug-tab.debug-tab-active')) as HTMLButtonElement;
		rpcTab.textContent = 'RPC Log';
		const processTab = dom.append(tabBar, $('button.debug-tab')) as HTMLButtonElement;
		processTab.textContent = 'Process Output';
		const infoTab = dom.append(tabBar, $('button.debug-tab')) as HTMLButtonElement;
		infoTab.textContent = 'Session Info';
		const switchTab = (tab: 'rpc' | 'process' | 'info') => {
			this._activeTab = tab;
			rpcTab.classList.toggle('debug-tab-active', tab === 'rpc');
			processTab.classList.toggle('debug-tab-active', tab === 'process');
			infoTab.classList.toggle('debug-tab-active', tab === 'info');
			this._rpcLogContainer.style.display = tab === 'rpc' ? '' : 'none';
			this._processLogContainer.style.display = tab === 'process' ? '' : 'none';
			this._sessionInfoContainer.style.display = tab === 'info' ? '' : 'none';
			if (tab === 'info') { this._refreshSessionInfo(); }
		};
		this._register(dom.addDisposableListener(rpcTab, 'click', () => switchTab('rpc')));
		this._register(dom.addDisposableListener(processTab, 'click', () => switchTab('process')));
		this._register(dom.addDisposableListener(infoTab, 'click', () => switchTab('info')));

		// RPC log stream
		this._rpcLogContainer = dom.append(this.element, $('.debug-panel-messages'));

		// Process output log
		this._processLogContainer = dom.append(this.element, $('.debug-panel-messages'));
		this._processLogContainer.style.display = 'none';

		// Session info dump
		this._sessionInfoContainer = dom.append(this.element, $('.debug-panel-messages'));
		this._sessionInfoContainer.style.display = 'none';
		this._sessionInfoContainer.style.whiteSpace = 'pre-wrap';
		this._sessionInfoContainer.style.fontFamily = 'var(--monaco-monospace-font)';
		this._sessionInfoContainer.style.fontSize = '11px';
		this._sessionInfoContainer.style.padding = '8px';

		// Free-form input for sending prompts
		const inputRow = dom.append(this.element, $('.debug-panel-input-row'));
		this._inputArea = dom.append(inputRow, $('textarea.debug-panel-input')) as HTMLTextAreaElement;
		this._inputArea.placeholder = 'Message prompt (used by Send Message)...';
		this._inputArea.rows = 2;

		// Replay buffered log entries, then subscribe for new ones
		this._replayAndSubscribe();
		this._initializeModels();
	}

	/**
	 * Render all buffered log entries then subscribe for new ones.
	 */
	private _replayAndSubscribe(): void {
		for (const entry of this._debugLog.entries) {
			this._renderEntry(entry);
		}

		this._eventDisposables.clear();
		this._eventDisposables.add(this._debugLog.onDidAddEntry(entry => {
			this._renderEntry(entry);
		}));
	}

	private _renderEntry(entry: IDebugLogEntry): void {
		if (entry.stream === 'process') {
			this._renderProcessEntry(entry);
		} else {
			this._renderRpcEntry(entry);
		}
	}

	private _renderRpcEntry(entry: IDebugLogEntry): void {
		const el = dom.append(this._rpcLogContainer, $('.debug-rpc-entry'));

		const num = dom.append(el, $('span.debug-rpc-num'));
		num.textContent = String(entry.id).padStart(3, '0');

		const dir = dom.append(el, $('span.debug-rpc-dir'));
		dir.textContent = entry.direction;

		if (entry.tag) {
			const tagEl = dom.append(el, $('span.debug-rpc-tag'));
			tagEl.textContent = entry.tag;
		}

		const meth = dom.append(el, $('span.debug-rpc-method'));
		meth.textContent = entry.method;

		if (entry.detail) {
			const det = dom.append(el, $('span.debug-rpc-detail'));
			det.textContent = entry.detail;
		}

		const time = dom.append(el, $('span.debug-rpc-time'));
		time.textContent = entry.timestamp;

		this._rpcLogContainer.scrollTop = this._rpcLogContainer.scrollHeight;
	}

	private _renderProcessEntry(entry: IDebugLogEntry): void {
		const el = dom.append(this._processLogContainer, $('.debug-rpc-entry'));
		const time = dom.append(el, $('span.debug-rpc-time'));
		time.textContent = entry.timestamp;
		const streamTag = dom.append(el, $('span.debug-rpc-tag'));
		streamTag.textContent = entry.method; // method holds the stream name for process entries
		const content = dom.append(el, $('span.debug-rpc-detail'));
		content.textContent = entry.detail;
		content.style.whiteSpace = 'pre-wrap';
		content.style.flex = '1';

		this._processLogContainer.scrollTop = this._processLogContainer.scrollHeight;
	}

	private async _initializeModels(): Promise<void> {
		try {
			this._setStatus('Loading models...');
			const models = await this._sdk.listModels();

			dom.clearNode(this._modelSelect);
			for (const m of models) {
				const opt = document.createElement('option');
				opt.value = m.id;
				opt.textContent = m.name ?? m.id;
				this._modelSelect.appendChild(opt);
			}
			const def = models.find(m => m.id === 'gpt-4.1') ?? models[0];
			if (def) { this._modelSelect.value = def.id; }

			this._setStatus('Ready');
		} catch (err) {
			this._debugLog.addEntry('X', 'init', String(err));
			this._setStatus('Error');
		}
	}

	private async _rpc(method: string): Promise<void> {
		try {
			switch (method) {
				case 'start': {
					this._debugLog.addEntry('\u2192', 'start', '');
					await this._sdk.start();
					this._debugLog.addEntry('\u2190', 'start', 'OK');
					break;
				}
				case 'stop': {
					this._debugLog.addEntry('\u2192', 'stop', '');
					await this._sdk.stop();
					this._sessionId = undefined;
					this._debugLog.addEntry('\u2190', 'stop', 'OK');
					break;
				}
				case 'listModels': {
					this._debugLog.addEntry('\u2192', 'listModels', '');
					const models = await this._sdk.listModels();
					this._debugLog.addEntry('\u2190', 'listModels', JSON.stringify(models.map(m => m.id)));
					break;
				}
				case 'listSessions': {
					this._debugLog.addEntry('\u2192', 'listSessions', '');
					const sessions = await this._sdk.listSessions();
					this._debugLog.addEntry('\u2190', 'listSessions', JSON.stringify(sessions));
					break;
				}
				case 'createSession': {
					const model = this._modelSelect.value;
					const cwd = this._cwdInput.value.trim() || undefined;
					this._debugLog.addEntry('\u2192', 'createSession', JSON.stringify({ model, streaming: true, workingDirectory: cwd }));
					this._sessionId = await this._sdk.createSession({ model, streaming: true, workingDirectory: cwd });
					this._debugLog.addEntry('\u2190', 'createSession', this._sessionId);
					this._setStatus(`Session: ${this._sessionId.substring(0, 8)}...`);
					break;
				}
				case 'send': {
					if (!this._sessionId) {
						this._debugLog.addEntry('X', 'send', 'No session -- create one first');
						return;
					}
					const prompt = this._inputArea.value.trim() || 'What is 2+2? Answer in one word.';
					this._debugLog.addEntry('\u2192', 'send', JSON.stringify({ sessionId: this._sessionId.substring(0, 8), prompt: prompt.substring(0, 100) }));
					this._setStatus('Sending...');
					await this._sdk.send(this._sessionId, prompt);
					this._debugLog.addEntry('\u2190', 'send', 'queued');
					break;
				}
				case 'abort': {
					if (!this._sessionId) { this._debugLog.addEntry('X', 'abort', 'No session'); return; }
					this._debugLog.addEntry('\u2192', 'abort', this._sessionId.substring(0, 8));
					await this._sdk.abort(this._sessionId);
					this._debugLog.addEntry('\u2190', 'abort', 'OK');
					break;
				}
				case 'destroySession': {
					if (!this._sessionId) { this._debugLog.addEntry('X', 'destroySession', 'No session'); return; }
					this._debugLog.addEntry('\u2192', 'destroySession', this._sessionId.substring(0, 8));
					await this._sdk.destroySession(this._sessionId);
					this._debugLog.addEntry('\u2190', 'destroySession', 'OK');
					this._sessionId = undefined;
					this._setStatus('Ready');
					break;
				}
				case 'deleteSession': {
					if (!this._sessionId) { this._debugLog.addEntry('X', 'deleteSession', 'No session'); return; }
					this._debugLog.addEntry('\u2192', 'deleteSession', this._sessionId.substring(0, 8));
					await this._sdk.deleteSession(this._sessionId);
					this._debugLog.addEntry('\u2190', 'deleteSession', 'OK');
					this._sessionId = undefined;
					this._setStatus('Ready');
					break;
				}
				case 'resumeSession': {
					if (!this._sessionId) { this._debugLog.addEntry('X', 'resumeSession', 'No session'); return; }
					this._debugLog.addEntry('\u2192', 'resumeSession', this._sessionId.substring(0, 8));
					await this._sdk.resumeSession(this._sessionId, { streaming: true });
					this._debugLog.addEntry('\u2190', 'resumeSession', 'OK');
					break;
				}
				case 'getMessages': {
					if (!this._sessionId) { this._debugLog.addEntry('X', 'getMessages', 'No session'); return; }
					this._debugLog.addEntry('\u2192', 'getMessages', this._sessionId.substring(0, 8));
					const messages = await this._sdk.getMessages(this._sessionId);
					const summary = messages.map(m => m.type).join(', ');
					this._debugLog.addEntry('\u2190', 'getMessages', `${messages.length} events: ${summary.substring(0, 200)}`);
					break;
				}
				case 'sendAndWait': {
					if (!this._sessionId) { this._debugLog.addEntry('X', 'sendAndWait', 'No session'); return; }
					const swPrompt = this._inputArea.value.trim() || 'What is 2+2? Answer in one word.';
					this._debugLog.addEntry('\u2192', 'sendAndWait', JSON.stringify({ sessionId: this._sessionId.substring(0, 8), prompt: swPrompt.substring(0, 100) }));
					this._setStatus('Sending (wait)...');
					const result = await this._sdk.sendAndWait(this._sessionId, swPrompt);
					this._debugLog.addEntry('\u2190', 'sendAndWait', result ? result.content.substring(0, 200) : 'undefined');
					this._setStatus(`Session: ${this._sessionId.substring(0, 8)}...`);
					break;
				}
				case 'setGitHubToken': {
					const token = this._inputArea.value.trim();
					if (!token) { this._debugLog.addEntry('X', 'setGitHubToken', 'Enter token in the text area'); return; }
					this._debugLog.addEntry('\u2192', 'setGitHubToken', `${token.substring(0, 4)}...`);
					await this._sdk.setGitHubToken(token);
					this._debugLog.addEntry('\u2190', 'setGitHubToken', 'OK');
					break;
				}
				case 'ping': {
					this._debugLog.addEntry('\u2192', 'ping', 'ping');
					const pong = await this._sdk.ping('ping');
					this._debugLog.addEntry('\u2190', 'ping', String(pong));
					break;
				}
				case 'getStatus': {
					this._debugLog.addEntry('\u2192', 'getStatus', '');
					const status = await this._sdk.getStatus();
					this._debugLog.addEntry('\u2190', 'getStatus', JSON.stringify(status));
					this._setStatus(`CLI v${status.version} (protocol ${status.protocolVersion})`);
					break;
				}
				case 'getAuthStatus': {
					this._debugLog.addEntry('\u2192', 'getAuthStatus', '');
					const auth = await this._sdk.getAuthStatus();
					this._debugLog.addEntry('\u2190', 'getAuthStatus', JSON.stringify(auth));
					this._setStatus(auth.isAuthenticated ? `Authenticated as ${auth.login} (${auth.authType})` : 'Not authenticated');
					break;
				}
			}
		} catch (err) {
			this._debugLog.addEntry('X', method, String(err instanceof Error ? err.message : err));
		}
	}

	private async _deleteAllSessions(): Promise<void> {
		const confirmation = await this._dialogService.confirm({
			message: localize('sdkDebug.deleteAll', "Delete all sessions?"),
			detail: localize('sdkDebug.deleteAll.detail', "This cannot be undone."),
			primaryButton: localize('delete', "Delete"),
			cancelButton: localize('cancel', "Cancel"),
		});
		if (!confirmation.confirmed) {
			this._debugLog.addEntry('!', 'deleteAll', 'Cancelled by user');
			return;
		}
		try {
			const sessions = await this._sdk.listSessions();
			this._debugLog.addEntry('\u2192', 'deleteAll', `Deleting ${sessions.length} sessions...`);
			let deleted = 0;
			let failed = 0;
			for (const s of sessions) {
				try {
					await this._sdk.deleteSession(s.sessionId);
					deleted++;
				} catch {
					failed++;
				}
			}
			this._sessionId = undefined;
			this._debugLog.addEntry('\u2190', 'deleteAll', `Done: ${deleted} deleted, ${failed} failed`);
			this._setStatus(`Deleted ${deleted} sessions`);
		} catch (err) {
			this._debugLog.addEntry('X', 'deleteAll', String(err));
		}
	}

	private async _dumpSessionsJson(): Promise<void> {
		try {
			this._debugLog.addEntry('\u2192', 'dumpSessions', 'Fetching all sessions + messages...');
			const sessions = await this._sdk.listSessions();
			const dump: Array<{ meta: typeof sessions[0]; eventCount: number; eventTypes: Record<string, number> }> = [];
			for (const s of sessions) {
				try {
					const events = await this._sdk.getMessages(s.sessionId);
					const types: Record<string, number> = {};
					for (const ev of events) { types[ev.type] = (types[ev.type] ?? 0) + 1; }
					dump.push({ meta: s, eventCount: events.length, eventTypes: types });
				} catch {
					dump.push({ meta: s, eventCount: -1, eventTypes: {} });
				}
			}
			const json = JSON.stringify(dump, null, 2);
			this._debugLog.addEntry('\u2190', 'dumpSessions', `${sessions.length} sessions dumped (${json.length} bytes)`);
			await this._clipboardService.writeText(json);
			this._setStatus('Session dump copied to clipboard');
		} catch (err) {
			this._debugLog.addEntry('X', 'dumpSessions', String(err));
		}
	}

	private _setStatus(text: string): void {
		this._statusBar.textContent = text;
	}

	/**
	 * Refresh the Session Info tab with comprehensive debug information.
	 */
	private async _refreshSessionInfo(): Promise<void> {
		this._sessionInfoDisposables.clear();
		dom.clearNode(this._sessionInfoContainer);

		const add = (label: string, value: string, color?: string) => {
			const line = dom.append(this._sessionInfoContainer, $('div'));
			line.style.marginBottom = '2px';
			const labelEl = dom.append(line, $('span'));
			labelEl.textContent = label + ': ';
			labelEl.style.color = 'var(--vscode-descriptionForeground)';
			const valueEl = dom.append(line, $('span'));
			valueEl.textContent = value;
			if (color) { valueEl.style.color = color; }
		};

		const section = (title: string) => {
			const h = dom.append(this._sessionInfoContainer, $('div'));
			h.style.cssText = 'margin:8px 0 4px;font-weight:bold;color:var(--vscode-foreground);border-bottom:1px solid var(--vscode-widget-border);padding-bottom:2px;';
			h.textContent = title;
		};

		// SDK State
		section('SDK STATE');
		add('Debug panel session ID', this._sessionId ?? '(none)');
		add('Log entries (RPC)', String(this._debugLog.entries.filter(e => e.stream === 'rpc').length));
		add('Log entries (process)', String(this._debugLog.entries.filter(e => e.stream === 'process').length));

		// CLI Status
		section('CLI STATUS');
		try {
			const status = await this._sdk.getStatus();
			add('CLI version', status.version);
			add('Protocol version', String(status.protocolVersion));
		} catch (err) {
			add('Error', String(err));
		}

		// Auth Status
		section('AUTHENTICATION');
		try {
			const auth = await this._sdk.getAuthStatus();
			add('Authenticated', auth.isAuthenticated ? 'Yes' : 'No', auth.isAuthenticated ? 'var(--vscode-terminal-ansiGreen)' : 'var(--vscode-errorForeground)');
			if (auth.login) { add('Login', auth.login); }
			if (auth.authType) { add('Auth type', auth.authType); }
			if (auth.host) { add('Host', auth.host); }
			if (auth.statusMessage) { add('Status', auth.statusMessage); }
		} catch (err) {
			add('Error', String(err));
		}

		// All sessions
		section('ALL SESSIONS');
		try {
			const sessions = await this._sdk.listSessions();
			add('Total sessions', String(sessions.length));
			for (const s of sessions) {
				const line = dom.append(this._sessionInfoContainer, $('div'));
				line.style.cssText = 'margin:4px 0;padding:4px 6px;border-radius:3px;background:var(--vscode-editor-inactiveSelectionBackground);';
				const idEl = dom.append(line, $('div'));
				idEl.style.cssText = 'font-weight:bold;color:var(--vscode-textLink-foreground);';
				idEl.textContent = `Session ${s.sessionId.substring(0, 12)}`;
				if (s.summary) { add('  Summary', s.summary); }
				if (s.workspacePath) { add('  Workspace path', s.workspacePath, 'var(--vscode-terminal-ansiGreen)'); }
				if (s.repository) { add('  Repository', s.repository); }
				if (s.branch) { add('  Branch', s.branch); }
				if (s.startTime) { add('  Started', new Date(s.startTime).toLocaleString()); }
				if (s.modifiedTime) { add('  Modified', new Date(s.modifiedTime).toLocaleString()); }
				add('  Remote', s.isRemote ? 'Yes' : 'No');

				// Get messages for this session to show event breakdown
				try {
					const events = await this._sdk.getMessages(s.sessionId);
					const typeCounts: Record<string, number> = {};
					for (const ev of events) {
						typeCounts[ev.type] = (typeCounts[ev.type] ?? 0) + 1;
					}
					add('  Events', `${events.length} total`);
					for (const [type, count] of Object.entries(typeCounts)) {
						add(`    ${type}`, String(count));
					}
				} catch {
					add('  Events', '(failed to load)');
				}
			}
		} catch (err) {
			add('Error loading sessions', String(err));
		}

		// Models
		section('AVAILABLE MODELS');
		try {
			const models = await this._sdk.listModels();
			add('Total models', String(models.length));
			for (const m of models) {
				const caps = m.capabilities?.supports;
				const flags: string[] = [];
				if (caps?.vision) { flags.push('vision'); }
				if (caps?.reasoningEffort) { flags.push('reasoning'); }
				if (m.billing?.multiplier && m.billing.multiplier > 1) { flags.push(`${m.billing.multiplier}x cost`); }
				const ctx = m.capabilities?.limits?.max_context_window_tokens;
				if (ctx) { flags.push(`${Math.round(ctx / 1000)}k ctx`); }
				const policy = m.policy?.state;
				if (policy && policy !== 'enabled') { flags.push(policy); }
				const label = flags.length > 0 ? `${m.name ?? m.id} [${flags.join(', ')}]` : (m.name ?? m.id);
				add(`  ${m.id}`, label);
			}
		} catch (err) {
			add('Error loading models', String(err));
		}

		// Event stats from debug log
		section('EVENT STATISTICS (from debug log)');
		const eventTypeCounts: Record<string, number> = {};
		const sessionEventCounts: Record<string, number> = {};
		for (const entry of this._debugLog.entries) {
			if (entry.stream === 'rpc' && entry.method.startsWith('event:')) {
				const eventType = entry.method.replace('event:', '');
				eventTypeCounts[eventType] = (eventTypeCounts[eventType] ?? 0) + 1;
			}
			if (entry.tag) {
				sessionEventCounts[entry.tag] = (sessionEventCounts[entry.tag] ?? 0) + 1;
			}
		}
		if (Object.keys(eventTypeCounts).length > 0) {
			for (const [type, count] of Object.entries(eventTypeCounts).sort((a, b) => b[1] - a[1])) {
				add(`  ${type}`, String(count));
			}
		} else {
			add('  (no events yet)', '');
		}

		section('EVENTS PER SESSION (from debug log)');
		if (Object.keys(sessionEventCounts).length > 0) {
			for (const [sid, count] of Object.entries(sessionEventCounts).sort((a, b) => b[1] - a[1])) {
				add(`  Session ${sid}`, `${count} events`);
			}
		} else {
			add('  (no events yet)', '');
		}

		// Refresh button at the bottom
		const refreshBtn = dom.append(this._sessionInfoContainer, $('button')) as HTMLButtonElement;
		refreshBtn.textContent = 'Refresh';
		refreshBtn.style.cssText = 'margin-top:12px;font-size:11px;padding:4px 12px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;cursor:pointer;';
		this._sessionInfoDisposables.add(dom.addDisposableListener(refreshBtn, 'click', () => this._refreshSessionInfo()));

		// Copy all info button
		const copyInfoBtn = dom.append(this._sessionInfoContainer, $('button')) as HTMLButtonElement;
		copyInfoBtn.textContent = 'Copy All Info';
		copyInfoBtn.style.cssText = 'margin-top:4px;margin-left:4px;font-size:11px;padding:4px 12px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;cursor:pointer;';
		this._sessionInfoDisposables.add(dom.addDisposableListener(copyInfoBtn, 'click', () => {
			this._clipboardService.writeText(this._sessionInfoContainer.textContent ?? '');
			copyInfoBtn.textContent = 'Copied!';
			setTimeout(() => { copyInfoBtn.textContent = 'Copy All Info'; }, 1500);
		}));
	}
}
