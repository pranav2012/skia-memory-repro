import { useEffect, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import {
  AlphaType,
  FilterMode,
  MipmapMode,
  DashPathEffect,
  ImageShader,
  LinearGradient,
  Paint,
  Paragraph,
  RoundedRect,
  RuntimeShader,
  rect,
  rrect,
  usePathValue,
  vec,
  type SkParagraph,
  Blur,
  ColorType,
  Canvas,
  Circle,
  Fill,
  Group,
  Image,
  Path,
  Shader,
  Skia,
  type SkImage,
} from "react-native-skia";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
} from "react-native-reanimated";

import { MemProbe } from "./modules/mem-probe";

// The whole frame is one runtime shader; only its `time` uniform changes.
const effect = Skia.RuntimeEffect.Make(`
uniform float time;
uniform float2 res;

half4 main(float2 xy) {
  float2 uv = xy / res;
  float3 c = 0.5 + 0.5 * cos(time + uv.xyx + float3(0, 2, 4));
  return half4(half3(c), 1);
}`)!;

type Scenario =
  | { kind: "none" }
  | { kind: "idle"; n: number }
  | { kind: "mount"; cycles: number; periodMs: number }
  | { kind: "images"; count: number; periodMs: number; idleSec: number }
  | { kind: "paths" }
  | { kind: "pattern"; name: PatternName }
  | { kind: "xform"; mode: XformMode }
  | { kind: "dashN"; n: number };

type XformMode = "3d" | "2d" | "opacity" | "card" | "flip";
const XFORMS: XformMode[] = ["3d", "2d", "opacity", "card", "flip"];

type PatternName = "children" | "childrenMip" | "childrenNearest" | "childrenGpu" | "dash" | "clip" | "layer";
const PATTERNS: PatternName[] = ["children", "childrenMip", "childrenNearest", "childrenGpu", "dash", "clip", "layer"];

const MB = 1024 * 1024;

// skiarepro://run?s=idle&n=3 | s=mount&cycles=200&period=1000 | s=images&count=600&period=50&idle=60
function parseScenario(url: string | null): Scenario | null {
  if (!url) {
    return null;
  }
  const query = url.split("?")[1] ?? "";
  const params = new Map(
    query.split("&").map((pair) => pair.split("=") as [string, string])
  );
  applyCacheLimits(params.get("budget"));
  const num = (key: string, fallback: number) => {
    const value = Number(params.get(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  switch (params.get("s")) {
    case "idle":
      return { kind: "idle", n: num("n", 1) };
    case "mount":
      return { kind: "mount", cycles: num("cycles", 200), periodMs: num("period", 1000) };
    case "images":
      return {
        kind: "images",
        count: num("count", 600),
        periodMs: num("period", 50),
        idleSec: num("idle", 60),
      };
    case "paths":
      return { kind: "paths" };
    case "dashN":
      return { kind: "dashN", n: num("n", 3) };
    case "xform": {
      const mode = params.get("m") as XformMode;
      return XFORMS.includes(mode) ? { kind: "xform", mode } : null;
    }
    case "pattern": {
      const name = params.get("p") as PatternName;
      return PATTERNS.includes(name) ? { kind: "pattern", name } : null;
    }
    case "none":
      return { kind: "none" };
    default:
      return null;
  }
}

// budget=<MB>: per-recorder GPU cache budget, on builds whose Skia has setResourceCacheLimits.
function applyCacheLimits(budgetMb: string | undefined) {
  const api = Skia as unknown as {
    setResourceCacheLimits?: (limits: { recorderBytes?: number }) => void;
  };
  const mb = Number(budgetMb);
  if (budgetMb && Number.isFinite(mb) && api.setResourceCacheLimits) {
    api.setResourceCacheLimits({ recorderBytes: mb * MB });
  }
}

function useTime() {
  const time = useSharedValue(0);
  useFrameCallback((info) => {
    time.value = info.timeSinceFirstFrame / 1000;
  });
  return time;
}

function useSize() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ width, height });
  };
  return [size, onLayout] as const;
}

function ShaderCanvas() {
  const time = useTime();
  const [size, onLayout] = useSize();
  const uniforms = useDerivedValue(() => ({
    time: time.value,
    res: [size.width, size.height],
  }));
  return (
    <Canvas style={styles.fill} onLayout={onLayout}>
      <Fill>
        <Shader source={effect} uniforms={uniforms} />
      </Fill>
    </Canvas>
  );
}

