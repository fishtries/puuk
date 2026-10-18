# Stage 7: Player Decomposition

**Owner:** Senior model leads; junior model may implement only isolated pure helpers/tests with an exact allowlist.  
**Dependencies:** Stage 6 contract accepted; feature destination approved by Stage 3.

## Target

Player files only, within the approved player feature tree. One responsibility per dispatch.

## Change

Reduce complexity by extracting cohesive responsibilities from the player controller and large presentation components. Preserve existing public behavior and introduce no new player feature.

## Suggested order

1. Extract and test pure track/queue identity helpers only if the Stage 8 contract is agreed; otherwise defer identity work.
2. Separate player presentation/gesture coordination from playback runtime only where a clear ownership boundary is demonstrated.
3. Separate queue/history/session telemetry from audio runtime only if tests and call contracts make the move behavior-preserving.
4. Split `FullPlayerModal` into meaningful presentation sections only where each section owns a coherent UI responsibility. Keep gesture and animation logic together when separating them would obscure coordination.
5. Keep the current background/color source near its real owner. Do not create a file solely to export one color or wrap one line.

## Constraints

- Do not change player visuals, copy, accessibility meaning, gestures, animation parameters, thresholds, timing, queue policy, playback order, background playback, lock-screen behavior, API calls, cache, or normalization.
- Do not change audio module versions or native patches.
- Preserve the player interface used by the rest of the app; adapt internally behind it.
- Every extraction must have a named responsibility, at least one concrete call-site/consumer, and a testability or readability benefit.
- Do not extract helpers that merely forward arguments or state.
- Do not migrate the whole player to TypeScript or a state library here.
- One logical extraction per task and review. Do not combine mass moves with behavior edits.

## Ownership

Senior owns controller/runtime and UI-state boundaries. Junior may edit only named pure helpers, their tests, and imports when the behavior is fully specified. No concurrent edits to player files.

## Observable acceptance

- Relevant Jest tests pass before and after each extraction.
- Any new pure module has focused tests for edge cases, not implementation mirroring.
- Existing player component tests pass.
- Bundle/export or GitHub Actions IPA build validation passes.
- Coordinator compares player screenshots/flows on physical iPhone where presentation or animation files changed. Check track change, artwork/background, lyrics, queue, gestures, loading/error state, and interruption/background/lock-screen behavior as applicable.
- Report explicitly distinguishes automated verification from manual device verification.

## Report

List responsibility moved, unchanged public contract, tests/checks, iPhone verification, and why the new module is worth its file. If that reason is weak, do not extract it.
