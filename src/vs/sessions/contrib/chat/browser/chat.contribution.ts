/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import * as dom from '../../../../base/browser/dom.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewExtensions, WindowVisibility } from '../../../../workbench/common/views.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { AgentSessionProviders } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { isAgentSession } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsModel.js';
import { ISessionsManagementService, IsNewChatSessionContext } from '../../sessions/browser/sessionsManagementService.js';
import { ITerminalService, ITerminalGroupService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { Menus } from '../../../browser/menus.js';
import { BranchChatSessionAction } from './branchChatSessionAction.js';
import { RunScriptContribution } from './runScriptAction.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AgenticPromptsService } from './promptsService.js';
import { IPromptsService } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { ChatViewContainerId, ChatViewId } from '../../../../workbench/contrib/chat/browser/chat.js';
import { NewChatViewPane, SessionsViewId } from './newChatViewPane.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ChatViewPane } from '../../../../workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IsSessionsUtilityProcessContext, IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { SdkChatViewPane, SdkChatViewId } from '../../../browser/widget/sdkChatViewPane.js';
import { CopilotSdkDebugLog } from '../../../browser/copilotSdkDebugLog.js';
import { CopilotSdkDebugPanel } from '../../../browser/copilotSdkDebugPanel.js';

export class OpenSessionWorktreeInVSCodeAction extends Action2 {
	static readonly ID = 'chat.openSessionWorktreeInVSCode';

	constructor() {
		super({
			id: OpenSessionWorktreeInVSCodeAction.ID,
			title: localize2('openInVSCode', 'Open in VS Code'),
			icon: Codicon.vscodeInsiders,
			menu: [{
				id: Menus.OpenSubMenu,
				group: 'navigation',
				order: 2,
			}]
		});
	}

	override async run(accessor: ServicesAccessor,): Promise<void> {
		const hostService = accessor.get(IHostService);
		const sessionsManagementService = accessor.get(ISessionsManagementService);

		const activeSession = sessionsManagementService.activeSession.get();
		if (!activeSession) {
			return;
		}

		const folderUri = isAgentSession(activeSession) && activeSession.providerType !== AgentSessionProviders.Cloud ? activeSession.worktree : undefined;

		if (!folderUri) {
			return;
		}

		await hostService.openWindow([{ folderUri }], { forceNewWindow: true });
	}
}
registerAction2(OpenSessionWorktreeInVSCodeAction);

export class OpenSessionInTerminalAction extends Action2 {

	constructor() {
		super({
			id: 'agentSession.openInTerminal',
			title: localize2('openInTerminal', "Open Terminal"),
			icon: Codicon.terminal,
			menu: [{
				id: Menus.OpenSubMenu,
				group: 'navigation',
				order: 1,
			}]
		});
	}

	override async run(accessor: ServicesAccessor,): Promise<void> {
		const terminalService = accessor.get(ITerminalService);
		const terminalGroupService = accessor.get(ITerminalGroupService);
		const sessionsManagementService = accessor.get(ISessionsManagementService);

		const activeSession = sessionsManagementService.activeSession.get();
		const repository = isAgentSession(activeSession) && activeSession.providerType !== AgentSessionProviders.Cloud
			? activeSession.worktree
			: undefined;
		if (repository) {
			const instance = await terminalService.createTerminal({ config: { cwd: repository } });
			if (instance) {
				terminalService.setActiveInstance(instance);
			}
		}
		terminalGroupService.showPanel(true);
	}
}

registerAction2(OpenSessionInTerminalAction);

// Register the split button menu item that combines Open in VS Code and Open in Terminal
MenuRegistry.appendMenuItem(Menus.TitleBarRight, {
	submenu: Menus.OpenSubMenu,
	isSplitButton: { togglePrimaryAction: true },
	title: localize2('open', "Open..."),
	icon: Codicon.folderOpened,
	group: 'navigation',
	order: 9,
});



// --- Sessions New Chat View Registration ---
// Registers in the same ChatBar container as the existing ChatViewPane.
// The `when` clause ensures only the new-session pane shows when no active session exists.

const chatViewIcon = registerIcon('chat-view-icon', Codicon.chatSparkle, localize('chatViewIcon', 'View icon of the chat view.'));

class RegisterChatViewContainerContribution implements IWorkbenchContribution {

	static ID = 'sessions.registerChatViewContainer';

	constructor(
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		if (environmentService.isSessionsUtilityProcess) {
			this._registerSdkViews();
		} else {
			this._registerDefaultViews();
		}
	}

	private _registerSdkViews(): void {
		const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		let chatViewContainer = viewContainerRegistry.get(ChatViewContainerId);
		if (chatViewContainer) {
			viewContainerRegistry.deregisterViewContainer(chatViewContainer);
			const view = viewsRegistry.getView(ChatViewId);
			if (view) {
				viewsRegistry.deregisterViews([view], chatViewContainer);
			}
		}

		chatViewContainer = viewContainerRegistry.registerViewContainer({
			id: ChatViewContainerId,
			title: localize2('chat.viewContainer.label', "Chat"),
			icon: chatViewIcon,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ChatViewContainerId, { mergeViewWithContainerWhenSingleView: true }]),
			storageId: ChatViewContainerId,
			hideIfEmpty: true,
			order: 1,
			windowVisibility: WindowVisibility.Sessions,
		}, ViewContainerLocation.ChatBar, { isDefault: true, doNotRegisterOpenCommand: true });

		viewsRegistry.registerViews([{
			id: SdkChatViewId,
			containerIcon: chatViewContainer.icon,
			containerTitle: chatViewContainer.title.value,
			singleViewPaneContainerTitle: chatViewContainer.title.value,
			name: localize2('sdkChat.viewContainer.label', "Chat"),
			canToggleVisibility: false,
			canMoveView: false,
			ctorDescriptor: new SyncDescriptor(SdkChatViewPane),
			when: IsSessionsWindowContext,
			windowVisibility: WindowVisibility.Both,
		}], chatViewContainer);
	}

	private _registerDefaultViews(): void {
		const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		let chatViewContainer = viewContainerRegistry.get(ChatViewContainerId);
		if (chatViewContainer) {
			viewContainerRegistry.deregisterViewContainer(chatViewContainer);
			const view = viewsRegistry.getView(ChatViewId);
			if (view) {
				viewsRegistry.deregisterViews([view], chatViewContainer);
			}
		}

		chatViewContainer = viewContainerRegistry.registerViewContainer({
			id: ChatViewContainerId,
			title: localize2('chat.viewContainer.label', "Chat"),
			icon: chatViewIcon,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ChatViewContainerId, { mergeViewWithContainerWhenSingleView: true }]),
			storageId: ChatViewContainerId,
			hideIfEmpty: true,
			order: 1,
			windowVisibility: WindowVisibility.Sessions,
		}, ViewContainerLocation.ChatBar, { isDefault: true, doNotRegisterOpenCommand: true });

		viewsRegistry.registerViews([{
			id: ChatViewId,
			containerIcon: chatViewContainer.icon,
			containerTitle: chatViewContainer.title.value,
			singleViewPaneContainerTitle: chatViewContainer.title.value,
			name: localize2('chat.viewContainer.label', "Chat"),
			canToggleVisibility: false,
			canMoveView: false,
			ctorDescriptor: new SyncDescriptor(ChatViewPane),
			when: IsNewChatSessionContext.negate(),
			windowVisibility: WindowVisibility.Sessions
		}, {
			id: SessionsViewId,
			containerIcon: chatViewContainer.icon,
			containerTitle: chatViewContainer.title.value,
			singleViewPaneContainerTitle: chatViewContainer.title.value,
			name: localize2('sessions.newChat.view', "New Session"),
			canToggleVisibility: false,
			canMoveView: false,
			ctorDescriptor: new SyncDescriptor(NewChatViewPane),
			when: IsNewChatSessionContext,
			windowVisibility: WindowVisibility.Sessions,
		}], chatViewContainer);
	}
}


