import { runnerContext } from './context.mjs';
import { runnerErrors } from './errors.mjs';

async function execute({ request, pieceCatalog }) {
  const mode = request.mode === undefined ? 'run' : request.mode;
  if (mode === 'run') {
    const { action, auth, props } = pieceCatalog.prepare({ request });
    return action.run(runnerContext.create({ auth, props }));
  }
  if (mode !== 'options' && mode !== 'props') {
    throw runnerErrors.refusalError({ code: runnerErrors.codes.invalidMode, message: 'Mode must be run, options or props.' });
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
