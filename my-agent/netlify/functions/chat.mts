import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

const GROQ_KEY = process.env.GROQ_API_KEY!;
const APP_TOKEN = process.env.APP_TOKEN!;

const tools = [
  {
    type: "function",
    function: {
      name: "get_time",
      description: "Get the current date and time",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description: "Evaluate a basic math expression like 2*(3+4)",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
    },
  },
];

const toolImpls: Record<string, (a: any) => string> = {
  get_time: () => new Date().toISOString(),
  calculate: ({ expression }) => {
    if (!/^[\d\s+\-*/().%]+$/.test(expression)) return "Invalid expression";
    try {
      return String(Function(`"use strict"; return (${expression})`)());
    } catch {
      return "Error evaluating expression";
    }
  },
};

async function callGroq(messages: any[]) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, tools }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).choices[0].message;
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (req.headers.get("authorization") !== `Bearer ${APP_TOKEN}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { prompt, sid } = await req.json();
  const sessionId = String(sid).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  const store = getStore("chat-history");

  const saved = ((await store.get(sessionId, { type: "json" })) as any[]) ?? [];
  const messages: any[] = [
    { role: "system", content: "You are a helpful agent. Use tools when useful." },
    ...saved,
    { role: "user", content: prompt },
  ];

  try {
    for (let i = 0; i < 5; i++) {
      const msg = await callGroq(messages);
      messages.push(msg);
      if (!msg.tool_calls) {
        const history = [
          ...saved,
          { role: "user", content: prompt },
          { role: "assistant", content: msg.content },
        ].slice(-20);
        await store.setJSON(sessionId, history);
        return Response.json({ reply: msg.content });
      }
      for (const call of msg.tool_calls) {
        const fn = toolImpls[call.function.name];
        const out = fn ? fn(JSON.parse(call.function.arguments || "{}")) : "Unknown tool";
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
      }
    }
    return Response.json({ reply: "Stopped after too many steps." });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
};

export const config: Config = { path: "/chat" };