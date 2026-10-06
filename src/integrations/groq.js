import Groq from "groq-sdk";
import dotenv from "dotenv";
import { identityFacts, isAboutBot } from "../config/bot.js";

dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const recentQuestions = [];

const NORMAL_TOPICS = [
  "history",
  "science",
  "geography",
  "sports",
  "movies",
  "music",
  "food",
  "technology",
  "animals",
  "literature",
];

const FUN_TOPICS = [
  "Strange laws around the world",
  "Bizarre historical facts",
  "Weird animal behavior",
  "Odd food facts and combinations",
  "Strange things the human body does",
  "Unusual inventions",
  "Science facts that sound fake but are true",
  "Funny mistranslations and language quirks",
  "Weird world records",
  "Strange coincidences in history",
  "Weird facts about emotions and feelings",
  "Funny psychology quirks (why we laugh, cry, blush, get butterflies)",
  "Quirky facts about love, crushes, and friendship around the world",
  "Surprising science of happiness, laughter, and mood",
];

function extractJsonObject(raw) {
  const text = String(raw || "").replace(/```json|```/g, "").trim();
  if (!text) throw new Error("empty_trivia");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("invalid_trivia_json");
    return JSON.parse(text.slice(start, end + 1));
  }
}

function normalizeTrivia(parsed, fallbackAnswer, lang = "pt") {
  const format = String(parsed?.format || "mc").toLowerCase() === "tf" ? "tf" : "mc";
  const question = String(parsed?.question || "").trim();
  const funny = String(parsed?.funny || parsed?.reaction || "").trim();

  let options = {
    A: String(parsed?.options?.A || "").trim(),
    B: String(parsed?.options?.B || "").trim(),
    C: String(parsed?.options?.C || "").trim(),
    D: String(parsed?.options?.D || "").trim(),
  };

  if (format === "tf") {
    const truth = lang === "en" ? "True" : "Verdadeiro";
    const falsy = lang === "en" ? "False" : "Falso";
    options = {
      A: options.A || truth,
      B: options.B || falsy,
      C: options.C || "—",
      D: options.D || "—",
    };
  }

  let answer = String(parsed?.answer || fallbackAnswer || "")
    .toUpperCase()
    .trim();
  if (format === "tf") {
    if (/^(TRUE|VERDADEIRO|V|YES|SIM)$/.test(answer)) answer = "A";
    if (/^(FALSE|FALSO|F|NO|NAO|NÃO)$/.test(answer)) answer = "B";
  }
  answer = answer.replace(/[^ABCD]/g, "").slice(0, 1);
  if (!["A", "B", "C", "D"].includes(answer)) answer = fallbackAnswer;

  if (format === "tf") {
    if (!question || !options.A || !options.B || !["A", "B"].includes(answer)) {
      throw new Error("invalid_trivia_shape");
    }
  } else if (!question || !options.A || !options.B || !options.C || !options.D || !options[answer]) {
    throw new Error("invalid_trivia_shape");
  }

  return { question, options, answer, format, funny };
}

function funSystemPrompt(language) {
  return `You are a very funny WhatsApp trivia host. You generate FUN MODE questions in ${language}.

HUMOR — this is mandatory, and there must be a lot of it
- Be genuinely funny: wordplay, absurd comparisons, comic timing, a wink in the wording.
- Wrong options must be specific and laugh-out-loud silly, not boring near-misses.
- The "funny" field is a short comedy bit (2-4 sentences): state the true fact clearly, then land a real punchline. A mild smile is not enough.
- Clean humor only. No insults at the players, no slurs, no sexual content, no jokes about death, illness, tragedy, or family trauma.
- Facts must be real. If you are not sure, pick a fact you know is true. Never invent the correct answer.

STYLE
- Still a real QUESTION (who/what/which/how/true-false), short enough for a group chat.
- Never start with "Did you know", "Sabias que", "Você sabia", "Curiosidade:", or similar.
- Sound like a witty friend who cannot help being funny, not like a textbook.

Output one compact JSON object only. No markdown.`;
}

