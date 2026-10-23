// Icons and per-scene diagram builders. Runs after the markup is parsed, before anim.js builds animations.
const ICONS = {
  star: '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/>',
  candles: '<path d="M3 3v18h18"/><path d="M8 6v3M8 15v2"/><rect x="6" y="9" width="4" height="6" rx="1"/><path d="M16 4v2M16 13v3"/><rect x="14" y="6" width="4" height="7" rx="1"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M16 15h2"/><path d="M6 6l9-3 2 3"/>',
  check: '<circle cx="12" cy="12" r="9.5"/><path d="m8 12 3 3 5-6"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8"/>',
  clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3 2"/>',
  up: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  down: '<path d="M3 7l6 6 4-4 8 8"/><path d="M15 17h6v-6"/>',
  bars: '<path d="M4 20V12M10 20V8M16 20V4M22 20H2"/>',
  pie: '<path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  target: '<circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="1.5"/>',
  hourglass: '<path d="M5 22h14M5 2h14"/><path d="M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22"/><path d="M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  play: '<circle cx="12" cy="12" r="9.5"/><path d="M10 8.5v7l6-3.5z"/>',
  terminal: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3M12 15h6"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2"/><path d="M18 8v4a6 6 0 0 1-12 0V8z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
};
for (const el of document.querySelectorAll("i[data-icon]")) {
  const span = document.createElement("span");
  span.style.display = "contents";
  span.innerHTML = `<svg class="i" viewBox="0 0 24 24">${ICONS[el.dataset.icon] || ""}</svg>`;
  el.replaceWith(span.firstChild);
}

const NS = "http://www.w3.org/2000/svg";
function S(parent, tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  parent.appendChild(el);
  return el;
}
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ACC = "#f5b942", LOSS = "#e0675d", MUTED = "#8d9ab0", DIM = "#3a4862", UPC = "#c9d3e3";
const rtl = { direction: "rtl" };