function BlurCanvas() {
  const time = useTime();
  const [size, onLayout] = useSize();
  const cx = useDerivedValue(
    () => size.width / 2 + Math.sin(time.value * 2) * size.width * 0.3
  );
  return (
    <Canvas style={styles.fill} onLayout={onLayout}>
      <Circle cx={cx} cy={size.height / 2} r={size.height / 4} color="#4af">
        <Blur blur={12} />
      </Circle>
    </Canvas>
  );
}

function IdleScenario({ n }: { n: number }) {
  return (
    <View style={styles.fill}>
      {Array.from({ length: n }, (_, i) => (
        <ShaderCanvas key={i} />
      ))}
    </View>
  );
}

// Mounts and unmounts a small "screen" with two animated canvases.
function MountScenario({
  cycles,
  periodMs,
  onPhase,
}: {
  cycles: number;
  periodMs: number;
  onPhase: (phase: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const [done, setDone] = useState(0);
  useEffect(() => {
    onPhase("cycling");
    let count = 0;
    const id = setInterval(() => {
      count += 1;
      setVisible((v) => !v);
      setDone(count);
      if (count >= cycles * 2) {
        clearInterval(id);
        setVisible(false);
        onPhase("unmounted-idle");
      }
    }, periodMs);
    return () => clearInterval(id);
  }, [cycles, periodMs, onPhase]);
  return (
    <View style={styles.fill}>
      <Text style={styles.text}>
        mounts: {Math.ceil(done / 2)} / {cycles}
      </Text>
      {visible && (
        <View style={styles.fill}>
          <ShaderCanvas />
          <BlurCanvas />
        </View>
      )}
    </View>
  );
}

// A self-intersecting star spanning the whole canvas: a large, complex path.
function makeStar(width: number, height: number) {
  const builder = Skia.PathBuilder.Make();
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.max(width, height) * 0.6;
  const points = 97;
  for (let i = 0; i < points; i++) {
    const a = (i * 2 * Math.PI * 41) / points;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) {
      builder.moveTo(x, y);
    } else {
      builder.lineTo(x, y);
    }
  }
  builder.close();
  return builder.detach();
}

function PathsScenario() {
  const time = useTime();
  const [size, onLayout] = useSize();
  const path = size.width > 0 ? makeStar(size.width, size.height) : null;
  const transform = useDerivedValue(() => [{ rotate: time.value * 0.5 }]);
  return (
    <Canvas style={styles.fill} onLayout={onLayout}>
      {path && (
        <Group origin={{ x: size.width / 2, y: size.height / 2 }} transform={transform}>
          <Path path={path} color="#f84" />
        </Group>
      )}
    </Canvas>
  );
}

// Runtime shader sampling three large, static image shaders; only uniforms change per frame.
const MIX = Skia.RuntimeEffect.Make(`
uniform shader a;
uniform shader b;
uniform shader c;
uniform float time;
uniform float2 res;

half4 main(float2 xy) {
  float2 uv = xy / res;
  float2 p = float2(fract(uv.x + time * 0.05) * 2048.0, uv.y * 1024.0);
  return mix(a.eval(p), b.eval(p.yx), 0.5) + c.eval(p * 0.5) * 0.2;
}`)!;

// Image filter for a layer: bends the layer's content around a moving lens.
const LENS = Skia.RuntimeEffect.Make(`
uniform shader image;
uniform float2 center;
uniform float radius;

half4 main(float2 xy) {
  float2 d = xy - center;
  float k = smoothstep(radius, 0.0, length(d));
  return image.eval(center + d * (1.0 - 0.3 * k)) + half4(0.1, 0.1, 0.2, 0) * k;
}`)!;

// A 2048x1024 texture decoded from a PNG, like an app's bundled assets.
function makeEncodedTexture(seed: number): SkImage | null {
  const w = 2048;
  const h = 1024;
  const pixels = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = 0xff000000 | (((y * 255) / h) << (seed * 8)) | (seed * 40);
    pixels.fill(row, y * w, (y + 1) * w);
  }
  const data = Skia.Data.fromBytes(new Uint8Array(pixels.buffer));
  const raster = Skia.Image.MakeImage(
    { width: w, height: h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Opaque },
    data,
    w * 4
  );
  data.dispose();
  if (!raster) {
    return null;
  }
  const encoded = Skia.Data.fromBytes(raster.encodeToBytes());
  raster.dispose();
  const image = Skia.Image.MakeImageFromEncoded(encoded);
  encoded.dispose();
  return image;
}

