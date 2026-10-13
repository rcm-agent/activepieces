FROM public.ecr.aws/lambda/nodejs:22

RUN dnf -y upgrade && dnf clean all

WORKDIR ${LAMBDA_TASK_ROOT}/runtime/piece-runner
COPY runtime/piece-runner/package.json runtime/piece-runner/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY runtime/piece-runner/*.mjs ./
COPY packages/pieces/community/slack/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/slack/package.json
COPY packages/pieces/community/discord/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/discord/package.json
COPY packages/pieces/community/google-sheets/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/google-sheets/package.json
COPY packages/pieces/community/google-calendar/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/google-calendar/package.json
COPY packages/pieces/community/google-drive/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/google-drive/package.json
COPY packages/pieces/community/microsoft-outlook/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/microsoft-outlook/package.json
COPY packages/pieces/community/microsoft-outlook-calendar/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/microsoft-outlook-calendar/package.json
COPY packages/pieces/community/microsoft-teams/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/microsoft-teams/package.json
COPY packages/pieces/community/microsoft-excel-365/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/microsoft-excel-365/package.json
COPY packages/pieces/community/microsoft-onedrive/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/microsoft-onedrive/package.json
COPY packages/pieces/community/microsoft-sharepoint/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/microsoft-sharepoint/package.json
COPY packages/pieces/community/service-now/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/service-now/package.json
COPY packages/pieces/community/docusign/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/docusign/package.json
COPY packages/pieces/community/shippo/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/shippo/package.json
COPY packages/pieces/community/quickbooks/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/quickbooks/package.json
COPY packages/pieces/community/quickbooks-sandbox/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/quickbooks-sandbox/package.json
COPY packages/pieces/community/xero/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/xero/package.json
RUN npm run check-versions \
  && rm -rf /var/lang/lib/node_modules/npm /var/lang/lib/node_modules/corepack /var/lang/bin/npm /var/lang/bin/npx /var/lang/bin/corepack /var/runtime/node_modules/@aws-sdk

CMD ["runtime/piece-runner/lambda.handler"]
