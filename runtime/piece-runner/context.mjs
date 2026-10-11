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

function createServiceContext({ values, services }) {
  const context = { ...values };
  for (const service of services) {
    Object.defineProperty(context, service, {
      get() {
        throw runnerErrors.refusalError({ code: 'CONTEXT_SERVICE_UNAVAILABLE', message: `Context service ${service} is unavailable` });
      },
    });
  }
  return context;
}

export const runnerContext = { create, createPropertyContext };
