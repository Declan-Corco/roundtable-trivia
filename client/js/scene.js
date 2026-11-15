// The 3D backdrop behind the menus: the roundtable model on a wooden floor under one spotlight,
// with the camera shifting slightly as the pointer moves.
//
// Pages opt in by loading this module (plus the import map for three.js) and putting `room` on
// <body> while a menu is showing (common.js does that for screens marked data-room). The canvas
// sits behind the page and takes no clicks, focus or keys, and if WebGL or the model isn't
// available the page drops back to its flat look (html.no-scene, see style.css).
//
// An element marked data-scene-avoid (the landing page's panel, the lobby's guest list) is kept
// clear: the table is framed in the largest free area beside or above it.
//
// The host's lobby uses the scene as its table (common.js setStage): the camera rises over the
// table, the PIN sits on the tabletop and each guest's name hangs over their stool. Seat N is the
// Nth stool clockwise from the far side; past six guests, more stools are added around the table
// and the camera backs off to fit them.

const MODEL_URL = '/assets/3d/roundtable.glb';
const FLOOR_URL = '/assets/3d/wood-floor.webp';

// The server tags this script's URL with a hash of client/ (?v=…). Pass it on to everything
// loaded from here, so browsers fetch new copies after an update.
const VERSION = new URL(import.meta.url).searchParams.get('v');
const versioned = (url) => (VERSION ? `${url}?v=${VERSION}` : url);

const VIEW = {
  fov: 30, // degrees, vertical
  swingX: 4, // how far the pointer swings the camera sideways, degrees each way
  swingY: 2, // …and up and down
  ease: 0.35, // seconds for the camera to catch up with the pointer
  glide: 1.1, // seconds the table takes to glide from where the last page had it to its place here
  stageGlide: 1.4, // seconds to move between the menu view and the lobby's view over the table
};
// Where the camera stands for each stage: azimuth is around the table (0 = seat 1 at the top of
// the screen), elevation is how far above the horizon it looks down from, both in degrees; fill is
// how much of the free area the table and stools take up; swing is how much the pointer moves the
// camera (none in the lobby: tilting a straight-down view just looks wrong).
const VIEWS = {
  menu: { azimuth: 28, elevation: 33, fill: 0.8, swing: 1 },
  lobby: { azimuth: 0, elevation: 90, fill: 0.9, swing: 0 }, // straight down over the table, seat 1 at the top
};
// Going from one page with the scene to another (landing → host and back), the old page leaves its
// framing here, and the new one starts from it and glides to its own, so the table moves across
// instead of vanishing and reappearing.
// It also leaves a still picture of the scene (STILL_KEY), which an inline script in the next page's
// <head> shows from its very first frame (html.scene-still, see style.css), so the room is never
// empty while the scene loads. The live scene fades in over it, still in the old framing, and only
// then glides to its own.
const HANDOFF_KEY = 'roundtable-scene';
const STILL_KEY = 'roundtable-scene-still';
const HANDOFF_FRESH_MS = 5000;
const STILL_MAX_WIDTH = 1280; // px; the still is only on screen while the sharp scene fades in over it
const FADE_IN_MS = 500; // matches .scene-canvas.scene-arriving in style.css
const MAX_PIXEL_RATIO = 2;
const SHADOW_MAP_SIZE = 1024;
const FLOOR_TINT = 0xb48c68; // warms the pale floorboards towards the brand's wood brown
const STOOL_BASE_GLOW = 0.3; // how much of the stool bases' baked shading shows regardless of the light (0-1)
const BOARDS_PER_TILE = 10; // rows of floorboards in the floor texture
const BOARD_WIDTH = 0.36; // one floorboard's width, as a fraction of a stool seat's width
const POOL = 1.75; // radius of the pool of light on the floor, in "reaches" (centre to the farthest stool)
// Past the model's own stools, more go in rows further out, each RING_GAP stool widths beyond the
// last. Each row has a stool behind every first-row stool plus more in between, so outer rows hold
// more, and a row only gets stools as guests need them.
const RING_GAP = 1.7;
const STOOL_EASE = 0.45; // seconds for new stools to pop up
const MAX_STOOLS = 60; // guests past this many aren't given a stool of their own

