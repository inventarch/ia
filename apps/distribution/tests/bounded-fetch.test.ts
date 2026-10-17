import { afterEach, expect, it, vi } from 'vitest';
import { fetchBounded } from '../src/bounded-fetch.js';
import { parseRegistryBase } from '../src/registry-source.js';

afterEach(() => {
  vi.unstubAllGlobals();
});
const digest = 'a'.repeat(64);
/** A fetch stub that records each requested URL and answers `ok`; every request must refuse redirects. */
function recording(): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe('error');
    requested.push(String(input));
    return new Response('ok');
  });
  return requested;
}
const get = (url: string) =>
  fetchBounded({ url, limit: 16, label: 'Test request', oversize: () => 'Test response exceeds 16 bytes' });
/**
 * The callers' own URL test, without the archive's digest suffix: the archive check (`readArtifactBytes`,
 * apps/distribution/src/acquire.ts:19-29) and the lock decoder's `url`
 * (packages/db/src/distribution/contracts.ts:124-135) both require HTTPS in the form `new URL` writes, with no
 * userinfo and no query or fragment as `URL` reads them. Every registry document URL passes it too: a base the
 * registry parser serialized, with no `?` or `#` at all, followed by a `portable` lowercase document path.
 */
function produced(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.href === url
    );
  } catch {
    return false;
  }
}

it('fetches every URL form registry documents and remote archives produce, as written', async () => {
  const forms = [
    'https://registry.test/base/ia-registry.json',
    'https://registry.test:8443/base/packages/acme/tools.json',
    'https://registry.test:65535/kits/acme/kit/index.json',
    'https://registry.test:0/workspaces/acme/space/index.json',
    'https://127.0.0.1:8443/ia-registry.json',
    `https://[::1]:8443/base/artifacts/${digest}.ia.tgz`,
    `https://[::ffff:7f00:1]/${digest}.ia.tgz`,
    'https://[2001:db8::1]/ia-registry.json',
    'https://xn--bcher-kva.test/base/ia-registry.json',
    'https://re_g!"$&\'()*+,;=`{}~istry.test/ia-registry.json',
    'https://registry.test/a%20b/%C3%A9/%22%3C%3E%60%7B%7D/%7e%zz%/ia-registry.json',
    "https://registry.test/!$&'()*+,;=:@[]^_|~-./ia-registry.json",
    `https://example.invalid/Mixed/CASE//${digest}.ia.tgz`,
    // `URL.search` and `URL.hash` read an empty query or fragment as none, so the archive check admits a bare `?` or `#`.
    `https://example.invalid/${digest}.ia.tgz?`,
    `https://example.invalid/${digest}.ia.tgz#`,
    `https://example.invalid/${digest}.ia.tgz?#`,
  ];
  for (const url of forms) expect(produced(url), url).toBe(true);
  const requested = recording();
  for (const url of forms) expect((await get(url))?.toString(), url).toBe('ok');
  expect(requested).toEqual(forms);
});

it('fetches every canonical spelling of a host or path character that a caller can produce', async () => {
  // Each printable ASCII character in a host and in a path, raw and as `new URL` rewrites it (the registry parser keeps
  // the rewrite, the archive check admits only an exact spelling), then non-ASCII, uppercase and long-form input.
  const raw: string[] = [];
  for (let code = 0x20; code < 0x7f; code += 1) {
    const c = String.fromCharCode(code);
    raw.push(
      `https://a${c}b.test/`,
      `https://registry.test/x${c}y/ia-registry.json`,
      `https://registry.test:8443/${c}/${digest}.ia.tgz`,
    );
  }
  raw.push(
    'https://BÜCHER.test/É/ia-registry.json',
    'https://registry.test/日本/ia-registry.json',
    'HTTPS://[0:0:0:0:0:0:0:1]:08443/ia-registry.json',
    'https://127.1/ia-registry.json',
  );
  const forms = [
    ...new Set(
      raw.flatMap((value) => {
        try {
          return [value, new URL(value).href];
        } catch {
          return [];
        }
      }),
    ),
  ].filter(produced);
  for (const form of [
    'https://a_b.test/',
    'https://a~b.test/',
    'https://registry.test/x%y/ia-registry.json',
    'https://registry.test/x%20y/ia-registry.json',
    'https://registry.test/x|y/ia-registry.json',
    `https://registry.test:8443/^/${digest}.ia.tgz`,
    'https://xn--bcher-kva.test/%C3%89/ia-registry.json',
    'https://registry.test/%E6%97%A5%E6%9C%AC/ia-registry.json',
    'https://[::1]:8443/ia-registry.json',
    'https://127.0.0.1/ia-registry.json',
  ])
    expect(forms, form).toContain(form);
  const requested = recording();
  for (const url of forms) expect((await get(url))?.toString(), url).toBe('ok');
  expect(requested).toEqual(forms);
});

