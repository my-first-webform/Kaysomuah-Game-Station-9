/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Always-on debug log for the Copilot SDK. Subscribes to all SDK events
 * at startup and buffers them so the debug panel can show the full history
 * regardless of when it is opened.
 *
 * Registered as a workbench contribution in `chat.contribution.ts`.
 */

import { Disposable } from '../../base/common/lifecycle.js';
import { Emitter, Event } from '../../base/common/event.js';
import { ICopilotSdkService } from '../../platform/copilotSdk/common/copilotSdkService.js';

const MAX_LOG_ENTRIES = 5000;

export interface IDebugLogEntry {
	readonly id: number;
	readonly timestamp: string;
	readonly direction: string;   // '→' request, '←' response, '!' event, 'X' error
	readonly method: string;
	readonly detail: string;
	readonly tag?: string;
	readonly stream: 'rpc' | 'process';
}

export class CopilotSdkDebugLog extends Disposable {

	private static _instance: CopilotSdkDebugLog | undefined;
	static get instance(): CopilotSdkDebugLog | undefined { return CopilotSdkDebugLog._instance; }

	private _nextId = 1;
	private readonly _entries: IDebugLogEntry[] = [];

	private readonly _onDidAddEntry = this._register(new Emitter<IDebugLogEntry>());
	readonly onDidAddEntry: Event<IDebugLogEntry> = this._onDidAddEntry.event;

	constructor(
		@ICopilotSdkService private readonly _sdk: ICopilotSdkService,
	) {
		super();
		CopilotSdkDebugLog._instance = this;
		this._register({ dispose: () => { if (CopilotSdkDebugLog._instance === this) { CopilotSdkDebugLog._instance = undefined; } } });
		this._subscribe();
	}

	get entries(): readonly IDebugLogEntry[] {
		return this._entries;
	}

	/**
	 * Add a log entry programmatically (used by the debug panel for manual RPC calls).
	 */
	addEntry(direction: string, method: string, detail: string, tag?: string, stream: 'rpc' | 'process' = 'rpc'): void {
		const entry: IDebugLogEntry = {
			id: this._nextId++,
			timestamp: new Date().toLocaleTimeString(),
			direction,
			method,
			detail,
			tag,
			stream,
		};
		this._entries.push(entry);
		if (this._entries.length > MAX_LOG_ENTRIES) {
			this._entries.splice(0, this._entries.length - MAX_LOG_ENTRIES);
		}
		this._onDidAddEntry.fire(entry);
	}

	clear(stream?: 'rpc' | 'process'): void {
		if (stream) {
			// Remove only entries of the given stream
			for (let i = this._entries.length - 1; i >= 0; i--) {
				if (this._entries[i].stream === stream) {
					this._entries.splice(i, 1);
				}
			}
		} else {
			this._entries.length = 0;
		}
	}

	private _subscribe(): void {
		this._register(this._sdk.onSessionEvent(event => {
			const data = JSON.stringify(event.data ?? {});
			const truncated = data.length > 300 ? data.substring(0, 300) + '...' : data;
			this.addEntry('!', `event:${event.type}`, truncated, event.sessionId.substring(0, 8));
		}));

		this._register(this._sdk.onSessionLifecycle(event => {
			this.addEntry('!', `lifecycle:${event.type}`, '', event.sessionId.substring(0, 8));
		}));

		this._register(this._sdk.onProcessOutput(output => {
			this.addEntry('', output.stream, output.data, undefined, 'process');
		}));
	}
}
