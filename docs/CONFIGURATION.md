# Configuration guide

Start with `/help` for a private overview. It shows the commands available for
enabled features and includes setup instructions for members with Manage Server.

Settings belong to a server, not the entire bot. In Discord, use `/config view`
and select a plugin. The response includes its complete settings JSON and an
edit button when the JSON fits Discord's modal limit. Editors expire after
15 minutes and are tied to the administrator who opened them.

For one value, use `/config set`. Values are JSON: numbers are unquoted,
booleans are `true`/`false`, IDs and text need double quotes, arrays use `[]`,
and optional destinations can be cleared with `null`. Turn on Developer Mode
in Discord to copy IDs.

```text
/config set plugin:Levels key:xp_gain.min value:15
/config set plugin:Levels key:xp_gain.max value:25
/config set plugin:Levels key:xp_cooldown_seconds value:60
/config enable plugin:Levels
```

The plugin option displays a friendly name; the IDs below are used in storage
and the HTTP API. `config.ts` inside each feature is the authoritative schema.
Unknown legacy fields are retained but do not acquire behavior automatically.

## Levels — `levels`

Defaults are 15–25 XP per eligible message, with a 60-second cooldown. Bots,
webhooks and system messages never earn XP. `ignored_channels` includes child
threads; `ignored_roles` excludes members. The largest of the default and
matching role multipliers is used, so role multipliers are boosts; use ignored
roles to suppress XP. `messages` counts awarded messages, not every message.

```json
{
  "enabled": true,
  "xp_gain": { "min": 15, "max": 25 },
  "xp_cooldown_seconds": 60,
  "xp_multipliers": { "default": 1, "roles": [] },
  "reward_roles": [{ "role_id": "123456789012345678", "level": 5 }],
  "reward_channel_id": null,
  "command_channel_id": null,
  "ignored_channels": [],
  "ignored_roles": []
}
```

Replace example IDs before using them. A member with Manage Server can choose
the dedicated level-up channel using `/level announcements channel:#levels`.
The bot checks that it can view and send to that server text/announcement
channel before saving. This sets `reward_channel_id` for this server, without
enabling the feature or changing other settings. A `null` reward destination
disables announcements; XP and earned roles continue normally. There is no
fallback to the conversation channel. Open `/level settings`, choose
**Announcements**, then select a destination or **Turn announcements off**.

### Level settings editor

`/level settings` opens one private Components V2 editor for admins with Manage
Server. Its **Rewards**, **Announcements**, **XP settings**, and **Commands** buttons remain
visible throughout setup, so no separate setup commands or pasted IDs are needed.

- **Rewards:** choose **Add reward**, select a role, then **Set level & save**.
  Level **0** is the join role. Nothing is saved until its level is submitted.
  Select an existing reward to change its level, replace its role, or remove it.
  Rewards are shown ten per page. Removing or replacing a mapping leaves that
  old role on members who already hold it and stops managing it.
- **Announcements:** choose the destination from the channel picker, edit the
  level-up message in a text input, or turn announcements off.
- **XP settings:** edit minimum/maximum XP per message and cooldown together in
  one form. Changes affect future awards; saved progress, multipliers and ignored
  roles/channels remain unchanged.
- **Commands:** choose one text or announcement channel for `/level rank` and
  `/level leaderboard`, or select **Allow anywhere** to clear the restriction.
  This saves `command_channel_id`; `null` (the default) permits all channels.
  The channel must be visible and writable by the bot. Other channels, including
  threads under the selected channel, receive a private error with a link to the
  chosen channel. Successful ranks and leaderboards are public; validation,
  lookup and publication errors are visible only to the person using the command.
  Admin settings, reward management and XP edits remain available
  elsewhere. Message XP and level-up announcements are not affected.

**Enable levels** / **Pause levels** and **Refresh** are available in every
section. Pausing keeps members' saved XP and current roles. Changes save when a
form is submitted or a channel/role selection is made; adding a reward requires
the final level form. The older direct setup commands remain compatible.

The editor checks the bot's role hierarchy and channel permissions before saving.
It expires after 15 minutes, belongs to the admin who opened it, and rejects
outdated edits if another admin has saved first. It works even while levels are
disabled; only **Enable levels** turns XP on. Editing reward settings never
bulk-updates members' roles.

