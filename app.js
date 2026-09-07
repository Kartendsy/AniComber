import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const FPS = 30;
const SAMPLE_URLS = [
  "https://unpkg.com/three@0.160.0/examples/models/gltf/Soldier.glb",
  "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/models/gltf/Soldier.glb",
];

// ---------- Scene ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa0a0a0);
// Fog intentionally disabled: it covers the model (especially Mixamo scale ~180 units)

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(100, 200, 300);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.domElement.id = "viewport";
renderer.domElement.style.cssText = "position:fixed;inset:0;z-index:0;display:block;";
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 100, 0);
controls.update();

// Lights (boosted so FBX models without PBR materials stay bright)
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
dirLight.position.set(0, 200, 100);
dirLight.castShadow = true;
dirLight.shadow.camera.top = 180;
dirLight.shadow.camera.bottom = -100;
dirLight.shadow.camera.left = -120;
dirLight.shadow.camera.right = 120;
scene.add(dirLight);

// Ground
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(2000, 2000),
  new THREE.MeshPhongMaterial({ color: 0x999999, depthWrite: false })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -80;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(2000, 20, 0x000000, 0x000000);
grid.material.opacity = 0.2;
grid.material.transparent = true;
grid.position.y = -80;
scene.add(grid);

// ---------- State ----------
let mainModel = null;
let charFileName = "";
let charBones = new Set();
let animations = []; // THREE.AnimationClip[]
let mixer = null;
let currentAction = null;
let playingUuid = null;
let selectedUuid = null;
let isPaused = false;
let scrubbing = false;
let skeletonHelper = null;
let pendingPreset = new Map(); // clip name -> {trimStart, trimEnd, speed, loop, sel}

const clipSettings = new Map(); // uuid -> {trimStart, trimEnd, speed, loop}
const selectedForExport = new Set(); // uuid

const fbxLoader = new FBXLoader();
const gltfLoader = new GLTFLoader();
const clock = new THREE.Clock();

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const loadingEl = $("loading");
const animListEl = $("animList");
const animTitleEl = $("animTitle");
const exportCountEl = $("exportCount");
const compatInfoEl = $("compatInfo");
const clipSelectEl = $("clipSelect");
const trimStartEl = $("trimStart");
const trimEndEl = $("trimEnd");
const speedEl = $("speed");
const speedValEl = $("speedVal");
const loopChkEl = $("loopChk");
const scrubEl = $("scrub");
const timeLabelEl = $("timeLabel");
const playPauseBtn = $("playPauseBtn");

window.addEventListener("error", (ev) => {
  console.error(ev.error || ev.message);
  if (statusEl) statusEl.innerText = "Error: " + (ev.error?.message || ev.message);
});

function setStatus(msg) { statusEl.innerText = msg; }
function setLoading(on, msg) {
  loadingEl.style.display = on ? "flex" : "none";
  loadingEl.innerText = on ? (msg || "⏳ Loading...") : "";
}

function extOf(filename) { return filename.split(".").pop().toLowerCase(); }
function cleanName(filename) {
  const base = filename.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  const noSpace = base.replace(/\s+/g, "");
  return noSpace.charAt(0).toUpperCase() + noSpace.slice(1) || "Anim";
}
function uniqueClipName(wanted) {
  const taken = new Set(animations.map((a) => a.name));
  if (!taken.has(wanted)) return wanted;
  let i = 1;
  while (taken.has(`${wanted}_${i}`)) i++;
  return `${wanted}_${i}`;
}
function describeError(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

const GENERIC_CLIP_NAMES = new Set(["take 001", "take001", "mixamo.com", "scene", "animation", ""]);

// ---------- Rig compatibility ----------
function collectBones(model) {
  const set = new Set();
  model.traverse((c) => { if (c.isBone) set.add(c.name); });
  return set;
}
function clipNodes(clip) {
  const set = new Set();
  for (const t of clip.tracks) set.add(t.name.split(".")[0]);
  return set;
}
function compatPct(clip) {
  if (!charBones.size) return null;
  const nodes = clipNodes(clip);
  if (!nodes.size) return 0;
  let hit = 0;
  nodes.forEach((n) => { if (charBones.has(n)) hit++; });
  return Math.round((hit / nodes.size) * 100);
}
function refreshCompatInfo() {
  if (!mainModel) { compatInfoEl.innerText = ""; return; }
  compatInfoEl.innerText = `🦴 ${charBones.size} bones • "${charFileName}" • ${animations.length} clips`;
}

// ---------- Camera / ground ----------
function fitCameraToModel(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) {
    console.warn("Box3 is empty — model may have no geometry.");
    return;
  }
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  console.log("[anicomber] size:", size, "center:", center);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fov = camera.fov * (Math.PI / 180);
  const dist = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 1.8;
  camera.near = Math.max(0.01, dist / 1000);
  camera.far = Math.max(5000, dist * 20);
  camera.updateProjectionMatrix();
  camera.position.set(center.x + dist * 0.6, center.y + dist * 0.35, center.z + dist);
  controls.target.copy(center);
  controls.update();
}
function groundModel(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y += (-80 - box.min.y);
  object.updateMatrixWorld(true);
}

