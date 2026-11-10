// Turns a Google Drive error answer into a plain sentence, for the errors a first-time setup is most likely to hit.
// Returns '' for anything else, and the app then shows a general message.
export function explainDriveError(status, bodyText) {
  let reason = '';
  let message = '';
  try {
    const body = JSON.parse(bodyText)?.error ?? {};
    message = body.message ?? '';
    reason = body.errors?.[0]?.reason ?? body.details?.find(detail => detail.reason)?.reason ?? '';
  } catch {
    // Not JSON: fall back to the status alone.
  }
  const text = `${reason} ${message}`;
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used in project|API is disabled/i.test(text)) {
    return 'Google Drive isn’t turned on for your Google project yet. In Google’s console, open APIs & Services → Library, search for Google Drive API, and click Enable. Then tap the cloud to try again.';
  }
  if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(text)) {
    return 'Google didn’t give the app permission to use Drive. Disconnect, connect again, and leave the Drive permission ticked.';
  }
  if (status === 429 || /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED/i.test(text)) {
    return 'Google is asking the app to slow down. Try again in a minute.';
  }
  return '';
}
