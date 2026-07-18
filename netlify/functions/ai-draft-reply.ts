import type { Handler } from "@netlify/functions";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  let reqBody: {
    channel: "sms" | "email";
    contactName: string;
    conversationHistory: { role: "user" | "assistant"; content: string }[];
    currentDraft?: string;
  };
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { channel, contactName, conversationHistory, currentDraft } = reqBody;
  if (!channel || !contactName) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "channel and contactName are required" }) };
  }

  const isSMS = channel === "sms";
  const systemPrompt = `You are a professional customer service rep for a home renovation contractor.
Draft a helpful, friendly reply to the client named ${contactName}.
${isSMS ? "Keep it concise — under 160 characters for SMS." : "Write a complete, professional email reply."}
Respond ONLY with the message text. No subject line, no greeting prefix, no explanation.`;

  const messages = [
    ...(conversationHistory ?? []),
    {
      role: "user" as const,
      content: currentDraft
        ? `My current draft is: "${currentDraft}"\nImprove it or replace it with a better reply.`
        : "Draft a reply for me.",
    },
  ];

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: isSMS ? 200 : 600,
        system: systemPrompt,
        messages,
      }),
    });

    if (!res.ok) {
      const err: any = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `Anthropic error ${res.status}`);
    }

    const data: any = await res.json();
    const draft = data.content?.[0]?.text?.trim() ?? "";
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ draft }) };
  } catch (err: any) {
    console.error("[ai-draft-reply]", err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