// ---------- Per-clip settings ----------
function ensureSettings(clip) {
  if (!clipSettings.has(clip.uuid)) {
    const preset = pendingPreset.get(clip.name);
    clipSettings.set(clip.uuid, preset ? { ...preset, sel: undefined } : {
      trimStart: 0, trimEnd: clip.duration, speed: 1, loop: true,
    });
    if (preset && preset.sel !== false) selectedForExport.add(clip.uuid);
    else if (!preset) selectedForExport.add(clip.uuid);
  }
  return clipSettings.get(clip.uuid);
}
function effDur(clip, s) {
  return Math.max(0.01, (s?.trimEnd ?? clip.duration) - (s?.trimStart ?? 0));
}

// ---------- Animation list ----------
function renderAnimList() {
  animTitleEl.innerText = `Animations (${animations.length})`;
  const headCount = $("headCount");
  if (headCount) headCount.innerText = `${animations.length} clips`;
  exportCountEl.innerText = `Export: ${selectedForExport.size} clips checked`;
  animListEl.innerHTML = "";

  if (!animations.length) {
    const li = document.createElement("div");
    li.className = "anim-item stop";
    li.textContent = "No animations found!";
    animListEl.appendChild(li);
    renderClipSelect();
    return;
  }

  const stop = document.createElement("div");
  stop.className = "anim-item stop";
  stop.innerHTML = `<span>⏹ Stop All Animations</span>`;
  stop.onclick = stopAll;
  animListEl.appendChild(stop);

  animations.forEach((clip) => {
    ensureSettings(clip);
    const pct = compatPct(clip);
    const div = document.createElement("div");
    div.className = "anim-item" + (clip.uuid === playingUuid ? " playing" : "");
    div.title = "Click: play • Double-click: rename";

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.className = "h-4 w-4 shrink-0";
    chk.checked = selectedForExport.has(clip.uuid);
    chk.title = "Include in export";
    chk.onclick = (e) => e.stopPropagation();
    chk.onchange = () => {
      if (chk.checked) selectedForExport.add(clip.uuid);
      else selectedForExport.delete(clip.uuid);
      exportCountEl.innerText = `Export: ${selectedForExport.size} clips checked`;
    };

    const icon = document.createElement("span");
    icon.className = "shrink-0";
    icon.textContent = clip.uuid === playingUuid ? (isPaused ? "⏸" : "▶") : "🎬";

    const wrap = document.createElement("span");
    wrap.className = "name";
    wrap.textContent = clip.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    let compatTxt = "";
    if (pct !== null) {
      compatTxt = pct >= 70
        ? ` • <span class="compat-ok">✓${pct}%</span>`
        : ` • <span class="compat-warn">⚠${pct}%</span>`;
    }
    meta.innerHTML = `${clip.duration.toFixed(2)}s • ${clip.tracks.length} tracks${compatTxt}`;
    wrap.appendChild(meta);

    const del = document.createElement("span");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete animation";
    del.onclick = (e) => { e.stopPropagation(); removeAnimation(clip.uuid); };

    div.appendChild(chk);
    div.appendChild(icon);
    div.appendChild(wrap);
    div.appendChild(del);
    div.onclick = () => { selectedUuid = clip.uuid; playClip(clip); renderClipSelect(); renderSettingsPanel(); };
    div.ondblclick = () => startRename(div, clip);
    animListEl.appendChild(div);
  });
  renderClipSelect();
}

