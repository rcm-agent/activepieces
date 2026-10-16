import { types } from 'node:util';
import { runnerErrors } from './errors.mjs';

function validate({ value }) {
  const store = value === undefined ? {} : value;
  if (!isJsonObject({ value: store })) throw invalidStoreError();
  return cloneJson({ value: store, ancestors: new Set(), maxBytes: storeLimitBytes }).value;
}

function create({ value }) {
  let store = validate({ value });
  const service = {
    async get(key) {
      validateKey({ key });
      if (!Object.hasOwn(store, key)) return null;
      return cloneJson({ value: store[key], ancestors: new Set(), maxBytes: storeLimitBytes }).value;
    },
    async put(key, value) {
      validateKey({ key });
      store = validate({ value: { ...store, [key]: value } });
      return cloneJson({ value: store[key], ancestors: new Set(), maxBytes: storeLimitBytes }).value;
    },
    async delete(key) {
      validateKey({ key });
      store = validate({ value: Object.fromEntries(Object.entries(store).filter(([entryKey]) => entryKey !== key)) });
    },
  };
  return { service, snapshot: () => validate({ value: store }) };
}

function cloneJson({ value, ancestors, maxBytes }) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    validateBytes({ bytes, maxBytes });
    return { value, bytes };
  }
  if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) throw invalidStoreError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) throw invalidStoreError();
  const nextAncestors = new Set([...ancestors, value]);
  if (Array.isArray(value)) return cloneJsonArray({ value, descriptors, keys, ancestors: nextAncestors, maxBytes });
  if (!isJsonObject({ value })) throw invalidStoreError();
  let bytes = 2;
  validateBytes({ bytes, maxBytes });
  const entries = [];
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalidStoreError();
    bytes += Buffer.byteLength(JSON.stringify(key)) + 1 + (entries.length ? 1 : 0);
    validateBytes({ bytes, maxBytes });
    const cloned = cloneJson({ value: descriptor.value, ancestors: nextAncestors, maxBytes: maxBytes - bytes });
    bytes += cloned.bytes;
    entries.push([key, cloned.value]);
  }
  return { value: Object.fromEntries(entries), bytes };
}

function cloneJsonArray({ value, descriptors, keys, ancestors, maxBytes }) {
  if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1) throw invalidStoreError();
  let bytes = 2;
  validateBytes({ bytes, maxBytes });
  const values = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalidStoreError();
    bytes += index ? 1 : 0;
    validateBytes({ bytes, maxBytes });
    const cloned = cloneJson({ value: descriptor.value, ancestors, maxBytes: maxBytes - bytes });
    bytes += cloned.bytes;
    values.push(cloned.value);
  }
  return { value: values, bytes };
}

function isJsonObject({ value }) {
  return value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateKey({ key }) {
  if (typeof key !== 'string') throw invalidStoreError();
}

function validateBytes({ bytes, maxBytes }) {
  if (bytes > maxBytes) throw runnerErrors.refusalError({ code: 'STORE_LIMIT_EXCEEDED', message: 'Store exceeds the 2048-byte limit' });
}

function invalidStoreError() {
  return runnerErrors.refusalError({ code: 'INVALID_STORE', message: 'Store must be a JSON object containing only JSON values' });
}

const storeLimitBytes = 2048;

export const runnerStore = { validate, create };
