import { DynamoStore, MemoryStore, type ActionStore } from '@complao/core';
import { createApp } from './app';
import { loadEnv } from './env';
import { httpResolver, idResolver, type NameResolver } from './names';

const env = loadEnv();

let store: ActionStore;
let names: NameResolver = env.userLookupUrl ? httpResolver(env.userLookupUrl, env.userLookupToken) : idResolver;

if (env.store === 'memory') {
  store = new MemoryStore();
} else {
  store = new DynamoStore({ tableName: env.tableName, endpoint: env.dynamoEndpoint });
}

if (env.demo) {
  const { startDemo, demoNames } = await import('./demo/demo');
  if (!env.userLookupUrl) names = demoNames;
  await startDemo(store);
}

const app = createApp(env, store, names);
app.listen(env.port, () => {
  console.log(`Complao action log API on http://localhost:${env.port}  (store: ${env.store}${env.demo ? ', demo data' : ''}${env.authDisabled ? ', AUTH DISABLED' : ''})`);
});
