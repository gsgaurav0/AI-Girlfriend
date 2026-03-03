import * as THREE from 'three';
import { expect } from 'vitest';

interface CustomMatchers<R = unknown> {
  toBeCloseToQuaternion(expected: THREE.Quaternion, precision?: number): R;
}

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Matchers<T = any> extends CustomMatchers<T> {}
}

function quatToString(quat: THREE.Quaternion): string {
  return `Quaternion(${quat.x.toFixed(3)}, ${quat.y.toFixed(3)}, ${quat.z.toFixed(3)}; ${quat.w.toFixed(3)})`;
}

expect.extend({
  toBeCloseToQuaternion(received: THREE.Quaternion, expected: THREE.Quaternion, precision = 2) {
    const expectedDiff = Math.pow(10.0, -precision) / 2;

    const dot = received.dot(expected);
    const diff = 1.0 - Math.abs(dot);

    if (expectedDiff < diff) {
      return {
        pass: false,
        message: () => `The received quaternion doesn't match to the expected quaternion:
    expected ${quatToString(expected)}, received ${quatToString(received)}`,
      };
    } else {
      return {
        pass: true,
        message: () => 'The received quaternion approximately matches to the expected quaternion',
      };
    }
  },
});