const root = document.documentElement;
const rad = (deg) => (deg * Math.PI) / 180;

/** Drops the page back to its flat look. Never throws, and logs quietly: this is only decoration. */
function giveUp(reason, canvas) {
  root.classList.add('no-scene');
  root.classList.remove('scene-still', 'scene-live');
  canvas?.remove();
  document.querySelector('.scene-labels')?.remove();
  console.info(`roundtable: no 3D scene (${reason}).`);
}

function hasWebGL() {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

const roomShowing = () => document.body.classList.contains('room');

/** The framing the previous page left, if we've just come from it (read once). */
function takeHandoff() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(HANDOFF_KEY));
    sessionStorage.removeItem(HANDOFF_KEY);
    return saved && Date.now() - saved.t < HANDOFF_FRESH_MS ? saved : null;
  } catch {
    return null;
  }
}

/** Resolves once the page has loaded (unless told not to wait) and a menu that wants the scene is showing. */
async function whenWanted(waitForLoad) {
  if (waitForLoad && document.readyState !== 'complete') await new Promise((done) => addEventListener('load', done, { once: true }));
  if (roomShowing()) return;
  await new Promise((done) => {
    const watch = new MutationObserver(() => {
      if (!roomShowing()) return;
      watch.disconnect();
      done();
    });
    watch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  });
}

async function start() {
  // The page and its buttons come first; the scene loads afterwards. Coming from another page with
  // the scene, everything is in the browser's cache, so it starts straight away to keep the gap short.
  const handoff = takeHandoff();
  await whenWanted(!handoff);
  if (!hasWebGL()) return giveUp('WebGL 2 is not available');

  const canvas = document.createElement('canvas');
  canvas.className = handoff ? 'scene-canvas scene-arriving' : 'scene-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);

  try {
    const [THREE, { GLTFLoader }] = await Promise.all([import('three'), import('three/addons/loaders/GLTFLoader.js')]);
    const [gltf, floorMap] = await Promise.all([
      new GLTFLoader().loadAsync(versioned(MODEL_URL)),
      new THREE.TextureLoader().loadAsync(versioned(FLOOR_URL)),
    ]);
    build(THREE, canvas, gltf.scene, floorMap, handoff);
  } catch (err) {
    giveUp(err?.message || 'the model failed to load', canvas);
  }
}