function startRename(container, clip) {
  container.innerHTML = "";
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = clip.name;
  const commit = () => {
    const v = input.value.trim();
    if (v) clip.name = v;
    renderAnimList();
    renderSettingsPanel();
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") renderAnimList();
    e.stopPropagation();
  };
  input.onblur = commit;
  input.onclick = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();
  container.appendChild(input);
  input.focus();
  input.select();
}

function renderClipSelect() {
  const prev = selectedUuid;
  clipSelectEl.innerHTML = "";
  if (!animations.length) {
    const o = document.createElement("option");
    o.textContent = "(no clips yet)";
    clipSelectEl.appendChild(o);
    return;
  }
  animations.forEach((c) => {
    const o = document.createElement("option");
    o.value = c.uuid;
    o.textContent = c.name;
    clipSelectEl.appendChild(o);
  });
  if (prev && animations.some((c) => c.uuid === prev)) clipSelectEl.value = prev;
  else { selectedUuid = animations[0].uuid; clipSelectEl.value = selectedUuid; }
}

function renderSettingsPanel() {
  const clip = animations.find((c) => c.uuid === selectedUuid);
  if (!clip) return;
  const s = ensureSettings(clip);
  trimStartEl.value = s.trimStart.toFixed(2);
  trimStartEl.max = clip.duration.toFixed(2);
  trimEndEl.value = s.trimEnd.toFixed(2);
  trimEndEl.max = clip.duration.toFixed(2);
  speedEl.value = s.speed;
  speedValEl.innerText = `${Number(s.speed).toFixed(2)}x`;
  loopChkEl.checked = s.loop;
}

