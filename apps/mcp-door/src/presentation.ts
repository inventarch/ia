import type { DoorResponse, Packet } from '@ia/runtime';

/** Explicit transport projection: never changes admission, selection or the delivered obligations. */
export function compactContext(response: DoorResponse): DoorResponse {
  if (!response.ok) return response;
  const packet = response.result as Packet;
  const { omitted, included, limits, ...rest } = packet;
  const counts: Record<string, number> = {};
  for (const omission of omitted) counts[omission.reason] = (counts[omission.reason] ?? 0) + 1;
  const result = {
    ...rest,
    format: 'compact',
    included: included.map(({ band: _band, score: _score, why: _why, ...entry }) => entry),
    omissions: {
      total: omitted.length,
      byReason: counts,
      unresolved: omitted.filter((entry) => entry.reason === 'unresolved'),
      details: 'Request format=full for individual budget and disqualification evidence.',
    },
    limits: { ...limits, envelopeBytes: 0 },
  };
  result.limits.envelopeBytes = Buffer.byteLength(
    JSON.stringify({
      ...result,
      included: result.included.map((entry) => ({
        ...entry,
        text: '',
        ...(entry.purpose === undefined ? {} : { purpose: '' }),
      })),
    }),
    'utf8',
  );
  return { ok: true, result };
}
