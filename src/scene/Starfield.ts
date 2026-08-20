import * as THREE from 'three';

/**
 * 背景の星空。テクスチャを持たず手続き的に作る。
 *
 * 実際の星表を使うほどの必然性はないので、明るさに偏りを持たせた
 * 一様分布で「それらしく」見せる。カメラのどの向きでも同じ密度になるよう、
 * 球面上に等方に散らしている。
 */

const vertexShader = /* glsl */ `
  in float aSize;
  in vec3 aColor;

  out vec3 vColor;

  void main() {
    vColor = aColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = aSize;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  in vec3 vColor;
  out vec4 fragColor;

  void main() {
    // 点を丸く、縁を柔らかく
    float d = length(gl_PointCoord - vec2(0.5));
    float alpha = smoothstep(0.5, 0.1, d);
    if (alpha < 0.01) discard;
    fragColor = vec4(vColor, alpha);
  }
`;

/** 決定的な擬似乱数。リロードのたびに星座が変わると落ち着かないため。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Starfield {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;

  constructor(count = 4000, radius = 400) {
    const random = mulberry32(20260821);

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);

    for (let i = 0; i < count; i += 1) {
      // 球面上の一様分布(高さを一様に取るのが正解。緯度を一様にすると極が混む)
      const u = random() * 2 - 1;
      const theta = random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const o = i * 3;
      positions[o] = radius * s * Math.cos(theta);
      positions[o + 1] = radius * u;
      positions[o + 2] = radius * s * Math.sin(theta);

      // 暗い星ほど多い分布にすると密度が自然に見える
      const brightness = 0.28 + 0.72 * random() ** 2.4;
      // 色温度をわずかにばらす(青白い星と赤い星)
      const tint = random();
      colors[o] = brightness * (0.85 + 0.15 * tint);
      colors[o + 1] = brightness * 0.95;
      colors[o + 2] = brightness * (1.0 - 0.12 * tint);

      sizes[i] = 0.6 + brightness * 2.0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, this.material);
    // 常に一番奥。カメラが動いても星は動かない(十分遠いので)。
    this.points.frustumCulled = false;
    this.points.renderOrder = -1;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
