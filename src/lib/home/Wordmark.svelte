<script>
  // The app's name as bubble letters, drawn here rather than set in a font.
  //
  // Each letter is a few centre lines stroked thick with round caps and joins,
  // so every end and corner comes out puffy. Letters overlap a little and tilt
  // a few degrees each way, like stickers. Drawn per letter in three layers: a
  // ring in the page colour, which keeps a letter apart from the one it sits
  // on; the body in the theme's accent; a small shine at the top left. One
  // soft shadow under the whole word sits on the ground and stays put while
  // the letters hop on hover.
  //
  // Geometry is in viewBox units: x-height from y 18 to 42, bowls of radius 12
  // round y 30, strokes 10 wide.
  const W = 10;
  const THIN = 4; // the e's bar, so its eye stays open
  const RING = 5;

  const bowl = (cx) => `M${cx - 12} 30a12 12 0 1 1 24 0a12 12 0 1 1 -24 0`;
  // A short arc just outside a bowl's top-left, from 235 to 265 degrees.
  const shine = (cx) => `M${cx - 7.75} 18.94A13.5 13.5 0 0 1 ${cx - 1.18} 16.55`;

  const LETTERS = [
    { cx: 19, tilt: -5, strokes: [{ d: 'M7 56V18' }, { d: bowl(19) }], shine: shine(19) },
    {
      cx: 47,
      tilt: 4,
      // The bowl runs from the bar's right end, up and round, and stops 65
      // degrees below it so the mouth stays open.
      strokes: [{ d: 'M59 30A12 12 0 1 0 52.07 40.88' }, { d: 'M36 32H58', thin: true }],
      shine: shine(47),
    },
    { cx: 76, tilt: -3, strokes: [{ d: bowl(76) }, { d: 'M88 18V42' }], shine: shine(76) },
    { cx: 104, tilt: 6, strokes: [{ d: 'M99 42V31C99 23 104 18 112 18' }], shine: 'M97.5 36V31' },
  ];

  const width = (s) => (s.thin ? THIN : W);
  const tilt = (l) => `rotate(${l.tilt} ${l.cx} 30)`;
</script>

<svg class="wordmark" viewBox="-1 9 122 56" role="img" aria-label="Pear">
  <g class="shadow" transform="translate(0 2.6)">
    {#each LETTERS as l}
      <g transform={tilt(l)}>
        {#each l.strokes as s}<path d={s.d} stroke-width={width(s)} />{/each}
      </g>
    {/each}
  </g>
  {#each LETTERS as l, i}
    <g transform={tilt(l)}>
      <g class="letter" style="animation-delay:{i * 55}ms">
        {#each l.strokes as s}<path class="ring" d={s.d} stroke-width={width(s) + RING} />{/each}
        {#each l.strokes as s}<path class="body" d={s.d} stroke-width={width(s)} />{/each}
        <path class="shine" d={l.shine} />
      </g>
    </g>
  {/each}
</svg>

<style>
  .wordmark {
    display: block;
    height: 30px;
    width: auto;
    overflow: visible;
  }
  path {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .shadow { stroke: var(--accent); opacity: .2; }
  .ring { stroke: var(--bg); }
  .body { stroke: var(--accent); }
  /* Always white: on a pale accent it fades out rather than reading as a dent. */
  .shine { stroke: #fff; stroke-width: 2.6; opacity: .6; }

  .wordmark:hover .letter { animation: hop .5s cubic-bezier(.3, .7, .4, 1.5) both; }
  @keyframes hop {
    0%, 100% { transform: translateY(0); }
    40% { transform: translateY(-3.5px); }
  }
  @media (prefers-reduced-motion: reduce) {
    .wordmark:hover .letter { animation: none; }
  }
</style>
