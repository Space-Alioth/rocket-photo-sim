// =====================================================================
// 火箭拍摄模拟器 · 网页版
// 目标发射工位 → 火箭型号（随工位过滤）→ 拍摄参数（含地图选点）→ 模式/设备
// 显示照搬桌面版：取景框(内240) + 框外(200) + 框线 + 投影阴影 + 部件描边
// 明暗：灰(210,212,216) × (0.38 + 0.62·|n·L|)
// =====================================================================

// ---------------- 火箭模型（按工位过滤；dir 为 null = 模型待补）----------------
const ROCKET_MODELS = [
  { id: "CZ-8", dir: null, obj: null, rot: 0 },
  { id: "CZ-8A", dir: "models/CZ-8A/", obj: "cz8a.obj", rot: 90 },
  { id: "CZ-12", dir: "models/CZ-12/", obj: "cz12.obj", rot: 0 },
  { id: "CZ-10B", dir: null, obj: null, rot: 0 },
];
let currentRocket = ROCKET_MODELS[1];

// ---------------- 外观常量 ----------------
const MARGIN_FRAC = 0.05;
const C_INSIDE = [240 / 255, 240 / 255, 240 / 255];
const C_OUTSIDE = [200 / 255, 200 / 255, 200 / 255];
const C_FRAME = [70 / 255, 70 / 255, 70 / 255];
const C_OUTLINE = [45 / 255, 48 / 255, 56 / 255];
const C_GRAY = [210 / 255, 212 / 255, 216 / 255];
const SHADOW_OFFSET = [6, 7];
const LIGHT_DIR = [-0.45, 0.70, 0.55];

