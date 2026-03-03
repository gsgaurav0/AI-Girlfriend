import * as THREE from 'three';

// COMPAT: pre-r155
/**
 * A compat function for `BufferAttribute.setComponent()`.
 * `BufferAttribute.setComponent()` is introduced in r155.
 *
 * See: https://github.com/mrdoob/three.js/pull/24515
 */
export function attributeSetComponentCompat(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
  component: number,
  value: number,
): void {
  if ((attribute as any).setComponent) {
    (attribute as any).setComponent(index, component, value);
  } else {
    // Ref: https://github.com/mrdoob/three.js/pull/24515/files#diff-fd9bd9820242ad98f71b72535834e02a4500e4788ad62e618a172534b69af013
    if (attribute.normalized) {
      value = THREE.MathUtils.normalize(value, attribute.array as any);
    }
    attribute.array[index * attribute.itemSize + component] = value;
  }
}