function funUserPrompt({ topic, language, answerPosition, format, avoidSection }) {
  const formatHint =
    format === "tf"
      ? `Use format "tf" (true/false). Options A/B must be True/False in ${language}. Answer letter must be "${answerPosition === "B" ? "B" : "A"}".`
      : `Use format "mc" (4 options). Correct option letter MUST be "${answerPosition}".`;

  const forcedAnswer =
    format === "tf" ? (answerPosition === "B" ? "B" : "A") : answerPosition;

  return `Create ONE funny, curious trivia QUESTION about: ${topic}
Language: ${language}
${formatHint}
${avoidSection}

The question itself should already be playful. The wrong answers should make people laugh. The "funny" field must explain the real fact AND joke hard.

Good question vibe (style only, invent a new one):
- "Which animal files 'standing nap' as a lifestyle and not a bit?"
- "Which country once said a lone guinea pig was a crime against guinea pigs?"
- "True or false: an octopus packs three hearts, which is two more than most group chats."

Bad (do NOT do this):
- "Did you know that octopuses have three hearts?"
- "Sabias que o polvo tem três corações?"
- Dry textbook wording, or wrong options that are just slightly incorrect dates.

Return ONLY valid JSON:
{"format":"${format}","question":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"answer":"${forcedAnswer}","funny":"..."}`;
}

export async function generateTriviaQuestion(lang = "pt", mode = "normal") {
  const language = lang === "en" ? "English" : "Brazilian Portuguese";
  const fun = mode === "fun";
  const topics = fun ? FUN_TOPICS : NORMAL_TOPICS;
  const avoid = recentQuestions.slice(-8).map((q) => q.slice(0, 80));
  const avoidSection =
    avoid.length > 0
      ? `Do NOT repeat these recent questions:\n${avoid.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
      : "";

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const topic = topics[Math.floor(Math.random() * topics.length)];
    const answerPosition = ["A", "B", "C", "D"][Math.floor(Math.random() * 4)];
    const format = fun && Math.random() < 0.35 ? "tf" : "mc";
    try {
      const request = {
        messages: fun
          ? [
              { role: "system", content: funSystemPrompt(language) },
              {
                role: "user",
                content: funUserPrompt({
                  topic,
                  language,
                  answerPosition,
                  format,
                  avoidSection,
                }),
              },
            ]
          : [
              {
                role: "system",
                content: `You generate trivia questions in a warm, very funny voice. Output one compact JSON object only. No markdown, no prose.
Facts must be real. Humor is required: a playful question, silly-but-tempting wrong options, and a "funny" field of 2-3 sentences that explains the fact and then lands a joke.
Clean humor only — no insults, slurs, sexual content, or jokes about death, illness, or tragedy.
Never start with "Did you know" / "Sabias que" / "Você sabia".`,
              },
              {
                role: "user",
                content: `Create one short, funny trivia question about ${topic}.
Language for question, options, and the joke: ${language}.
Correct option letter must be "${answerPosition}".
${avoidSection}
Return ONLY valid JSON:
{"format":"mc","question":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"answer":"${answerPosition}","funny":"..."}`,
              },
            ],
        model: GROQ_MODEL,
        temperature: fun ? 0.95 : 0.85,
        max_tokens: 1600,
        reasoning_effort: "low",
        seed: Math.floor(Math.random() * 1000000),
      };
      if (attempt === 1 && lang === "en") {
        request.response_format = { type: "json_object" };
      }
      const completion = await groq.chat.completions.create(request);
      const message = completion.choices[0]?.message || {};
      const raw = message.content || message.reasoning || "";
      if (!String(message.content || "").trim()) {
        console.warn(
          `⚠️  trivia empty content lang=${lang} mode=${mode} attempt=${attempt} reasoning=${String(message.reasoning || "").length}`,
        );
      }
      const parsed = normalizeTrivia(extractJsonObject(raw), answerPosition, lang);
      recentQuestions.push(parsed.question);
      if (recentQuestions.length > 20) recentQuestions.shift();
      return parsed;
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️  trivia generate attempt ${attempt} failed:`, err.message);
    }
  }
  throw lastErr || new Error("trivia_fail");
}

const ASK_FORMAT_RULES = `You write WhatsApp messages that look polished and friendly — like a witty helpful friend, never a stiff robot.
Tone: warm, light, lightly funny when it fits. No corporate jargon.
Formatting rules (mandatory):
- Use WhatsApp markup only: *bold* with ONE asterisk on each side, _italic_ with underscores.
- NEVER use **double asterisks**, markdown headings (#), or \`\`\` code fences.
- Structure the answer like this:
  1) One short hook line in *bold*
  2) 1–3 short paragraphs (blank line between them)
  3) Optional mini-list with "• " bullets (2–5 items) when it helps
- Keep it scannable and clear. No walls of text.
- Do not repeat the user's question as a giant title.`;

