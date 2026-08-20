import * as THREE from 'three';
import { EARTH_RADIUS } from '../lib/units';

/**
 * 昼夜の境目を持つ地球。
 *
 * メッシュは ECF(地球固定)の向きで作り、GMST の分だけ Y 軸まわりに回して
 * ECI(慣性)のシーンに置く。太陽方向は ECI で与えられるので、
 * 法線をワールド空間に変換してから内積を取る必要がある。
 */

const vertexShader = /* glsl */ `
  out vec2 vUv;
  out vec3 vWorldNormal;
  out vec3 vViewDirection;

  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vViewDirection = normalize(cameraPosition - worldPosition.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uDayMap;
  uniform sampler2D uNightMap;
  uniform vec3 uSunDirection;
  uniform float uNightIntensity;

  in vec2 vUv;
  in vec3 vWorldNormal;
  in vec3 vViewDirection;

  out vec4 fragColor;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    float lambert = dot(normal, normalize(uSunDirection));

    // ターミネータは大気の散乱で数百 km にわたってぼやける。
    // 幾何学的な境界(lambert = 0)より少し夜側まで明るさを伸ばすと自然に見える。
    float dayAmount = smoothstep(-0.14, 0.20, lambert);

    vec3 dayColor = texture(uDayMap, vUv).rgb;
    vec3 nightColor = texture(uNightMap, vUv).rgb;

    // 昼側: 太陽高度による明暗。完全な影でも僅かに地球照が残る。
    vec3 lit = dayColor * (0.04 + 0.96 * clamp(lambert, 0.0, 1.0));

    // 夜側: 都市光。昼側では完全に見えなくする。
    vec3 night = nightColor * uNightIntensity * (1.0 - dayAmount);

    vec3 color = mix(vec3(0.0), lit, dayAmount) + night;

    // 縁に薄く空気の青を足して、球が切り紙のように見えるのを防ぐ
    float rim = pow(1.0 - clamp(dot(normal, normalize(vViewDirection)), 0.0, 1.0), 3.0);
    color += vec3(0.30, 0.52, 0.95) * rim * 0.30 * max(dayAmount, 0.08);

    fragColor = vec4(color, 1.0);
  }
`;

export class Earth {
  readonly mesh: THREE.Mesh;
  /** 地球と一緒に回るもの(地上軌跡・観測地マーカー)を入れるグループ */
  readonly surfaceGroup: THREE.Group;
  private readonly material: THREE.ShaderMaterial;
  private readonly textures: THREE.Texture[] = [];

  constructor(loader: THREE.TextureLoader, onProgress?: (loaded: number, total: number) => void) {
    let loaded = 0;
    const total = 2;
    const track = (texture: THREE.Texture) => {
      loaded += 1;
      onProgress?.(loaded, total);
      return texture;
    };

    const dayMap = loader.load('/textures/earth_day.jpg', track);
    const nightMap = loader.load('/textures/earth_night.jpg', track);
    for (const texture of [dayMap, nightMap]) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      this.textures.push(texture);
    }

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uDayMap: { value: dayMap },
        uNightMap: { value: nightMap },
        uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
        uNightIntensity: { value: 1.5 },
      },
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS, 128, 64), this.material);
    this.mesh.renderOrder = 0;

    this.surfaceGroup = new THREE.Group();
    this.mesh.add(this.surfaceGroup);
  }

  /**
   * @param sunDirection ECI(シーン座標)での太陽方向の単位ベクトル
   * @param gmst グリニッジ平均恒星時(ラジアン)
   */
  update(sunDirection: THREE.Vector3, gmst: number): void {
    this.material.uniforms.uSunDirection!.value.copy(sunDirection);
    this.mesh.rotation.y = gmst;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    for (const texture of this.textures) texture.dispose();
  }
}
