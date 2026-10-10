function create({ auth, props }) {
  const context = { auth, propsValue: props, executionType: 'BEGIN' };
  for (const service of ['store', 'files', 'server', 'pause', 'connections', 'agent', 'flows', 'project', 'step', 'run', 'tags', 'output', 'generateResumeUrl', 'createWaitpoint', 'waitForWaitpoint']) {
    Object.defineProperty(context, service, {
      get() {
        const error = new Error(`Context service ${service} is unavailable`);
        error.name = 'RunnerRefusal';
        error.code = 'CONTEXT_SERVICE_UNAVAILABLE';
        throw error;
      },
    });
  }
  return context;
}

export const runnerContext = { create };