it('refuses, before any request, a URL that is malformed, not HTTPS or carries credentials', async () => {
  const refused = [
    // Another scheme, in any case.
    'http://registry.test/ia-registry.json',
    'HTTP://registry.test/ia-registry.json',
    'file:///registry/ia-registry.json',
    'data:text/plain,ia',
    'ftp://registry.test/ia-registry.json',
    'wss://registry.test/ia-registry.json',
    // A username, a password or both.
    'https://user:secret@registry.test/ia-registry.json',
    'https://user@registry.test/ia-registry.json',
    'https://:secret@registry.test/ia-registry.json',
    // Text `new URL` cannot parse: empty or blank, no scheme, or a host, IPv6 literal or port it rejects.
    '',
    ' ',
    'registry.test/ia-registry.json',
    '//registry.test/ia-registry.json',
    'https://',
    'https://regi stry.test/ia-registry.json',
    'https://regi^stry.test/ia-registry.json',
    'https://regi|stry.test/ia-registry.json',
    'https://regi%stry.test/ia-registry.json',
    'https://xn--/ia-registry.json',
    'https://xn--a/ia-registry.json',
    'https://1.2.3.4.5/ia-registry.json',
    'https://[::1/ia-registry.json',
    'https://[::G]/ia-registry.json',
    'https://[::1]x/ia-registry.json',
    'https://[:::]/ia-registry.json',
    'https://registry.test:99999/ia-registry.json',
    'https://registry.test:84a3/ia-registry.json',
  ];
  const requested = recording();
  for (const url of refused)
    await expect(get(url), JSON.stringify(url)).rejects.toMatchObject({
      code: 'IA-DIST-INPUT-INVALID',
      message: `Test request ${url} is not a credential-free HTTPS URL`,
    });
  expect(requested).toEqual([]);
});

it('made no request for a credentialed or malformed URL before this check either: fetch rejects one itself', async () => {
  // The real fetch, before any stub: it builds no request for a URL with credentials or one it cannot parse, and
  // rejects with a TypeError, which the transport reported as IA-DIST-ARTIFACT-UNAVAILABLE before this check.
  for (const url of [
    'https://user:secret@registry.test/ia-registry.json',
    'https://:secret@registry.test/ia-registry.json',
    'https://registry.test:99999/ia-registry.json',
    'https://[::1/ia-registry.json',
    '',
  ])
    await expect(fetch(url), JSON.stringify(url)).rejects.toThrow(TypeError);
});