### Milestone roles

Members with Manage Server can use the native role picker to set up rewards:

```text
/level rewards add level:0 role:@NewArrival
/level rewards add level:5 role:@Regular
/level rewards add level:10 role:@Explorer
/level rewards add level:15 role:@Survivor
/level rewards list
/level rewards remove level:10
```

Use `add` again with the same role to change its milestone. Different roles can
share a level; a server can have up to 100 reward roles. `list page:2` shows more
rewards. `remove level:10 role:@Explorer` removes just that role; omitting the
role removes all mappings for that level, including deleted Discord roles.
Removing a mapping leaves that role on existing members and stops managing it.

Level **0** is the join role: new human members receive it immediately when they
join, while levels are enabled. Returning members regain the reward for their
saved level instead of losing progress. The level-0 role is replaced at the next
configured milestone. Existing members receive it on their next eligible XP
award or admin XP change; configuring it does not bulk-update the whole server.

Members keep **only the roles at their highest unlocked milestone**: at level
12, the level-10 rewards replace the level-5 rewards. All roles at a tied
milestone are awarded. This also handles skipping levels. Rewards are granted
before previous rewards are removed, so a failed grant retains the old rewards.
Only configured reward roles are removed; unrelated roles are untouched.
The bot needs Manage Roles, and reward roles must be below its highest role
and have no administrative permissions. These checks run both at setup and
when updating roles, so later permission changes are respected.

Setup replies are private Components V2 messages and do not ping roles.
Settings are saved per server, even while levels are disabled. Reward changes
apply on a member's next eligible XP award or `/level set` / `/level reset`,
without requiring another level-up. Rewards also synchronize when a member joins.
There is no immediate server-wide role
update. Concurrent edits are rejected instead of overwriting a newer change.

`/level set` takes lifetime XP; `/level reset` sets it to zero. Both require
Manage Server and synchronize configured roles to the resulting level, removing
configured rewards when the member falls below the first milestone.
Reward templates accept `{user}`, `{display_name}`, `{level}`, `{xp}`, `{xp_next}`.
Rank and leaderboard replies are public. XP management replies stay private.
Ranks and leaderboards use server display names, with account display names as
a fallback, instead of member mentions. For level-up announcements, `{user}`
mentions the member who earned the level, while `{display_name}` is plain text.
Only that member can be notified; role mentions and mass mentions are disabled.

## Welcome and goodbye — `welcome_goodbye`

`/welcome settings` opens the private **welcome and goodbye editor**.
Switch between the visible **Welcome** and **Goodbye** buttons. `/goodbye settings` opens
the goodbye editor directly. Use **Edit welcome text** or **Edit goodbye text**
to open the full template in a text input. Review the private preview, then choose
**Save message**, **Edit draft**, or **Discard draft**. **Change channel**
selects or clears that message type's destination; both can use the same channel.
Channel changes save immediately. **Pause both** / **Enable greetings**
controls the whole plugin, including its separate join roles. Level-0 rewards
remain managed by Levels. Choosing a channel does not enable a paused plugin.

The editor requires Manage Server, expires after 15 minutes, and rejects stale
saves if another admin changed the configuration. Previews use your profile as
the example and are only visible to you. No test messages are posted publicly.
`{user}` is a member mention, while `{display_name}` is plain text. Welcome can
notify only the arriving member; goodbye messages and previews never ping anyone.
Link channels with `<#CHANNEL_ID>`. Newlines and Discord Markdown are supported.

Both `/welcome` and `/goodbye` have the same nested actions:

- `settings` opens the editor with buttons and text inputs.
- `set channel:<channel> message:<optional template>` selects that greeting's channel,
  optionally updates its message, and enables the shared greetings plugin (including
  the other configured greeting and join roles). It returns to the editor.
- `channel channel:<channel>` changes only that greeting's destination, preserving
  its text and the shared enabled/paused status.
- `message message:<template>` changes only that greeting's text and opens the editor.
- `preview` opens a private preview with controls to edit or return to the editor.

