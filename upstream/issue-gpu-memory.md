# Android: every animated Canvas that draws paths fills its own 256 MB Graphite cache (N canvases ≈ N × 256 MB GPU memory)

## Summary

In v3 (Graphite/Dawn), every `<Canvas>` gets its own `skgpu::graphite::Recorder`. Neither the Recorder nor the Context gets a budget, so both use Skia's desktop default of 256 MB (`kDefaultRecorderBudget`, `kDefaultContextBudget`). With MSAA off on Android (the only workaround for the Adreno crash in #TODO-adreno-issue), drawing paths that change every frame churns GPU resources. Each frame's resources end up purgeable in the recorder's cache. Nothing purges them until the cache reaches its budget.

Each continuously animating Canvas that draws paths therefore settles at about 256 MB of GPU memory, and the cost adds up per canvas: 3 such canvases use 1.2–1.4 GB of `GL mtrack`. In a real app (several path canvases on one screen) we saw 2.1 GB, swap, and then a low-memory kill.

Lowering the per-recorder budget fixes it: with a 32 MB budget, 3 canvases use 174–187 MB instead of 1.2–1.4 GB, and nothing looks different.

## Environment

- react-native-skia **3.0.8** (`latest`), same sources as `main` at `67182c2` for every file referenced below. Graphite binaries 154.1.0.
- React Native 0.86.3, Expo SDK 57, New Architecture, Hermes, Reanimated 4.5.1, Worklets 0.10.1. Release builds.
- **Android:** Samsung Galaxy SM-S948B (`m3q`, SoC SM8850, Adreno, Vulkan), Android 17 (`CP2A.260605.016`, S948BXXS4BZIG).
- **iOS:** iPhone 16 Plus (iPhone17,4), Metal backend.

## Minimal repro

Repo: https://github.com/pranav2012/skia-memory-repro. Alternatively this could be a screen in `apps/example`; the repro is a single file and ports easily.

The repro uses the library the standard way: one full-screen `<Canvas>`, paths built with `usePathValue` from a Reanimated clock, and nothing created or leaked per frame on the JS side.

```tsx
function DashPattern({ width, height }: { width: number; height: number }) {
  const time = useTime(); // useFrameCallback -> shared value in seconds
  const arc = (builder: SkPathBuilder, offset: number) => {
    "worklet";
    const t = time.get() * 0.4 + offset;
    for (let i = 0; i <= 48; i++) {
      const s = i / 48;
      const x = width * (0.1 + 0.8 * s);
      const y = height * (0.5 + 0.3 * Math.sin(t + s * 3)) - Math.sin(s * Math.PI) * height * 0.2;
      if (i === 0) builder.moveTo(x, y); else builder.lineTo(x, y);
    }
  };
  const legs = usePathValue((b) => { "worklet"; arc(b, 0); arc(b, 1.5); });
  const next = usePathValue((b) => { "worklet"; arc(b, 3); });
  const march = useDerivedValue(() => 12 - ((time.get() * 30) % 12));
  return (
    <>
      <Fill color="#0b1020" />
      <Path path={legs} style="stroke" strokeWidth={4} color="#000" opacity={0.22} strokeCap="round" />
      <Path path={legs} style="stroke" strokeWidth={2.2} color="#fff" strokeCap="round">
        <DashPathEffect intervals={[6, 6]} />
      </Path>
      <Path path={next} style="stroke" strokeWidth={2.2} color="#fff" strokeCap="round">
        <DashPathEffect intervals={[6, 6]} phase={march} />
      </Path>
    </>
  );
}
// Screen: N of these, each in its own <Canvas style={{ flex: 1 }}>.
```

**Steps**

1. Build the repro (release). On Android the build needs `fInternalMultisampleCount = SampleCount::k1` (see the Adreno issue); without it the app crashes as soon as these paths draw.
2. Open `skiarepro://run?s=dashN&n=1`, then `skiarepro://run?s=dashN&n=3`.
3. Sample `adb shell dumpsys meminfo com.pranav.skiarepro` every 10 s (`scripts/android-sample.sh` in the repro) and read the `GL mtrack` row.

**Expected:** GPU memory roughly proportional to what one frame needs (about 17 MB per path canvas, see below), and nothing that scales into the gigabytes.

