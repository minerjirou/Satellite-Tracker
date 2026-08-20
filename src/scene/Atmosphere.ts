import * as THREE from 'three';
import { EARTH_RADIUS } from '../lib/units';

/**
 * 大気のグロー。
 *
 * 地球より一回り大きい球を内側から見る(BackSide)ことで、
 * 地球の縁にだけ光が乗る。加算合成なので黒い部分は透けて何も描かれない。
 */

const vertexShader = /* glsl */ `
  out vec3 vWorldNormal;
  out vec3 vWorldPosition;

  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform vec3 uSunDirection;
  uniform vec3 uColor;
  uniform float uIntensity;

  in vec3 vWorldNormal;
  in vec3 vWorldPosition;

  out vec4 fragColor;

  void main() {
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    vec3 normal = normalize(vWorldNormal);

    // BackSide なので法線はカメラから見て外向き。内積の符号を反転して使う。
    float fresnel = pow(clamp(1.0 - abs(dot(normal, viewDirection)), 0.0, 1.0), 3.5);

    // 昼側の縁だけを光らせる。夜側にグローが出ると不自然。
    float sunFacing = smoothstep(-0.45, 0.35, dot(normal, normalize(uSunDirection)));

    float alpha = fresnel * sunFacing * uIntensity;
    fragColor = vec4(uColor * alpha, alpha);
  }
`;

export class Atmosphere {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
        uColor: { value: new THREE.Color(0.35, 0.6, 1.0) },
        uIntensity: { value: 1.15 },
      },
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });

    // 実際の大気は 100km 程度だが、見た目の印象を出すため少し厚めに取っている
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS * 1.035, 64, 32),
      this.material,
    );
    this.mesh.renderOrder = 1;
  }

  update(sunDirection: THREE.Vector3): void {
    this.material.uniforms.uSunDirection!.value.copy(sunDirection);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
