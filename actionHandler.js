import { loadMixamoAnimation } from './loadMixamoAnimation.js';
import { createVRMAnimationClip } from '@pixiv/three-vrm-animation';

/**
 * Handles dynamically loading and playing animation files (FBX or VRMA).
 * Keeps the logic separated from the main application flow.
 */
export async function handleAction(actionPath, currentVRM, currentMixer, loader) {
    if (!actionPath || !currentVRM || !currentMixer || !loader) {
        console.warn('[ActionHandler] Missing dependencies for action:', actionPath);
        return null;
    }

    console.log(`[ActionHandler] Triggered Action: ${actionPath}`);

    // Determine file type
    const fileType = actionPath.split('.').pop().toLowerCase();

    try {
        let clip = null;

        if (fileType === 'fbx') {
            console.log(`[ActionHandler] Loading Mixamo FBX: ${actionPath}`);
            // Use the existing Mixamo adapter 
            clip = await loadMixamoAnimation(actionPath, currentVRM);
        } else if (fileType === 'vrma') {
            console.log(`[ActionHandler] Loading VRM Animation: ${actionPath}`);
            // Use the VRMA loader
            const gltfVrma = await loader.loadAsync(actionPath);
            const vrmAnimation = gltfVrma.userData.vrmAnimations[0];
            clip = createVRMAnimationClip(vrmAnimation, currentVRM);
        } else {
            console.error(`[ActionHandler] Unsupported action file type: ${fileType}`);
            return null;
        }

        if (clip) {
            // Play the animation on the current mixer
            const newAction = currentMixer.clipAction(clip);
            return newAction;
        }
    } catch (err) {
        console.error(`[ActionHandler] Failed to load action ${actionPath}:`, err);
    }

    return null;
}
