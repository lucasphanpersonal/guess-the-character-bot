// Minimal zero-dependency test harness + fake Discord objects.
//
// Tests run against a throwaway SQLite file (BOT_DB_PATH, set by test/run.js) so they can
// never touch data/bot.sqlite. Nothing here talks to the network or to Discord.

const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Fake Discord objects
// ---------------------------------------------------------------------------

// Most of the bot's UI lives in embeds, so flatten content + embed title/description/fields
// into one searchable string per message.
function payloadText(payload) {
  if (typeof payload === 'string') return payload;
  if (!payload) return '';
  const parts = [payload.content ?? ''];
  for (const embed of payload.embeds ?? []) {
    const data = typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
    parts.push(data.title ?? '', data.description ?? '');
    for (const field of data.fields ?? []) parts.push(field.name ?? '', field.value ?? '');
  }
  return parts.filter(Boolean).join('\n');
}

// Records every message the bot would have sent, so tests can assert on wording and on
// which channel/DM it went to.
let messageSeq = 0;
function createRecorder() {
  const sent = [];
  // Sent messages by `<channelId>:<messageId>`, so a fake client can fetch one back the way
  // the startup board sweep does.
  const messages = new Map();
  // Message ids that were deleted, in order.
  const deleted = [];

  // channelId defaults to the target's own id (`channel:123` -> `123`, `dm:p1` -> `p1`);
  // interaction replies pass the real channel explicitly, since their target is the user.
  const record = (target, payload, channelId = target.split(':')[1] ?? target) => {
    sent.push({ target, content: payloadText(payload), payload });
    const message = {
      id: `msg${++messageSeq}`,
      channelId,
      content: typeof payload === 'string' ? payload : payload?.content ?? '',
      // Boards are edited in place; edits are recorded against `<target>:edit`.
      edit: async (next) => record(`${target}:edit`, next, channelId),
      // Superseded turn boards are deleted so the channel keeps only the live one. Recorded
      // rather than dropped, so tests can assert WHICH message went.
      delete: async () => {
        deleted.push(message.id);
        messages.delete(`${channelId}:${message.id}`);
        return message;
      },
    };
    messages.set(`${channelId}:${message.id}`, message);
    return message;
  };
  const matching = (prefix) => sent.filter((m) => m.target.startsWith(prefix));
  return {
    sent,
    record,
    deleted,
    messageAt: (channelId, messageId) => messages.get(`${channelId}:${messageId}`),
    /** All recorded content joined, for coarse "was this mentioned anywhere" checks. */
    allText: () => sent.map((m) => m.content).join('\n'),
    textFor: (target) => sent.filter((m) => m.target === target).map((m) => m.content),
    /** Everything sent to a target or edited on it, e.g. `channel:123` also covers edits. */
    textMatching: (prefix) => matching(prefix).map((m) => m.content).join('\n'),
    lastMatching: (prefix) => matching(prefix).at(-1),
    last: () => sent[sent.length - 1],
    clear: () => sent.splice(0, sent.length),
  };
}

// Discord throws on a message that's been deleted; the board sweep relies on that to know
// there's nothing left to retire.
function unknownMessage() {
  const err = new Error('Unknown Message');
  err.code = 10008;
  return err;
}

function createFakeClient(recorder) {
  return {
    channels: {
      fetch: async (channelId) => ({
        id: channelId,
        send: async (payload) => recorder.record(`channel:${channelId}`, payload),
        messages: {
          fetch: async (messageId) => {
            const message = recorder.messageAt(channelId, messageId);
            if (!message) throw unknownMessage();
            return message;
          },
        },
      }),
    },
    users: {
      fetch: async (id) => ({
        id,
        username: `User${id}`,
        send: async (payload) => recorder.record(`dm:${id}`, payload),
      }),
    },
    // No shared voice channel by default -> voice features no-op, which is what we want
    // for logic tests.
    guilds: { fetch: async () => ({ members: { fetch: async () => null } }) },
  };
}

function createSlashInteraction({ client, userId, guildId, channelId, options = {}, recorder, canManageGuild = false }) {
  return {
    client,
    user: { id: userId },
    guildId,
    channelId,
    memberPermissions: { has: () => canManageGuild },
    options: {
      getString: (name) => (name in options ? options[name] : null),
      getInteger: (name) => (name in options ? options[name] : null),
      getBoolean: (name) => (name in options ? options[name] : null),
      getUser: (name) => (name in options ? options[name] : null),
      getFocused: (withDetail) => (withDetail ? options.__focused : options.__focused?.value ?? ''),
    },
    replied: false,
    deferred: false,
    // Mirrors the real shape: with `withResponse: true` discord.js hands back an
    // InteractionCallbackResponse whose `.resource.message` is the posted Message.
    reply: async (payload) => {
      // A reply that doubles as a board lives in the channel, not on the user.
      const message = recorder.record(`reply:${userId}`, payload, channelId);
      return { resource: { message } };
    },
    fetchReply: async () => recorder.record(`fetchReply:${userId}`, '', channelId),
    deferReply: async () => recorder.record(`defer:${userId}`, ''),
    editReply: async (payload) => recorder.record(`editreply:${userId}`, payload),
    followUp: async (payload) => recorder.record(`followup:${userId}`, payload),
    respond: async (choices) => recorder.record(`autocomplete:${userId}`, JSON.stringify(choices)),
  };
}

function createButtonInteraction({ client, userId, customId, recorder, guildId, channelId }) {
  return {
    client,
    user: { id: userId },
    customId,
    guildId,
    channelId,
    message: { embeds: [] },
    update: async (payload) => recorder.record(`update:${userId}`, payload, channelId),
    reply: async (payload) => {
      const message = recorder.record(`reply:${userId}`, payload, channelId);
      return { resource: { message } };
    },
    fetchReply: async () => recorder.record(`fetchReply:${userId}`, '', channelId),
    editReply: async (payload) => recorder.record(`editreply:${userId}`, payload, channelId),
    followUp: async (payload) => recorder.record(`followup:${userId}`, payload),
    deferUpdate: async () => recorder.record(`defer:${userId}`, ''),
    showModal: async (modal) => recorder.record(`modal:${userId}`, JSON.stringify(modal.toJSON())),
  };
}

// A submitted modal. `fields` holds what the user typed, keyed by the text inputs' customIds.
// isFromMessage() is true because every modal the bot shows is opened from a button on a
// board, which is what makes interaction.update() valid on the submission.
function createModalInteraction({ client, userId, customId, fields = {}, recorder, guildId, channelId }) {
  return {
    ...createButtonInteraction({ client, userId, customId, recorder, guildId, channelId }),
    isFromMessage: () => true,
    fields: {
      getTextInputValue: (key) => {
        if (!(key in fields)) throw new Error(`No text input "${key}" in the submitted modal`);
        return fields[key];
      },
    },
  };
}

// Stand-in for a live voice connection, so tests can assert which sounds would play
// without @discordjs/voice ever opening a socket.
function attachFakeVoice(game) {
  const played = [];
  game.voiceConnection = { destroy() {} };
  game.audioPlayer = {
    state: { status: 'idle' },
    play: (resource) => played.push(resource),
    stop() {},
    on() {},
  };
  return played;
}

module.exports = {
  assert,
  createRecorder,
  createFakeClient,
  createSlashInteraction,
  createButtonInteraction,
  createModalInteraction,
  attachFakeVoice,
};
