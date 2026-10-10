import { pieceRunner } from './index.mjs';

export async function handler(event) {
  return pieceRunner.invoke(event);
}