function readSettingsPanel() {
  const clip = animations.find((c) => c.uuid === selectedUuid);
  if (!clip) return;
  const s = ensureSettings(clip);
  s.trimStart = Math.max(0, Math.min(Number(trimStartEl.value) || 0, clip.duration));
  s.trimEnd = Math.max(s.trimStart + 0.01, Math.min(Number(trimEndEl.value) || clip.duration, clip.duration));
  s.speed = Math.min(3, Math.max(0.1, Number(speedEl.value) || 1));
  s.loop = loopChkEl.checked;
  speedValEl.innerText = `${s.speed.toFixed(2)}x`;
  // Apply immediately to the running action
  if (clip.uuid === playingUuid && currentAction) {
    mixer.timeScale = s.speed;
    currentAction.setLoop(s.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    currentAction.clampWhenFinished = !s.loop;
    if (currentAction.time < s.trimStart || currentAction.time > s.trimEnd) {
      currentAction.time = s.trimStart;
    }
  }
}
[trimStartEl, trimEndEl, loopChkEl].forEach((el) => el.addEventListener("change", readSettingsPanel));
speedEl.addEventListener("input", readSettingsPanel);
clipSelectEl.addEventListener("change", () => {
  selectedUuid = clipSelectEl.value;
  renderSettingsPanel();
});

// ---------- Playback ----------
function playClip(clip) {
  if (!mixer || !mainModel) {
    setStatus("Upload the main character first before previewing.");
    return;
  }
  if (clip.uuid === playingUuid && currentAction) {
    currentAction.paused = false;
    isPaused = false;
    playPauseBtn.innerText = "⏸";
    renderAnimList();
    return;
  }
  try {
    const s = ensureSettings(clip);
    if (currentAction) currentAction.stop();
    mixer.timeScale = s.speed;
    currentAction = mixer.clipAction(clip);
    currentAction.setLoop(s.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    currentAction.clampWhenFinished = !s.loop;
    currentAction.reset();
    currentAction.time = s.trimStart;
    currentAction.paused = false;
    currentAction.play();
    playingUuid = clip.uuid;
    selectedUuid = clip.uuid;
    isPaused = false;
    playPauseBtn.innerText = "⏸";
    renderAnimList();
    renderSettingsPanel();
    const pct = compatPct(clip);
    setStatus(pct !== null && pct < 70
      ? `▶ ${clip.name} — ⚠ rig only ${pct}% compatible, the pose may break.`
      : `▶ Playing: ${clip.name}`);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to play ${clip.name}: the rig may be incompatible.`);
  }
}
function stopAll() {
  if (currentAction) currentAction.stop();
  currentAction = null;
  playingUuid = null;
  isPaused = false;
  playPauseBtn.innerText = "▶";
  scrubEl.value = 0;
  timeLabelEl.innerText = "0.00 / 0.00s";
  renderAnimList();
  setStatus("⏹ All animations stopped.");
}
function removeAnimation(uuid) {
  if (currentAction && currentAction.getClip().uuid === uuid) {
    currentAction.stop();
    currentAction = null;
    playingUuid = null;
  }
  animations = animations.filter((a) => a.uuid !== uuid);
  clipSettings.delete(uuid);
  selectedForExport.delete(uuid);
  if (selectedUuid === uuid) selectedUuid = animations[0]?.uuid || null;
  renderAnimList();
  renderSettingsPanel();
  setStatus(`Animation deleted. Remaining: ${animations.length}`);
}

function togglePause() {
  const clip = animations.find((c) => c.uuid === playingUuid);
  if (!clip || !currentAction) {
    if (selectedUuid) {
      const sel = animations.find((c) => c.uuid === selectedUuid);
      if (sel) playClip(sel);
    }
    return;
  }
  isPaused = !isPaused;
  currentAction.paused = isPaused;
  playPauseBtn.innerText = isPaused ? "▶" : "⏸";
  renderAnimList();
}
function stepFrame(dir) {
  const clip = animations.find((c) => c.uuid === playingUuid) || animations.find((c) => c.uuid === selectedUuid);
  if (!clip || !currentAction) return;
  const s = ensureSettings(clip);
  if (!isPaused) togglePause();
  let t = currentAction.time + dir / FPS;
  if (t > s.trimEnd) t = s.loop ? s.trimStart + (t - s.trimEnd) : s.trimEnd;
  if (t < s.trimStart) t = s.loop ? s.trimEnd - (s.trimStart - t) : s.trimStart;
  currentAction.time = t;
  mixer.update(0);
}
playPauseBtn.onclick = togglePause;
$("stopBtn").onclick = stopAll;
$("stepBackBtn").onclick = () => stepFrame(-1);
$("stepFwdBtn").onclick = () => stepFrame(1);

scrubEl.addEventListener("pointerdown", () => { scrubbing = true; });
window.addEventListener("pointerup", () => { scrubbing = false; });
scrubEl.addEventListener("input", () => {
  const clip = animations.find((c) => c.uuid === playingUuid);
  if (!clip || !currentAction) return;
  const s = ensureSettings(clip);
  if (!isPaused) togglePause();
  currentAction.time = s.trimStart + effDur(clip, s) * (Number(scrubEl.value) / 1000);
  mixer.update(0);
});

// ---------- Loaders ----------
function loadObjectFromFile(file) {
  const ext = extOf(file.name);
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const done = (obj) => { URL.revokeObjectURL(url); resolve(obj); };
    const fail = (e) => { URL.revokeObjectURL(url); reject(e); };
    if (ext === "fbx") fbxLoader.load(url, done, undefined, fail);
    else if (ext === "glb" || ext === "gltf") gltfLoader.load(url, done, undefined, fail);
    else { URL.revokeObjectURL(url); reject(new Error(`Unsupported extension: ${ext}`)); }
  });
}
function normalizeLoaded(loaded, ext) {
  if (ext === "fbx") return { object3D: loaded, clips: loaded.animations || [] };
  return { object3D: loaded.scene, clips: loaded.animations || [] };
}

function setCharacter(object3D, clips, label) {
  if (mainModel) {
    scene.remove(mainModel);
    if (skeletonHelper) { scene.remove(skeletonHelper); skeletonHelper = null; }
    stopAll();
  }
  animations = [];
  clipSettings.clear();
  selectedForExport.clear();

  object3D.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  mainModel = object3D;
  charFileName = label;
  scene.add(mainModel);
  groundModel(mainModel);
  fitCameraToModel(mainModel);
  charBones = collectBones(mainModel);
  refreshSkeleton();

  mixer = new THREE.AnimationMixer(mainModel);

  clips.forEach((clip) => {
    if (GENERIC_CLIP_NAMES.has((clip.name || "").toLowerCase().trim())) {
      clip.name = "T-Pose (No Animation)";
    }
    clip.name = uniqueClipName(clip.name);
    ensureSettings(clip);
  });
  animations = [...clips];
  selectedUuid = animations[0]?.uuid || null;

  let meshCount = 0;
  mainModel.traverse((c) => { if (c.isMesh) meshCount++; });
  const sz = new THREE.Box3().setFromObject(mainModel).getSize(new THREE.Vector3());

  // Report built-in animations that don't match the rig
  const bad = animations.filter((c) => (compatPct(c) ?? 100) < 70);
  renderAnimList();
  renderSettingsPanel();
  refreshCompatInfo();
  setStatus(`Character "${label}" loaded (${meshCount} meshes, height ±${sz.y.toFixed(1)}, ${charBones.size} bones). Built-in animations: ${clips.length}${bad.length ? ` — ⚠ ${bad.length} incompatible with the rig.` : "."}`);
  if (animations.length) playClip(animations[0]);
}

$("charInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setLoading(true, "⏳ Loading character...");
  try {
    const ext = extOf(file.name);
    const loaded = await loadObjectFromFile(file);
    const { object3D, clips } = normalizeLoaded(loaded, ext);
    setCharacter(object3D, clips, file.name);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load character: ${describeError(err)} — make sure the .fbx/.glb file is valid, not a split .gltf + .bin.`);
  } finally {
    setLoading(false);
    e.target.value = "";
  }
});