// register actions
registerAction2(BranchChatSessionAction);

// register workbench contributions
registerWorkbenchContribution2(RegisterChatViewContainerContribution.ID, RegisterChatViewContainerContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(RunScriptContribution.ID, RunScriptContribution, WorkbenchPhase.AfterRestored);

class CopilotSdkDebugContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'copilotSdk.debugContribution';

	constructor(
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// Only initialize debug logging when the SDK utility process is enabled
		if (!environmentService.isSessionsUtilityProcess) {
			return;
		}

		this._register(instantiationService.createInstance(CopilotSdkDebugLog));
	}
}

// SDK debug log (only when using SDK - captures all events from startup)
registerWorkbenchContribution2(CopilotSdkDebugContribution.ID, CopilotSdkDebugContribution, WorkbenchPhase.AfterRestored);

// SDK debug panel (command palette action)
let activeDebugBackdrop: HTMLElement | undefined;
registerAction2(class CopilotSdkDebugPanelAction extends Action2 {
	constructor() {
		super({
			id: 'copilotSdk.openDebugPanel',
			title: localize2('copilotSdkDebugPanel', 'Copilot SDK: Open Debug Panel'),
			f1: true,
			icon: Codicon.beaker,
			precondition: IsSessionsUtilityProcessContext,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		if (!environmentService.isSessionsUtilityProcess) {
			return;
		}

		const layoutService = accessor.get(IWorkbenchLayoutService);
		const instantiationService = accessor.get(IInstantiationService);
		const container = layoutService.mainContainer;
		const targetWindow = dom.getWindow(container);
		if (activeDebugBackdrop) {
			activeDebugBackdrop.remove();
			activeDebugBackdrop = undefined;
			return;
		}
		const log = CopilotSdkDebugLog.instance;
		if (!log) {
			return;
		}
		const backdrop = dom.$('.copilot-sdk-debug-backdrop');
		activeDebugBackdrop = backdrop;
		backdrop.style.cssText = 'position:absolute;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';
		container.appendChild(backdrop);
		const modal = dom.$('div');
		modal.style.cssText = 'width:560px;height:80%;max-height:700px;border-radius:8px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.4);';
		backdrop.appendChild(modal);
		const panel = instantiationService.createInstance(CopilotSdkDebugPanel, modal, log);
		const close = () => {
			panel.dispose();
			backdrop.remove();
			activeDebugBackdrop = undefined;
			targetWindow.document.removeEventListener('keydown', onKeyDown);
		};
		const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); } };
		backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { close(); } });
		targetWindow.document.addEventListener('keydown', onKeyDown);
	}
});

// register services
registerSingleton(IPromptsService, AgenticPromptsService, InstantiationType.Delayed);
