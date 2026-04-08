can we use Telegram Topics to separate out all sessions and have them all live ?

⏺ Really good idea — and it's actually architecturally compatible with how the bot works today.

What Telegram Topics are
"Forum" mode on a group — each topic is a separate thread with its own message_thread_id. Messages sent
to a topic only appear there. It's basically sub-channels inside one group.

How it would map

- One Telegram group (forum) per machine or per repo
- One topic per Claude Code session
- Watch output streams into that session's topic
- You send messages in the topic → relay sends to that session
- New session via /new_wt → bot creates a new topic automatically

What needs to change technically

- sendMessage calls need message_thread_id added
- Active session concept changes: instead of one active session per chat, the active session is derived
  from which topic you're in — the message_thread_id in the incoming message
- /list becomes less necessary — the topic list is your session list
- WatchState keyed by (chatId, threadId) instead of just chatId
- Topic creation via createForumTopic API call when a session is spawned

The tricky parts

- grammY supports forum topics — ctx.message?.message_thread_id is already available
- The bot needs to be admin in the group to create/manage topics
- You lose the single-user private chat model — everything moves to the group
- Existing auth (ALLOWED_USERS by user ID) still works fine in groups
- The pinned status message per chat would need rethinking — one pin per topic or one per group

Biggest win
You get a persistent, scrollable, per-session history in each topic without any new storage layer.
Telegram is the UI.

This is probably the most impactful architectural addition possible for this bot. Worth a proper plan
before touching code.
