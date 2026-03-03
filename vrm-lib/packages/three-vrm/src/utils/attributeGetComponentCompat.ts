import * as THREE from 'three';

// COMPAT: pre-r155
/**
 * A compat function for `BufferAttribute.getComponent()`.
 * `BufferAttribute.getComponent()` is introduced in r155.
 *
 * See: https://github.com/mrdoob/three.js/pull/24515
 */
export function attributeGetComponentCompat(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
  component: number,
): number {
  if ((attribute as any).getComponent) {
    return (attribute as any).getComponent(index, component);
  } else {
    // Ref: https://github.com/mrdoob/three.js/pull/24515/files#diff-fd9bd9820242ad98f71b72535834e02a4500e4788ad62e618a172534b69af013
    let value = attribute.array[index * attribute.itemSize + component];
    if (attribute.normalized) {
      value = THREE.MathUtils.denormalize(value, attribute.array as any);
    }
    return value;
  }
}