// The same texture drawn into an offscreen GPU surface: a texture-backed image.
function makeGpuTexture(seed: number): SkImage | null {
  const source = makeEncodedTexture(seed);
  const surface = Skia.Surface.MakeOffscreen(2048, 1024);
  if (!source || !surface) {
    return null;
  }
  surface.getCanvas().drawImage(source, 0, 0);
  surface.flush();
  const image = surface.makeImageSnapshot();
  source.dispose();
  return image;
}

const SAMPLING = {
  default: undefined,
  mip: { filter: FilterMode.Linear, mipmap: MipmapMode.Linear },
  nearest: { filter: FilterMode.Nearest, mipmap: MipmapMode.None },
};

function ChildrenPattern({
  width,
  height,
  sampling = "default",
  gpu = false,
}: {
  width: number;
  height: number;
  sampling?: keyof typeof SAMPLING;
  gpu?: boolean;
}) {
  const time = useTime();
  const [textures, setTextures] = useState<(SkImage | null)[]>([]);
  useEffect(() => {
    const made = [0, 1, 2].map(gpu ? makeGpuTexture : makeEncodedTexture);
    setTextures(made);
    return () => made.forEach((image) => image?.dispose());
  }, [gpu]);
  const uniforms = useDerivedValue(() => ({ time: time.value, res: [width, height] }));
  if (textures.length < 3 || textures.some((t) => !t)) {
    return null;
  }
  return (
    <Fill>
      <Shader source={MIX} uniforms={uniforms}>
        {textures.map((image, i) => (
          <ImageShader
            key={i}
            image={image}
            fit="fill"
            x={0}
            y={0}
            width={2048}
            height={1024}
            sampling={SAMPLING[sampling]}
          />
        ))}
      </Shader>
    </Fill>
  );
}

// Stroked arcs rebuilt every frame (they follow a rotating view) with marching dashes.
function DashPattern({ width, height }: { width: number; height: number }) {
  const time = useTime();
  const arc = (builder: SkPathBuilderLike, offset: number) => {
    "worklet";
    const t = time.value * 0.4 + offset;
    for (let i = 0; i <= 48; i++) {
      const s = i / 48;
      const x = width * (0.1 + 0.8 * s);
      const y = height * (0.5 + 0.3 * Math.sin(t + s * 3)) - Math.sin(s * Math.PI) * height * 0.2;
      if (i === 0) {
        builder.moveTo(x, y);
      } else {
        builder.lineTo(x, y);
      }
    }
  };
  const legs = usePathValue((builder) => {
    "worklet";
    arc(builder, 0);
    arc(builder, 1.5);
  });
  const next = usePathValue((builder) => {
    "worklet";
    arc(builder, 3);
  });
  const march = useDerivedValue(() => 12 - ((time.value * 30) % 12));
  const ring = useDerivedValue(() => 8 + ((time.value % 1.6) / 1.6) * 16);
  return (
    <>
      <Fill color="#0b1020" />
      <Path path={legs} style="stroke" strokeWidth={4} color="#000" opacity={0.22} strokeCap="round" />
      <Path path={legs} style="stroke" strokeWidth={2.2} color="#fff" strokeCap="round">
        <DashPathEffect intervals={[6, 6]} />
      </Path>
      <Path path={next} style="stroke" strokeWidth={4} color="#000" opacity={0.22} strokeCap="round" />
      <Path path={next} style="stroke" strokeWidth={2.2} color="#fff" strokeCap="round">
        <DashPathEffect intervals={[6, 6]} phase={march} />
      </Path>
      <Circle cx={width / 2} cy={height / 2} r={ring} style="stroke" strokeWidth={2} color="#4af" />
    </>
  );
}

type SkPathBuilderLike = { moveTo(x: number, y: number): unknown; lineTo(x: number, y: number): unknown };