**Actual:** each path canvas holds about 256 MB more. 3 canvases use 1.2–1.4 GB and are still climbing after 90 s.

## Measurements

All numbers are the `GL mtrack` Pss in MB (the `GL mtrack` row of `dumpsys meminfo`, not `EGL mtrack`), first sample → sample after 85–90 s, 10 s interval, app in front, screen kept on. Android builds are release builds with MSAA off unless noted. Raw CSVs are in the repro's `results/` (`android-msaa-*`, `android-atlas2048-*`, `android-fixmsaa-*`, `android-patched-*`).

### Per-canvas scaling (Android, 3.0.8 with only the MSAA-off line)

| Scenario | GL mtrack (MB) |
|---|---|
| 1 canvas, runtime shader, only uniforms change | 22.9 → 22.9 |
| 1 canvas, 3 × 2048×1024 encoded images as runtime-shader children (default / linear+mipmap / nearest / texture-backed) | 70 → 70 / 87 → 87 / 70 → 70 / 108 → 107 |
| 1 canvas, large filled self-intersecting path, rotating | 439 → 447 |
| **1 canvas, dashed strokes rebuilt each frame (`dashN&n=1`)** | **454 → 468** |
| **3 canvases, dashed strokes (`dashN&n=3`)** | **1192 → 1366** (still rising) |

Without paths, the same canvases stay flat. I also checked uniform-only canvases (1 and 5 for 10 min), canvases inside parents with per-frame 3D, 2D or opacity transforms, a rounded-rect clip with 3 stacked shader fills, and a supersampled `layer` with a `RuntimeShader` image filter over paragraphs and moving clips. None of them grew. On 3.0.1 the uniform-only and image-children cases are flat as well. Those earlier runs were judged by the `Graphics` total (`GL` + `EGL mtrack` + `Gfx dev`), because the sampler's GL column was reading `EGL mtrack` at the time; the `Graphics` total stayed flat in every one of them.

### The path atlas size is not the cause

`ContextOptions::fMaxPathAtlasTextureSize` defaults to 8192 (`include/gpu/graphite/ContextOptions.h:98`). Capping it at 2048 changed nothing:

| `fMaxPathAtlasTextureSize` | 1 dash canvas | 3 dash canvases | large path |
|---|---|---|---|
| 8192 (default) | 454 → 468 | 1192 → 1366 | 439 → 447 |
| 2048 | 468 → 469 | 1158 → 1330 | 440 → 447 |

### What the caches hold (logging `currentBudgetedBytes()` after `performDeferredCleanup(5 s)` every 2 s)

With a 128 MB recorder budget and 3 dash canvases, each recorder sits at its budget, and almost all of it is purgeable:

```
SKMEM context budgeted 4KB -> 4KB purgeable 0KB
SKMEM recorder 0x…a850 budgeted 130675KB -> 130675KB purgeable 113177KB max 131072KB
SKMEM recorder 0x…3f30 budgeted 130512KB -> 130512KB purgeable 113007KB max 131072KB
SKMEM recorder 0x…75d0 budgeted 130465KB -> 130465KB purgeable 112975KB max 131072KB
```

With an 8 MB budget the same recorders hold only what a frame needs:

```
SKMEM recorder 0x…75d0 budgeted 17504KB -> 17504KB purgeable 0KB max 8192KB
```

So each frame of path rendering creates about 17 MB of GPU resources. Once released they stay in the recorder's cache as purgeable scratch resources until the budget forces a purge. They were all used within the last few seconds, so `performDeferredCleanup` frees almost nothing. **The budget is the only thing that bounds this memory**, and the default budget is 256 MB per canvas.

### Budget sweep (3.0.8 + MSAA off + the PR below; budget set at runtime with `Skia.setResourceCacheLimits`)

| Recorder budget | 1 dash canvas | 3 dash canvases |
|---|---|---|
| 256 MB (current, no change) | 454 → 468 | 1192 → 1366 |
| 128 MB | 246 → 250 | 681 → 692 |
| **32 MB (proposed default)** | **78 → 86** | **174 → 187** (174 → 192 when set at runtime instead of as the default) |
| 8 MB | – | 113 → 122 |

The paths render the same at 8 MB (screenshot checked).

### Related retention (separate PRs)

These come from the same repro, Android with MSAA off, otherwise unpatched.

