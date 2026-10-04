/* Explicit synthetic provider smoke check. Never reads application/user data. */
import { readFile } from 'node:fs/promises';
import './contract.js';
import './feature.js';
const C = globalThis.JevContract,
  F = globalThis.JevFeature;
if (!process.env.TYPESAFE_API_KEY) {
  console.log('NOT RUN: TYPESAFE_API_KEY is not configured.');
  process.exitCode = 2;
} else {
  const input = JSON.parse(await readFile(new URL('./fixture.json', import.meta.url), 'utf8')),
    spec = F.build(input);
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.TYPESAFE_API_KEY,
    },
    body: JSON.stringify({
      model: process.env.JEV_MODEL || 'jev-latest',
      state: spec.state,
      questions: spec.questions,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('Provider returned HTTP ' + response.status);
  const checked = C.validate(spec.questions, await response.json());
  console.log(
    JSON.stringify({ model: checked.model, results: F.present(input, checked.answers) }, null, 2),
  );
}
