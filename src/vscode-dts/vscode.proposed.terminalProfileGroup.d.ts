/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// https://github.com/microsoft/vscode/issues/293554

	/**
	 * Additional options for terminal profile contributions declared in `contributes.terminal.profiles`.
	 *
	 * Allows extensions to specify a `group` to control the placement of the profile
	 * in the terminal profile quick pick and dropdown.
	 *
	 * Currently recognized groups:
	 * - `'ai'` — The profile will be elevated to a dedicated section near the top of the
	 *   terminal profile list, improving discoverability of AI agent terminals.
	 */
}
