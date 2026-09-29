import React, { useEffect, useRef } from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { getCoverUrl } from '../../api/tracks';
import { fetchAuthorizedBlobUrl } from '../../api/media';
import styles from './AmbientBackground.module.css';

interface WaveNode {
  x0: number;
  y0: number;
  ax: number;
  ay: number;
  wx: number;
  wy: number;
  phase: number;
  r0: number;
  dr: number;
  wr: number;
  isAccent?: boolean;
}

const WAVE_NODES: WaveNode[] = [
  // Deep ambient waves (rolling body & shadow currents)
  { x0: 0.25, y0: 0.30, ax: 0.22, ay: 0.16, wx: 0.70, wy: 0.55, phase: 0.0, r0: 0.65, dr: 0.14, wr: 0.75, isAccent: false },
  { x0: 0.75, y0: 0.65, ax: 0.20, ay: 0.22, wx: 0.60, wy: 0.75, phase: 1.6, r0: 0.60, dr: 0.12, wr: 0.65, isAccent: false },
  { x0: 0.45, y0: 0.80, ax: 0.24, ay: 0.15, wx: 0.80, wy: 0.60, phase: 3.2, r0: 0.58, dr: 0.15, wr: 0.75, isAccent: false },
  { x0: 0.15, y0: 0.70, ax: 0.18, ay: 0.18, wx: 0.65, wy: 0.50, phase: 2.4, r0: 0.55, dr: 0.13, wr: 0.85, isAccent: false },
  // Accent & highlight waves (subtle luminescence)
  { x0: 0.80, y0: 0.25, ax: 0.18, ay: 0.20, wx: 0.50, wy: 0.70, phase: 4.8, r0: 0.50, dr: 0.12, wr: 0.95, isAccent: true },
  { x0: 0.50, y0: 0.35, ax: 0.20, ay: 0.16, wx: 0.55, wy: 0.65, phase: 5.5, r0: 0.48, dr: 0.10, wr: 0.80, isAccent: true },
];

