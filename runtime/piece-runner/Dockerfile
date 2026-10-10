FROM public.ecr.aws/lambda/nodejs:20

WORKDIR ${LAMBDA_TASK_ROOT}/runtime/piece-runner
COPY runtime/piece-runner/package.json runtime/piece-runner/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY runtime/piece-runner/*.mjs ./
COPY packages/pieces/community/slack/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/slack/package.json
COPY packages/pieces/community/discord/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/community/discord/package.json
COPY packages/pieces/framework/package.json ${LAMBDA_TASK_ROOT}/packages/pieces/framework/package.json
RUN npm run check-versions

CMD ["runtime/piece-runner/lambda.handler"]
