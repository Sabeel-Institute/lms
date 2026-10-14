/**
 * The narration as `tts.py` reads it: every step's line, with the id its
 * WAV is saved under (`<film>-<step>`, steps counted from 01).
 *
 *   node scripts/tutorials/lines.mjs > lines.json
 */
import { TUTORIALS } from './tutorials.mjs';

export const lineId = (filmId, index) => `${filmId}-${String(index + 1).padStart(2, '0')}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const lines = TUTORIALS.flatMap((t) => t.steps.map((s, i) => ({ id: lineId(t.id, i), text: s.say })));
  process.stdout.write(`${JSON.stringify(lines, null, 2)}\n`);
}