Use `settings` for a multiline text input and preview-before-save workflow.
Direct `set`, `channel`, and `message` changes save immediately. Additional fields are
`welcome_channel_id`, `leave_channel_id`, `welcome_message`, `goodbye_message`,
`join_role_ids` and `include_bots` (false by default). A `null` message uses the
neutral default. A `null` channel disables that announcement.
Place join roles below the bot and keep administrative permissions off them.
Templates accept `{user}`, `{display_name}`, `{server}`, `{member_count}`.

## Self roles — `roles`

Set `roles` to an array of up to 25 unique items with `role_id`, `label` and an
optional `description`. Set `title` and `description` for the panel, enable the
plugin, then run `/roles` in the destination channel. The menu keeps working
after restarts. Clearing a selection removes configured self roles only.
Changing the configured choices requires publishing a new panel; old messages
are not rewritten automatically.

## Birthdays — `birthday`

Open `/birthday settings` for the private Components V2 editor. **Channel** selects
the announcement destination, **Edit message** opens a multiline input and a private
draft preview, and **Time zone & hour** edits the local schedule. Save or discard the
message draft from its preview. **Enable birthdays** checks the destination before
enabling celebrations. Pausing never removes members' saved dates. Choosing or
clearing a channel does not change the enabled/paused status.

Set `channel_id`, `timezone` (for example `Europe/Warsaw`), `hour` (0–23) and
`message`, then enable. Members opt in with `/birthday set` and can always use
`/birthday remove`, even if celebrations are disabled. The year is optional
and never included in announcements. February 29 is celebrated on February 29
only. The scheduler catches up after the chosen hour on the same local day;
it does not send celebrations for missed previous days. Templates accept
`{user}`, `{display_name}`, `{server}`.

## Tickets — `tickets`

Open `/ticket settings` for one private Components V2 editor with these tabs:

- **Channels**: choose the private-thread parent channel, support-panel destination, staff alerts
  and private transcripts. Each picker checks channel type and bot permissions.
- **Staff roles**: add or remove selected roles without replacing the rest of the list.
  Current staff members are added to new private threads. Existing ticket memberships
  are unchanged. Staff roles are mentioned only in the staff-alert channel; only
  configured roles can be pinged. Ticket introductions contain no staff tags and
  never fall back to notifying staff inside the thread. Non-mentionable roles require
  the bot's Mention Everyone permission in the notification channel; ordinary
  members do not need that permission.
- **Support panel**: edit the title, body and button label in a form; preview the
  draft and save or discard it. **Publish panel** explicitly posts the saved version
  to `panel_channel_id`. The preview's open-ticket button is disabled. Saving text
  does not change previously published panels. Existing panel buttons keep working.
- **Auto-close**: change idle time in minutes and the close reason, turn automatic
  closure on/off, edit exempt roles, or set/remove a role-specific timeout in seconds.
  These rules also apply to existing tickets; overdue tickets may close at the next check.

**Enable tickets** validates the setup; **Pause tickets** stops new tickets and
automatic closure, while existing tickets can still be closed manually. The birthday
and ticket editors require Manage Server on every interaction, expire after 15 minutes,
and reject saves or panel publication if another administrator changed the settings.
They preserve settings from the other tabs and unknown legacy fields.

Configure `parent_channel_id`, `mods_role_ids`, optional `admin_channel_id` and
optional `transcript_channel_id`. Publish `/ticket panel` or use `/ticket open`.
`/ticket panel` uses `panel_channel_id` if set, otherwise the command's channel.
Customize `panel.title`, `panel.message` and `panel.button_label` in the editor.
New tickets are private threads in a server text channel. `parent_channel_id`
falls back to `panel_channel_id` when unset. The bot creates and owns the thread,
with member invitations disabled, and adds the opener plus current staff members.
The bot needs View Channel, Read Message History, Create Private Threads,
Send Messages in Threads and Manage Threads in the parent. Participants need
View Channel and Send Messages in Threads there. Discord members with Manage
Threads can also see private threads; review that permission on the parent.

Only ticket staff can manually close or claim tickets. Staff means Manage Server
permission or a configured staff role. The opener has no special closing rights.
Closed threads are locked and archived. Existing text-channel tickets remain
accessible and use their original archive behavior; `category_id` is retained for
legacy settings but no longer used to create tickets.

