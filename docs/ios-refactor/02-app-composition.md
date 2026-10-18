# Stage 2: App Composition

**Owner:** Senior model  
**Dependencies:** Stage 0 accepted; coordinate with Stage 6 design before touching player composition.

## Target

`App.js` and only the smallest set of new app-level modules needed to clarify bootstrap/composition.

## Change

Make the application entry point easier to read by separating startup/auth gating from the main authenticated shell where that creates a real responsibility boundary. Keep the visible player, navigation, and modal behavior unchanged.

## Constraints

- Preserve current order and semantics of settings load, server URL setup, last-track restoration, audio-cache initialization, auth check/listener setup, and user changes.
- Preserve loading and signed-out screens, navigation ref behavior, global modal behavior, and player layer stacking/gestures.
- Do not add a global store, context, or generic bootstrap framework in this stage.
- Do not split files just to reduce line count. Each extracted module must own a cohesive lifecycle or composition responsibility.
- Do not change the ambient/color background or its current source of truth.
- Treat current dirty changes as baseline; inspect them before editing and keep them intact.

## Ownership

Senior owns `App.js` and any app-level extracted module. Other agents must not edit these files concurrently. Do not move feature screens or player components in this stage.

## Observable acceptance

- `App.js` reads primarily as top-level composition rather than containing all bootstrap and shell details.
- Existing Jest suite passes.
- Expo bundle/export or applicable CI validation passes.
- Manual regression checklist is recorded for auth gate, startup restoration, main navigation, global modals, mini-player/full-player layer order.
- Physical iPhone check is required if changed code affects player mounting, app foreground/background lifecycle, or audio ownership.
- Diff demonstrates no intentional visible or functional changes.

## Report

Describe extracted ownership and lifecycle ordering; list commands/results and any iPhone checks still required. Stop if a behavior-preserving extraction cannot be made confidently.
