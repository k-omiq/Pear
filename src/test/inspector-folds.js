import { fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

// The Effects tab keeps what a plain look never needs in folds: each
// effect's "More" (`moreFold` in Inspector.svelte) and the bevel's Contour
// and Texture. A test that reaches past them opens every closed one first.
const FOLDS = /more options$|^Bevel contour$|^Bevel texture$/;
export async function openFxFolds(view) {
  for (let round = 0; round < 3; round++) {
    const closed = view.queryAllByRole('button', { name: FOLDS }).filter((b) => b.getAttribute('aria-expanded') === 'false');
    if (!closed.length) return;
    for (const b of closed) await fireEvent.click(b);
    await tick();
  }
}
