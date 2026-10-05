// Each player's notes in the computer game -- what they have worked out about themselves so far
// ("not human", "from a cartoon") -- shown to everyone, live.
//
// Pure, like ./guessing.js. The socket layer (./index.js) stores and broadcasts what this allows.
//
// Notes are the one thing a player WRITES that every other player READS, which makes them the one
// way to hand somebody their own answer: "Sam is Pikachu", typed as a reminder, is on Sam's screen
// a second later. So a note that names a character someone is still guessing is refused, with the
// reason, and nobody sees it. Matched by whole words, in the forms the guess-checker accepts as
// the whole name (src/compendium/answers.js) plus a name's own distinctive words ("Sasuke"), so
// "Leo" does not trip on "leopard". It errs toward refusing: a writer who meant something else
// rephrases, while a leak cannot be taken back.

const { answerForms, wordsOf } = require('../../compendium/answers');

const NOTES_MAX = 500;

// The contiguous runs of words in a note, flattened the way answer forms are -- so the full name,
// a nickname or the part before a comma is found wherever it sits in a sentence.
function runsOf(words, maxLen = 6) {
  const runs = new Set();
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let j = i; j < Math.min(words.length, i + maxLen); j++) {
      joined += words[j];
      runs.add(joined);
    }
  }
  return runs;
}

/** Whether `text` names `name`, by any form a player would recognise. */
function names(text, name) {
  const words = wordsOf(text);
  if (!words.length) return false;
  const runs = runsOf(words);
  const forms = answerForms(name);
  if (forms.exact.some((k) => k.length >= 3 && runs.has(k))) return true;
  // A name's own words, when distinctive enough to stand for it: "Sasuke" for Sasuke Uchiha.
  return forms.words.some((w) => w.length >= 4 && words.includes(w));
}

/**
 * @returns {{ok: true, text: string} | {ok: false, error: string}}
 */
function setNotes(game, playerId, text) {
  if (!game || !game.turnOrder.includes(playerId)) return { ok: false, error: 'Only players in this game have notes.' };
  const clean = String(text ?? '').replace(/\r/g, '').slice(0, NOTES_MAX);
  for (const id of game.turnOrder) {
    if (id === playerId) continue;
    // Revealed already -- they got it, gave up or left -- so there is nothing left to give away.
    if (game.finished || game.finishedBy.has(id) || game.surrendered.has(id)) continue;
    if (names(clean, game.headByPlayer[id].name)) {
      return { ok: false, error: "That names someone else's character, and everyone can see your notes. Not saved." };
    }
  }
  (game.deskNotes ??= new Map()).set(playerId, clean);
  return { ok: true, text: clean };
}

const notesOf = (game, playerId) => game?.deskNotes?.get(playerId) ?? '';

module.exports = { setNotes, notesOf, names, NOTES_MAX };
