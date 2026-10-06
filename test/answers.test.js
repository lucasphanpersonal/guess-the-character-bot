// The guess-checker (src/compendium/answers.js), against names as they really are in the
// compendium. A wrong CORRECT ends somebody's turn or round for no reason they can see, so most of
// these pin what must NOT be accepted outright; CLOSE is the safe place for anything uncertain.

const { assert } = require('./harness');
const { judgeGuess, editDistance, maskNameWords, poolIndex } = require('../src/compendium/answers');

// The Naruto cast, trimmed: enough to make "Uzumaki" ambiguous and "Sasuke" not.
const NARUTO = ['Naruto Uzumaki', 'Sasuke Uchiha', 'Itachi Uchiha', 'Kushina Uzumaki', 'Kakashi Hatake', 'Sakura Haruno'];
// singleWords on, as the laptop guessing game will run it; the drawing game's setting has its own
// test below.
const verdict = (guess, name, others = []) => judgeGuess(guess, name, { others, singleWords: true }).verdict;

function eachIs(expected, cases) {
  for (const [guess, name, others] of cases) {
    assert.equal(verdict(guess, name, others), expected, `"${guess}" for "${name}" should be ${expected}`);
  }
}

module.exports = {
  'the name itself, however it is typed'() {
    eachIs('correct', [
      ['Naruto Uzumaki', 'Naruto Uzumaki'],
      ['naruto uzumaki', 'Naruto Uzumaki'],
      ['spiderman', 'Spider-Man'],
      ['Spider Man', 'Spider-Man'],
      ['pokemon trainer', 'Pokémon Trainer'],
      ['flabebe', 'Flabébé'],
      ['kaisa', "Kai'Sa"],
      ['f(x)', 'f(x)'],
    ]);
  },

  'the words in another order'() {
    eachIs('correct', [
      ['Uzumaki Naruto', 'Naruto Uzumaki'],
      ['Jean-Pierre Polnareff', 'Polnareff Jean-Pierre'],
    ]);
  },

  'a qualifier, an article and a nickname are all optional'() {
    eachIs('correct', [
      ['Zabimaru', 'Zabimaru (Female)'],
      ['Joe Jackson', 'Joe Jackson (talent manager)'],
      ['Major', 'The Major'],
      ['the joker', 'Joker'],
      ['Tails', 'Miles "Tails" Prower'],
      ['Miles Prower', 'Miles "Tails" Prower'],
      ['Soap', 'John "Soap" MacTavish'],
      ['Weird Al', '"Weird Al" Yankovic'],
      ['Catherine', 'Catherine, Princess of Wales'],
      ['Morton Koopa', 'Morton Koopa, Jr.'],
    ]);
  },

  'one word stands for the name only when no one else in the pool has it'() {
    eachIs('correct', [
      ['Sasuke', 'Sasuke Uchiha', NARUTO],
      ['Kakashi', 'Kakashi Hatake', NARUTO],
      ['Luffy', 'Monkey D. Luffy', ['Monkey D. Luffy', 'Roronoa Zoro', 'Portgas D. Ace']],
    ]);
    eachIs('close', [
      ['Uzumaki', 'Naruto Uzumaki', NARUTO],
      ['Uchiha', 'Sasuke Uchiha', NARUTO],
      // With no pool to check against, a single word is never trusted.
      ['Sasuke', 'Sasuke Uchiha', []],
    ]);
  },

  // Guessing at a drawing, people type what they SEE: "Combat" at a soldier is not a guess that
  // it is Combat Carl, and must not end the round.
  'a single word is only close unless the game opts in'() {
    const opts = { others: ['Woody', 'Buzz Lightyear', 'Combat Carl'] };
    assert.equal(judgeGuess('Combat', 'Combat Carl', opts).verdict, 'close');
    assert.equal(judgeGuess('Combat', 'Combat Carl', { ...opts, singleWords: true }).verdict, 'correct');
    assert.equal(judgeGuess('Combat Carl', 'Combat Carl', opts).verdict, 'correct', 'the whole name always counts');
  },

  "a word before a possessive 'no' or 'of' names somebody else"() {
    // Sendou no Sobo is Sendou's grandmother.
    assert.notEqual(verdict('Sendou', 'Sendou no Sobo', ['Ippo Makunouchi', 'Sendou Takeshi']), 'correct');
    assert.notEqual(verdict('Sobo', 'Sendou no Sobo', ['Ippo Makunouchi']), 'correct');
  },

  'a title stripped off is only close -- some titles are the name'() {
    eachIs('close', [
      ['Leia', 'Princess Leia'],
      ['America', 'Captain America'],
      ['Mime', 'Mr. Mime'],
      ['Tarkin', 'Grand Moff Tarkin'],
      ['Jack Sparrow', 'Captain Jack Sparrow'],
      ['Sparrow', 'Captain Jack Sparrow'],
    ]);
    // ...and even a pool where nobody else is called America does not make it correct.
    assert.equal(verdict('America', 'Captain America', ['Iron Man', 'Thor']), 'close');
    assert.equal(verdict('Captain America', 'Captain America'), 'correct');
  },

  'words that describe rather than name never stand in'() {
    eachIs('wrong', [
      ['Wales', 'Catherine, Princess of Wales'],
      ['Princess', 'Catherine, Princess of Wales'],
      ['Holy Roman Emperor', 'Leopold I, Holy Roman Emperor'],
      ['D', 'Monkey D. Luffy'],
    ]);
    assert.notEqual(verdict('Captain', 'Captain America', ['Iron Man']), 'correct');
    assert.notEqual(verdict('Edward', 'Wong Hau Pepelu Tivrusky IV Edward', ['Spike Spiegel']), 'correct');
  },

  'a typo or two is close, never correct'() {
    eachIs('close', [
      ['Sasuek Uchiha', 'Sasuke Uchiha'],
      ['Naruto Uzumak', 'Naruto Uzumaki'],
      ['Pikahcu', 'Pikachu'],
      ['Kakshi', 'Kakashi Hatake', NARUTO],
    ]);
  },

  'short names get no typo allowance -- they are one letter apart from each other'() {
    eachIs('wrong', [
      ['Al', 'Ed'],
      ['Bo', 'Bob'],
      ['Ami', 'Amy'],
    ]);
  },

  'the right name with more besides is close'() {
    eachIs('close', [
      ['Monkey D Luffy', 'Luffy'],
      ['Naruto Uzumaki Shippuden', 'Naruto Uzumaki'],
    ]);
  },

  'someone else entirely is wrong'() {
    eachIs('wrong', [
      ['Sasuke', 'Naruto Uzumaki', NARUTO],
      ['Batman', 'Superman'],
      ['', 'Superman'],
      ['   ', 'Superman'],
      ['!!!', 'Superman'],
    ]);
  },

  'the matched form comes back, for a game to show'() {
    assert.deepEqual(judgeGuess('tails', 'Miles "Tails" Prower'), { verdict: 'correct', as: 'tails' });
    assert.deepEqual(judgeGuess('Pikahcu', 'Pikachu'), { verdict: 'close', as: 'pikachu' });
    assert.deepEqual(judgeGuess('Batman', 'Superman'), { verdict: 'wrong', as: null });
  },

  'a title loses every word that names the character, and keeps its punctuation'() {
    assert.equal(maskNameWords('Super Mario Bros.', 'Mario'), 'Super _____ Bros.');
    assert.equal(maskNameWords('The Simpsons', 'Homer Simpson'), 'The ________', 'a plural still spells it');
    assert.equal(maskNameWords('Spider-Man: Into the Spider-Verse', 'Spider-Man'), '______-___: Into the Spider-Verse');
    assert.equal(maskNameWords('Ed, Edd n Eddy', 'Ed'), '__, Edd n Eddy', 'a short word goes when it IS the word');
    assert.equal(maskNameWords('Amélie', 'Amelie Poulain'), '______', 'accents decide nothing');
    assert.equal(maskNameWords('The Lord of the Rings', 'The Witch-king of Angmar'), 'The Lord of the Rings', 'filler is not a name');
    assert.equal(maskNameWords('Cowboy Bebop', 'Spike Spiegel'), 'Cowboy Bebop');
  },

  'a pool index gives exactly the verdicts the list of names does'() {
    // Desk builds the index once per game rather than scanning every name per guess.
    const pool = [...NARUTO, 'Pikachu', 'Ash Ketchum'];
    const index = poolIndex(pool);
    for (const [guess, name] of [['Sasuke', 'Sasuke Uchiha'], ['Uzumaki', 'Naruto Uzumaki'], ['Naruto', 'Naruto Uzumaki'], ['ash', 'Ash Ketchum'], ['Kakashi', 'Kakashi Hatake'], ['Uchiha', 'Itachi Uchiha']]) {
      assert.deepEqual(
        judgeGuess(guess, name, { others: index, singleWords: true }),
        judgeGuess(guess, name, { others: pool, singleWords: true }),
        `${guess} for ${name}`
      );
    }
    assert.equal(judgeGuess('Sasuke', 'Sasuke Uchiha', { others: poolIndex([]), singleWords: true }).verdict, 'close', 'an empty pool decides nothing, as an empty list did');
  },

  'a romanised name may drop its long vowels, and only a romanised one'() {
    const romanised = { romanised: true };
    assert.equal(judgeGuess('Tanjiro', 'Kamado Tanjirou', { ...romanised, singleWords: true, others: poolIndex(['Kamado Tanjirou', 'Kamado Nezuko']) }).verdict, 'correct');
    assert.equal(judgeGuess('tanjiro kamado', 'Kamado Tanjirou', romanised).verdict, 'correct', 'in either order');
    assert.equal(judgeGuess('Sato Kazuma', 'Satou Kazuma', romanised).verdict, 'correct');
    assert.equal(judgeGuess('Shuichi Aizawa', 'Aizawa Shuuichi', romanised).verdict, 'correct');
    assert.equal(judgeGuess('Kamado', 'Kamado Tanjirou', { ...romanised, singleWords: true, others: poolIndex(['Kamado Tanjirou', 'Kamado Nezuko']) }).verdict, 'close', 'a shared family name is still close');
    // Everywhere else, two spellings are two people: measured, folding every name would have made
    // 121 pairs of different characters one -- Dog and Doug, Lois and Louis.
    assert.notEqual(judgeGuess('Dog', 'Doug').verdict, 'correct');
    assert.notEqual(judgeGuess('Lois', 'Louis').verdict, 'correct');
    assert.notEqual(judgeGuess('Tanjiro', 'Kamado Tanjirou', { singleWords: true }).verdict, 'correct', 'off unless the game says the name is romanised');
  },

  'edit distance counts a swap of neighbours as one typo'() {
    assert.equal(editDistance('sasuke', 'sasuek'), 1);
    assert.equal(editDistance('pikachu', 'pikachu'), 0);
    assert.equal(editDistance('kitten', 'sitting'), 3);
  },
};
