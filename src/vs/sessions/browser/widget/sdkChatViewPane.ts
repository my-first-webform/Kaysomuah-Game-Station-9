/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../base/browser/dom.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../workbench/common/views.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../workbench/browser/parts/views/viewPane.js';
import { SdkChatWidget } from './sdkChatWidget.js';

export const SdkChatViewId = 'workbench.panel.chat.view.sdkChat';

export class SdkChatViewPane extends ViewPane {

	private _widget: SdkChatWidget | undefined;

	get widget(): SdkChatWidget | undefined {
		return this._widget;
	}

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService,
		);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const widgetContainer = append(container, $('.sdk-chat-view-pane-container'));
		widgetContainer.style.height = '100%';
		this._widget = this._register(this.instantiationService.createInstance(SdkChatWidget, widgetContainer));
	}

	override focus(): void {
		super.focus();
		this._widget?.focus();
	}
}
