// Mana debut video: everything on screen is a function of window.seek(t).
// DOM layers (cards, sparkles, subtitles) are pure functions of t. The Live2D
// model's hair/cloth physics are stateful, so render_debut.py seeks in order.
(async function () {
  "use strict";
  const data = await (await fetch("data.json")).json();
  const S = 2.4; // logical 800x450 stage -> 1920x1080 px

  // ---------- timing helpers ----------
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const smooth = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
  const easeInOut = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  // closed-form damped-spring step response, 0 -> 1 (with a little overshoot)
  function spring(dt, freq = 3.0, zeta = 0.55) {
    if (dt <= 0) return 0;
    const w0 = 2 * Math.PI * freq, wd = w0 * Math.sqrt(1 - zeta * zeta), env = Math.exp(-zeta * w0 * dt);
    return 1 - env * (Math.cos(wd * dt) + (zeta * w0 / wd) * Math.sin(wd * dt));
  }

  const screenOf = Object.fromEntries(data.screens.map((s) => [s.key, s]));
  const last = data.screens[data.screens.length - 1].key;
  const layers = [...document.querySelectorAll(".layer")].map((el) => {
    const s = screenOf[el.dataset.key];
    return {
      el, key: el.dataset.key, start: s.start, end: s.end,
      pops: [...el.querySelectorAll("[data-pop]")].map((e) => ({ e, d: +e.dataset.pop })),
      fades: [...el.querySelectorAll("[data-fade]")].map((e) => ({ e, d: +e.dataset.fade })),
      tw: [...el.querySelectorAll("[data-tw]")].map((e) => ({ e, ph: +e.dataset.tw })),
    };
  });
  const lineOf = Object.fromEntries(data.lines.map((l) => [l.key, l]));
  const $ = (id) => document.getElementById(id);
  const sub = $("sub");

  function drawDom(t) {
    for (const L of layers) {
      const fadeIn = L.start === 0 ? 1 : smooth((t - L.start + 0.1) / 0.2);
      const fadeOut = L.key === last ? 1 : 1 - smooth((t - L.end + 0.1) / 0.2);
      const vis = fadeIn * fadeOut;
      L.el.style.opacity = vis;
      if (vis <= 0) continue;
      const rt = t - L.start;
      for (const { e, d } of L.pops) {
        const p = spring(rt - d);
        e.style.opacity = clamp(p * 1.6);
        e.style.scale = 0.82 + 0.18 * p;
      }
      for (const { e, d } of L.fades) e.style.opacity = smooth((rt - d) / 0.3);
      for (const { e, ph } of L.tw) e.setAttribute("opacity", (0.14 + 0.3 * (0.5 + 0.5 * Math.sin(t * 2.4 + ph))).toFixed(3));
    }

    // reveal: the crystal charges, flashes, and the rays spread out behind her
    const r = t - screenOf.reveal.start;
    const charge = smooth(r / 0.8);
    $("revealCrystal").style.scale = 1 + 0.35 * charge + 0.04 * Math.sin(r * 40) * charge;
    $("revealCrystal").style.opacity = 1 - smooth((r - 0.78) / 0.08);
    $("flash").style.opacity = smooth((r - 0.62) / 0.16) * (1 - smooth((r - 0.85) / 0.6));
    $("rays").style.opacity = smooth((r - 0.8) / 0.5);
    $("rays").style.transformOrigin = "400px 215px";
    $("rays").style.rotate = `${r * 5}deg`;
    $("glow").style.opacity = 0.4 + 0.6 * charge;
    $("glow").style.scale = 0.7 + 0.5 * charge;
    $("glow").style.transformOrigin = "400px 215px";

    // code: the Approve button gets pressed as she finishes her line
    const press = spring(t - (lineOf["06-code"].end + 0.1), 2.5, 0.7);
    $("approve").style.boxShadow = `0 0 0 ${6 * press}px rgba(198,170,224,${0.35 * press})`;

    // tease: the "Teasing" tile lights up on the word
    const tease = spring(t - (lineOf["10-tease"].start + 0.9), 2.5, 0.6);
    $("teaseTile").style.outline = `2px solid rgba(198,170,224,${clamp(tease)})`;
    $("teaseTile").style.outlineOffset = "3px";

    // subtitles
    const ln = data.lines.find((l) => t >= l.start - 0.05 && t <= l.end + 0.4);
    if (ln) {
      if (sub.textContent !== ln.text) sub.textContent = ln.text;
      // centred under the cards while she presents on the left, else mid-frame
      const scr = data.screens.find((s) => t >= s.start && t < s.end) || data.screens[data.screens.length - 1];
      sub.style.left = (SCREEN_SPOT[scr.key] ? 400 : 535) + "px";
      sub.style.opacity = smooth((t - ln.start + 0.05) / 0.12) * (1 - smooth((t - ln.end - 0.2) / 0.2));
    } else sub.style.opacity = 0;
  }

  // ---------- Mana (Live2D) ----------
  const app = new PIXI.Application({
    view: $("avatar"), width: 1920, height: 1080, backgroundAlpha: 0, antialias: true,
    preserveDrawingBuffer: true, autoStart: false, resolution: 1,
  });
  app.ticker.stop();
  const model = await PIXI.live2d.Live2DModel.from(
    "/windows-launcher/avatar/model/hiyori_pro/runtime/hiyori_pro_t11.model3.json",
    { autoInteract: false, autoUpdate: false });
  app.stage.addChild(model);
  const im = model.internalModel;
  const core = im.coreModel;
  im.motionManager.groups.idle = undefined; // no auto-replayed idle motion: every pose is ours
  im.motionManager.stopAllMotions();
  im.eyeBlink = undefined; // blinks are scheduled below, deterministically
  model.elapsedTime = 0;

  // the storyboard's poses, but with eyes kept wide open except where closing them is the point
  // (reveal, bow, dozing, wink): this model's eye-smile params squint her eyes
  const NEUTRAL = { ParamEyeLOpen: 1, ParamEyeROpen: 1 };
  const POSE = {
    idle: { ParamMouthForm: 0.5 },
    closed: { ParamEyeLOpen: 0, ParamEyeROpen: 0, ParamEyeLSmile: 0.4, ParamEyeRSmile: 0.4, ParamMouthForm: 0.3, ParamAngleY: -8 },
    greeting: { ParamMouthOpenY: 0.3, ParamMouthForm: 1,
      ParamAngleZ: -12, ParamBodyAngleZ: -6, ParamArmRA: 10 },
    bow: { ParamAngleY: -30, ParamBodyAngleY: -10, ParamEyeLOpen: 0, ParamEyeROpen: 0, ParamEyeLSmile: 1, ParamEyeRSmile: 1,
      ParamMouthForm: 1, ParamMouthOpenY: 0.3, ParamAngleZ: -6 },
    listening: { ParamAngleZ: 12, ParamAngleX: 8, ParamEyeBallX: 0.4, ParamBrowLForm: 0.6, ParamBrowRForm: 0.6, ParamMouthForm: 0.4, ParamBodyAngleZ: 4 },
    smug: { ParamEyeLOpen: 0.85, ParamEyeROpen: 0.85, ParamMouthForm: 1, ParamBrowLForm: 0.4,
      ParamBrowRForm: -0.3, ParamAngleZ: 10, ParamAngleY: 6, ParamEyeBallX: -0.4 },
    dozing: { ParamEyeLOpen: 0, ParamEyeROpen: 0, ParamAngleY: -22, ParamAngleZ: 14, ParamBodyAngleZ: 5, ParamMouthForm: 0.4 },
    wink: { ParamEyeLOpen: 0, ParamEyeLSmile: 1, ParamEyeROpen: 1, ParamMouthForm: 1, ParamMouthOpenY: 0.35, ParamAngleZ: -10, ParamBodyAngleZ: -4 },
  };
  const SCREEN_POSE = { reveal: "closed", name: "greeting", nice: "bow", talk: "idle", screen: "listening", code: "smug", game: "greeting",
    everything: "idle", memory: "dozing", tease: "idle", promise: "idle", signoff: "greeting" };
  const events = data.screens.map((s) => ({ t: s.start, pose: SCREEN_POSE[s.key] }));
  events.push({ t: screenOf.reveal.start + 0.85, pose: "greeting" }); // eyes open as the light clears
  events.push({ t: lineOf["13-otsumana"].start - 0.05, pose: "wink" });
  events.sort((a, b) => a.t - b.t);
  const PARAMS = [...new Set(Object.values(POSE).flatMap(Object.keys).concat(Object.keys(NEUTRAL)))];

  function poseValue(id, t) {
    let v = NEUTRAL[id] ?? 0;
    for (const e of events) {
      if (e.t > t) break;
      const target = POSE[e.pose][id] ?? NEUTRAL[id] ?? 0;
      v += (target - v) * smooth((t - e.t) / 0.35);
    }
    return v;
  }

  // blinks every ~3-4.5s (fixed pseudo-random sequence), 0.16s each
  const blinks = [];
  for (let t = 1.9, k = 7; t < data.duration; ) { blinks.push(t); k = (k * 1103515245 + 12345) % 2147483648; t += 3 + (k % 1500) / 1000; }
  const blinkAt = (t) => blinks.reduce((m, b) => Math.max(m, 1 - Math.abs(t - b) / 0.08), 0);

  // slow side-to-side sway, ~4.2s per cycle: slower than her breathing so the two don't lock together
  const sway = (t) => Math.sin((2 * Math.PI * t) / 4.2);

  let curT = 0;
  im.on("afterMotionUpdate", () => {
    const t = curT;
    const m = data.mouth[Math.min(data.mouth.length - 1, Math.round(t * data.fps))] || 0;
    const v = Object.fromEntries(PARAMS.map((id) => [id, poseValue(id, t)]));
    const blink = 1 - blinkAt(t);
    v.ParamEyeLOpen *= v.ParamEyeLOpen > 0.3 ? blink : 1;
    v.ParamEyeROpen *= v.ParamEyeROpen > 0.3 ? blink : 1;
    v.ParamMouthOpenY = Math.max(v.ParamMouthOpenY * (1 - m), m * 0.95);
    v.ParamAngleX = (v.ParamAngleX || 0) + 4 * Math.sin(t * 0.6);
    v.ParamAngleY = (v.ParamAngleY || 0) + 3 * m;                       // small nods on stressed syllables
    v.ParamAngleZ = (v.ParamAngleZ || 0) + 2.5 * Math.sin(t * 0.43 + 1) + 2 * sway(t - 0.25); // head trails the body
    v.ParamBodyAngleZ = (v.ParamBodyAngleZ || 0) + 4 * sway(t);
    v.ParamBodyAngleX = (v.ParamBodyAngleX || 0) + 2 * Math.sin(t * 0.31 + 2);
    v.ParamBreath = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 3.2);
    for (const [id, val] of Object.entries(v)) core.setParameterValueById(id, val);
  });

  // where she stands, in logical stage units: horizontal centre, top of head, body height
  const SPOT = { full: { cx: 400, top: 20, h: 430, a: 1 }, // h is the mesh-bounds height, which runs past her feet: 830 frames her waist-up
    presenter: { cx: 146, top: 8, h: 830, a: 1 },
    center: { cx: 400, top: 8, h: 830, a: 1 }, hidden: { cx: 146, top: 8, h: 830, a: 0 } };
  const SCREEN_SPOT = { reveal: "full", nice: "center", tease: "hidden" };
  const spotOf = (key) => SPOT[SCREEN_SPOT[key] || "presenter"];

  // art bounds from the model's own mesh, so framing doesn't depend on its canvas padding
  model.update(16); app.renderer.render(app.stage);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < core.getDrawableCount(); i++) {
    if (core.getDrawableOpacity(i) <= 0) continue;
    const vs = im.getDrawableVertices(i);
    for (let j = 0; j < vs.length; j += 2) {
      x0 = Math.min(x0, vs[j]); x1 = Math.max(x1, vs[j]); y0 = Math.min(y0, vs[j + 1]); y1 = Math.max(y1, vs[j + 1]);
    }
  }

  function placeModel(t) {
    let p = { ...spotOf(data.screens[0].key) };
    for (const s of data.screens) {
      if (s.start > t) break;
      const q = spotOf(s.key), k = easeInOut((t - s.start) / 0.6);
      for (const f of ["cx", "top", "h", "a"]) p[f] += (q[f] - p[f]) * k;
    }
    const r = t - screenOf.reveal.start; // she materialises out of the flash
    if (r < 1.4) { const k = smooth((r - 0.72) / 0.45); p.a *= k; p.h *= 0.9 + 0.1 * k; }
    const scale = (p.h * S) / (y1 - y0);
    model.scale.set(scale);
    model.x = (p.cx + 2.5 * sway(t)) * S - ((x0 + x1) / 2) * scale; // a few px of drift with the lean
    model.y = p.top * S - y0 * scale;
    model.alpha = p.a;
  }

  let lastT = 0;
  window.seek = (t) => {
    curT = t;
    drawDom(t);
    placeModel(t);
    model.update(Math.max(0.001, (t - lastT) * 1000)); // deltaTime must be > 0 or the model skips its update
    lastT = Math.max(lastT, t);
    app.renderer.render(app.stage);
    return true;
  };

  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
  window.seek(0);
  window.debutReady = true;
})().catch((e) => { window.debutError = String(e && e.stack || e); console.error(e); });
