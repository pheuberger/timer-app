import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// ---------------------------------------------------------------------------
// Scene / renderer / camera
// ---------------------------------------------------------------------------
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x06060a);
scene.fog = new THREE.FogExp2(0x06060a, 0.045);

// Composition: candle stays at world origin; the camera looks left of it so
// the candle lands on the right third of the frame, leaving the left third
// for the UI. Portrait screens recenter (UI stacks below instead).
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 100);
const camTarget = new THREE.Vector3(-2.1, 2.45, 0);
let camBaseX = -0.9;
let camBaseY = 3.4;
let camBaseZ = 10.6;
function updateFraming() {
  const portrait = innerWidth / innerHeight < 1;
  camTarget.set(portrait ? 0 : -2.1, portrait ? 2.0 : 2.45, 0);
  camBaseX = portrait ? 0 : -0.9;
  camBaseY = 3.4;
  camBaseZ = portrait ? 15 : 10.6;
}
updateFraming();
camera.position.set(camBaseX, camBaseY, camBaseZ);
camera.lookAt(camTarget);

// ---------------------------------------------------------------------------
// Constants for the candle geometry
// ---------------------------------------------------------------------------
const CANDLE_RADIUS = 0.85;
const CANDLE_FULL_HEIGHT = 4.2;
const CANDLE_MIN_HEIGHT = 0.35;   // stub left when fully burned
const BASE_Y = 0.0;               // bottom of candle sits here

// Asymmetric burn: one side of the candle melts faster. LOW_SIDE is the
// angle (radians) of the fast-melting side; edgeProfile() gives the relative
// melt depth around the circumference. The GLSL in the wax shader must stay
// in sync with this function.
const LOW_SIDE = 2.3;
function edgeProfile(theta) {
  const low = 0.5 + 0.5 * Math.cos(theta - LOW_SIDE);
  const prof = 0.3 + 0.7 * low * low
    + 0.14 * Math.sin(theta * 3.0 + 0.8)
    + 0.08 * Math.sin(theta * 7.0 + 2.1);
  return Math.max(prof, 0.05);
}

// Radial jitter of the melted rim ring — shared by the rim bake and the
// drip spill blobs so they stay glued to the actual lip.
function rimJitter(theta) {
  return 1 + 0.04 * Math.sin(theta * 5.0 + 1.3) + 0.02 * Math.sin(theta * 11.0 + 4.2);
}

// Debug hook: ?burn=0.5 previews the candle at a given burn progress.
const DEBUG_BURN = parseFloat(new URLSearchParams(location.search).get("burn"));

// ---------------------------------------------------------------------------
// Ground / table
// ---------------------------------------------------------------------------
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(30, 64),
  new THREE.MeshStandardMaterial({ color: 0x0d0b0a, roughness: 0.85, metalness: 0.2 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = BASE_Y - 0.01;
ground.receiveShadow = true;
scene.add(ground);

// A subtle reflective pool glow under the candle — radial falloff so there
// is no visible disc edge on the floor.
const haloMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: { uOpacity: { value: 0.1 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform float uOpacity;
    void main() {
      float d = length(vUv - 0.5) * 2.0;
      float a = pow(max(0.0, 1.0 - d), 2.4) * uOpacity;
      gl_FragColor = vec4(1.0, 0.48, 0.18, a);
    }
  `,
});
const halo = new THREE.Mesh(new THREE.PlaneGeometry(6.5, 6.5), haloMat);
halo.rotation.x = -Math.PI / 2;
halo.position.y = BASE_Y + 0.005;
scene.add(halo);

// ---------------------------------------------------------------------------
// Candle body (wax). Anchored at the bottom; we scale height as it burns.
// ---------------------------------------------------------------------------
const candleGroup = new THREE.Group();
scene.add(candleGroup);

const waxMat = new THREE.MeshStandardMaterial({
  color: 0xf3e2c7,
  roughness: 0.55,
  metalness: 0.0,
  emissive: 0xff5a1e,
  emissiveIntensity: 0.0,
});
// Translucent-ish top glow near the flame handled via emissive gradient trick:
waxMat.onBeforeCompile = (shader) => {
  shader.uniforms.uTopY = { value: CANDLE_FULL_HEIGHT };
  shader.uniforms.uMelt = { value: 0 };   // world-space melt depth at the low side
  shader.uniforms.uH = { value: CANDLE_FULL_HEIGHT }; // current world height (candle scale.y)
  // Uneven top edge: sink vertices near the top by an angular melt profile.
  // Must match edgeProfile() in JS. Displacement is in local space, so divide
  // by uH to cancel the world-height scaling applied via candle.scale.y.
  shader.vertexShader = shader.vertexShader.replace(
    "#include <begin_vertex>",
    `#include <begin_vertex>
    {
      float theta = atan(transformed.z, transformed.x);
      float low = 0.5 + 0.5 * cos(theta - ${LOW_SIDE.toFixed(3)});
      float prof = 0.3 + 0.7 * low * low
        + 0.14 * sin(theta * 3.0 + 0.8)
        + 0.08 * sin(theta * 7.0 + 2.1);
      float drop = uMelt * max(prof, 0.05);
      transformed.y -= (drop / max(uH, 0.001)) * smoothstep(0.55, 1.0, transformed.y);
    }`
  );
  shader.vertexShader = "uniform float uMelt;\nuniform float uH;\nvarying float vWorldY;\n" + shader.vertexShader.replace(
    "#include <worldpos_vertex>",
    "#include <worldpos_vertex>\n vWorldY = worldPosition.y;"
  );
  shader.uniforms.uBand = { value: 0.9 }; // emissive band height, shrinks with the candle
  shader.uniforms.uGlowW = { value: 0 }; // flame energy — no hot band when unlit
  shader.fragmentShader = "uniform float uTopY;\nuniform float uBand;\nuniform float uGlowW;\nvarying float vWorldY;\n" +
    shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n float g = smoothstep(uTopY - uBand, uTopY, vWorldY); totalEmissiveRadiance += vec3(1.0,0.42,0.12) * g * 0.9 * uGlowW;"
    );
  waxMat.userData.shader = shader;
};

// cylinder of height 1 centered at 0.5 so bottom = 0; we scale.y to set height.
// Height segments matter: the melt displacement needs vertices near the top.
const candleGeo = new THREE.CylinderGeometry(CANDLE_RADIUS, CANDLE_RADIUS * 1.02, 1, 48, 24, false);
candleGeo.translate(0, 0.5, 0);
const candle = new THREE.Mesh(candleGeo, waxMat);
candle.position.y = BASE_Y;
candle.castShadow = true;
candle.receiveShadow = true;
candleGroup.add(candle);

// Melted rim at the top of the wax — vertices baked with the same melt
// profile (plus radial jitter) so the lip looks hand-melted, not machined.
// After rotation.x = PI/2, local +z maps to world -y, and the local
// circumference angle atan2(y, x) matches the world angle atan2(z, x).
const rim = new THREE.Mesh(
  new THREE.TorusGeometry(CANDLE_RADIUS * 0.96, 0.09, 12, 64),
  new THREE.MeshStandardMaterial({
    color: 0xffca8a, roughness: 0.4, emissive: 0xff6a20, emissiveIntensity: 0.6,
    transparent: true, opacity: 0, // fades in as the wax starts melting
  })
);
{
  const pos = rim.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const a = Math.atan2(y, x);
    const rj = rimJitter(a);
    pos.setXYZ(i, x * rj, y * rj, z + edgeProfile(a) * 0.13);
  }
  rim.geometry.computeVertexNormals();
}
rim.rotation.x = Math.PI / 2;
rim.visible = false;
candleGroup.add(rim);

// Melt pool — molten disc sitting in the crater around the wick. Its flat
// plane slices through the tilted, displaced wax top, which reads as an
// uneven pool contour for free.
const poolMat = new THREE.ShaderMaterial({
  transparent: true,
  uniforms: { uTime: { value: 0 }, uGlow: { value: 1 }, uAlpha: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform float uTime, uGlow, uAlpha;
    void main() {
      float d = length(vUv - 0.5) * 2.0;
      float shimmer = 0.5 + 0.5 * sin(uTime * 2.0 + d * 9.0);
      float heat = smoothstep(0.9, 0.15, d);
      vec3 waxDark = vec3(0.38, 0.30, 0.22);
      vec3 hot = vec3(1.0, 0.45, 0.12) * (1.1 + 0.25 * shimmer);
      vec3 col = mix(waxDark, hot, heat * uGlow);
      gl_FragColor = vec4(col, uAlpha);
    }
  `,
});
const pool = new THREE.Mesh(new THREE.CircleGeometry(CANDLE_RADIUS * 0.8, 48), poolMat);
pool.rotation.x = -Math.PI / 2;
pool.visible = false;
candleGroup.add(pool);

// Wick — slight lean toward the low side so the flame sits a touch off-axis
const wick = new THREE.Mesh(
  new THREE.CylinderGeometry(0.035, 0.05, 0.42, 8),
  new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 1, emissive: 0xff3d00, emissiveIntensity: 1.2 })
);
wick.rotation.z = 0.13;
wick.rotation.x = -0.05;
wick.position.x = -0.04;
candleGroup.add(wick);
const WICK_TIP_X = -0.09; // where the flame anchors, given the lean

