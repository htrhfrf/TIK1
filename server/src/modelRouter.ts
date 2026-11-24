import { GoogleGenAI } from '@google/genai';
import {
  getGeminiApiKey,
  TRANSLATION_MODEL_PRIORITY as CONFIG_TRANSLATION_PRIORITY,
  TRANSCRIPTION_MODEL_PRIORITY as CONFIG_TRANSCRIPTION_PRIORITY,
} from './config.js';
import type { ModelMetric } from './types.js';

export const TRANSLATION_MODEL_PRIORITY = CONFIG_TRANSLATION_PRIORITY;
export const TRANSCRIPTION_MODEL_PRIORITY = CONFIG_TRANSCRIPTION_PRIORITY;
export const CANDIDATE_TRANSLATE_MODELS = [...TRANSLATION_MODEL_PRIORITY];

const metrics = new Map<string, { latencies: number[]; metric: ModelMetric }>();
const cooldowns = new Map<string, number>();

function getEntry(model: string) {
  if (!metrics.has(model)) {
    metrics.set(model, {
      latencies: [],
      metric: {
        model,
        attempts: 0,
        successes: 0,
        failures: 0,
        timeouts: 0,
        rate429: 0,
        rate503: 0,
      },
    });
  }
  return metrics.get(model)!;
}

export function recordModelAttempt(
  model: string,
  result: { ok: boolean; latencyMs?: number; status?: number; error?: string },
) {
  const entry = getEntry(model);
  const m = entry.metric;
  m.attempts++;
  if (result.ok) {
    m.successes++;
    m.lastSuccessAt = Date.now();
    if (result.latencyMs != null) entry.latencies.push(result.latencyMs);
    if (entry.latencies.length > 120) entry.latencies.shift();
    m.lastLatencyMs = result.latencyMs;
    const sorted = [...entry.latencies].sort((a, b) => a - b);
    m.p50LatencyMs = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : undefined;
    m.p95LatencyMs = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : undefined;
    cooldowns.delete(model);
  } else {
    m.failures++;
    m.lastError = result.error;
    m.lastStatus = result.status;
    if (result.status === 429) {
      m.rate429++;
    }
    if (result.status === 503) {
      m.rate503++;
    }
    if (/timeout/i.test(result.error || '')) m.timeouts++;
  }
}

export function markModelCooldown(model: string, durationMs = 30_000) {
  cooldowns.set(model, Date.now() + durationMs);
}

export function isModelCooledDown(model: string): boolean {
  const until = cooldowns.get(model);
  if (!until) return false;
  if (until <= Date.now()) {
    cooldowns.delete(model);
    return false;
  }
  return true;
}

export function getRankedModels(candidates = TRANSLATION_MODEL_PRIORITY): string[] {
  // Returns priority-ordered list with active (non-cooldown) models first
  const active = candidates.filter((m) => !isModelCooledDown(m));
  const cooling = candidates.filter((m) => isModelCooledDown(m));
  return active.length > 0 ? [...active, ...cooling] : [...candidates];
}

/**
 * Executes task against models in fastest-first priority order with immediate fallback on failure.
 * Skips in-place retry loops: failure (request or validation) immediately triggers the next model.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, errMsg: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(errMsg)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

export async function callWithModelFallback<T>(
  task: (model: string) => Promise<T>,
  models: readonly string[] | string[] = TRANSLATION_MODEL_PRIORITY,
  timeoutPerModelMs = 18_000,
): Promise<{ value: T; model: string }> {
  let lastError: unknown;
  const list = [...models];

  for (let pass = 0; pass < 2; pass++) {
    // If all models are currently on cooldown, attempt all models in list anyway to probe recovery
    const allCooling = list.every((m) => isModelCooledDown(m));

    for (let i = 0; i < list.length; i++) {
      const model = list[i];
      const nextModel = list[i + 1] || 'none';

      if (!allCooling && isModelCooledDown(model)) {
        continue;
      }

      const started = Date.now();

      try {
        const value = await withTimeout(
          task(model),
          timeoutPerModelMs,
          `${model} timed out after ${Math.round(timeoutPerModelMs / 1000)}s`,
        );
        const latencyMs = Date.now() - started;

        recordModelAttempt(model, {
          ok: true,
          latencyMs,
        });

        return {
          value,
          model,
        };
      } catch (err) {
        const latencyMs = Date.now() - started;
        const message = err instanceof Error ? err.message : String(err);
        const status =
          Number(
            message.match(/\b(400|401|403|404|408|429|500|502|503|504)\b/)?.[1] || 0,
          ) || undefined;

        recordModelAttempt(model, {
          ok: false,
          latencyMs,
          status,
          error: message,
        });

        lastError = err;

        // Fail fast on auth errors
        if (status === 401 || status === 403) {
          throw err;
        }

        // Set cooldown: 404 means model is discontinued/deprecated, lock out for 24 hours
        const cooldownMs =
          status === 404
            ? 24 * 3600_000
            : status === 429
              ? 20_000
              : status === 503
                ? 15_000
                : 10_000;

        markModelCooldown(model, cooldownMs);

        console.warn(
          `[ModelRouter] ${model} failed (${status ? `status ${status}` : message.slice(0, 100)}). Switching to next model: ${nextModel}`,
        );

        // Pause briefly before hitting next model if rate limited or high demand to avoid cascading burst failures
        if (status === 429 || status === 503) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    const lastMsg = lastError instanceof Error ? lastError.message : String(lastError);
    const isTransient = /\b(429|503|504)\b/.test(lastMsg);
    if (!isTransient || pass === 1) break;

    console.log('[ModelRouter] Transient demand/rate limit encountered across models. Pausing 2.5s before retry pass...');
    await new Promise((r) => setTimeout(r, 2500));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('No AI model in the priority list succeeded.');
}

export interface ModelPingResult {
  model: string;
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
  testedAt: number;
}

export async function pingModel(model: string, timeoutMs = 5000): Promise<ModelPingResult> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return {
      model,
      ok: false,
      latencyMs: 0,
      status: 401,
      error: 'Gemini API key not configured',
      testedAt: Date.now(),
    };
  }

  const started = Date.now();
  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    await ai.models.generateContent({
      model,
      contents: 'Reply with OK.',
      config: {
        maxOutputTokens: 5,
        temperature: 0,
      } as any,
    });

    const latencyMs = Date.now() - started;
    recordModelAttempt(model, { ok: true, latencyMs });
    return { model, ok: true, latencyMs, testedAt: Date.now() };
  } catch (err: any) {
    const latencyMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    const status =
      Number(
        message.match(/\b(400|401|403|404|408|429|500|502|503|504)\b/)?.[1] || 0,
      ) || undefined;

    recordModelAttempt(model, { ok: false, latencyMs, status, error: message });
    return { model, ok: false, latencyMs, status, error: message, testedAt: Date.now() };
  }
}

export function getModelStatus() {
  const rows = TRANSLATION_MODEL_PRIORITY.map((model) => ({
    ...getEntry(model).metric,
    cooldownUntil: cooldowns.get(model),
  }));

  const recommendedModel =
    rows.find((r) => !isModelCooledDown(r.model) && (r.successes > 0 || r.attempts === 0))
      ?.model || rows[0]?.model || '';

  return {
    fastestModel: recommendedModel,
    recommendedModel,
    priorityList: [...TRANSLATION_MODEL_PRIORITY],
    transcriptionPriorityList: [...TRANSCRIPTION_MODEL_PRIORITY],
    models: rows,
    activeModels: rows.filter((r) => !isModelCooledDown(r.model)),
    generatedAt: new Date().toISOString(),
  };
}
