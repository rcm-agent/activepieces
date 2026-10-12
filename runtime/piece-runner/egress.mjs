import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import { runnerErrors } from './errors.mjs';

function validate({ request }) {
  if (!['API_KEY', 'BASIC', 'CUSTOM_AUTH'].includes(request.auth_type)) return undefined;
  const hosts = request.allowed_hosts;
  if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > 10 || ![...hosts].every(validHost)) {
    throw runnerErrors.refusalError({ code: runnerErrors.codes.allowedHostsRequired });
  }
  return [...hosts];
}

function install({ request }) {
  const hosts = validate({ request });
  if (hosts === undefined) return { refusal: () => undefined };
  const allowed = new Set(hosts);
  const originalLookup = dns.lookup;
  const originalPromiseLookup = dns.promises.lookup;
  const originalSocketConnect = net.Socket.prototype.connect;
  const originalTlsConnect = tls.connect;
  let refused = false;
  const deny = () => {
    refused = true;
    return runnerErrors.refusalError({ code: runnerErrors.codes.egressHostRefused });
  };
  const checkHost = (hostname) => {
    if (typeof hostname !== 'string' || !allowed.has(hostname.toLowerCase())) throw deny();
  };
  const checkAddresses = (addresses) => {
    const values = Array.isArray(addresses) ? [...addresses].map((value) => value?.address)
      : [typeof addresses === 'string' ? addresses : addresses?.address];
    if (values.length === 0 || !values.every(publicAddress)) throw deny();
  };

  const guardedLookup = function (...args) {
    const callback = args.at(-1);
    try {
      checkHost(args[0]);
    } catch (error) {
      if (typeof callback !== 'function') throw error;
      queueMicrotask(() => callback(error));
      return;
    }
    if (typeof callback !== 'function') return Reflect.apply(originalLookup, dns, args);
    return Reflect.apply(originalLookup, dns, [...args.slice(0, -1), (...result) => {
      if (result[0]) return callback(...result);
      try {
        checkAddresses(result[1]);
      } catch (error) {
        return callback(error);
      }
      return callback(...result);
    }]);
  };
  for (const symbol of Object.getOwnPropertySymbols(originalLookup)) {
    if (Array.isArray(originalLookup[symbol])) Object.defineProperty(guardedLookup, symbol, Object.getOwnPropertyDescriptor(originalLookup, symbol));
  }
  dns.lookup = guardedLookup;
  dns.promises.lookup = async function (...args) {
    checkHost(args[0]);
    const result = await Reflect.apply(originalPromiseLookup, dns.promises, args);
    checkAddresses(result);
    return result;
  };
  net.Socket.prototype.connect = function (...args) {
    const { options, callback } = connectionArguments({ args });
    if (options.path) throw deny();
    checkHost(options.host ?? options.hostname ?? 'localhost');
    options.lookup = guardedLookup;
    return Reflect.apply(originalSocketConnect, this, callback ? [options, callback] : [options]);
  };
  tls.connect = function (...args) {
    const { options, callback } = connectionArguments({ args, tlsOptions: true });
    if (options.path) throw deny();
    checkHost(options.host ?? options.hostname ?? 'localhost');
    options.lookup = guardedLookup;
    return Reflect.apply(originalTlsConnect, this, callback ? [options, callback] : [options]);
  };
  syncBuiltinESMExports();
  return { refusal: () => refused ? runnerErrors.refusalError({ code: runnerErrors.codes.egressHostRefused }) : undefined };
}

function validHost(hostname) {
  if (typeof hostname !== 'string' || hostname.length > 253 || net.isIP(hostname)) return false;
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  if (!new RegExp(`^(?:${label}\\.)*${label}$`).test(hostname)) return false;
  try {
    return new URL(`http://${hostname}`).hostname === hostname;
  } catch {
    return false;
  }
}

function publicAddress(address) {
  const family = typeof address === 'string' ? net.isIP(address) : 0;
  if (family === 4) return publicIpv4(address);
  if (family !== 6 || address.includes('%')) return false;
  const words = ipv6Words(address);
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return publicIpv4(ipv4FromWords({ words }));
  }
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)) {
    return publicIpv4(ipv4FromWords({ words }));
  }
  if ((words[0] & 0xe000) !== 0x2000 || words[0] === 0x2002) return false;
  if (words[0] === 0x2001 && words[1] < 0x200) return publicProtocolAssignment({ words });
  if (words[0] === 0x2001 && words[1] === 0xdb8) return false;
  return !(words[0] === 0x3fff && (words[1] & 0xf000) === 0);
}

function publicProtocolAssignment({ words }) {
  if (words[1] === 1 && words.slice(2, 7).every((word) => word === 0) && [1, 2, 3].includes(words[7])) return true;
  return words[1] === 3 || (words[1] === 4 && words[2] === 0x112) || [0x20, 0x30].includes(words[1] & 0xfff0);
}

function publicIpv4(address) {
  const [first, second, third, fourth] = address.split('.').map(Number);
  if ([0, 10, 127].includes(first) || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && (second === 168 || (second === 0 && third === 2)
    || (second === 0 && third === 0 && ![9, 10].includes(fourth)) || (second === 88 && third === 99))) return false;
  if (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) return false;
  return !(first === 203 && second === 0 && third === 113);
}

function ipv6Words(address) {
  let text = address;
  const tail = text.split(':').at(-1);
  if (tail.includes('.')) {
    const bytes = tail.split('.').map(Number);
    text = `${text.slice(0, -tail.length)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const [left, right] = text.split('::');
  const first = left.split(':').filter(Boolean).map((word) => Number.parseInt(word, 16));
  const last = (right ?? '').split(':').filter(Boolean).map((word) => Number.parseInt(word, 16));
  return [...first, ...Array(8 - first.length - last.length).fill(0), ...last];
}

function ipv4FromWords({ words }) {
  return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join('.');
}

function connectionArguments({ args, tlsOptions = false }) {
  const list = Array.isArray(args[0]) ? args[0] : args;
  const first = list[0];
  const options = first !== null && typeof first === 'object' ? { ...first }
    : typeof first === 'string' && !/^\d+$/.test(first) ? { path: first }
      : { port: first, ...(typeof list[1] === 'string' ? { host: list[1] } : {}) };
  const extra = tlsOptions ? (list[1] !== null && typeof list[1] === 'object' ? list[1] : list[2]) : undefined;
  return { options: { ...options, ...extra }, callback: typeof list.at(-1) === 'function' ? list.at(-1) : undefined };
}

export const runnerEgress = { validate, install };
