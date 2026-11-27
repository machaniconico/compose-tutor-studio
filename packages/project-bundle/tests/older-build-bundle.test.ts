// P20 regression: a .ctsbundle exported by an older build (origin/main, schema v10) must import.
//
// fixtures/main-v10-two-assets.ctsbundle was written by origin/main's encodePortableProjectBundle.
// Its Project JSON is canonical for schema v10; decoding migrates it to v12 (swing 0, choke off).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePortableProjectBundle, encodePortableProjectBundle, PortableProjectBundleError } from '../src';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'main-v10-two-assets.ctsbundle');

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parts(bundle: Uint8Array) {
  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  const manifestLength = view.getUint32(12, true);
  const projectLength = view.getUint32(16, true);
  const manifestEnd = 32 + manifestLength;
  return {
    header: bundle.slice(0, 32),
    manifest: JSON.parse(new TextDecoder().decode(bundle.subarray(32, manifestEnd))) as {
      project: { byteLength: number; checksumSha256: string };
    },
    projectText: new TextDecoder().decode(bundle.subarray(manifestEnd, manifestEnd + projectLength)),
    payloads: bundle.slice(manifestEnd + projectLength),
  };
}

/** Re-assemble a bundle around replacement project text, with consistent lengths and checksum. */
async function withProjectText(bundle: Uint8Array, projectText: string): Promise<Uint8Array> {
  const { header, manifest, payloads } = parts(bundle);
  const projectBytes = new TextEncoder().encode(projectText);
  manifest.project = { byteLength: projectBytes.byteLength, checksumSha256: await sha256(projectBytes) };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const out = new Uint8Array(32 + manifestBytes.byteLength + projectBytes.byteLength + payloads.byteLength);
  out.set(header, 0);
  out.set(manifestBytes, 32);
  out.set(projectBytes, 32 + manifestBytes.byteLength);
  out.set(payloads, 32 + manifestBytes.byteLength + projectBytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(12, manifestBytes.byteLength, true);
  view.setUint32(16, projectBytes.byteLength, true);
  view.setUint32(24, out.byteLength, true);
  return out;
}

describe('portable bundle from an older build', () => {
  it('decode_mainV10Bundle_migratesToV11WithLegacyGroove', async () => {
    const bundle = new Uint8Array(readFileSync(FIXTURE));
    expect(JSON.parse(parts(bundle).projectText).schemaVersion).toBe(10);

    const decoded = await decodePortableProjectBundle(bundle);
    expect(decoded.project.schemaVersion).toBe(12);
    expect(decoded.project.swing).toBe(0);
    expect(decoded.project.hiHatChoke).toBe(false);
    expect(decoded.project.title).toBe('main v10 bundle');
    expect(decoded.payloads.map((payload) => [...payload.bytes])).toEqual(
      decoded.payloads.map((payload) => (payload.byteLength === 2 ? [1, 2] : [9, 8, 7])),
    );
    expect(decoded.payloads).toHaveLength(2);

    // Re-exporting writes a current-schema bundle that round-trips exactly.
    const payloadByChecksum = new Map(decoded.payloads.map((p) => [p.checksumSha256, p.bytes]));
    const reexported = await encodePortableProjectBundle(decoded.project, {
      read: async ({ checksumSha256 }) => payloadByChecksum.get(checksumSha256)!,
    });
    expect((await decodePortableProjectBundle(reexported)).project).toEqual(decoded.project);
  });

  it('decode_v10BundleAtExactly16MiB_isAcceptedBecauseTheLimitAppliesToSourceBytes', async () => {
    const LIMIT = 16 * 1024 * 1024;
    const bundle = new Uint8Array(readFileSync(FIXTURE));
    const document = JSON.parse(parts(bundle).projectText) as {
      tracks: Array<{ name: string; clips: Array<{ notes?: Array<Record<string, unknown>> }> }>;
    };
    const notes = document.tracks.find((track) => track.name === 'Melody')!.clips[0]!.notes!;
    const template = notes[0]!;
    // ~4 KiB ids (the 4,096-character string limit) fill the canonical v10 text to the limit.
    const note = (index: number, idLength: number) => ({
      ...template,
      id: `n${index}-`.padEnd(idLength, 'x'),
      pitch: 20 + (index % 80),
      startBeat: (index % 3000) / 100,
      durationBeats: 0.01,
    });
    const sized = (count: number, lastIdLength: number) => {
      notes.length = 1;
      for (let index = 1; index < count; index += 1) notes.push(note(index, 4000));
      notes.push(note(count, lastIdLength));
      return JSON.stringify(document);
    };
    const count = Math.floor((LIMIT - parts(bundle).projectText.length) / JSON.stringify(note(1, 4000)).length) - 1;
    const base = sized(count, 1000).length;
    const exact = sized(count, 1000 + LIMIT - base);
    expect(new TextEncoder().encode(exact).byteLength).toBe(LIMIT);

    const decoded = await decodePortableProjectBundle(await withProjectText(bundle, exact));
    expect(decoded.project.schemaVersion).toBe(12);
    // Control: one byte over the source limit is still too large.
    const over = sized(count, 1001 + LIMIT - base);
    await expect(decodePortableProjectBundle(await withProjectText(bundle, over))).rejects.toMatchObject(
      new PortableProjectBundleError('too-large'),
    );
  }, 60_000);

  it('decode_v10BundleWithReorderedKeys_isRejectedAsNonCanonical', async () => {
    const bundle = new Uint8Array(readFileSync(FIXTURE));
    const { id, ...rest } = JSON.parse(parts(bundle).projectText) as Record<string, unknown>;
    const idLast = JSON.stringify({ ...rest, id });
    await expect(decodePortableProjectBundle(await withProjectText(bundle, idLast))).rejects.toMatchObject(
      new PortableProjectBundleError('non-canonical'),
    );
  });

  it('decode_bundleBelowV10_isRejectedAsNonCanonical', async () => {
    const bundle = new Uint8Array(readFileSync(FIXTURE));
    const document = JSON.parse(parts(bundle).projectText) as Record<string, unknown>;
    const relabelled = JSON.stringify({ ...document, schemaVersion: 9 });
    await expect(decodePortableProjectBundle(await withProjectText(bundle, relabelled))).rejects.toMatchObject(
      new PortableProjectBundleError('non-canonical'),
    );
  });

  it('decode_olderBundleWithNonCanonicalProjectJson_isStillRejected', async () => {
    const bundle = new Uint8Array(readFileSync(FIXTURE));
    const { projectText } = parts(bundle);
    const pretty = JSON.stringify(JSON.parse(projectText), null, 1);
    await expect(decodePortableProjectBundle(await withProjectText(bundle, pretty))).rejects.toMatchObject(
      new PortableProjectBundleError('non-canonical'),
    );
    // Control: re-assembling with the original text is accepted, so only canonicality differs.
    await expect(decodePortableProjectBundle(await withProjectText(bundle, projectText))).resolves.toBeDefined();
  });
});