// A card clipped to a rounded rect: gradient plus two animated runtime shaders.
function ClipPattern({ width, height }: { width: number; height: number }) {
  const time = useTime();
  const uniforms = useDerivedValue(() => ({ time: time.value, res: [width, height] }));
  const card = rrect(rect(16, 16, width - 32, height * 0.4), 24, 24);
  return (
    <Group clip={card}>
      <Fill>
        <LinearGradient start={vec(0, 0)} end={vec(width, height)} colors={["#123", "#345"]} />
      </Fill>
      <Fill opacity={0.5}>
        <Shader source={effect} uniforms={uniforms} />
      </Fill>
      <Fill opacity={0.3}>
        <Shader source={effect} uniforms={uniforms} />
      </Fill>
    </Group>
  );
}

// A supersampled layer whose paint is a runtime-shader image filter, over text and clips that move.
function LayerPattern({ width, height }: { width: number; height: number }) {
  const time = useTime();
  const [labels, setLabels] = useState<SkParagraph[]>([]);
  useEffect(() => {
    const made = ["Home", "Trips", "Money", "Safety", "AI"].map((label) => {
      const builder = Skia.ParagraphBuilder.Make({ textAlign: 2 });
      builder.pushStyle({ color: Skia.Color("#fff"), fontSize: 14 });
      builder.addText(label);
      const paragraph = builder.build();
      paragraph.layout(width / 5);
      return paragraph;
    });
    setLabels(made);
  }, [width]);
  const pd = 2;
  const barY = height * 0.45;
  const pillX = useDerivedValue(() => (width - 80) * (0.5 + 0.5 * Math.sin(time.value)));
  const uniforms = useDerivedValue(() => ({ center: [(pillX.value + 40) * pd, (barY + 30) * pd], radius: 50 * pd }));
  const drop = useDerivedValue(() => rrect(rect(pillX.value, barY + 5, 80, 50), 25, 25));
  return (
    <Group transform={[{ scale: 1 / pd }]}>
      <Group
        transform={[{ scale: pd }]}
        layer={
          <Paint>
            <RuntimeShader source={LENS} uniforms={uniforms} />
          </Paint>
        }
      >
        <RoundedRect x={8} y={barY} width={width - 16} height={60} r={30} style="stroke" strokeWidth={1}>
          <LinearGradient start={vec(0, barY)} end={vec(width, barY + 60)} colors={["#fff", "#888", "#fff"]} />
        </RoundedRect>
        <RoundedRect x={pillX} y={barY + 5} width={80} height={50} r={25} color="#ffffff33" />
        <Group clip={drop} invertClip>
          {labels.map((p, i) => (
            <Paragraph key={i} paragraph={p} x={(width / 5) * i} y={barY + 20} width={width / 5} />
          ))}
        </Group>
        <Group clip={drop}>
          {labels.map((p, i) => (
            <Paragraph key={i} paragraph={p} x={(width / 5) * i} y={barY + 22} width={width / 5} />
          ))}
        </Group>
      </Group>
    </Group>
  );
}

// One uniform-animated canvas inside a native view whose style changes every frame.
function XformScenario({ mode }: { mode: XformMode }) {
  const time = useTime();
  const style = useAnimatedStyle(() => {
    const t = time.value;
    switch (mode) {
      case "3d":
      case "card":
      case "flip":
        return {
          transform: [
            { perspective: 1000 },
            { rotateX: `${Math.sin(t) * 10}deg` },
            { rotateY: `${Math.cos(t * 0.7) * 10}deg` },
          ],
        };
      case "2d":
        return { transform: [{ translateX: Math.sin(t) * 20 }, { scale: 0.9 + 0.05 * Math.sin(t * 0.7) }] };
      default:
        return { opacity: 0.6 + 0.4 * Math.sin(t) };
    }
  });
  return (
    <View style={[styles.fill, styles.pad]}>
      <Animated.View style={[styles.fill, style]}>
        {mode === "card" && <CardCanvas />}
        {mode === "flip" && <FlipFaces />}
        {mode !== "card" && mode !== "flip" && <ShaderCanvas />}
      </Animated.View>
    </View>
  );
}

// Front and back faces stacked, each with its own canvas; opacity swaps every two seconds.
function FlipFaces() {
  const time = useTime();
  const front = useAnimatedStyle(() => ({ opacity: Math.floor(time.value / 2) % 2 === 0 ? 1 : 0 }));
  const back = useAnimatedStyle(() => ({ opacity: Math.floor(time.value / 2) % 2 === 0 ? 0 : 1 }));
  return (
    <View style={styles.fill}>
      <Animated.View style={[StyleSheet.absoluteFill, front]}>
        <CardCanvas />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, back]}>
        <ShaderCanvas />
      </Animated.View>
    </View>
  );
}

