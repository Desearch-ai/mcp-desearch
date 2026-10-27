// Replace with the token copied from the OpenAI Apps portal (Verify Domain).
export const OPENAI_APPS_CHALLENGE_TOKEN = "REPLACE_WITH_OPENAI_APPS_CHALLENGE_TOKEN";

export function openaiAppsChallengeToken(): string | null {
    const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN?.trim() || OPENAI_APPS_CHALLENGE_TOKEN;
    return token && token !== "REPLACE_WITH_OPENAI_APPS_CHALLENGE_TOKEN" ? token : null;
}
