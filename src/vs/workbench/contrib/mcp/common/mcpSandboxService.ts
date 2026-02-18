/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { dirname, posix, win32 } from '../../../../base/common/path.js';
import { OperatingSystem, OS } from '../../../../base/common/platform.js';
import { equals } from '../../../../base/common/objects.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { InstallMcpServerResult } from '../../../../platform/mcp/common/mcpManagement.js';
import { IRemoteAgentEnvironment } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import { IMcpSandboxConfiguration, McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { IWorkbenchMcpManagementService } from '../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { mcpSandboxedLaunchEnvironmentKey, McpServerDefinition, McpServerLaunch, McpServerTransportType } from './mcpTypes.js';

export const IMcpSandboxService = createDecorator<IMcpSandboxService>('mcpSandboxService');

export interface IMcpSandboxService {
	readonly _serviceBrand: undefined;
	launchInSandboxIfEnabled(serverDef: McpServerDefinition, launch: McpServerLaunch, remoteAuthority?: string): Promise<McpServerLaunch>;
	isEnabled(serverDef: McpServerDefinition, serverLabel?: string): Promise<boolean>;
}

export class McpSandboxService extends Disposable implements IMcpSandboxService {
	readonly _serviceBrand: undefined;

	private _srtPath: string | undefined;
	private _srtPathResolved = false;
	private _sandboxConfigPath: string | undefined;
	private _sandboxConfig: IMcpSandboxConfiguration | undefined;
	private _tempDir: URI | undefined;
	private _sandboxSettingsId: string | undefined;
	private _remoteEnvDetailsPromise: Promise<IRemoteAgentEnvironment | null>;
	private _remoteEnvDetails: IRemoteAgentEnvironment | null = null;
	private _appRoot: string;
	private _os: OperatingSystem = OS;
	private _sandboxEnabledMcpServers: Set<string> = new Set();
	private readonly _defaultAllowedDomains: readonly string[] = ['*.npmjs.org'];

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
		@IWorkbenchMcpManagementService private readonly _mcpManagementService: IWorkbenchMcpManagementService,
	) {
		super();
		this._appRoot = dirname(FileAccess.asFileUri('').path);
		this._sandboxSettingsId = generateUuid();
		this._remoteEnvDetailsPromise = this._remoteAgentService.getEnvironment();
		// listen to MCP server updates to update the sandbox config file in case of any changes to the sandbox config for installed servers, since the sandbox config is stored in a file that is read during launch.
		this._register(this._mcpManagementService.onDidUpdateMcpServers(e => {
			void this._refreshSandboxConfigFromUpdates(e);
		}));
		// also listen to MCP server installs to populate the initial sandbox config and enabled servers set based on the install results.
		this._register(this._mcpManagementService.onDidInstallMcpServers(e => {
			this._populateSandboxConfigFromInstallResults(e);
		}));
	}

	public async isEnabled(serverDef: McpServerDefinition, serverLabel?: string, remoteAuthority?: string): Promise<boolean> {
		if (remoteAuthority) {
			this._remoteEnvDetails = await this._remoteEnvDetailsPromise;
			this._os = this._remoteEnvDetails ? this._remoteEnvDetails.os : OS;
		}
		if (this._os === OperatingSystem.Windows) {
			return false;
		}
		this._logService.debug(`McpSandboxService: Checking sandbox enablement for server ${serverDef.label}. Enabled servers: ${[...this._sandboxEnabledMcpServers].join(', ')}`);
		return this._sandboxEnabledMcpServers.has(serverLabel ?? serverDef.label);
	}

	public async launchInSandboxIfEnabled(serverDef: McpServerDefinition, launch: McpServerLaunch, remoteAuthority?: string): Promise<McpServerLaunch> {
		if (launch.type !== McpServerTransportType.Stdio) {
			return launch;
		}
		if (await this.isEnabled(serverDef, undefined, remoteAuthority)) {
			const srtPath = await this.getSandboxRuntimePath(remoteAuthority);
			const sandboxArgs = await this.getSandboxCommandArgs(launch.command, launch.args, remoteAuthority);
			const sandboxEnv = this.getSandboxEnvVariables();
			if (srtPath && sandboxArgs) {
				return {
					...launch,
					command: srtPath,
					args: sandboxArgs,
					env: sandboxEnv ? { ...launch.env, ...sandboxEnv } : launch.env,
					type: McpServerTransportType.Stdio,
				};
			}
			this._logService.debug(`McpSandboxService: launch details for server ${serverDef.label} - command: ${launch.command}, args: ${launch.args.join(' ')}`);
		}
		return launch;
	}

	private async getSandboxRuntimePath(remoteAuthority?: string): Promise<string | undefined> {
		await this._resolveSrtPath(remoteAuthority);
		return this._srtPath;
	}

	private getSandboxEnvVariables(): Record<string, string> | undefined {
		if (this._tempDir) {
			return { TMPDIR: this._tempDir.path, SRT_DEBUG: 'true', [mcpSandboxedLaunchEnvironmentKey]: 'true' };
		}
		return undefined;
	}

	private async getSandboxCommandArgs(command: string, args: readonly string[], remoteAuthority?: string): Promise<string[] | undefined> {
		const result: string[] = [];
		this._sandboxConfigPath = await this.getSandboxConfigPath(remoteAuthority);
		if (this._sandboxConfigPath) {
			result.push('--settings', this._sandboxConfigPath);
		}
		result.push(command, ...args);
		return result;
	}

	private async getSandboxConfigPath(remoteAuthority?: string): Promise<string | undefined> {
		if (this._os === OperatingSystem.Windows) {
			return undefined;
		}
		if (!this._tempDir) {
			await this._initTempDir(remoteAuthority);
		}
		this._sandboxConfigPath = await this._updateSandboxConfig(this._sandboxConfig);
		this._logService.debug(`McpSandboxService: Updated sandbox config path: ${this._sandboxConfigPath}`);
		return this._sandboxConfigPath;
	}

	private _populateSandboxConfigFromInstallResults(results: readonly InstallMcpServerResult[]): void {
		//updating sandbox config based on the first local server config we find in the results.
		// single server config is supported for all installed servers, so we can break after the first match.
		for (const result of results) {
			const config = result.local?.config;
			if (config?.type === McpServerType.LOCAL) {
				this._sandboxConfig = config.sandbox;
				break;
			}
		}
		this._updateSandboxEnabledServersFromInstallResults(results);
	}

	private _updateSandboxEnabledServersFromInstallResults(results: readonly InstallMcpServerResult[]): void {
		// Update sandbox enablement set for local servers.
		for (const result of results) {
			const config = result.local?.config;
			if (config?.type === McpServerType.LOCAL) {
				if (config.sandboxEnabled) {
					this._sandboxEnabledMcpServers.add(result.name);
				} else {
					this._sandboxEnabledMcpServers.delete(result.name);
				}
			}
		}
	}

	private async _resolveSrtPath(remoteAuthority?: string): Promise<void> {
		if (this._srtPathResolved) {
			return;
		}
		this._srtPathResolved = true;
		if (remoteAuthority) {
			this._remoteEnvDetails = await this._remoteEnvDetailsPromise;
			if (this._remoteEnvDetails) {
				this._appRoot = this._remoteEnvDetails.appRoot.path;
			}
		}
		this._srtPath = this._pathJoin(this._appRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'cli.js');
	}

	private async _updateSandboxConfig(sandboxConfig?: IMcpSandboxConfiguration): Promise<string | undefined> {
		if (!this._tempDir) {
			return undefined;
		}
		const normalizedSandboxConfig = this._withDefaultSandboxConfig(sandboxConfig);
		if (this._sandboxConfigPath && equals(this._sandboxConfig, normalizedSandboxConfig)) {
			return this._sandboxConfigPath;
		}
		this._sandboxConfig = normalizedSandboxConfig;
		const configFileUri = URI.joinPath(this._tempDir, `vscode-mcp-sandbox-settings-${this._sandboxSettingsId}.json`);
		this._sandboxConfigPath = configFileUri.path;
		await this._fileService.createFile(configFileUri, VSBuffer.fromString(JSON.stringify(this._sandboxConfig, null, '\t')), { overwrite: true });
		return this._sandboxConfigPath;
	}

	// this method merges the default allowWrite paths and allowedDomains with the ones provided in the sandbox config, to ensure that the default necessary paths and domains are always included in the sandbox config used for launching,
	//  even if they are not explicitly specified in the config provided by the user or the MCP server config.
	private _withDefaultSandboxConfig(sandboxConfig?: IMcpSandboxConfiguration): IMcpSandboxConfiguration {
		const mergedAllowWrite = new Set(sandboxConfig?.filesystem?.allowWrite ?? []);
		for (const defaultAllowWrite of this._getDefaultAllowWrite()) {
			if (defaultAllowWrite) {
				mergedAllowWrite.add(defaultAllowWrite);
			}
		}

		const mergedAllowedDomains = new Set(sandboxConfig?.network?.allowedDomains ?? []);
		for (const defaultAllowedDomain of this._defaultAllowedDomains) {
			if (defaultAllowedDomain) {
				mergedAllowedDomains.add(defaultAllowedDomain);
			}
		}

		return {
			...sandboxConfig,
			network: {
				allowedDomains: [...mergedAllowedDomains],
				deniedDomains: sandboxConfig?.network?.deniedDomains ?? [],
			},
			filesystem: {
				allowWrite: [...mergedAllowWrite],
				denyRead: sandboxConfig?.filesystem?.denyRead ?? [],
				denyWrite: sandboxConfig?.filesystem?.denyWrite ?? [],
			},
		};
	}

	private _getDefaultAllowWrite(): readonly string[] {
		return [
			'~/.npm'
		];
	}

	// TODO: this should not be registered if there is no sandboxing enabled.
	private async _refreshSandboxConfigFromUpdates(results: readonly InstallMcpServerResult[]): Promise<void> {

		this._updateSandboxEnabledServersFromInstallResults(results);

		this._os = this._remoteEnvDetails ? this._remoteEnvDetails.os : OS;
		if (this._os === OperatingSystem.Windows) {
			return;
		}
		let sandboxConfig: IMcpSandboxConfiguration | undefined;
		for (const result of results) {
			const config = result.local?.config;
			if (config?.type === McpServerType.LOCAL) {
				sandboxConfig = config.sandbox;
				break;
			}
		}
		if (!sandboxConfig) {
			return;
		}
		if (!this._tempDir) {
			await this._initTempDir();
		}
		if (!this._tempDir) {
			return;
		}
		await this._updateSandboxConfig(sandboxConfig);
	}

	private _pathJoin = (...segments: string[]) => {
		const path = this._os === OperatingSystem.Windows ? win32 : posix;
		return path.join(...segments);
	};

	private async _initTempDir(remoteAuthority?: string): Promise<void> {
		if (remoteAuthority) {
			this._remoteEnvDetails = await this._remoteEnvDetailsPromise;
			if (this._remoteEnvDetails) {
				this._tempDir = this._remoteEnvDetails.tmpDir;
			}
		} else {
			const environmentService = this._environmentService as IEnvironmentService & { tmpDir?: URI };
			this._tempDir = environmentService.tmpDir;
		}
		if (!this._tempDir) {
			this._logService.warn('McpSandboxService: Cannot create sandbox settings file because no tmpDir is available in this environment');
		}
	}

}
