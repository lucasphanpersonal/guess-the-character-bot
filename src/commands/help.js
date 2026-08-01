const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('help').setDescription('How to set up and play Guess the Character'),
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('🎮 Guess the Character')
      .setDescription(
        'Two players are each secretly assigned a character only the *other* player (and ' +
          "spectators) can see. Ask yes/no questions out loud in voice to figure out who you " +
          'are, then guess. The bot only tracks turns, timers, and guesses -- all the Q&A ' +
          'happens live in voice chat. If both players share a voice channel, the bot joins in ' +
          'and plays sound effects for the countdown, correct/wrong guesses, and the final win.'
      )
      .addFields(
        {
          name: '1️⃣ Build a character list (one-time setup)',
          value:
            '`/list-create` -- start a new list, tagged with a category (e.g. "Anime", "Video Games")\n' +
            '`/list-add-character` -- add a character, optionally with an `image` URL\n' +
            '`/list-set-image` -- attach/update an image on an existing character\n' +
            '`/list-remove-character` -- remove one\n' +
            '`/list-show` -- see all lists grouped by category, or one list\'s characters',
        },
        {
          name: '2️⃣ Start a game',
          value:
            '`/create-lobby list:<name>` -- open a lobby (comma-separate several list names to ' +
            'draw from a combined pool; optionally set `turn-seconds` and `max-rerolls`, ' +
            '`-1` = unlimited)\n' +
            '`/create-lobby category:<name>` -- draw from **every** list in a category at once, ' +
            'e.g. `category:Video Games` for any video game character\n' +
            'Or `random:true` to let the bot roll a random category -- 🎲 category roulette\n' +
            'That posts the **lobby board**, which updates itself as people join. Everything ' +
            'else here is a button on it:\n' +
            '**Join** / **Leave** -- two people need to join (the host doesn\'t have to be one ' +
            'of them)\n' +
            '**Spectate** -- opt in to a DM revealing both characters\n' +
            '**Start game** -- host only, stays disabled until 2 players have joined\n' +
            'The matching `/join-lobby`, `/leave-lobby`, `/spectate` and `/start-game` commands ' +
            'still work and keep the board in sync.\n' +
            '`/set-characters` -- host only, optional, no button: assign each player\'s hidden ' +
            "character yourself instead of leaving it random (reply is only visible to you, so " +
            "it won't spoil anything)",
        },
        {
          name: '🗳️ Audience vote mode',
          value:
            'Add `audience-vote:true` to `/create-lobby` and the **audience** picks both ' +
            'characters instead of the bot. A vote board appears with a **Vote** button — ' +
            'clicking it gives you a private ballot of candidates for each player. The two ' +
            "players can't vote and never see the options. Tune it with `vote-options` " +
            '(candidates per player) and `vote-seconds`; the host can close voting early.',
        },
        {
          name: '🔍 Confirm your character',
          value:
            "Once the game starts, you'll get a DM showing a character with **Good to go** / " +
            "**Reroll** buttons. If you (or you think the wearer) won't recognize it, reroll " +
            "(however many the host allowed) -- the game waits until both players confirm before " +
            'turn 1 begins.',
        },
        {
          name: '3️⃣ On your turn',
          value:
            'A **turn board** appears with a live countdown, your guesses so far, and ' +
            '**Guess** / **Pass** buttons. Ask your questions out loud in voice, then hit ' +
            "**Guess** (it opens a text box) as often as you like -- guessing wrong doesn't " +
            'end your turn, so guess early and often and keep going. Only **Pass**, or ' +
            "running out of time, actually hands the turn over (once time's up the board goes " +
            'amber for one truly last guess before it moves on). `/guess <character>` and ' +
            '`/pass` still work if you prefer typing. Small typos are OK, and a well-known ' +
            'first or last name alone is accepted for multi-word names.',
        },
        {
          name: '🏆 Winning',
          value:
            'First correct guess wins the game -- unless it was the player who went first that ' +
            "round, in which case the other player gets one rebuttal turn before it's final " +
            '(correct on rebuttal = tie, wrong = the first player wins).',
        },
        {
          name: '✍️ What counts as a correct guess',
          value:
            'Case and punctuation are ignored, accents are optional (`Flabebe` matches ' +
            '`Flabébé`), small typos are forgiven, and for multi-word names a single ' +
            'well-known part is enough (`Shikamaru` matches `Shikamaru Nara`).',
        },
        {
          name: '🛠️ Anytime',
          value:
            '`/status` -- whose turn it is and time left\n' +
            '`/end-game` -- host or admin can cancel a stuck game\n' +
            '`/rematch` -- replay with the same two players (order swapped) once a game finishes\n' +
            '`/leaderboard [player]` -- server win/loss standings, or one player\'s record\n' +
            'The end-of-game reveal also has **Rematch** and **Leaderboard** buttons.',
        }
      );

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
