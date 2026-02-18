/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { formatChangeForSummary, buildChangeSummary, truncateDiff, buildBranchNamePrompt, cleanBranchNameResponse, deduplicateChanges } from '../branchNameGenerator';
import { Status, Change } from '../api/git';

suite('branchNameGenerator', () => {
	suite('formatChangeForSummary', () => {
		test('INDEX_ADDED', () => {
			assert.strictEqual(formatChangeForSummary(Status.INDEX_ADDED, 'src/new-file.ts'), 'Added: src/new-file.ts');
		});

		test('UNTRACKED', () => {
			assert.strictEqual(formatChangeForSummary(Status.UNTRACKED, 'readme.md'), 'Added: readme.md');
		});

		test('INTENT_TO_ADD', () => {
			assert.strictEqual(formatChangeForSummary(Status.INTENT_TO_ADD, 'file.txt'), 'Added: file.txt');
		});

		test('INDEX_DELETED', () => {
			assert.strictEqual(formatChangeForSummary(Status.INDEX_DELETED, 'old-file.ts'), 'Deleted: old-file.ts');
		});

		test('DELETED', () => {
			assert.strictEqual(formatChangeForSummary(Status.DELETED, 'removed.ts'), 'Deleted: removed.ts');
		});

		test('INDEX_RENAMED with original path', () => {
			assert.strictEqual(
				formatChangeForSummary(Status.INDEX_RENAMED, 'new-name.ts', '/old-name.ts'),
				'Renamed: /old-name.ts -> new-name.ts'
			);
		});

		test('INDEX_RENAMED without original path', () => {
			assert.strictEqual(
				formatChangeForSummary(Status.INDEX_RENAMED, 'new-name.ts'),
				'Renamed: new-name.ts -> new-name.ts'
			);
		});

		test('INTENT_TO_RENAME', () => {
			assert.strictEqual(
				formatChangeForSummary(Status.INTENT_TO_RENAME, 'new.ts', '/old.ts'),
				'Renamed: /old.ts -> new.ts'
			);
		});

		test('INDEX_MODIFIED', () => {
			assert.strictEqual(formatChangeForSummary(Status.INDEX_MODIFIED, 'src/app.ts'), 'Modified: src/app.ts');
		});

		test('MODIFIED', () => {
			assert.strictEqual(formatChangeForSummary(Status.MODIFIED, 'src/app.ts'), 'Modified: src/app.ts');
		});

		test('TYPE_CHANGED', () => {
			assert.strictEqual(formatChangeForSummary(Status.TYPE_CHANGED, 'link.ts'), 'Modified: link.ts');
		});

		test('INDEX_COPIED', () => {
			assert.strictEqual(formatChangeForSummary(Status.INDEX_COPIED, 'copy.ts'), 'Copied: copy.ts');
		});

		test('unknown status falls back to Changed', () => {
			assert.strictEqual(formatChangeForSummary(Status.BOTH_MODIFIED, 'conflict.ts'), 'Changed: conflict.ts');
		});
	});

	suite('buildChangeSummary', () => {
		test('empty changes', () => {
			assert.strictEqual(buildChangeSummary([]), '');
		});

		test('single change', () => {
			assert.strictEqual(
				buildChangeSummary([{ status: Status.MODIFIED, fileName: 'file.ts' }]),
				'Modified: file.ts'
			);
		});

		test('multiple changes', () => {
			assert.strictEqual(
				buildChangeSummary([
					{ status: Status.INDEX_ADDED, fileName: 'new.ts' },
					{ status: Status.MODIFIED, fileName: 'existing.ts' },
					{ status: Status.DELETED, fileName: 'old.ts' }
				]),
				'Added: new.ts\nModified: existing.ts\nDeleted: old.ts'
			);
		});

		test('renamed with original path', () => {
			assert.strictEqual(
				buildChangeSummary([
					{ status: Status.INDEX_RENAMED, fileName: 'new.ts', originalPath: '/old.ts' }
				]),
				'Renamed: /old.ts -> new.ts'
			);
		});
	});

	suite('truncateDiff', () => {
		test('short diff is unchanged', () => {
			const diff = 'short diff content';
			assert.strictEqual(truncateDiff(diff), diff);
		});

		test('empty diff', () => {
			assert.strictEqual(truncateDiff(''), '');
		});

		test('diff at exact limit is unchanged', () => {
			const diff = 'a'.repeat(2000);
			assert.strictEqual(truncateDiff(diff, 2000), diff);
		});

		test('diff exceeding limit is truncated', () => {
			const diff = 'a'.repeat(2500);
			const result = truncateDiff(diff, 2000);
			assert.strictEqual(result.startsWith('a'.repeat(2000)), true);
			assert.strictEqual(result.endsWith('\n... (truncated)'), true);
			assert.strictEqual(result.length, 2000 + '\n... (truncated)'.length);
		});

		test('custom max length', () => {
			const diff = 'abcdefghij';
			const result = truncateDiff(diff, 5);
			assert.strictEqual(result, 'abcde\n... (truncated)');
		});
	});

	suite('buildBranchNamePrompt', () => {
		test('basic prompt without prefix', () => {
			const prompt = buildBranchNamePrompt({
				changeSummary: 'Modified: src/app.ts',
				diffSnippet: '',
				branchWhitespaceChar: '-',
				branchPrefix: '',
				previousNames: []
			});

			assert.ok(prompt.includes('Modified: src/app.ts'));
			assert.ok(prompt.includes('feature/, fix/, refactor/, docs/, chore/, test/'));
			assert.ok(!prompt.includes('Do NOT suggest any of these names'));
			assert.ok(!prompt.includes('Diff snippet'));
		});

		test('prompt with prefix suppresses conventional prefixes', () => {
			const prompt = buildBranchNamePrompt({
				changeSummary: 'Modified: src/app.ts',
				diffSnippet: '',
				branchWhitespaceChar: '-',
				branchPrefix: 'user/',
				previousNames: []
			});

			assert.ok(prompt.includes('automatically prefixed with "user/"'));
			assert.ok(prompt.includes('Do NOT add conventional prefixes'));
			assert.ok(!prompt.includes('feature/, fix/, refactor/'));
		});

		test('prompt includes diff snippet when provided', () => {
			const prompt = buildBranchNamePrompt({
				changeSummary: 'Modified: src/app.ts',
				diffSnippet: '+ added line\n- removed line',
				branchWhitespaceChar: '-',
				branchPrefix: '',
				previousNames: []
			});

			assert.ok(prompt.includes('Diff snippet:'));
			assert.ok(prompt.includes('+ added line'));
			assert.ok(prompt.includes('- removed line'));
		});

		test('prompt excludes previous names', () => {
			const prompt = buildBranchNamePrompt({
				changeSummary: 'Modified: src/app.ts',
				diffSnippet: '',
				branchWhitespaceChar: '-',
				branchPrefix: '',
				previousNames: ['feature/first-attempt', 'feature/second-attempt']
			});

			assert.ok(prompt.includes('Do NOT suggest any of these names'));
			assert.ok(prompt.includes('feature/first-attempt'));
			assert.ok(prompt.includes('feature/second-attempt'));
		});

		test('prompt uses custom whitespace char', () => {
			const prompt = buildBranchNamePrompt({
				changeSummary: 'Modified: src/app.ts',
				diffSnippet: '',
				branchWhitespaceChar: '_',
				branchPrefix: '',
				previousNames: []
			});

			assert.ok(prompt.includes('separated by "_"'));
		});
	});

	suite('cleanBranchNameResponse', () => {
		test('empty string', () => {
			assert.strictEqual(cleanBranchNameResponse(''), '');
		});

		test('simple branch name', () => {
			assert.strictEqual(cleanBranchNameResponse('feature/add-login'), 'feature/add-login');
		});

		test('trims whitespace', () => {
			assert.strictEqual(cleanBranchNameResponse('  feature/add-login  '), 'feature/add-login');
		});

		test('removes backticks', () => {
			assert.strictEqual(cleanBranchNameResponse('`feature/add-login`'), 'feature/add-login');
		});

		test('removes single quotes', () => {
			assert.strictEqual(cleanBranchNameResponse('\'feature/add-login\''), 'feature/add-login');
		});

		test('removes double quotes', () => {
			assert.strictEqual(cleanBranchNameResponse('"feature/add-login"'), 'feature/add-login');
		});

		test('takes only first line', () => {
			assert.strictEqual(
				cleanBranchNameResponse('feature/add-login\nThis is a great name because...'),
				'feature/add-login'
			);
		});

		test('handles multiline with explanation', () => {
			assert.strictEqual(
				cleanBranchNameResponse('feature/add-login\n\nI chose this name because it describes the feature.'),
				'feature/add-login'
			);
		});

		test('handles code block wrapping', () => {
			assert.strictEqual(
				cleanBranchNameResponse('`feature/add-login`\nThis branch name...'),
				'feature/add-login'
			);
		});

		test('handles mixed quotes and whitespace', () => {
			assert.strictEqual(
				cleanBranchNameResponse('  "feature/add-login"  \n  explanation'),
				'feature/add-login'
			);
		});

		test('handles triple backtick code block', () => {
			assert.strictEqual(
				cleanBranchNameResponse('```\nfeature/add-login\n```'),
				'feature/add-login'
			);
		});

		test('handles only whitespace', () => {
			assert.strictEqual(cleanBranchNameResponse('   \n\n  '), '');
		});

		test('strips markdown-style inline code', () => {
			assert.strictEqual(
				cleanBranchNameResponse('`fix/resolve-null-pointer`'),
				'fix/resolve-null-pointer'
			);
		});
	});

	suite('deduplicateChanges', () => {
		function makeChange(filePath: string, status: Status): Change {
			// Minimal mock URI with toString() - avoids vscode module dependency
			const uri = { toString: () => filePath } as Pick<Change['uri'], 'toString'> as Change['uri'];
			return {
				uri,
				originalUri: uri,
				renameUri: undefined,
				status
			};
		}

		test('empty array', () => {
			assert.deepStrictEqual(deduplicateChanges([]), []);
		});

		test('no duplicates', () => {
			const changes = [
				makeChange('/src/a.ts', Status.MODIFIED),
				makeChange('/src/b.ts', Status.INDEX_ADDED)
			];
			assert.strictEqual(deduplicateChanges(changes).length, 2);
		});

		test('removes duplicates keeping first occurrence', () => {
			const changes = [
				makeChange('/src/a.ts', Status.INDEX_MODIFIED),
				makeChange('/src/a.ts', Status.MODIFIED),
				makeChange('/src/b.ts', Status.INDEX_ADDED)
			];
			const result = deduplicateChanges(changes);
			assert.strictEqual(result.length, 2);
			assert.strictEqual(result[0].status, Status.INDEX_MODIFIED);
			assert.strictEqual(result[1].status, Status.INDEX_ADDED);
		});

		test('handles all duplicates', () => {
			const changes = [
				makeChange('/src/a.ts', Status.MODIFIED),
				makeChange('/src/a.ts', Status.INDEX_MODIFIED),
				makeChange('/src/a.ts', Status.UNTRACKED)
			];
			const result = deduplicateChanges(changes);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].status, Status.MODIFIED);
		});
	});
});
