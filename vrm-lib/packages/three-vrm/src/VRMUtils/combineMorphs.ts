import * as THREE from 'three';
import { VRMCore, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm-core';

/**
 * Traverse an entire tree and collect meshes.
 */
function collectMeshes(scene: THREE.Group): Set<THREE.Mesh> {
  const meshes = new Set<THREE.Mesh>();

  scene.traverse((obj) => {
    if (!(obj as any).isMesh) {
      return;
    }

    const mesh = obj as THREE.Mesh;
    meshes.add(mesh);
  });

  return meshes;
}

function combineMorph(
  positionAttributes: (THREE.BufferAttribute | THREE.InterleavedBufferAttribute)[],
  binds: Set<VRMExpressionMorphTargetBind>,
  morphTargetsRelative: boolean,
): THREE.BufferAttribute | THREE.InterleavedBufferAttribute {
  // if there is only one morph target and the weight is 1.0, we can use the original as-is
  if (binds.size === 1) {
    const bind = binds.values().next().value!;
    if (bind.weight === 1.0) {
      return positionAttributes[bind.index];
    }
  }

  const newArray = new Float32Array(positionAttributes[0].count * 3);
  let weightSum = 0.0;

  if (morphTargetsRelative) {
    weightSum = 1.0;
  } else {
    for (const bind of binds) {
      weightSum += bind.weight;
    }
  }

  for (const bind of binds) {
    const src = positionAttributes[bind.index];
    const weight = bind.weight / weightSum;

    for (let i = 0; i < src.count; i++) {
      newArray[i * 3 + 0] += src.getX(i) * weight;
      newArray[i * 3 + 1] += src.getY(i) * weight;
      newArray[i * 3 + 2] += src.getZ(i) * weight;
    }
  }

  const newAttribute = new THREE.BufferAttribute(newArray, 3);
  return newAttribute;
}

/**
 * A map from expression names to a set of morph target binds.
 */
type NameBindSetMap = Map<string, Set<VRMExpressionMorphTargetBind>>;

/**
 * Combine morph targets by VRM expressions.
 *
 * This function prevents crashes caused by the limitation of the number of morph targets, especially on mobile devices.
 *
 * @param vrm The VRM instance
 */
export function combineMorphs(vrm: VRMCore): void {
  const meshes = collectMeshes(vrm.scene);

  // Iterate over all expressions and check which morph targets are used
  const meshNameBindSetMapMap = new Map<THREE.Mesh, NameBindSetMap>();

  const expressionMap = vrm.expressionManager?.expressionMap;
  if (expressionMap != null) {
    for (const [expressionName, expression] of Object.entries(expressionMap)) {
      const bindsToDeleteSet = new Set<VRMExpressionMorphTargetBind>();
      for (const bind of expression.binds) {
        if (bind instanceof VRMExpressionMorphTargetBind) {
          if (bind.weight !== 0.0) {
            for (const mesh of bind.primitives) {
              let nameBindSetMap = meshNameBindSetMapMap.get(mesh);
              if (nameBindSetMap == null) {
                nameBindSetMap = new Map();
                meshNameBindSetMapMap.set(mesh, nameBindSetMap);
              }

              let bindSet = nameBindSetMap.get(expressionName);
              if (bindSet == null) {
                bindSet = new Set();
                nameBindSetMap.set(expressionName, bindSet);
              }

              bindSet.add(bind);
            }
          }
          bindsToDeleteSet.add(bind);
        }
      }

      for (const bind of bindsToDeleteSet) {
        expression.deleteBind(bind);
      }
    }
  }

  // Combine morphs
  for (const mesh of meshes) {
    const nameBindSetMap = meshNameBindSetMapMap.get(mesh);
    if (nameBindSetMap == null) {
      continue;
    }

    // prevent cloning morph attributes
    const originalMorphAttributes = mesh.geometry.morphAttributes;
    mesh.geometry.morphAttributes = {};

    const geometry = mesh.geometry.clone();
    mesh.geometry = geometry;
    const morphTargetsRelative = geometry.morphTargetsRelative;

    const hasPMorph = originalMorphAttributes.position != null;
    const hasNMorph = originalMorphAttributes.normal != null;

    const morphAttributes: typeof originalMorphAttributes = {};
    const morphTargetDictionary: typeof mesh.morphTargetDictionary = {};
    const morphTargetInfluences: typeof mesh.morphTargetInfluences = [];

    if (hasPMorph || hasNMorph) {
      if (hasPMorph) {
        morphAttributes.position = [];
      }
      if (hasNMorph) {
        morphAttributes.normal = [];
      }

      let i = 0;
      for (const [name, bindSet] of nameBindSetMap) {
        if (hasPMorph) {
          morphAttributes.position![i] = combineMorph(originalMorphAttributes.position!, bindSet, morphTargetsRelative);
        }
        if (hasNMorph) {
          morphAttributes.normal![i] = combineMorph(originalMorphAttributes.normal!, bindSet, morphTargetsRelative);
        }

        expressionMap?.[name].addBind(
          new VRMExpressionMorphTargetBind({
            index: i,
            weight: 1.0,
            primitives: [mesh],
          }),
        );

        morphTargetDictionary[name] = i;
        morphTargetInfluences.push(0.0);

        i++;
      }
    }

    geometry.morphAttributes = morphAttributes;
    mesh.morphTargetDictionary = morphTargetDictionary;
    mesh.morphTargetInfluences = morphTargetInfluences;
  }
}
