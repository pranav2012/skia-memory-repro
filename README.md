# react-native-skia GPU memory repro

A minimal Expo app (SDK 57, React Native 0.86, Reanimated 4.5, `react-native-skia` 3.0.8) that measures GPU memory for a series of `<Canvas>` patterns. It was used to write the drafts in `upstream/`.

## Build

```sh
pnpm install
npx expo prebuild --no-install
# Android (release, arm64): needs JDK 17 and ANDROID_HOME
(cd android && ./gradlew assembleRelease)        # android/app/build/outputs/apk/release/app-release.apk
# iOS (release, device): set your team in app.json (ios.appleTeamId)
(cd ios && pod install && xcodebuild -workspace SkiaMemRepro.xcworkspace -scheme SkiaMemRepro \
  -configuration Release -destination 'generic/platform=iOS' -allowProvisioningUpdates build)
```

### Patched vs unpatched

`pnpm-workspace.yaml` applies `patches/react-native-skia@3.0.8.patch` through `patchedDependencies`. That patch is the three PR drafts together, plus the Android-only MSAA workaround from `issue-adreno-msaa.md`. For a stock build, remove the `patchedDependencies` entry and run `pnpm install`. Then delete the generated native build output (Gradle rebuilds the Skia module; `pod install` re-copies the frameworks).

Stock 3.0.8 crashes on the Samsung (Adreno) in the `pattern&p=dash`, `dashN` and `paths` scenarios (see `upstream/issue-adreno-msaa.md`). To measure those scenarios we used a build with only the MSAA line, `fInternalMultisampleCount = SampleCount::k1`.

## Scenarios

Each scenario has an in-app button and a deep link (`skiarepro://run?...`):

| Query | What it draws |
|---|---|
| `s=idle&n=1\|3\|5` | N canvases, each a full-screen runtime shader whose `time` uniform animates every frame |
| `s=dashN&n=N` | N canvases with stroked arcs rebuilt every frame (`usePathValue`) and an animated `DashPathEffect` |
| `s=paths` | one large self-intersecting filled path, rotating |
| `s=pattern&p=children\|childrenMip\|childrenNearest\|childrenGpu` | runtime shader with three 2048×1024 image children (encoded, raster or texture-backed; different sampling) |
| `s=pattern&p=clip\|layer` | rounded clip plus stacked shader fills; supersampled `layer` with a `RuntimeShader` image filter over paragraphs and moving clips |
| `s=xform&m=3d\|2d\|opacity\|card\|flip` | an animated canvas inside a native view whose transform or opacity changes every frame |
| `s=images&count=600&period=50&idle=60` | creates a 512×512 `SkImage` every 50 ms, draws it, disposes the previous one, then idles and unmounts |
| `s=mount&cycles=200&period=1000` | mounts and unmounts a screen with two animated canvases |
| `budget=<MB>` (with any of the above) | calls `Skia.setResourceCacheLimits({ recorderBytes })` on builds that have it |

The app keeps the screen on. Every 10 s it logs its own memory to `Documents/memlog.csv` (iOS) or `files/memlog.csv` (Android), using the local `modules/mem-probe` module: phys_footprint on iOS, Debug.MemoryInfo TOTAL PSS and Graphics on Android.

## Measuring

```sh
# Android: checks the phone is awake and unlocked, launches the scenario, samples dumpsys meminfo
scripts/android-run.sh <adb-serial> "s=dashN&n=3" 9 10 results/out.csv
# iOS: checks the phone is unlocked, launches, waits, copies memlog.csv from the app container
scripts/ios-run.sh <coredevice-id> "s=dashN&n=3" 95 results/out.csv
```

`results/` holds the raw CSVs from the runs in the drafts. In `android-unpatched-*.csv` and `android-301-*.csv`, the `gl_mtrack_mb` column is actually **EGL mtrack**: the sampler matched that row first, and was fixed later. Use their `graphics_mb` column, which is correct. Every `android-msaa-*`, `android-atlas2048-*`, `android-fixmsaa-*` and `android-patched-*` file has the correct GL mtrack column.

## Drafts

`upstream/` contains the issue and PR drafts (not posted). The patches there are against the `packages/skia/...` layout of `main` and apply with `git apply`.
