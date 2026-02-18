/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'path';
import fs from 'fs';
import minimatch from 'minimatch';
import { makeUniversalApp } from 'vscode-universal-bundler';

const root = path.dirname(path.dirname(import.meta.dirname));

async function main(buildDir?: string) {
	const arch = process.env['VSCODE_ARCH'];

	if (!buildDir) {
		throw new Error('Build dir not provided');
	}

	const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));
	const appName = product.nameLong + '.app';
	const x64AppPath = path.join(buildDir, 'VSCode-darwin-x64', appName);
	const arm64AppPath = path.join(buildDir, 'VSCode-darwin-arm64', appName);
	const asarRelativePath = path.join('Contents', 'Resources', 'app', 'node_modules.asar');
	const outAppPath = path.join(buildDir, `VSCode-darwin-${arch}`, appName);
	const productJsonPath = path.resolve(outAppPath, 'Contents', 'Resources', 'app', 'product.json');

	// Copilot SDK: each arch build only has its own platform package.
	// Copy the missing one from the other build so the universal merger sees identical file sets.
	const copilotPlatforms = ['darwin-x64', 'darwin-arm64'];
	for (const plat of copilotPlatforms) {
		const relPath = path.join('Contents', 'Resources', 'app', 'node_modules', '@github', `copilot-${plat}`);
		const inX64 = path.join(x64AppPath, relPath);
		const inArm64 = path.join(arm64AppPath, relPath);
		if (fs.existsSync(inX64) && !fs.existsSync(inArm64)) {
			console.log(`Copying missing copilot-${plat} to arm64 build`);
			fs.cpSync(inX64, inArm64, { recursive: true });
		} else if (fs.existsSync(inArm64) && !fs.existsSync(inX64)) {
			console.log(`Copying missing copilot-${plat} to x64 build`);
			fs.cpSync(inArm64, inX64, { recursive: true });
		}
		const relPathU = path.join('Contents', 'Resources', 'app', 'node_modules.asar.unpacked', '@github', `copilot-${plat}`);
		const inX64U = path.join(x64AppPath, relPathU);
		const inArm64U = path.join(arm64AppPath, relPathU);
		if (fs.existsSync(inX64U) && !fs.existsSync(inArm64U)) {
			fs.mkdirSync(path.dirname(inArm64U), { recursive: true });
			fs.cpSync(inX64U, inArm64U, { recursive: true });
		} else if (fs.existsSync(inArm64U) && !fs.existsSync(inX64U)) {
			fs.mkdirSync(path.dirname(inX64U), { recursive: true });
			fs.cpSync(inArm64U, inX64U, { recursive: true });
		}
	}

	const filesToSkip = [
		'**/CodeResources',
		'**/Credits.rtf',
		'**/policies/{*.mobileconfig,**/*.plist}',
		'**/node_modules/@github/copilot-darwin-x64/**',
		'**/node_modules/@github/copilot-darwin-arm64/**',
		'**/node_modules.asar.unpacked/@github/copilot-darwin-x64/**',
		'**/node_modules.asar.unpacked/@github/copilot-darwin-arm64/**',
	];

	await makeUniversalApp({
		x64AppPath,
		arm64AppPath,
		asarPath: asarRelativePath,
		outAppPath,
		force: true,
		mergeASARs: true,
		x64ArchFiles: '{*/kerberos.node,**/extensions/microsoft-authentication/dist/libmsalruntime.dylib,**/extensions/microsoft-authentication/dist/msal-node-runtime.node,**/node_modules/@github/copilot-darwin-*/copilot}',
		filesToSkipComparison: (file: string) => {
			for (const expected of filesToSkip) {
				if (minimatch(file, expected)) {
					return true;
				}
			}
			return false;
		}
	});

	const productJson = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
	Object.assign(productJson, {
		darwinUniversalAssetId: 'darwin-universal'
	});
	fs.writeFileSync(productJsonPath, JSON.stringify(productJson, null, '\t'));
}

if (import.meta.main) {
	main(process.argv[2]).catch(err => {
		console.error(err);
		process.exit(1);
	});
}
