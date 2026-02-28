import type { ExtractedEndpoint, ApiEvaluation } from './utils';

export async function llmExtractEndpoints(markdown: string, apiName: string): Promise<ExtractedEndpoint[]> {
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) return [];

  const truncated = markdown.length > 80000 ? markdown.slice(0, 80000) : markdown;

  const prompt = `Extract ALL API endpoints from this documentation. The documentation may come from multiple pages separated by "---". For each endpoint provide:
- method: HTTP method (GET, POST, PUT, DELETE, PATCH)
- path: the endpoint path (e.g. /v1/payments/{id})
- summary: short name/title (e.g. "Create Payment")
- description: one-sentence description
- section: the category/group this endpoint belongs to (e.g. "Payments", "Users", "Webhooks")
- parameters: array of {name, type, required, description, in} objects
- responses: object with status codes as keys and {description} as values

If the page has NO actual API endpoints listed, return {"endpoints": []}.
Deduplicate — if the same endpoint appears on multiple pages, include it only once.

Return ONLY valid JSON: {"endpoints": [...]}

API: ${apiName}
Documentation:
${truncated}`;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        temperature: 0,
        max_tokens: 8000,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.endpoints) ? parsed.endpoints : []);

    return arr
      .filter((e: any) => e?.method && e?.path)
      .map((e: any) => ({
        method: String(e.method).toUpperCase(),
        path: String(e.path),
        summary: e.summary ?? null,
        description: e.description ?? null,
        section: e.section ?? null,
        parameters: Array.isArray(e.parameters) ? e.parameters : [],
        responses: e.responses && typeof e.responses === 'object' ? e.responses : {},
      }));
  } catch {
    return [];
  }
}

export async function llmEvaluateApi(markdown: string, apiName: string, apiId: string): Promise<ApiEvaluation | null> {
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) return null;

  const truncated = markdown.length > 40000 ? markdown.slice(0, 40000) : markdown;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: `You are an API integration expert. Analyze this API documentation AND use your training knowledge about "${apiName}" (${apiId}) to produce a concise integration guide for a coding agent.

The documentation below may be incomplete. Supplement with what you know about this API from your training data — SDKs, pricing, common gotchas, rate limits, etc.

Return JSON:
{
  "purpose": "One sentence: what this API does",
  "auth": { "method": "e.g. Bearer token, API key, OAuth2", "details": "How to authenticate, where to get keys" },
  "pricing": { "model": "e.g. per-request, per-seat, freemium", "free_tier": true/false, "details": "Key pricing info for a developer deciding whether to use this" },
  "rate_limits": { "description": "Specific limits if known, otherwise 'Unknown'", "recommendation": "Concrete advice: e.g. 'Add 100ms delay between requests' or 'Use exponential backoff'" },
  "sdks": ["List official SDK languages/packages, e.g. '@duffel/api (Node.js)', 'duffel-api (Python)'"],
  "gotchas": ["Actionable warnings a developer MUST know before implementing. e.g. 'Offers expire after 30 minutes — cache and refresh', 'Sandbox and production use different API keys', 'Pagination is cursor-based, not offset-based'. Be specific and practical."],
  "best_for": "One sentence: ideal use case",
  "alternatives": ["2-4 competing APIs by domain, e.g. 'amadeus.com', 'kiwi.com'"]
}

Be concise but specific. Every gotcha should be actionable. Every field should help a coding agent make better implementation decisions.

API: ${apiName} (${apiId})
Documentation:
${truncated}`,
        }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) return null;
    return JSON.parse(raw) as ApiEvaluation;
  } catch {
    return null;
  }
}