async function addAnimationFiles(files) {
  if (!files.length) return;
  setLoading(true, `⏳ Loading ${files.length} animations...`);
  let added = 0;
  const warn = [];
  for (const file of files) {
    try {
      const ext = extOf(file.name);
      const loaded = await loadObjectFromFile(file);
      const { clips } = normalizeLoaded(loaded, ext);
      if (!clips.length) {
        warn.push(`"${file.name}" has no animations`);
        continue;
      }
      const base = cleanName(file.name);
      clips.forEach((clip, idx) => {
        const wanted = clips.length > 1 ? `${base}${idx}` : base;
        const orig = (clip.name || "").trim();
        if (clips.length === 1 && orig && !GENERIC_CLIP_NAMES.has(orig.toLowerCase())) {
          clip.name = uniqueClipName(`${base}_${orig}`);
        } else {
          clip.name = uniqueClipName(wanted);
        }
        ensureSettings(clip);
        const pct = compatPct(clip);
        if (pct !== null && pct < 70) warn.push(`"${clip.name}" only ${pct}% compatible`);
      });
      animations.push(...clips);
      added += clips.length;
      renderAnimList();
    } catch (err) {
      console.error(err);
      warn.push(`"${file.name}": ${describeError(err)}`);
    }
  }
  setLoading(false);
  if (added && mixer && !currentAction) {
    selectedUuid = animations[animations.length - added].uuid;
    playClip(animations[animations.length - added]);
  }
  renderSettingsPanel();
  refreshCompatInfo();
  setStatus(`Successfully added ${added} animations. Total: ${animations.length}.${warn.length ? " ⚠ " + warn.slice(0, 3).join(" • ") : ""}`);
}

$("animInput").addEventListener("change", async (e) => {
  await addAnimationFiles(Array.from(e.target.files || []));
  e.target.value = "";
});

// ---------- Texture ----------
$("texInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!mainModel) {
    setStatus("Upload the character first before changing the texture.");
    return;
  }
  const url = URL.createObjectURL(file);
  new THREE.TextureLoader().load(url, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    let n = 0;
    mainModel.traverse((child) => {
      if (child.isMesh) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => { if (m) { m.map = tex; m.needsUpdate = true; n++; } });
      }
    });
    URL.revokeObjectURL(url);
    setStatus(`Texture replaced (${n} materials).`);
  });
  e.target.value = "";
});

