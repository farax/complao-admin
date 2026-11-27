import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { cached, type NameResolver } from './names';

/**
 * R15 with names in RDS: the portal invokes a small lookup Lambda that runs inside the
 * database's VPC (`complao-user-names`). The portal itself never connects to RDS.
 * Request `{"ids": [...]}`, response `{"<id>": "<name>"}`. Kept apart from names.ts so the
 * browser preview build doesn't pull in the Lambda SDK.
 */
export function lambdaResolver(functionName: string, client: Pick<LambdaClient, 'send'> = new LambdaClient({})): NameResolver {
  return cached(async (ids) => {
    const res = await client.send(
      new InvokeCommand({ FunctionName: functionName, Payload: new TextEncoder().encode(JSON.stringify({ ids })) }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
    if (res.FunctionError) throw new Error(`user lookup failed: ${res.FunctionError}`);
    const body = JSON.parse(new TextDecoder().decode(res.Payload ?? new Uint8Array())) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('user lookup returned an unexpected shape');
    return body as Record<string, string>;
  });
}
