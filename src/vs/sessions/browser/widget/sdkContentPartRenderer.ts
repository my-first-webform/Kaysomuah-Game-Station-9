/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Renders SDK chat parts into DOM nodes that match VS Code's chat design
 * language. Uses `ChatContentMarkdownRenderer` for markdown (same sanitizer,
 * same HTML tags, same hover behavior) and replicates the DOM structure of
 * `ChatThinkingContentPart`, `ChatToolInvocationPart`, etc.
 *
 * This avoids the full `ChatListItemRenderer` infrastructure (view models,
 * editor pools, code block collections) while producing visually identical
 * output for the content types we support.
 */

import * as dom from '../../../base/browser/dom.js';
import { Codicon } from '../../../base/common/codicons.js';
import { IDisposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../base/common/htmlContent.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { localize } from '../../../nls.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { type IMarkdownRenderer } from '../../../platform/markdown/browser/markdownRenderer.js';
import { ChatContentMarkdownRenderer } from '../../../workbench/contrib/chat/browser/widget/chatContentMarkdownRenderer.js';
import { type SdkChatPart, type ISdkMarkdownPart, type ISdkThinkingPart, type ISdkToolCallPart } from './sdkChatModel.js';

const $ = dom.$;

/**
 * The result of rendering a content part: a DOM node + disposable for cleanup.
 */
export interface IRenderedContentPart extends IDisposable {
	readonly domNode: HTMLElement;
}

/**
 * Renders SDK chat model parts into DOM elements using VS Code's chat
 * design language. Owns a `ChatContentMarkdownRenderer` for markdown.
 */
export class SdkContentPartRenderer {

	private readonly _markdownRenderer: IMarkdownRenderer;
	private readonly _renderDisposables = new WeakMap<HTMLElement, DisposableStore>();

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		this._markdownRenderer = instantiationService.createInstance(ChatContentMarkdownRenderer);
	}

	/**
	 * Render a single SDK chat part to a DOM node.
	 */
	render(part: SdkChatPart): IRenderedContentPart {
		switch (part.kind) {
			case 'markdownContent': return this._renderMarkdown(part);
			case 'thinking': return this._renderThinking(part);
			case 'toolInvocation': return this._renderToolCall(part);
			case 'progress': return this._renderProgress(part.message);
		}
	}

	/**
	 * Update an existing rendered part in-place with new data.
	 * Returns false if the part should be re-rendered from scratch.
	 */
	update(part: SdkChatPart, rendered: IRenderedContentPart): boolean {
		switch (part.kind) {
			case 'markdownContent':
				return this._updateMarkdown(part, rendered.domNode);
			case 'thinking':
				return this._updateThinking(part, rendered.domNode);
			case 'toolInvocation':
				// Tool calls change state: just re-render
				return false;
			default:
				return false;
		}
	}

	// --- Markdown ---

	private _renderMarkdown(part: ISdkMarkdownPart): IRenderedContentPart {
		const store = new DisposableStore();
		const el = $('.chat-markdown-part');
		if (part.isStreaming) {
			el.classList.add('sdk-chat-streaming-cursor');
		}
		const result = this._markdownRenderer.render(part.content);
		store.add(result);
		el.appendChild(result.element);
		this._renderDisposables.set(el, store);
		return { domNode: el, dispose: () => { this._renderDisposables.get(el)?.dispose(); this._renderDisposables.delete(el); } };
	}

	private _updateMarkdown(part: ISdkMarkdownPart, el: HTMLElement): boolean {
		this._renderDisposables.get(el)?.dispose();
		dom.clearNode(el);
		const store = new DisposableStore();
		const result = this._markdownRenderer.render(part.content);
		store.add(result);
		el.appendChild(result.element);
		this._renderDisposables.set(el, store);
		el.classList.toggle('sdk-chat-streaming-cursor', part.isStreaming);
		return true;
	}

	// --- Thinking/Reasoning ---

	private _renderThinking(part: ISdkThinkingPart): IRenderedContentPart {
		const store = new DisposableStore();
		const el = $('.sdk-chat-thinking');

		// Label row with chevron + "Thinking"
		const label = dom.append(el, $('.sdk-chat-thinking-label'));
		const chevronEl = dom.append(label, $(`span${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`));
		chevronEl.classList.add('codicon');
		const labelText = dom.append(label, $('span'));
		labelText.textContent = localize('sdkChat.thinking', "Thinking");
		if (part.isStreaming) {
			labelText.classList.add('sdk-chat-shimmer');
		}

		// Content
		const content = dom.append(el, $('.sdk-chat-thinking-content'));
		const result = this._markdownRenderer.render(new MarkdownString(part.content));
		store.add(result);
		content.appendChild(result.element);
		this._renderDisposables.set(el, store);

		return { domNode: el, dispose: () => { this._renderDisposables.get(el)?.dispose(); this._renderDisposables.delete(el); } };
	}

	private _updateThinking(part: ISdkThinkingPart, el: HTMLElement): boolean {
		// Update content only, keep label
		const content = el.lastElementChild;
		if (content) {
			this._renderDisposables.get(el)?.dispose();
			dom.clearNode(content as HTMLElement);
			const store = new DisposableStore();
			const result = this._markdownRenderer.render(new MarkdownString(part.content));
			store.add(result);
			content.appendChild(result.element);
			this._renderDisposables.set(el, store);
		}
		// Update shimmer on label
		const labelText = el.firstElementChild?.lastElementChild;
		if (labelText) {
			labelText.classList.toggle('sdk-chat-shimmer', part.isStreaming);
		}
		return true;
	}

	// --- Tool Invocation ---

	/**
	 * Internal tools that should be hidden from the user.
	 */
	private static readonly _hiddenTools = new Set([
		'report_intent',
		'report_progress',
		'suggest_mode',
		'placeholder',
	]);

	/**
	 * Human-readable labels for well-known tool names.
	 */
	private static readonly _toolLabels: Record<string, string> = {
		'edit': 'Edit file',
		'read': 'Read file',
		'write': 'Write file',
		'read_file': 'Read file',
		'write_file': 'Write file',
		'edit_file': 'Edit file',
		'create_file': 'Create file',
		'create': 'Create file',
		'multi_edit': 'Edit files',
		'list_directory': 'List directory',
		'run_command': 'Run command',
		'run_terminal_command': 'Run command',
		'search': 'Search',
		'grep_search': 'Search files',
		'file_search': 'Find files',
		'semantic_search': 'Semantic search',
		'delete': 'Delete',
		'browser_action': 'Browser action',
		'get_errors': 'Check errors',
	};

	private _humanizeToolName(name: string): string {
		if (SdkContentPartRenderer._toolLabels[name]) {
			return SdkContentPartRenderer._toolLabels[name];
		}
		// Convert snake_case to Title Case
		return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
	}

	private _renderToolCall(part: ISdkToolCallPart): IRenderedContentPart {
		// Hide internal tools
		if (SdkContentPartRenderer._hiddenTools.has(part.toolName)) {
			const el = $('span');
			el.style.display = 'none';
			return { domNode: el, dispose: () => { } };
		}

		const el = $('.sdk-chat-tool');
		if (part.state === 'complete') {
			el.classList.add('sdk-chat-tool-complete');
		}
		this._buildToolCallContent(el, part);
		return { domNode: el, dispose: () => { } };
	}

	private _buildToolCallContent(el: HTMLElement, part: ISdkToolCallPart): void {
		const isRunning = part.state === 'running';
		const iconCodicon = isRunning ? Codicon.loading : Codicon.check;
		const iconEl = dom.append(el, $(`span${ThemeIcon.asCSSSelector(iconCodicon)}`));
		iconEl.classList.add('codicon');
		if (isRunning) {
			iconEl.classList.add('codicon-loading', 'codicon-modifier-spin');
		}

		const label = this._humanizeToolName(part.toolName);
		const messageEl = dom.append(el, $('span.sdk-chat-tool-message'));
		messageEl.textContent = isRunning
			? localize('sdkChat.tool.invocationMessage', "Running {0}...", label)
			: label;
		if (isRunning) {
			messageEl.classList.add('sdk-chat-shimmer');
		}
	}

	// --- Progress ---

	private _renderProgress(message: string): IRenderedContentPart {
		const el = $('.sdk-chat-progress');
		const iconEl = dom.append(el, $(`span${ThemeIcon.asCSSSelector(Codicon.loading)}`));
		iconEl.classList.add('codicon', 'codicon-loading', 'codicon-modifier-spin');
		const textEl = dom.append(el, $('span.sdk-chat-shimmer'));
		textEl.textContent = message;
		return { domNode: el, dispose: () => { } };
	}
}
