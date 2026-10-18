# Stage 1: Formatting and Focused Static Checks

**Owner:** Senior model decides rules; junior model may implement the approved configuration.  
**Dependencies:** Stage 0 accepted.

## Target

Existing JavaScript configuration and scripts under `app/ios/puuk-ios/`.

## Change

Reduce formatting drift between agent contributions and catch a small, useful set of common mistakes. First propose the smallest tool/configuration change; implement only after the senior approves whether it affects GitHub Actions and dependency installation.

## Constraints

- Do not format the entire repository or rewrite existing files for style.
- Prefer the project’s available toolchain. Do not add a native dependency. A JS-only development dependency is allowed only after checking lockfile and GitHub Actions install/test commands.
- ESLint rules must be compatible with the current React Native/Expo code and avoid speculative strictness that produces broad unrelated fixes.
- Prettier addresses formatting only; do not present it as an architecture or correctness check.
- Do not make lint a CI gate until the existing tree can pass without unrelated mass changes. The proposal must state whether it is advisory or blocking.
- Preserve existing test behavior and scripts.

## Ownership

Configuration and package scripts only, plus lockfile if an approved JS dev dependency is necessary. Do not reformat application source in this stage.

## Observable acceptance

- One documented formatter command yields stable formatting on a temporary/sample changed file or explicitly listed files.
- One lint command runs and reports actionable findings; any known baseline failures are listed, not hidden by disabling broad rules.
- Existing Jest command remains unchanged and runnable.
- GitHub Actions unsigned IPA workflow does not require signing changes or a new native module.
- Diff is limited to tool configuration/scripts and necessary lockfile changes.

## Report

List chosen rules, why they are useful, exact commands/results, baseline lint debt, CI impact, and files changed.
