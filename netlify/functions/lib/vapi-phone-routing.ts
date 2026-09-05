// netlify/functions/lib/vapi-phone-routing.ts
//
// Shared Vapi phone-number routing helpers, extracted from
// assign-voice-number.ts (AI-H1.1) so voice-agent-set-status.ts can reuse
// the exact same provider-verified "put this number in serverUrl mode"
// logic rather than re-implementing it. Behavior is unchanged from the
// original assign-voice-number.ts inline functions.

const VAPI_BASE = 'https://api.vapi.ai';
const WEBHOOK_URL = 'https://connect.renometa.com/.netlify/functions/vapi-webhook';

export { WEBHOOK_URL };

export async function patchVapiPhoneNumberToWebhook(phoneNumberId: string) {
  const patchRes = await fetch(`${VAPI_BASE}/phone-number/${phoneNumberId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // Explicitly clear the hardcoded assistantId so Vapi uses serverUrl instead.
      // If assistantId is left set, Vapi uses it directly and never fires assistant-request.
      assistantId: null,
      serverUrl: WEBHOOK_URL,
    }),
  });

  const patchText = await patchRes.text();
  if (!patchRes.ok) {
    throw new Error(`Vapi PATCH failed: ${patchRes.status} ${patchText}`);
  }

  try { return JSON.parse(patchText); }
  catch { return { raw: patchText }; }
}

export async function fetchVapiPhoneNumber(phoneNumberId: string) {
  const res = await fetch(`${VAPI_BASE}/phone-number/${phoneNumberId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Vapi GET failed: ${res.status} ${text}`);

  try { return JSON.parse(text); }
  catch { throw new Error(`Vapi GET returned invalid JSON: ${text}`); }
}

/**
 * Ensures a Vapi phone number is in serverUrl-routing mode (assistantId
 * cleared, serverUrl pointed at RenoMeta's webhook), patching it if needed
 * and verifying the result. Throws if Vapi's state can't be confirmed —
 * callers must not report success to the UI if this throws.
 */
export async function verifyPhoneNumberInWebhookMode(vapiPhoneNumberId: string): Promise<void> {
  const patchPayload = await patchVapiPhoneNumberToWebhook(vapiPhoneNumberId);
  const verifiedPhone = await fetchVapiPhoneNumber(vapiPhoneNumberId);

  const verifiedServerUrl = verifiedPhone?.serverUrl ?? patchPayload?.serverUrl ?? null;
  let verifiedAssistantId = verifiedPhone?.assistantId ?? patchPayload?.assistantId ?? null;

  if (verifiedServerUrl !== WEBHOOK_URL) {
    throw new Error(
      `Phone number did not switch to webhook routing mode in Vapi (got serverUrl=${verifiedServerUrl})`
    );
  }

  if (verifiedAssistantId) {
    // Some Vapi versions require a second PATCH with just assistantId: null.
    await fetch(`${VAPI_BASE}/phone-number/${vapiPhoneNumberId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assistantId: null }),
    }).catch(() => {});

    const reverified = await fetchVapiPhoneNumber(vapiPhoneNumberId);
    verifiedAssistantId = reverified?.assistantId ?? null;

    if (verifiedAssistantId) {
      throw new Error('Vapi phone number still has a hardcoded assistantId after clearing');
    }
  }
}