export async function explainTopic(topic, lang = "pt") {
  const language = lang === "en" ? "English" : "Brazilian Portuguese";
  const aboutBot = isAboutBot(topic);
  const userPrompt = aboutBot
    ? `The user asked: "${topic}". They are asking about you / this bot.
Answer in ${language} as Nyxius, in character.
You MUST include these facts, formatted prettily (labels in *bold*):
• *name* — Nyxius
• *designation* — NX-01
• *creator* — g a s p r .
• *version* — include the current version from your identity
• *what I do* — moderation, games (trivia, hangman, tic-tac-toe, truth or dare), SFW Pinterest (.pin), AI (.ask)
End with a short line inviting *.help* / *.ajuda*.
Keep it complete but not long.`
    : `Explain clearly: ${topic}
Language: ${language}.
Be informative but brief. Prefer clarity over length.
If the topic is about you / this bot, include your Nyxius identity (created by g a s p r .).`;

  const completion = await groq.chat.completions.create({
    messages: [
      {
        role: "system",
        content: `${identityFacts(lang)}\n\n${ASK_FORMAT_RULES}`,
      },
      { role: "user", content: userPrompt },
    ],
    model: GROQ_MODEL,
    temperature: 0.7,
  });

  return (
    completion.choices[0]?.message?.content ||
    "Unable to generate explanation."
  );
}

export async function explainTriviaAnswer(
  { question, options, answer },
  lang = "pt",
) {
  const language = lang === "en" ? "English" : "Brazilian Portuguese";
  const optionText = options?.[answer] || "";
  const allOptions = ["A", "B", "C", "D"]
    .map((key) => `${key}) ${options?.[key] || ""}`)
    .join("\n");

  const completion = await groq.chat.completions.create({
    messages: [
      {
        role: "system",
        content: `${identityFacts(lang)} For emphasis in WhatsApp, use *single* asterisks only (*like this*). Never use **double** markdown asterisks.`,
      },
      {
        role: "user",
        content: `A trivia player just answered. Explain why the correct option is right, in ${language}. Be clear first, then very funny: a real joke or a playful image, not a polite smile. 3-5 short sentences. Do not invent a different correct option.

Question: ${question}
Options:
${allOptions}
Correct answer: ${answer}) ${optionText}`,
      },
    ],
    model: GROQ_MODEL,
    temperature: 0.85,
  });

  return (
    completion.choices[0]?.message?.content ||
    "Unable to generate explanation."
  );
}

