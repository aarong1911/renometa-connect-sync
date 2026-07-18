/// <reference types="node" />
/**
 * seed-definitions.ts
 * Netlify Function — seeds agent_definitions and tool_definitions if empty.
 * Called by the AI Center store on first load.
 *
 * POST {} → { seeded: boolean }
 */

import type { Handler } from "@netlify/functions";
import { seedAiCenter } from "../../src/lib/seed-ai-center";

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: "Method Not Allowed" }) };

  try {
    await seedAiCenter();
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ seeded: true }) };
  } catch (err: any) {
    console.error("[seed-definitions]", err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