interface ExtractedTheme {
  bgDark: string;
  colors: string[];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hexToHsl(hex: string): [number, number, number] {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map((x) => x + x).join('');
  const num = parseInt(c, 16);
  const r = (num >> 16) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  return rgbToHsl(r, g, b);
}

/**
 * Samples the ENTIRE tonal spectrum of the cover image:
 * dark shadows, midtones, body colors, and subtle accent highlights.
 * Never artificially boosts saturation or forces high lightness.
 */
function extractArtTheme(img: HTMLImageElement): ExtractedTheme | null {
  try {
    const canvas = document.createElement('canvas');
    const size = 32;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;

    const pixels: { r: number; g: number; b: number; h: number; s: number; l: number }[] = [];

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const [h, s, l] = rgbToHsl(r, g, b);
      pixels.push({ r, g, b, h, s, l });
    }

    if (pixels.length === 0) return null;

    // Sort by lightness to capture all tonal bands
    pixels.sort((a, b) => a.l - b.l);

    // 1. Deepest shadow / background tone (average of the darkest 20% pixels)
    const darkSlice = pixels.slice(0, Math.max(1, Math.floor(pixels.length * 0.2)));
    let darkR = 0;
    let darkG = 0;
    let darkB = 0;
    darkSlice.forEach((p) => {
      darkR += p.r;
      darkG += p.g;
      darkB += p.b;
    });
    darkR = Math.min(22, Math.round(darkR / darkSlice.length));
    darkG = Math.min(22, Math.round(darkG / darkSlice.length));
    darkB = Math.min(26, Math.round(darkB / darkSlice.length));
    const bgDark = `rgb(${darkR}, ${darkG}, ${darkB})`;

    // 2. Sample across the spectrum: dark-shadow, lower-mid, midtone, upper-mid, and accent
    // Node 0: Deep dark body wave
    const p0 = pixels[Math.floor(pixels.length * 0.15)];
    const c0 = `hsla(${p0.h}, ${Math.min(60, p0.s)}%, ${Math.min(18, Math.max(8, p0.l))}%, 0.85)`;

    // Node 1: Lower midtone wave
    const p1 = pixels[Math.floor(pixels.length * 0.35)];
    const c1 = `hsla(${p1.h}, ${p1.s}%, ${Math.min(26, Math.max(12, p1.l))}%, 0.75)`;

    // Node 2: True midtone wave
    const p2 = pixels[Math.floor(pixels.length * 0.55)];
    const c2 = `hsla(${p2.h}, ${p2.s}%, ${Math.min(32, Math.max(16, p2.l))}%, 0.70)`;

    // Node 3: Upper midtone wave
    const p3 = pixels[Math.floor(pixels.length * 0.75)];
    const c3 = `hsla(${p3.h}, ${p3.s}%, ${Math.min(36, Math.max(20, p3.l))}%, 0.65)`;

    // Find the most distinctive / saturated accent color from the artwork (e.g. logo, highlight)
    let bestAccent = pixels[Math.floor(pixels.length * 0.85)];
    let highestScore = -1;
    for (const p of pixels) {
      // Score favors saturated colors that aren't pure white or pure black
      if (p.l > 15 && p.l < 85) {
        const score = p.s * (1 - Math.abs(p.l - 45) / 50);
        if (score > highestScore) {
          highestScore = score;
          bestAccent = p;
        }
      }
    }

    // Node 4: Primary accent wave (restrained lightness so it never blows out)
    const c4 = `hsla(${bestAccent.h}, ${Math.min(85, bestAccent.s)}%, ${Math.min(38, Math.max(24, bestAccent.l))}%, 0.55)`;

    // Node 5: Secondary harmonic accent wave
    const p5 = pixels[Math.floor(pixels.length * 0.68)];
    const c5 = `hsla(${p5.h}, ${Math.min(75, p5.s)}%, ${Math.min(32, Math.max(18, p5.l))}%, 0.50)`;

    return {
      bgDark,
      colors: [c0, c1, c2, c3, c4, c5],
    };
  } catch {
    return null;
  }
}

function generateFallbackTheme(baseHex?: string, fallbackSeed: string = 'puuk'): ExtractedTheme {
  let [h, s] = [230, 45];
  if (baseHex && baseHex.startsWith('#') && baseHex.length >= 4) {
    [h, s] = hexToHsl(baseHex);
  } else {
    let hash = 0;
    for (let i = 0; i < fallbackSeed.length; i++) {
      hash = fallbackSeed.charCodeAt(i) + ((hash << 5) - hash);
    }
    h = Math.abs(hash % 360);
  }

  const sat = Math.min(55, Math.max(25, s));

  return {
    bgDark: '#000000',
    colors: [
      `hsla(${h}, ${sat}%, 12%, 0.85)`,
      `hsla(${(h + 20) % 360}, ${Math.max(20, sat - 5)}%, 16%, 0.75)`,
      `hsla(${(h - 25 + 360) % 360}, ${sat}%, 22%, 0.70)`,
      `hsla(${(h + 45) % 360}, ${sat}%, 26%, 0.65)`,
      `hsla(${(h + 15) % 360}, ${Math.min(65, sat + 10)}%, 32%, 0.55)`,
      `hsla(${(h - 15 + 360) % 360}, ${sat}%, 20%, 0.50)`,
    ],
  };
}

