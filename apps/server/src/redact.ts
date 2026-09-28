import type { FastifyRequest } from 'fastify';

// ak/sk/sn are Baidu's credential parameters (§10.4: never log them); the rest are generic secret names.
const SECRET_ASSIGNMENT = /(?<=^|[^a-z0-9])(ak|sk|sn|key|token|secret|password|signature)=[^&#\s"']*/gi;

/** Masks secret-looking `name=value` pairs in URLs, messages and stacks. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_ASSIGNMENT, '$1=***');
}

/** Upstream (Baidu) text may quote request URLs: clients get neither URLs nor credential parameters. */
export function forClient(text: string): string {
  return redactSecrets(text).replace(/https?:\/\/\S+/g, '[链接已省略]');
}

/** Pino serializers: request lines without query secrets, errors without leaked credentials. */
export const logSerializers = {
  req(req: FastifyRequest) {
    return { method: req.method, url: redactSecrets(req.url), remoteAddress: req.ip };
  },
  err(err: Error) {
    if (!(err instanceof Error)) return { type: typeof err, message: redactSecrets(String(err)), stack: '' };
    const { code, statusCode } = err as Error & { code?: unknown; statusCode?: unknown };
    return {
      type: err.name,
      message: redactSecrets(err.message),
      stack: redactSecrets(err.stack ?? ''),
      code,
      statusCode,
    };
  },
};
