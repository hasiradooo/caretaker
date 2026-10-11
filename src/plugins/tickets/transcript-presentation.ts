import { AttachmentBuilder, escapeMarkdown } from "discord.js";
import { UserError } from "../../shared/errors";
import { card } from "../../shared/messages";
import { ticketLabel } from "./presentation";
import type { TicketTranscript } from "./transcript-repository";

const iso = (value: Date | string) => new Date(value).toISOString();
const stamp = (value: Date | string) =>
    `<t:${Math.floor(new Date(value).getTime() / 1000)}:f>`;
export function ticketDuration(
    opened: Date | string,
    closed: Date | string,
): string {
    const seconds = Math.max(
        0,
        Math.floor(
            (new Date(closed).getTime() - new Date(opened).getTime()) / 1000,
        ),
    );
    const parts = [
        Math.floor(seconds / 86400),
        Math.floor((seconds % 86400) / 3600),
        Math.floor((seconds % 3600) / 60),
        seconds % 60,
    ];
    return (
        parts
            .map((n, i) => (n ? `${n}${["d", "h", "m", "s"][i]}` : ""))
            .filter(Boolean)
            .slice(0, 2)
            .join(" ") || "0s"
    );
}
// Transcript content is untrusted. Escape it as text, never render user HTML or
// scripts, and only link HTTP(S) attachments. The document loads no remote assets.
const html = (value: string) =>
    value.replace(
        /[&<>"']/g,
        (char) =>
            ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
            })[char] ?? char,
    );
const safeUrl = (value: string) => {
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol)
            ? html(url.href)
            : null;
    } catch {
        return null;
    }
};