Each member has at most one ongoing ticket per server and bot, enforced by a
database unique index and a shared queue for button/slash requests. Claimed tickets
and automatically archived threads still occupy this slot. Opening again returns
the same ticket (and unarchives an unlocked ongoing thread) without pinging staff
again. Only a recorded closure frees the slot. Migration 003 preserves all rows
and refuses to proceed if legacy duplicate open tickets exist.

Every ticket has a permanent number within its bot and server, such as `#0001`.
New thread names include it (`ticket-0001-username`), as do opening messages,
staff alerts, command receipts and transcript files. A later ticket from the
same member gets a new number; returning to an ongoing ticket keeps its number.
Counters survive restarts and deleted tickets. Migration 004 assigns numbers to
existing open and closed records in creation order without changing their history.
Previously posted Discord messages and existing thread names are left as they are.

Closing a ticket removes its original staff alert after the closure is saved.
The archived thread and transcript remain. Alert message/channel IDs are stored
with the ticket, so cleanup survives restarts and changes to the alerts channel.
Failed deletions retry every minute, including while tickets or auto-close are
disabled. Manually deleted alerts count as already cleaned up. Migration 005 adds
this tracking; alerts posted before it need their existing message IDs linked first.

After a successful manual or automatic closure, the opener receives a private
review card with five buttons: `⭐ 1` through `⭐ 5`. The card identifies the server
and ticket number. Only that opener can vote, and the first rating is final;
the buttons are then disabled. Ratings use the existing ticket `rating` column,
with a timestamp in `reviewed_at`, and remain usable after a bot restart.

Migration 006 adds delivery tracking without sending reviews for historical
closures. The bot claims one DM attempt per ticket before sending. Closed DMs,
delivery failures or an interrupted attempt never block closure or trigger repeated
DMs. Delivery status is retained for troubleshooting. An already delivered card
still works even if recording its message ID was interrupted.

The staff archive includes the opener, claimed staff member (or **Unclaimed**),
closer, opening/closing times, duration, topic, reason and captured message count.
It attaches both a self-contained HTML transcript and a plain-text copy. HTML
escapes member content, loads no remote assets, and preserves attachment links;
those links may expire. Exports include at most the latest 10,000 messages and
must fit within 7 MB combined. Messages are ordered oldest first.

The **Member review** section appears only after an actual rating is submitted.
The bot edits the same archive message and replaces both files with the rated
version. Migration 007 stores a private conversation snapshot and its original
destination, allowing this update after restart or deletion of the source thread.
Snapshots are retained with their ticket record. Failed publication/edits retry
every minute, even if tickets are paused; staff-only permissions are checked again
before every update. A deliberately deleted archive message is not recreated.

`auto_close.enabled` defaults false. `auto_close.threshold_ms` defaults to
259200000 (three days). `auto_close.warning_ms` defaults to 1800000 (30 minutes).
Edit both in **/ticket settings → Auto-close → Timer, warning & reason**.
Only messages from the ticket opener restart the full timer; staff and bot
messages do not. The bot mentions the opener inside the thread before closure,
with the deadline and instructions to reply to keep the ticket open. Staff roles
are never mentioned in that warning. Any new opener message cancels the pending
closure, even if the ticket is claimed. Reactions/edits do not count as replies.
Migration 008 persists warnings and deadlines across restarts. If a warning was
missed during downtime, the member still gets the full warning period. History is
checked before warning/closure to recover missed replies. Failed warning delivery
or unreadable history postpones closure. Discord-auto-archived threads are reopened
for the warning so members can reply. Pausing tickets or auto-close clears pending
warnings; re-enabling warns again before closing. Existing activity timestamps are
retained during migration, so old staff activity can only delay the first closure.
`role_time_limits.excluded` exempts openers with those roles.
`role_time_limits.included` accepts `{ "role_id": "...", "threshold_seconds": 3600 }`;
the longest matching custom threshold wins. The warning period is capped at the
effective timeout if that timeout is shorter. Changing an effective timeout or
warning period cancels its previous deadline. Closure checks run every minute,
so a warning/closure can arrive up to roughly one minute after its due time.
Automatic closure uses the same archive, staff-alert cleanup and review DM flow
as staff closure. New servers keep auto-close disabled until an admin enables it.
Transcripts require a separate destination with @everyone denied View Channel.
Also inspect its other role overrides to ensure only intended staff can see it.

## Starboard — `starboard`

