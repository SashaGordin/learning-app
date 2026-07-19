// Grades submitted active-recall explanations and turns them into durable
// knowledge evidence. Runs frequently, but exits cheaply when no review is
// pending. The PWA submits answers; this server-side job keeps the Anthropic
// key out of the public frontend.

import { ask } from "./lib/claude.js";
import { loadState, saveState, getItemById, listItems } from "./lib/state.js";

const REVIEW_INTERVALS = [1, 7, 30, 90, 180];
const now = new Date();
const isoNow = now.toISOString();

function addDays(date, days) {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out.toISOString().slice(0, 10);
}

function parseJsonObject(raw) {
  let text = String(raw || "").trim();
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

function cleanStrings(value, limit = 8) {
  return Array.isArray(value)
    ? value.filter(v => typeof v === "string" && v.trim()).map(v => v.trim()).slice(0, limit)
    : [];
}

function scheduleFor(verdict, previousStep) {
  const step = Math.min(Math.max(Number(previousStep) || 0, 0), REVIEW_INTERVALS.length - 1);
  if (verdict === "correct") {
    const nextStep = Math.min(step + 1, REVIEW_INTERVALS.length - 1);
    return { reviewStep: nextStep, days: REVIEW_INTERVALS[nextStep] };
  }
  if (verdict === "partial") {
    return { reviewStep: step, days: Math.max(1, Math.floor(REVIEW_INTERVALS[step] / 2)) };
  }
  return { reviewStep: 0, days: 1 };
}

const state = await loadState();
if (!state) {
  console.log("[grade_memory] no state available — skipping");
  process.exit(0);
}

const reviews = Array.isArray(state.memoryReviews) ? state.memoryReviews : [];
const review = reviews
  .filter(r => r?.status === "pending" && r.answer && r.itemId)
  .sort((a, b) => (a.submittedAt || "").localeCompare(b.submittedAt || ""))[0];

if (!review) {
  console.log("[grade_memory] no pending reviews");
  process.exit(0);
}

const item = await getItemById(review.itemId, state);
if (!item) {
  console.warn(`[grade_memory] item ${review.itemId} not found`);
  process.exit(1);
}

const catalog = await listItems(state);
const byId = new Map(catalog.map(i => [i.id, i]));
const candidates = (review.candidateItemIds || [])
  .map(id => byId.get(id))
  .filter(Boolean)
  .slice(0, 12);
const itemMeta = state.items?.[review.itemId] || {};
const existingProfile = state.learnerProfile || null;

const prompt = `Assess one active-recall answer for a personal learning system. Judge the demonstrated knowledge, not the learner's self-rating. Be encouraging but intellectually honest. A confident wrong answer is incorrect; a hesitant correct answer is correct.

LEARNING ITEM
Title: ${item.title}
Source: ${item.source || "—"}
Category: ${item.category || "—"}
Why it matters: ${item.why || "—"}
Original takeaway: ${itemMeta.note || "(none captured)"}

RECALL QUESTION
${review.question}

REFERENCE ANSWER AND RUBRIC
${review.referenceAnswer || "(legacy question; no saved reference answer)"}
${review.keyPoints?.length ? review.keyPoints.map(point => `- ${point}`).join("\n") : "(no saved key points)"}

LEARNER ANSWER
${review.answer}

SELF-ASSESSMENT
${review.selfAssessment}

CURRENT LEARNER PROFILE
${existingProfile ? JSON.stringify(existingProfile) : "(none yet)"}

CANDIDATE NEXT ITEMS FROM THE ACTIVE PATH
${candidates.length ? candidates.map(i => `- ${i.id}: ${i.title} — ${i.why || ""}`).join("\n") : "(none supplied)"}

Return ONLY valid JSON with this shape:
{
  "verdict": "correct" | "partial" | "incorrect",
  "score": 0-100,
  "feedback": "2-4 sentences addressed directly to the learner: what was right, what was missing, and why it matters",
  "correctedAnswer": "a compact ideal answer in 2-4 sentences",
  "knowledgeSummary": "one sentence describing what this answer proves the learner currently understands",
  "demonstratedConcepts": ["specific concept"],
  "knowledgeGaps": ["specific gap or misconception"],
  "profileSummary": "2-4 sentence cumulative summary of the learner's demonstrated knowledge so far, incorporating the prior profile if supplied",
  "profileStrengths": ["durable demonstrated strength"],
  "profileGaps": ["durable gap to work on"],
  "recommendedItemIds": ["zero to three ids copied exactly from the candidate list"],
  "recommendationReason": "one sentence explaining how the next items respond to this answer"
}

Rules:
- Do not infer knowledge that is not evidenced in the answer.
- score measures this answer, not effort or confidence.
- Only recommend candidate ids exactly as provided; use [] if none fit.
- Keep profile strengths/gaps to at most 8 each and consolidate duplicates.`;

console.log(`[grade_memory] grading ${review.id} for ${review.itemId}`);
let assessment;
try {
  assessment = parseJsonObject(await ask(prompt, { maxTokens: 1800, noSearch: true }));
} catch (error) {
  console.error(`[grade_memory] assessment failed: ${error?.message || error}`);
  process.exit(1);
}

const verdict = ["correct", "partial", "incorrect"].includes(assessment.verdict)
  ? assessment.verdict
  : "partial";
const score = Math.min(100, Math.max(0, Number(assessment.score) || 0));
const schedule = scheduleFor(verdict, review.previousReviewStep ?? itemMeta.reviewStep ?? 0);
const recommendedItemIds = cleanStrings(assessment.recommendedItemIds, 3)
  .filter(id => candidates.some(item => item.id === id));

const gradedReview = {
  ...review,
  status: "graded",
  verdict,
  score,
  feedback: String(assessment.feedback || "").trim(),
  correctedAnswer: String(assessment.correctedAnswer || "").trim(),
  knowledgeSummary: String(assessment.knowledgeSummary || "").trim(),
  demonstratedConcepts: cleanStrings(assessment.demonstratedConcepts),
  knowledgeGaps: cleanStrings(assessment.knowledgeGaps),
  recommendedItemIds,
  recommendationReason: String(assessment.recommendationReason || "").trim(),
  gradedAt: isoNow,
  nextReviewAt: addDays(now, schedule.days),
};

state.memoryReviews = reviews.map(r => r.id === review.id ? gradedReview : r).slice(-100);

const priorEvidence = Array.isArray(itemMeta.knowledgeEvidence) ? itemMeta.knowledgeEvidence : [];
const priorMastery = Number.isFinite(Number(itemMeta.masteryScore)) ? Number(itemMeta.masteryScore) : null;
const masteryScore = priorMastery == null ? score : Math.round(priorMastery * 0.6 + score * 0.4);
state.items = {
  ...(state.items || {}),
  [review.itemId]: {
    ...itemMeta,
    reviewStep: schedule.reviewStep,
    nextReviewAt: gradedReview.nextReviewAt,
    lastReviewedAt: isoNow,
    lastReviewVerdict: verdict,
    lastReviewScore: score,
    masteryScore,
    masteryLevel: masteryScore >= 80 ? "strong" : masteryScore >= 50 ? "developing" : "needs_work",
    knowledgeSummary: gradedReview.knowledgeSummary,
    reviewCount: (Number(itemMeta.reviewCount) || 0) + 1,
    knowledgeEvidence: [...priorEvidence, {
      reviewId: review.id,
      score,
      verdict,
      summary: gradedReview.knowledgeSummary,
      reviewedAt: isoNow,
    }].slice(-10),
    updatedAt: isoNow,
  },
};

state.learnerProfile = {
  summary: String(assessment.profileSummary || gradedReview.knowledgeSummary || "").trim(),
  strengths: cleanStrings(assessment.profileStrengths),
  gaps: cleanStrings(assessment.profileGaps),
  evidenceCount: reviews.filter(r => r.status === "graded").length + 1,
  updatedAt: isoNow,
};

if (review.pathId) {
  state.pathRecommendations = {
    ...(state.pathRecommendations || {}),
    [review.pathId]: {
      sourceReviewId: review.id,
      itemIds: recommendedItemIds,
      reason: gradedReview.recommendationReason,
      focusAreas: gradedReview.knowledgeGaps,
      updatedAt: isoNow,
    },
  };
}

const ok = await saveState(state, { ifUnchangedSince: state.__rowUpdatedAt });
if (!ok) {
  console.error("[grade_memory] state save failed; will retry while review remains pending");
  process.exit(1);
}

console.log(`[grade_memory] ${review.id}: ${verdict} ${score}/100, next review ${gradedReview.nextReviewAt}, recommendations=${recommendedItemIds.join(",") || "none"}`);
