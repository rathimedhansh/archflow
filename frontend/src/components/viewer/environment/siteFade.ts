import * as THREE from "three";

/**
 * Fades the surroundings into the studio backdrop with distance from the site centre, so the
 * ground never ends in a hard edge. Applied after tone mapping and colour-space conversion (at
 * the fog step), so the far colour is the backdrop gradient's own sRGB colour at that pixel.
 * Must match createBackdropTexture() in ../proceduralTextures.ts.
 */
const BACKDROP = { top: "#dfe4ea", mid: "#eef0f2", bottom: "#f7f6f3", midStop: 0.55 };

const srgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

export interface SiteFade {
  uniforms: {
    siteCenter: { value: THREE.Vector2 };
    siteFade: { value: THREE.Vector2 };
    siteViewport: { value: THREE.Vector2 };
    siteTop: { value: THREE.Vector3 };
    siteMid: { value: THREE.Vector3 };
    siteBottom: { value: THREE.Vector3 };
  };
  apply: (material: THREE.Material) => void;
  /** First person: fade into one haze colour (the sky's horizon); null restores the backdrop gradient. */
  setHaze: (hex: string | null) => void;
}

export function createSiteFade(): SiteFade {
  const uniforms = {
    siteCenter: { value: new THREE.Vector2() },
    siteFade: { value: new THREE.Vector2(30, 45) },
    siteViewport: { value: new THREE.Vector2(1, 1) },
    siteTop: { value: srgb(BACKDROP.top) },
    siteMid: { value: srgb(BACKDROP.mid) },
    siteBottom: { value: srgb(BACKDROP.bottom) },
  };
  const apply = (material: THREE.Material) => {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vSiteWorld;")
        .replace(
          "#include <project_vertex>",
          `#include <project_vertex>
  vec4 siteWorld = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    siteWorld = instanceMatrix * siteWorld;
  #endif
  vSiteWorld = ( modelMatrix * siteWorld ).xyz;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying vec3 vSiteWorld;
uniform vec2 siteCenter;
uniform vec2 siteFade;
uniform vec2 siteViewport;
uniform vec3 siteTop;
uniform vec3 siteMid;
uniform vec3 siteBottom;`,
        )
        .replace(
          "#include <fog_fragment>",
          `#include <fog_fragment>
  float siteK = smoothstep( siteFade.x, siteFade.y, distance( vSiteWorld.xz, siteCenter ) );
  float siteV = 1.0 - gl_FragCoord.y / siteViewport.y;
  vec3 siteBg = siteV < ${BACKDROP.midStop.toFixed(2)}
    ? mix( siteTop, siteMid, siteV / ${BACKDROP.midStop.toFixed(2)} )
    : mix( siteMid, siteBottom, ( siteV - ${BACKDROP.midStop.toFixed(2)} ) / ${(1 - BACKDROP.midStop).toFixed(2)} );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, siteBg, siteK );`,
        );
    };
    // One shader variant per base material type, shared by every surroundings material.
    material.customProgramCacheKey = () => "archflow-site-fade";
  };
  const setHaze = (hex: string | null) => {
    const top = hex ? srgb(hex) : srgb(BACKDROP.top);
    const mid = hex ? srgb(hex) : srgb(BACKDROP.mid);
    const bottom = hex ? srgb(hex) : srgb(BACKDROP.bottom);
    uniforms.siteTop.value.copy(top);
    uniforms.siteMid.value.copy(mid);
    uniforms.siteBottom.value.copy(bottom);
  };
  return { uniforms, apply, setHaze };
}
