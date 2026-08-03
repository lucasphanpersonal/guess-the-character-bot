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
            '`/list create` -- start a new list, tagged with a category (e.g. "Anime", "Video Games")\n' +
            '`/list add` -- add a character, optionally with an `image` URL\n' +
            '`/list image` -- attach/update an image on an existing character\n' +
            '`/list remove` -- remove one\n' +
            '`/list show` -- see all lists grouped by category, or one list\'s characters\n' +
            '`/list toggle <list>` -- **switch one list in or out** of what this server plays ' +
            'with. Autocomplete shows ✅/⬜ so you can see what a toggle will do\n' +
            '`/list select top:<n>` -- enable the N best-known lists in every category (or one, ' +
            'with `category:`)\n' +
            '`/list select` -- the full checkbox page, for browsing and bulk changes. Pooled ' +
            'draws only ever use enabled lists, which is how obscure shows stay out of the deal',
        },
        {
          name: '2️⃣ Start a game',
          value:
            '`/lobby create` -- opens a lobby here. On its own it rolls a random category, so ' +
            'you can just run it.\n' +
            '`from:` picks what to draw from: one field offering 🎲 a random category, ' +
            '🌍 everything enabled, 🗂️ any single category, or 📋 list names ' +
            '(comma-separate to combine several).\n' +
            '`difficulty:` sets how deep into each cast the deal may go. That, the turn ' +
            'length, the rerolls and the audience-vote settings can all be changed afterwards ' +
            'from the board -- nothing has to be decided up front.',
        },
        {
          name: '🎛️ The lobby board',
          value:
            'Creating a lobby posts a board that updates itself as people join. Everything ' +
            'below is a button on it:\n' +
            "**Join** / **Leave** -- two people need to join (the host doesn't have to be one " +
            'of them)\n' +
            '**Spectate** -- opt in to a DM revealing both characters\n' +
            '**Start game** -- host only, stays disabled until 2 players have joined\n' +
            '**⚙️ Settings** / **🗳️ Audience vote** / **🎚️ Difficulty** / **🎭 Set characters** ' +
            '-- host only, and all locked once the game starts\n' +
            '`/lobby join`, `/lobby leave`, `/lobby spectate`, `/lobby start` and ' +
            '`/lobby set-characters` do the same from the command line and keep the board in ' +
            'sync.',
        },
        {
          name: '🗳️ Audience vote mode',
          value:
            'Add `audience-vote:true` to `/lobby create`, or hit the **🗳️ Audience vote** ' +
            'toggle on the lobby board, and the **audience** picks both ' +
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
            'turn 1 begins.\n' +
            '🚫 **Never deal this show** drops that list from the server for good *and* rerolls, ' +
            "in one press. And once 3 different people have rerolled the same character, the bot " +
            'stops dealing them -- the pool learns from what you reject.',
        },
        {
          name: '3️⃣ On your turn',
          value:
            'A **turn board** appears with a live countdown, the standings so far, and two ' +
            'rows of buttons -- one per player:\n' +
            '⚖️ **The other player judges.** They can see your character, so when you call a ' +
            'name out loud they hit **✅ They got it** or **❌ Nope**. That is how a turn ' +
            'resolves -- you never stop talking to log a guess.\n' +
            '⏭️ **Pass** is your only button -- there is no guess box, because the judge ' +
            'already decides whether you got it.\n' +
            "Guessing wrong costs you nothing and isn't counted, so guess early and often. " +
            "Only **Pass**, or running out of time, hands the turn over (once time's up the " +
            'board goes amber for one truly last guess).',
        },
        {
          name: '🏆 Winning: fewest turns',
          value:
            'Getting your character ends **your** part, not the game: it is revealed there and ' +
            'then, you drop out, and everyone else keeps playing until they get theirs. ' +
            'Whoever needed the fewest turns wins, and the same number of turns is a tie.\n' +
            'Once you are the last one still guessing there is nobody to pass to, so ⏭️ Pass ' +
            'becomes 🏳️ **Give up** -- the only way to end a game early.',
        },
        {
          name: '✍️ What counts as a correct guess',
          value:
            'Whatever the other player accepts. They can see your character, so they rule on ' +
            'it -- no spelling rules, no typo tolerance, no arguing with a bot about whether ' +
            '"Shikamaru" should have counted.',
        },
        {
          name: '🛠️ Anytime',
          value:
            '`/lobby status` -- whose turn it is, time left, and who has already finished\n' +
            '`/lobby end` -- host or admin can cancel a stuck game\n' +
            '`/rematch` -- replay with the same two players once a game finishes\n' +
            '`/leaderboard [player]` -- server standings, or one player\'s record and turn counts\n' +
            'The end-of-game reveal also has **Rematch** and **Leaderboard** buttons.',
        }
      );

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