// The card itself: a rounded clip with a gradient and two animated shaders.
function CardCanvas() {
  const [size, onLayout] = useSize();
  return (
    <Canvas style={styles.fill} onLayout={onLayout}>
      {size.width > 0 && <ClipPattern {...size} />}
    </Canvas>
  );
}

function PatternScenario({ name }: { name: PatternName }) {
  const [size, onLayout] = useSize();
  const ready = size.width > 0;
  return (
    <Canvas style={styles.fill} onLayout={onLayout}>
      {ready && name === "children" && <ChildrenPattern {...size} />}
      {ready && name === "childrenMip" && <ChildrenPattern {...size} sampling="mip" />}
      {ready && name === "childrenNearest" && <ChildrenPattern {...size} sampling="nearest" />}
      {ready && name === "childrenGpu" && <ChildrenPattern {...size} gpu />}
      {ready && name === "dash" && <DashPattern {...size} />}
      {ready && name === "clip" && <ClipPattern {...size} />}
      {ready && name === "layer" && <LayerPattern {...size} />}
    </Canvas>
  );
}

const IMAGE_SIZE = 512;

// A new 512x512 raster image (1 MB) with different pixels each time.
function makeImage(seed: number): SkImage | null {
  const pixels = new Uint32Array(IMAGE_SIZE * IMAGE_SIZE);
  const color = 0xff000000 | ((seed * 2654435761) & 0xffffff);
  pixels.fill(color);
  const stripe = (seed * 7) % IMAGE_SIZE;
  pixels.fill(0xffffffff, stripe * IMAGE_SIZE, (stripe + 8) * IMAGE_SIZE);
  const data = Skia.Data.fromBytes(new Uint8Array(pixels.buffer));
  const image = Skia.Image.MakeImage(
    {
      width: IMAGE_SIZE,
      height: IMAGE_SIZE,
      colorType: ColorType.RGBA_8888,
      alphaType: AlphaType.Opaque,
    },
    data,
    IMAGE_SIZE * 4
  );
  data.dispose();
  return image;
}

// Creates, draws and disposes images: JS never keeps more than two alive.
function ImagesScenario({
  count,
  periodMs,
  idleSec,
  onPhase,
}: {
  count: number;
  periodMs: number;
  idleSec: number;
  onPhase: (phase: string) => void;
}) {
  const image = useSharedValue<SkImage | null>(null);
  const [size, onLayout] = useSize();
  const [made, setMade] = useState(0);
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    onPhase("creating");
    const live: SkImage[] = [];
    let n = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const id = setInterval(() => {
      n += 1;
      const next = makeImage(n);
      if (next) {
        live.push(next);
        image.value = next;
      }
      // The previous frame may still be drawing the one before: dispose it one tick later.
      while (live.length > 2) {
        live.shift()!.dispose();
      }
      if (n % 20 === 0) {
        setMade(n);
      }
      if (n >= count) {
        clearInterval(id);
        setMade(n);
        onPhase("drawn-idle");
        idleTimer = setTimeout(() => {
          setMounted(false);
          onPhase("unmounted-idle");
        }, idleSec * 1000);
      }
    }, periodMs);
    return () => {
      clearInterval(id);
      clearTimeout(idleTimer);
    };
  }, [count, periodMs, idleSec, image, onPhase]);
  return (
    <View style={styles.fill}>
      <Text style={styles.text}>
        images created and disposed: {made} / {count}
      </Text>
      {mounted && (
        <Canvas style={styles.fill} onLayout={onLayout}>
          <Image
            image={image}
            x={0}
            y={0}
            width={size.width}
            height={size.height}
            fit="cover"
          />
        </Canvas>
      )}
    </View>
  );
}