| Scenario | GL mtrack (MB) | With fix |
|---|---|---|
| `images`: a 512×512 raster `SkImage` created every 50 ms for 30 s, drawn, then disposed from JS (at most 2 alive) | 55 → 535 while creating; **536 after drawing stops; 536 still 45 s after the canvas unmounted** | 55 → 56 while creating; 54 after drawing stops; 54 after unmount |
| `mount`: 40 × mount/unmount of a screen with 2 animated canvases | 24 → 43; 43 after the last unmount | 25 → 26; 26 after the last unmount |

iOS, `images` (phys_footprint, MB):

| | Peak while creating | 30 s after drawing stops | After unmount |
|---|---|---|---|
| 3.0.8 | 392 | 334 | 299 |
| With PR1+PR2+PR3 | 152 | 73 | 42 |

A single animated canvas sits at about 104 MB. "With fix" everywhere in this section means PR1+PR2+PR3 together (plus the Android MSAA line); the PRs were not measured one at a time.

### iOS

On iPhone 16 Plus (Metal, default MSAA), the path scenario does **not** reproduce: 3 dash canvases stay at 104 → 107 MB phys_footprint over 90 s. One uniform-only canvas goes from 102 to 107 MB over 13 min. Our guess is that with MSAA on, Graphite renders these paths without the per-frame churn seen through the Android MSAA-off path. The recorder budgets are still 256 MB on iOS, so other content could fill them the same way; we did not find such content.

## Root cause (3.0.8 / `main`, `packages/skia/…`)

1. **No budgets.** `cpp/rnskia/RNDawnContext.h:86-91` (`makeRecorder()`, one per view) and `:314-326` (`getRecorder()`, thread-local) build `RecorderOptions` without `fGpuBudgetInBytes`, and `:365-370` builds `ContextOptions` without `fGpuBudgetInBytes`. So every recorder gets `kDefaultRecorderBudget` = 256 MB (`include/gpu/graphite/Recorder.h:79-81`), and the context gets `kDefaultContextBudget` = 256 MB (`include/gpu/graphite/ContextOptions.h:123-127`).
2. **One recorder per view.** `cpp/rnskia/RNSkGraphiteTarget.h:160-168` creates one recorder per view target, so the 256 MB budget applies to each canvas separately.
3. **No cleanup.** Nothing ever calls `performDeferredCleanup` or `freeGpuResources`. `RNSkGraphiteTarget::finishRecording()` (`RNSkGraphiteTarget.h:187-201`) snaps and returns, so a recorder only trims its cache when it goes over budget.
4. **Image uploads outlive their images.** `cpp/rnskia/RNImageProvider.h:21,49-58,62,97`: the per-recorder `ImageProvider` keeps up to 256 GPU uploads in an `SkLRUCache` keyed by image ID. The cache never learns that a source image was released, so the uploads of disposed images stay until they are pushed out by 256 newer ones or the recorder dies (the `images` row above).
5. **Android keeps a removed view's recorder until GC.** `cpp/rnskia/RNSkView.h:148`: `releaseContent()` only clears the producer. The view's target (holding the recorder, its cache and its image provider) and the last presented recording are only dropped when `SkiaView.finalize()` runs (`android/src/main/java/com/reactnative/skia/SkiaView.java:198-202`, after `JniSkiaView::unregisterView`, `android/cpp/jni/include/JniSkiaView.h:94-103`). On iOS the view is released deterministically in `removeFromSuperview`.

## Proposed fix

Three independent PRs (drafts attached):

1. **Cache budgets (the main fix).** Give recorders a 32 MB default and the context 64 MB. Add `Skia.setResourceCacheLimits({ recorderBytes, contextBytes })` to override them. Also call a throttled `performDeferredCleanup(5 s)` on each view's recorder after `snap()`, and on the context after submit, so idle caches shrink.
2. **Image provider eviction.** Keep a reference to each upload's source image and drop uploads whose source only the cache still references.
3. **Release on detach (Android).** `releaseContent()` also drops the view's target, recorder and queued or last recordings instead of waiting for the Java finalizer.

Alternatives considered: capping `fMaxPathAtlasTextureSize` (no effect, see above), and calling `freeGpuResources()` periodically. The latter would also free resources still being reused frame to frame, and it adds stalls; a budget expresses the intent directly.
