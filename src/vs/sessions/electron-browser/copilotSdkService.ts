/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../platform/ipc/electron-browser/services.js';
import { ICopilotSdkService, CopilotSdkChannel } from '../../platform/copilotSdk/common/copilotSdkService.js';

// Register ICopilotSdkService as a proxy to the main process channel.
// The main process forwards calls to the Copilot SDK utility process.
// Any workbench code can now inject @ICopilotSdkService via standard DI.
registerMainProcessRemoteService(ICopilotSdkService, CopilotSdkChannel);
