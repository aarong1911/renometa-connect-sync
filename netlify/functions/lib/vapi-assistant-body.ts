// netlify/functions/lib/vapi-assistant-body.ts
//
// Server-side Vapi assistant body builder (AI-H1.1 correction pass). Moved
// here from voice-agent-tab.tsx so voice-agent-save.ts — not the browser —
// is the one place that constructs the Vapi payload, including the
// required webhook credential (never sent to the client).

import { WEBHOOK_URL } from './vapi-phone-routing';

export type CrmTools = {
  saveLeads: boolean;
  checkAvailability: boolean;
  bookAppointment: boolean;
  getServiceInfo: boolean;
};

export const DEFAULT_CRM_TOOLS: CrmTools = {
  saveLeads: true,
  checkAvailability: true,
  bookAppointment: true,
  getServiceInfo: true,
};

type VapiToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
  };
};

// AI-H1.1 model-audit fix — provider must match the selected model. This was
// previously hardcoded to 'anthropic' regardless of which model id was sent,
// so selecting "GPT-4o" would have serialized as { provider: 'anthropic',
// model: 'gpt-4o' } — a combination Vapi cannot run correctly.
function inferModelProvider(model: string): 'anthropic' | 'openai' {
  return model.startsWith('gpt-') ? 'openai' : 'anthropic';
}

export type VapiAssistantBody = {
  name: string;
  firstMessage: string;
  serverUrl: string;
  serverMessages: string[];
  server: { url: string; credentialId: string };
  model: {
    provider: 'anthropic' | 'openai';
    model: string;
    systemPrompt: string;
    tools: VapiToolDefinition[];
  };
  voice: {
    provider: '11labs';
    voiceId: string;
  };
  endCallPhrases: string[];
  transcriber?: {
    provider: 'deepgram';
    model: string;
  };
};

function buildVapiTools(crmTools: CrmTools): VapiToolDefinition[] {
  const tools: VapiToolDefinition[] = [];

  if (crmTools.saveLeads) {
    tools.push({
      type: 'function',
      function: {
        name: 'save_lead',
        description:
          "Save the caller's contact information and project details into the CRM when the caller provides lead information.",
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Caller full name' },
            phone: { type: 'string', description: 'Caller phone number' },
            email: { type: 'string', description: 'Caller email address' },
            address: { type: 'string', description: 'Project address' },
            service: { type: 'string', description: 'Requested service or project type' },
            budget: { type: 'string', description: 'Mentioned project budget' },
            timeline: { type: 'string', description: 'Mentioned project timeline' },
            notes: { type: 'string', description: 'Important call notes' },
          },
          required: [],
        },
      },
    });
  }

  if (crmTools.checkAvailability) {
    tools.push({
      type: 'function',
      function: {
        name: 'check_availability',
        description:
          'Check whether a specific date and time is open. Call this whenever the caller names or changes a desired day/time, before book_appointment or reschedule_appointment. The newest successful check is the one that gets booked.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Requested date, e.g. "tomorrow", "next Monday", "April 15"' },
            time: { type: 'string', description: 'Requested time, e.g. "10am", "2:30pm"' },
          },
          required: ['date'],
        },
      },
    });
  }

  if (crmTools.bookAppointment) {
    tools.push({
      type: 'function',
      function: {
        name: 'book_appointment',
        description:
          'Confirm the appointment after check_availability returned "available" for the slot the caller agreed to. The server already holds the confirmed slot and the caller details for this call, so calling with an empty object {} is valid; any fields you do pass are used as-is. Safe to call more than once — repeat calls return the same booking.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Confirmed date (optional — omit to use the last checked slot)' },
            time: { type: 'string', description: 'Confirmed time (optional — omit to use the last checked slot)' },
            name: { type: 'string', description: 'Caller full name (optional)' },
            phone: { type: 'string', description: 'Caller phone number (optional)' },
            email: { type: 'string', description: 'Caller email address (optional)' },
            address: { type: 'string', description: 'Project address (optional)' },
            service: { type: 'string', description: 'Service or project type in the caller\'s own words (optional)' },
            budget: { type: 'string', description: 'Mentioned budget (optional)' },
            timeline: { type: 'string', description: 'Mentioned timeline (optional)' },
            notes: { type: 'string', description: 'Important notes (optional)' },
          },
          required: [],
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'reschedule_appointment',
        description:
          'Move this caller\'s existing appointment to a new time. First call check_availability for the new slot. The server finds the existing appointment from the caller\'s record — pass current_date only if the server asks you to disambiguate between several upcoming appointments. Safe to call more than once.',
        parameters: {
          type: 'object',
          properties: {
            new_date: { type: 'string', description: 'New date (optional — omit to use the last checked slot)' },
            new_time: { type: 'string', description: 'New time (optional — omit to use the last checked slot)' },
            current_date: { type: 'string', description: 'The existing appointment\'s current date — only when disambiguating between multiple upcoming appointments' },
          },
          required: [],
        },
      },
    });
  }

  if (crmTools.getServiceInfo) {
    tools.push({
      type: 'function',
      function: {
        name: 'get_service_info',
        description: 'Answer basic questions about company services, project types, pricing process, or service availability.',
        parameters: {
          type: 'object',
          properties: {
            service: { type: 'string', description: 'Service the caller is asking about' },
          },
          required: [],
        },
      },
    });
  }

  return tools;
}

export function buildVapiAssistantBody(params: {
  name: string;
  greeting: string;
  llm: string;
  systemPrompt: string;
  voice: string;
  endPhrases: string;
  crmTools: CrmTools;
  credentialId: string;
  includeCreateOnlyFields?: boolean;
}): VapiAssistantBody {
  const {
    name,
    greeting,
    llm,
    systemPrompt,
    voice,
    endPhrases,
    crmTools,
    credentialId,
    includeCreateOnlyFields = false,
  } = params;

  const body: VapiAssistantBody = {
    name,
    firstMessage: greeting,
    serverUrl: WEBHOOK_URL,
    serverMessages: ['status-update', 'tool-calls', 'end-of-call-report', 'hang'],
    server: { url: WEBHOOK_URL, credentialId },
    model: {
      provider: inferModelProvider(llm),
      model: llm,
      systemPrompt,
      tools: buildVapiTools(crmTools),
    },
    voice: {
      provider: '11labs',
      voiceId: voice,
    },
    endCallPhrases: endPhrases
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  };

  if (includeCreateOnlyFields) {
    body.transcriber = {
      provider: 'deepgram',
      model: 'nova-2',
    };
  }

  return body;
}
