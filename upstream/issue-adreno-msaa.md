# Android (Adreno): SIGSEGV in `vkCreateFramebuffer` when a Canvas draws stroked or large paths

## Summary

On a Samsung Galaxy SM-S948B (Adreno, Vulkan), react-native-skia 3.0.8 crashes the app with SIGSEGV as soon as a `<Canvas>` draws animated stroked paths or a large filled path. The crash is inside the Adreno Vulkan driver's `vkCreateFramebuffer`, called from Dawn while Graphite begins a render pass.

The only workaround we found is to turn off Graphite's internal MSAA (`ContextOptions::fInternalMultisampleCount = SampleCount::k1`). That workaround in turn sends paths through a code path that fills each canvas's 256 MB resource cache (see #TODO-gpu-memory-issue).

## Environment

- react-native-skia 3.0.8 (`latest`; the relevant sources are identical to `main` at `67182c2`), Graphite binaries 154.1.0, Dawn Vulkan backend
- React Native 0.86.3, Expo SDK 57, New Architecture, release build
- Samsung Galaxy SM-S948B (`m3q`, SoC SM8850, `ro.hardware.vulkan=adreno`), Android 17
- Build fingerprint `samsung/m3qxins/m3q:17/CP2A.260605.016/S948BXXS4BZIG_OXM4BZIG:user/release-keys`
- Driver: `/vendor/lib64/hw/vulkan.adreno.so`, BuildId `a9d225179b4390de37080a63dd2e9a24`

## Repro

Repo: https://github.com/pranav2012/skia-memory-repro. Both scenarios use the library the standard way:

- `skiarepro://run?s=pattern&p=dash`: one full-screen Canvas with stroked arcs rebuilt each frame by `usePathValue`, a `DashPathEffect` with an animated phase, and a pulsing stroked `Circle`. Code is in the GPU memory issue.
- `skiarepro://run?s=paths`: one full-screen Canvas with a single filled, self-intersecting 97-point star spanning the screen, rotated by a `Group` transform driven by a shared value.

```tsx
function makeStar(width: number, height: number) {
  const builder = Skia.PathBuilder.Make();
  const r = Math.max(width, height) * 0.6;
  for (let i = 0; i < 97; i++) {
    const a = (i * 2 * Math.PI * 41) / 97;
    const x = width / 2 + r * Math.cos(a), y = height / 2 + r * Math.sin(a);
    i === 0 ? builder.moveTo(x, y) : builder.lineTo(x, y);
  }
  builder.close();
  return builder.detach();
}
// <Canvas style={{ flex: 1 }}>
//   <Group origin={center} transform={rotation /* derived value */}>
//     <Path path={star} color="#f84" />
//   </Group>
// </Canvas>
```

**Steps:** install the release build on the device and open either deep link.

**Expected:** the paths render.

**Actual:** the process dies within about a second of the first frame. It happened with both scenarios, on every attempt (2 of 2).

## Crash

```
F libc    : Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x8 in tid 24297 (ranav.skiarepro)
F DEBUG   : signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0000000000000008 (read)
F DEBUG   : backtrace:
  #00 pc 00000000002bb3f0  /vendor/lib64/hw/vulkan.adreno.so (!!!0000!db133968c896ab4da80ab74ca293d0!089d643e2a!+272)
  #01 pc 00000000001b0094  /vendor/lib64/hw/vulkan.adreno.so (!!!0000!f29c702e83e1ff0960bb4066d06322!089d643e2a!+1108)
  #02 pc 00000000001afad8  /vendor/lib64/hw/vulkan.adreno.so (qglinternal::vkCreateFramebuffer(...)+248)
  #03 pc 0000000000831904  libwebgpu_dawn.so (dawn::native::vulkan::RecordBeginRenderPass(...)+2120)
  #04 pc 0000000000833ac0  libwebgpu_dawn.so (dawn::native::vulkan::CommandBuffer::RecordRenderPass(...)+208)
  #05 pc 0000000000832efc  libwebgpu_dawn.so (dawn::native::vulkan::CommandBuffer::RecordCommands(...)+2952)
  #06 pc 0000000000858090  libwebgpu_dawn.so (dawn::native::vulkan::Queue::SubmitImpl(...)+76)
  #07 pc 00000000007768b0  libwebgpu_dawn.so (dawn::native::QueueBase::SubmitInternal(...)+180)
  ...
  #13 pc 000000000055407c  librnskia.so (RNSkia::DawnContext::insertRecordings(...)+268)
  #14 pc 0000000000747fc4  librnskia.so (RNSkia::RNSkWindowSurface::presentRecordings(...)+372)
  #15 pc 0000000000553058  librnskia.so (RNSkia::RNSkView::present(...)+832)
  #16 pc 000000000055ba5c  librnskia.so (RNSkia::RNSkView::presentFrame()+168)
  ...  com.reactnative.skia.SkiaView.presentFrame <- FrameScheduler.onPosted (main thread)
```

The full tombstones for both crashes are in the repro at `results/android-unpatched-crash-logcat.txt`.

## What we know, and what we don't

**Known:**

- The crash reproduces on unpatched 3.0.8 with both path scenarios. It does not happen with canvases that only draw shaders, images, gradients, clips, rounded rects, paragraphs or a `layer` with a `RuntimeShader` image filter. Those all ran for minutes on the same device.
- Setting `ctxOptions.fInternalMultisampleCount = skgpu::graphite::SampleCount::k1` in `DawnContext()` (`cpp/rnskia/RNDawnContext.h:365-370`) stops the crash completely: both scenarios ran for 90 s+ in every later run. The default is `SampleCount::k4` (`include/gpu/graphite/ContextOptions.h:54`). Because the crash goes away exactly when Graphite stops opening multisampled render passes, the MSAA render pass's framebuffer is the likely trigger.
- The same workaround first appeared in a production app on the same device model with 3.0.1, where the globe's route paths crashed in `vkCreateFramebuffer`.
- iOS (Metal, MSAA on) renders the same scenarios fine.

**Not known:**

- We have tested only one Adreno device and driver build. We don't know which Adreno generations or driver versions are affected.
- Our tombstone has no Vulkan validation output, so we don't know what makes the framebuffer invalid for the driver: an attachment combination (MSAA color plus resolve plus depth/stencil), the attachment size, or the format.
- We haven't checked whether `fInternalMSAATileSize` or a path-size threshold for MSAA (the options next to `fInternalMultisampleCount` in `ContextOptions.h`) would avoid the crash while keeping MSAA.
- We haven't checked whether this should be reported to Dawn or Skia rather than handled here.

## Consequence of the workaround

With MSAA off, the same path canvases use about 450 MB of `GL mtrack` each, and 3 of them use 1.2–1.4 GB, because the per-recorder cache fills to its 256 MB default. A small default recorder budget fixes that (#TODO-gpu-memory-issue / PR "cache budgets"). Until this crash is understood, Android apps that draw animated paths are stuck choosing between the crash and the memory cost unless both changes land.

## Possible directions

- Disable internal MSAA on Adreno only, detected from the adapter info (vendor `0x5143`). That is narrower than the `#ifdef __ANDROID__` we use today.
- Try `fInternalMSAATileSize` (for example 1024×1024) or the small-path MSAA threshold to see whether smaller MSAA attachments avoid the driver bug.
- Capture with Vulkan validation layers on the device and report upstream to Dawn or Skia with the framebuffer create info.
