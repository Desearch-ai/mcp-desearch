// Public token from the OpenAI Apps portal (Verify Domain); the env var overrides it.
export const OPENAI_APPS_CHALLENGE_TOKEN = "izKGHpAfQ5WzE5-QR0SrRad5StYDEzjKi434MfJGQPI";
const PLACEHOLDER = "REPLACE_WITH_OPENAI_APPS_CHALLENGE_TOKEN";

export function openaiAppsChallengeToken(): string | null {
    const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN?.trim();
    return token && token !== PLACEHOLDER ? token : OPENAI_APPS_CHALLENGE_TOKEN;
}
