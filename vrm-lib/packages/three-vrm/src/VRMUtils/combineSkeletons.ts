import * as THREE from 'three';
import { attributeGetComponentCompat } from '../utils/attributeGetComponentCompat';
import { attributeSetComponentCompat } from '../utils/attributeSetComponentCompat';

/**
 * Traverses the given object and combines the skeletons of skinned meshes.
 *
 * Each frame the bone matrices are computed for every skeleton. Combining skeletons
 * reduces the number of calculations needed, improving performance.
 *
 * @param root Root object that will be traversed
 */
export function combineSkeletons(root: THREE.Object3D): void {
  const skinnedMeshes = collectSkinnedMeshes(root);

  /** A set of geometries in the given {@link root}. */
  const geometries = new Set<THREE.BufferGeometry>();
  for (const mesh of skinnedMeshes) {
    // meshes sometimes share the same geometry
    // we don't want to touch the same attribute twice, so we clone the geometries
    if (geometries.has(mesh.geometry)) {
      mesh.geometry = shallowCloneBufferGeometry(mesh.geometry);
    }

    geometries.add(mesh.geometry);
  }

  // List all used skin indices for each skin index attribute
  /** A map: skin index attribute -> skin weight attribute -> used index set */
  const attributeUsedIndexSetMap = new Map<
    THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    Map<THREE.BufferAttribute | THREE.InterleavedBufferAttribute, Set<number>>
  >();

  for (const geometry of geometries) {
    const skinIndexAttr = geometry.getAttribute('skinIndex');
    const skinIndexMap = attributeUsedIndexSetMap.get(skinIndexAttr) ?? new Map();
    attributeUsedIndexSetMap.set(skinIndexAttr, skinIndexMap);

    const skinWeightAttr = geometry.getAttribute('skinWeight');
    const usedIndicesSet = listUsedIndices(skinIndexAttr, skinWeightAttr);
    skinIndexMap.set(skinWeightAttr, usedIndicesSet);
  }

  // List all bones and boneInverses for each meshes
  const meshBoneInverseMapMap = new Map<THREE.SkinnedMesh, Map<THREE.Bone, THREE.Matrix4>>();
  for (const mesh of skinnedMeshes) {
    const boneInverseMap = listUsedBones(mesh, attributeUsedIndexSetMap);
    meshBoneInverseMapMap.set(mesh, boneInverseMap);
  }

  // Group meshes by bone sets
  const groups: { boneInverseMap: Map<THREE.Bone, THREE.Matrix4>; meshes: Set<THREE.SkinnedMesh> }[] = [];
  for (const [mesh, boneInverseMap] of meshBoneInverseMapMap) {
    let foundMergeableGroup = false;
    for (const candidate of groups) {
      // check if the candidate group is mergeable
      const isMergeable = boneInverseMapIsMergeable(boneInverseMap, candidate.boneInverseMap);

      // if we found a mergeable group, add the mesh to the group
      if (isMergeable) {
        foundMergeableGroup = true;
        candidate.meshes.add(mesh);

        // add lacking bones to the group
        for (const [bone, boneInverse] of boneInverseMap) {
          candidate.boneInverseMap.set(bone, boneInverse);
        }

        break;
      }
    }

    // if we couldn't find a mergeable group, create a new group
    if (!foundMergeableGroup) {
      groups.push({ boneInverseMap, meshes: new Set([mesh]) });
    }
  }

  // prepare new skeletons for each group, and bind them to the meshes

  // the condition to use the same skin index attribute:
  // - the same skin index attribute
  // - and the skeleton is same
  // - and the bone set is same
  const cache = new Map<string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute>();
  const skinIndexDispatcher = new ObjectIndexDispatcher<THREE.BufferAttribute | THREE.InterleavedBufferAttribute>();
  const skeletonDispatcher = new ObjectIndexDispatcher<THREE.Skeleton>();
  const boneDispatcher = new ObjectIndexDispatcher<THREE.Bone>();

  for (const group of groups) {
    const { boneInverseMap, meshes } = group;

    // create a new skeleton
    const newBones = Array.from(boneInverseMap.keys());
    const newBoneInverses = Array.from(boneInverseMap.values());
    const newSkeleton = new THREE.Skeleton(newBones, newBoneInverses);
    const skeletonKey = skeletonDispatcher.getOrCreate(newSkeleton);

    // remap skin index attribute
    for (const mesh of meshes) {
      const skinIndexAttr = mesh.geometry.getAttribute('skinIndex');
      const skinIndexKey = skinIndexDispatcher.getOrCreate(skinIndexAttr);

      const bones = mesh.skeleton.bones;
      const bonesKey = bones.map((bone) => boneDispatcher.getOrCreate(bone)).join(',');

      // create a key from conditions and check if we already have a remapped skin index attribute
      const key = `${skinIndexKey};${skeletonKey};${bonesKey}`;
      let newSkinIndexAttr = cache.get(key);

      // if we don't have a remapped skin index attribute, create one
      if (newSkinIndexAttr == null) {
        newSkinIndexAttr = skinIndexAttr.clone();
        remapSkinIndexAttribute(newSkinIndexAttr, bones, newBones);
        cache.set(key, newSkinIndexAttr);
      }

      mesh.geometry.setAttribute('skinIndex', newSkinIndexAttr);
    }

    // bind the new skeleton to the meshes
    for (const mesh of meshes) {
      mesh.bind(newSkeleton, new THREE.Matrix4());
    }
  }
}

