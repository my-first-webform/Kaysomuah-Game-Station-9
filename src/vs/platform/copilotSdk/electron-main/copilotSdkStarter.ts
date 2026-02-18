/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { UtilityProcess } from '../../utilityProcess/electron-main/utilityProcess.js';
import { NullTelemetryService } from '../../telemetry/common/telemetryUtils.js';
import { Client as MessagePortClient } from '../../../base/parts/ipc/electron-main/ipc.mp.js';
import type { IServerChannel, IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { CopilotSdkChannel, ICopilotSdkMainService } from '../common/copilotSdkService.js';
import { Schemas } from '../../../base/common/network.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { CancellationToken } from '../../../base/common/cancellation.js';

/**
 * Manages the Copilot SDK utility process in the main process.
 *
 * Follows the terminal (pty host) pattern: spawns a UtilityProcess lazily
 * on first use, connects via MessagePort, and exposes an IServerChannel.
 */
export class CopilotSdkMainService extends Disposable implements ICopilotSdkMainService {

	declare readonly _serviceBrand: undefined;

	private _utilityProcess: UtilityProcess | undefined;
	private _channel: IChannel | undefined;
	private _connectionStore: DisposableStore | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@ILifecycleMainService private readonly _lifecycleMainService: ILifecycleMainService,
		@IEnvironmentMainService private readonly _environmentMainService: IEnvironmentMainService,
	) {
		super();

		this._register(this._lifecycleMainService.onWillShutdown(() => {
			this._teardown();
		}));
	}

	private _ensureChannel(): IChannel {
		if (this._channel) {
			return this._channel;
		}

		this._logService.info(`[CopilotSdkMainService] Starting Copilot SDK utility process (logs: ${this._environmentMainService.logsHome.with({ scheme: Schemas.file }).fsPath})`);

		this._connectionStore = new DisposableStore();

		this._utilityProcess = new UtilityProcess(this._logService, NullTelemetryService, this._lifecycleMainService);
		this._connectionStore.add(toDisposable(() => {
			this._logService.info('[CopilotSdkMainService] Utility process disposed');
			this._utilityProcess?.kill();
			this._utilityProcess?.dispose();
			this._utilityProcess = undefined;
		}));

		this._connectionStore.add(this._utilityProcess.onStdout(data => this._logService.info(`[CopilotSdkHost:stdout] ${data}`)));
		this._connectionStore.add(this._utilityProcess.onStderr(data => this._logService.warn(`[CopilotSdkHost:stderr] ${data}`)));
		this._connectionStore.add(this._utilityProcess.onExit(e => this._logService.error(`[CopilotSdkHost] Process exited with code ${e.code}`)));
		this._connectionStore.add(this._utilityProcess.onCrash(e => this._logService.error(`[CopilotSdkHost] Process crashed with code ${e.code}`)));

		this._utilityProcess.start({
			type: 'copilotSdkHost',
			name: 'copilot-sdk-host',
			entryPoint: 'vs/platform/copilotSdk/node/copilotSdkHost',
			args: ['--logsPath', this._environmentMainService.logsHome.with({ scheme: Schemas.file }).fsPath, '--disable-gpu'],
			env: {
				...process.env as Record<string, string>,
				VSCODE_ESM_ENTRYPOINT: 'vs/platform/copilotSdk/node/copilotSdkHost',
				VSCODE_PIPE_LOGGING: 'true',
				VSCODE_VERBOSE_LOGGING: 'true',
			},
		});

		const port = this._utilityProcess.connect();
		const client = new MessagePortClient(port, 'copilotSdkHost');
		this._connectionStore.add(client);

		this._channel = client.getChannel(CopilotSdkChannel);
		this._logService.info(`[CopilotSdkMainService] Channel '${CopilotSdkChannel}' acquired. Utility process ready.`);

		return this._channel;
	}

	getServerChannel(): IServerChannel<string> {
		return {
			listen: <T>(_ctx: string, event: string, arg?: unknown): Event<T> => {
				return this._ensureChannel().listen(event, arg);
			},
			call: <T>(_ctx: string, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> => {
				return this._ensureChannel().call<T>(command, arg, cancellationToken);
			}
		};
	}

	private _teardown(): void {
		this._connectionStore?.dispose();
		this._connectionStore = undefined;
		this._channel = undefined;
	}

	override dispose(): void {
		this._teardown();
		super.dispose();
	}
}
