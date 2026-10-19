import { redirectHostname } from "./redirects.js";

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export interface AuthorizePageFields {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    resource: string;
    scope: string;
    clientName: string;
    error?: string;
}

export function authorizePage(fields: AuthorizePageFields): string {
    const host = redirectHostname(fields.redirectUri) || "the requesting app";
    const error = fields.error
        ? `<p class="error" role="alert">${escapeHtml(fields.error)}</p>`
        : "";
    const hidden = (
        [
            ["response_type", "code"],
            ["client_id", fields.clientId],
            ["redirect_uri", fields.redirectUri],
            ["state", fields.state],
            ["code_challenge", fields.codeChallenge],
            ["code_challenge_method", fields.codeChallengeMethod],
            ["resource", fields.resource],
            ["scope", fields.scope],
        ] as const
    )
        .map(
            ([name, value]) =>
                `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`
        )
        .join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<meta name="robots" content="noindex">
<title>Connect Desearch</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f3efe6; color: #1c1915; font-family: Georgia, "Iowan Old Style", serif; }
  main { max-width: 28rem; margin: 10vh auto; background: #fffdf8; border: 1px solid #e3d9c6; padding: 2rem 1.75rem 1.75rem; }
  h1 { font-size: 1.7rem; font-weight: 600; margin: 0 0 0.4rem; }
  p, label { line-height: 1.45; }
  label, button, .host { font-family: ui-sans-serif, system-ui, sans-serif; }
  label { display: block; font-size: 0.85rem; margin: 1.2rem 0 0.4rem; }
  input[type="password"] { width: 100%; box-sizing: border-box; font: 0.95rem ui-monospace, SFMono-Regular, Menlo, monospace; padding: 0.65rem 0.7rem; border: 1px solid #cfc4ae; background: #fff; }
  .actions { display: flex; gap: 0.6rem; margin-top: 1.1rem; }
  button { border: 0; padding: 0.65rem 0.95rem; cursor: pointer; }
  button.primary { background: #1c1915; color: #fffdf8; }
  button.secondary { background: transparent; color: #1c1915; border: 1px solid #cfc4ae; }
  a { color: #1c1915; }
  .error { color: #8d2a2a; font-family: ui-sans-serif, system-ui, sans-serif; }
  .host { font-weight: 650; }
</style>
</head>
<body>
<main>
  <h1>Desearch</h1>
  <p>Paste a Desearch API key to connect. <a href="https://console.desearch.ai/api-keys">Create a key</a> in the Desearch console if you need one.</p>
  <p>The key is checked before this page continues. It stays on this server and is not sent to <span class="host">${escapeHtml(host)}</span>.</p>
  ${error}
  <form method="post" action="/authorize" accept-charset="UTF-8">
    ${hidden}
    <label for="api_key">Desearch API key</label>
    <input id="api_key" name="api_key" type="password" autocomplete="off" spellcheck="false" required>
    <div class="actions">
      <button class="primary" type="submit" name="decision" value="allow">Continue</button>
      <button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Cancel</button>
    </div>
  </form>
</main>
</body>
</html>`;
}

export function messagePage(title: string, message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; background: #f3efe6; color: #1c1915; font-family: Georgia, "Iowan Old Style", serif; }
  main { max-width: 28rem; margin: 10vh auto; background: #fffdf8; border: 1px solid #e3d9c6; padding: 2rem 1.75rem; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</main>
</body>
</html>`;
}
