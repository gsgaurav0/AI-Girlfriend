import * as THREE from 'three';
import { attributeGetComponentCompat } from '../utils/attributeGetComponentCompat';
import { attributeSetComponentCompat } from '../utils/attributeSetComponentCompat';

/**
 * Traverse the given object and remove unnecessarily bound joints from every `THREE.SkinnedMesh`.
 *
 * Some environments like mobile devices have a lower limit of bones
 * and might be unable to perform mesh skinning with many bones.
 * This function might resolve such an issue.
 *
 * Also, this function might significantly improve the performance of mesh skinning.
 *
 * @param root Root object that will be traversed
 *
 * @deprecated `removeUnnecessaryJoints` is deprecated. Use `combineSkeletons` instead. `combineSkeletons` contributes more to the performance improvement. This function will be removed in the next major version.
 */
export function removeUnnecessaryJoints(
  root: THREE.Object3D,
  options?: {
    /**
     * If `true`, this function will compensate skeletons with dummy bones to keep the bone count same between skeletons.
     *
     * This option might be effective for the shader compilation performance that matters to the initial rendering time in WebGPURenderer,
     * especially when the model loaded has many materials and the dependent bone count is different between them.
     *
     * Consider this parameter as experimental. We might modify or delete this API without notice in the future.
     *
     * `false` by default.
     */
    experimentalSameBoneCounts?: boolean;
  },
): void {
  console.warn(
    'VRMUtils.removeUnnecessaryJoints: removeUnnecessaryJoints is deprecated. Use combineSkeletons instead. combineSkeletons contributes more to the performance improvement. This function will be removed in the next major version.',
  );

  const experimentalSameBoneCounts = options?.experimentalSameBoneCounts ?? false;

  // Traverse an entire tree, and collect all skinned meshes
  const skinnedMeshes: THREE.SkinnedMesh[] = [];

  root.traverse((obj) => {
    if (obj.type !== 'SkinnedMesh') {
      return;
    }

    skinnedMeshes.push(obj as THREE.SkinnedMesh);
  });

  // A map from meshes to new-to-old bone index map
  // some meshes might share a same skinIndex attribute, and this map also prevents to convert the attribute twice
  const attributeToBoneIndexMapMap: Map<
    THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    Map<number, number>
  > = new Map();

  // A maximum number of bones
  let maxBones = 0;

  // Iterate over all skinned meshes and remap bones for each skin index attribute
  for (const mesh of skinnedMeshes) {
    const geometry = mesh.geometry;
    const attribute = geometry.getAttribute('skinIndex');

    if (attributeToBoneIndexMapMap.has(attribute)) {
      continue;
    }

    const oldToNew = new Map<number, number>(); // map of old bone index vs. new bone index
    const newToOld = new Map<number, number>(); // map of new bone index vs. old bone index

    // create a new bone map
    for (let i = 0; i < attribute.count; i++) {
      for (let j = 0; j < attribute.itemSize; j++) {
        const oldIndex = attributeGetComponentCompat(attribute, i, j);
        let newIndex = oldToNew.get(oldIndex);

        // new skinIndex buffer
        if (newIndex == null) {
          newIndex = oldToNew.size;
          oldToNew.set(oldIndex, newIndex);
          newToOld.set(newIndex, oldIndex);
        }

        attributeSetComponentCompat(attribute, i, j, newIndex);
      }
    }

    // replace with new indices
    attribute.needsUpdate = true;

    // update boneList
    attributeToBoneIndexMapMap.set(attribute, newToOld);

    // update max bones count
    maxBones = Math.max(maxBones, oldToNew.size);
  }

  // Let's actually set the skeletons
  for (const mesh of skinnedMeshes) {
    const geometry = mesh.geometry;
    const attribute = geometry.getAttribute('skinIndex');
    const newToOld = attributeToBoneIndexMapMap.get(attribute)!;

    const bones: THREE.Bone[] = [];
    const boneInverses: THREE.Matrix4[] = [];

    // if `experimentalSameBoneCounts` is `true`, compensate skeletons with dummy bones to keep the bone count same between skeletons
    const nBones = experimentalSameBoneCounts ? maxBones : newToOld.size;

    for (let newIndex = 0; newIndex < nBones; newIndex++) {
      const oldIndex = newToOld.get(newIndex) ?? 0;

      bones.push(mesh.skeleton.bones[oldIndex]);
      boneInverses.push(mesh.skeleton.boneInverses[oldIndex]);
    }

    const skeleton = new THREE.Skeleton(bones, boneInverses);
    mesh.bind(skeleton, new THREE.Matrix4());
    //                  ^^^^^^^^^^^^^^^^^^^ transform of meshes should be ignored
    // See: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#skins
  }
}
