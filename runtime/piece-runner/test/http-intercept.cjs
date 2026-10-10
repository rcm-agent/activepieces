const assert = require('node:assert/strict');
const { Readable, Writable } = require('node:stream');
const http = require('node:http'), https = require('node:https'), net = require('node:net'), tls = require('node:tls');
const Module = require('node:module'), originalLoad = Module._load;
assert.deepEqual(Object.keys(process.env), []);
const fixture = JSON.parse(process.argv.at(-1));
const blocked = () => { throw new Error('Unexpected outbound network operation'); };
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = global.fetch = blocked;
Module._load = function (...args) {
  const exported = originalLoad.apply(this, args);
  if (fixture.mode === 'store' && args[0] === '@activepieces/piece-discord') exported.discord.getAction('sendMessageWithBot').run = async (context) => context.store.get('contract');
  return exported;
};
function request(input, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  const config = typeof input === 'string' || input instanceof URL ? { ...Object.fromEntries(['protocol', 'hostname', 'port', 'pathname', 'search'].map((key) => [key, new URL(input)[key]])), ...options } : input;
  const headers = Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key.toLowerCase(), value]));
  assert.deepEqual([`${config.protocol}//${config.hostname ?? config.host}${config.path ?? `${config.pathname}${config.search}`}`, config.method, headers.authorization], [fixture.url, 'POST', fixture.authorization]);
  const req = new Writable({
    write(chunk, encoding, done) { done(); },
    final(done) {
      done();
      if (fixture.mode === 'hang') { setInterval(() => {}, 1000); return; }
      const res = Readable.from([Buffer.from(JSON.stringify(fixture.body))]);
      Object.assign(res, { statusCode: fixture.status ?? 200, statusMessage: 'Contract response', headers: { 'content-type': 'application/json' }, req });
      queueMicrotask(() => req.emit('response', res));
    },
  });
  if (callback) req.once('response', callback);
  req.setTimeout = () => req; req.abort = () => req.destroy();
  req.setHeader = (name, value) => { headers[name.toLowerCase()] = value; }; req.getHeader = (name) => headers[name.toLowerCase()]; req.removeHeader = (name) => { delete headers[name.toLowerCase()]; };
  return req;
}
http.request = https.request = request;
http.get = https.get = (...args) => { const req = request(...args); req.end(); return req; };
