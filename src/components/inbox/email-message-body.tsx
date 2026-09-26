// Email-specific message body for the Conversations thread. Email is not SMS:
// it has a distinct subject, multi-paragraph text, an optional signature and
// quoted earlier messages. Everything is rendered as TEXT (never as HTML), so
// email markup cannot execute or load remote content (no tracking pixels).
//
// Layout (all presentation-only — see src/lib/email-body-presentation.ts):
//   subject (own line, only where it changes)
//   authored message (paragraphs and line breaks preserved)
//   signature (visually separated, muted)
//   "Show quoted text" toggle -> folded earlier thread

import { useMemo, useState } from "react";
import { dequote, splitEmailBody } from "@/lib/email-body-presentation";

export function EmailMessageBody({
  body,
  subject,
  showSubject,
}: {
  body: string;
  subject?: string;
  showSubject: boolean;
}) {
  const parts = useMemo(() => splitEmailBody(body), [body]);
  const [showQuoted, setShowQuoted] = useState(false);

  return (
    <div className="space-y-2">
      {showSubject && subject && <div className="text-[13px] font-semibold leading-snug">{subject}</div>}
      {parts.main ? (
        <div className="whitespace-pre-wrap break-words">{parts.main}</div>
      ) : (
        !parts.quoted && !parts.signature && <div className="italic opacity-60">(no message content)</div>
      )}
      {parts.signature && (
        <div className="whitespace-pre-wrap break-words border-t border-current/10 pt-2 text-xs opacity-60">{parts.signature}</div>
      )}
      {parts.quoted && (
        <div>
          <button
            type="button"
            onClick={() => setShowQuoted((v) => !v)}
            aria-expanded={showQuoted}
            className="rounded border border-current/15 px-1.5 py-0.5 text-[11px] opacity-60 hover:opacity-100"
          >
            {showQuoted ? "Hide quoted text" : "Show quoted text"}
          </button>
          {showQuoted && (
            <div className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-current/20 pl-2 text-xs opacity-60">
              {dequote(parts.quoted)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