/**
 * Traverse an entire tree and collect skinned meshes.
 */
function collectSkinnedMeshes(scene: THREE.Object3D): Set<THREE.SkinnedMesh> {
  const skinnedMeshes = new Set<THREE.SkinnedMesh>();

  scene.traverse((obj) => {
    if (!(obj as any).isSkinnedMesh) {
      return;
    }

    const skinnedMesh = obj as THREE.SkinnedMesh;
    skinnedMeshes.add(skinnedMesh);
  });

  return skinnedMeshes;
}

/**
 * List all skin indices used by the given geometry.
 * If the skin weight is 0, the index won't be considered as used.
 * @param skinIndexAttr The skin index attribute to list used indices
 * @param skinWeightAttr The skin weight attribute corresponding to the skin index attribute
 */
function listUsedIndices(
  skinIndexAttr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  skinWeightAttr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): Set<number> {
  const usedIndices = new Set<number>();

  for (let i = 0; i < skinIndexAttr.count; i++) {
    for (let j = 0; j < skinIndexAttr.itemSize; j++) {
      const index = attributeGetComponentCompat(skinIndexAttr, i, j);
      const weight = attributeGetComponentCompat(skinWeightAttr, i, j);

      if (weight !== 0) {
        usedIndices.add(index);
      }
    }
  }

  return usedIndices;
}

/**
 * List all bones used by the given skinned mesh.
 * @param mesh The skinned mesh to list used bones
 * @param attributeUsedIndexSetMap A map from skin index attribute to the set of used skin indices
 * @returns A map from used bone to the corresponding bone inverse matrix
 */
function listUsedBones(
  mesh: THREE.SkinnedMesh,
  attributeUsedIndexSetMap: Map<
    THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    Map<THREE.BufferAttribute | THREE.InterleavedBufferAttribute, Set<number>>
  >,
): Map<THREE.Bone, THREE.Matrix4> {
  const boneInverseMap = new Map<THREE.Bone, THREE.Matrix4>();

  const skeleton = mesh.skeleton;

  const geometry = mesh.geometry;
  const skinIndexAttr = geometry.getAttribute('skinIndex');
  const skinWeightAttr = geometry.getAttribute('skinWeight');
  const skinIndexMap = attributeUsedIndexSetMap.get(skinIndexAttr);
  const usedIndicesSet = skinIndexMap?.get(skinWeightAttr);

  if (!usedIndicesSet) {
    throw new Error(
      'Unreachable. attributeUsedIndexSetMap does not know the skin index attribute or the skin weight attribute.',
    );
  }

  for (const index of usedIndicesSet) {
    boneInverseMap.set(skeleton.bones[index], skeleton.boneInverses[index]);
  }

  return boneInverseMap;
}

/**
 * Check if the given bone inverse map is mergeable to the candidate bone inverse map.
 * @param toCheck The bone inverse map to check
 * @param candidate The candidate bone inverse map
 * @returns True if the bone inverse map is mergeable to the candidate bone inverse map
 */
