const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'the business';
const BUSINESS_HOURS = process.env.BUSINESS_HOURS || 'Mon-Fri 9am-5pm';

// --- System prompt ---
// TODO: Replace this with your actual business knowledge base
// (services, pricing, policies, FAQs). Keep it concise but complete —
// this is what Claude uses to answer customer questions accurately.
const SYSTEM_PROMPT = `You are a friendly, professional phone receptionist for ${BUSINESS_NAME}.
Business hours: ${BUSINESS_HOURS}.

Your job:
1. Answer customer questions about the business (services, hours, pricing, location, policies).
2. Help customers schedule appointments using the check_availability and book_appointment tools.
3. Keep responses SHORT and conversational — this is a phone call, not a chat window. One or two sentences at a time.
4. If you don't know the answer to something, say so honestly and offer to have someone call them back — do not make up information.
5. If the caller is upset, frustrated, or asks for a human, offer to transfer them (use the transfer_to_human tool).
6. Never invent appointment times, prices, or policies that aren't in your instructions or returned by a tool.

Speak naturally, the way a helpful human receptionist would — avoid sounding scripted or robotic.`;

// --- Tool definitions ---
// These map to real actions your backend performs (check a calendar, book a slot, etc.)
const tools = [
  {
    name: 'check_availability',
    description: 'Check available appointment slots for a given date or date range.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'The date to check, in YYYY-MM-DD format. Infer this from what the caller says (e.g. "tomorrow", "next Tuesday").'
        },
        service: {
          type: 'string',
          description: 'The type of service/appointment being requested, if mentioned.'
        }
      },
      required: ['date']
    }
  },
  {
    name: 'book_appointment',
    description: 'Book a confirmed appointment slot for the caller. Only call this after confirming the exact date/time with the caller and collecting their name and phone number.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: 'HH:MM in 24-hour format' },
        customer_name: { type: 'string' },
        customer_phone: { type: 'string' },
        service: { type: 'string', description: 'What the appointment is for' }
      },
      required: ['date', 'time', 'customer_name', 'customer_phone']
    }
  },
  {
    name: 'transfer_to_human',
    description: 'Transfer the call to a human staff member. Use this when the caller explicitly asks for a person, is upset, or has a request outside what you can help with.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Brief reason for the transfer' }
      },
      required: ['reason']
    }
  }
];

/**
 * Executes a tool call against your real business systems.
 * TODO: Replace the stub logic below with actual Google Calendar / Calendly API calls.
 */
async function executeTool(name, input) {
  switch (name) {
    case 'check_availability':
      // STUB — replace with a real Google Calendar / Calendly availability lookup
      return {
        date: input.date,
        available_slots: ['09:00', '11:00', '14:30', '16:00'],
        note: 'This is placeholder data. Wire this up to your real calendar.'
      };

    case 'book_appointment':
      // STUB — replace with a real calendar booking call
      console.log('[BOOKING]', input);
      return {
        success: true,
        confirmation_id: 'TEMP-' + Date.now(),
        note: 'This is a placeholder booking. Wire this up to your real calendar/CRM.'
      };

    case 'transfer_to_human':
      return { transfer_requested: true, reason: input.reason };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/**
 * Runs one turn of the conversation: takes the running message history plus
 * the caller's latest transcribed utterance, gets Claude's reply (handling
 * any tool calls along the way), and returns the assistant's spoken text.
 */
async function getAssistantReply(messageHistory) {
  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    tools,
    messages: messageHistory
  });

  // Handle tool use loop (Claude may call a tool, then needs the result to respond)
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    messageHistory.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      const result = await executeTool(block.name, block.input);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result)
      });
    }
    messageHistory.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      tools,
      messages: messageHistory
    });
  }

  const textBlock = response.content.find(b => b.type === 'text');
  const replyText = textBlock ? textBlock.text : "I'm sorry, could you repeat that?";

  messageHistory.push({ role: 'assistant', content: replyText });

  return replyText;
}

module.exports = { getAssistantReply, SYSTEM_PROMPT };