// ---------------------------------------------------------------------------
// Flame — additive shader sprite that flickers
// ---------------------------------------------------------------------------
const flameGeo = new THREE.PlaneGeometry(1.05, 2.0, 1, 1);
const flameMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    uTime: { value: 0 },
    uIntensity: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform float uTime;
    uniform float uIntensity;

    // cheap value noise
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      float a = hash(i), b = hash(i+vec2(1,0));
      float c = hash(i+vec2(0,1)), d = hash(i+vec2(1,1));
      vec2 u = f*f*(3.0-2.0*f);
      return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
    }

    void main() {
      vec2 uv = vUv;
      // center horizontally, flame rises along y
      float x = uv.x - 0.5;
      float y = uv.y;

      // flicker: horizontal sway increasing toward the tip
      float sway = (noise(vec2(uTime*1.6, y*3.0)) - 0.5) * 0.22 * y;
      x += sway;

      // teardrop body
      float width = 0.32 * (1.0 - y) * smoothstep(0.0, 0.12, y);
      float body = 1.0 - smoothstep(width*0.6, width, abs(x));
      body *= smoothstep(0.0, 0.08, y) * (1.0 - smoothstep(0.78, 1.0, y));

      // turbulence flicker
      float flick = noise(vec2(x*8.0, y*6.0 - uTime*3.0));
      body *= 0.75 + flick*0.5;
      body *= uIntensity;

      // color gradient: blue base -> orange -> yellow tip -> soft
      vec3 col = mix(vec3(0.15,0.35,1.0), vec3(1.0,0.35,0.05), smoothstep(0.02, 0.25, y));
      col = mix(col, vec3(1.0,0.75,0.25), smoothstep(0.25, 0.6, y));
      col = mix(col, vec3(1.0,0.95,0.7), smoothstep(0.6, 0.95, y));

      float alpha = clamp(body, 0.0, 1.0);
      gl_FragColor = vec4(col * (1.3 + flick), alpha);
    }
  `,
});
const flame = new THREE.Mesh(flameGeo, flameMat);
scene.add(flame);

// Inner bright core for extra bloom punch
const coreMat = new THREE.MeshBasicMaterial({ color: 0xffdca0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
const core = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 16), coreMat);
scene.add(core);

// ---------------------------------------------------------------------------
// Lighting — moody, warm, driven by the flame
// ---------------------------------------------------------------------------
const ambient = new THREE.AmbientLight(0x2a2033, 0.6);
scene.add(ambient);

const flameLight = new THREE.PointLight(0xff8a3d, 30, 22, 2.0);
flameLight.castShadow = true;
flameLight.shadow.mapSize.set(1024, 1024);
flameLight.shadow.bias = -0.0015;
scene.add(flameLight);

// cool rim light from behind for shape separation
const rimLight = new THREE.DirectionalLight(0x4060ff, 0.35);
rimLight.position.set(-4, 6, -5);
scene.add(rimLight);

// faint fill so the candle body never goes pure black
const fill = new THREE.PointLight(0xff6a2a, 4, 14, 2.0);
fill.position.set(2.5, 1.5, 3.5);
scene.add(fill);

// dim cool light so the unlit candle stays readable before ignition;
// fades out as the flame takes over
const idleFill = new THREE.PointLight(0x9db4ff, 6, 16, 2.0);
idleFill.position.set(2.5, 3.5, 3.5);
scene.add(idleFill);

// ---------------------------------------------------------------------------
// Sparks — GPU-ish particle system (updated on CPU, small count)
// ---------------------------------------------------------------------------
const SPARK_MAX = 300;
const sparkGeo = new THREE.BufferGeometry();
const sparkPos = new Float32Array(SPARK_MAX * 3);
const sparkVel = new Float32Array(SPARK_MAX * 3);
const sparkLife = new Float32Array(SPARK_MAX);     // remaining life
const sparkMaxLife = new Float32Array(SPARK_MAX);
sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
const sparkAlpha = new Float32Array(SPARK_MAX);
sparkGeo.setAttribute("aAlpha", new THREE.BufferAttribute(sparkAlpha, 1));

const sparkMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: { uSize: { value: 22.0 * Math.min(devicePixelRatio, 2) } },
  vertexShader: /* glsl */ `
    attribute float aAlpha;
    varying float vAlpha;
    uniform float uSize;
    void main() {
      vAlpha = aAlpha;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = uSize * aAlpha / max(-mv.z, 0.5);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    varying float vAlpha;
    void main() {
      vec2 d = gl_PointCoord - 0.5;
      float r = length(d);
      if (r > 0.5) discard;
      float glow = smoothstep(0.5, 0.0, r);
      vec3 col = mix(vec3(1.0,0.5,0.15), vec3(1.0,0.95,0.7), glow);
      gl_FragColor = vec4(col, glow * vAlpha);
    }
  `,
});
const sparks = new THREE.Points(sparkGeo, sparkMat);
scene.add(sparks);

let sparkCursor = 0;
function emitSpark(x, y, z, speed) {
  const i = sparkCursor;
  sparkCursor = (sparkCursor + 1) % SPARK_MAX;
  sparkPos[i * 3] = x + (Math.random() - 0.5) * 0.1;
  sparkPos[i * 3 + 1] = y;
  sparkPos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.1;
  const ang = Math.random() * Math.PI * 2;
  const spread = 0.35 + Math.random() * 0.5;
  sparkVel[i * 3] = Math.cos(ang) * spread;
  sparkVel[i * 3 + 1] = (0.8 + Math.random() * 1.4) * speed;
  sparkVel[i * 3 + 2] = Math.sin(ang) * spread;
  const life = 0.5 + Math.random() * 0.9;
  sparkLife[i] = life;
  sparkMaxLife[i] = life;
}

function updateSparks(dt) {
  for (let i = 0; i < SPARK_MAX; i++) {
    if (sparkLife[i] <= 0) { sparkAlpha[i] = 0; continue; }
    sparkLife[i] -= dt;
    sparkVel[i * 3 + 1] -= dt * 0.6;        // slight gravity, they mostly float up
    sparkVel[i * 3] *= (1 - dt * 0.8);
    sparkVel[i * 3 + 2] *= (1 - dt * 0.8);
    sparkPos[i * 3] += sparkVel[i * 3] * dt;
    sparkPos[i * 3 + 1] += sparkVel[i * 3 + 1] * dt;
    sparkPos[i * 3 + 2] += sparkVel[i * 3 + 2] * dt;
    sparkAlpha[i] = Math.max(0, sparkLife[i] / sparkMaxLife[i]);
  }
  sparkGeo.attributes.position.needsUpdate = true;
  sparkGeo.attributes.aAlpha.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Wax drips — capsule streaks hanging from the rim, clustered on the low
// side. Each activates at a burn threshold, then keeps flowing until it
// reaches the floor (wax doesn't stop halfway); surplus flow feeds a
// growing pool mound at the base. `speed` is the flow rate per unit of
// burn progress.
// ---------------------------------------------------------------------------
// Angles are spread around the circumference in clumps: a main clump on the
// fast-melting low side, a smaller clump right-front, plus two loners, so the
// streaks don't all bunch on one spot.
const DRIPS = [
  { angle: LOW_SIDE,        start: 0.10, speed: 1.0,  r: 0.075 }, // main clump
  { angle: LOW_SIDE + 0.22, start: 0.30, speed: 0.7,  r: 0.050 },
  { angle: LOW_SIDE - 0.35, start: 0.48, speed: 0.8,  r: 0.060 },
  { angle: LOW_SIDE - 1.55, start: 0.26, speed: 0.85, r: 0.065 }, // second clump
  { angle: LOW_SIDE - 1.80, start: 0.42, speed: 0.65, r: 0.050 },
  { angle: LOW_SIDE + 1.15, start: 0.60, speed: 0.7,  r: 0.055 }, // loner, left
  { angle: LOW_SIDE - 2.50, start: 0.72, speed: 0.6,  r: 0.050 }, // loner, right edge
];
const dripMeshes = DRIPS.map((d) => {
  const geo = new THREE.CapsuleGeometry(d.r, 1, 4, 10);
  geo.translate(0, -(0.5 + d.r), 0); // origin at the top so scale.y grows downward
  const mat = new THREE.MeshStandardMaterial({
    color: 0xf3e2c7,
    roughness: 0.45,
    emissive: 0xff5a1e,
    emissiveIntensity: 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // sit half-proud of the wax wall so the streak reads on the surface,
  // not buried inside the cylinder
  const rr = CANDLE_RADIUS + d.r * 0.45;
  mesh.position.set(Math.cos(d.angle) * rr, 0, Math.sin(d.angle) * rr);
  mesh.castShadow = true;
  mesh.visible = false;
  scene.add(mesh);

  // spill blob bridging the rim lip and the streak, so the drip reads as
  // wax flowing over the edge instead of a rod floating beside it
  const blob = new THREE.Mesh(new THREE.SphereGeometry(d.r * 2.1, 12, 10), mat);
  blob.rotation.y = -d.angle; // local +x points radially outward
  blob.castShadow = true;
  blob.visible = false;
  scene.add(blob);

  // pool mound where the streak meets the floor — half-buried squashed
  // sphere that swells as surplus wax keeps arriving
  const floorPool = new THREE.Mesh(new THREE.SphereGeometry(d.r * 4.5, 16, 12), mat.clone());
  floorPool.visible = false;
  scene.add(floorPool);

  const lipR = CANDLE_RADIUS * 0.96 * rimJitter(d.angle) + 0.06;
  return { mesh, blob, floorPool, lipR, dropY: edgeProfile(d.angle) * 0.13 };
});

function updateDrips(p, rimY, energy) {
  for (let i = 0; i < DRIPS.length; i++) {
    const d = DRIPS[i];
    const { mesh, blob, floorPool, lipR, dropY } = dripMeshes[i];
    // total wax flowed since activation; unbounded so every streak
    // eventually reaches the floor
    const flow = Math.max(0, p - d.start) * 11 * d.speed;
    if (flow <= 0) { mesh.visible = blob.visible = floorPool.visible = false; continue; }
    mesh.visible = blob.visible = true;
    const lipY = rimY - dropY; // rim ring dips by the melt profile at this angle
    mesh.position.y = lipY + 0.02;
    // streak runs from the lip down to the floor, no further
    const reach = Math.max(0.05, mesh.position.y - 0.02);
    mesh.scale.y = Math.min(flow, reach);
    const thick = Math.min(1, flow / 1.2);
    mesh.scale.x = mesh.scale.z = 0.8 + 0.4 * thick;
    blob.position.set(Math.cos(d.angle) * lipR, lipY + 0.03, Math.sin(d.angle) * lipR);
    const bs = 0.6 + 0.5 * thick;
    blob.scale.set(1.25 * bs, 0.5 * bs, 0.95 * bs);
    // once the streak touches down, surplus flow swells the floor mound
    const surplus = flow - reach;
    if (surplus > 0) {
      floorPool.visible = true;
      const ps = Math.min(1.6, 0.35 + surplus * 0.5);
      floorPool.position.set(mesh.position.x, BASE_Y + 0.01, mesh.position.z);
      floorPool.scale.set(ps, 0.14 + 0.05 * ps, ps);
      floorPool.material.emissiveIntensity = 0.3 * energy * Math.max(0, 1 - surplus);
    } else {
      floorPool.visible = false;
    }
    // fresh wax glows near the flame, cools as the drip ages
    mesh.material.emissiveIntensity = 0.5 * energy * (1 - thick * 0.7);
  }
}

// ---------------------------------------------------------------------------
// Fog wisps — big noise-shader planes drifting through the scene at different
// depths (one in front of the candle) for a low-hanging haze.
// ---------------------------------------------------------------------------
const mistUniforms = [];
function makeMist(w, h, y, z, opacity, speed, seed) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: opacity },
      uSpeed: { value: speed },
      uSeed: { value: seed },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform float uTime, uOpacity, uSpeed, uSeed;

      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)) + uSeed) * 43758.5453); }
      float noise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        float a = hash(i), b = hash(i+vec2(1,0));
        float c = hash(i+vec2(0,1)), d = hash(i+vec2(1,1));
        vec2 u = f*f*(3.0-2.0*f);
        return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
      }
      float fbm(vec2 p){
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.1; a *= 0.5; }
        return v;
      }

      void main() {
        vec2 p = vUv * vec2(3.0, 1.4);
        p.x += uTime * uSpeed;
        float m = fbm(p + fbm(p * 1.7 - uTime * uSpeed * 0.5));
        // fade toward plane edges so the quads never read as rectangles
        float edge = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x)
                   * smoothstep(0.0, 0.30, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
        float a = smoothstep(0.35, 0.85, m) * edge * uOpacity;
        vec3 col = mix(vec3(0.16, 0.19, 0.30), vec3(0.85, 0.50, 0.28), 0.25);
        gl_FragColor = vec4(col, a);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.position.set(0, y, z);
  scene.add(mesh);
  mistUniforms.push(mat.uniforms);
}
makeMist(30, 7, 1.6, -4.5, 0.15, 0.020, 1.0);  // far bank
makeMist(26, 5, 1.0, -2.0, 0.11, 0.035, 7.0);  // mid, hugging the ground
makeMist(24, 4, 0.7, 3.0, 0.08, 0.050, 13.0);  // foreground drift

// ---------------------------------------------------------------------------
// Post-processing: bloom
// ---------------------------------------------------------------------------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.9, 0.6, 0.72);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------------------
// Timer state machine
// ---------------------------------------------------------------------------
const State = { IDLE: "idle", RUNNING: "running", DONE: "done" };
let state = State.IDLE;
let totalMs = 5 * 60 * 1000;
let remainingMs = totalMs;
let lastTick = 0;

// UI refs
const el = {
  time: document.getElementById("time"),
  status: document.getElementById("status"),
  presets: document.getElementById("presets"),
  startBtn: document.getElementById("startBtn"),
  resetBtn: document.getElementById("resetBtn"),
  controls: document.getElementById("controls"),
  done: document.getElementById("done"),
  doneReset: document.getElementById("doneReset"),
  customToggle: document.getElementById("customToggle"),
  customFields: document.getElementById("customFields"),
  inH: document.getElementById("inH"),
  inM: document.getElementById("inM"),
  inS: document.getElementById("inS"),
  editToggle: document.getElementById("editToggle"),
  restoreBtn: document.getElementById("restoreBtn"),
  editor: document.getElementById("editor"),
  editorTitle: document.getElementById("editorTitle"),
  iconGrid: document.getElementById("iconGrid"),
  pName: document.getElementById("pName"),
  pH: document.getElementById("pH"),
  pM: document.getElementById("pM"),
  pS: document.getElementById("pS"),
  pCancel: document.getElementById("pCancel"),
  pDelete: document.getElementById("pDelete"),
};

// ---------------------------------------------------------------------------
// Presets — the shipped set is only a starting point. Users can edit, remove
// and add their own; once they do, the list is persisted in localStorage and
// fully replaces the defaults (an empty list is a valid choice). Each preset
// is { id, label, ms, icon } with icon a key of ICONS or null.
// ---------------------------------------------------------------------------
const PRESET_KEY = "ember.presets";
const MAX_PRESET_MS = (9 * 3600 + 59 * 60 + 59) * 1000;
const MAX_LABEL = 18;

const DEFAULT_PRESETS = [
  { label: "25s", ms: 25 * 1000 },
  { label: "1m", ms: 60 * 1000 },
  { label: "5m", ms: 5 * 60 * 1000 },
  { label: "15m", ms: 15 * 60 * 1000 },
  { label: "25m", ms: 25 * 60 * 1000 },
  { label: "1hr", ms: 60 * 60 * 1000 },
];

// Monochrome line icons (24-unit grid, 1.6 stroke, drawn in currentColor so
// they inherit the chip's tint). Kept to a small, quiet set on purpose.
const ICONS = {
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  candle: '<path d="M10 22v-9a2 2 0 0 1 4 0v9"/><path d="M8 22h8"/><path d="M12 10V8"/><path d="M12 2c-1.1 1.2-1.7 2.1-1.7 3a1.7 1.7 0 0 0 3.4 0c0-.9-.6-1.8-1.7-3z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  sprout: '<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>',
  drop: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
  wind: '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>',
  mountain: '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>',
  coffee: '<path d="M10 2v2M14 2v2M6 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  hourglass: '<path d="M5 22h14M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  dumbbell: '<path d="M6 7v10M18 7v10M3 9v6M21 9v6M6 12h12"/>',
  bed: '<path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/>',
  feather: '<path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/>',
};
const ICON_NONE = '<path d="M5 12h14"/>';

function iconSvg(inner, cls) {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
}

// "25m", "1h 30m", "45s" — the label a preset gets when the user leaves the
// name blank
function shortLabel(ms) {
  const t = Math.round(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h && !m && !s) return `${h}hr`;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return parts.join(" ");
}

let presetSeq = 0;
function normalizePreset(raw) {
  if (!raw || typeof raw !== "object") return null;
  const ms = Math.round(Number(raw.ms));
  if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_PRESET_MS) return null;
  const icon = typeof raw.icon === "string" && ICONS[raw.icon] ? raw.icon : null;
  let label = typeof raw.label === "string" ? raw.label.trim().slice(0, MAX_LABEL) : "";
  if (!label && !icon) label = shortLabel(ms); // never render an empty chip
  return { id: `p${presetSeq++}`, label, ms, icon };
}

function loadPresets() {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    if (raw != null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(normalizePreset).filter(Boolean);
    }
  } catch (e) { /* unavailable or corrupt storage: fall back to the defaults */ }
  return DEFAULT_PRESETS.map(normalizePreset);
}

function savePresets() {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets.map(({ label, ms, icon }) => ({ label, ms, icon }))));
  } catch (e) { /* private mode / quota: presets still work for this session */ }
}

let presets = loadPresets();
let activePresetId = null;
let activeChip = null;
let editing = false;   // edit mode: chips open the editor instead of selecting
let editingId = null;  // preset open in the editor, null when creating
let editorIcon = null;

function renderPresets() {
  el.presets.innerHTML = "";
  activeChip = null;
  for (const p of presets) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (p.label ? "" : " icon-only");
    if (p.icon) b.insertAdjacentHTML("beforeend", iconSvg(ICONS[p.icon], "chip-icon"));
    if (p.label) {
      const span = document.createElement("span");
      span.className = "chip-label";
      span.textContent = p.label;
      b.appendChild(span);
    }
    const name = p.label || shortLabel(p.ms);
    b.title = p.label ? "" : shortLabel(p.ms);
    b.setAttribute("aria-label", p.label ? `${p.label}, ${shortLabel(p.ms)}` : name);
    const x = document.createElement("span");
    x.className = "chip-x";
    x.setAttribute("role", "button");
    x.setAttribute("aria-label", `Remove ${name}`);
    x.textContent = "×";
    x.addEventListener("click", (e) => { e.stopPropagation(); removePreset(p.id); });
    b.appendChild(x);
    b.addEventListener("click", () => (editing ? openEditor(p) : selectPreset(p, b)));
    if (p.id === activePresetId) { b.classList.add("active"); activeChip = b; }
    el.presets.appendChild(b);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "chip chip-add";
  add.textContent = "+ New";
  add.addEventListener("click", () => openEditor(null));
  el.presets.appendChild(add);
}

function selectPreset(p, chip) {
  setDuration(p.ms);
  activePresetId = p.id;
  setActiveChip(chip);
  syncInputs(p.ms);
}

function setActiveChip(b) {
  if (activeChip) activeChip.classList.remove("active");
  activeChip = b;
  if (b) b.classList.add("active");
  if (!b) activePresetId = null;
}

function removePreset(id) {
  presets = presets.filter((p) => p.id !== id);
  if (activePresetId === id) activePresetId = null; // keep the duration, drop the highlight
  savePresets();
  renderPresets();
}

function restoreDefaults() {
  presets = DEFAULT_PRESETS.map(normalizePreset);
  try { localStorage.removeItem(PRESET_KEY); } catch (e) { /* ignore */ }
  const match = presets.find((p) => p.ms === totalMs);
  activePresetId = match ? match.id : null;
  renderPresets();
}

function setEditing(on) {
  editing = on;
  document.body.classList.toggle("editing", on);
  el.editToggle.textContent = on ? "Done" : "Edit presets";
  if (on) {
    el.customFields.setAttribute("hidden", "");
    el.customToggle.textContent = "Custom time";
  } else {
    closeEditor();
  }
}

// --- editor -----------------------------------------------------------------
function renderIconGrid() {
  el.iconGrid.innerHTML = "";
  const options = [[null, ICON_NONE, "No icon"], ...Object.keys(ICONS).map((k) => [k, ICONS[k], k])];
  for (const [key, inner, name] of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon-opt" + (key ? "" : " icon-none") + (key === editorIcon ? " selected" : "");
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(key === editorIcon));
    b.setAttribute("aria-label", name);
    b.title = name;
    b.innerHTML = iconSvg(inner, "");
    b.addEventListener("click", () => {
      editorIcon = key;
      for (const o of el.iconGrid.children) {
        const on = o === b;
        o.classList.toggle("selected", on);
        o.setAttribute("aria-checked", String(on));
      }
      updateNamePlaceholder();
    });
    el.iconGrid.appendChild(b);
  }
}

function readFields(hEl, mEl, sEl) {
  const h = Math.min(9, Math.max(0, parseInt(hEl.value) || 0));
  const m = Math.min(59, Math.max(0, parseInt(mEl.value) || 0));
  const s = Math.min(59, Math.max(0, parseInt(sEl.value) || 0));
  return (h * 3600 + m * 60 + s) * 1000;
}

function writeFields(hEl, mEl, sEl, ms) {
  const t = Math.round(ms / 1000);
  hEl.value = Math.floor(t / 3600);
  mEl.value = Math.floor((t % 3600) / 60);
  sEl.value = t % 60;
}

// the name falls back to the duration, so show that as the placeholder
function updateNamePlaceholder() {
  const ms = readFields(el.pH, el.pM, el.pS);
  el.pName.placeholder = ms >= 1000 ? shortLabel(ms) : "Name";
}

function openEditor(p) {
  editingId = p ? p.id : null;
  editorIcon = p ? p.icon : null;
  el.editorTitle.textContent = p ? "Edit preset" : "New preset";
  el.pName.value = p ? p.label : "";
  writeFields(el.pH, el.pM, el.pS, p ? p.ms : 10 * 60 * 1000);
  el.pDelete.hidden = !p;
  renderIconGrid();
  updateNamePlaceholder();
  document.body.classList.add("editor-open");
  el.editor.removeAttribute("hidden");
  el.pName.focus();
}

function closeEditor() {
  editingId = null;
  el.editor.setAttribute("hidden", "");
  document.body.classList.remove("editor-open");
}

function saveEditor() {
  const ms = readFields(el.pH, el.pM, el.pS);
  if (ms < 1000) {
    for (const inp of [el.pH, el.pM, el.pS]) {
      inp.classList.remove("invalid");
      void inp.offsetWidth; // restart the nudge animation
      inp.classList.add("invalid");
    }
    el.pS.focus();
    return;
  }
  const next = normalizePreset({ label: el.pName.value, ms, icon: editorIcon });
  const idx = presets.findIndex((p) => p.id === editingId);
  if (idx >= 0) {
    next.id = editingId;
    presets[idx] = next;
    if (activePresetId === editingId) { setDuration(next.ms); syncInputs(next.ms); }
  } else {
    presets.push(next);
  }
  savePresets();
  renderPresets();
  closeEditor();
}

el.editor.addEventListener("submit", (e) => { e.preventDefault(); saveEditor(); });
el.pCancel.addEventListener("click", closeEditor);
el.pDelete.addEventListener("click", () => { const id = editingId; closeEditor(); removePreset(id); });
el.editor.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); closeEditor(); } });
[el.pH, el.pM, el.pS].forEach((inp) => {
  inp.addEventListener("input", () => { inp.classList.remove("invalid"); updateNamePlaceholder(); });
});
el.editToggle.addEventListener("click", () => setEditing(!editing));
el.restoreBtn.addEventListener("click", restoreDefaults);

// initial selection: the preset matching the default duration, else the first
{
  const initial = presets.find((p) => p.ms === totalMs) || presets[0];
  if (initial) { totalMs = remainingMs = initial.ms; activePresetId = initial.id; }
  syncInputs(totalMs);
}
renderPresets();

function setDuration(ms) {
  totalMs = Math.max(1000, ms);
  remainingMs = totalMs;
  updateTimeLabel(remainingMs);
}

function fmt(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function updateTimeLabel(ms) {
  el.time.textContent = fmt(ms);
}

function syncInputs(ms) {
  writeFields(el.inH, el.inM, el.inS, ms);
}

function readInputs() {
  return readFields(el.inH, el.inM, el.inS);
}

[el.inH, el.inM, el.inS].forEach((inp) => {
  inp.addEventListener("input", () => {
    const ms = readInputs();
    if (ms >= 1000) { setDuration(ms); setActiveChip(null); }
  });
});

el.customToggle.addEventListener("click", () => {
  const hidden = el.customFields.hasAttribute("hidden");
  if (hidden) el.customFields.removeAttribute("hidden");
  else el.customFields.setAttribute("hidden", "");
  el.customToggle.textContent = hidden ? "Hide custom" : "Custom time";
});

// ---------------------------------------------------------------------------
// Ambient completion sound — a slow synth pad that fades in over the final
// seconds of the countdown, reaching full volume right at 00:00, then
// lingering (with sparse soft chimes) until reset. Everything is synthesized
// with the Web Audio API — no samples. The fade is scheduled on the audio
// clock when the timer starts, so it stays sample-accurate even if the tab
// is backgrounded and rAF freezes.
// ---------------------------------------------------------------------------
const FADE_LEAD_MS = 7000;   // fade-in window before 00:00
const AMBIENT_LEVEL = 0.4;   // pad resting volume after the timer hits zero
const ARRIVAL_CREST = 1.35;  // swell peaks this far above rest right at 00:00
const ARM_LEAD_MS = FADE_LEAD_MS + 1500; // wake the audio context this early

// Declare a mixable audio session before any AudioContext exists — WebKit
// applies the type when the session activates, so setting it after creation
// can be too late. "ambient" mixes with the user's music instead of pausing
// it; the trade-off is iOS mutes ambient audio while the PWA is backgrounded,
// so a 00:00 that passes in the background is sounded by the slip-recovery
// path in finishAudio() the moment the app returns. The web has no
// mix-with-others "playback" session, so music continuity and a guaranteed
// background chime are mutually exclusive.
try {
  if (navigator.audioSession) navigator.audioSession.type = "ambient";
} catch (e) { /* unsupported */ }

let audio = null;            // created lazily on Start (needs a user gesture)
let chimeTimeout = 0;
let armTimeout = 0;
let suspendTimeout = 0;

// Cancel pending automation but keep the param's current value (Firefox has
// no cancelAndHoldAtTime).
function holdParam(param, t) {
  if (param.cancelAndHoldAtTime) {
    param.cancelAndHoldAtTime(t);
  } else {
    const v = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  }
}

// Synthesized impulse response: decaying stereo noise reads as a soft room.
function makeImpulse(ctx, seconds, decay) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function initAudio() {
  if (audio) return audio;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  const ctx = new Ctor();

  // safety compressor so the pad + chimes can never clip harshly
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -14;
  limiter.knee.value = 20;
  limiter.ratio.value = 6;
  limiter.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(limiter);

  // shared space: dry signal plus a synthesized reverb tail
  const bus = ctx.createGain();
  const dry = ctx.createGain();
  dry.gain.value = 0.6;
  const verb = ctx.createConvolver();
  verb.buffer = makeImpulse(ctx, 3.5, 2.6);
  const wet = ctx.createGain();
  wet.gain.value = 0.5;
  bus.connect(dry);
  dry.connect(master);
  bus.connect(verb);
  verb.connect(wet);
  wet.connect(master);

  // one warm lowpass the whole pad sits behind, cutoff wandering slowly
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 520;
  filter.Q.value = 0.7;
  filter.connect(bus);
  const filterLfo = ctx.createOscillator();
  filterLfo.frequency.value = 0.06;
  const filterLfoDepth = ctx.createGain();
  filterLfoDepth.gain.value = 170;
  filterLfo.connect(filterLfoDepth);
  filterLfoDepth.connect(filter.frequency);
  filterLfo.start();

  // Pad voices — an Asus2 spread (A, B, E): warm but uncommitted, neither
  // major-bright nor minor-mournful. Detuned saw pairs through the lowpass;
  // the sub stays a clean sine. Each voice breathes and drifts across the
  // stereo field on its own slow cycle so the pad never sits still.
  const VOICES = [
    { freq: 55.0,   gain: 0.17,  detune: 0 }, // A1 sub
    { freq: 110.0,  gain: 0.2,   detune: 5 }, // A2
    { freq: 164.81, gain: 0.15,  detune: 4 }, // E3
    { freq: 220.0,  gain: 0.11,  detune: 6 }, // A3
    { freq: 246.94, gain: 0.08,  detune: 5 }, // B3
    { freq: 329.63, gain: 0.055, detune: 7 }, // E4
  ];
  VOICES.forEach((v, i) => {
    const vGain = ctx.createGain();
    vGain.gain.value = v.gain;
    const pan = ctx.createStereoPanner();
    vGain.connect(pan);
    pan.connect(filter);

    for (const det of v.detune ? [v.detune, -v.detune] : [0]) {
      const osc = ctx.createOscillator();
      osc.type = v.detune ? "sawtooth" : "sine";
      osc.frequency.value = v.freq;
      osc.detune.value = det;
      osc.connect(vGain);
      osc.start();
    }

    const breath = ctx.createOscillator();
    breath.frequency.value = 0.045 + i * 0.019;
    const breathDepth = ctx.createGain();
    breathDepth.gain.value = v.gain * 0.45;
    breath.connect(breathDepth);
    breathDepth.connect(vGain.gain);
    breath.start();

    const drift = ctx.createOscillator();
    drift.frequency.value = 0.031 + i * 0.013;
    const driftDepth = ctx.createGain();
    driftDepth.gain.value = 0.2 + 0.09 * (i % 3);
    drift.connect(driftDepth);
    driftDepth.connect(pan.pan);
    drift.start();
  });

  // chimes bypass the lowpass so they sparkle slightly above the pad
  const chimeBus = ctx.createGain();
  chimeBus.connect(bus);

  audio = { ctx, master, filter, chimeBus };
  return audio;
}

// The arrival at 00:00 — a soft singing-bowl-like strike (sine partials with
// a slow beat plus a low body swell), scheduled sample-accurately on the
// audio clock so zero is unmistakable even in a backgrounded tab.
function scheduleArrival(tEnd) {
  const { ctx, chimeBus } = audio;
  const nodes = [];
  const strike = (freq, peak, attack, decay) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, tEnd);
    g.gain.linearRampToValueAtTime(peak, tEnd + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, tEnd + decay);
    osc.connect(g);
    g.connect(chimeBus);
    osc.start(tEnd);
    osc.stop(tEnd + decay + 0.5);
    nodes.push(osc, g);
  };
  strike(440, 0.3, 0.06, 8);    // fundamental — the "ding"
  strike(441.8, 0.12, 0.06, 8); // detuned twin — slow bowl-like beating
  strike(883, 0.12, 0.05, 6);   // shimmer octave
  strike(110, 0.22, 0.2, 3.5);  // low body swell under the strike
  audio.pendingArrival = nodes;
}

function cancelArrival() {
  if (!audio || !audio.pendingArrival) return;
  for (const n of audio.pendingArrival) {
    if (n.stop) { try { n.stop(); } catch (e) { /* already stopped */ } }
    n.disconnect();
  }
  audio.pendingArrival = null;
}

// Schedule the fade-in the moment the timer starts: silence until the last
// few seconds, then a smoothstep swell that crests just past resting volume
// at 00:00 (with the bowl strike) and relaxes — the crest-and-release is
// what makes hitting zero readable instead of merely "gradually louder".
function armAmbientFade(runMs) {
  if (!audio) return;
  const { ctx, master } = audio;
  const t0 = ctx.currentTime;
  const tEnd = t0 + runMs / 1000;
  const g = master.gain;
  holdParam(g, t0);
  g.setTargetAtTime(0, t0, 0.05); // settle any residue from a quick restart
  // clamp so very short timers still get a brief swell without the curve
  // colliding with the settle above
  const tFade = Math.max(tEnd - FADE_LEAD_MS / 1000, t0 + 0.25);
  const dur = Math.max(0.05, tEnd - tFade);
  const N = 64;
  const curve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    curve[i] = AMBIENT_LEVEL * ARRIVAL_CREST * x * x * (3 - 2 * x);
  }
  g.setValueCurveAtTime(curve, tFade, dur);
  g.setTargetAtTime(AMBIENT_LEVEL, tEnd + 0.01, 1.2); // relax off the crest
  cancelArrival();
  scheduleArrival(tEnd);
  audio.tEndCtx = tEnd; // context-clock time of 00:00, for slip detection
}

// The context stays suspended for most of the countdown — a suspended context
// releases the OS audio session entirely, so the user's music is untouched.
// Arming resumes it just ahead of the fade window and schedules the swell +
// strike. Anything that keeps this from running in time (backgrounded PWA,
// throttled timers) is caught by the slip-recovery path in finishAudio().
function armAudio() {
  if (!audio || audio.armed || state !== State.RUNNING) return;
  audio.armed = true;
  if (audio.ctx.state !== "running") audio.ctx.resume().catch(() => {});
  armAmbientFade(remainingMs);
}

const CHIME_NOTES = [440, 493.88, 659.25, 739.99, 880]; // A B E F# A — pad tones

function playChime() {
  if (!audio || state !== State.DONE) return;
  const { ctx, chimeBus } = audio;
  const t = ctx.currentTime;
  const freq = CHIME_NOTES[Math.floor(Math.random() * CHIME_NOTES.length)];
  const g = ctx.createGain();
  g.connect(chimeBus);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.11, t + 0.4); // soft bloom, no attack click
  g.gain.exponentialRampToValueAtTime(0.0001, t + 5.5);
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;
  osc.connect(g);
  // slightly-off octave partial gives a faint bell-like beat
  const shimmer = ctx.createOscillator();
  shimmer.type = "sine";
  shimmer.frequency.value = freq * 2.007;
  const shimmerGain = ctx.createGain();
  shimmerGain.gain.value = 0.3;
  shimmer.connect(shimmerGain);
  shimmerGain.connect(g);
  osc.start(t);
  shimmer.start(t);
  osc.stop(t + 6);
  shimmer.stop(t + 6);
  chimeTimeout = setTimeout(playChime, 4000 + Math.random() * 6000);
}

function finishAudio() {
  if (!audio) return;
  const { ctx, master, filter } = audio;
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  const t = ctx.currentTime;
  const g = master.gain;
  holdParam(g, t); // hold the crest, then continue its release
  // If the swell + bowl strike were never armed (00:00 passed while the app
  // was backgrounded and JS frozen) or the context clock never reached the
  // scheduled zero (the OS suspended audio mid-schedule), they were lost.
  // Fire them now (they'll sound the moment the context resumes) instead of
  // leaving silence.
  const slipped = audio.tEndCtx == null || t < audio.tEndCtx - 0.1;
  audio.tEndCtx = null;
  if (slipped) {
    cancelArrival();
    scheduleArrival(t + 0.05);
    g.linearRampToValueAtTime(AMBIENT_LEVEL * ARRIVAL_CREST, t + 0.35);
    g.setTargetAtTime(AMBIENT_LEVEL, t + 0.35, 1.2);
  } else {
    g.setTargetAtTime(AMBIENT_LEVEL, t, 1.2);
  }
  // ease down to a quieter bed over the next minute so it never nags
  g.setTargetAtTime(AMBIENT_LEVEL * 0.55, t + 15, 30);
  // gentle filter bloom under the bowl strike
  holdParam(filter.frequency, t);
  filter.frequency.linearRampToValueAtTime(880, t + 5);
  filter.frequency.setTargetAtTime(620, t + 12, 20);
  // give the strike room to ring before the sparse chimes begin
  clearTimeout(chimeTimeout);
  chimeTimeout = setTimeout(playChime, 4500 + Math.random() * 3000);
}

function fadeOutAudio() {
  clearTimeout(chimeTimeout);
  clearTimeout(armTimeout);
  if (!audio) return;
  cancelArrival(); // a reset before zero also cancels the pending strike
  audio.tEndCtx = null;
  audio.armed = false;
  const { ctx, master, filter } = audio;
  const t = ctx.currentTime;
  holdParam(master.gain, t);
  master.gain.setTargetAtTime(0, t, 0.35); // ~1.5s tail out
  holdParam(filter.frequency, t);
  filter.frequency.setTargetAtTime(520, t, 2);
  // once the tail is inaudible, suspend the context to hand the audio
  // session back to whatever the user was listening to
  clearTimeout(suspendTimeout);
  suspendTimeout = setTimeout(() => {
    if (audio && state === State.IDLE) audio.ctx.suspend().catch(() => {});
  }, 3000);
}

// ---------------------------------------------------------------------------
// Start / reset
// ---------------------------------------------------------------------------
function start() {
  if (state === State.RUNNING) return;
  if (remainingMs <= 0) remainingMs = totalMs;
  state = State.RUNNING;
  lastTick = performance.now();
  if (editing) setEditing(false);
  const a = initAudio();
  if (a) {
    clearTimeout(suspendTimeout);
    clearTimeout(armTimeout);
    a.armed = false;
    // resume inside the user gesture so later programmatic resumes are allowed
    if (a.ctx.state !== "running") a.ctx.resume().catch(() => {});
    if (remainingMs > ARM_LEAD_MS) {
      // park the context so the OS gives the audio session back to the
      // user's music; armAudio() wakes it just before the fade window
      a.ctx.suspend().catch(() => {});
      armTimeout = setTimeout(armAudio, remainingMs - ARM_LEAD_MS);
    } else {
      armAudio();
    }
  }
  el.controls.setAttribute("hidden", "");
  el.resetBtn.removeAttribute("hidden");
  el.status.textContent = "Burning";
}

function reset() {
  state = State.IDLE;
  fadeOutAudio();
  remainingMs = totalMs;
  updateTimeLabel(remainingMs);
  el.controls.removeAttribute("hidden");
  el.resetBtn.setAttribute("hidden", "");
  el.done.setAttribute("hidden", "");
  el.status.textContent = "Ready";
}

function finish() {
  state = State.DONE;
  remainingMs = 0;
  updateTimeLabel(0);
  el.status.textContent = "Done";
  el.done.removeAttribute("hidden");
  el.resetBtn.setAttribute("hidden", "");
  finishAudio();
  // burst of sparks on completion
  for (let i = 0; i < 90; i++) emitSpark(0, currentTopY(), 0, 2.2);
}

el.startBtn.addEventListener("click", start);
el.resetBtn.addEventListener("click", reset);
el.doneReset.addEventListener("click", reset);
el.startBtn.addEventListener("click", () => {
  // hide custom fields on start
  el.customFields.setAttribute("hidden", "");
  el.customToggle.textContent = "Custom time";
});

// Keyboard: space toggles start/reset (but never while typing in a field)
addEventListener("keydown", (e) => {
  if (e.target && e.target.matches && e.target.matches("input, textarea")) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (state === State.RUNNING) reset();
    else if (state === State.DONE) reset();
    else start();
  }
});

// ---------------------------------------------------------------------------
// Flame extinguish / relight animation — target follows state each frame
// ---------------------------------------------------------------------------
let flameEnergy = 0.0;   // 0 = out, 1 = full; candle starts unlit

// ---------------------------------------------------------------------------
// Burn helpers — how tall is the wax right now?
// ---------------------------------------------------------------------------
function burnProgress() {
  // 0 at start, 1 when finished
  if (totalMs <= 0) return 1;
  return 1 - remainingMs / totalMs;
}

function effectiveProgress() {
  if (!Number.isNaN(DEBUG_BURN)) return Math.min(1, Math.max(0, DEBUG_BURN));
  return state === State.IDLE ? 0 : burnProgress();
}

function currentHeight() {
  return THREE.MathUtils.lerp(CANDLE_FULL_HEIGHT, CANDLE_MIN_HEIGHT, effectiveProgress());
}

function currentTopY() {
  return BASE_Y + currentHeight();
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();

// Spark cadence scales with how fast the candle burns.
// Fast timers (5s) => lots of sparks. Slow timers (5h) => almost none.
let sparkAccumulator = 0;

function burnRatePerSec() {
  // fraction of candle consumed per real second
  return 1 / (totalMs / 1000);
}

function tickRunning() {
  const now = performance.now();
  remainingMs -= now - lastTick;
  lastTick = now;
  // safety net for the arm setTimeout, which browsers throttle: arm as soon
  // as any tick lands inside the lead window
  if (remainingMs > 0 && remainingMs <= ARM_LEAD_MS) armAudio();
  if (remainingMs <= 0) { finish(); }
  updateTimeLabel(Math.max(0, remainingMs));
}

// Background safety net: rAF freezes in hidden tabs. The ambient fade is
// pre-scheduled on the audio clock so it still lands at 00:00, but finish()
// (chimes, status, sparks) needs a JS heartbeat too.
setInterval(() => { if (state === State.RUNNING) tickRunning(); }, 500);

// Catch up the moment the app returns to the foreground: tick immediately so
// a countdown that hit zero while we were frozen fires finish() — and its
// slipped-schedule catch-up sound — right away instead of on the next
// throttled interval. Only resume the context when it should be audible
// (DONE); mid-countdown it is parked on purpose so music keeps playing, and
// tickRunning()/armAudio() wake it if we're already inside the lead window.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (state === State.RUNNING) tickRunning();
  if (audio && state === State.DONE && audio.ctx.state !== "running") {
    audio.ctx.resume().catch(() => {});
  }
});

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  // --- timer progression ---
  if (state === State.RUNNING) tickRunning();

  // --- candle height + asymmetric melt ---
  const h = currentHeight();
  const p = effectiveProgress();
  candle.scale.y = h;
  // melt depth grows with burn progress from zero (pristine candle at idle),
  // capped so it never exceeds the wax
  const melt = Math.min(p * 0.6, h * 0.5);
  if (waxMat.userData.shader) {
    const u = waxMat.userData.shader.uniforms;
    u.uTopY.value = BASE_Y + h;
    u.uMelt.value = melt;
    u.uH.value = h;
    u.uBand.value = Math.min(0.9, h * 0.35);
    u.uGlowW.value = flameEnergy;
  }

  const topY = BASE_Y + h;
  const rimY = topY - melt * 0.5;
  const poolY = topY - melt * 0.6;
  rim.position.y = rimY;
  pool.position.y = poolY + 0.01;
  wick.position.y = poolY + 0.18;
  poolMat.uniforms.uTime.value = t;

  // melted rim + pool fade in as the first wax softens
  const meltIn = THREE.MathUtils.smoothstep(melt, 0.005, 0.1);
  rim.visible = pool.visible = meltIn > 0.001;
  rim.material.opacity = meltIn;
  rim.material.emissiveIntensity = 0.6 * flameEnergy; // molten glow only while lit
  poolMat.uniforms.uAlpha.value = meltIn;

  // --- flame energy (lit only while running; extinguish when idle or done).
  // ?burn= debug previews with the flame lit.
  const targetEnergy = state === State.RUNNING || (!Number.isNaN(DEBUG_BURN) && state !== State.DONE) ? 1 : 0;
  flameEnergy += (targetEnergy - flameEnergy) * Math.min(1, dt * 6);
  poolMat.uniforms.uGlow.value = flameEnergy;
  idleFill.intensity = 6 * (1 - flameEnergy);

  // --- flame placement + flicker ---
  const flick = 0.85 + Math.sin(t * 13.0) * 0.05 + Math.sin(t * 27.0) * 0.04 + (Math.random() - 0.5) * 0.06;
  const flameBase = poolY + 0.32;
  // anchored to the leaning wick tip, plus a slow wander and the fast sway
  flame.position.set(
    WICK_TIP_X + Math.sin(t * 0.37) * 0.05 + Math.sin(t * 3.1) * 0.03,
    flameBase + 0.62 * flameEnergy,
    Math.cos(t * 0.29) * 0.04 + Math.cos(t * 2.3) * 0.03
  );
  flame.scale.setScalar(Math.max(0.001, flameEnergy) * (0.9 + flick * 0.15));
  // billboard the flame toward camera (Y-locked)
  flame.rotation.y = Math.atan2(camera.position.x - flame.position.x, camera.position.z - flame.position.z);
  flameMat.uniforms.uTime.value = t;
  flameMat.uniforms.uIntensity.value = flameEnergy * flick;

  core.position.set(flame.position.x, flameBase + 0.12, flame.position.z);
  core.scale.setScalar(Math.max(0.001, flameEnergy) * (0.9 + flick * 0.2));
  coreMat.opacity = 0.9 * flameEnergy;

  // --- lighting responds to flame ---
  // dampen as the flame nears the floor, otherwise the ground blows out
  const floorDamp = THREE.MathUtils.clamp((flameBase + 0.25) / 2.5, 0.5, 1);
  const lightFlick = flameEnergy * (26 + flick * 10) * floorDamp;
  flameLight.position.set(flame.position.x, flameBase + 0.25, flame.position.z);
  flameLight.intensity = lightFlick;
  fill.intensity = 3.5 * flameEnergy;
  wick.material.emissiveIntensity = 1.4 * flameEnergy;
  haloMat.uniforms.uOpacity.value = 0.1 * flameEnergy;

  // --- wax drips ---
  updateDrips(p, rimY, flameEnergy);

  // --- sparks ---
  updateSparks(dt);
  if (state === State.RUNNING && flameEnergy > 0.4) {
    // emission rate proportional to burn speed. clamp so 5h barely sparks.
    const rate = THREE.MathUtils.clamp(burnRatePerSec() * 900, 0.3, 60); // sparks/sec
    sparkAccumulator += rate * dt;
    while (sparkAccumulator >= 1) {
      emitSpark(flame.position.x, flameBase + 0.2, flame.position.z, 1.0 + Math.min(2, burnRatePerSec() * 300));
      sparkAccumulator -= 1;
    }
  }

  // --- fog drift ---
  for (const u of mistUniforms) u.uTime.value = t;

  // --- gentle camera drift for life ---
  camera.position.x = camBaseX + Math.sin(t * 0.15) * 0.3;
  camera.position.y = camBaseY + Math.sin(t * 0.21) * 0.1;
  camera.position.z = camBaseZ;
  camera.lookAt(camTarget);

  composer.render();
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  updateFraming();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// init
updateTimeLabel(remainingMs);
animate();
