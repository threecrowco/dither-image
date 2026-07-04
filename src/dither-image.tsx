"use client";

// ============================================================================
// TUTORIAL: <DitherImage /> — a hover-triggered WebGL dither effect
// ============================================================================
//
// This component renders an image into a <canvas> using raw WebGL (no
// three.js/ogl) and crossfades it into an ordered-dither ("halftone") look
// on hover. The shader math lives in ./shader.ts — this file is just the
// plumbing that gets an image onto the GPU and animates a single number
// (`progress`, 0..1) in response to mouse/focus events.
//
// The general shape of *any* raw-WebGL component is:
//   1. Get a WebGL context from a <canvas>.
//   2. Compile + link a vertex + fragment shader into a "program".
//   3. Upload geometry (here: 4 corners of a rectangle) into a buffer.
//   4. Upload an image into a texture.
//   5. Each frame: set uniforms (the shader's "input variables") and draw.
//   6. Clean up all GPU resources when the component unmounts — WebGL
//      contexts are a scarce, unmanaged browser resource, unlike JS objects
//      the garbage collector would otherwise reclaim for you.
//
// ponytail: raw WebGL instead of `ogl`/`three` — the whole surface here is
// one fullscreen quad + one texture + one shader (~100 lines). Reach for
// `ogl` only if this boilerplate (resize/texture/RAF plumbing) grows.
// ============================================================================

import { useEffect, useRef } from "react";
import {
  FRAGMENT_SHADER,
  ORDERED_DITHERERS,
  VERTEX_SHADER,
  type Ditherer,
  type DitherMode,
} from "./shader";

export type DitherImageProps = {
  src: string;
  alt: string;
  /** Dither pattern — one of 18 fixed matrices, or "RANDOM" for per-pixel noise. Default "BAYER_4x4". See README.md for the full list. */
  mode?: DitherMode;
  width: number;
  height: number;
  /** Size (px) of each dithered "block" — bigger = chunkier pattern. */
  granularity?: number;
  /** RGB (0..1 each) tint applied to the "on" dither pixels. */
  color?: [number, number, number];
  /** Crossfade duration in ms. */
  duration?: number;
  className?: string;
  /** When true, the image starts dithered and resolves to sharp on hover/focus (default is sharp-at-rest, dithered-on-hover). */
  invert?: boolean;
};

