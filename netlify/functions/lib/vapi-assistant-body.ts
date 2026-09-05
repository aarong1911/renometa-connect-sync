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
          'Check appointment availability for a requested date and optional time before booking.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Requested appointment date, like tomorrow or next Monday' },
            time: { type: 'string', description: 'Requested appointment time, like 10am' },
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
        description: 'Book a confirmed appointment after the caller agrees to a specific date and time.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Confirmed appointment date' },
            time: { type: 'string', description: 'Confirmed appointment time' },
            name: { type: 'string', description: 'Caller full name' },
            phone: { type: 'string', description: 'Caller phone number' },
            email: { type: 'string', description: 'Caller email address' },
            address: { type: 'string', description: 'Project address' },
            service: { type: 'string', description: 'Requested service or project type' },
            budget: { type: 'string', description: 'Mentioned project budget' },
            timeline: { type: 'string', description: 'Mentioned project timeline' },
            notes: { type: 'string', description: 'Important appointment notes' },
          },
          required: ['date', 'time'],
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
