/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Status, Change } from './api/git';

/**
 * Describes a file change in a human-readable format for prompt construction.
 */
export function formatChangeForSummary(status: Status, fileName: string, originalPath?: string): string {
	switch (status) {
		case Status.INDEX_ADDED:
		case Status.UNTRACKED:
		case Status.INTENT_TO_ADD:
			return `Added: ${fileName}`;
		case Status.INDEX_DELETED:
		case Status.DELETED:
			return `Deleted: ${fileName}`;
		case Status.INDEX_RENAMED:
		case Status.INTENT_TO_RENAME:
			return `Renamed: ${originalPath ?? fileName} -> ${fileName}`;
		case Status.INDEX_MODIFIED:
		case Status.MODIFIED:
		case Status.TYPE_CHANGED:
			return `Modified: ${fileName}`;
		case Status.INDEX_COPIED:
			return `Copied: ${fileName}`;
		default:
			return `Changed: ${fileName}`;
	}
}

/**
 * Maps an array of changes to a newline-separated summary string.
 */
export function buildChangeSummary(changes: { status: Status; fileName: string; originalPath?: string }[]): string {
	return changes.map(c => formatChangeForSummary(c.status, c.fileName, c.originalPath)).join('\n');
}

/**
 * Truncates a diff to a maximum character length, appending a truncation marker if needed.
 */
export function truncateDiff(diff: string, maxLength: number = 2000): string {
	if (diff.length <= maxLength) {
		return diff;
	}
	return diff.substring(0, maxLength) + '\n... (truncated)';
}

export interface BranchNamePromptOptions {
	changeSummary: string;
	diffSnippet: string;
	branchWhitespaceChar: string;
	branchPrefix: string;
	previousNames: string[];
}

/**
 * Builds the LLM prompt for generating a branch name from file changes.
 */
export function buildBranchNamePrompt(options: BranchNamePromptOptions): string {
	const { changeSummary, diffSnippet, branchWhitespaceChar, branchPrefix, previousNames } = options;

	const prefixRule = branchPrefix
		? `- The branch name will be automatically prefixed with "${branchPrefix}", so do NOT include it in your output. Do NOT add conventional prefixes like feature/, fix/, etc. since the user already has a configured prefix.`
		: '- Use conventional prefixes when appropriate: feature/, fix/, refactor/, docs/, chore/, test/';

	const avoidRule = previousNames.length > 0
		? `\n- Do NOT suggest any of these names, they already exist: ${previousNames.join(', ')}`
		: '';

	return `You are a helpful assistant that generates descriptive git branch names. Based on the following file changes and diff, suggest a single branch name that clearly communicates the purpose and scope of the changes.

Rules:
- Use lowercase letters, numbers, and hyphens only
- Be descriptive: include what is being changed and why (3-7 words separated by "${branchWhitespaceChar}")
${prefixRule}
- Focus on the semantic intent of the changes, not just file names (e.g. "add-ai-branch-name-generation" not "update-commands-ts")
- Do not include any explanation, just output the branch name
- Do not wrap in quotes or backticks${avoidRule}

File changes:
${changeSummary}${diffSnippet ? `\n\nDiff snippet:\n${diffSnippet}` : ''}`;
}

/**
 * Cleans an LLM response into a usable branch name string.
 * Removes quotes, backticks, markdown code blocks, extra lines, and leading/trailing whitespace.
 */
export function cleanBranchNameResponse(response: string): string {
	if (!response) {
		return '';
	}
	let cleaned = response.trim();
	// Strip triple-backtick code blocks (with optional language tag)
	cleaned = cleaned.replace(/^```[^\n]*\n?/gm, '').replace(/```$/gm, '');
	// Remove wrapping quotes and single backticks
	cleaned = cleaned.replace(/[`'"]/g, '');
	// Take only the first non-empty line
	const firstLine = cleaned.split('\n').map(l => l.trim()).find(l => l.length > 0);
	return firstLine ?? '';
}

/**
 * Deduplicates changes by URI string to avoid listing the same file twice
 * (e.g. when it appears in both staged and working tree changes).
 */
export function deduplicateChanges(changes: Change[]): Change[] {
	const seen = new Set<string>();
	return changes.filter(change => {
		const key = change.uri.toString();
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}
