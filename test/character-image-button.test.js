// The Add/Replace image button on the check DM.
//
// Only the checker of a character may set its image (the same one-checker-each rule that
// gates reroll and "never deal this show"), it has to be a real list row to save to, and the
// fix has to show up immediately -- on the checker's own message in the same response, and on
// everyone else holding that character as a reference.

const {
  assert,
  createRecorder,
  createFakeClient,
  createButtonInteraction,
  createModalInteraction,
} = require('./harness');
const engine = require('../src/game/engine');
const confirmPhase = require('../src/game/confirmPhase');
const Lobby = require('../src/game/Lobby');
const GameManager = require('../src/game/GameManager');
const lists = require('../src/db/characterLists');
const db = require('../src/db/connection');

let counter = 0;

async function startedGame({ playerCount = 2, p2Freeform = false } = {}) {
  const n = ++counter;
  const guildId = `img-guild-${n}`;
  const channelId = `img-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);

  const listId = lists.createList(guildId, 'Show', 'tester', 'Anime', { enabled: true });
  for (const name of ['Hero', 'Sidekick', 'Villain']) lists.addCharacter(listId, name, 'tester');

  const recorder = createRecorder();
  const client = createFakeClient(recorder);
  const lobby = new Lobby({
    guildId,
    channelId,
    hostId: 'p1',
    listIds: [listId],
    listNames: ['Show'],
    turnSeconds: 90,
    maxRerolls: 2,
    difficulty: 'everything',
  });
  const players = ['p1', 'p2', 'p3'].slice(0, playerCount);
  for (const id of players) lobby.addPlayer(id);
  GameManager.createLobby(channelId, lobby);

  const pool = lists.drawablePool([listId], 'everything');
  // p2's row can be swapped for a freeform (hand-picked, no database row) character, to
  // exercise the "nowhere to save this to" path.
  const rows = players.map((_, i) => (i === 1 && p2Freeform ? lists.freeformCharacter('Made-Up Guy') : pool[i]));
  await engine.startGame(client, lobby, rows);

  return { lobby, client, recorder, channelId, guildId, listId, players };
}

const click = (ctx, userId, gameInstanceId) =>
  confirmPhase.handleImageButton(
    createButtonInteraction({
      client: ctx.client,
      userId,
      customId: `image:${ctx.channelId}:${gameInstanceId}`,
      recorder: ctx.recorder,
    })
  );

const submit = (ctx, userId, gameInstanceId, url) =>
  confirmPhase.handleImageModalSubmit(
    createModalInteraction({
      client: ctx.client,
      userId,
      customId: `image-submit:${ctx.channelId}:${gameInstanceId}`,
      fields: { url },
      recorder: ctx.recorder,
    })
  );

module.exports = {
  async "submitting a URL saves it and updates the checker's own DM in the same response"() {
    const ctx = await startedGame();
    const game = ctx.lobby.game;
    const ownerId = game.checkTargetOf('p1'); // p1 checks p2's character
    const before = game.headByPlayer[ownerId];
    assert.equal(before.imageUrl, null);

    await submit(ctx, 'p1', game.gameInstanceId, 'https://example.com/a.png');

    const row = lists.getCharacters(ctx.listId).find((c) => c.name === before.name);
    assert.equal(row.image_url, 'https://example.com/a.png', 'saved to the database');
    assert.equal(game.headByPlayer[ownerId].imageUrl, 'https://example.com/a.png', 'and to the in-memory head');

    // Not on some later render -- the interaction that submitted the modal is the one that
    // carries the updated embed back to Discord.
    const updated = ctx.recorder.lastMatching('update:p1');
    const embed = updated.payload.embeds[0].toJSON();
    assert.equal(embed.image.url, 'https://example.com/a.png');

    GameManager.endLobby(ctx.channelId);
  },

  async 'the button relabels to Replace image, and prefills the modal with what is already saved'() {
    const ctx = await startedGame();
    const game = ctx.lobby.game;
    const gameInstanceId = game.gameInstanceId;

    await submit(ctx, 'p1', gameInstanceId, 'https://example.com/a.png');
    const updated = ctx.recorder.lastMatching('update:p1');
    const button = updated.payload.components[0]
      .toJSON()
      .components.find((c) => c.custom_id === `image:${ctx.channelId}:${gameInstanceId}`);
    assert.equal(button.label, 'Replace image');

    await click(ctx, 'p1', gameInstanceId);
    const modal = ctx.recorder.lastMatching('modal:p1');
    assert.match(modal.content, /"value":"https:\/\/example\.com\/a\.png"/);

    GameManager.endLobby(ctx.channelId);
  },

  async 'a URL missing http(s):// is rejected and nothing changes'() {
    const ctx = await startedGame();
    const game = ctx.lobby.game;
    const ownerId = game.checkTargetOf('p1');

    await submit(ctx, 'p1', game.gameInstanceId, 'not-a-url');

    assert.equal(game.headByPlayer[ownerId].imageUrl, null);
    assert.match(ctx.recorder.allText(), /must be a URL/i);
    assert.equal(ctx.recorder.lastMatching('update:p1'), undefined, 'no update was sent');

    GameManager.endLobby(ctx.channelId);
  },

  async 'a hand-picked character with no list behind it has nowhere to save an image'() {
    const ctx = await startedGame({ p2Freeform: true });
    const game = ctx.lobby.game;

    await click(ctx, 'p1', game.gameInstanceId);
    assert.match(ctx.recorder.allText(), /wasn't drawn from a list/);
    assert.equal(ctx.recorder.lastMatching('modal:p1'), undefined, 'no modal was shown');

    await submit(ctx, 'p1', game.gameInstanceId, 'https://example.com/a.png');
    assert.match(ctx.recorder.allText(), /wasn't drawn from a list/);

    GameManager.endLobby(ctx.channelId);
  },

  async 'only the designated checker of a character may set its image'() {
    const ctx = await startedGame({ playerCount: 3 });
    const game = ctx.lobby.game;
    // p1 checks p2's character (checkTargetOf), so p3 -- who checks p1's -- has no business
    // touching p2's image.
    assert.notEqual(game.checkTargetOf('p3'), game.checkTargetOf('p1'));

    await submit(ctx, 'p3', game.gameInstanceId, 'https://example.com/wrong.png');
    const p2Character = game.headByPlayer[game.checkTargetOf('p1')];
    assert.notEqual(p2Character.imageUrl, 'https://example.com/wrong.png');

    GameManager.endLobby(ctx.channelId);
  },

  async 'from three players, everyone else holding the character as a reference sees the fix too'() {
    const ctx = await startedGame({ playerCount: 3 });
    const game = ctx.lobby.game;
    const ownerId = game.checkTargetOf('p1'); // p1's the checker; p3 holds it as a reference card

    await submit(ctx, 'p1', game.gameInstanceId, 'https://example.com/a.png');

    // fanOutReference re-renders via message.edit, recorded against the DM it originally
    // went out on -- not as an interaction update, since nobody clicked anything on p3's end.
    const refUpdate = ctx.recorder.lastMatching('dm:p3:edit');
    assert.ok(refUpdate, 'p3 got a re-rendered reference message');
    const hasImage = refUpdate.payload.embeds.some((e) => e.toJSON().image?.url === 'https://example.com/a.png');
    assert.ok(hasImage, "p3's reference card shows the new image");

    GameManager.endLobby(ctx.channelId);
  },

  async 'the image button and its fix both still work after the game locks in'() {
    const ctx = await startedGame();
    const game = ctx.lobby.game;
    const gameInstanceId = game.gameInstanceId;

    await confirmPhase.handleConfirmationButton(
      createButtonInteraction({ client: ctx.client, userId: 'p1', customId: `confirm:${ctx.channelId}`, recorder: ctx.recorder })
    );
    await confirmPhase.handleConfirmationButton(
      createButtonInteraction({ client: ctx.client, userId: 'p2', customId: `confirm:${ctx.channelId}`, recorder: ctx.recorder })
    );
    assert.equal(ctx.lobby.status, 'IN_PROGRESS');

    await submit(ctx, 'p1', gameInstanceId, 'https://example.com/a.png');
    const updated = ctx.recorder.lastMatching('update:p1');
    assert.match(updated.content, /game is under way/, 'still the locked-in message, not the confirm-phase one');
    const embed = updated.payload.embeds[0].toJSON();
    assert.equal(embed.image.url, 'https://example.com/a.png');

    GameManager.endLobby(ctx.channelId);
  },
};
