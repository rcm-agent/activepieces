import { runnerContext } from './context.mjs';
import { runnerErrors } from './errors.mjs';
import { runnerStore } from './store.mjs';
import { runnerTriggerCatalog } from './trigger-catalog.mjs';

async function execute({ request, pieceCatalog }) {
  const mode = request.mode === undefined ? 'run' : request.mode;
  if (mode === 'run') {
    const { action, auth, props } = pieceCatalog.prepare({ request });
    return action.run(runnerContext.create({ auth, props }));
  }
  if (mode === 'trigger') {
    runnerTriggerCatalog.validateHook({ hook: request.hook });
    const store = runnerStore.create({ value: request.store });
    const { trigger, auth, props } = pieceCatalog.prepareTrigger({ request });
    const context = runnerContext.createTrigger({ auth, props, store: store.service });
    const hook = { enable: 'onEnable', poll: 'run', test: 'test' }[request.hook];
    const result = await trigger[hook](context);
    const items = request.hook === 'enable' ? [] : result;
    if (!Array.isArray(items)) {
      throw runnerErrors.refusalError({ code: 'INVALID_TRIGGER_OUTPUT', message: 'A polling trigger must return an array of items.' });
    }
    return { items, store: store.snapshot() };
  }
  if (mode !== 'options' && mode !== 'props') {
    throw runnerErrors.refusalError({ code: runnerErrors.codes.invalidMode, message: 'Mode must be run, trigger, options or props.' });
  }
  const { declaration, auth, props } = pieceCatalog.prepareLoader({ request });
  const context = runnerContext.createPropertyContext({ searchValue: request.search_value });
  if (mode === 'options') {
    const result = await declaration.options({ auth, ...props }, context);
    return {
      options: result.options.map(({ label, value }) => ({ label, value })),
      disabled: result.disabled ?? false,
      placeholder: result.placeholder ?? null,
    };
  }
  const declarations = await declaration.props({ auth, ...props }, context);
  return { props: pieceCatalog.exportProps({ declarations }) };
}

export const runnerExecution = { execute };
