function refusal({ code, message = code }) {
  return { status: 'refused', refusal: { code, message } };
}

function refusalError({ code, message = code }) {
  const error = new Error(message);
  error.name = 'RunnerRefusal';
  error.code = code;
  return error;
}

function failure({ error, auth }) {
  const scrub = redactor({ auth });
  if (error?.name === 'RunnerRefusal') {
    return refusal({ code: scrub(error.code), message: scrub(error.message) });
  }
  const status = error?.status ?? error?.response?.status;
  return {
    status: 'failed',
    error: {
      class: scrub(error?.constructor?.name ?? 'Error'),
      http_status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      message: scrub(typeof error?.message === 'string' ? error.message : 'Action failed'),
    },
  };
}

function redactor({ auth }) {
  const strings = new Set();
  collectStrings({ value: auth, strings });
  if (typeof auth?.username === 'string' && typeof auth?.password === 'string') {
    strings.add(Buffer.from(`${auth.username}:${auth.password}`).toString('base64'));
  }
  for (const value of [...strings]) {
    strings.add(JSON.stringify(value).slice(1, -1));
    try {
      strings.add(encodeURIComponent(value));
    } catch {
      // JSON credentials may contain unpaired surrogates that URI encoding rejects.
    }
  }
  const secrets = [...strings].filter(Boolean).sort((left, right) => right.length - left.length);
  const marker = secrets.some((secret) => '[REDACTED]'.includes(secret)) ? '' : '[REDACTED]';
  return (value) => {
    let message = typeof value === 'string' ? value : 'Error';
    do {
      for (const secret of secrets) message = message.split(secret).join(marker);
    } while (secrets.some((secret) => message.includes(secret)));
    return message.slice(0, 4096);
  };
}

function collectStrings({ value, strings }) {
  const pending = [value];
  const visited = new Set();
  while (pending.length) {
    const child = pending.pop();
    if (typeof child === 'string') strings.add(child);
    if (!child || typeof child !== 'object' || visited.has(child)) continue;
    visited.add(child);
    for (const nested of Object.values(child)) pending.push(nested);
  }
}

const codes = Object.freeze({
  invalidMode: 'INVALID_MODE',
  propertyNotLoadable: 'PROPERTY_NOT_LOADABLE',
  invalidSearchValue: 'INVALID_SEARCH_VALUE',
});

export const runnerErrors = { refusal, refusalError, failure, redactor, codes };