// ---------- Skeleton helper ----------
function refreshSkeleton() {
  if (skeletonHelper) { scene.remove(skeletonHelper); skeletonHelper = null; }
  if ($("skeletonChk").checked && mainModel) {
    skeletonHelper = new THREE.SkeletonHelper(mainModel);
    skeletonHelper.material.linewidth = 2;
    scene.add(skeletonHelper);
  }
}
$("skeletonChk").addEventListener("change", refreshSkeleton);

// ---------- Sample model ----------
$("sampleBtn").addEventListener("click", async () => {
  setLoading(true, "⏳ Downloading sample model...");
  let lastErr = null;
  for (const url of SAMPLE_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const loaded = await gltfLoader.parseAsync(buf, "");
      const { object3D, clips } = normalizeLoaded(loaded, "glb");
      setCharacter(object3D, clips, "Soldier.glb (sample)");
      setLoading(false);
      return;
    } catch (err) {
      lastErr = err;
      console.warn("Sample failed from", url, err);
    }
  }
  setLoading(false);
  setStatus(`Failed to load sample: ${describeError(lastErr)} — check your internet connection.`);
});

// ---------- Drag & drop ----------
const dropOverlay = $("dropOverlay");
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  dropOverlay.style.display = "flex";
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.style.display = "none"; }
});
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.style.display = "none";
  const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
    ["fbx", "glb", "gltf"].includes(extOf(f.name)));
  if (!files.length) {
    setStatus("Drop ignored: only .fbx/.glb/.gltf are supported.");
    return;
  }
  if (!mainModel) {
    const [first, ...rest] = files;
    setLoading(true, "⏳ Loading character...");
    try {
      const loaded = await loadObjectFromFile(first);
      const { object3D, clips } = normalizeLoaded(loaded, extOf(first.name));
      setCharacter(object3D, clips, first.name);
    } catch (err) {
      console.error(err);
      setStatus(`Failed to load character: ${describeError(err)}`);
    } finally {
      setLoading(false);
    }
    await addAnimationFiles(rest);
  } else {
    await addAnimationFiles(files);
  }
});

// ---------- Save / load project (name + settings preset) ----------
$("saveProjBtn").addEventListener("click", () => {
  if (!animations.length) {
    setStatus("No clips to save yet.");
    return;
  }
  const data = {
    app: "anicomber",
    v: 1,
    charFile: charFileName,
    savedAt: new Date().toISOString(),
    clips: animations.map((c) => ({ name: c.name, s: clipSettings.get(c.uuid), sel: selectedForExport.has(c.uuid) })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `anicomber-project-${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setStatus(`✔ Project saved (${data.clips.length} clips). Reload this file after re-uploading the model + animations to restore names & settings.`);
});
$("loadProjBtn").addEventListener("click", () => $("loadProjInput").click());
$("loadProjInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "anicomber" && data.app !== "anim-combiner") throw new Error("not an AniComber project file");
    pendingPreset = new Map(data.clips.map((c) => [c.name, { ...c.s, sel: c.sel }]));
    let matched = 0;
    animations.forEach((c) => {
      const p = pendingPreset.get(c.name);
      if (p) {
        clipSettings.set(c.uuid, { trimStart: p.trimStart ?? 0, trimEnd: Math.min(p.trimEnd ?? c.duration, c.duration), speed: p.speed ?? 1, loop: p.loop ?? true });
        if (p.sel === false) selectedForExport.delete(c.uuid);
        else selectedForExport.add(c.uuid);
        matched++;
      }
    });
    renderAnimList();
    renderSettingsPanel();
    setStatus(`✔ Preset loaded: matched ${matched}/${data.clips.length} clips (by name). Upload the missing animation files so the rest is applied too.`);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load project: ${describeError(err)}`);
  } finally {
    e.target.value = "";
  }
});

