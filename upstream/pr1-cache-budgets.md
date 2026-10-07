# fix(🧠): give Graphite recorders a mobile-sized cache budget and purge unused resources

Fixes #TODO-gpu-memory-issue

## Problem

Each `<Canvas>` has its own Graphite `Recorder`, and neither recorders nor the `Context` get a budget, so both use Skia's 256 MB default. A canvas that draws paths every frame (Android, MSAA off) creates about 17 MB of GPU resources per frame. Released resources stay in the recorder's cache as purgeable until it reaches 256 MB, so each such canvas costs about 256 MB of GPU memory, and N canvases cost N times that.

Measured on a Samsung SM-S948B (`GL mtrack`, 90 s):

| Recorder budget | 1 path canvas | 3 path canvases |
|---|---|---|
| 256 MB (today) | 454 → 468 MB | 1192 → 1366 MB (rising) |
| 128 MB | 246 → 250 MB | 681 → 692 MB |
| **32 MB (this PR)** | **78 → 86 MB** | **174 → 187 MB** |
| 8 MB | – | 113 → 122 MB |

Canvases that don't churn resources (shaders, images, gradients) stay at 23–107 MB today. We didn't re-measure them with this change; a budget only purges cached, unused resources, so we expect no difference.

## Changes

- `RNDawnContext.h`
  - New defaults: `kDefaultRecorderBudget` = 32 MB and `kDefaultContextBudget` = 64 MB. They are applied to the per-view recorders (`makeRecorder()`), the thread-local recorders (`getRecorder()`) and the context.
  - `setResourceCacheLimits(recorderBytes, contextBytes)`: the context budget changes right away. Recorders pick up the new budget at their next cleanup, because a recorder may only be touched on its own thread.
  - `performRecorderCleanup(recorder, lastCleanup)`: runs `performDeferredCleanup(5 s)` at most every 2 s, and syncs the recorder's budget.
  - The context gets the same throttled cleanup after `insertRecordings()` and `submitRecording()`, under the existing mutex.
- `RNSkGraphiteTarget::finishRecording()` runs the recorder cleanup right after `snap()`. That is on the recording thread, under `_stateMutex`, with no recording open.
- `RNSkWindowSurface::presentImage()` cleans the main-thread recorder after its snap.
- JS API: `Skia.setResourceCacheLimits({ recorderBytes?, contextBytes? })`, typed in `Skia.ts`. It is a no-op on web (CanvasKit manages its own cache). A value you leave out keeps the current budget.

```ts
// e.g. an app with one big animated canvas that wants more headroom
Skia.setResourceCacheLimits({ recorderBytes: 64 * 1024 * 1024 });
```

## Why 32 MB

The budget is a soft limit. Resources still in use are never purged, so a frame that needs more than the budget still renders, and the cache just keeps nothing extra afterwards (see the 8 MB row). 32 MB keeps about 2 frames' worth of the heaviest path workload we measured, and it rendered identically in every repro scenario. Images held by the image provider are referenced, not purgeable, so a small budget doesn't make them re-upload. The context cache stayed under 1 MB in all our runs, so 64 MB is generous.

## Risks

- Content that relies on a large warm cache (for example many large offscreen layers reused across frames) may re-create more resources at 32 MB. In that case apps can raise the budget with `setResourceCacheLimits`.
- `performDeferredCleanup` costs a cache walk every 2 s per recorder. That is cheap, but it is new work on the recording thread.
- Thread-local recorders other than the main thread's (offscreen surfaces made on the JS thread) get the budget but no periodic cleanup. They are used for one-off work, so we left them alone.

## Checks

- In `packages/skia` on this branch (on top of `main` `67182c2`): `yarn tsc` ✅, `yarn lint` ✅, `yarn test` ✅ (97 suites passed, 9 skipped; 810 tests passed, 87 skipped).
- clang-format (23.1.3, default style like `yarn clang-format`; `main` itself is unchanged by it) applied to every changed C++ file.
- Compiled on its own against the 3.0.8 sources (identical to `main` for these files) in a release build of the repro: Android arm64 (`./gradlew assembleRelease`) ✅. Combined with PR2 and PR3 (plus the Android MSAA line): Android arm64 ✅ and iOS device Release (`xcodebuild`) ✅.
- `git submodule update` / `yarn copy-skia-headers` not run: the headers shipped in the npm package were enough to compile.
- Device measurements: the numbers above (Samsung) come from the same code before clang-format. The 128 MB and 8 MB rows used this PR with the budget changed. The 32 MB row was measured with PR1+PR2+PR3 together (PR2/PR3 don't touch the path workload). iOS with this change: pending (TODO).

## Suggested checks for maintainers

- e2e (`apps/example`, Tests screen, `yarn e2e`): no visual change expected.
- Manual: example screens with many animated canvases or paths on an Android device. Compare `adb shell dumpsys meminfo <pkg>` `GL mtrack` before and after.
- The repro (`<TODO link>`), or the same `dashN` scenario as an `apps/example` screen if you'd rather keep it in the repo.