function build(THREE, canvas, model, floorMap, handoff) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, MAX_PIXEL_RATIO));
  // "Neutral" tone mapping keeps saturated colours on their hue (ACES would push the cushions'
  // red towards orange and wash out the teal), so the seats still read as the brand colours.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // with shadow.radius below: soft edges
  renderer.shadowMap.autoUpdate = false; // shadows are only re-rendered when something moves

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const hasMouse = matchMedia('(hover: hover) and (pointer: fine)');

  // The room's colour comes from the stylesheet, so the floor fades into exactly the page behind it.
  const roomColor = new THREE.Color(getComputedStyle(root).getPropertyValue('--room').trim() || '#1b110b');
  const scene = new THREE.Scene();
  scene.background = roomColor;

  // ---- The model: measured, not assumed, so a replacement of another size still frames itself.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const baseReach = Math.hypot(size.x, size.z) / 2; // from the middle out to the farthest stool
  let reachGoal = baseReach; // grows when more stools are added round a bigger ring
  let reach = baseReach; // eases towards reachGoal
  let radius = 0; // of a ball that holds the table and every stool (set by sizeUp)
  const sizeUp = () => (radius = Math.hypot(reach, size.y / 2));
  sizeUp();
  const stoolNodes = [];
  let table = null;
  model.traverse((node) => {
    const parentName = node.parent?.name || '';
    if (/^stool/i.test(node.name) && !/^stool/i.test(parentName)) stoolNodes.push(node);
    if (!table && /^table/i.test(node.name)) table = node;
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
    // The stool bases were exported "unlit", with their shading baked into the texture. Left
    // like that they ignore the spotlight: flat grey poles that glow even in the table's shadow.
    // So they get a lit material here, with the baked texture as their colour. A straight-down
    // lamp barely reaches an upright pole, so a little of the bake is kept as a glow
    // (STOOL_BASE_GLOW) to stop them going black.
    if (node.material.isMeshBasicMaterial) {
      const baked = node.material;
      node.material = new THREE.MeshStandardMaterial({
        map: baked.map,
        color: baked.color,
        side: baked.side,
        roughness: 0.9,
        metalness: 0,
        emissive: 0xffffff,
        emissiveMap: baked.map,
        emissiveIntensity: STOOL_BASE_GLOW,
      });
      baked.dispose();
    }
  });
  scene.add(model);

  const stoolBox = stoolNodes[0] ? new THREE.Box3().setFromObject(stoolNodes[0]) : null;
  const stoolWidth = stoolBox ? stoolBox.getSize(new THREE.Vector3()).x : baseReach / 3;
  const stoolTop = stoolBox ? stoolBox.max.y : box.min.y + size.y * 0.6; // where name tags hang from
  const tableBox = table ? new THREE.Box3().setFromObject(table) : box;
  const tableTop = tableBox.max.y; // where the PIN sits
  const tableRadius = tableBox.getSize(new THREE.Vector3()).x / 2;

  // ---- Stools. Each one is a slot with a place round the table (angle a, clockwise from the far
  // side as the lobby's camera sees it, and distance r from the middle) and a size s, all easing
  // towards their targets (at, rt, st) so stools slide into place when more are added.
  const angleOf = (n) => (Math.atan2(n.position.x - centre.x, -(n.position.z - centre.z)) + 2 * Math.PI) % (2 * Math.PI);
  const yAxis = new THREE.Vector3(0, 1, 0);
  const turn = new THREE.Quaternion();
  const slots = stoolNodes
    .map((node) => {
      const a = angleOf(node);
      const r = Math.hypot(node.position.x - centre.x, node.position.z - centre.z);
      // a0/q0: the angle and turn the model gave this stool, so it can be turned to face the table from anywhere.
      return { node, a0: a, q0: node.quaternion.clone(), home: { a, r }, a, r, s: 1, at: a, rt: r, st: 1 };
    })
    .sort((p, q) => p.a - q.a);
  const modelStools = slots.length; // six in the shipped model
  const baseRing = modelStools ? slots.reduce((sum, s) => sum + s.r, 0) / modelStools : baseReach * 0.8;
  const stoolOverhang = baseReach - baseRing; // from a stool's centre to its outer edge
  let stoolCount = modelStools;

  /**
   * Where each of the first n seats goes: the model's own stools first, then row after row further
   * out, filled clockwise from the top. Every row repeats the first row's spread: a stool straight
   * behind each first-row stool, plus more evenly in between (one in the second row, two in the
   * third, …), so the spacing stays about the same as the rows get bigger.
   * Returns [{ a, r }] and the outermost row's radius.
   */
  function seatPlaces(n) {
    const places = slots.slice(0, modelStools).map((s) => ({ ...s.home }));
    const firstStep = (2 * Math.PI) / modelStools; // between neighbouring first-row seats
    const seatOne = slots[0].home.a;
    let outer = baseRing;
    for (let row = 1; places.length < n; row++) {
      const r = baseRing + row * RING_GAP * stoolWidth;
      const step = firstStep / (row + 1);
      for (let j = 0; j < modelStools * (row + 1) && places.length < n; j++) {
        const a = seatOne + j * step;
        places.push({ a: ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), r });
      }
      outer = r;
    }
    return { places, outer };
  }

  /** Sets out a stool for every seat up to the highest one taken (and never fewer than the model's own). */
  function setStoolCount(highestSeat) {
    if (!modelStools) return;
    const n = Math.min(MAX_STOOLS, Math.max(modelStools, highestSeat));
    if (n === stoolCount) return;
    stoolCount = n;
    const { places, outer } = seatPlaces(n);
    const colours = Math.min(3, modelStools); // the model's stools go red, yellow, teal, red, …
    for (let i = 0; i < n; i++) {
      let slot = slots[i];
      const at = places[i].a;
      const rt = places[i].r;
      if (!slot) {
        const like = slots[i % colours]; // same cushion colour as the seat number's
        const node = like.node.clone(); // shares the geometry and materials
        node.visible = false;
        model.add(node);
        slot = { node, a0: like.a0, q0: like.q0, home: null };
        slots.push(slot);
      }
      if (!slot.node.visible) {
        slot.node.visible = true;
        Object.assign(slot, { a: at, r: rt, s: 0 }); // pops up in its place
      }
      Object.assign(slot, { at, rt, st: 1 });
      placeStool(slot);
    }
    for (let i = n; i < slots.length; i++) slots[i].node.visible = false;
    reachGoal = Math.max(baseReach, outer + stoolOverhang);
    if (reduceMotion.matches) settleStools();
    else afterStoolsMoved();
    dirty = true;
    wake();
  }

  function placeStool(slot) {
    slot.node.position.set(centre.x + slot.r * Math.sin(slot.a), slot.node.position.y, centre.z - slot.r * Math.cos(slot.a));
    // Turning a stool clockwise (seen from above) is turning it by a negative angle about "up".
    slot.node.quaternion.copy(turn.setFromAxisAngle(yAxis, -(slot.a - slot.a0))).multiply(slot.q0);
    slot.node.scale.setScalar(Math.max(0.001, slot.s));
  }

  function settleStools() {
    for (const slot of slots) {
      if (!slot.node.visible) continue;
      Object.assign(slot, { a: slot.at, r: slot.rt, s: slot.st });
      placeStool(slot);
    }
    reach = reachGoal;
    afterStoolsMoved();
  }

  /** Eases stools (and the size of the whole arrangement) towards their places; true while any still moves. */
  function easeStools(dt) {
    const k = 1 - Math.exp(-dt / STOOL_EASE);
    let moving = false;
    for (const slot of slots) {
      if (!slot.node.visible) continue;
      const da = ((slot.at - slot.a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI; // the short way round
      const dr = slot.rt - slot.r;
      const ds = slot.st - slot.s;
      if (Math.abs(da) + Math.abs(dr) + Math.abs(ds) < 0.0005) continue;
      moving = true;
      slot.a += da * k;
      slot.r += dr * k;
      slot.s += ds * k;
      placeStool(slot);
    }
    if (Math.abs(reachGoal - reach) > 0.0005) {
      moving = true;
      reach += (reachGoal - reach) * k;
    }
    if (moving) afterStoolsMoved();
    return moving;
  }

  function afterStoolsMoved() {
    sizeUp();
    lamp.angle = Math.atan((reach * POOL) / lampHeight);
    renderer.shadowMap.needsUpdate = true;
  }

  // ---- The floor: big enough that the fog swallows it long before its edge, even round a big table.
  const tile = stoolWidth * BOARD_WIDTH * BOARDS_PER_TILE;
  const floorSize = baseReach * 120;
  floorMap.colorSpace = THREE.SRGBColorSpace;
  floorMap.wrapS = floorMap.wrapT = THREE.RepeatWrapping;
  floorMap.repeat.set(floorSize / tile, floorSize / tile);
  floorMap.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(floorSize, floorSize),
    new THREE.MeshStandardMaterial({ map: floorMap, color: FLOOR_TINT, roughness: 0.85, metalness: 0 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(centre.x, box.min.y, centre.z);
  floor.receiveShadow = true;
  scene.add(floor);

  // ---- Light: one spotlight straight above the table, and a little fill so shadows aren't black.
  const lampHeight = size.y + baseReach * 2.6;
  // Bright enough that a surface facing the lamp at table height shows about its own colour.
  const lamp = new THREE.SpotLight(0xfff1dc, Math.PI * (lampHeight - size.y) ** 2 * 1.15);
  lamp.position.set(centre.x, box.min.y + lampHeight, centre.z);
  lamp.target.position.set(centre.x, box.min.y, centre.z);
  lamp.angle = Math.atan((baseReach * POOL) / lampHeight);
  lamp.penumbra = 0.85;
  lamp.decay = 2;
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  lamp.shadow.camera.near = lampHeight - size.y - baseReach * 0.2;
  lamp.shadow.camera.far = lampHeight + baseReach * 0.2;
  lamp.shadow.radius = 5;
  lamp.shadow.bias = -0.0005;
  lamp.shadow.normalBias = 0.02;
  scene.add(lamp, lamp.target);
  scene.add(new THREE.HemisphereLight(0xffe2c4, 0x3a2416, 0.26));

  // ---- Labels over the scene (lobby only): the PIN on the tabletop and a name tag over each taken
  // stool. Plain HTML laid over the canvas, moved to follow the camera every time it draws.
  const labels = document.createElement('div');
  labels.className = 'scene-labels';
  labels.setAttribute('aria-hidden', 'true'); // the guest list and the top bar say the same for screen readers
  labels.hidden = true;
  labels.innerHTML =
    '<div class="scene-pin"><div class="scene-pin-body"><span class="scene-pin-label">Game PIN</span>' +
    '<span class="scene-pin-code"></span><span class="scene-pin-title"></span></div></div>';
  canvas.after(labels);
  const pinPlate = labels.querySelector('.scene-pin');
  const tags = new Map(); // player id → tag element

  // ---- Camera
  const camera = new THREE.PerspectiveCamera(VIEW.fov, 1, 0.1, 100);
  const target = new THREE.Vector3(centre.x, box.min.y + size.y * 0.42, centre.z);
  let distance = radius * 4;
  const swing = { x: handoff?.sx || 0, y: handoff?.sy || 0 }; // where the camera is, -1..1 each way
  const want = { ...swing }; // where the pointer (or the idle drift) wants it
  let stage = { view: 'menu' }; // what the page wants shown (common.js setStage)
  // The framing: how far the table's centre is shifted (fx, fy: fractions of the window), how far
  // back the camera stands (d: in model radii) and where from (az, el: degrees). `goal` is the
  // current stage's, `view` is what's on screen; they differ only while gliding between them.
  let goal = null;
  let view = null;
  let glide =
    handoff && !reduceMotion.matches
      ? { from: { az: VIEWS.menu.azimuth, el: VIEWS.menu.elevation, sw: 1, ...handoff }, start: 0, delay: FADE_IN_MS, duration: VIEW.glide }
      : null;
  scene.fog = new THREE.Fog(roomColor, 1, 2); // the floor fades out behind the table (set in frameView)

  function placeCamera() {
    const az = rad(view.az + swing.x * VIEW.swingX * view.sw);
    const el = rad(Math.min(90, view.el + swing.y * VIEW.swingY * view.sw));
    camera.position.set(
      target.x + distance * Math.cos(el) * Math.sin(az),
      target.y + distance * Math.sin(el),
      target.z + distance * Math.cos(el) * Math.cos(az)
    );
    // "Up" on screen is the far side of the table, which still works looking straight down.
    camera.up.set(-Math.sin(az), 0, -Math.cos(az));
    camera.lookAt(target);
  }

  /** The part of the window the table should sit in: the biggest area clear of the menu panel. */
  function freeArea(w, h) {
    const whole = { x: 0, y: 0, w, h };
    const panel = [...document.querySelectorAll('[data-scene-avoid]')].find((n) => n.offsetParent);
    if (!panel) return whole;
    const r = panel.getBoundingClientRect();
    const top = r.top + scrollY; // where the panel sits before any scrolling
    const areas = [
      { x: 0, y: 0, w: r.left, h }, // left of the panel
      { x: r.right, y: 0, w: w - r.right, h }, // right of it
      { x: 0, y: 0, w, h: Math.min(top, h) }, // above it
    ].filter((a) => a.w > 80 && a.h > 80);
    // The table needs a roughly square space, so judge each area by its shorter side.
    return areas.sort((a, b) => Math.min(b.w, b.h) - Math.min(a.w, a.h))[0] || whole;
  }

  /** Sizes the canvas and frames the model (by its measured size) in the free area. */
  function fit() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    // Resizing a canvas wipes it, and this often runs (from the ResizeObserver) after the frame's
    // drawing but before the browser paints, which would show one empty frame: a flicker. So only
    // resize when the size really changed, and then draw again straight away.
    const ratio = Math.min(devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const resized = canvas.width !== Math.floor(w * ratio) || canvas.height !== Math.floor(h * ratio);
    if (resized) {
      renderer.setPixelRatio(ratio);
      renderer.setSize(w, h, false);
    }
    camera.aspect = w / h;

    const v = VIEWS[stage.view];
    const area = freeArea(w, h);
    const halfFov = Math.tan(rad(VIEW.fov) / 2);
    const across = (Math.min(area.w, area.h) * v.fill) / h; // of the window's height
    goal = {
      // Shift the picture so the table's centre lands in the middle of the free area…
      fx: 0.5 - (area.x + area.w / 2) / w,
      fy: 0.5 - (area.y + area.h / 2) / h,
      // …and stand far enough back that the ball around the model fits inside it.
      d: 1 / Math.sin(Math.atan(across * halfFov)),
      az: v.azimuth,
      el: v.elevation,
      sw: v.swing,
    };
    if (resized && canvas.classList.contains('ready')) {
      updateFraming(performance.now());
      draw();
    }
    dirty = true;
    wake();
  }

  /** Points the camera for a framing (see `goal`). */
  function frameView(v) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    view = v;
    camera.setViewOffset(w, h, v.fx * w, v.fy * h, w, h);
    distance = v.d * radius;
    camera.near = distance * 0.1; // the floor right under the camera is still well beyond this
    camera.far = distance + reach * 10; // just past where the fog ends
    camera.updateProjectionMatrix();
    // The floor fades out behind the table, well before its edge.
    scene.fog.near = distance + reach * 1.5;
    scene.fog.far = distance + reach * 9;
  }

  /** Moves the framing towards the goal; true while it is still gliding there. */
  function updateFraming(now) {
    if (!goal) return false;
    if (!glide) {
      frameView(goal);
      return false;
    }
    if (!glide.start) glide.start = now + glide.delay; // e.g. hold the old framing while fading in over the still
    if (now < glide.start) {
      frameView(glide.from);
      return true;
    }
    const p = Math.min(1, (now - glide.start) / (glide.duration * 1000));
    const e = p * p * (3 - 2 * p); // eases in and out
    const mix = (key) => glide.from[key] + (goal[key] - glide.from[key]) * e;
    frameView({ fx: mix('fx'), fy: mix('fy'), d: mix('d'), az: mix('az'), el: mix('el'), sw: mix('sw') });
    if (p < 1) return true;
    glide = null;
    frameView(goal);
    return false;
  }

  // ---- Stage: what the page wants shown. The host's lobby passes its PIN and guests.
  function applyStage(next) {
    const before = stage.view;
    stage = next && VIEWS[next.view] ? next : { view: 'menu' };
    const seats = stage.view === 'lobby' ? stage.seats || [] : [];
    setStoolCount(Math.max(0, ...seats.map((p) => p.seat || 0)));
    updateLabels(seats);
    // Moving between the menu and the lobby: the camera glides from where it is to the new view.
    if (stage.view !== before && view && !reduceMotion.matches) {
      glide = { from: { ...view }, start: 0, delay: 0, duration: VIEW.stageGlide };
    }
    fit();
  }
  document.addEventListener('roundtable:stage', (e) => applyStage(e.detail));

  function updateLabels(seats) {
    labels.hidden = stage.view !== 'lobby';
    if (labels.hidden) return;
    labels.querySelector('.scene-pin-code').textContent = (stage.pin || '').replace(/(\d{3})(\d{3})/, '$1 $2');
    labels.querySelector('.scene-pin-title').textContent = stage.title || '';
    const seen = new Set();
    for (const p of seats) {
      seen.add(p.id);
      let tag = tags.get(p.id);
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'scene-tag';
        tag.innerHTML = '<span class="scene-tag-body"><span class="seat-no"></span><span class="scene-tag-name"></span></span>';
        labels.append(tag);
        tags.set(p.id, tag);
      }
      tag.dataset.seat = p.seat;
      tag.classList.toggle('away', !p.connected);
      const no = tag.querySelector('.seat-no');
      no.className = `seat-no s-${p.color || 'red'}`;
      no.textContent = p.seat;
      tag.querySelector('.scene-tag-name').textContent = p.name;
    }
    for (const [id, tag] of tags) {
      if (seen.has(id)) continue;
      tag.remove();
      tags.delete(id);
    }
  }

  const spot = new THREE.Vector3();
  /** Where a point in the scene lands on the page, in CSS pixels. */
  function onPage(x, y, z) {
    spot.set(x, y, z).project(camera);
    return [((spot.x + 1) / 2) * canvas.clientWidth, ((1 - spot.y) / 2) * canvas.clientHeight];
  }

  function placeLabels() {
    if (labels.hidden) return;
    const [px, py] = onPage(centre.x, tableTop, centre.z);
    const [ex, ey] = onPage(centre.x + tableRadius, tableTop, centre.z);
    labels.style.setProperty('--table-r', `${Math.hypot(ex - px, ey - py).toFixed(1)}px`); // sizes the PIN to the table
    pinPlate.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
    for (const tag of tags.values()) {
      const slot = slots[tag.dataset.seat - 1];
      if (!slot || !slot.node.visible) {
        tag.style.visibility = 'hidden';
        continue;
      }
      const [x, y] = onPage(slot.node.position.x, stoolTop, slot.node.position.z);
      tag.style.visibility = '';
      tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  function draw() {
    placeCamera();
    renderer.render(scene, camera);
    placeLabels();
  }

  // Leaving for another page: tell it where the table is, and leave it a picture of the room as it
  // looks right now (at the canvas's current opacity, over the room colour), so it can carry on.
  addEventListener('pagehide', () => {
    if (!onScreen || !view) return;
    try {
      const t = Date.now();
      sessionStorage.setItem(
        HANDOFF_KEY,
        JSON.stringify({ t, fx: view.fx, fy: view.fy, d: view.d, az: view.az, el: view.el, sw: view.sw, sx: swing.x, sy: swing.y })
      );
      draw(); // the drawing buffer is only readable in the task that drew it
      const scale = Math.min(1, STILL_MAX_WIDTH / canvas.width);
      const still = document.createElement('canvas');
      still.width = Math.round(canvas.width * scale);
      still.height = Math.round(canvas.height * scale);
      const g = still.getContext('2d');
      g.fillStyle = `#${roomColor.getHexString()}`;
      g.fillRect(0, 0, still.width, still.height);
      g.globalAlpha = parseFloat(getComputedStyle(canvas).opacity) || 0;
      g.drawImage(canvas, 0, 0, still.width, still.height);
      sessionStorage.setItem(STILL_KEY, JSON.stringify({ t, url: still.toDataURL('image/jpeg', 0.85) }));
    } catch {}
  });

  // ---- Motion: follow the mouse; with no mouse, drift very slowly; with reduced motion, stay still.
  const drifting = () => !reduceMotion.matches && !hasMouse.matches;

  addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType !== 'mouse' || reduceMotion.matches || !hasMouse.matches) return;
      want.x = (e.clientX / innerWidth) * 2 - 1;
      want.y = (e.clientY / innerHeight) * 2 - 1;
      wake();
    },
    { passive: true }
  );
  const motionChanged = () => {
    want.x = want.y = 0;
    if (reduceMotion.matches) swing.x = swing.y = 0;
    dirty = true;
    wake();
  };
  reduceMotion.addEventListener('change', motionChanged);
  hasMouse.addEventListener('change', motionChanged);

  // ---- Rendering: only while the canvas is on screen and the tab is showing, and only when
  // something has changed (the camera is still catching up, stools are sliding, …).
  let dirty = true;
  let onScreen = false;
  let frame = 0;
  let last = 0;
  let lastDraw = 0;
  const active = () => onScreen && !document.hidden;

  function wake() {
    if (!frame && active()) frame = requestAnimationFrame(tick);
  }

  function tick(now) {
    frame = 0;
    if (!active()) return;
    const dt = Math.min(0.1, (now - last) / 1000 || 0);
    last = now;
    if (drifting()) {
      want.x = Math.sin(now / 9000);
      want.y = Math.sin(now / 13000 + 1) * 0.6;
    }
    const k = 1 - Math.exp(-dt / VIEW.ease);
    const dx = want.x - swing.x;
    const dy = want.y - swing.y;
    const swinging = Math.abs(dx) + Math.abs(dy) > 0.0005;
    if (swinging) {
      swing.x += dx * k;
      swing.y += dy * k;
    }
    const stoolsMoving = easeStools(dt);
    const gliding = updateFraming(now);
    const moving = swinging || stoolsMoving || gliding;
    // The idle drift is slow enough that 30 frames a second is plenty (kinder to phone batteries).
    const due = !drifting() || gliding || stoolsMoving || now - lastDraw > 30;
    if ((moving || dirty) && due) {
      draw();
      lastDraw = now;
      dirty = false;
      if (!canvas.classList.contains('ready')) {
        canvas.classList.add('ready'); // fades in (style.css)
        root.classList.add('scene-live'); // the lobby swaps its flat table for this one
        if (root.classList.contains('scene-still')) {
          // The still from the last page fades out as the scene fades in, then goes.
          root.classList.add('scene-drawn');
          setTimeout(() => {
            root.classList.remove('scene-still', 'scene-drawn');
            root.style.removeProperty('--scene-still');
          }, FADE_IN_MS + 100);
        }
      }
    }
    if (moving || dirty || drifting()) frame = requestAnimationFrame(tick);
  }

  // The canvas is display:none whenever no menu is showing (a game in progress).
  new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1].isIntersecting;
    if (onScreen) {
      last = 0;
      fit(); // the menu showing now may leave a different area free
    }
  }).observe(canvas);
  document.addEventListener('visibilitychange', () => {
    last = 0;
    wake();
  });
  // Covers window resizes, phones rotating, and panels changing size (e.g. once the font loads, or
  // the lobby's guest list appearing).
  const resized = new ResizeObserver(() => fit());
  resized.observe(canvas);
  document.querySelectorAll('[data-scene-avoid]').forEach((n) => resized.observe(n));

  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => {
    renderer.shadowMap.needsUpdate = true;
    dirty = true;
    wake();
  });

  renderer.shadowMap.needsUpdate = true;
  // The page may have asked for a stage before the scene loaded (e.g. the host reloading in the lobby).
  const early = window.roundtableStage;
  if (early && early.view !== 'menu') {
    applyStage(early);
    if (!handoff) glide = null; // just be there, no glide in from the menu
  }
  fit();
}

start().catch((err) => giveUp(err?.message || 'unexpected error'));