// ---------------------------------------------------------------------------
// Step 2 (part 1): compile one shader (vertex or fragment) from GLSL source
// text into a GPU-side shader object. This is boilerplate every raw-WebGL
// program needs — GLSL is compiled at runtime, in the browser, on first use.
// ---------------------------------------------------------------------------
function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // If the GLSL has a typo, this is where you'd find out — the browser
    // doesn't type-check shader strings ahead of time.
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}`);
  }
  return shader;
}

export function DitherImage({
  src,
  alt,
  mode = "BAYER_4x4",
  width,
  height,
  granularity = 2,
  color = [1, 1, 1],
  duration = 250,
  className,
  invert = false,
}: DitherImageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Refs, not useState: these values change every animation frame, and we
  // read/write them from a plain requestAnimationFrame loop below — running
  // that through React state would trigger a re-render (and a shader
  // re-setup, since this effect depends on nothing that changes per-frame)
  // 60 times a second for no benefit.
  const targetRef = useRef(invert ? 1 : 0); // where progress is animating *to* (0 or 1)
  const progressRef = useRef(invert ? 1 : 0); // current animated progress, fed to the shader

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // --- Step 1: get the WebGL context ---
    const gl = canvas.getContext("webgl");
    if (!gl) return; // no WebGL support — component silently renders nothing

    // WebGL uploads texture data starting from the source's first row, but
    // a canvas's first row is its *top* (row 0 = top in 2D canvas space),
    // while texture coordinate v=0 samples as the *bottom* of the image once
    // rendered through our vertex shader's uv mapping. Without this flag the
    // image renders upside down. This affects every texImage2D call below,
    // including the dither-matrix texture, but that pattern tiles
    // infinitely and looks identical either way, so a single global flag is
    // enough — no need to flip each upload individually.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    // Render at device pixel ratio (capped at 2x) so the dither pattern
    // stays crisp on high-DPI screens, without the cost of going higher.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);

    // --- Step 2 (part 2): compile both shaders and link them into a program ---
    // A "program" is the GPU-side pairing of a vertex + fragment shader;
    // gl.useProgram makes it the active one for subsequent draw calls.
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("Program link error:", gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);

    // --- Step 3: upload the quad geometry ---
    // Two triangles sharing a diagonal, expressed as a TRIANGLE_STRIP of 4
    // points in clip space (-1..1): bottom-left, bottom-right, top-left,
    // top-right. This is the full-canvas rectangle the fragment shader
    // paints across — see the vertex shader in shader.ts for how these
    // become `vUv`.
    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const aPosition = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    // "Uniforms" are the shader's input variables — set once (or once per
    // frame) from JS, and visible to every pixel the shader touches. We
    // look up their GPU-assigned locations once here, then write values to
    // them below and in render().
    const uProgress = gl.getUniformLocation(program, "uProgress");
    const uGranularity = gl.getUniformLocation(program, "uGranularity");
    const uColor = gl.getUniformLocation(program, "uColor");
    const uResolution = gl.getUniformLocation(program, "uResolution");
    // With two samplers now active (image + dither matrix), each must be
    // explicitly assigned to a texture unit — previously this worked
    // implicitly because there was only one sampler, defaulting to unit 0.
    const uTextureLoc = gl.getUniformLocation(program, "uTexture");
    const uMatrixTexture = gl.getUniformLocation(program, "uMatrixTexture");
    const uMatrixTextureSize = gl.getUniformLocation(program, "uMatrixTextureSize");
    const uRandomLoc = gl.getUniformLocation(program, "uRandom");
    gl.uniform1f(uGranularity, granularity);
    gl.uniform3f(uColor, color[0], color[1], color[2]);
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1i(uTextureLoc, 0); // image sampler reads texture unit 0
    gl.uniform1i(uMatrixTexture, 1); // matrix sampler reads texture unit 1

    // --- Step 4 (part 1): create an (empty, for now) texture ---
    // CLAMP_TO_EDGE + LINEAR filtering, no mipmaps: the simplest settings
    // that work correctly for a non-power-of-two image, which mipmapping
    // doesn't support in WebGL1 without extra steps we don't need here.
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // --- Step 4 (part 1b): build and upload the dither-matrix texture ---
    // Ported from spargo's CanvasTexture approach: render the chosen
    // Ditherer's matrix into a tiny grayscale image (one pixel per matrix
    // cell) via a scratch 2D canvas, then upload it as a texture — NEAREST
    // filtering is required (not LINEAR) so every texel maps to exactly one
    // matrix cell; interpolating between cells would blur the thresholds.
    const matrixTexture = gl.createTexture();

    function buildMatrixTexture(ditherer: Ditherer) {
      if (!gl) return;
      const buffer = document.createElement("canvas");
      buffer.width = ditherer.x;
      buffer.height = ditherer.y;
      const context = buffer.getContext("2d");
      if (!context) return;
      const image = context.createImageData(ditherer.x, ditherer.y);
      const buffer32 = new Uint32Array(image.data.buffer);
      for (let i = 0; i < buffer32.length; i++) {
        const value = (ditherer.matrix[i] ?? 0) / ditherer.max;
        const channel = Math.floor(value * 255);
        // Little-endian Uint32 packs bytes as (alpha << 24 | blue << 16 |
        // green << 8 | red) in memory order — grayscale, alpha fully opaque.
        buffer32[i] = (255 << 24) | (channel << 16) | (channel << 8) | channel;
      }
      context.putImageData(image, 0, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, matrixTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
      gl.uniform2f(uMatrixTextureSize, ditherer.x, ditherer.y);
      // Restore the default active unit so the async image.onload handler
      // below (which binds `texture` without calling activeTexture) affects
      // unit 0, not unit 1.
      gl.activeTexture(gl.TEXTURE0);
    }

    if (mode === "RANDOM") {
      gl.uniform1i(uRandomLoc, 1);
    } else {
      gl.uniform1i(uRandomLoc, 0);
      buildMatrixTexture(ORDERED_DITHERERS[mode]);
    }

    // --- Step 5: the actual per-frame draw call ---
    // Pushes the current animated progress to the GPU, then redraws the
    // quad. Called both from the image's onload (first paint) and from the
    // animation loop below (every frame while hovering in/out).
    function render() {
      if (!gl) return;
      gl.uniform1f(uProgress, progressRef.current);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // --- Step 4 (part 2): load the image and upload it into the texture ---
    const image = new Image();
    let loaded = false;
    image.onload = () => {
      // Rasterize through a 2D canvas before uploading: texImage2D rejects
      // some image sources directly (e.g. SVGs without intrinsic size), but
      // any canvas is always a valid texture source.
      const raster = document.createElement("canvas");
      raster.width = canvas.width;
      raster.height = canvas.height;
      const ctx2d = raster.getContext("2d");
      if (!ctx2d) return;

      // "Cover" fit: crop the source to the canvas's aspect ratio (centered)
      // instead of stretching it to fill — a plain drawImage(image, 0, 0, w,
      // h) distorts any source whose aspect ratio doesn't match the target
      // box, squishing it. This mirrors CSS `object-fit: cover`.
      const targetAspect = raster.width / raster.height;
      const sourceAspect = image.naturalWidth / image.naturalHeight;
      let sx = 0;
      let sy = 0;
      let sWidth = image.naturalWidth;
      let sHeight = image.naturalHeight;
      if (sourceAspect > targetAspect) {
        // source is wider than the target box — crop its left/right edges
        sWidth = sHeight * targetAspect;
        sx = (image.naturalWidth - sWidth) / 2;
      } else {
        // source is taller than the target box — crop its top/bottom edges
        sHeight = sWidth / targetAspect;
        sy = (image.naturalHeight - sHeight) / 2;
      }
      ctx2d.drawImage(image, sx, sy, sWidth, sHeight, 0, 0, raster.width, raster.height);

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, raster);
      loaded = true;
      render(); // first paint, at whatever progress we're currently at
    };
    image.src = src;

    // --- Hover animation: a tiny manual tween, no animation library ---
    // `progress` chases `target` (0 or 1) every frame using simple
    // exponential-ish easing (`diff * step`, where step is time-based) —
    // this is the entire "animation engine" the crossfade needs.
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let rafId = 0;
    let lastTime = 0;

    function tick(time: number) {
      const dt = lastTime ? time - lastTime : 0;
      lastTime = time;
      const diff = targetRef.current - progressRef.current;
      if (Math.abs(diff) < 0.001) {
        // Close enough — snap to the target and stop the RAF loop instead
        // of running it forever at rest (no idle GPU/CPU work).
        progressRef.current = targetRef.current;
        render();
        rafId = 0;
        return;
      }
      const step = duration > 0 ? dt / duration : 1;
      progressRef.current += diff * Math.min(step, 1);
      render();
      rafId = requestAnimationFrame(tick);
    }

    function setTarget(value: number) {
      targetRef.current = value;
      if (!loaded) return; // nothing to show yet — the onload render() will catch up
      if (reduceMotion) {
        // Respect the OS-level "reduce motion" setting: snap instantly
        // instead of animating.
        progressRef.current = value;
        render();
        return;
      }
      if (!rafId) {
        lastTime = 0;
        rafId = requestAnimationFrame(tick);
      }
    }

    // Mouse hover *and* keyboard focus trigger the same effect — this is
    // what makes the interaction reachable without a mouse (see the
    // tabIndex={0} + role="img" on the <canvas> below).
    const enter = () => setTarget(invert ? 0 : 1);
    const leave = () => setTarget(invert ? 1 : 0);
    canvas.addEventListener("mouseenter", enter);
    canvas.addEventListener("mouseleave", leave);
    canvas.addEventListener("focus", enter);
    canvas.addEventListener("blur", leave);

    // --- Step 6: cleanup ---
    // Effect cleanup runs on unmount (and before every re-run of this
    // effect, e.g. if `src` changes) — including, in dev, a synchronous
    // extra mount -> cleanup -> remount from React Strict Mode, reusing the
    // *same* canvas element. WebGL resources are refcounted by the browser,
    // not the JS garbage collector, so anything gl.create*'d here must be
    // explicitly gl.delete*'d, or it leaks GPU memory for the life of the
    // page. We deliberately do NOT call the WEBGL_lose_context extension:
    // it kills the context object itself, and canvas.getContext("webgl")
    // on the immediate Strict Mode remount would then hand back that same
    // dead context — every subsequent shader/texture call fails silently
    // ("Shader compile error: null"). Deleting the individual objects below
    // already frees the GPU memory without invalidating the context.
    return () => {
      canvas.removeEventListener("mouseenter", enter);
      canvas.removeEventListener("mouseleave", leave);
      canvas.removeEventListener("focus", enter);
      canvas.removeEventListener("blur", leave);
      if (rafId) cancelAnimationFrame(rafId);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.deleteBuffer(quadBuffer);
      gl.deleteTexture(texture);
      gl.deleteTexture(matrixTexture);
    };
  }, [src, width, height, mode, granularity, color, duration, invert]);

  // We render a <canvas>, not an <img>/<Image>, because we need direct
  // pixel control for the shader. role="img" + aria-label stand in for the
  // alt text a screen reader would otherwise get from a real <img>.
  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={alt}
      tabIndex={0}
      className={className}
      style={{ width, height }}
    />
  );
}
