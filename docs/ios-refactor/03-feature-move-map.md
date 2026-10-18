# Stage 3: Approve Feature Structure and Move Map

**Owner:** Senior model  
**Dependencies:** Stages 0 and 2 accepted  
**Mode:** design first; no broad file movement.

## Target

Current iOS source tree and tests, excluding generated `dist/`, native project files, and dependencies.

## Change

Create an evidence-based move map into feature-oriented folders. The proposed direction is:

```text
app/
features/
  auth/
  player/
    components/
      FullPlayer/
      MiniPlayer/
      Lyrics/
      Queue/
    hooks/
    services/
    __tests__/
  catalog/
  search/
  library/
  playlists/
  albums/
  settings/
navigation/
shared/
  api/
  storage/
  components/
  hooks/
  utils/
```

This is a proposal to validate, not a mandate to create every folder. A folder is created only when it receives real cohesive files. Artist artwork belongs to an `artists` feature if it owns artist-facing behavior; a reusable image primitive belongs in `shared` only when multiple features actually consume it. A drawing/visual mode may be a player subfeature if it is a player visualization, or a separate `drawing` feature if it owns an independent user workflow. Do not create either hypothetical feature now.

## Constraints

- Keep related feature UI, hooks, services, and tests close enough to navigate as one unit.
- Do not make a folder for every component or create empty directories.
- `shared` means proven reuse or platform/application infrastructure, not “might be reused later.”
- Keep Expo/native entry files, configuration, `ios/`, build scripts, and generated `dist/` where they are unless a concrete requirement says otherwise.
- Identify cross-feature dependencies and proposed public entry points before moving files.
- Do not change behavior, styling, text, gestures, audio lifecycle, API contracts, or screen names.

## Ownership

Senior authors/approves the map. This is a design artifact, not permission for a worker to move files yet.

## Observable acceptance

The approved map lists each current source/test file or coherent file group with:

- current path;
- destination path;
- owning feature and reason;
- whether it is shared and evidence of current multi-feature use;
- import updates expected;
- risk/verification needed.

Include proposed public boundaries between player, navigation, auth, settings, and screens. Avoid changing player architecture merely to fit the directory tree.

## Report

Return the approved move map and unresolved ownership decisions. No source file moves in this stage.