export async function celebrateTriviaMatch({
  lang = "pt",
  draw = false,
  winnerNumber = "",
  loserNumber = "",
  aNumber = "",
  bNumber = "",
  scoreWinner = 0,
  scoreLoser = 0,
} = {}) {
  const language = lang === "en" ? "English" : "Brazilian Portuguese";
  const who = draw
    ? `It is a draw between @${aNumber} and @${bNumber}, score ${scoreWinner}–${scoreLoser}.`
    : `@${winnerNumber} won ${scoreWinner}–${scoreLoser} against @${loserNumber}.`;

  const completion = await groq.chat.completions.create({
    messages: [
      {
        role: "system",
        content: `You write the closing message of a friendly WhatsApp trivia match, in ${language}.
Tone: very warm, affectionate, proud, and lightly funny — like a friend who is genuinely happy for both people.
Celebrate hard. Be kind to whoever did not win. No mockery, no "better luck loser", no cold sports-announcer voice.
3 to 6 short lines. Use *single* asterisks for emphasis. Never use **double** asterisks or markdown headings.
Mention both people with the exact @numbers given. Include the score.
Plain text only. No JSON.`,
      },
      { role: "user", content: who },
    ],
    model: GROQ_MODEL,
    temperature: 0.9,
    max_tokens: 400,
    reasoning_effort: "low",
  });

  const text = String(completion.choices[0]?.message?.content || "")
    .replace(/```/g, "")
    .trim();
  if (text.length < 40 || text.length > 700) return "";
  const needed = draw ? [aNumber, bNumber] : [winnerNumber, loserNumber];
  if (needed.some((n) => n && !text.includes(n))) return "";
  return text;
}

const recentTod = [];

function todLevelGuide(level, kind) {
  if (kind === "truth") {
    if (level === "profundo") {
      return "DEEP but safe: reflective, emotional, friendship/life meaning. Still appropriate for a mixed group chat. No trauma mining, no sexual content, no politics fights.";
    }
    if (level === "medio") {
      return "MEDIUM: a bit more personal/funny-awkward, still friendly. Mild secrets, quirks, social moments. No NSFW, no cruelty.";
    }
    return "LIGHT: fun, silly, low-stakes preferences and opinions. Easy to answer in public.";
  }
  if (level === "profundo") {
    return "DEEP dare but NON-INVASIVE: wholesome/funny challenges like a short sincere voice note, a creative photo of a nearby object/hand/view, or a playful dedication. Never body exposure, never leave the house, never contact strangers, never drink/drugs.";
  }
  if (level === "medio") {
    return "MEDIUM dare: funny WhatsApp actions — silly voice notes, photo of shoe/thumb/ceiling/random object nearby, short hummed tune. Embarrassing-funny only, never invasive.";
  }
  return "LIGHT dare: quick silly WhatsApp tasks — short funny voice note, photo of thumb/object, dramatic one-liner. Completely safe and optional-feeling.";
}

export async function generateTruthOrDare({ kind = "truth", level = "leve", lang = "pt" } = {}) {
  const language = lang === "en" ? "English" : "Brazilian Portuguese";
  const type = kind === "dare" ? "dare" : "truth";
  const intensity = ["leve", "medio", "profundo"].includes(level) ? level : "leve";
  const avoid = recentTod.slice(-10).map((q) => q.slice(0, 100));
  const avoidSection =
    avoid.length > 0
      ? `Do NOT repeat these recent prompts:\n${avoid.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
      : "";

  const completion = await groq.chat.completions.create({
    messages: [
      {
        role: "system",
        content:
          "You write playful Truth or Dare (verdade ou consequência) prompts for a friendly WhatsApp group bot. Output one compact JSON object only. No markdown, no prose.",
      },
      {
        role: "user",
        content: `Create ONE ${type === "dare" ? "dare / consequência" : "truth / verdade"} prompt for a WhatsApp group game.
Language: ${language}.
Intensity: ${intensity}.
Guide: ${todLevelGuide(intensity, type)}

Hard rules:
- SFW only. No sexual, romantic pressure, body exposure, or "show skin".
- No illegal, dangerous, expensive, or public humiliation tasks.
- No asking for passwords, addresses, phone numbers, money, or private photos of other people.
- Dares must be doable from the phone in under ~1 minute (voice note, selfie of hand/object, typed line).
- For photo dares, prefer harmless objects (thumb, shoe, ceiling, snack, notebook) — never private spaces that feel invasive.
- Keep the prompt to 1-2 short sentences. Witty and friendly, not robotic.
- ALWAYS start the prompt with 1–2 fitting emojis that match the vibe of THAT specific prompt (e.g. 🎤 for voice, 📸 for photo, 🫢 for awkward truth, 🧃 for silly snack stuff, 🎭 for acting).
- NEVER use ❌, ✖️, ✖, ❎, ✝️, †, or any "cross / X" emoji.
- Prefer fun emojis: 😂 🤭 🎤 📸 👀 🙈 🧃 🕺 💬 🌈 🐱 ✨ 🍀 etc.

${avoidSection}

Return ONLY valid JSON:
{"prompt":"..."}`,
      },
    ],
    model: GROQ_MODEL,
    temperature: 0.95,
    max_tokens: 400,
    reasoning_effort: "low",
    seed: Math.floor(Math.random() * 1000000),
  });

  const message = completion.choices[0]?.message || {};
  const raw = message.content || message.reasoning || "";
  const parsed = extractJsonObject(raw);
  let prompt = String(parsed?.prompt || "").trim();
  // Never let a cross/X mark slip into ToD prompts
  prompt = prompt.replace(/[❌✖️✖❎✝️†]/gu, "").replace(/\s{2,}/g, " ").trim();
  if (!prompt || prompt.length < 8) throw new Error("empty_tod");
  // If the model forgot emojis, prepend a light default by kind
  if (!/\p{Extended_Pictographic}/u.test(prompt)) {
    prompt = `${type === "dare" ? "🎭✨" : "🫢💬"} ${prompt}`;
  }
  recentTod.push(prompt);
  if (recentTod.length > 24) recentTod.shift();
  return prompt;
}