const D2R = Math.PI / 180;
const APP_VERSION = "v0.9.0 内测1";
const $ = (id) => document.getElementById(String(id).replace(/^#/, ""));

// ---------------- three.js 基础 ----------------
const canvas = $("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = null;
let camera = new THREE.PerspectiveCamera(30, 1.5, 0.05, 1e6);

const rocketGroup = new THREE.Group();
scene.add(rocketGroup);
let currentModel = null;
let currentHeight = 0;

let pitch = 0.0;
let yaw = 0.0;

// ---------------- 火箭明暗着色器 ----------------
const rocketMat = new THREE.ShaderMaterial({
  uniforms: {
    u_base: { value: new THREE.Vector3(C_GRAY[0], C_GRAY[1], C_GRAY[2]) },
    u_light: { value: new THREE.Vector3(LIGHT_DIR[0], LIGHT_DIR[1], LIGHT_DIR[2]) },
  },
  vertexShader: `
    varying vec3 vN;
    void main() {
      vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 u_base;
    uniform vec3 u_light;
    varying vec3 vN;
    void main() {
      float d = abs(dot(normalize(vN), normalize(u_light)));
      float sh = 0.38 + 0.62 * d;
      gl_FragColor = vec4(u_base * sh, 1.0);
    }
  `,
  side: THREE.FrontSide,
});

// ---------------- 离屏渲染目标 & 全屏四边形 ----------------
let rtW = 1, rtH = 1;
let colorRT = null, idRT = null, blurA = null, blurB = null;
const quadGeo = new THREE.PlaneGeometry(2, 2);
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const VERT_QUAD = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const blurMat = new THREE.ShaderMaterial({
  uniforms: { u_src: { value: null }, u_dir: { value: new THREE.Vector2() } },
  vertexShader: VERT_QUAD,
  fragmentShader: `
    uniform sampler2D u_src;
    uniform vec2 u_dir;
    varying vec2 vUv;
    void main() {
      float s = texture2D(u_src, vUv).a * 0.1370;
      s += (texture2D(u_src, vUv + u_dir * 1.0).a + texture2D(u_src, vUv - u_dir * 1.0).a) * 0.1296;
      s += (texture2D(u_src, vUv + u_dir * 2.0).a + texture2D(u_src, vUv - u_dir * 2.0).a) * 0.1097;
      s += (texture2D(u_src, vUv + u_dir * 3.0).a + texture2D(u_src, vUv - u_dir * 3.0).a) * 0.0831;
      s += (texture2D(u_src, vUv + u_dir * 4.0).a + texture2D(u_src, vUv - u_dir * 4.0).a) * 0.0563;
      s += (texture2D(u_src, vUv + u_dir * 5.0).a + texture2D(u_src, vUv - u_dir * 5.0).a) * 0.0342;
      s += (texture2D(u_src, vUv + u_dir * 6.0).a + texture2D(u_src, vUv - u_dir * 6.0).a) * 0.0185;
      gl_FragColor = vec4(s, s, s, s);
    }
  `,
});
const blurScene = new THREE.Scene();
blurScene.add(new THREE.Mesh(quadGeo, blurMat));

const compMat = new THREE.ShaderMaterial({
  uniforms: {
    u_color: { value: null },
    u_idtex: { value: null },
    u_shadow: { value: null },
    u_texel: { value: new THREE.Vector2() },
    u_shadowoff: { value: new THREE.Vector2() },
    u_canvas: { value: new THREE.Vector2(1.5, 1.0) },
    u_fhalf: { value: new THREE.Vector2(0.75, 0.5) },
    u_frameAngle: { value: 0 },
    u_border: { value: 0.01 },
    u_inside: { value: new THREE.Vector3(...C_INSIDE) },
    u_outside: { value: new THREE.Vector3(...C_OUTSIDE) },
    u_frame: { value: new THREE.Vector3(...C_FRAME) },
    u_outline: { value: new THREE.Vector3(...C_OUTLINE) },
  },
  vertexShader: VERT_QUAD,
  fragmentShader: `
    uniform sampler2D u_color;
    uniform sampler2D u_idtex;
    uniform sampler2D u_shadow;
    uniform vec2 u_texel;
    uniform vec2 u_shadowoff;
    uniform vec2 u_canvas;     // 画布尺寸（单位：frameH=1 基准）＝(cw, ch)
    uniform vec2 u_fhalf;      // 取景框半宽/半高（同单位）
    uniform float u_frameAngle; // 取景框倾斜角（弧度）
    uniform float u_border;    // 框线半宽（同单位，约 2px）
    uniform vec3 u_inside;
    uniform vec3 u_outside;
    uniform vec3 u_frame;
    uniform vec3 u_outline;
    varying vec2 vUv;
    void main() {
      // 画布坐标（与取景框同一单位），再绕中心反旋，得到取景框坐标
      vec2 p = (vUv - 0.5) * u_canvas;
      float ca = cos(-u_frameAngle), sa = sin(-u_frameAngle);
      vec2 q = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
      float inside = step(abs(q.x), u_fhalf.x) * step(abs(q.y), u_fhalf.y);
      vec3 base = mix(u_outside, u_inside, inside);

      float sh = texture2D(u_shadow, vUv - u_shadowoff).r;
      base *= (1.0 - 0.28 * sh);

      vec4 c = texture2D(u_color, vUv);
      vec3 col = mix(base, c.rgb, c.a);

      vec3 idc = texture2D(u_idtex, vUv).rgb;
      vec3 a = texture2D(u_idtex, vUv + vec2(u_texel.x, 0.0)).rgb;
      vec3 b = texture2D(u_idtex, vUv - vec2(u_texel.x, 0.0)).rgb;
      vec3 d = texture2D(u_idtex, vUv + vec2(0.0, u_texel.y)).rgb;
      vec3 e = texture2D(u_idtex, vUv - vec2(0.0, u_texel.y)).rgb;
      float edge = 0.0;
      if (distance(idc, a) > 0.008 || distance(idc, b) > 0.008 ||
          distance(idc, d) > 0.008 || distance(idc, e) > 0.008) edge = 1.0;
      col = mix(col, u_outline, edge * 0.9);

      float onB = 0.0;
      if (abs(abs(q.x) - u_fhalf.x) < u_border || abs(abs(q.y) - u_fhalf.y) < u_border) onB = 1.0;
      col = mix(col, u_frame, onB);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const compScene = new THREE.Scene();
compScene.add(new THREE.Mesh(quadGeo, compMat));

// ---------------- 部件分组 ----------------
let idMeshes = [];
function partColor(i) {
  const r = ((i * 67 + 80) % 255) / 255;
  const g = ((i * 131 + 50) % 255) / 255;
  const b = ((i * 197 + 20) % 255) / 255;
  return new THREE.Color(r, g, b);
}
function setupParts(obj) {
  idMeshes = [];
  const bodyColor = partColor(0);
  let bi = 1;
  const children = obj.children.length ? obj.children : [obj];
  for (const child of children) {
    const box = new THREE.Box3().setFromObject(child);
    const ctr = box.getCenter(new THREE.Vector3());
    const radius = Math.hypot(ctr.x, ctr.z);
    const col = (radius < 0.8) ? bodyColor : partColor(bi++);
    child.traverse((o) => {
      if (o.isMesh) {
        o.material = rocketMat;
        idMeshes.push({ mesh: o, idMat: new THREE.MeshBasicMaterial({ color: col }) });
      }
    });
  }
}

// ---------------- 加载/清空火箭模型 ----------------
function clearRocket() {
  while (rocketGroup.children.length) rocketGroup.remove(rocketGroup.children[0]);
  currentModel = null;
  currentHeight = 0;
  idMeshes = [];
}
function loadModel(entry) {
  $("#status").textContent = "正在加载模型：" + entry.id + " …";
  clearRocket();
  const objLoader = new THREE.OBJLoader();
  objLoader.setPath(entry.dir);
  objLoader.load(entry.obj, (obj) => {
    const box = new THREE.Box3().setFromObject(obj);
    const c = box.getCenter(new THREE.Vector3());
    const minY = box.min.y;
    obj.position.set(-c.x, -minY, -c.z);
    rocketGroup.add(obj);
    currentModel = obj;
    currentHeight = box.max.y - box.min.y;
    setupParts(obj);
    $("#status").textContent = "已加载：" + entry.id + "（高 " + currentHeight.toFixed(1) + " m）";
    render();
  }, undefined, (err) => { $("#status").textContent = "模型加载失败：" + err; });
}
function loadRocket(id) {
  const e = ROCKET_MODELS.find((x) => x.id === id) || ROCKET_MODELS[0];
  currentRocket = e;
  if (e.dir) { loadModel(e); }
  else { clearRocket(); render(); $("#status").textContent = e.id + " 模型待补（暂无模型文件）"; }
}

// ---------------- 数据 ----------------
let DATA = { cameras: [], lenses: [], phones: [] };
let SITES = [];
let mode = "camera";

function loadData() {
  return Promise.all([
    fetch("data/cameras.json").then((r) => r.json()),
    fetch("data/lenses.json").then((r) => r.json()),
    fetch("data/phones.json").then((r) => r.json()),
    fetch("data/sites.json").then((r) => r.json()),
    fetch("data/notes.json").then((r) => r.json()).catch(() => ({})),
  ]).then(([c, l, p, s, notes]) => {
    DATA.cameras = c; DATA.lenses = l; DATA.phones = p; SITES = s;
    Object.assign(NOTES, notes || {});
  });
}

const bodyList = () => DATA.cameras.filter((c) => c.cat === "相机");
const otherList = () => DATA.cameras.filter((c) => c.cat === "其他");
function groupByBrand(items) {
  const m = {};
  for (const it of items) (m[it.brand] = m[it.brand] || []).push(it);
  return m;
}
const currentSite = () => SITES[$("site").selectedIndex] || SITES[0];
const MOUNT_SHORT = { "Sony E": "E", "Canon RF": "RF", "Nikon Z": "Z", "Nikon F": "F", "Fujifilm G": "GF", "Hasselblad X": "XCD" };
function shortMount(m) { return MOUNT_SHORT[m] || m || ""; }
function lensLabel(l) {
  const firstParty = ["索尼", "佳能", "尼康", "富士", "哈苏"];
  const need = !firstParty.includes(l.brand) || (l.brand === "尼康" && l.mount !== "Nikon Z");
  return l.model + (need ? "（" + shortMount(l.mount) + "）" : "");
}
function cmpLens(a, b) {
  return (b.focalMax - a.focalMax) || (b.focalMin - a.focalMin) || a.model.localeCompare(b.model, "zh");
}
function sortedLensesForBrand(brand) {
  return DATA.lenses.filter((x) => x.brand === brand).sort(cmpLens);
}
function getBody() {
  const list = bodyList().filter((x) => x.brand === $("camBrand").value);
  return list[$("camModel").selectedIndex] || list[0] || null;
}
function getLens() {
  const b = $("lensBrand").value;
  if (!b) return null;
  const idx = $("lensModel").selectedIndex;
  if (idx <= 0) return null;
  return sortedLensesForBrand(b)[idx - 1] || null;
}
function getPhone() {
  const list = DATA.phones.filter((x) => x.brand === $("phoneBrand").value);
  return list[$("phoneModel").selectedIndex] || list[0] || null;
}
function getOther() {
  const list = otherList().filter((x) => x.brand === $("otherBrand").value);
  return list[$("otherModel").selectedIndex] || list[0] || null;
}

// ---------------- 传感器 / 焦距 ----------------
function sensorSpec() {
  if (mode === "camera") {
    const b = getBody();
    return { w: b.sensorW, h: b.sensorH, fov: b.fov, format: b.format, factor: b.factor || 1, name: b.brand + " " + b.model };
  }
  if (mode === "phone") return { w: 36, h: 24, fov: null, name: getPhone().model };
  const d = getOther();
  return { w: d.sensorW, h: d.sensorH, fov: d.fov, name: d.brand + " " + d.model };
}
function getZoom() {
  const v = parseFloat($("zoomNum").value);
  return isNaN(v) ? 1 : v;
}
function nativeFocal() {
  if (mode === "camera") {
    const L = getLens();
    if (L && L.focalMin !== L.focalMax) {           // 变焦：取滑块值
      const v = parseFloat($("focalSlider").value);
      return isNaN(v) ? L.focalMin : v;
    }
    return parseFloat($("focal").value) || 200;      // 定焦/手动：取输入框
  }
  if (mode === "phone") return getPhone().mainEquiv * getZoom();
  return 0;
}
function tcFactor() {
  const el = $("#tc");
  if (!el) return 1;
  const v = parseFloat(el.value);
  return isFinite(v) && v > 0 ? v : 1;
}
function focalSpec() {
  if (mode === "camera") return nativeFocal() * tcFactor();
  return nativeFocal();
}

// 按所选镜头类型切换焦距控件：定焦=禁用输入框；变焦=滑块；手动=可编辑输入框
function updateFocalUI() {
  const fIn = $("focal"), fSl = $("focalSlider");
  if (!fIn || !fSl) return;
  const L = (mode === "camera") ? getLens() : null;
  if (L && L.focalMin !== L.focalMax) {              // 变焦 → 滑块（无手动输入框）
    fIn.style.display = "none";
    fSl.style.display = "block";
    fSl.min = L.focalMin; fSl.max = L.focalMax; fSl.step = 1;
    let v = parseFloat(fSl.value);
    if (isNaN(v) || v < L.focalMin || v > L.focalMax) v = L.focalMin;
    fSl.value = v;
  } else if (L && L.focalMin === L.focalMax) {       // 定焦 → 输入框禁用
    fSl.style.display = "none";
    fIn.style.display = "block";
    fIn.disabled = true;
    fIn.value = L.focalMin;
  } else {                                            // 手动焦距 → 可编辑
    fSl.style.display = "none";
    fIn.style.display = "block";
    fIn.disabled = false;
  }
  updateFocalReadout();
}

// 焦距行右侧的实时数值
function updateFocalReadout() {
  const el = $("#focalReadout");
  if (!el) return;
  if (mode !== "camera") { el.textContent = ""; return; }
  const n = nativeFocal();
  const S = sensorSpec();
  const total = n * tcFactor() * (S.factor || 1);
  const r = (x) => Math.round(x * 10) / 10;
  el.textContent = r(n) + "mm/等效" + r(total) + "mm";
}

// 构图：画框方向（是否竖构图）与画面滚转
function compState() {
  const el = $("rollDeg");
  const angle = el ? (parseFloat(el.value) || 0) : 0;
  const checked = document.querySelector('input[name="compmode"]:checked');
  const content = checked && checked.value === "content";
  const basePortrait = (mode === "phone");        // 手机默认竖构图；相机默认横构图
  if (content) return { portrait: basePortrait, roll: angle, frameAngle: 0 };   // 画面转：内容滚转
  const near90 = Math.round(angle / 90) * 90;
  if (Math.abs(angle - near90) < 1e-6) {           // 画框转：90° 整数倍 → 交换片幅（FOV 准确）
    const odd = (Math.abs(Math.round(angle / 90)) % 2) === 1;
    const portrait = basePortrait ? !odd : odd;
    return { portrait, roll: 0, frameAngle: 0 };
  }
  return { portrait: basePortrait, roll: 0, frameAngle: angle };  // 画框转：其它角度 → 斜框
}

// 取景框几何（相机=基准横、手机=基准竖；可倾斜）：返回画布长宽比、框半尺寸等
function frameGeom() {
  const S = sensorSpec();
  const cs = compState();
  const effW = cs.portrait ? S.h : S.w;
  const effH = cs.portrait ? S.w : S.h;
  const frameW = effW / effH, frameH = 1;          // 框宽高比（frameH=1 为基准单位）
  const a = (cs.frameAngle || 0) * D2R;
  const ca = Math.abs(Math.cos(a)), sa = Math.abs(Math.sin(a));
  const bw = frameW * ca + frameH * sa;            // 旋转后外接矩形
  const bh = frameW * sa + frameH * ca;
  const cw = bw + 2 * MARGIN_FRAC * frameW;        // 外接矩形 + 四周外边距
  const ch = bh + 2 * MARGIN_FRAC * frameH;
  return { S, cs, effW, effH, frameW, frameH, cw, ch, aspect: cw / ch };
}

// ---------------- 姿态 / 相机 ----------------
function applyTransform() {
  const h = parseFloat($("height").value) || 0;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -currentRocket.rot * D2R);
  rocketGroup.quaternion.copy(q);
  rocketGroup.position.set(0, h, 0);
}
function updateCamera() {
  const g = frameGeom();
  const S = g.S, cs = g.cs;
  const dist = parseFloat($("distance").value) || 450;
  const azDeg = parseFloat($("azimuth").value) || 0;
  const h = parseFloat($("height").value) || 0;

  // 画布竖向 FOV：框高 1 单位 = 片幅高；画布高 ch 单位 → 按比例放大（含倾斜外接框/边距）
  let fovCanvas;
  if (S.fov) fovCanvas = 2 * Math.atan(g.ch * Math.tan(S.fov * D2R / 2)) / D2R;
  else fovCanvas = 2 * Math.atan((g.ch * g.effH) / (2 * focalSpec())) / D2R;

  camera.fov = fovCanvas;
  camera.aspect = g.aspect;
  // 动态近/远平面：紧贴"火箭附近"，把深度范围压到最小，避免远距离 z-fighting（模型破碎）
  const centerDist = Math.sqrt(dist * dist + (h + currentHeight / 2) * (h + currentHeight / 2));
  const depthMargin = currentHeight + 50;
  camera.near = Math.max(0.5, centerDist - depthMargin);
  camera.far = centerDist + depthMargin;
  camera.updateProjectionMatrix();

  const az = azDeg * D2R;
  // 方位角：0=正北、顺时针（与地图/罗盘一致）；北=-Z、东=+X
  const pos = new THREE.Vector3(dist * Math.sin(az), 0, -dist * Math.cos(az));
  const target = new THREE.Vector3(0, h + currentHeight / 2, 0);

  let fwd = target.clone().sub(pos).normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  let right = new THREE.Vector3().crossVectors(fwd, worldUp);
  if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
  right.normalize();
  let up = new THREE.Vector3().crossVectors(right, fwd);
  if (yaw) { fwd.applyAxisAngle(worldUp, yaw * D2R); right.applyAxisAngle(worldUp, yaw * D2R); }
  if (pitch) { fwd.applyAxisAngle(right, pitch * D2R); up.applyAxisAngle(right, pitch * D2R); }
  if (cs.roll) { right.applyAxisAngle(fwd, cs.roll * D2R); up.applyAxisAngle(fwd, cs.roll * D2R); }  // 画面转：绕光轴滚转
  up = new THREE.Vector3().crossVectors(right, fwd);

  camera.position.copy(pos);
  const m = new THREE.Matrix4().makeBasis(right, up, fwd.clone().negate());
  camera.quaternion.setFromRotationMatrix(m);
}

// ---------------- 搭配校验 ----------------
const FMT_ORDER = { "半画幅": 1, "全画幅": 2, "中画幅": 3 };
const shortFmt = (f) => (f || "").slice(0, 1) + "幅";
function computeWarnings() {
  const list = [];
  if (mode === "camera") {
    const b = getBody();
    const L = getLens();
    if (b && L) {
      if (L.mount !== b.mount) {
        list.push({
          title: "你使用 " + b.brand + " " + b.model + " 相机搭配 " + L.brand + " " + L.model + " 镜头的组合",
          text: "不要忘记搭配转接环使用哦！搭配转接环可能会造成无法自动对焦、测光等情况，请谨慎使用。",
        });
      }
      const bo = FMT_ORDER[b.format], lo = FMT_ORDER[L.format];
      const comboTitle = "你使用了 " + b.brand + " " + b.model + "（" + b.format + "）相机搭配 "
        + L.brand + " " + L.model + "（" + L.format + "镜头）的组合";
      if (lo < bo) {
        list.push({ title: comboTitle, text: shortFmt(b.format) + "相机用" + shortFmt(L.format) + "镜头？很有想法啊。这样做会有暗角，建议使用裁切模式。/doge" });
      } else if (lo > bo && (b.factor || 1) > 1.05) {
        list.push({ title: comboTitle, text: shortFmt(b.format) + "相机使用了" + shortFmt(L.format) + "镜头，等效焦距会有 " + (b.factor).toFixed(1) + " 的系数哦，我已经帮你算进去了~" });
      }
    }
  } else if (mode === "phone") {
    const p = getPhone();
    if (p && getZoom() > p.maxOptical + 1e-6) {
      list.push({ title: null, text: "超过 " + p.maxOptical + " 倍就要变成数码变焦了，画质会降低哦！" });
    }
  }
  return list;
}
function updateWarnings() {
  const box = $("#warn");
  const list = computeWarnings();
  if (!list.length) { box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "block";
  box.innerHTML = list.map((w) =>
    '<div class="wnote">' + (w.title ? '<div class="wtitle">' + w.title + '</div>' : "")
    + '<div class="wtxt">' + w.text + "</div>"
    + "</div>").join("");
}

// ---------------- 信息面板（两列）----------------
function updateInfo() {
  const S = sensorSpec();
  const rows = [];
  if (mode === "camera") {
    const L = getLens();
    rows.push(["机身", S.name]);
    rows.push(["镜头", L ? L.model : "（手动焦距）"]);
    rows.push(["画幅", S.format + "（系数 " + (S.factor || 1).toFixed(1) + "）"]);
    const n = nativeFocal();
    const total = n * tcFactor() * (S.factor || 1);
    const rf = (x) => Math.round(x * 10) / 10;
    rows.push(["焦距", rf(n) + "mm/等效" + rf(total) + "mm"]);
    if (tcFactor() > 1) rows.push(["增倍镜", tcFactor() + "×"]);
    rows.push(["传感器", S.w.toFixed(1) + "×" + S.h.toFixed(1) + " mm"]);
  } else if (mode === "phone") {
    const p = getPhone();
    rows.push(["型号", S.name]);
    rows.push(["放大倍率", getZoom().toFixed(1) + "×"]);
    rows.push(["等效焦距", focalSpec().toFixed(1) + " mm"]);
    rows.push(["最大光学", p.maxOptical + "×"]);
  } else {
    rows.push(["设备", S.name]);
    rows.push(["传感器", S.w.toFixed(2) + "×" + S.h.toFixed(2) + " mm"]);
    if (S.fov) rows.push(["视场角", S.fov + "°（竖向）"]);
  }
  rows.push(["距离", (parseFloat($("distance").value) || 0) + " m"]);
  rows.push(["方位角", (parseFloat($("azimuth").value) || 0) + "°"]);
  rows.push(["相对高度", (parseFloat($("height").value) || 0) + " m"]);
  $("#info").innerHTML = rows.map((r) =>
    '<div class="pir"><span class="ik">' + r[0] + '</span><span class="iv" title="' + r[1] + '">' + r[1] + "</span></div>").join("");
}

// ---------------- 尺寸 & 渲染目标 ----------------
// 带 24 位深度贴图的渲染目标（治远距离 z-fighting：默认 16 位深度精度不够）
function makeDeepRT(w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h);
  const dt = new THREE.DepthTexture(w, h);
  dt.format = THREE.DepthFormat;
  dt.type = THREE.UnsignedIntType;   // 24 位
  rt.depthTexture = dt;
  return rt;
}

function makeRTs(w, h) {
  rtW = w; rtH = h;
  for (const rt of [colorRT, idRT, blurA, blurB]) if (rt) rt.dispose();
  colorRT = makeDeepRT(w, h);        // 出图（需要深度）
  idRT = makeDeepRT(w, h);           // 部件ID（需要深度）
  blurA = new THREE.WebGLRenderTarget(w, h);
  blurB = new THREE.WebGLRenderTarget(w, h);
  compMat.uniforms.u_texel.value.set(1 / w, 1 / h);
  compMat.uniforms.u_shadowoff.value.set(SHADOW_OFFSET[0] / w, -SHADOW_OFFSET[1] / h);
}
function resize() {
  const wrap = $("#viewwrap");
  const aw = wrap.clientWidth, ah = wrap.clientHeight;
  const g = frameGeom();
  const aspect = g.aspect;
  let w = aw, h = aw / aspect;
  if (h > ah) { h = ah; w = ah * aspect; }
  renderer.setSize(w, h, false);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  canvas.style.margin = ((ah - h) / 2) + "px " + ((aw - w) / 2) + "px";
  const dbs = new THREE.Vector2();
  renderer.getDrawingBufferSize(dbs);
  makeRTs(Math.max(1, Math.floor(dbs.x)), Math.max(1, Math.floor(dbs.y)));
  // 取景框几何 → 合成着色器
  compMat.uniforms.u_canvas.value.set(g.cw, g.ch);
  compMat.uniforms.u_fhalf.value.set(g.frameW / 2, g.frameH / 2);
  compMat.uniforms.u_frameAngle.value = (g.cs.frameAngle || 0) * D2R;
  compMat.uniforms.u_border.value = 2.0 * Math.max(g.cw / rtW, g.ch / rtH);
}

// ---------------- 渲染流水线 ----------------
function render() {
  applyTransform();
  updateCamera();
  if (!colorRT) { renderer.render(scene, camera); return; }

  renderer.setRenderTarget(colorRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, camera);

  blurMat.uniforms.u_src.value = colorRT.texture;
  blurMat.uniforms.u_dir.value.set(1 / rtW, 0);
  renderer.setRenderTarget(blurA);
  renderer.clear();
  renderer.render(blurScene, quadCam);
  blurMat.uniforms.u_src.value = blurA.texture;
  blurMat.uniforms.u_dir.value.set(0, 1 / rtH);
  renderer.setRenderTarget(blurB);
  renderer.clear();
  renderer.render(blurScene, quadCam);

  renderer.setRenderTarget(idRT);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  for (const m of idMeshes) m.mesh.material = m.idMat;
  renderer.render(scene, camera);
  for (const m of idMeshes) m.mesh.material = rocketMat;

  compMat.uniforms.u_color.value = colorRT.texture;
  compMat.uniforms.u_idtex.value = idRT.texture;
  compMat.uniforms.u_shadow.value = blurB.texture;
  renderer.setRenderTarget(null);
  renderer.render(compScene, quadCam);
}

// ---------------- 导出（叠印信息）----------------
const DISCLAIMER = [
  "本工具导出的效果图为“理想状态下的预估”，仅考虑上述参数。实际效果还会受遮挡、烟雾、天气、光照、设备等众多因素影响。",
  "不同相机/手机的传感器尺寸、裁切模式（含视频裁切）和镜头像场不同，实际画面范围可能与模拟结果存在差异。",
  "本工具为个人非商业项目，与航天机构、火箭研制单位及相机/手机/镜头厂商无隶属或合作关系；相关名称、商标仅用于识别，归各自权利人所有。",
  "本工具中的火箭外形模型作者为 @赛博航天基地，版权归 @赛博航天基地 所有；火箭外形仅使用公开资料，不含内部结构或性能参数。",
  "相机、镜头、手机的品牌、型号和参数来自公开资料整理，可能存在误差，不构成购买建议。",
  "本工具及导出图片仅供非商业性学习与交流使用，禁止任何商业用途；使用者应对导出图片的使用自行负责。",
  "导出图片包含拍摄经纬度，公开分享前请自行评估位置隐私。",
  "本工具仅用于拍摄构图预演，不构成官方、工程或拍摄安全建议；请遵守发射场、空域及当地法律法规，勿进入警戒区或干扰发射。",
  "本工具按现状提供，不提供任何明示或暗示的保证；使用风险由使用者自行承担。",
  "本图片由 @北斗_玉衡 和大肥鱼合作编写的「火箭摄影效果模拟工具」生成。",
  "如有疑问，可联系作者。",
  "使用本程序即表示已理解并认同以上条款。",
];
function _fmtSigned(v) { v = parseFloat(v) || 0; return (v >= 0 ? "+" : "") + v.toFixed(1); }
function _dms(v) {
  const neg = v < 0; v = Math.abs(v);
  const d = Math.floor(v);
  const mf = (v - d) * 60, m = Math.floor(mf), s = (mf - m) * 60;
  return d + "°" + m + "′" + s.toFixed(1) + "″";
}
function _coordDMS() {
  if (!shotLL) return "—";
  return "北纬 " + _dms(shotLL.lat) + "　东经 " + _dms(shotLL.lng);
}
function _timestamp() {
  const d = new Date(), p = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " "
    + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function exportInfoLines() {
  const s = currentSite();
  const S = sensorSpec();
  const lines = [];
  lines.push("目标工位：" + (s ? s.name : ""));
  lines.push("火箭型号：" + currentRocket.id);
  if (mode === "camera") {
    const L = getLens();
    const n = nativeFocal();
    const total = n * tcFactor() * (S.factor || 1);
    const rf = (x) => Math.round(x * 10) / 10;
    lines.push("机身：" + S.name);
    lines.push("镜头：" + (L ? L.model : "（手动焦距）"));
    if (tcFactor() > 1) lines.push("增倍镜：" + tcFactor() + "×");
    lines.push("焦距：" + rf(n) + "mm/等效" + rf(total) + "mm");
  } else if (mode === "phone") {
    lines.push("机型：" + S.name);
    lines.push("放大倍率：" + getZoom().toFixed(1) + "×");
    lines.push("等效焦距：" + focalSpec().toFixed(1) + " mm");
  } else {
    lines.push("设备：" + S.name);
    lines.push("视场角：" + (S.fov || "") + "°");
  }
  lines.push("距离：" + (parseFloat($("distance").value) || 0) + " m　方位角："
    + (parseFloat($("azimuth").value) || 0) + "°　相对高度：" + (parseFloat($("height").value) || 0) + " m");
  lines.push("拍摄经纬度：" + _coordDMS());
  lines.push("俯仰：" + _fmtSigned(pitch) + "°　偏转：" + _fmtSigned(yaw)
    + "°　旋转：" + _fmtSigned($("rollDeg").value) + "°");
  lines.push("导出时间：" + _timestamp());
  return lines;
}
function _wrap(ctx, text, maxW) {
  const out = []; let cur = "";
  for (const ch of text) {
    const t = cur + ch;
    if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = ch; } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
}
function exportFont(W) {
  return Math.max(9, Math.round(W * 0.0105));
}
function drawParamOverlay(ctx, W, H) {
  const marginX = Math.round(W * 0.055);
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#1a1a1a";
  const fs = exportFont(W);
  ctx.font = fs + "px 'Microsoft YaHei', system-ui, sans-serif";
  let y = Math.round(H * 0.06);
  for (const ln of exportInfoLines()) { ctx.fillText(ln, marginX, y); y += Math.round(fs * 1.6); }
  ctx.restore();
}
function disclaimerLayout(W) {
  const marginX = Math.round(W * 0.055);
  const maxW = W - marginX * 2;
  const dfs = exportFont(W);
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = dfs + "px 'Microsoft YaHei', system-ui, sans-serif";
  const lines = [];
  for (const p of DISCLAIMER) for (const l of _wrap(measure, p, maxW)) lines.push(l);
  const dlh = Math.round(dfs * 1.45);
  return { marginX, maxW, dfs, dlh, lines };
}
function drawDisclaimerOverlay(ctx, W, H) {
  const lay = disclaimerLayout(W);
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#1a1a1a";
  ctx.font = lay.dfs + "px 'Microsoft YaHei', system-ui, sans-serif";
  let y = H - Math.round(H * 0.05) - lay.lines.length * lay.dlh;
  for (const l of lay.lines) { ctx.fillText(l, lay.marginX, y); y += lay.dlh; }
  ctx.restore();
}
function drawTopRightCredit(ctx, W, H) {
  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#1a1a1a";
  const fs = exportFont(W);
  ctx.font = fs + "px 'Microsoft YaHei', system-ui, sans-serif";
  ctx.fillText("本图由 火箭摄影效果模拟工具 " + APP_VERSION + " 生成",
    W - Math.round(W * 0.055), Math.round(H * 0.06));
  ctx.restore();
}
function buildExportCanvas() {
  render();
  const W = canvas.width, H = canvas.height;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.drawImage(canvas, 0, 0);
  drawParamOverlay(ctx, W, H);
  drawDisclaimerOverlay(ctx, W, H);
  drawTopRightCredit(ctx, W, H);
  return cv;
}
function exportPng() {
  const cv = buildExportCanvas();
  const a = document.createElement("a");
  a.download = "火箭拍摄_" + Date.now() + ".png";
  a.href = cv.toDataURL("image/png");
  a.click();
}

// ---------------- 微调 ----------------
function stepValue() {
  const v = parseFloat($("step").value);
  return isNaN(v) ? 0.2 : v;
}
function nudge(which, delta) {
  if (which === "p") pitch += delta; else yaw += delta;
  updateOffsetLabel(); render();
}
function resetOffsets() { pitch = 0; yaw = 0; updateOffsetLabel(); render(); }
function updateOffsetLabel() {
  const el = $("#offsetLabel");
  if (!el) return;
  el.textContent = "俯仰 " + (pitch >= 0 ? "+" : "") + pitch.toFixed(1)
    + "° / 偏转 " + (yaw >= 0 ? "+" : "") + yaw.toFixed(1) + "°";
}

function refreshAll() { updateWarnings(); updateInfo(); updateFocalReadout(); render(); }

// ---------------- 模式切换 ----------------
function setMode(m) {
  mode = m;
  $("#modeCamera").classList.toggle("active", m === "camera");
  $("#modePhone").classList.toggle("active", m === "phone");
  $("#modeOther").classList.toggle("active", m === "other");
  $("#grpCamera").style.display = (m === "camera") ? "block" : "none";
  $("#grpPhone").style.display = (m === "phone") ? "block" : "none";
  $("#grpOther").style.display = (m === "other") ? "block" : "none";
  updateFocalUI();
  resize();
  refreshAll();
  updatePhoneStops();
}

// ---------------- 坐标转换（高德 GCJ-02 / 百度 BD-09 / 标准 WGS84）----------------
// 现有 sites.json 的坐标来自高德，是 GCJ-02；内部统一转成 WGS84 算距离/方位，
// 显示到百度地图时再转 BD-09。千万别拿两种坐标直接混算。
const X_PI = Math.PI * 3000 / 180;
const COORD_A = 6378245.0;
const COORD_EE = 0.00669342162296594323;

function outOfChina(lat, lng) {
  return (lng < 72.004 || lng > 137.8347) || (lat < 0.8293 || lat > 55.8271);
}
function transformLat(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return ret;
}
function transformLng(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return ret;
}
function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return { lat, lng };
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = lat / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - COORD_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((COORD_A * (1 - COORD_EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180) / (COORD_A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}
function gcj02ToWgs84(lat, lng) {
  if (outOfChina(lat, lng)) return { lat, lng };
  let wLat = lat, wLng = lng;
  for (let i = 0; i < 5; i++) {
    const g = wgs84ToGcj02(wLat, wLng);
    wLat -= g.lat - lat;
    wLng -= g.lng - lng;
  }
  return { lat: wLat, lng: wLng };
}
function gcj02ToBd09(lat, lng) {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
  return { lat: z * Math.sin(theta) + 0.006, lng: z * Math.cos(theta) + 0.0065 };
}
function bd09ToGcj02(lat, lng) {
  const x = lng - 0.0065, y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return { lat: z * Math.sin(theta), lng: z * Math.cos(theta) };
}
function bd09ToWgs84(lat, lng) {
  const g = bd09ToGcj02(lat, lng);
  return gcj02ToWgs84(g.lat, g.lng);
}
function wgs84ToBd09(lat, lng) {
  const g = wgs84ToGcj02(lat, lng);
  return gcj02ToBd09(g.lat, g.lng);
}
function siteWgs(s) { return gcj02ToWgs84(s.lat, s.lon); }
function siteBd(s) { return gcj02ToBd09(s.lat, s.lon); }

// ---------------- 地图选点（百度 JS API GL）----------------
let map = null, siteMarker = null, shotMarker = null;
let shotBD = null;              // 百度地图上的拍摄点（BD-09）
let shotLL = null;              // 标准拍摄点（WGS84），用于导出/距离/方位
let selectedPoiName = "";
let mapLayerType = "sat";
let mapSearchScope = "nearby";
let suggestTimer = null;
let resultMarkers = [];
let currentSearchResults = [];
let lastSearchQuery = "";
let lastSearchPage = 1;
let lastSearchTotal = 0;
const MAP_PAGE_SIZE = 20;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, p = D2R;
  const dLat = (lat2 - lat1) * p, dLon = (lon2 - lon1) * p;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function bearing(lat1, lon1, lat2, lon2) {
  const p = D2R;
  const y = Math.sin((lon2 - lon1) * p) * Math.cos(lat2 * p);
  const x = Math.cos(lat1 * p) * Math.sin(lat2 * p) - Math.sin(lat1 * p) * Math.cos(lat2 * p) * Math.cos((lon2 - lon1) * p);
  return (Math.atan2(y, x) / p + 360) % 360;
}
function bdPoint(lat, lng) { return new BMapGL.Point(lng, lat); }
function dotIcon(color) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
    '<circle cx="10" cy="10" r="7" fill="' + color + '" stroke="#fff" stroke-width="2"></circle></svg>';
  return new BMapGL.Icon("data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    new BMapGL.Size(20, 20), { anchor: new BMapGL.Size(10, 10) });
}
function baiduMapType(type) {
  if (type === "standard") return (typeof BMAP_NORMAL_MAP !== "undefined") ? BMAP_NORMAL_MAP : "B_NORMAL_MAP";
  // 百度 GL 的 BMAP_HYBRID_MAP 实际是 B_STREET_MAP（标准图），不能用；
  // 普通卫星图本身带地名注记，所以“卫星 / 卫星+路网”都走卫星图。
  return (typeof BMAP_SATELLITE_MAP !== "undefined") ? BMAP_SATELLITE_MAP : "B_SATELLITE_MAP";
}
function updateMapLayerButtons(type) {
  document.querySelectorAll(".maplayers button").forEach((b) => b.classList.toggle("on", b.dataset.layer === type));
}
function setBaiduMapType(type) {
  mapLayerType = type;
  if (map) {
    try { map.setMapType(baiduMapType(type)); } catch (e) { console.warn("百度地图图层切换失败", e); }
  }
  updateMapLayerButtons(type);
}
function resizeBaiduMap() {
  if (!map) return;
  try { map.resize(); } catch (e) { try { map.checkResize(); } catch (_) {} }
}
function drawSite() {
  if (!map) return;
  const s = currentSite();
  const b = siteBd(s);
  if (siteMarker) { try { map.removeOverlay(siteMarker); } catch (e) {} siteMarker = null; }
  siteMarker = new BMapGL.Marker(bdPoint(b.lat, b.lng), { icon: dotIcon("#e74c3c") });
  try { siteMarker.setTitle(s.name); } catch (e) {}
  map.addOverlay(siteMarker);
}
function drawShot() {
  if (!map || !shotBD) return;
  if (shotMarker) { try { map.removeOverlay(shotMarker); } catch (e) {} shotMarker = null; }
  shotMarker = new BMapGL.Marker(bdPoint(shotBD.lat, shotBD.lng), { icon: dotIcon("#2d7ff9") });
  try { shotMarker.enableDragging(); } catch (e) {}
  shotMarker.addEventListener("dragend", () => {
    const p = shotMarker.getPosition();
    setShotBD(p.lat, p.lng, "");
  });
  map.addOverlay(shotMarker);
}
function setShotBD(lat, lng, name) {
  shotBD = { lat: lat, lng: lng };
  shotLL = bd09ToWgs84(lat, lng);
  selectedPoiName = name || "";
  drawShot();
  updateMapInfo();
}
function updateMapInfo() {
  const s = currentSite();
  const sw = siteWgs(s);
  if (!shotLL) {
    $("#mapinfo").textContent = "在地图上点一下，或在上方搜索，选择你的拍摄地点";
    return;
  }
  const d = haversine(sw.lat, sw.lng, shotLL.lat, shotLL.lng);
  const az = bearing(sw.lat, sw.lng, shotLL.lat, shotLL.lng);
  const prefix = selectedPoiName ? selectedPoiName + " ／ " : "";
  $("#mapinfo").textContent = prefix + "距工位 " + Math.round(d) + " m ／ 方位角 " + az.toFixed(1) + "°";
}
function createBaiduMap() {
  if (!window.BMapGL) return false;
  const s = currentSite();
  const b = siteBd(s);
  try {
    // 尽量在创建时就指定地图类型，避免“创建后再 setMapType”把后续 setCenter 冻住
    map = new BMapGL.Map("bmap", { mapType: baiduMapType(mapLayerType) });
  } catch (e) {
    $("#mapinfo").textContent = "百度地图初始化失败：" + e;
    return false;
  }
  map.centerAndZoom(bdPoint(b.lat, b.lng), 15);
  map.enableScrollWheelZoom(true);
  map.addEventListener("click", (e) => {
    const p = e.latlng || e.point;
    if (p) { hideMapSuggestions(); setShotBD(p.lat, p.lng, ""); }
  });
  drawSite();
  if (shotBD) drawShot();
  return true;
}
function openMap() {
  $("#mapModal").classList.add("show");
  if (!window.BMapGL) {
    $("#mapinfo").textContent = "地图加载失败：需要联网（百度脚本没加载出来）";
    return;
  }
  // 等弹层完成布局再建地图；否则百度地图可能在 0 尺寸容器里初始化，之后 setCenter/setZoom 会失效
  setTimeout(() => {
    if (!$("#mapModal").classList.contains("show")) return;
    if (!map) {
      if (!createBaiduMap()) return;
    } else {
      const s = currentSite();
      const b = siteBd(s);
      try { map.centerAndZoom(bdPoint(b.lat, b.lng), 15); } catch (e) {}
      drawSite();
      if (shotBD) drawShot();
      updateMapInfo();
    }
    resizeBaiduMap();
    setTimeout(resizeBaiduMap, 200);
  }, 80);
}
function closeMap() {
  $("#mapModal").classList.remove("show");
  hideMapSuggestions();
  clearSearchResults();
}
function openHelp() {
  $("#helpModal").classList.add("show");
}
function closeHelp() {
  $("#helpModal").classList.remove("show");
}
function openAbout() {
  $("#aboutModal").classList.add("show");
}
function closeAbout() {
  $("#aboutModal").classList.remove("show");
}
function openContact() {
  $("#contactModal").classList.add("show");
}
function closeContact() {
  $("#contactModal").classList.remove("show");
}
function openShowcase() {
  $("#showcaseModal").classList.add("show");
}
function closeShowcase() {
  $("#showcaseModal").classList.remove("show");
}

// ---------------- 百度 POI 搜索（静态版：浏览器端 LocalSearch）----------------
function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/[\s\-_/（）()·]+/g, "");
}
function hideMapSuggestions() {
  const box = $("#mapSuggestions");
  if (box) { box.innerHTML = ""; box.classList.remove("open"); }
}
function poiListFromLocal(results) {
  const out = [];
  if (!results || typeof results.getCurrentNumPois !== "function") return out;
  const n = results.getCurrentNumPois();
  for (let i = 0; i < n; i++) {
    const p = results.getPoi(i);
    if (!p || !p.point) continue;
    out.push({
      name: p.title || "",
      address: p.address || "",
      district: p.district || p.city || "",
      tag: Array.isArray(p.tags) ? p.tags.join(" · ") : (p.tags || ""),
      lat: Number(p.point.lat),
      lng: Number(p.point.lng),
    });
  }
  return out;
}
function runLocalSearch(keyword, scope, center, capacity) {
  return new Promise((resolve) => {
    if (!window.BMapGL || !window.BMapGL.LocalSearch || !map) {
      resolve({ items: [], status: "no-map" });
      return;
    }
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let ls = null;
    try {
      ls = new BMapGL.LocalSearch(map, {
        pageCapacity: capacity || 50,
        onSearchComplete: (results) => {
          const status = (ls && typeof ls.getStatus === "function") ? ls.getStatus() : "";
          finish({ items: poiListFromLocal(results), status: status });
        },
      });
      if (scope === "nearby") {
        ls.searchNearby(keyword, center, 50000);
      } else if (scope === "city") {
        ls.setLocation("文昌");
        ls.search(keyword);
      } else {
        // 静态版没有服务端 region/city_limit；不设 location 时 LocalSearch 走全国
        ls.search(keyword);
      }
    } catch (e) {
      finish({ items: [], status: "error", error: String(e) });
    }
    setTimeout(() => finish({ items: [], status: "timeout" }), 9000);
  });
}
async function fetchSuggestions(q) {
  const s = currentSite();
  const b = siteBd(s);
  const r = await runLocalSearch(q, "nearby", bdPoint(b.lat, b.lng), 10);
  return r.items || [];
}
function renderSuggestions(list) {
  const box = $("#mapSuggestions");
  if (!box || !$("#mapModal").classList.contains("show")) return;
  box.innerHTML = "";
  if (!list.length) { box.classList.remove("open"); return; }
  for (const item of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    const name = document.createElement("span");
    name.textContent = item.name || "";
    const sub = document.createElement("span");
    sub.className = "sug-sub";
    sub.textContent = [item.district, item.address].filter(Boolean).join(" · ");
    btn.appendChild(name);
    if (sub.textContent) btn.appendChild(sub);
    btn.onclick = () => {
      hideMapSuggestions();
      selectPoiBD(item);
      clearSearchResults();
    };
    box.appendChild(btn);
  }
  box.classList.add("open");
}
function onMapSearchInput() {
  const input = $("#mapSearchInput");
  const q = input ? (input.value || "").trim() : "";
  clearTimeout(suggestTimer);
  if (q.length < 2) { hideMapSuggestions(); return; }
  suggestTimer = setTimeout(async () => {
    const list = await fetchSuggestions(q);
    const cur = input ? (input.value || "").trim() : "";
    if (cur === q) renderSuggestions(list);
  }, 300);
}
function selectPoiBD(item, center) {
  const lat = Number(item.lat), lng = Number(item.lng);
  if (!isFinite(lat) || !isFinite(lng)) return;
  setShotBD(lat, lng, item.name || "");
  if (center !== false && map) {
    try { map.centerAndZoom(bdPoint(shotBD.lat, shotBD.lng), 16); } catch (e) {}
  }
}
async function fetchOwnSpots(q) {
  // 静态版没有后端，自有点位/审核框架不参与
  return [];
}
async function loadSearchPage(page) {
  const q = lastSearchQuery;
  if (!q) return;
  const s = currentSite();
  const b = siteBd(s);
  $("#mapinfo").textContent = "搜索中…";
  const r = await runLocalSearch(q, mapSearchScope, bdPoint(b.lat, b.lng), 50);
  if (!$("#mapModal").classList.contains("show")) return;
  if (!r || r.status === "no-map") {
    $("#mapinfo").textContent = "地图还没准备好";
    return;
  }
  if (r.status === "timeout") {
    $("#mapinfo").textContent = "搜索超时，请重试或换关键词";
    return;
  }
  if (r.status === "error") {
    $("#mapinfo").textContent = "搜索失败：" + (r.error || "");
    return;
  }
  renderSearchResults({ ok: true, results: r.items || [], total: (r.items || []).length }, [], page);
}
function renderSearchResults(data, own, page) {
  const s = currentSite();
  const sw = siteWgs(s);
  const items = [];
  const seen = new Set();
  for (const o of own || []) {
    const lat = Number(o.lat), lng = Number(o.lng);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const key = normalizeName(o.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const b = wgs84ToBd09(lat, lng);
    items.push({
      name: o.name || "用户点位",
      address: [o.category, o.description].filter(Boolean).join(" · "),
      source: "user",
      latBD: b.lat, lngBD: b.lng,
      latWGS: lat, lngWGS: lng,
      distance: haversine(sw.lat, sw.lng, lat, lng),
    });
  }
  for (const r of data.results || []) {
    const lat = Number(r.lat), lng = Number(r.lng);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const key = normalizeName(r.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const w = bd09ToWgs84(lat, lng);
    items.push({
      name: r.name || "未命名地点",
      address: [r.address, r.tag].filter(Boolean).join(" · "),
      source: "baidu",
      latBD: lat, lngBD: lng,
      latWGS: w.lat, lngWGS: w.lng,
      distance: haversine(sw.lat, sw.lng, w.lat, w.lng),
    });
  }
  items.sort((a, b) => a.distance - b.distance);
  currentSearchResults = items;
  lastSearchPage = page;
  lastSearchTotal = Number(data.total || 0);

  if (map) {
    resultMarkers.forEach((m) => { try { map.removeOverlay(m); } catch (e) {} });
  }
  resultMarkers = [];

  const panel = $("#mapSearchPanel");
  const list = $("#mapSearchList");
  const pageBox = $("#mapSearchPage");
  if (!panel || !list || !pageBox) return;
  list.innerHTML = "";
  pageBox.innerHTML = "";
  panel.classList.add("show");

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "msp-sub";
    empty.style.padding = "12px";
    empty.textContent = "没找到「" + lastSearchQuery + "」。可以切换“文昌”或“全国”再试。";
    list.appendChild(empty);
    $("#mapinfo").textContent = "没找到「" + lastSearchQuery + "」";
    return;
  }

  const start = (page - 1) * MAP_PAGE_SIZE;
  const pageItems = items.slice(start, start + MAP_PAGE_SIZE);
  for (const item of pageItems) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msp-item";
    const name = document.createElement("div");
    name.className = "msp-name";
    name.textContent = item.name;
    const sub = document.createElement("div");
    sub.className = "msp-sub";
    const dist = Math.round(item.distance);
    sub.textContent = (item.address ? item.address + " ／ " : "") +
      "距工位 " + (dist >= 1000 ? (dist / 1000).toFixed(1) + " km" : dist + " m") +
      (item.source === "user" ? " ／ 用户点位" : "");
    btn.appendChild(name);
    btn.appendChild(sub);
    btn.onclick = () => {
      selectPoiBD({ lat: item.latBD, lng: item.lngBD, name: item.name });
    };
    list.appendChild(btn);

    if (map) {
      const marker = new BMapGL.Marker(bdPoint(item.latBD, item.lngBD), {
        icon: dotIcon(item.source === "user" ? "#8e44ad" : "#e67e22"),
      });
      try { marker.setTitle(item.name); } catch (e) {}
      marker.addEventListener("click", () => {
        selectPoiBD({ lat: item.latBD, lng: item.lngBD, name: item.name });
      });
      map.addOverlay(marker);
      resultMarkers.push(marker);
    }
  }

  const totalPages = Math.max(1, Math.ceil(lastSearchTotal / MAP_PAGE_SIZE));
  if (totalPages > 1) {
    const prev = document.createElement("button");
    prev.type = "button";
    prev.textContent = "上一页";
    prev.disabled = page <= 1;
    prev.onclick = () => loadSearchPage(page - 1);
    const info = document.createElement("span");
    info.textContent = "第 " + page + " / " + totalPages + " 页";
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "下一页";
    next.disabled = page >= totalPages;
    next.onclick = () => loadSearchPage(page + 1);
    pageBox.appendChild(prev);
    pageBox.appendChild(info);
    pageBox.appendChild(next);
  }

  const scopeText = mapSearchScope === "nearby" ? "附近 50km" : (mapSearchScope === "city" ? "文昌" : "全国");
  $("#mapinfo").textContent = "找到 " + lastSearchTotal + " 个结果（" + scopeText + "），点列表或地图上的点选择";
}
async function runMapSearch(fromEnter) {
  const q = ($("#mapSearchInput").value || "").trim();
  if (!q) { $("#mapinfo").textContent = "请输入要搜索的地名"; return; }
  hideMapSuggestions();
  lastSearchQuery = q;
  lastSearchPage = 1;
  if (fromEnter && q.length >= 4) {
    const sug = await fetchSuggestions(q);
    if (!$("#mapModal").classList.contains("show")) return;
    const nq = normalizeName(q);
    const candidates = sug.filter((x) => {
      const nn = normalizeName(x.name);
      return nn === nq || nn.startsWith(nq) || nq.startsWith(nn);
    });
    if (candidates.length === 1) {
      selectPoiBD(candidates[0]);
      clearSearchResults();
      return;
    }
  }
  await loadSearchPage(1);
}
function clearSearchResults() {
  if (map) {
    resultMarkers.forEach((m) => { try { map.removeOverlay(m); } catch (e) {} });
  }
  resultMarkers = [];
  currentSearchResults = [];
  lastSearchQuery = "";
  lastSearchTotal = 0;
  lastSearchPage = 1;
  const panel = $("#mapSearchPanel");
  const list = $("#mapSearchList");
  const pageBox = $("#mapSearchPage");
  if (panel) panel.classList.remove("show");
  if (list) list.innerHTML = "";
  if (pageBox) pageBox.innerHTML = "";
}
function setMapScope(scope) {
  mapSearchScope = scope;
  document.querySelectorAll(".mapscopes button").forEach((b) => b.classList.toggle("on", b.dataset.scope === scope));
  if (lastSearchQuery) loadSearchPage(1);
}
function applyMap() {
  if (!shotLL) return;
  const s = currentSite();
  const sw = siteWgs(s);
  $("#distance").value = Math.round(haversine(sw.lat, sw.lng, shotLL.lat, shotLL.lng));
  $("#azimuth").value = bearing(sw.lat, sw.lng, shotLL.lat, shotLL.lng).toFixed(1);
  closeMap();
  refreshAll();
}

// ---------------- 注释气泡（桌面悬浮 / 触屏点按）----------------
const NOTES = {
  secTarget: "",
  secLoc: "",
  secDevice: "",
  secAdjust: "",
  site: "",
  rocket: "",
  camBody: "",
  camLens: "",
  focal: "",
  phoneModel: "",
  zoom: "",
  otherDev: "",
  distance: "单位：米(m)。相机到火箭轴线的水平距离。",
  azimuth: "单位：度(°)。0° = 拍摄位置在发射工位的正北方向。",
  height: "单位：米(m)。可负（相机高于火箭时）；地面=0。",
  map: "选择你拍摄的地点",
  roll: "构图角度（度）。配合右边『画框转/画面转』使用。相机默认横构图（0=横，90=竖）；手机默认竖构图（0=竖，90=横）。",
  compmode: "画框转：旋转取景框方向（90=竖构图），火箭保持竖直。画面转：把画面内容整体旋转该角度。",
};
const hoverCapable = !!(window.matchMedia && window.matchMedia("(hover: hover)").matches);

function showTip(el) {
  const key = el.dataset.note;
  const text = (NOTES[key] && NOTES[key].length) ? NOTES[key] : "（说明待补充）";
  const tip = $("#tip");
  tip.textContent = text;
  tip.style.display = "block";
  const r = el.getBoundingClientRect();
  let left = r.left + r.width / 2 - tip.offsetWidth / 2;
  let top = r.top - tip.offsetHeight - 8;
  if (top < 4) top = r.bottom + 8;
  left = Math.min(Math.max(4, left), window.innerWidth - tip.offsetWidth - 4);
  top = Math.min(Math.max(4, top), window.innerHeight - tip.offsetHeight - 4);
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}
function hideTip() { $("#tip").style.display = "none"; }

function bindTips() {
  document.querySelectorAll(".q[data-note]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!hoverCapable) {
        if ($("#tip").style.display === "block") hideTip(); else showTip(el);
      }
    });
    if (hoverCapable) {
      el.addEventListener("mouseenter", () => showTip(el));
      el.addEventListener("mouseleave", hideTip);
    }
  });
  if (!hoverCapable) {
    document.addEventListener("click", (e) => {
      if (!(e.target && e.target.classList && e.target.classList.contains("q"))) hideTip();
    });
  }
  window.addEventListener("scroll", hideTip, true);
  window.addEventListener("resize", hideTip);
}

// ---------------- 初始化 ----------------
function initBrandModel(brandSel, modelSel, items, onChange) {
  const groups = groupByBrand(items);
  const brands = Object.keys(groups);
  brandSel.innerHTML = "";
  brands.forEach((b) => brandSel.add(new Option(b, b)));
  const rebuild = () => {
    const list = groups[brandSel.value] || groups[brands[0]] || [];
    modelSel.innerHTML = "";
    list.forEach((it) => modelSel.add(new Option(it.model, it.model)));
  };
  brandSel.onchange = () => { rebuild(); onChange(); };
  modelSel.onchange = onChange;
  rebuild();
}
function initLens(onChange) {
  const lb = $("#lensBrand"), lm = $("#lensModel");
  const brands = Array.from(new Set(DATA.lenses.map((l) => l.brand)));
  lb.innerHTML = "";
  lb.add(new Option("（手动焦距，不选镜头）", ""));
  brands.forEach((b) => lb.add(new Option(b, b)));
  const rebuild = () => {
    const manual = (lb.value === "");
    const row = lb.closest(".lensrow");
    if (row) row.classList.toggle("manual", manual);
    lm.style.visibility = manual ? "hidden" : "visible";
    lm.innerHTML = "";
    if (!manual) {
      lm.add(new Option("（请选择镜头）", ""));
      sortedLensesForBrand(lb.value).forEach((l) => lm.add(new Option(lensLabel(l), l.model)));
      lm.selectedIndex = 0;
    }
  };
  lb.onchange = () => { rebuild(); updateFocalUI(); onChange(); };
  lm.onchange = () => { updateFocalUI(); onChange(); };
  rebuild();
  updateFocalUI();
}
function onSelectChange() { resize(); refreshAll(); updatePhoneStops(); }

function updatePhoneStops() {
  const box = $("#phoneStops");
  if (!box) return;
  box.innerHTML = "";
  if (mode !== "phone") return;
  const p = getPhone();
  if (!p || !Array.isArray(p.lenses)) return;
  const stops = p.lenses.slice().sort((a, b) => a.zoom - b.zoom);
  stops.forEach((s) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = (Math.round(s.zoom * 10) / 10) + "×";
    b.title = "等效焦距 " + s.equiv + " mm";
    b.onclick = () => {
      $("#zoom").value = s.zoom;
      $("#zoomNum").value = s.zoom;
      refreshAll();
    };
    box.appendChild(b);
  });
}

function rebuildModelSelect() {
  const s = currentSite();
  const msel = $("#model");
  msel.innerHTML = "";
  for (const id of s.models) {
    const e = ROCKET_MODELS.find((x) => x.id === id);
    if (!e || !e.dir) continue;   // 没模型/已撤下的型号不显示
    msel.add(new Option(id, id));
  }
  let idx = 0;
  for (let i = 0; i < msel.options.length; i++) {
    const e = ROCKET_MODELS.find((x) => x.id === msel.options[i].value);
    if (e && e.dir) { idx = i; break; }
  }
  msel.selectedIndex = idx;
  msel.onchange = () => { loadRocket(msel.value); refreshAll(); };
  loadRocket(msel.value);
}
function buildSelects() {
  const ssel = $("#site");
  ssel.innerHTML = "";
  SITES.forEach((s) => ssel.add(new Option(s.name, s.id)));
  ssel.onchange = () => { rebuildModelSelect(); resize(); refreshAll(); };
  rebuildModelSelect();

  initBrandModel($("#camBrand"), $("#camModel"), bodyList(), onSelectChange);
  initLens(onSelectChange);
  initBrandModel($("#phoneBrand"), $("#phoneModel"), DATA.phones, onSelectChange);
  initBrandModel($("#otherBrand"), $("#otherModel"), otherList(), onSelectChange);
  selectDefaultPhone();
}

function selectDefaultPhone() {
  const brand = "华为";
  const brandSel = $("#phoneBrand"), modelSel = $("#phoneModel");
  if (![...brandSel.options].some((o) => o.value === brand)) return;
  brandSel.value = brand;
  brandSel.dispatchEvent(new Event("change"));
  const list = DATA.phones.filter((p) => p.brand === brand);
  const idx = list.findIndex((p) => /Mate XTs/i.test(p.model));
  if (idx >= 0) modelSel.selectedIndex = idx;
  onSelectChange();
}

function closeAllSearch() {
  document.querySelectorAll(".searchres.open").forEach((el) => el.classList.remove("open"));
}

function setupOneSearch(inputId, resId, getItems, labelFn, pickFn) {
  const input = $(inputId), res = $(resId);
  if (!input || !res) return;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    res.innerHTML = "";
    if (!q) { res.classList.remove("open"); return; }
    const tokens = q.split(/\s+/).filter(Boolean);
    const matches = [];
    for (const it of getItems()) {
      const label = labelFn(it);
      const low = label.toLowerCase();
      if (tokens.every((t) => low.includes(t))) {
        matches.push({ it, label });
        if (matches.length >= 30) break;
      }
    }
    if (!matches.length) {
      const d = document.createElement("div");
      d.className = "nores";
      d.textContent = "没有匹配的型号，换个词试试";
      res.appendChild(d);
    } else {
      for (const m of matches) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = m.label;
        b.onclick = () => {
          pickFn(m.it);
          input.value = "";
          res.classList.remove("open");
        };
        res.appendChild(b);
      }
    }
    res.classList.add("open");
  };
  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { res.classList.remove("open"); input.blur(); }
    else if (e.key === "Enter") {
      const first = res.querySelector("button");
      if (first) { e.preventDefault(); first.click(); }
    }
  });
}

function setupSearch() {
  setupOneSearch("camSearch", "camSearchRes", bodyList,
    (it) => it.brand + " " + it.model,
    (it) => {
      $("#camBrand").value = it.brand;
      $("#camBrand").dispatchEvent(new Event("change"));
      const list = bodyList().filter((x) => x.brand === it.brand);
      const idx = list.findIndex((x) => x === it);
      if (idx >= 0) $("#camModel").selectedIndex = idx;
      onSelectChange();
    });

  setupOneSearch("lensSearch", "lensSearchRes", () => DATA.lenses,
    (it) => it.brand + " " + lensLabel(it),
    (it) => {
      $("#lensBrand").value = it.brand;
      $("#lensBrand").dispatchEvent(new Event("change"));
      const list = sortedLensesForBrand(it.brand);
      const idx = list.findIndex((x) => x === it);
      if (idx >= 0) $("#lensModel").selectedIndex = idx + 1;
      updateFocalUI();
      onSelectChange();
    });

  setupOneSearch("phoneSearch", "phoneSearchRes", () => DATA.phones,
    (it) => it.brand + " " + it.model,
    (it) => {
      $("#phoneBrand").value = it.brand;
      $("#phoneBrand").dispatchEvent(new Event("change"));
      const list = DATA.phones.filter((x) => x.brand === it.brand);
      const idx = list.findIndex((x) => x === it);
      if (idx >= 0) $("#phoneModel").selectedIndex = idx;
      onSelectChange();
    });

  setupOneSearch("otherSearch", "otherSearchRes", otherList,
    (it) => it.brand + " " + it.model,
    (it) => {
      $("#otherBrand").value = it.brand;
      $("#otherBrand").dispatchEvent(new Event("change"));
      const list = otherList().filter((x) => x.brand === it.brand);
      const idx = list.findIndex((x) => x === it);
      if (idx >= 0) $("#otherModel").selectedIndex = idx;
      onSelectChange();
    });

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || !t.closest || !t.closest(".searchwrap")) closeAllSearch();
  });
}

function bindUI() {
  $("#modeCamera").onclick = () => setMode("camera");
  $("#modePhone").onclick = () => setMode("phone");
  $("#modeOther").onclick = () => setMode("other");

  ["focal", "distance", "azimuth", "height"].forEach((id) => $(id).addEventListener("input", refreshAll));
  $("#focalSlider").addEventListener("input", refreshAll);
  $("#tc").addEventListener("change", () => { updateFocalReadout(); refreshAll(); });

  // 构图角度：滑块(−180~180, 0居中, 左逆右顺) ↔ 数字 双向同步
  const syncRoll = (src) => {
    let v = parseFloat(src === "num" ? $("#rollDeg").value : $("#rollSlider").value);
    if (isNaN(v)) v = 0;
    v = Math.max(-180, Math.min(180, v));
    if (src === "num") $("#rollSlider").value = v; else $("#rollDeg").value = v;
    resize(); refreshAll();
  };
  $("#rollSlider").addEventListener("input", () => syncRoll("slider"));
  $("#rollDeg").addEventListener("input", () => syncRoll("num"));
  const setFrameOrientation = (orient) => {
    const frame = document.querySelector('input[name="compmode"][value="frame"]');
    if (frame) frame.checked = true;
    const basePortrait = (mode === "phone");
    const deg = (orient === "h") ? (basePortrait ? 90 : 0) : (basePortrait ? 0 : 90);
    $("#rollDeg").value = deg;
    $("#rollSlider").value = deg;
    resize(); refreshAll();
  };
  $("#rollH").onclick = () => setFrameOrientation("h");
  $("#rollV").onclick = () => setFrameOrientation("v");
  document.querySelectorAll('input[name="compmode"]').forEach((r) => {
    r.addEventListener("change", () => { resize(); refreshAll(); });
  });

  $("#zoom").addEventListener("input", () => { $("#zoomNum").value = $("#zoom").value; refreshAll(); });
  $("#zoomNum").addEventListener("input", () => {
    const v = parseFloat($("#zoomNum").value);
    if (!isNaN(v)) $("#zoom").value = Math.min(50, Math.max(0.5, v));
    refreshAll();
  });

  $("#openMap").onclick = openMap;
  $("#mapCancel").onclick = closeMap;
  $("#mapApply").onclick = applyMap;
  $("#mapModal").addEventListener("click", (e) => { if (e.target === $("#mapModal")) closeMap(); });
  $("#mapSearchBtn").onclick = () => runMapSearch(true);
  $("#mapSearchInput").addEventListener("input", onMapSearchInput);
  $("#mapSearchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runMapSearch(true); }
    else if (e.key === "Escape") { hideMapSuggestions(); }
  });
  $("#mapSearchPanelClose").onclick = clearSearchResults;
  document.querySelectorAll(".maplayers button").forEach((b) => {
    b.onclick = () => setBaiduMapType(b.dataset.layer);
  });
  document.querySelectorAll(".mapscopes button").forEach((b) => {
    b.onclick = () => setMapScope(b.dataset.scope);
  });

  $("#navGuide").onclick = openHelp;
  $("#navTerms").onclick = openAbout;
  $("#navContact").onclick = openContact;
  $("#navShowcase").onclick = openShowcase;
  $("#helpClose").onclick = closeHelp;
  $("#helpOk").onclick = closeHelp;
  $("#helpModal").addEventListener("click", (e) => { if (e.target === $("#helpModal")) closeHelp(); });
  $("#openAbout").onclick = openAbout;
  $("#aboutClose").onclick = closeAbout;
  $("#aboutOk").onclick = closeAbout;
  $("#aboutModal").addEventListener("click", (e) => { if (e.target === $("#aboutModal")) closeAbout(); });
  $("#contactClose").onclick = closeContact;
  $("#contactOk").onclick = closeContact;
  $("#contactModal").addEventListener("click", (e) => { if (e.target === $("#contactModal")) closeContact(); });
  $("#showcaseClose").onclick = closeShowcase;
  $("#showcaseOk").onclick = closeShowcase;
  $("#showcaseModal").addEventListener("click", (e) => { if (e.target === $("#showcaseModal")) closeShowcase(); });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("#showcaseModal").classList.contains("show")) closeShowcase();
    else if ($("#contactModal").classList.contains("show")) closeContact();
    else if ($("#aboutModal").classList.contains("show")) closeAbout();
    else if ($("#helpModal").classList.contains("show")) closeHelp();
  });

  $("#export").onclick = exportPng;
  $("#reset").onclick = () => {
    $("#focal").value = 200; $("#distance").value = 450; $("#azimuth").value = 0;
    $("#height").value = 0; $("#zoom").value = 1; $("#zoomNum").value = 1;
    $("#tc").value = 1;
    $("#rollDeg").value = 0; $("#rollSlider").value = 0;
    pitch = 0; yaw = 0;
    updateOffsetLabel();
    updateFocalUI();
    resize(); refreshAll();
  };

  $("#pitchUp").onclick = () => nudge("p", +stepValue());
  $("#pitchDown").onclick = () => nudge("p", -stepValue());
  $("#yawLeft").onclick = () => nudge("y", +stepValue());
  $("#yawRight").onclick = () => nudge("y", -stepValue());
  $("#resetOffsets").onclick = resetOffsets;

  window.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "ArrowUp") { nudge("p", +stepValue()); e.preventDefault(); }
    else if (e.key === "ArrowDown") { nudge("p", -stepValue()); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { nudge("y", +stepValue()); e.preventDefault(); }
    else if (e.key === "ArrowRight") { nudge("y", -stepValue()); e.preventDefault(); }
  });
  window.addEventListener("resize", () => { resize(); refreshAll(); });
}

// ---------------- 启动 ----------------
updateOffsetLabel();
loadData().then(() => {
  buildSelects();
  bindTips();
  bindUI();
  setupSearch();
  setMode("camera");
  resize();
  const params = new URLSearchParams(location.search);
  if (params.get("help") === "1") openHelp();
  if (params.get("about") === "1") openAbout();
}).catch((err) => {
  const st = $("#status");
  if (st) st.textContent = "数据加载失败：请用本地 http 服务打开（本地预览.bat）。" + err;
});
