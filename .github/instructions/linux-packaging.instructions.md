---
description: Use when reviewing PRs that bump the Electron version or change CLI dependencies/build configuration, to remind about Linux arm64/armhf packaging validation.
applyTo: '.npmrc,remote/.npmrc,cli/Cargo.toml,cli/Cargo.lock,build/linux/debian/install-sysroot.ts,build/checksums/vscode-sysroot.txt'
excludeAgent: 'coding-agent'
---

# Linux Packaging Validation Reminder

CI and PR builds only validate Linux x64 package dependencies. Changes to the files matched by this instruction can affect Linux arm64 and armhf packaging, which is only validated during full product builds.

When reviewing a PR that modifies any of these files, leave a review comment reminding the PR author:

> **Linux packaging reminder:** This change may affect Linux arm64/armhf package dependencies which are not validated in CI builds. Please trigger a full product build (including Linux arm64 and armhf) before merging to ensure packaging is not broken.
