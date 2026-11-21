import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordingFetch, redactCredentialFields, redactCredentialForm } from '../src/providers/http-record.js';
import { tempDir } from './tmp.js';

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJmYWtlIn0.fake-signature';
const TOKEN = 'ya29.fake-access-token-0123456789abcdef';

async function record(init: RequestInit, response: Response) {
  const dir = await tempDir('overtone-rec-cred-');
  const f = recordingFetch(dir, 'google-chirp-language', [], (async () => response) as unknown as typeof fetch);
  const res = await f('https://oauth2.googleapis.com/token', init);
  const [file] = await readdir(dir);
  const text = await readFile(join(dir, file!), 'utf8');
  return { res, text, ex: JSON.parse(text) as { request: { body: unknown }; response: { body: unknown } } };
}

describe('OVERTONE_RECORD_HTTP: credential fields of token exchanges', () => {
  it('redacts the JWT assertion of a form request and the access_token of a JSON answer, and passes the answer on unchanged', async () => {
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: JWT }).toString();
    const answer = JSON.stringify({ access_token: TOKEN, expires_in: 3599, token_type: 'Bearer' });
    const { res, text, ex } = await record(
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      new Response(answer, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }),
    );
    expect(text).not.toContain(JWT);
    expect(text).not.toContain(TOKEN);
    expect(new URLSearchParams(ex.request.body as string).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(new URLSearchParams(ex.request.body as string).get('assertion')).toBe('REDACTED');
    expect(ex.response.body).toEqual({ access_token: 'REDACTED', expires_in: 3599, token_type: 'Bearer' });
    expect(await res.json()).toEqual({ access_token: TOKEN, expires_in: 3599, token_type: 'Bearer' });
  });

  it('redacts a URLSearchParams request body, a JSON request body and a form answer', async () => {
    const form = await record(
      { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'fake-refresh-0123456789', client_secret: 'fake-client-secret-0123' }) },
      new Response(`access_token=${TOKEN}&id_token=fake-id-token-0123456789&scope=x`, { status: 200, headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    );
    expect(form.text).not.toMatch(/fake-refresh|fake-client-secret|fake-id-token|ya29/);
    expect(form.ex.response.body).toBe('access_token=REDACTED&id_token=REDACTED&scope=x');
    const json = await record(
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: 'c', client_secret: 'fake-client-secret-0123' }) },
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(json.ex.request.body).toEqual({ client_id: 'c', client_secret: 'REDACTED' });
  });

  it('leaves bodies without credential fields as they are', () => {
    expect(redactCredentialFields({ results: [{ alternatives: [{ transcript: 'hallo' }] }], token_type: 'Bearer' })).toEqual({ results: [{ alternatives: [{ transcript: 'hallo' }] }], token_type: 'Bearer' });
    expect(redactCredentialFields({ data: [{ nested: { access_token: 'x' } }] })).toEqual({ data: [{ nested: { access_token: 'REDACTED' } }] });
    expect(redactCredentialForm('a=1&b=%20two')).toBe('a=1&b=%20two');
  });
});