it('requests a non-canonical HTTPS spelling as new URL writes it, the request fetch built from that spelling', async () => {
  const spellings: readonly (readonly [string, string])[] = [
    // The host or scheme in another case, an explicit or empty default port, a percent-encoded host character, raw
    // path characters that `new URL` percent-encodes, an IDN, and IPv6 and IPv4 long forms.
    ['https://Registry.test/ia-registry.json', 'https://registry.test/ia-registry.json'],
    ['https://REGISTRY.TEST/Base/ia-registry.json', 'https://registry.test/Base/ia-registry.json'],
    ['HTTPS://registry.test/ia-registry.json', 'https://registry.test/ia-registry.json'],
    ['https://registry.test:443/ia-registry.json', 'https://registry.test/ia-registry.json'],
    ['https://registry.test:/ia-registry.json', 'https://registry.test/ia-registry.json'],
    ['https://regi%73try.test/ia-registry.json', 'https://registry.test/ia-registry.json'],
    [
      'https://registry.test/a b/é/"<>`{}/ia-registry.json',
      'https://registry.test/a%20b/%C3%A9/%22%3C%3E%60%7B%7D/ia-registry.json',
    ],
    ['https://bücher.test/ia-registry.json', 'https://xn--bcher-kva.test/ia-registry.json'],
    ['https://[::A]/ia-registry.json', 'https://[::a]/ia-registry.json'],
    ['https://[0:0:0:0:0:ffff:127.0.0.1]:08443/ia-registry.json', 'https://[::ffff:7f00:1]:8443/ia-registry.json'],
    ['https://127.1/ia-registry.json', 'https://127.0.0.1/ia-registry.json'],
    ['https://2130706433/ia-registry.json', 'https://127.0.0.1/ia-registry.json'],
    ['https://0x7f.1/ia-registry.json', 'https://127.0.0.1/ia-registry.json'],
    ['https://0/ia-registry.json', 'https://0.0.0.0/ia-registry.json'],
    // Dot segments, backslashes, a missing path and missing or extra slashes after the scheme.
    ['https://registry.test/a/../ia-registry.json', 'https://registry.test/ia-registry.json'],
    ['https://registry.test/%2e/ia-registry.json', 'https://registry.test/ia-registry.json'],
    ['https://registry.test\\base\\ia-registry.json', 'https://registry.test/base/ia-registry.json'],
    ['https://registry.test', 'https://registry.test/'],
    ['https:registry.test/ia-registry.json', 'https://registry.test/ia-registry.json'],
    ['https:///registry.test/ia-registry.json', 'https://registry.test/ia-registry.json'],
    // An empty userinfo, which holds no credentials and which `new URL` drops.
    ['https://@registry.test/ia-registry.json', 'https://registry.test/ia-registry.json'],
    ['https://:@registry.test/ia-registry.json', 'https://registry.test/ia-registry.json'],
    // Surrounding whitespace, and a tab or newline inside, which URL parsing strips.
    [' https://registry.test/ia-registry.json\n', 'https://registry.test/ia-registry.json'],
    ['https://regi\tstry.test/ia-\nregistry.json', 'https://registry.test/ia-registry.json'],
    // A query or a fragment as `new URL` writes them, where the host ends too, and a trailing slash, kept as it is.
    ['https://registry.test/ia-registry.json?token=a b', 'https://registry.test/ia-registry.json?token=a%20b'],
    ['https://registry.test/ia-registry.json#part', 'https://registry.test/ia-registry.json#part'],
    ['https://evil.test#.registry.test/ia-registry.json', 'https://evil.test/#.registry.test/ia-registry.json'],
    ['https://registry.test/base/', 'https://registry.test/base/'],
  ];
  const requested = recording();
  for (const [url, canonical] of spellings) {
    expect(new URL(url).href, JSON.stringify(url)).toBe(canonical);
    // Handed the spelling itself, as it was before this check, fetch built this same request.
    expect(new Request(url).url, JSON.stringify(url)).toBe(new Request(canonical).url);
    expect((await get(url))?.toString(), JSON.stringify(url)).toBe('ok');
    expect(requested.pop(), JSON.stringify(url)).toBe(canonical);
  }
  expect(requested).toEqual([]);
});

it('refuses an ASCII character in a host, path, query or fragment exactly where new URL does, else requests its href', async () => {
  const requested = recording();
  let admitted = '';
  // Every ASCII character, controls included: URL parsing strips a tab or newline, ends the host at `/`, `\`, `?` or
  // `#`, reads `@` as userinfo and lowercases letters, and the request is then for the host `new URL` reads.
  for (let code = 0; code < 0x80; code += 1) {
    const c = String.fromCharCode(code);
    for (const url of [
      `https://a${c}b.test/ia-registry.json`,
      `https://registry.test/a${c}b/ia-registry.json`,
      `https://registry.test/ia-registry.json?a${c}b`,
      `https://registry.test/ia-registry.json#a${c}b`,
    ]) {
      let href: string | undefined;
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) href = parsed.href;
      } catch {
        href = undefined;
      }
      const outcome = await get(url).then(
        () => requested.pop(),
        (error: unknown) => error,
      );
      if (href === undefined) expect(outcome, JSON.stringify(url)).toMatchObject({ code: 'IA-DIST-INPUT-INVALID' });
      else {
        expect(outcome, JSON.stringify(url)).toBe(href);
        if (url.startsWith('https://a')) admitted += c;
      }
    }
  }
  // The characters a host admits: those `new URL` keeps or lowercases there, the tab, newline and carriage return it
  // strips, and `#`, `/`, `?` and `\`, which end the host.
  expect(admitted).toBe(
    '\t\n\r!"#$&\'()*+,-./0123456789;=?ABCDEFGHIJKLMNOPQRSTUVWXYZ\\_`abcdefghijklmnopqrstuvwxyz{}~',
  );
  expect(requested).toEqual([]);
});

it('requests a URL that parseRegistryBase produced exactly as it produced it', async () => {
  const requested = recording();
  for (const value of [
    'HTTPS://Registry.TEST:443/Base',
    'https://registry.test:8443/a b/é/',
    'https://bücher.test',
    'https://[0:0::1]/base/',
    'https://127.1',
  ]) {
    const base = parseRegistryBase(value, '/');
    if (base.kind !== 'https') throw new Error(`${value} is not an HTTPS base`);
    const url = `${base.url}ia-registry.json`;
    expect((await get(url))?.toString(), value).toBe('ok');
    expect(requested.pop(), value).toBe(url);
  }
  expect(requested).toEqual([]);
});