function boneInverseMapIsMergeable(
  toCheck: Map<THREE.Bone, THREE.Matrix4>,
  candidate: Map<THREE.Bone, THREE.Matrix4>,
): boolean {
  for (const [bone, boneInverse] of toCheck.entries()) {
    // if the bone is in the candidate group and the boneInverse is different, it's not mergeable
    const candidateBoneInverse = candidate.get(bone);
    if (candidateBoneInverse != null) {
      if (!matrixEquals(boneInverse, candidateBoneInverse)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Remap the skin index attribute from old bones to new bones.
 * This function modifies the given attribute in place.
 * @param attribute The skin index attribute to remap
 * @param oldBones The bone array that the attribute is currently using
 * @param newBones The bone array that the attribute will be using
 */
function remapSkinIndexAttribute(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  oldBones: THREE.Bone[],
  newBones: THREE.Bone[],
): void {
  // a map from bone to old index
  const boneOldIndexMap = new Map<THREE.Bone, number>();
  for (const bone of oldBones) {
    boneOldIndexMap.set(bone, boneOldIndexMap.size);
  }

  // a map from old skin index to new skin index
  const oldToNew = new Map<number, number>();
  for (const [i, bone] of newBones.entries()) {
    const oldIndex = boneOldIndexMap.get(bone)!;
    oldToNew.set(oldIndex, i);
  }

  // replace the skin index attribute with new indices
  for (let i = 0; i < attribute.count; i++) {
    for (let j = 0; j < attribute.itemSize; j++) {
      const oldIndex = attributeGetComponentCompat(attribute, i, j);
      const newIndex = oldToNew.get(oldIndex)!;
      attributeSetComponentCompat(attribute, i, j, newIndex);
    }
  }

  attribute.needsUpdate = true;
}

// https://github.com/mrdoob/three.js/blob/r170/test/unit/src/math/Matrix4.tests.js#L12
function matrixEquals(a: THREE.Matrix4, b: THREE.Matrix4, tolerance?: number) {
  tolerance = tolerance || 0.0001;
  if (a.elements.length != b.elements.length) {
    return false;
  }

  for (let i = 0, il = a.elements.length; i < il; i++) {
    const delta = Math.abs(a.elements[i] - b.elements[i]);
    if (delta > tolerance) {
      return false;
    }
  }

  return true;
}

class ObjectIndexDispatcher<T> {
  private _objectIndexMap = new Map<T, number>();
  private _index = 0;

  public get(obj: T): number | undefined {
    return this._objectIndexMap.get(obj);
  }

  public getOrCreate(obj: T): number {
    let index = this._objectIndexMap.get(obj);
    if (index == null) {
      index = this._index;
      this._objectIndexMap.set(obj, index);
      this._index++;
    }

    return index;
  }
}

/**
 * Shallow clone a buffer geometry.
 * `BufferGeometry#clone` does a deep clone that also copies the attributes.
 * We want to shallow clone the geometry to avoid copying the attributes.
 *
 * See: https://github.com/mrdoob/three.js/blob/r175/src/core/BufferGeometry.js#L1330
 */
function shallowCloneBufferGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const clone = new THREE.BufferGeometry();

  clone.name = geometry.name;

  clone.setIndex(geometry.index);

  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    clone.setAttribute(name, attribute);
  }

  for (const [key, morphAttributes] of Object.entries(geometry.morphAttributes)) {
    const attributeName = key as keyof typeof geometry.morphAttributes;
    clone.morphAttributes[attributeName] = morphAttributes.concat();
  }
  clone.morphTargetsRelative = geometry.morphTargetsRelative;

  clone.groups = [];
  for (const group of geometry.groups) {
    clone.addGroup(group.start, group.count, group.materialIndex);
  }

  clone.boundingSphere = geometry.boundingSphere?.clone() ?? null;
  clone.boundingBox = geometry.boundingBox?.clone() ?? null;

  clone.drawRange.start = geometry.drawRange.start;
  clone.drawRange.count = geometry.drawRange.count;

  clone.userData = geometry.userData;

  return clone;
}
