// Jev (TypeSafe AI) client — cheap, fast, typed decisions around the agent loop.
//
// Jev doesn't generate text: it answers predefined Choice questions about a
// "state" and returns per-option probabilities plus a confidence. We use it for
// two routine judgments the agent loop otherwise hard-codes:
//   1. routeEffort   — how much reasoning effort a new task needs.
//   2. classifyOutcome — whether a finished turn actually needs the user.
// Everything here is best-effort: any failure, timeout, or low-confidence answer
// returns undefined and the caller keeps its default behavior.

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
/** Jev answers in ~70-500ms; never hold up the agent longer than this. */
const TIMEOUT_MS = 1500;

export interface JevDecision<T extends string> {
  choice: T;
  confidence: number;
}

interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

async function askChoice<T extends string>(
  apiKey: string,
  state: unknown,
  question: ChoiceQuestion,
  minConfidence: number
): Promise<JevDecision<T> | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(JEV_URL, {
      method: "POST",
      signal: ac.signal,
      // NOTE: auth header shape is unconfirmed in TypeSafe's public docs; Bearer assumed.
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ state, model: JEV_MODEL, questions: { q: question } }),
    });
    if (!res.ok) {
      console.warn(`[celiador-ai] Jev HTTP ${res.status}`);
      return undefined;
    }
    const data = (await res.json()) as { answers?: Record<string, ChoiceAnswer> };
    const a = data.answers?.q;
    if (!a || !(a.choice in question.criteria)) return undefined;
    if (typeof a.confidence !== "number" || a.confidence < minConfidence) return undefined;
    return { choice: a.choice as T, confidence: a.confidence };
  } catch (err: any) {
    console.warn(`[celiador-ai] Jev call failed: ${err?.message ?? err}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ---- 1. Effort routing --------------------------------------------------------

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORT_QUESTION: ChoiceQuestion = {
  type: "choice",
  instructions:
    "A developer sent this request to an AI coding agent working in their repository. How much reasoning effort does the agent need to do it well?",
  criteria: {
    low: "Trivial: a quick factual question, a typo or rename, a one-line change, or explaining a small snippet.",
    medium: "Routine: a small, well-scoped change in one or two files, or a straightforward explanation of a module.",
    high: "Substantial: a multi-file feature or bug fix that needs exploring the codebase first.",
    xhigh: "Hard: a tricky bug with unclear cause, a cross-cutting refactor, or careful design work.",
    max: "Very hard: large architectural change, subtle concurrency/security issues, or deep multi-step debugging.",
  },
};

/** Pick a reasoning effort for a new task, or undefined to keep the configured default. */
export function routeEffort(apiKey: string, prompt: string, priorTurns: number, minConfidence: number): Promise<JevDecision<Effort> | undefined> {
  return askChoice<Effort>(apiKey, { request: prompt.slice(0, 8000), priorTurnsInConversation: priorTurns }, EFFORT_QUESTION, minConfidence);
}

// ---- 2. Turn-outcome classification -------------------------------------------

export type Outcome = "completed" | "needs_user_input" | "blocked" | "partial";

const OUTCOME_QUESTION: ChoiceQuestion = {
  type: "choice",
  instructions:
    "An AI coding agent just stopped working on a task and wrote this final message. What is the state of the task from the user's point of view?",
  criteria: {
    completed: "The agent finished what was asked and is simply reporting the result. Nothing is required from the user.",
    needs_user_input: "The agent is asking the user a question, offering options, or waiting for a decision or confirmation before it can continue.",
    blocked: "The agent could not proceed because of an error, missing access, missing information, or a failing environment.",
    partial: "The agent did some of the work but explicitly left parts undone or recommends follow-up steps.",
  },
};

/** Classify how a turn ended, or undefined if Jev is unsure/unavailable. */
export function classifyOutcome(apiKey: string, finalText: string, filesChanged: string[], minConfidence: number): Promise<JevDecision<Outcome> | undefined> {
  return askChoice<Outcome>(apiKey, { finalMessage: finalText.slice(-6000), filesChanged }, OUTCOME_QUESTION, minConfidence);
}