export const AmbientBackground: React.FC = () => {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const accentColor = usePlayerStore((state) => state.accentColor);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const coverImgRef = useRef<HTMLImageElement | null>(null);
  const extractedThemeRef = useRef<ExtractedTheme | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const timeRef = useRef<number>(0);

  const isPlaying = status === 'playing';
  const coverUrl = currentTrack ? getCoverUrl(currentTrack) : '';

  useEffect(() => {
    extractedThemeRef.current = null;
    if (!coverUrl) {
      coverImgRef.current = null;
      return;
    }

    let isCancelled = false;

    async function loadCover() {
      try {
        const objectUrl = await fetchAuthorizedBlobUrl(coverUrl);
        if (isCancelled) return;

        const img = new Image();
        img.src = objectUrl;
        img.onload = () => {
          if (isCancelled) return;
          coverImgRef.current = img;
          const theme = extractArtTheme(img);
          if (theme) {
            extractedThemeRef.current = theme;
          }
        };
        img.onerror = () => {
          if (isCancelled) return;
          coverImgRef.current = null;
        };
      } catch {
        coverImgRef.current = null;
      }
    }

    loadCover();

    return () => {
      isCancelled = true;
    };
  }, [coverUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = 480;
    const height = 270;
    canvas.width = width;
    canvas.height = height;

    const fallbackTheme = generateFallbackTheme(
      currentTrack?.cover_color || accentColor,
      currentTrack?.title || 'puuk'
    );

    const render = () => {
      timeRef.current += isPlaying ? 0.007 : 0.0025;
      const time = timeRef.current;

      const activeTheme = extractedThemeRef.current || fallbackTheme;

      // 1. Base deep background derived from the actual artwork shadow tone
      ctx.fillStyle = activeTheme.bgDark;
      ctx.fillRect(0, 0, width, height);

      // 2. Organic breathing album artwork underlay
      if (coverImgRef.current && coverImgRef.current.complete) {
        ctx.save();
        ctx.globalAlpha = 0.34;
        const breathScale = 1.06 + 0.03 * Math.sin(time * 0.4);
        const dw = width * breathScale;
        const dh = height * breathScale;
        const dx = (width - dw) / 2;
        const dy = (height - dh) / 2;
        ctx.drawImage(coverImgRef.current, dx, dy, dw, dh);
        ctx.restore();
      }

      // 3. Render body & shadow wave nodes (source-over for natural, deep, liquid depth)
      ctx.globalCompositeOperation = 'source-over';

      WAVE_NODES.forEach((node, i) => {
        if (node.isAccent) return;

        const color = activeTheme.colors[i % activeTheme.colors.length];
        const x =
          (node.x0 +
            node.ax * Math.sin(time * node.wx + node.phase) +
            0.06 * Math.cos(time * 1.3 * node.wx)) *
          width;
        const y =
          (node.y0 +
            node.ay * Math.cos(time * node.wy + node.phase) +
            0.06 * Math.sin(time * 1.1 * node.wy)) *
          height;
        const r =
          (node.r0 + node.dr * Math.sin(time * node.wr + node.phase)) *
          Math.max(width, height);

        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, color);
        grad.addColorStop(0.5, color.replace(/[\d.]+\)$/, '0.35)'));
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      });

      // 4. Render subtle accent wave currents (screen blend with restrained lightness)
      ctx.globalCompositeOperation = 'screen';

      WAVE_NODES.forEach((node, i) => {
        if (!node.isAccent) return;

        const color = activeTheme.colors[i % activeTheme.colors.length];
        const x =
          (node.x0 +
            node.ax * Math.sin(time * node.wx + node.phase) +
            0.06 * Math.cos(time * 1.4 * node.wx)) *
          width;
        const y =
          (node.y0 +
            node.ay * Math.cos(time * node.wy + node.phase) +
            0.06 * Math.sin(time * 1.2 * node.wy)) *
          height;
        const r =
          (node.r0 + node.dr * Math.sin(time * node.wr + node.phase)) *
          Math.max(width, height);

        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, color);
        grad.addColorStop(0.5, color.replace(/[\d.]+\)$/, '0.22)'));
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.globalCompositeOperation = 'source-over';

      animFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [currentTrack?.cover_color, currentTrack?.title, accentColor, isPlaying]);

  return (
    <div className={styles.ambientContainer} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.fluidWaveCanvas} />
      <div className={styles.vignetteOverlay} />
    </div>
  );
};


