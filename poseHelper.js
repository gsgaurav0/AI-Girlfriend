/**
 * poseHelper.js — Humanoid Pose Save / Restore / Reset API
 *
 * Uses the VRMHumanoid normalized pose system from @pixiv/three-vrm-core.
 *
 * All functions operate on the VRM's NORMALIZED bone rig, so the saved pose
 * data is portable between different VRM models regardless of how the artists
 * exported the skeleton.
 *
 * Usage (browser console):
 *   const pose = window.savePose();          // capture current pose as JSON
 *   window.restorePose(pose);                // apply saved pose back
 *   window.resetPose();                      // return to T-pose
 *
 * Or import directly:
 *   import { savePose, restorePose, resetPose } from './poseHelper.js';
 */

/**
 * Capture the VRM's current normalized humanoid pose.
 *
 * @param {import('@pixiv/three-vrm').VRM} vrm  The loaded VRM instance
 * @returns {Object}  A VRMPose object — JSON-serializable, portable across models
 */
export function savePose(vrm) {
    if (!vrm?.humanoid) {
        console.warn('[PoseHelper] savePose: VRM or humanoid not available.');
        return null;
    }
    const pose = vrm.humanoid.getNormalizedPose();
    console.log('[PoseHelper] Pose saved:', JSON.stringify(pose, null, 2));
    return pose;
}

/**
 * Apply a previously saved VRMPose to the humanoid.
 * This immediately snaps the normalized rig to the stored rotations/positions.
 *
 * @param {import('@pixiv/three-vrm').VRM} vrm   The loaded VRM instance
 * @param {Object}                          pose  A VRMPose object from savePose()
 */
export function restorePose(vrm, pose) {
    if (!vrm?.humanoid) {
        console.warn('[PoseHelper] restorePose: VRM or humanoid not available.');
        return;
    }
    if (!pose) {
        console.warn('[PoseHelper] restorePose: No pose provided.');
        return;
    }
    vrm.humanoid.setNormalizedPose(pose);
    console.log('[PoseHelper] Pose restored.');
}

/**
 * Reset the VRM's humanoid back to its default normalized rest pose (T-pose).
 *
 * @param {import('@pixiv/three-vrm').VRM} vrm  The loaded VRM instance
 */
export function resetPose(vrm) {
    if (!vrm?.humanoid) {
        console.warn('[PoseHelper] resetPose: VRM or humanoid not available.');
        return;
    }
    vrm.humanoid.resetNormalizedPose();
    console.log('[PoseHelper] Pose reset to T-pose.');
}

/**
 * Blend between two VRMPose objects by a given weight (0 = poseA, 1 = poseB).
 * Useful for creating smooth pose transitions manually.
 *
 * @param {Object} poseA   Start VRMPose
 * @param {Object} poseB   End VRMPose
 * @param {number} weight  Blend factor [0..1]
 * @returns {Object}       Interpolated VRMPose
 */
export function blendPoses(poseA, poseB, weight) {
    if (!poseA || !poseB) return poseA || poseB;
    const result = {};
    const bonesA = poseA.humanoidBones ?? {};
    const bonesB = poseB.humanoidBones ?? {};
    const allBones = new Set([...Object.keys(bonesA), ...Object.keys(bonesB)]);

    result.humanoidBones = {};
    allBones.forEach(boneName => {
        const a = bonesA[boneName];
        const b = bonesB[boneName];
        if (!a) { result.humanoidBones[boneName] = b; return; }
        if (!b) { result.humanoidBones[boneName] = a; return; }

        result.humanoidBones[boneName] = {};

        // Slerp rotation quaternions
        if (a.rotation && b.rotation) {
            const [ax, ay, az, aw] = a.rotation;
            const [bx, by, bz, bw] = b.rotation;
            const t = weight;
            const dot = ax * bx + ay * by + az * bz + aw * bw;
            const flip = dot < 0 ? -1 : 1;
            result.humanoidBones[boneName].rotation = [
                ax + t * (flip * bx - ax),
                ay + t * (flip * by - ay),
                az + t * (flip * bz - az),
                aw + t * (flip * bw - aw),
            ];
        }

        // Lerp position vectors
        if (a.position && b.position) {
            result.humanoidBones[boneName].position = [
                a.position[0] + t * (b.position[0] - a.position[0]),
                a.position[1] + t * (b.position[1] - a.position[1]),
                a.position[2] + t * (b.position[2] - a.position[2]),
            ];
        }
    });

    return result;
}
