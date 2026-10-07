# fix(🖼️): drop GPU uploads of images that were released

Refs #TODO-gpu-memory-issue

## Problem

Each recorder's `ImageProvider` (`cpp/rnskia/RNImageProvider.h`) keeps the GPU upload of every raster or lazy image it draws in an `SkLRUCache` of 256 entries. The cache key is the image's unique ID, and the cache holds no reference to the source image. So after JS disposes an image, its upload stays on the GPU until 256 newer images push it out or the recorder is destroyed.

The repro creates a 512×512 image every 50 ms, draws it, and disposes the previous one, with at most 2 alive in JS:

| | Android `GL mtrack` | iOS phys_footprint |
|---|---|---|
| Before creating images | 55 MB | ~104 MB (1 canvas) |
| After 600 images | 535 MB | 392 MB peak |
| 40 s after the last image, still drawing the last one | **536 MB** | **334 MB** |
| With this PR (PR1+2+3 build) | 55 → 56 MB while creating; 54 MB after drawing stops; 54 MB after unmount | peak 152 MB; 73 MB 30 s after drawing stops; 42 MB after unmount |

(On Android the 536 MB also survives unmounting the canvas; PR3 addresses that part.)

## Change

- Each cache entry keeps `sk_sp<const SkImage> source` next to its `texture`.
- `findOrCreate()` first calls `purgeReleasedImages()`, throttled to once a second. It removes entries whose source is `unique()`, meaning only the cache still references it: JS released the image and no recorder command draws it any more.

The provider is still per recorder and is only used on the recorder's thread, so this adds no locking.

## Risks

- The cache now keeps the CPU copy of an image alive until the next purge, which is at most 1 s later while the canvas draws images. If a canvas stops calling `findOrCreate` (it stopped drawing images), released sources and their uploads stay until it draws an image again or the recorder goes away. That is the same as today for the GPU side, plus the CPU copy. If that matters, `purgeReleasedImages()` could also run from the recorder cleanup in PR1.
- `unique()` is an atomic refcount read, so it is safe against releases on other threads. A source that is released concurrently is simply caught by the next purge.

## Checks

- Standalone: applies to `main` (`67182c2`) without PR1 or PR3, and compiles on its own against the 3.0.8 sources (identical to `main` for these files) in a release build of the repro: Android arm64 (`./gradlew assembleRelease`) ✅. It does not depend on PR1.
- Combined with PR1 and PR3 (plus the Android MSAA line): Android arm64 ✅ and iOS device Release (`xcodebuild`) ✅.
- In `packages/skia` on this branch: `yarn tsc` ✅, `yarn lint` ✅, `yarn test` ✅ (810 passed, 87 skipped). This PR changes C++ only.
- clang-format (23.1.3, default style like `yarn clang-format`) applied to the changed files.
- Device measurements above are with PR1+PR2+PR3 together; this PR was not measured on its own; happy to measure it separately if useful.

## Suggested checks for maintainers

- e2e: the image tests (`apps/example`, Tests screen, `yarn e2e`), to be sure mipmapped and non-mipmapped lookups still hit the cache.
- Manual: the repro's `images` scenario, or an `apps/example` screen that streams images. Check that `GL mtrack` returns to its baseline after images stop.
