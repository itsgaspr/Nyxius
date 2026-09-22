import Groq from "groq-sdk";
import dotenv from "dotenv";
import { identityFacts, isAboutBot } from "../config/bot.js";

dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const recentQuestions = [];

export async function generateTriviaQuestion(lang = "pt") {
  const topics = [
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
  const topic = topics[Math.floor(Math.random() * topics.length)];
  const answerPosition = ["A", "B", "C", "D"][Math.floor(Math.random() * 4)];
  const language = lang === "en" ? "English" : "Brazilian Portuguese";

  const avoidSection =
    recentQuestions.length > 0
      ? `Do NOT ask about any of these recent questions:\n${recentQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
      : "";

  const completion = await groq.chat.completions.create({
    messages: [
      {
        role: "user",
        content: `Generate a fun and unpredictable trivia question about ${topic} in ${language}. Seed: ${Math.random()} - ${Date.now()}.
${avoidSection}
Only ONE option must be correct, and the correct answer MUST be option ${answerPosition}.
The question and options must be written in ${language}.
Respond ONLY with a valid JSON object, no markdown, no explanation:
{
  "question": "...",
  "options": {
    "A": "...",
    "B": "...",
    "C": "...",
    "D": "..."
  },
  "answer": "${answerPosition}"
}`,
      },
    ],
    model: GROQ_MODEL,
    temperature: 1.5,
    seed: Math.floor(Math.random() * 1000000),
  });

  const raw = completion.choices[0]?.message?.content || "";
  const clean = raw.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  recentQuestions.push(parsed.question);
  if (recentQuestions.length > 20) recentQuestions.shift();

  return parsed;
}

export async function explainTopic(topic, lang = "pt") {
  const language = lang === "en" ? "English" : "Brazilian Portuguese";
  const aboutBot = isAboutBot(topic);
  const userPrompt = aboutBot
    ? `The user asked: "${topic}". They are asking about you / this bot. Answer in ${language} as Nyxius. You MUST include: bot name Nyxius, creator "g a s p r .", version, designation NX-01, and what you can do (moderation, games, YouTube audio, Pinterest SFW, AI). Keep it brief but complete.`
    : `Please provide a clear, concise explanation of: ${topic}. Write in ${language}. Keep it informative but brief (2-3 short paragraphs max). If the topic is about you or this bot, include your identity (Nyxius, created by g a s p r .).`;

  const completion = await groq.chat.completions.create({
    messages: [
      { role: "system", content: identityFacts(lang) },
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