// ---------- Export ----------
function bakeClip(clip, s) {
  let c = clip;
  const t0 = s.trimStart, t1 = s.trimEnd;
  if (t0 > 0.001 || t1 < clip.duration - 0.001) {
    const f0 = Math.max(0, Math.round(t0 * FPS));
    const f1 = Math.max(f0 + 1, Math.round(t1 * FPS));
    c = THREE.AnimationUtils.subclip(clip, clip.name, f0, f1, FPS);
  }
  if (Math.abs(s.speed - 1) > 0.001) {
    c = c.clone();
    c.tracks.forEach((tr) => { tr.times = tr.times.map((t) => t / s.speed); });
    c.duration = c.duration / s.speed;
    c.name = clip.name;
  }
  return c;
}

function download(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function doExport(binary) {
  if (!mainModel) {
    setStatus("Upload the main character first before exporting.");
    return;
  }
  const chosen = animations.filter((c) => selectedForExport.has(c.uuid));
  if (!chosen.length) {
    setStatus("Check at least 1 clip (☑) to export.");
    return;
  }
  setLoading(true, "⏳ Exporting...");
  try {
    const exporter = new GLTFExporter();
    const exportClips = chosen.map((c) => bakeClip(c, ensureSettings(c)));
    exporter.parse(
      mainModel,
      (result) => {
        const stamp = Date.now();
        if (binary) download(new Blob([result], { type: "application/octet-stream" }), `anicomber-${stamp}.glb`);
        else download(new Blob([JSON.stringify(result, null, 2)], { type: "text/plain" }), `anicomber-${stamp}.gltf`);
        setLoading(false);
        setStatus(`✔ Exported ${exportClips.length} clips (trim + speed applied): ${exportClips.map((a) => a.name).join(", ")}`);
      },
      (err) => {
        console.error(err);
        setLoading(false);
        setStatus("Export failed. Try removing the texture (re-upload the character) and retry.");
      },
      { binary, animations: exportClips, trs: true }
    );
  } catch (err) {
    console.error(err);
    setLoading(false);
    setStatus("Error during export. Try removing the texture and retry.");
  }
}

$("exportGlbBtn").addEventListener("click", () => doExport(true));
$("exportGltfBtn").addEventListener("click", () => doExport(false));
$("selectAllBtn").addEventListener("click", () => {
  animations.forEach((c) => selectedForExport.add(c.uuid));
  renderAnimList();
});
$("deselectAllBtn").addEventListener("click", () => {
  selectedForExport.clear();
  renderAnimList();
});

$("clearBtn").addEventListener("click", () => {
  if (mainModel) scene.remove(mainModel);
  if (skeletonHelper) { scene.remove(skeletonHelper); skeletonHelper = null; }
  mainModel = null;
  charFileName = "";
  charBones = new Set();
  mixer = null;
  currentAction = null;
  playingUuid = null;
  selectedUuid = null;
  isPaused = false;
  animations = [];
  clipSettings.clear();
  selectedForExport.clear();
  renderAnimList();
  renderSettingsPanel();
  refreshCompatInfo();
  setStatus("Reset. Upload a new character to start.");
});

// ---------- Loop ----------
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  if (mixer && currentAction && !isPaused) {
    mixer.update(delta);
    // Enforce trim bounds (subclip is only used at export time)
    const clip = animations.find((c) => c.uuid === playingUuid);
    if (clip) {
      const s = ensureSettings(clip);
      if (currentAction.time >= s.trimEnd) {
        if (s.loop) currentAction.time = s.trimStart;
        else { currentAction.time = s.trimEnd; togglePause(); }
      }
    }
  }
  // Update timeline
  const clip = animations.find((c) => c.uuid === playingUuid);
  if (clip && currentAction) {
    const s = ensureSettings(clip);
    const dur = effDur(clip, s);
    if (!scrubbing) scrubEl.value = Math.round(((currentAction.time - s.trimStart) / dur) * 1000);
    timeLabelEl.innerText = `${currentAction.time.toFixed(2)} / ${s.trimEnd.toFixed(2)}s`;
  }
  renderer.render(scene, camera);
}
animate();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderAnimList();
