/**
 * Barge-in logic, driven by synthetic audio levels.
 *
 * The failure that matters is Jarvis interrupting ITSELF: the microphone hears
 * its own voice through the speakers, so a naive "any sound = interruption"
 * check fires on every sentence it speaks. These cases replay realistic RMS
 * sequences through the same echo-floor maths the listener uses.
 *
 *   npm run bargetest
 */
export {};

const BARGE_FACTOR = 1.6;
const BARGE_FRAMES = 6;
const BARGE_BLOCK_MS = 1500;
const MS_PER_FRAME = 32;
const SPEECH_THRESHOLD = 164; // representative value from the live mic
const ROOM_NOISE = 60; // idle noise floor the peak estimate starts from

/** Mirrors VoiceListener.watchForBargeIn, fed a sequence of frame levels. */
function simulate(levels: number[]): { fired: boolean; atFrame: number } {
  let echoPeak = ROOM_NOISE; // seeded from the room, never zero
  let bargeFrames = 0;

  for (let i = 0; i < levels.length; i++) {
    const rms = levels[i];

    const settling = i * MS_PER_FRAME < BARGE_BLOCK_MS;

    const bar = Math.max(echoPeak * BARGE_FACTOR, SPEECH_THRESHOLD);
    if (settling || rms < bar) {
      echoPeak = Math.max(rms, echoPeak * 0.995);
    }
    if (settling) continue;

    if (rms >= bar) {
      if (++bargeFrames >= BARGE_FRAMES) return { fired: true, atFrame: i };
    } else if (bargeFrames > 0) {
      bargeFrames--;
    }
  }
  return { fired: false, atFrame: -1 };
}

const rand = (base: number, spread: number) => base + (Math.random() - 0.5) * spread;
const frames = (n: number, gen: (i: number) => number) => Array.from({ length: n }, (_, i) => gen(i));

interface Case {
  name: string;
  levels: number[];
  expect: boolean;
}

const cases: Case[] = [
  {
    // Speaker playback: Jarvis's own voice is loud and continuous at the mic.
    name: "Jarvis speaking on open speakers — must NOT self-trigger",
    levels: frames(90, () => rand(650, 400)),
    expect: false,
  },
  {
    // Headphones: barely any echo.
    name: "Jarvis speaking on headphones — must NOT self-trigger",
    levels: frames(90, () => rand(70, 60)),
    expect: false,
  },
  {
    // Natural gaps between words dip toward silence.
    name: "speech with pauses between words — must NOT self-trigger",
    levels: frames(90, (i) => (i % 9 < 6 ? rand(600, 300) : rand(40, 30))),
    expect: false,
  },
  {
    // The real thing: user talks over quiet headphone playback.
    name: "user interrupts over headphones — MUST fire",
    levels: [...frames(55, () => rand(70, 40)), ...frames(30, () => rand(700, 200))],
    expect: true,
  },
  {
    // Over loud speaker playback the user has to be clearly louder.
    name: "user interrupts over speakers — MUST fire",
    levels: [...frames(55, () => rand(600, 200)), ...frames(30, () => rand(2600, 500))],
    expect: true,
  },
  {
    // Regression: `say` is slow to spawn, so the first ~400ms after Jarvis is
    // told to speak is silence. Timing the learning window from the request
    // rather than from real audio taught the floor "silence", after which its
    // own first word cleared the bar and it interrupted itself every sentence.
    name: "playback starts late (spawn lag) then Jarvis speaks — must NOT self-trigger",
    levels: [...frames(16, () => rand(8, 12)), ...frames(80, () => rand(1000, 500))],
    expect: false,
  },
  {
    // Same lag, but the user really does cut in afterwards.
    name: "playback starts late, then user interrupts — MUST fire",
    levels: [
      ...frames(30, () => rand(8, 12)),
      ...frames(40, () => rand(700, 250)),
      ...frames(30, () => rand(3000, 500)),
    ],
    expect: true,
  },
  {
    // Documents a known limitation rather than hiding it: `say` can take up to
    // 1.3s to make a sound, so an interruption inside the block window is
    // indistinguishable from playback finally starting. Use the reactor or the
    // hotkey to cut in that early.
    name: "user interrupts inside the block window — does NOT fire (known limit)",
    levels: [...frames(10, () => rand(70, 40)), ...frames(30, () => rand(900, 200))],
    expect: false,
  },
  {
    name: "single loud click — must NOT fire (too brief)",
    levels: [...frames(55, () => rand(70, 40)), 2400, 2500, ...frames(30, () => rand(70, 40))],
    expect: false,
  },
  {
    // Nothing may fire during the settling window, however loud.
    name: "loud onset inside the block window — must NOT fire",
    levels: frames(40, () => 3000),
    expect: false,
  },
];

let pass = 0;
let fail = 0;

console.log("\nBarge-in detection\n");
for (const c of cases) {
  // Repeat: the levels are randomised, so a flaky rule shows up as an
  // intermittent failure rather than passing once by luck.
  let fired = 0;
  const RUNS = 40;
  for (let r = 0; r < RUNS; r++) if (simulate(c.levels).fired) fired++;

  const consistent = c.expect ? fired === RUNS : fired === 0;
  if (consistent) {
    pass++;
    console.log(`  ✓ ${c.name}`);
  } else {
    fail++;
    console.log(`  ✗ ${c.name}\n      fired ${fired}/${RUNS}, expected ${c.expect ? RUNS : 0}`);
  }
}

console.log(`\n${pass}/${pass + fail} barge-in cases passed\n`);
process.exit(fail ? 1 : 0);
