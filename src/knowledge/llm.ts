/**
 * Text-generation provider for knowledge summarization — the CLI/`dim knowledge sync`
 * "LLM fallback" when no MCP agent is in the loop. Auto-detects the same way the
 * embedding provider does: OpenAI if OPENAI_API_KEY is set, else a local Ollama, else
 * none (in which case docs simply wait in the inbox until a provider/agent appears).
 *
 *   AIDIMAG_LLM = auto (default) | openai | ollama | off
 *   AIDIMAG_OPENAI_CHAT_MODEL  (default gpt-4o-mini)
 *   AIDIMAG_OLLAMA_CHAT_MODEL  (default llama3.1)
 *   AIDIMAG_OLLAMA_URL         (default http://localhost:11434)
 */

export interface TextProvider {
  readonly name: string;
  readonly model: string;
  /** Returns the model's raw text response (expected to be JSON for our prompts). */
  generate(system: string, user: string): Promise<string>;
}

const OLLAMA_URL = process.env.AIDIMAG_OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_CHAT_MODEL = process.env.AIDIMAG_OLLAMA_CHAT_MODEL ?? "llama3.1";
const OPENAI_CHAT_MODEL = process.env.AIDIMAG_OPENAI_CHAT_MODEL ?? "gpt-4o-mini";

class OpenAiTextProvider implements TextProvider {
  readonly name = "openai";
  readonly model = OPENAI_CHAT_MODEL;

  async generate(system: string, user: string): Promise<string> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI chat: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return body.choices[0]?.message?.content ?? "";
  }
}

class OllamaTextProvider implements TextProvider {
  readonly name = "ollama";
  readonly model = OLLAMA_CHAT_MODEL;

  async generate(system: string, user: string): Promise<string> {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        system,
        prompt: user,
        format: "json",
        stream: false,
        options: { temperature: 0.1 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama generate: HTTP ${res.status}`);
    const body = (await res.json()) as { response?: string };
    return body.response ?? "";
  }

  static async detect(): Promise<OllamaTextProvider | null> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      return new OllamaTextProvider();
    } catch {
      return null;
    }
  }
}

let cached: TextProvider | null | undefined;

/** Resolve the text/LLM provider (cached per process). null = none available. */
export async function getTextProvider(): Promise<TextProvider | null> {
  if (cached !== undefined) return cached;
  const mode = (process.env.AIDIMAG_LLM ?? "auto").toLowerCase();

  if (mode === "off") return (cached = null);
  if (mode === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("AIDIMAG_LLM=openai but OPENAI_API_KEY is not set");
    return (cached = new OpenAiTextProvider());
  }
  if (mode === "ollama") {
    const p = await OllamaTextProvider.detect();
    if (!p) throw new Error(`AIDIMAG_LLM=ollama but Ollama is not reachable at ${OLLAMA_URL}`);
    return (cached = p);
  }
  // auto
  if (process.env.OPENAI_API_KEY) return (cached = new OpenAiTextProvider());
  return (cached = await OllamaTextProvider.detect());
}

