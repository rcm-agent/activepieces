import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runnerExecution } from '../execution.mjs';

test('loader callbacks receive resolved inputs and property context without executing actions', async () => {
  const auth = { type: 'OAUTH2', access_token: 'loader-token', data: {} };
  const props = { sheetId: 'worksheet', headerRow: 1 };
  const declarations = { column: { type: 'SHORT_TEXT', required: true, description: 'Column' } };
  const metadata = { column: { type: 'SHORT_TEXT', required: true, description: 'Column' } };
  for (const mode of ['options', 'props']) {
    const request = { mode, property: 'column', auth: { access_token: auth.access_token }, props: { sheetId: props.sheetId }, search_value: mode === 'options' ? 'filter' : undefined };
    const callback = async (...args) => {
      const [values, context] = args;
      assert.deepEqual(values, { auth, ...props });
      assert.equal(context.searchValue, request.search_value);
      for (const service of ['server', 'project', 'flows', 'connections']) assert.throws(() => context[service], { code: 'CONTEXT_SERVICE_UNAVAILABLE' });
      return mode === 'options' ? { options: [{ label: 'First', value: 0, icon: 'ignored', description: 'ignored' }], extra: 'ignored' } : declarations;
    };
    const pieceCatalog = {
      prepare: () => assert.fail('Loader modes must not prepare actions'),
      prepareLoader: ({ request: received }) => {
        assert.equal(received, request);
        return { auth, props, action: { run: () => assert.fail('Loader modes must not run actions') }, declaration: { [mode]: callback } };
      },
      exportProps: ({ declarations: received }) => { assert.equal(received, declarations); return metadata; },
    };
    const expected = mode === 'options' ? { options: [{ label: 'First', value: 0 }], disabled: false, placeholder: null } : { props: metadata };
    assert.deepEqual(await runnerExecution.execute({ request, pieceCatalog }), expected);
  }
});

test('unknown modes fail before preparing or running actions', async () => {
  const pieceCatalog = { prepare: () => assert.fail('Unknown modes must not prepare actions'), prepareLoader: () => assert.fail('Unknown modes must not load properties') };
  await assert.rejects(runnerExecution.execute({ request: { mode: 'unknown' }, pieceCatalog }), { name: 'RunnerRefusal', code: 'INVALID_MODE' });
});