export function transcriptPayload(row: TicketTranscript) {
    const label = ticketLabel(row.ticket_number),
        closed = row.closed_at ?? row.created_at;
    const person = (id: string | null) =>
        id ? `${row.snapshot.names[id] ?? id} (${id})` : "Unclaimed";
    const duration = ticketDuration(row.created_at, closed);
    const summary: [string, string][] = [
        ["Server", row.snapshot.server_name],
        ["Ticket", label],
        ["Opened by", person(row.opener_id)],
        ["Claimed by", person(row.claimed_by)],
        ["Closed by", row.closed_by ? person(row.closed_by) : "Unknown"],
        ["Opened", iso(row.created_at)],
        ["Closed", iso(closed)],
        ["Duration", duration],
        ["Messages", String(row.snapshot.messages.length)],
        ["Topic", row.topic ?? "General support"],
        ["Close reason", row.close_reason ?? "Resolved"],
    ];
    if (row.rating !== null)
        summary.push([
            "Member review",
            `${row.rating}/5${row.reviewed_at ? ` · ${iso(row.reviewed_at)}` : ""}`,
        ]);
    const scope = row.snapshot.complete
        ? "Full available history"
        : "Latest 10,000 messages; earlier history remains in the ticket thread";
    const text = `${summary.map(([key, value]) => `${key}: ${value}`).join("\n")}\nThread ID: ${row.thread_id}\nServer ID: ${row.guild_id}\n\n${scope}\n${"─".repeat(60)}\n\n${row.snapshot.messages
        .map(
            (m) =>
                `[${m.created_at}] ${m.author_name} (${m.author_id})\nMessage ID: ${m.id}${m.reply_to ? ` · Reply to: ${m.reply_to}` : ""}${m.edited_at ? ` · Edited: ${m.edited_at}` : ""}\n${m.text || "[No text]"}${m.attachments.map((a) => `\nAttachment: ${a.name}\n${a.url}`).join("")}`,
        )
        .join("\n\n")}`;
    const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Ticket ${html(label)} · ${html(row.snapshot.server_name)}</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#131519;color:#e5e8ef;font:15px/1.6 system-ui,sans-serif}main{max-width:1040px;margin:auto;padding:48px 24px}.eyebrow{color:#e6bd62;letter-spacing:.12em;font-size:12px;text-transform:uppercase}h1{font-size:38px;margin:8px 0}h2{font-size:21px;margin:36px 0 12px}.muted,time,small{color:#a8b0bf}dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:#303540;border:1px solid #303540;border-radius:14px;overflow:hidden;margin-top:28px}dl div{background:#1d2129;padding:16px}dt{color:#a8b0bf;font-size:12px;text-transform:uppercase;letter-spacing:.05em}dd{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.message{display:flex;gap:14px;padding:20px 0;border-top:1px solid #303540}.avatar{flex:0 0 38px;height:38px;display:grid;place-items:center;background:#30374a;border-radius:12px;color:#e6bd62;font-weight:700}.body{min-width:0;flex:1}.message header{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:8px 0}a{color:#a3c2ff;overflow-wrap:anywhere}.files{padding:0;list-style:none}footer{margin-top:36px;padding-top:20px;border-top:1px solid #303540;font-size:12px;color:#a8b0bf}@media(max-width:640px){dl{grid-template-columns:1fr}main{padding:24px 16px}h1{font-size:29px}}@media print{body{background:white;color:#111}dl div{background:white}dt,time,small,.muted,footer{color:#555}.avatar{background:#eee;color:#222}.message{break-inside:avoid}}
  </style></head><body><main><div class="eyebrow">Support archive · Closed</div><h1>Ticket ${html(label)}</h1><div class="muted">${html(row.snapshot.server_name)} · ${html(duration)} · ${row.snapshot.messages.length} messages</div><dl>${summary.map(([key, value]) => `<div><dt>${html(key)}</dt><dd>${html(value)}</dd></div>`).join("")}</dl><h2>Conversation</h2><p class="muted">${html(scope)}</p>${
      row.snapshot.messages
          .map(
              (m) =>
                  `<article class="message"><div class="avatar">${html(Array.from(m.author_name)[0] ?? "?")}</div><div class="body"><header><strong>${html(m.author_name)}</strong><time>${html(m.created_at)}</time></header><small>${html(m.author_id)} · Message ${html(m.id)}${m.reply_to ? ` · Reply to ${html(m.reply_to)}` : ""}${m.edited_at ? ` · Edited ${html(m.edited_at)}` : ""}</small><pre>${html(m.text || "[No text]")}</pre>${
                      m.attachments.length
                          ? `<ul class="files">${m.attachments
                                .map((a) => {
                                    const url = safeUrl(a.url);
                                    return `<li>${url ? `<a href="${url}" rel="noreferrer noopener">${html(a.name)}</a>` : html(a.name)}</li>`;
                                })
                                .join("")}</ul>`
                          : ""
                  }</div></article>`,
          )
          .join("") || '<p class="muted">No messages were available.</p>'
  }<footer>Server ID: ${html(row.guild_id)} · Thread ID: ${html(row.thread_id)}<br>Private staff copy · Attachment links may expire. This file contains the captured conversation.</footer></main></body></html>`;
    const base = `ticket-${row.ticket_number.padStart(4, "0")}-${row.thread_id}`;
    const files = [
        { name: `${base}.html`, bytes: Buffer.from(document) },
        { name: `${base}.txt`, bytes: Buffer.from(text) },
    ];
    if (files.reduce((sum, file) => sum + file.bytes.length, 0) > 7_000_000)
        throw new UserError(
            "Transcript files exceed 7 MB. Archive the channel manually or change the transcript setting.",
        );
    const sections = [
        `### People\n**Opened by:** <@${row.opener_id}>\n**Claimed by:** ${row.claimed_by ? `<@${row.claimed_by}>` : "Unclaimed"}\n**Closed by:** ${row.closed_by ? `<@${row.closed_by}>` : "Unknown"}`,
        `### Timeline\n**Opened:** ${stamp(row.created_at)}\n**Closed:** ${stamp(closed)}\n**Duration:** ${duration} · **Messages:** ${row.snapshot.messages.length}`,
        `### Topic\n${escapeMarkdown(row.topic ?? "General support")}\n\n**Close reason**\n${escapeMarkdown(row.close_reason ?? "Resolved")}`,
    ];
    if (row.rating !== null)
        sections.push(
            `### Member review\n⭐ **${row.rating}/5**${row.reviewed_at ? ` · Submitted ${stamp(row.reviewed_at)}` : ""}`,
        );
    return {
        ...card({
            title: `Ticket ${label} archive`,
            icon: "📁",
            body: `<#${row.thread_id}> · **Closed**`,
            sections,
            fileNames: files.map((f) => f.name),
            footer: "Staff copy · HTML transcript + plain text",
        }),
        files: files.map(
            (f) => new AttachmentBuilder(f.bytes, { name: f.name }),
        ),
    };
}