function useMemorySampler(label: string, phase: string) {
  const [line, setLine] = useState("");
  const start = useRef(Date.now());
  const ref = useRef({ label, phase });
  ref.current = { label, phase };
  useEffect(() => {
    start.current = Date.now();
    MemProbe?.clearLog();
    MemProbe?.appendLog("elapsed_s,scenario,phase,app_state,footprint_mb,graphics_mb");
  }, [label]);
  useEffect(() => {
    const sample = () => {
      const elapsed = Math.round((Date.now() - start.current) / 1000);
      const footprint = (MemProbe?.footprint() ?? -1) / MB;
      const graphics = (MemProbe?.graphics() ?? -1) / MB;
      const csv = `${elapsed},${ref.current.label},${ref.current.phase},${AppState.currentState},${footprint.toFixed(1)},${graphics.toFixed(1)}`;
      MemProbe?.appendLog(csv);
      setLine(
        `${elapsed}s ${ref.current.phase} footprint ${footprint.toFixed(0)} MB` +
          (graphics >= 0 ? ` graphics ${graphics.toFixed(0)} MB` : "")
      );
    };
    sample();
    const id = setInterval(sample, 10000);
    return () => clearInterval(id);
  }, [label]);
  return line;
}

function label(s: Scenario) {
  switch (s.kind) {
    case "idle":
      return `idle-${s.n}`;
    case "mount":
      return `mount-${s.cycles}`;
    case "images":
      return `images-${s.count}`;
    case "paths":
      return "paths";
    case "pattern":
      return `pattern-${s.name}`;
    case "xform":
      return `xform-${s.mode}`;
    case "dashN":
      return `dash-${s.n}`;
    default:
      return "none";
  }
}

export default function App() {
  const [scenario, setScenario] = useState<Scenario>({ kind: "none" });
  const [phase, setPhase] = useState("start");
  const memory = useMemorySampler(label(scenario), phase);

  useEffect(() => {
    Linking.getInitialURL().then((url) => {
      const s = parseScenario(url);
      if (s) {
        setScenario(s);
      }
    });
    const sub = Linking.addEventListener("url", ({ url }) => {
      const s = parseScenario(url);
      if (s) {
        setScenario(s);
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    setPhase(scenario.kind === "idle" ? "animating" : "start");
  }, [scenario]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>
          react-native-skia memory repro ({Platform.OS}) — {label(scenario)}
        </Text>
        <Text style={styles.text}>{memory}</Text>
        <View style={styles.row}>
          {[1, 3, 5].map((n) => (
            <Button key={n} title={`${n} canvas`} onPress={() => setScenario({ kind: "idle", n })} />
          ))}
          <Button
            title="mount x200"
            onPress={() => setScenario({ kind: "mount", cycles: 200, periodMs: 1000 })}
          />
          <Button
            title="images x600"
            onPress={() => setScenario({ kind: "images", count: 600, periodMs: 50, idleSec: 60 })}
          />
          {PATTERNS.map((name) => (
            <Button key={name} title={name} onPress={() => setScenario({ kind: "pattern", name })} />
          ))}
 {XFORMS.map((mode) => (
            <Button key={mode} title={`xform ${mode}`} onPress={() => setScenario({ kind: "xform", mode })} />
          ))}
          <Button title="large path" onPress={() => setScenario({ kind: "paths" })} />
          <Button title="none" onPress={() => setScenario({ kind: "none" })} />
        </View>
      </View>
      <View style={styles.fill} key={label(scenario)}>
        {scenario.kind === "idle" && <IdleScenario n={scenario.n} />}
        {scenario.kind === "mount" && (
          <MountScenario cycles={scenario.cycles} periodMs={scenario.periodMs} onPhase={setPhase} />
        )}
        {scenario.kind === "paths" && <PathsScenario />}
        {scenario.kind === "pattern" && <PatternScenario name={scenario.name} />}
        {scenario.kind === "xform" && <XformScenario mode={scenario.mode} />}
        {scenario.kind === "dashN" && (
          <View style={styles.fill}>
            {Array.from({ length: scenario.n }, (_, i) => (
              <PatternScenario key={i} name="dash" />
            ))}
          </View>
        )}
        {scenario.kind === "images" && (
          <ImagesScenario
            count={scenario.count}
            periodMs={scenario.periodMs}
            idleSec={scenario.idleSec}
            onPhase={setPhase}
          />
        )}
      </View>
    </View>
  );
}

function Button({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable style={styles.button} onPress={onPress}>
      <Text style={styles.text}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#111", paddingTop: 60 },
  header: { padding: 12, gap: 8 },
  title: { color: "#fff", fontWeight: "600" },
  text: { color: "#ddd", padding: 4 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { backgroundColor: "#333", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6 },
  fill: { flex: 1 },
  pad: { padding: 24 },
});
