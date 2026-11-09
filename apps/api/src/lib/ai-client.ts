// The one AI client interface (roadmap §7). Everything that calls a model
// goes through aiClient(), never through fetch to a provider directly.
//
// Providers (AI_PROVIDER):
// - foundry: Claude in Microsoft Foundry, at AI_ENDPOINT
//   (https://<resource>.services.ai.azure.com/anthropic). Authenticates with
//   AI_API_KEY, or with the app's managed identity (Entra ID) when no key is
//   set. The production target.
// - anthropic: the Anthropic API (development).
// - unset / none: no AI. Callers get a 503 and say so; nothing pretends to be
//   an AI answer.
//
// Model IDs come from config (AI_MODEL, AI_RESEARCH_MODEL), never code.
// Failures throw: a timeout, an HTTP error or an empty answer is an error the
// user sees, not a quiet fallback.
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { httpError } from './http';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  /** Which configured model: 'default' (AI_MODEL) or 'research' (AI_RESEARCH_MODEL). */
  model?: 'default' | 'research';
  system: string;
  messages: AiMessage[];
  maxTokens: number;
  temperature?: number;
}

export interface AiResult {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export interface AiClient {
  readonly provider: string;
  complete(request: AiRequest): Promise<AiResult>;
}

export type AiProvider = 'foundry' | 'anthropic' | 'none';

export function aiProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
  const value = String(env.AI_PROVIDER || '')
    .trim()
    .toLowerCase();
  if (value === 'foundry' || value === 'anthropic') {
    return value;
  }
  return 'none';
}

export function modelFor(kind: AiRequest['model'] = 'default', env = process.env): string {
  const model =
    kind === 'research' ? env.AI_RESEARCH_MODEL || env.AI_MODEL : env.AI_MODEL || undefined;
  if (!model) {
    throw httpError('No AI model is configured (AI_MODEL).', 503);
  }
  return model;
}

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 90_000;

interface MessagesResponse {
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Both providers speak the Messages API; they differ in URL and credentials. */
class MessagesApiClient implements AiClient {
  constructor(
    readonly provider: 'foundry' | 'anthropic',
    private readonly url: string,
    private readonly headers: () => Promise<Record<string, string>>,
  ) {}

  async complete(request: AiRequest): Promise<AiResult> {
    const model = modelFor(request.model);
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(await this.headers()),
        },
        body: JSON.stringify({
          model,
          max_tokens: request.maxTokens,
          temperature: request.temperature ?? 0,
          system: request.system,
          messages: request.messages,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw httpError(
        timedOut
          ? 'The AI service did not answer in time. Please try again.'
          : 'The AI service could not be reached. Please try again.',
        502,
      );
    }
    if (!response.ok) {
      // The body may echo the prompt; it is not logged or returned.
      throw httpError(
        response.status === 429
          ? 'The AI service is busy. Please try again in a minute.'
          : `The AI service failed (${response.status}). Please try again.`,
        502,
      );
    }
    const payload = (await response.json()) as MessagesResponse;
    const text = (payload.content ?? [])
      .filter((block) => block.type === undefined || block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
      .trim();
    if (!text) {
      throw httpError('The AI service returned an empty answer. Please try again.', 502);
    }
    return {
      text,
      provider: this.provider,
      model: payload.model || model,
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
      stopReason: payload.stop_reason ?? null,
    };
  }
}

let credential: TokenCredential | null = null;

function buildClient(env: NodeJS.ProcessEnv = process.env): AiClient | null {
  const provider = aiProvider(env);
  if (provider === 'foundry') {
    const endpoint = String(env.AI_ENDPOINT || '').replace(/\/+$/, '');
    if (!endpoint) {
      throw httpError('AI_ENDPOINT is not set for Microsoft Foundry.', 503);
    }
    const url = endpoint.endsWith('/v1/messages') ? endpoint : `${endpoint}/v1/messages`;
    const key = String(env.AI_API_KEY || '');
    return new MessagesApiClient('foundry', url, async (): Promise<Record<string, string>> => {
      if (key) {
        return { 'api-key': key };
      }
      credential ??= new DefaultAzureCredential({
        managedIdentityClientId: env.AZURE_CLIENT_ID || undefined,
      });
      const token = await credential.getToken('https://ai.azure.com/.default');
      if (!token) {
        throw httpError('Could not get a Microsoft Entra token for the AI service.', 502);
      }
      return { authorization: `Bearer ${token.token}` };
    });
  }
  if (provider === 'anthropic') {
    const key = String(env.AI_API_KEY || env.ANTHROPIC_API_KEY || '');
    if (!key) {
      throw httpError('AI_API_KEY is not set for the Anthropic API.', 503);
    }
    return new MessagesApiClient(
      'anthropic',
      'https://api.anthropic.com/v1/messages',
      async () => ({
        'x-api-key': key,
      }),
    );
  }
  return null;
}

let override: AiClient | null | undefined;

/** Tests install a fake model here; production always builds from config. */
export function setAiClient(client: AiClient | null | undefined): void {
  override = client;
}

export function aiConfigured(): boolean {
  return override !== undefined ? override !== null : aiProvider() !== 'none';
}

/** The configured client; throws a 503 when AI is not set up. */
export function aiClient(): AiClient {
  if (override !== undefined) {
    if (!override) {
      throw httpError('AI is not configured for this platform.', 503);
    }
    return override;
  }
  const client = buildClient();
  if (!client) {
    throw httpError('AI is not configured for this platform.', 503);
  }
  return client;
}

/** The first JSON object in a model answer (models sometimes wrap it in prose or fences). */
export function parseJsonAnswer<T>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as T;
      } catch {
        // fall through
      }
    }
    throw httpError('The AI answer was not in the expected format. Please try again.', 502);
  }
}
