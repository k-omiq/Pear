// ===== Whether an SFX gesture is under way =====
//
// A drag on the SFX handles, or a slider of the SFX panel held down, writes
// the box's recipe on every frame. The box itself must follow every frame;
// the panel's pictures (the stage, the type and variation cards) need not,
// and painting them each frame is most of a drag's cost. So the gesture says
// it is live here, and the panel paints once when it ends.
export const sfxLive = $state({ on: false });

// A box whose words the SFX window is to take the typing for: set when a
// sound is drawn (Canvas.svelte), so the next keys replace the stock sound;
// the window focuses its Sound field and clears it.
export const sfxAsk = $state({ typeFor: null });
