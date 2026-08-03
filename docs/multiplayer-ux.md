# Multiplayer: playing it, and what that breaks

A companion to [multiplayer-design.md](multiplayer-design.md). That document settles the rules
and the data. This one walks a real session at five players and asks what it feels like, then
specifies the interface changes that fall out.

The short version: **the mechanics generalise cleanly, the interface does not.** Almost
everything below is a problem that does not exist at two players and gets steadily worse as
the table grows.

---

# Part 1 — Playing it

Five people in a voice channel. Here is the session as a player experiences it.

**Opening the lobby.** Someone runs `/lobby create`, the board posts, five people click Join,
the board updates in place each time. This part scales fine — it is a list that gets longer.
Start unlocks at two rather than requiring exactly two.

**The DM.** Start is pressed and a DM arrives with four character embeds in it, each with
artwork. On a phone that is a lot of scrolling. One of the four is the one I'm checking; the
other three are context I need to recognise later. The buttons sit at the very bottom, after
all four — so if my check target is the *first* embed, the control for it is four images away
from it. I scroll back up to check which one was mine, then back down to press.

**My turn.** A board posts: whose turn, a countdown bar, ✅/❌ for everyone else, Pass for me.
I ask questions out loud, people answer, I guess, someone hits ❌ and I hear a buzz. Time runs
out, the board goes amber, I get one more, then I pass.

**Everyone else's turns.** Four more boards post, one per player. I judge when I can. Then
round two starts and four more post. By round three the channel is a column of maybe fifteen
grey dead boards and I have to scroll to find the live one.

**Someone finishes.** P3 gets theirs on turn 3, their character is revealed publicly, they drop
out. Nice moment. Then I realise I have no idea whether I'm doing well. P3 finished on 3 — am I
on turn 3 or 4? I'd have to count the boards.

**The endgame.** By round five it's just me and P5. Our turns come around every minute or so,
which is a much faster rhythm than the five-minute cycle at the start. Boards pile up quicker.
Then P5 finishes and I'm alone. The whole channel is watching one person, my Pass button has
turned red and says Give up, and I have no idea how far behind I am or how long people expect
me to keep going.

## What that walkthrough exposes

Ranked by how much it hurts, not by how hard it is to fix.

**1. The channel floods.** A new board message per turn is the current design, and it is right
at two players — a short game produces a tidy handful of blocks. Five players over four rounds
produces twenty, plus completions, plus the bookend messages. The live board is never where
you left it, and the dead ones carry no information worth scrolling past.

**2. The standings are invisible.** Turn-count scoring is the entire point of the mode and
nothing displays it. Who has finished, on what turn, and how the survivors compare is the
drama, and right now it is something you'd reconstruct by counting messages.

**3. You will miss your turn.** Discord does not send a notification for a mention inside an
embed — only in message content — and `startTurn` sends a payload of embeds and components
with no content at all. At two players this is invisible as a problem because you are locked
into a duel. At five, with four minutes between your turns, you will be talking to someone
else when your turn opens and nobody pings you.

**4. The DM separates the control from its subject.** Discord always renders components after
all embeds, so the button row cannot sit next to the character it acts on. With one embed that
is invisible. With four it means the thing you must act on and the thing you press are not
adjacent, and nothing on screen says which embed the buttons belong to.

**5. ✅ becomes a four-way race, and it's a one-way door.** At two players there is exactly one
judge, so a press is unambiguous. At five, four people can rule on the same guess, and they
will lunge simultaneously. First press wins is correct — but the other three need a graceful
answer rather than an interaction error. More seriously: one misclick out of four ends someone's
turn wrongly, marks them finished, and *reveals their character publicly*, which cannot be
untold. That risk scales linearly with table size.

**6. Turn length doesn't scale.** Five players at 60s is a five-minute round at the start and a
one-minute cycle at the end. The same setting produces two very different games.

---

# Part 2 — Interface changes

