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
};

const PRESETS = [
  { label: "25s", ms: 25 * 1000 },
  { label: "1m", ms: 60 * 1000 },
  { label: "5m", ms: 5 * 60 * 1000 },
  { label: "15m", ms: 15 * 60 * 1000 },
  { label: "25m", ms: 25 * 60 * 1000 },
  { label: "1hr", ms: 60 * 60 * 1000 },
];

let activeChip = null;
PRESETS.forEach((p) => {
  const b = document.createElement("button");
  b.className = "chip";
  b.textContent = p.label;
  b.addEventListener("click", () => {
    setDuration(p.ms);
    setActiveChip(b);
    syncInputs(p.ms);
  });
  el.presets.appendChild(b);
  if (p.ms === totalMs) { b.classList.add("active"); activeChip = b; }
});

function setActiveChip(b) {
  if (activeChip) activeChip.classList.remove("active");
  activeChip = b;
  if (b) b.classList.add("active");
}

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
  const t = Math.round(ms / 1000);
  el.inH.value = Math.floor(t / 3600);
  el.inM.value = Math.floor((t % 3600) / 60);
  el.inS.value = t % 60;
}

function readInputs() {
  const h = Math.min(9, Math.max(0, parseInt(el.inH.value) || 0));
  const m = Math.min(59, Math.max(0, parseInt(el.inM.value) || 0));
  const s = Math.min(59, Math.max(0, parseInt(el.inS.value) || 0));
  return (h * 3600 + m * 60 + s) * 1000;
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
// Start / reset
// ---------------------------------------------------------------------------
function start() {
  if (state === State.RUNNING) return;
  if (remainingMs <= 0) remainingMs = totalMs;
  state = State.RUNNING;
  lastTick = performance.now();
  el.controls.setAttribute("hidden", "");
  el.resetBtn.removeAttribute("hidden");
  el.status.textContent = "Burning";
}

function reset() {
  state = State.IDLE;
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

// Keyboard: space toggles start/reset
addEventListener("keydown", (e) => {
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

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();
  const t = clock.elapsedTime;

  // --- timer progression ---
  if (state === State.RUNNING) {
    remainingMs -= now - lastTick;
    lastTick = now;
    if (remainingMs <= 0) { finish(); }
    updateTimeLabel(Math.max(0, remainingMs));
  }

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
