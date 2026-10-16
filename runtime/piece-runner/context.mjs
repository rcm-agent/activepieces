import { runnerErrors } from './errors.mjs';

function create({ auth, props }) {
  return createServiceContext({
    values: { auth, propsValue: props, executionType: 'BEGIN' },
    services: ['store', 'files', 'server', 'pause', 'connections', 'agent', 'flows', 'project', 'step', 'run', 'tags', 'output', 'generateResumeUrl', 'createWaitpoint', 'waitForWaitpoint'],
  });
}

function createPropertyContext({ searchValue }) {
  return createServiceContext({ values: { searchValue }, services: ['server', 'project', 'flows', 'connections'] });
}

function createTrigger({ auth, props, store }) {
  // pollingHelper hands the whole context on, reading files, server and maxItemsToPoll; using a service refuses.
  const context = createServiceContext({
    values: { auth, propsValue: props, store, files: createFilesService(), server: createUnreadableService('server'), isRepublish: false, maxItemsToPoll: undefined },
    services: ['pause', 'connections', 'agent', 'flows', 'project', 'step', 'run', 'tags', 'output', 'generateResumeUrl', 'createWaitpoint', 'waitForWaitpoint', 'setSchedule', 'webhookUrl', 'payload', 'app'],
  });
  return new Proxy(context, {
    get(target, service) {
      if (Reflect.has(target, service) || typeof service === 'symbol') return Reflect.get(target, service);
      throw unavailableServiceError({ service });
    },
  });
}

function createServiceContext({ values, services }) {
  const context = { ...values };
  for (const service of services) {
    Object.defineProperty(context, service, {
      get() {
        throw unavailableServiceError({ service });
      },
    });
  }
  return context;
}

function createFilesService() {
  const unavailable = async () => {
    throw unavailableServiceError({ service: 'files' });
  };
  return new Proxy(Object.create(null), { get: () => unavailable });
}

function createUnreadableService(service) {
  return new Proxy(Object.create(null), {
    get(target, key) {
      if (key === 'then' || typeof key === 'symbol') return undefined;
      throw unavailableServiceError({ service });
    },
  });
}

function unavailableServiceError({ service }) {
  return runnerErrors.refusalError({ code: 'CONTEXT_SERVICE_UNAVAILABLE', message: `Context service ${service} is unavailable` });
}

export const runnerContext = { create, createPropertyContext, createTrigger };
