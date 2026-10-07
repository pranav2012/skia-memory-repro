# fix(🤖): release a removed view's recorder without waiting for the Java finalizer

Refs #TODO-gpu-memory-issue

## Problem

On Android, `JniSkiaView::unregisterView()` calls `RNSkView::releaseContent()`, which only clears the producer's content. The view keeps its `RNSkGraphiteTarget` and its last presented recording. Both hold the view's Graphite recorder, with its resource cache and `ImageProvider`. They are only released when `SkiaView.finalize()` resets the hybrid data, which can take a long time in an app that allocates few Java objects. (On iOS the native view goes away in `removeFromSuperview`.)

In the repro's `images` scenario on a Samsung SM-S948B, `GL mtrack` stayed at **536 MB** for 45 s after the canvas was unmounted. In the `mount` scenario (40 mounts/unmounts of 2 animated canvases) it went from 24 to 43 MB and stayed there after the last unmount. With PR1+PR2+PR3 together on the same phone: `images` stays at 54 MB after unmount, and `mount` goes 25 → 26 MB and stays 26 after the last unmount. This PR was not measured on its own. For reference, on iOS (where this PR changes nothing, since views are already released in `removeFromSuperview`) the `images` scenario with PR1+PR2+PR3 fell to 42 MB after unmount, against 299 MB with 3.0.8.

## Change

- `RNSkView::releaseContent()` now also detaches the producer from the target and drops the view's target and last presented frame. It also asks the target to `releaseRecorder()`: drop the recorder unless a recording is open, plus the queued recordings, in case a JS context object (`SkiaViewApi.makeGraphiteContext`) still holds the target.
- `RNSkGraphiteProducer`:
  - `setTarget()` resets `_presentPending`, because a frame presented on the old target says nothing about the new one.
  - A recording that finishes after its target was replaced is dropped and the content is recorded again for the current target. Before, a stale `_presentPending` could stall a view that was registered again (recycled).
- A view registered again goes through `setNativeId()`, which already creates or looks up a target when `_target` is null.

## Risks

- `releaseContent()` is only called from `JniSkiaView::unregisterView()` (Android `onDropViewInstance`). If a dropped view were reused without `registerView`, it would have no target. Today that can't happen: `setNativeId` re-registers.
- A recording in flight on the thread pool when the view is released finishes against the old target and is then discarded. That is the intended behaviour for a view that is gone.

## Checks

- Standalone: applies to `main` (`67182c2`) without PR1 or PR2, and compiles on its own against the 3.0.8 sources (identical to `main` for these files) in a release build of the repro: Android arm64 (`./gradlew assembleRelease`) ✅. It does not depend on PR1.
- Combined with PR1 and PR2 (plus the Android MSAA line): Android arm64 ✅ and iOS device Release (`xcodebuild`) ✅.
- In `packages/skia` on this branch: `yarn tsc` ✅, `yarn lint` ✅, `yarn test` ✅ (810 passed, 87 skipped). This PR changes C++ only.
- clang-format (23.1.3, default style like `yarn clang-format`) applied to the changed files.
- Device measurements above are with PR1+PR2+PR3 together; this PR was not measured on its own. TODO if maintainers want the split.

## Suggested checks for maintainers

- e2e (`apps/example`, `yarn e2e`), plus manual navigation on Android between screens with animated canvases: make sure nothing goes blank when returning to a screen, and check `GL mtrack` after leaving one.
- The `SkiaGraphiteView` / `makeGraphiteContext` examples: a JS-held target after its view unmounts should no longer keep the recorder.
