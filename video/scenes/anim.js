// Deterministic, time-seekable animation engine.
// URL params: scene=s01..s11, lead (s before speech), audio (speech length), d (scene length).
// Elements opt in with data-a="<preset>" and data-t="<time>"; data-kids="<preset>" animates each child
// with data-stagger seconds between them. Times: "1.2" (seconds), "40%" (of scene), or "@phrase|+0.3"
// (when the phrase is spoken, estimated from its character position in the narration).
(() => {
  const q = new URLSearchParams(location.search);
  const SCENE = q.get("scene") || "s01";
  const LEAD = Number(q.get("lead") ?? 0.3);
  const AUDIO = Number(q.get("audio") ?? 20);
  const D = Number(q.get("d") ?? LEAD + AUDIO + 0.7);
  const FADE = 0.35;
  const errors = [];
  window.__errors = errors;

  const FA = "۰۱۲۳۴۵۶۷۸۹";
  window.fa = (x) => String(x).replace(/[0-9]/g, (d) => FA[d]).replace(/\./g, "٫");

  const narration = (window.NARRATION || {})[SCENE] || "";
  function at(spec) {
    if (spec == null || spec === "") return 0;
    spec = String(spec).trim();
    if (spec.startsWith("@")) {
      let [phrase, off] = spec.slice(1).split("|");
      const i = narration.indexOf(phrase);
      if (i < 0) {
        errors.push(`phrase not found in ${SCENE}: ${phrase}`);
        return 0;
      }
      return Math.max(0, LEAD + (AUDIO * i) / narration.length - 0.25 + Number(off || 0));
    }
    if (spec.endsWith("%")) return (parseFloat(spec) / 100) * D;
    return parseFloat(spec);
  }

  const P = {
    up: [{ opacity: 0, transform: "translateY(40px)" }, { opacity: 1, transform: "translateY(0)" }],
    down: [{ opacity: 0, transform: "translateY(-30px)" }, { opacity: 1, transform: "translateY(0)" }],
    fade: [{ opacity: 0 }, { opacity: 1 }],
    pop: [{ opacity: 0, transform: "scale(0.86)" }, { opacity: 1, transform: "scale(1)" }],
    right: [{ opacity: 0, transform: "translateX(70px)" }, { opacity: 1, transform: "translateX(0)" }],
    left: [{ opacity: 0, transform: "translateX(-70px)" }, { opacity: 1, transform: "translateX(0)" }],
    draw: [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
    growx: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
    growy: [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }],
    lit: [
      { borderColor: "var(--line)", backgroundColor: "var(--surface)" },
      { borderColor: "var(--accent)", backgroundColor: "rgba(245,185,66,0.10)" },
    ],
    on: [
      { borderColor: "var(--line)", color: "var(--text)", backgroundColor: "var(--surface)" },
      { borderColor: "var(--accent)", color: "var(--accent)", backgroundColor: "rgba(245,185,66,0.14)" },
    ],
  };
  const EASE = "cubic-bezier(.2,.7,.2,1)";

  function add(el, preset, t, dur) {
    const kf = P[preset];
    if (!kf) return errors.push(`unknown preset ${preset}`);
    if (preset === "draw") {
      el.setAttribute("pathLength", "1");
      el.style.strokeDasharray = "1";
    }
    const a = el.animate(kf, {
      delay: t * 1000,
      duration: dur * 1000,
      fill: "both",
      easing: preset === "draw" ? "cubic-bezier(.4,0,.2,1)" : EASE,
    });
    a.pause();
  }

  function build(root) {
    for (const el of root.querySelectorAll("[data-a]")) {
      const dur = Number(el.dataset.dur ?? (el.dataset.a === "draw" ? 1.6 : 0.7));
      add(el, el.dataset.a, at(el.dataset.t), dur);
    }
    for (const el of root.querySelectorAll("[data-b]")) {
      add(el, el.dataset.b, at(el.dataset.tb), Number(el.dataset.durb ?? 0.6));
    }
    for (const el of root.querySelectorAll("[data-kids]")) {
      const t0 = at(el.dataset.t);
      const st = Number(el.dataset.stagger ?? 0.12);
      const dur = Number(el.dataset.dur ?? 0.7);
      [...el.children].forEach((c, i) => add(c, el.dataset.kids, t0 + i * st, dur));
    }
  }

  window.seek = (t) => {
    for (const a of document.getAnimations()) a.currentTime = t * 1000;
  };

  window.addEventListener("DOMContentLoaded", async () => {
    const root = document.getElementById(SCENE);
    if (!root) errors.push(`no scene ${SCENE}`);
    root.classList.add("active");
    const n = Number(SCENE.slice(1));
    const head = root.querySelector(".brand .count");
    if (head) head.textContent = `${fa(n)} / ${fa(11)}`;
    try {
      (window.SETUP?.[SCENE] || (() => {}))(root, { at, D });
    } catch (e) {
      errors.push(String(e && e.stack || e));
    }
    const bar = document.createElement("div");
    bar.className = "progress";
    root.appendChild(bar);
    bar.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: D * 1000, fill: "both" }).pause();
    const veil = document.getElementById("veil");
    veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE * 1000, fill: "forwards" }).pause();
    veil.animate([{ opacity: 0 }, { opacity: 1 }], { delay: (D - FADE) * 1000, duration: FADE * 1000, fill: "forwards", composite: "replace" }).pause();
    build(root);
    await document.fonts.ready;
    await Promise.all([...document.fonts].map((f) => f.load().catch(() => {})));
    window.seek(Number(q.get("t") ?? 0));
    window.__ready = true;
  });
})();