window.SETUP = {
  // Breakout: range under a 96h ceiling, a high-volume breakout candle, entry, initial and trailing stop.
  s03(root, { at }) {
    const svg = root.querySelector("#bo");
    const r = rng(11);
    const lo = 92, hi = 140, Y = (p) => 470 - ((p - lo) / (hi - lo)) * 440;
    const N = 58, step = 1000 / N, X = (i) => step * i + step / 2;
    const C = [];
    let p = 104;
    for (let i = 0; i < 36; i++) {
      const o = p;
      p = Math.min(108.8, Math.max(99.5, p + (r() - 0.5) * 5 + (104.5 - p) * 0.3));
      C.push({ o, c: p, h: Math.min(110, Math.max(o, p) + r() * 1.6), l: Math.min(o, p) - r() * 1.6, v: 0.5 + r() * 0.5 });
    }
    C.push({ o: 108.4, c: 116, h: 117.2, l: 107.9, v: 1.9 });
    p = 116;
    for (let i = 37; i < N; i++) {
      const o = p;
      const drift = i >= 45 && i <= 48 ? -1.6 : 1.25;
      p = p + drift + (r() - 0.5) * 2.4;
      C.push({ o, c: p, h: Math.max(o, p) + r() * 1.4, l: Math.min(o, p) - r() * 1.4, v: 0.55 + r() * 0.55 });
    }
    // grid
    for (const g of [100, 110, 120, 130]) S(svg, "line", { x1: 0, x2: 1000, y1: Y(g), y2: Y(g), stroke: "#1c2638", "stroke-width": 2 });
    S(svg, "line", { x1: 0, x2: 1000, y1: 495, y2: 495, stroke: "#1c2638", "stroke-width": 2 });
    // ceiling
    const ceil = S(svg, "path", { d: `M0 ${Y(110)} H ${X(36) + 40}`, stroke: ACC, "stroke-width": 3, "stroke-dasharray": "1", fill: "none", "data-a": "draw", "data-t": "@سقف چهار روز", "data-dur": "1.2" });
    ceil.style.opacity = 0.9;
    S(svg, "text", { x: 10, y: Y(110) - 14, class: "lbl-a", "text-anchor": "end", ...rtl, "data-a": "fade", "data-t": "@سقف چهار روز|0.4" }, "سقف ۹۶ ساعته");
    // candles
    const vmax = 2;
    C.forEach((k, i) => {
      const brk = i === 36;
      const g = S(svg, "g", {});
      const col = brk ? ACC : k.c >= k.o ? UPC : DIM;
      S(g, "line", { x1: X(i), x2: X(i), y1: Y(k.h), y2: Y(k.l), stroke: col, "stroke-width": 2 });
      const top = Y(Math.max(k.o, k.c)), h = Math.max(3, Math.abs(Y(k.o) - Y(k.c)));
      S(g, "rect", { x: X(i) - 5.5, y: top, width: 11, height: h, rx: 2, fill: col });
      const vh = (k.v / vmax) * 120;
      const vb = S(svg, "rect", { x: X(i) - 5.5, y: 620 - vh, width: 11, height: vh, rx: 2, fill: brk ? ACC : "#2a3750" });
      let t;
      if (i < 36) t = String(0.5 + i * 0.045);
      else if (brk) t = "@بسته بشه|-0.2";
      else t = `@حدضرر متحرک|${((i - 37) * 0.09).toFixed(2)}`;
      g.setAttribute("data-a", "fade");
      g.setAttribute("data-t", t);
      g.setAttribute("data-dur", "0.4");
      vb.setAttribute("data-a", brk ? "growy" : "fade");
      vb.setAttribute("data-t", t);
      vb.style.transformOrigin = "bottom";
    });
    S(svg, "text", { x: X(36) - 18, y: 560, class: "lbl-a", "text-anchor": "start", ...rtl, "data-a": "fade", "data-t": "@حجم معامله" }, "حجم بالا");
    S(svg, "text", { x: 10, y: 515, class: "lbl", "text-anchor": "end", ...rtl }, "حجم");
    // entry
    const ex = X(36), ey = Y(116);
    S(svg, "circle", { cx: ex, cy: ey, r: 13, fill: ACC, stroke: "#0b0f17", "stroke-width": 4, "data-a": "pop", "data-t": "@خره" });
    S(svg, "text", { x: ex - 24, y: ey - 22, class: "lbl-a", "text-anchor": "start", ...rtl, "data-a": "fade", "data-t": "@خره" }, "خرید");
    // initial stop: 4x volatility below
    const s0 = 106;
    S(svg, "path", { d: `M${ex - 60} ${Y(s0)} H ${X(41)}`, stroke: LOSS, "stroke-width": 3, "stroke-dasharray": "10 8", fill: "none", "data-a": "fade", "data-t": "@حدضرر چهار" });
    const legend = (y, color, dash, text, t) => {
      S(svg, "path", { d: `M10 ${y - 9} H 60`, stroke: color, "stroke-width": dash ? 3 : 4, "stroke-dasharray": dash ? "10 8" : "none", fill: "none", "data-a": "fade", "data-t": t });
      S(svg, "text", { x: 74, y, class: color === LOSS ? "lbl-l" : "lbl-a", "text-anchor": "end", ...rtl, "data-a": "fade", "data-t": t }, text);
    };
    legend(40, LOSS, true, "حدضرر اولیه: ۴ برابر نوسان", "@حدضرر چهار");
    // trailing stop
    let s = s0, maxH = 0, d = "";
    for (let i = 36; i < N; i++) {
      maxH = Math.max(maxH, C[i].h);
      s = Math.max(s, maxH - 9);
      d += i === 36 ? `M${X(i)} ${Y(s)}` : ` H ${X(i)} V ${Y(s)}`;
    }
    d += ` H 1000`;
    S(svg, "path", { d, stroke: ACC, "stroke-width": 4, fill: "none", "data-a": "draw", "data-t": "@حدضرر متحرک", "data-dur": "2.0" });
    legend(84, ACC, false, "حدضرر متحرک", "@حدضرر متحرک");
  },

  // Washout: a sharp one-hour drop, entry at the low, +4% take profit, -6% stop, rebound to target.
  s04(root) {
    const svg = root.querySelector("#wo");
    const r = rng(5);
    const lo = 88.5, hi = 102.5, Y = (p) => 450 - ((p - lo) / (hi - lo)) * 420;
    const N = 60, X = (i) => 20 + (i * 960) / (N - 1);
    const v = [];
    for (let i = 0; i < 22; i++) v.push(100 + (r() - 0.5) * 0.8);
    const dropStart = v[21];
    for (let k = 1; k <= 6; k++) v.push(dropStart - (dropStart - 96.2) * (k / 6) + (k < 6 ? (r() - 0.5) * 0.5 : 0));
    const entry = 96.2, tp = entry * 1.04, sl = entry * 0.94;
    const bottom = [95.8, 96.5, 96.0, 96.9];
    v.push(...bottom);
    const lastIdx = 46;
    for (let i = v.length; i <= lastIdx; i++) {
      const f = (i - 31) / (lastIdx - 31);
      v.push(i === lastIdx ? tp : 96.9 + (tp - 96.9) * f + (r() - 0.5) * 0.7);
    }
    const path = (a, b) => v.slice(a, b + 1).map((p, j) => `${j ? "L" : "M"}${X(a + j).toFixed(1)} ${Y(p).toFixed(1)}`).join(" ");
    for (const g of [90, 94, 98, 102]) S(svg, "line", { x1: 0, x2: 1000, y1: Y(g), y2: Y(g), stroke: "#1c2638", "stroke-width": 2 });
    const ei = 27;
    S(svg, "path", { d: path(0, 21), stroke: UPC, "stroke-width": 4, fill: "none", "data-a": "draw", "data-t": "0.4", "data-dur": "1.4" });
    S(svg, "path", { d: path(21, ei), stroke: LOSS, "stroke-width": 5, fill: "none", "data-a": "draw", "data-t": "@سه و نیم درصد|-0.3", "data-dur": "0.9" });
    // one-hour bracket
    const by = Y(95) + 75;
    S(svg, "path", { d: `M${X(21)} ${by - 12} V ${by} H ${X(ei)} V ${by - 12}`, stroke: MUTED, "stroke-width": 2, fill: "none", "data-a": "fade", "data-t": "@سه و نیم درصد|0.4" });
    S(svg, "text", { x: (X(21) + X(ei)) / 2, y: by + 34, class: "lbl", "text-anchor": "middle", ...rtl, "data-a": "fade", "data-t": "@سه و نیم درصد|0.4" }, "۱ ساعت");
    S(svg, "path", { d: path(ei, ei + 4), stroke: UPC, "stroke-width": 4, fill: "none", "data-a": "draw", "data-t": "@ربات", "data-dur": "0.6" });
    // levels
    S(svg, "path", { d: `M${X(ei)} ${Y(tp)} H 980`, stroke: ACC, "stroke-width": 3, "stroke-dasharray": "12 8", fill: "none", "data-a": "fade", "data-t": "@چهار درصد بالاتر" });
    S(svg, "text", { x: 980, y: Y(tp) - 16, class: "lbl-a", "text-anchor": "start", ...rtl, "data-a": "fade", "data-t": "@چهار درصد بالاتر" }, "فروش: ۴٪ بالاتر");
    S(svg, "path", { d: `M${X(ei)} ${Y(sl)} H 980`, stroke: LOSS, "stroke-width": 3, "stroke-dasharray": "12 8", fill: "none", "data-a": "fade", "data-t": "@حدضرر شش" });
    S(svg, "text", { x: 980, y: Y(sl) + 40, class: "lbl-l", "text-anchor": "start", ...rtl, "data-a": "fade", "data-t": "@حدضرر شش" }, "حدضرر: ۶٪ پایین‌تر");
    S(svg, "circle", { cx: X(ei), cy: Y(entry), r: 13, fill: ACC, stroke: "#0b0f17", "stroke-width": 4, "data-a": "pop", "data-t": "@ربات" });
    S(svg, "text", { x: X(ei), y: Y(entry) + 52, class: "lbl-a", "text-anchor": "middle", ...rtl, "data-a": "fade", "data-t": "@ربات" }, "خرید");
    // rebound to target
    S(svg, "path", { d: path(ei + 4, lastIdx), stroke: UPC, "stroke-width": 4, fill: "none", "data-a": "draw", "data-t": "@هشت ساعت|0.6", "data-dur": "1.8" });
    S(svg, "circle", { cx: X(lastIdx), cy: Y(tp), r: 13, fill: ACC, stroke: "#0b0f17", "stroke-width": 4, "data-a": "pop", "data-t": "@هشت ساعت|2.4" });
  },

  // Equity curve of the 180-day backtest.
  s08(root) {
    const svg = root.querySelector("#eq");
    let pts = window.EQUITY?.points;
    if (!pts) {
      pts = [];
      for (let i = 0; i <= 120; i++) {
        const f = i / 120;
        pts.push([f * 180, 5e6 + 2.07e6 * (f * f * 0.3 + f * 0.7) + Math.sin(i * 0.9) * 6e4 * (1 - f)]);
      }
      pts[pts.length - 1][1] = 7.07e6;
    }
    const days = Math.max(180, pts[pts.length - 1][0]);
    const lo = 4.6e6, hi = 7.4e6;
    const X = (d) => 130 + (d / days) * 840, Y = (v) => 480 - ((v - lo) / (hi - lo)) * 450;
    for (const m of [5, 6, 7]) {
      S(svg, "line", { x1: 130, x2: 970, y1: Y(m * 1e6), y2: Y(m * 1e6), stroke: "#1c2638", "stroke-width": 2 });
      S(svg, "text", { x: 112, y: Y(m * 1e6) + 9, class: "lbl", "text-anchor": "start", ...rtl }, `${fa(m)} میلیون`);
    }
    S(svg, "text", { x: 130, y: 530, class: "lbl", "text-anchor": "middle", ...rtl }, "روز ۰");
    S(svg, "text", { x: 970, y: 530, class: "lbl", "text-anchor": "middle", ...rtl }, "روز ۱۸۰");
    const d = pts.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
    const defs = S(svg, "defs");
    const grad = S(defs, "linearGradient", { id: "eqfill", x1: 0, y1: 0, x2: 0, y2: 1 });
    S(grad, "stop", { offset: "0", "stop-color": ACC, "stop-opacity": "0.28" });
    S(grad, "stop", { offset: "1", "stop-color": ACC, "stop-opacity": "0" });
    S(svg, "path", { d: `${d} L ${X(pts[pts.length - 1][0])} 480 L ${X(0)} 480 Z`, fill: "url(#eqfill)", "data-a": "fade", "data-t": "@۱۸۰ روزه|2.4", "data-dur": "1.0" });
    S(svg, "path", { d, stroke: ACC, "stroke-width": 4, fill: "none", "data-a": "draw", "data-t": "@۱۸۰ روزه|-0.2", "data-dur": "3.0" });
    const [lt, lv] = pts[pts.length - 1];
    S(svg, "circle", { cx: X(0), cy: Y(pts[0][1]), r: 9, fill: UPC, "data-a": "pop", "data-t": "@۱۸۰ روزه|-0.2" });
    S(svg, "text", { x: X(0) + 14, y: Y(pts[0][1]) + 48, class: "lbl", "text-anchor": "end", ...rtl, "data-a": "fade", "data-t": "@۱۸۰ روزه|-0.2" }, "۵ میلیون تومن");
    S(svg, "circle", { cx: X(lt), cy: Y(lv), r: 12, fill: ACC, stroke: "#0b0f17", "stroke-width": 4, "data-a": "pop", "data-t": "@۱۸۰ روزه|2.8" });
    S(svg, "text", { x: X(lt), y: Y(lv) - 28, class: "lbl-a", "text-anchor": "start", ...rtl, style: "font-size:32px", "data-a": "fade", "data-t": "@۱۸۰ روزه|2.8" }, `${fa((lv / 1e6).toFixed(2))} میلیون تومن`);
  },
};