Open `/starboard settings` for a private Components V2 editor (Manage Server
required). Use **Channel**, **Reaction threshold**, **Emoji**, **Watched channels**,
the self-star toggle, **Preview**, and **Enable/Pause starboard**. The preview uses
the real highlight layout with sample text and never posts or notifies anyone.
Channel and rule edits save without automatically enabling the feature.

Shortcuts: `/starboard status`, `/starboard channel channel:#highlights`,
`/starboard threshold count:5`, `/starboard emoji emoji:⭐`, `/starboard enable`,
and `/starboard disable`. All replies are private and require Manage Server.
Paste one Unicode emoji or a custom emoji from this server (or its ID). Custom
emoji are matched by ID, so renaming them does not break starboard.

Watched channels support **All public channels**, **Watch none**, and adding or
removing selected channels. Add up to 25 at a time, up to 100 total; removal is
paged so longer existing lists remain editable. Selected text/announcement
channels include their public threads; selecting a forum/media channel watches
its public posts. Private channels and private threads remain excluded. The
destination cannot watch itself. Clearing the destination also pauses starboard.

Set `channel_id`, `threshold` (default 15), `emoji` (default ⭐),
`allow_self_star` (default false) and `watch_channels` (`null` means all eligible
channels, `[]` means none). Private messages/channels and private threads are
excluded. Adult-channel content is not copied into a non-adult destination.
Highlights update as reactions change. Removing all stars or deleting a source
removes its highlight. Already recorded highlights stay in their original
destination after you change the setting; new highlights use the new channel.
Rule changes apply to subsequent reactions; they do not scan historical messages
or immediately recount all existing highlights. Pausing keeps saved highlights.

## Temporary voice — `tempvc`

`channel_id` identifies a voice lobby. `title_template` accepts `{display_name}`
and `{username}`. `allowed_role_ids: []` allows everyone who can join the lobby.
`user_limit: 0` means unlimited. New rooms inherit the lobby's category and
permission overrides. The bot needs Manage Channels and Move Members.

Empty rooms are removed within roughly 30 seconds. `max_duration_minutes`
sets how long the creator can reuse an existing room by rejoining the lobby;
`null` means no expiry. Occupied rooms are never forcibly deleted or disconnected
when the duration expires. Cleanup also runs after restart and after disabling
new room creation.

## Adaptive slowmode — `slowmode`

Defaults: `message_threshold: 10`, `window_seconds: 10`, `rates.high: 6`,
`slowmode_duration_ms: 10000`. `watch_channels: null` includes all ordinary text
channels. On a burst, Caretaker applies the higher slowmode and stores the
previous rate. It restores that prior rate when the override expires, unless
a moderator has since changed it. Recovery checks run every five seconds.
The old `rates.low` field is preserved for compatibility but is not used;
restoring each channel's actual prior rate avoids erasing manual settings.

## Bot guard — `auto_ban_bots`

Disabled by default. `watch_roles` must explicitly list quarantine roles;
@everyone is ignored. `allowed_bot_ids` exempts trusted bots. Only bot accounts
are considered; human members are never banned by this plugin.
`delete_message_days` defaults to 0. `ban_check_interval_minutes` controls a
periodic scan of cached members; new bot joins and role changes are checked
directly. It does not fetch the whole server member list on each scan.

## Server-specific messages and permissions

Shared defaults are neutral and feature plugins start disabled. Use the welcome,
level, birthday and ticket editors to customize messages, or `/config view` and
`/config set` for self-role panel text and temporary voice names. These values
are saved by bot, server and plugin in PostgreSQL. No server's custom wording,
channel IDs or role choices are copied into another server's defaults.

The old `/config theme` preset command has been removed. Existing saved messages
remain intact and can still be edited normally. The default public bio in
`src/config/profile.ts` is neutral; publishing it is an explicit operator action,
and normal startup does not overwrite the bot's existing Discord profile.

Grant only the permissions needed by the features you enable: View Channel,
Send Messages, Read Message History, Embed Links and Attach Files as relevant;
Manage Roles for role assignments; Manage Channels for ticket/voice/slowmode;
Move Members for voice; Ban Members only for bot guard. Legacy ticket threads
need Manage Threads to close. All command users need Use Application Commands.
