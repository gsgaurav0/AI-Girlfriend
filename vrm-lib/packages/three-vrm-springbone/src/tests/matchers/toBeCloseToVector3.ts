import * as THREE from 'three';
import { expect } from 'vitest';

interface CustomMatchers<R = unknown> {
  toBeCloseToVector3(expected: THREE.Vector3, precision?: number): R;
}

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Matchers<T = any> extends CustomMatchers<T> {}
}

function vector3ToString(vector: THREE.Vector3): string {
  return `Vector3(${vector.x.toFixed(3)}, ${vector.y.toFixed(3)}, ${vector.z.toFixed(3)})`;
}

expect.extend({
  toBeCloseToVector3(received: THREE.Vector3, expected: THREE.Vector3, precision = 2) {
    const expectedDiff = Math.pow(10.0, -precision) / 2;

    const diff = received.distanceTo(expected);

    if (expectedDiff < diff) {
      return {
        pass: false,
        message: () => `The received vector doesn't match to the expected vector:
    expected ${vector3ToString(expected)}, received ${vector3ToString(received)}`,
      };
    } else {
      return {
        pass: true,
        message: () => 'The received vector approximately matches to the expected vector',
      };
    }
  },
});
