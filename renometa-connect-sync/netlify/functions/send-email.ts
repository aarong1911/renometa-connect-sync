/// <reference types="node" />
// netlify/functions/send-email.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "" };

  const token = event.headers.authorization?.slice(7);
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };

  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return { statusCode: 401, body: JSON.stringify({ error: "Invalid token" }) };

  const { to, subject, body } = JSON.parse(event.body ?? "{}");
  if (!to || !subject || !body) {
    return { statusCode: 400, body: JSON.stringify({ error: "to, subject, and body required" }) };
  }

  // Get sender name from profile
  const { data: profile } = await admin
    .from("profiles")
    .select("first_name, last_name")
    .eq("id", user.id)
    .maybeSingle();

  const senderName = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || "RenoMeta Connect";

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 587, secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: `"${senderName}" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html: body.replace(/\n/g, "<br>"),
      text: body,
    });

    console.log(`[send-email] sent to ${to} from ${user.email}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("[send-email] failed:", err);
    return { statusCode: 500, body: JSON.stringify({ error: (err as Error).message }) };
  }
};