**Shipped so far** (with stages 1–3): the standings field, the current-player ping, and the
three defects found by reading the transcript back — see
[What playing it back exposed](#what-playing-it-back-exposed) at the end. Still outstanding:
deleting the previous turn's board, the two-message DM split, and the ✅ undo.

## Replace the per-turn board with a repost-and-delete board

Post a new board each turn as today, then **delete the previous turn's board** once it's
resolved. The channel holds one live board at all times.

This solves flooding and problem 3 together: a fresh message re-anchors at the bottom of the
channel and produces an unread marker, which an in-place edit does not. Add
`content: <@currentPlayerId>` to that post and the current player is actually notified that
they're up. The mention in the embed description stays for layout; the one in content is what
pings.

The alternative — a single board edited in place all game — is tempting because burial risk is
genuinely low here (the game is played in voice, so the text channel is mostly the bot's own
surface). It is rejected because an edit generates no notification, which leaves problem 3
unsolved.

What is lost is per-turn scrollback. That is the right thing to lose: the turns that mattered
are the ones where somebody finished, and those stay as their own permanent messages. A column
of "turn over" greys is not history, it is residue.

Deleting the bot's own messages needs no additional permission, so the invite link in the
README is unchanged.

## Put standings on the board

One embed field, `Standings`, rendered as lines rather than one field per player — 25 fields is
the hard cap and it would look like a spreadsheet well before that.

```
Standings
✅ Kira — turn 2
✅ Sam — turn 3
🎯 Alex — turn 4 (guessing)
⏳ Jordan — turn 3
```

Mentions resolve in field *values* but not in field names or titles — `turnBoard.js` already
carries this note — so names go in the value or are rendered as plain display names.

This is the single highest-value addition in this document. It makes the scoring legible, it
tells a finished player whether they're still winning, and it tells the last player alive
exactly how far behind they are, which is the difference between a tense finish and an
uncomfortable one.

## Split the confirm DM into two messages

This supersedes the single-message layout in
[multiplayer-design.md](multiplayer-design.md#layout).

- **Message 1 — "The character you're checking."** One embed, and the existing
  `[Good to go] [Reroll] [🚫 Never deal this show]` row directly beneath it. Unchanged from
  today's two-player DM, which is the point: the button row is adjacent to its subject again,
  and it is the only thing in the message.
- **Message 2 — "Everyone else's characters."** The remaining N−2 embeds, no components.
  Reference material.

Two DMs per player rather than one, so 2N per game rather than N² — nowhere near the rate
limits that ruled out the per-character variant. It also removes the 10-embed ceiling from the
message that has buttons, so only the reference message ever needs pagination.

The fan-out on reroll now has a smaller target: a reroll of P2's character re-renders message 2
for everyone except P1 and P2, and message 1 for P1 only.

## Make ✅ idempotent and give the losers of the race an answer

`submitJudgement` already refuses non-players and the current guesser. It needs one more state:
a correct judgement that arrives after the turn has already resolved should reply ephemerally
with something like "Already recorded — Alex got it" rather than surfacing an error. This will
fire on most turns at five players, so it is normal operation, not an edge case.

**On the misclick risk:** the cheapest mitigation is a 10-second `↩️ Undo` on the completion
message, pressable only by whoever pressed ✅. It restores the player to the rotation and
re-hides their character. It cannot un-reveal what people already read, but it fixes the
standings and lets the game continue honestly, which is the part that matters. Worth doing at
stage 4 rather than deferring — the failure it prevents corrupts a whole game and has no other
remedy.

## Smaller items

- **Give up needs a state, not just a label.** The relabel from `⏭️ Pass` grey to `🏳️ Give up`
  red is specified already. Add the context line that makes it a decision rather than a dare:
  "You're the last one — the leader finished on turn 3, you're on turn 6."
- **Completion reveals should be their own message**, not an edit to the turn board, so they
  survive the repost-and-delete cycle and form the game's actual history.
- **The lobby board's Start gate** moves from "exactly 2" to "at least 2" and the player slots
  become a list.
- **Turn length should probably fall as the table grows.** Not specifying a rule — nobody has
  played this yet — but the host can already change `turn-seconds` from the board, and the
  README should say why they'd want to.

---

## What doesn't need changing

Worth stating, because it is most of the interface:

The colour language (blurple active, amber last chance, green correct, grey over) carries over
untouched and gains no new states. The countdown bar, the timer semantics and the amber
last-chance behaviour are all player-count-independent. The judge row shrinks from two rows to
one shared row, so the component budget gets *looser*, not tighter. The lobby board, the vote
board, the list browser and every slash command surface are unaffected apart from the Start
gate and the vote mode's five-player limit.

---

# What playing it back exposed

Everything above was written by reasoning about the interface. Once turn-count scoring was
built, printing a real game's channel transcript end to end found three things that reasoning
had not — all of them invisible in the code and obvious on the page.

**A retired board went on claiming a turn was live.** `currentPlayerId` doesn't advance until
the *next* turn starts, so a board frozen in between still rendered `🎯 … (guessing)` against
whoever had just played. Every dead board in the channel history was pointing at a turn that
had already ended. Fixed by passing `turnOver` into the standings renderer.

**The end of the game was a duplicate of the two messages above it.** Each character is
revealed as its wearer gets it, and the final reveal then showed all of them again — so in a
game where both players finished, the same two names and images appeared three times in a row.
The reveal now carries only the characters nobody has seen: in practice, the one belonging to
a player who gave up, which is the single genuinely unanswered question at the end. When
everybody finished, it is just the result line and the buttons.

**"turn 0."** Technically correct for a player yet to move, and it reads like an off-by-one.
Now "not started yet".

The lesson worth keeping: none of these are logic errors, and no test would have been written
for them, because each is a sentence that is *true* and reads wrong. A transcript dump is
cheap — `test/harness.js` already records every message — and it is the only way any of this
surfaces before a player sees it.
