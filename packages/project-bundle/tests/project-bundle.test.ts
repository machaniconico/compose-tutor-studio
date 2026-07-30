import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_PROJECT_JSON_BYTES,
  MAX_AUDIO_ASSETS,
  createEmptyProject,
  serializeProject,
  type Project,
  type ReadyAudioAsset,
} from '@cts/project-model';
import {
  PORTABLE_PROJECT_BUNDLE_HEADER_BYTES,
  MAX_PORTABLE_PROJECT_BUNDLE_ASSET_BYTES,
  MAX_PORTABLE_PROJECT_BUNDLE_BYTES,
  MAX_PORTABLE_PROJECT_BUNDLE_MANIFEST_BYTES,
  PortableProjectBundleError,
  checkedPortableProjectBundleTotal,
  decodePortableProjectBundle,
  encodePortableProjectBundle,
} from '../src';
import headerCases from '../fixtures/header-v1-cases.json';

async function checksum(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function asset(id: string, bytes: Uint8Array): Promise<ReadyAudioAsset> {
  return {
    id,
    availability: 'ready',
    checksumSha256: await checksum(bytes),
    originalName: `${id}.wav`,
    mediaType: 'audio/wav',
    byteLength: bytes.byteLength,
    sampleRate: 44_100,
    channelCount: 1,
    frameCount: bytes.byteLength,
  };
}

type MutableManifest = {
  format: unknown;
  version: unknown;
  project: Record<string, unknown>;
  assets: Array<Record<string, unknown>>;
};

function splitBundle(bundle: Uint8Array): {
  manifest: MutableManifest;
  projectText: string;
  payload: Uint8Array;
} {
  const header = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  const manifestLength = header.getUint32(12, true);
  const projectLength = header.getUint32(16, true);
  const manifestStart = PORTABLE_PROJECT_BUNDLE_HEADER_BYTES;
  const projectStart = manifestStart + manifestLength;
  const payloadStart = projectStart + projectLength;
  return {
    manifest: JSON.parse(new TextDecoder().decode(
      bundle.subarray(manifestStart, projectStart),
    )) as MutableManifest,
    projectText: new TextDecoder().decode(bundle.subarray(projectStart, payloadStart)),
    payload: bundle.subarray(payloadStart),
  };
}

async function assembleBundle(input: {
  manifest: MutableManifest;
  projectText: string;
  payload?: Uint8Array;
  manifestText?: string;
  assetCount?: number;
  preserveProjectDescriptor?: boolean;
}): Promise<Uint8Array> {
  const projectBytes = new TextEncoder().encode(input.projectText);
  if (!input.preserveProjectDescriptor) {
    input.manifest.project.byteLength = projectBytes.byteLength;
    input.manifest.project.checksumSha256 = await checksum(projectBytes);
  }
  const manifestBytes = new TextEncoder().encode(
    input.manifestText ?? JSON.stringify(input.manifest),
  );
  const payload = input.payload ?? new Uint8Array();
  const output = new Uint8Array(
    PORTABLE_PROJECT_BUNDLE_HEADER_BYTES
      + manifestBytes.byteLength + projectBytes.byteLength + payload.byteLength,
  );
  output.set(new TextEncoder().encode('CTSBNDL1'));
  const header = new DataView(output.buffer);
  header.setUint16(8, 1, true);
  header.setUint32(12, manifestBytes.byteLength, true);
  header.setUint32(16, projectBytes.byteLength, true);
  header.setUint32(20, input.assetCount ?? input.manifest.assets.length, true);
  header.setUint32(24, output.byteLength, true);
  output.set(manifestBytes, PORTABLE_PROJECT_BUNDLE_HEADER_BYTES);
  output.set(
    projectBytes,
    PORTABLE_PROJECT_BUNDLE_HEADER_BYTES + manifestBytes.byteLength,
  );
  output.set(
    payload,
    PORTABLE_PROJECT_BUNDLE_HEADER_BYTES + manifestBytes.byteLength + projectBytes.byteLength,
  );
  return output;
}

describe('portable project bundle v1', () => {
  it('writes its 32-byte header and round-trips canonical project and sorted payloads', async () => {
    const high = Uint8Array.of(9, 8, 7);
    const low = Uint8Array.of(1, 2);
    const entries = await Promise.all([asset('high', high), asset('low', low)]);
    const project: Project = { ...createEmptyProject({ title: 'portable' }), audioAssets: entries };
    const byChecksum = new Map(entries.map((entry, index) => [
      entry.checksumSha256,
      index === 0 ? high : low,
    ]));
    const bundle = await encodePortableProjectBundle(project, {
      read: async ({ checksumSha256 }) => byChecksum.get(checksumSha256)!,
    });
    const header = new DataView(bundle.buffer);
    expect(new TextDecoder().decode(bundle.subarray(0, 8))).toBe('CTSBNDL1');
    expect(PORTABLE_PROJECT_BUNDLE_HEADER_BYTES).toBe(32);
    expect(header.getUint16(8, true)).toBe(1);
    expect(header.getUint16(10, true)).toBe(0);
    const manifestLength = header.getUint32(12, true);
    const projectLength = header.getUint32(16, true);
    expect(header.getUint32(20, true)).toBe(2);
    expect(header.getUint32(24, true)).toBe(bundle.byteLength);
    expect(header.getUint32(28, true)).toBe(0);

    const decoded = await decodePortableProjectBundle(bundle);
    const canonicalProject = {
      ...project,
      audioAssets: [...entries].sort((a, b) =>
        (a.checksumSha256 < b.checksumSha256 ? -1 : a.checksumSha256 > b.checksumSha256 ? 1 : 0)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    };
    expect(decoded.project).toEqual(canonicalProject);

    const manifestStart = PORTABLE_PROJECT_BUNDLE_HEADER_BYTES;
    const projectStart = manifestStart + manifestLength;
    const payloadStart = projectStart + projectLength;
    const manifestText = new TextDecoder().decode(
      bundle.subarray(manifestStart, projectStart),
    );
    const projectText = new TextDecoder().decode(
      bundle.subarray(projectStart, payloadStart),
    );
    const manifest = JSON.parse(manifestText) as {
      format: string;
      version: number;
      project: { byteLength: number; checksumSha256: string };
      assets: Array<{ checksumSha256: string; byteLength: number }>;
    };
    expect(Object.keys(manifest)).toEqual(['format', 'version', 'project', 'assets']);
    expect(Object.keys(manifest.project)).toEqual(['byteLength', 'checksumSha256']);
    expect(manifest.assets.every((entry) =>
      Object.keys(entry).join(',') === 'checksumSha256,byteLength')).toBe(true);
    expect(JSON.stringify(manifest)).toBe(manifestText);
    expect(manifest.format).toBe('ctsbundle');
    expect(manifest.version).toBe(1);
    expect(projectText).toBe(serializeProject(canonicalProject));
    expect(manifest.project.byteLength).toBe(new TextEncoder().encode(projectText).byteLength);

    const sortedChecksums = [...byChecksum.keys()].sort();
    expect(manifest.assets.map((entry) => entry.checksumSha256)).toEqual(sortedChecksums);
    expect(decoded.assets.map((entry) => entry.checksumSha256)).toEqual(sortedChecksums);
    let offset = payloadStart;
    for (const payload of decoded.assets) {
      expect(payload.bytes).toEqual(byChecksum.get(payload.checksumSha256));
      expect(payload.bytes.buffer).toBe(bundle.buffer);
      expect(payload.bytes.byteOffset).toBe(bundle.byteOffset + offset);
      offset += payload.byteLength;
    }
    expect(offset).toBe(bundle.byteLength);
  });

  it('is byte deterministic across asset input and asynchronous read order', async () => {
    const bytes = [Uint8Array.of(3, 2, 1), Uint8Array.of(7, 8, 9, 10)];
    const entries = await Promise.all(bytes.map((value, index) => asset(`a${index}`, value)));
    const byChecksum = new Map(entries.map((entry, index) => [entry.checksumSha256, bytes[index]!]));
    const base = createEmptyProject({ title: 'deterministic' });
    const encode = (audioAssets: ReadyAudioAsset[], reverseDelay: boolean) =>
      encodePortableProjectBundle({ ...base, audioAssets }, {
        read: async ({ checksumSha256 }) => {
          const index = entries.findIndex((entry) => entry.checksumSha256 === checksumSha256);
          await new Promise((resolve) => setTimeout(resolve, reverseDelay ? (1 - index) * 2 : index * 2));
          return byChecksum.get(checksumSha256)!;
        },
      });
    expect(await encode(entries, false)).toEqual(await encode([...entries].reverse(), true));
  });

  it('reads and releases one repository payload at a time', async () => {
    const values = [
      Uint8Array.of(1, 2, 3),
      Uint8Array.of(4, 5, 6, 7),
      Uint8Array.of(8, 9),
    ];
    const entries = await Promise.all(
      values.map((value, index) => asset(`sequential-${index}`, value)),
    );
    const byChecksum = new Map(
      entries.map((entry, index) => [entry.checksumSha256, values[index]!]),
    );
    let activeReads = 0;
    let maximumActiveReads = 0;
    await encodePortableProjectBundle(
      { ...createEmptyProject(), audioAssets: [...entries].reverse() },
      {
        read: async ({ checksumSha256 }) => {
          activeReads += 1;
          maximumActiveReads = Math.max(maximumActiveReads, activeReads);
          await new Promise((resolve) => setTimeout(resolve, 1));
          activeReads -= 1;
          return byChecksum.get(checksumSha256)!;
        },
      },
    );
    expect(maximumActiveReads).toBe(1);
    expect(activeReads).toBe(0);
  });

  it('deduplicates matching content metadata while preserving project aliases', async () => {
    const bytes = Uint8Array.of(1, 4, 9);
    const first = await asset('first', bytes);
    const second = { ...first, id: 'second', originalName: 'renamed.wav' };
    let reads = 0;
    const bundle = await encodePortableProjectBundle(
      { ...createEmptyProject(), audioAssets: [second, first] },
      { read: async () => { reads += 1; return bytes; } },
    );
    expect(reads).toBe(1);
    const header = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
    expect(header.getUint32(20, true)).toBe(1);
    const manifestLength = header.getUint32(12, true);
    const manifest = JSON.parse(new TextDecoder().decode(bundle.subarray(
      PORTABLE_PROJECT_BUNDLE_HEADER_BYTES,
      PORTABLE_PROJECT_BUNDLE_HEADER_BYTES + manifestLength,
    ))) as { assets: unknown[] };
    expect(manifest.assets).toHaveLength(1);
    const decoded = await decodePortableProjectBundle(bundle);
    expect(decoded.assets).toHaveLength(1);
    expect(decoded.project.audioAssets).toHaveLength(2);
  });

  it('rejects a projected oversized bundle before the first asset read', async () => {
    const read = vi.fn(async () => new Uint8Array());
    const allocate = vi.fn((byteLength: number) => new Uint8Array(byteLength));
    const oversized: ReadyAudioAsset = {
      id: 'oversized',
      availability: 'ready',
      checksumSha256: 'a'.repeat(64),
      originalName: 'oversized.wav',
      mediaType: 'audio/wav',
      byteLength: MAX_PORTABLE_PROJECT_BUNDLE_BYTES,
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: 1,
    };
    await expect(encodePortableProjectBundle(
      { ...createEmptyProject(), audioAssets: [oversized] },
      { read },
      { allocate },
    )).rejects.toMatchObject({ code: 'too-large' });
    expect(read).not.toHaveBeenCalled();
    expect(allocate).not.toHaveBeenCalled();
  });

  it('maps invalid Project input and enforces the existing 16 MiB embedded JSON contract', async () => {
    const project = {
      ...createEmptyProject(),
      title: 'x'.repeat(DEFAULT_MAX_PROJECT_JSON_BYTES),
    };
    const read = vi.fn();
    const allocate = vi.fn((byteLength: number) => new Uint8Array(byteLength));
    const hash = vi.fn(async () => '0'.repeat(64));
    await expect(encodePortableProjectBundle(
      project,
      { read },
      { allocate, hash },
    )).rejects.toMatchObject({ code: 'invalid-project' });
    expect(read).not.toHaveBeenCalled();
    expect(allocate).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();

    const oversized = new Uint8Array(
      PORTABLE_PROJECT_BUNDLE_HEADER_BYTES + DEFAULT_MAX_PROJECT_JSON_BYTES + 1,
    );
    oversized.set(new TextEncoder().encode('CTSBNDL1'));
    const header = new DataView(oversized.buffer);
    header.setUint16(8, 1, true);
    header.setUint32(16, DEFAULT_MAX_PROJECT_JSON_BYTES + 1, true);
    header.setUint32(24, oversized.byteLength, true);
    const parseJson = vi.fn(JSON.parse);
    await expect(decodePortableProjectBundle(oversized, { parseJson, hash }))
      .rejects.toMatchObject({ code: 'too-large' });
    expect(parseJson).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it('writes through an injected offset allocator without allocating another bundle', async () => {
    let backing: Uint8Array<ArrayBuffer> | undefined;
    const allocate = vi.fn((byteLength: number): Uint8Array<ArrayBuffer> => {
      backing = new Uint8Array(byteLength + 13);
      return backing.subarray(7, 7 + byteLength);
    });
    const bundle = await encodePortableProjectBundle(
      createEmptyProject(),
      { read: vi.fn() },
      { allocate },
    );
    expect(allocate).toHaveBeenCalledOnce();
    expect(bundle.buffer).toBe(backing!.buffer);
    expect(bundle.byteOffset).toBe(7);
    expect(new TextDecoder().decode(bundle.subarray(0, 8))).toBe('CTSBNDL1');
    await expect(decodePortableProjectBundle(bundle)).resolves.toMatchObject({
      project: { audioAssets: [] },
    });
  });

  it('rejects unresolved assets and contradictory metadata but permits aliases', async () => {
    const bytes = Uint8Array.of(2, 4, 6);
    const first = await asset('first', bytes);
    const alias = { ...first, id: 'alias', originalName: '別名.wav' };
    await expect(encodePortableProjectBundle(
      { ...createEmptyProject(), audioAssets: [first, alias] },
      { read: async () => bytes },
    )).resolves.toBeInstanceOf(Uint8Array);

    for (const patch of [
      { byteLength: first.byteLength + 1 },
      { mediaType: 'audio/mpeg' as const },
      { sampleRate: first.sampleRate + 1 },
      { channelCount: first.channelCount + 1 },
      { frameCount: first.frameCount + 1 },
    ]) {
      await expect(encodePortableProjectBundle(
        {
          ...createEmptyProject(),
          audioAssets: [first, { ...alias, ...patch }],
        },
        { read: async () => bytes },
      )).rejects.toMatchObject({ code: 'asset-metadata-conflict' });
    }

    await expect(encodePortableProjectBundle({
      ...createEmptyProject(),
      audioAssets: [{
        id: 'lost',
        availability: 'unresolved',
        reason: 'missing-reference',
      }],
    }, { read: vi.fn() })).rejects.toMatchObject({ code: 'unresolved-asset' });
  });

  it('returns borrowed payload views for an offset input without a whole-bundle copy', async () => {
    const bytes = Uint8Array.of(5, 4, 3, 2, 1);
    const entry = await asset('offset', bytes);
    const bundle = await encodePortableProjectBundle(
      { ...createEmptyProject(), audioAssets: [entry] },
      { read: async () => bytes },
    );
    const backing = new Uint8Array(bundle.byteLength + 17);
    backing.set(bundle, 9);
    const input = backing.subarray(9, 9 + bundle.byteLength);
    const decoded = await decodePortableProjectBundle(input);
    const payload = decoded.assets[0]!;
    expect(payload.bytes.buffer).toBe(backing.buffer);
    expect(payload.bytes.byteOffset).toBeGreaterThan(input.byteOffset);
    expect(payload.bytes.byteLength).toBe(entry.byteLength);
  });

  it('rejects an oversized decode before JSON parsing or hashing', async () => {
    const oversized = new Uint8Array(MAX_PORTABLE_PROJECT_BUNDLE_BYTES + 1);
    const parseJson = vi.fn(JSON.parse);
    const hash = vi.fn(async () => '0'.repeat(64));
    await expect(decodePortableProjectBundle(oversized, { parseJson, hash }))
      .rejects.toMatchObject({ code: 'too-large' });
    expect(parseJson).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it('rejects an oversized manifest before JSON parsing or hashing', async () => {
    const oversized = new Uint8Array(
      PORTABLE_PROJECT_BUNDLE_HEADER_BYTES
        + MAX_PORTABLE_PROJECT_BUNDLE_MANIFEST_BYTES + 1,
    );
    oversized.set(new TextEncoder().encode('CTSBNDL1'));
    const header = new DataView(oversized.buffer);
    header.setUint16(8, 1, true);
    header.setUint32(12, MAX_PORTABLE_PROJECT_BUNDLE_MANIFEST_BYTES + 1, true);
    header.setUint32(24, oversized.byteLength, true);
    const parseJson = vi.fn(JSON.parse);
    const hash = vi.fn(async () => '0'.repeat(64));
    await expect(decodePortableProjectBundle(oversized, { parseJson, hash }))
      .rejects.toMatchObject({ code: 'too-large' });
    expect(parseJson).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it('rejects BOM-prefixed manifest and Project bytes as non-canonical', async () => {
    const bundle = await encodePortableProjectBundle(createEmptyProject(), {
      read: vi.fn(),
    });
    const header = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
    const manifestLength = header.getUint32(12, true);
    const projectLength = header.getUint32(16, true);
    const metadataStart = PORTABLE_PROJECT_BUNDLE_HEADER_BYTES;
    const manifest = bundle.subarray(metadataStart, metadataStart + manifestLength);
    const project = bundle.subarray(
      metadataStart + manifestLength,
      metadataStart + manifestLength + projectLength,
    );
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf);

    const withBom = (target: 'manifest' | 'project'): Uint8Array => {
      const nextManifest = target === 'manifest'
        ? Uint8Array.from([...bom, ...manifest])
        : manifest;
      const nextProject = target === 'project'
        ? Uint8Array.from([...bom, ...project])
        : project;
      const next = new Uint8Array(
        PORTABLE_PROJECT_BUNDLE_HEADER_BYTES + nextManifest.byteLength + nextProject.byteLength,
      );
      next.set(bundle.subarray(0, PORTABLE_PROJECT_BUNDLE_HEADER_BYTES));
      next.set(nextManifest, PORTABLE_PROJECT_BUNDLE_HEADER_BYTES);
      next.set(nextProject, PORTABLE_PROJECT_BUNDLE_HEADER_BYTES + nextManifest.byteLength);
      const nextHeader = new DataView(next.buffer);
      nextHeader.setUint32(12, nextManifest.byteLength, true);
      nextHeader.setUint32(16, nextProject.byteLength, true);
      nextHeader.setUint32(24, next.byteLength, true);
      return next;
    };

    for (const target of ['manifest', 'project'] as const) {
      await expect(decodePortableProjectBundle(withBom(target)))
        .rejects.toBeInstanceOf(PortableProjectBundleError);
    }
  });

  it.each(headerCases)('rejects header fixture: $name', async (fixture) => {
    const bundle = await encodePortableProjectBundle(createEmptyProject(), { read: vi.fn() });
    const changed = bundle.slice();
    const header = new DataView(changed.buffer);
    if (fixture.kind === 'uint16') header.setUint16(fixture.offset, fixture.value, true);
    else header.setUint32(fixture.offset, fixture.value, true);
    await expect(decodePortableProjectBundle(changed))
      .rejects.toMatchObject({ code: fixture.code });
  });

  it('rejects unknown, missing, wrong-type and malformed manifest members at every level', async () => {
    const bytes = Uint8Array.of(3, 1, 4);
    const entry = await asset('contract', bytes);
    const valid = await encodePortableProjectBundle(
      { ...createEmptyProject(), audioAssets: [entry] },
      { read: async () => bytes },
    );
    const base = splitBundle(valid);
    const cases: Array<(manifest: MutableManifest) => void> = [
      (manifest) => { (manifest as MutableManifest & { extra?: boolean }).extra = true; },
      (manifest) => { delete (manifest as Partial<MutableManifest>).format; },
      (manifest) => { manifest.version = '1'; },
      (manifest) => { manifest.format = 'other'; },
      (manifest) => { manifest.version = 2; },
      (manifest) => { manifest.project.extra = true; },
      (manifest) => { delete manifest.project.byteLength; },
      (manifest) => { manifest.project.byteLength = '1'; },
      (manifest) => { manifest.project.byteLength = 0; },
      (manifest) => { manifest.project.checksumSha256 = 'A'.repeat(64); },
      (manifest) => { manifest.assets[0]!.extra = true; },
      (manifest) => { delete manifest.assets[0]!.byteLength; },
      (manifest) => { manifest.assets[0]!.byteLength = '3'; },
      (manifest) => { manifest.assets[0]!.byteLength = 0; },
      (manifest) => { manifest.assets[0]!.checksumSha256 = 'A'.repeat(64); },
    ];
    for (const mutate of cases) {
      const manifest = structuredClone(base.manifest);
      mutate(manifest);
      const changed = await assembleBundle({
        manifest,
        projectText: base.projectText,
        payload: base.payload,
        preserveProjectDescriptor: true,
      });
      await expect(decodePortableProjectBundle(changed))
        .rejects.toMatchObject({ code: 'invalid-manifest' });
    }
  });

  it('rejects non-canonical manifest spelling, key order, and asset order', async () => {
    const bytes = [Uint8Array.of(1), Uint8Array.of(2)];
    const entries = await Promise.all(bytes.map((value, index) => asset(`m${index}`, value)));
    const byChecksum = new Map(entries.map((entry, index) => [entry.checksumSha256, bytes[index]!]));
    const valid = await encodePortableProjectBundle(
      { ...createEmptyProject(), audioAssets: entries },
      { read: async ({ checksumSha256 }) => byChecksum.get(checksumSha256)! },
    );
    const base = splitBundle(valid);
    const canonical = JSON.stringify(base.manifest);
    const variants = [
      `\uFEFF${canonical}`,
      ` ${canonical}`,
      `${canonical}\n`,
      JSON.stringify({
        version: base.manifest.version,
        format: base.manifest.format,
        project: base.manifest.project,
        assets: base.manifest.assets,
      }),
      canonical.replace('"version":1', '"version":1.0'),
      JSON.stringify({
        ...base.manifest,
        assets: [...base.manifest.assets].reverse(),
      }),
    ];
    for (const manifestText of variants) {
      const changed = await assembleBundle({
        manifest: structuredClone(base.manifest),
        projectText: base.projectText,
        payload: base.payload,
        manifestText,
      });
      await expect(decodePortableProjectBundle(changed))
        .rejects.toMatchObject({ code: 'non-canonical' });
    }
  });

  it('rejects non-canonical Project BOM, whitespace, key order and numeric spelling', async () => {
    const valid = await encodePortableProjectBundle(createEmptyProject(), { read: vi.fn() });
    const base = splitBundle(valid);
    const parsed = JSON.parse(base.projectText) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(parsed).reverse());
    const numeric = base.projectText.replace(/:(-?\d+)(?=[,}])/u, ':$1.0');
    const variants = [
      `\uFEFF${base.projectText}`,
      ` ${base.projectText}`,
      `${base.projectText}\n`,
      JSON.stringify(reversed),
      numeric,
    ];
    for (const projectText of variants) {
      const manifest = structuredClone(base.manifest);
      const projectBytes = new TextEncoder().encode(projectText);
      manifest.project.byteLength = projectBytes.byteLength;
      manifest.project.checksumSha256 = await checksum(projectBytes);
      const changed = await assembleBundle({ manifest, projectText });
      await expect(decodePortableProjectBundle(changed))
        .rejects.toMatchObject({ code: 'non-canonical' });
    }
  });

  it('rejects an unsorted Project audioAssets array that the writer cannot emit', async () => {
    const values = [Uint8Array.of(11), Uint8Array.of(12)];
    const entries = await Promise.all(
      values.map((value, index) => asset(`project-order-${index}`, value)),
    );
    const byChecksum = new Map(
      entries.map((entry, index) => [entry.checksumSha256, values[index]!]),
    );
    const valid = await encodePortableProjectBundle(
      { ...createEmptyProject(), audioAssets: entries },
      { read: async ({ checksumSha256 }) => byChecksum.get(checksumSha256)! },
    );
    const base = splitBundle(valid);
    const project = JSON.parse(base.projectText) as Project;
    project.audioAssets = [...project.audioAssets].reverse();
    const changed = await assembleBundle({
      manifest: structuredClone(base.manifest),
      projectText: JSON.stringify(project),
      payload: base.payload,
    });
    await expect(decodePortableProjectBundle(changed))
      .rejects.toMatchObject({ code: 'non-canonical' });
  });

  it('reports a future embedded Project schema as unsupported rather than corrupt', async () => {
    const valid = await encodePortableProjectBundle(createEmptyProject(), { read: vi.fn() });
    const base = splitBundle(valid);
    const project = JSON.parse(base.projectText) as Record<string, unknown>;
    project.schemaVersion = 65_535;
    const changed = await assembleBundle({
      manifest: structuredClone(base.manifest),
      projectText: JSON.stringify(project),
    });
    await expect(decodePortableProjectBundle(changed))
      .rejects.toMatchObject({ code: 'unsupported-version' });
  });

  it('distinguishes duplicate manifest aliases from contradictory lengths', async () => {
    const bytes = Uint8Array.of(6, 2);
    const entry = await asset('duplicate', bytes);
    const valid = await encodePortableProjectBundle(
      { ...createEmptyProject(), audioAssets: [entry] },
      { read: async () => bytes },
    );
    const base = splitBundle(valid);
    for (const [byteLength, code] of [
      [entry.byteLength, 'non-canonical'],
      [entry.byteLength + 1, 'asset-metadata-conflict'],
    ] as const) {
      const manifest = structuredClone(base.manifest);
      manifest.assets.push({
        checksumSha256: entry.checksumSha256,
        byteLength,
      });
      const changed = await assembleBundle({
        manifest,
        projectText: base.projectText,
        payload: base.payload,
        assetCount: 2,
      });
      await expect(decodePortableProjectBundle(changed)).rejects.toMatchObject({ code });
    }
  });

  it('rejects exact-correspondence, truncation, tamper and trailing-byte violations', async () => {
    const bytes = Uint8Array.of(8, 9, 7);
    const entry = await asset('boundaries', bytes);
    const valid = await encodePortableProjectBundle(
      { ...createEmptyProject(), audioAssets: [entry] },
      { read: async () => bytes },
    );
    const headerMismatch = valid.slice();
    new DataView(headerMismatch.buffer).setUint32(20, 0, true);
    await expect(decodePortableProjectBundle(headerMismatch))
      .rejects.toMatchObject({ code: 'length-mismatch' });

    const tampered = valid.slice();
    const lastIndex = tampered.byteLength - 1;
    tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 0xff;
    await expect(decodePortableProjectBundle(tampered))
      .rejects.toMatchObject({ code: 'checksum-mismatch' });

    const truncated = valid.subarray(0, valid.byteLength - 1);
    await expect(decodePortableProjectBundle(truncated))
      .rejects.toMatchObject({ code: 'invalid-header' });

    const trailing = new Uint8Array(valid.byteLength + 1);
    trailing.set(valid);
    new DataView(trailing.buffer).setUint32(24, trailing.byteLength, true);
    await expect(decodePortableProjectBundle(trailing))
      .rejects.toMatchObject({ code: 'length-mismatch' });

    const parts = splitBundle(valid);
    const missingManifestEntry = structuredClone(parts.manifest);
    missingManifestEntry.assets = [];
    const missing = await assembleBundle({
      manifest: missingManifestEntry,
      projectText: parts.projectText,
      payload: parts.payload,
      assetCount: 0,
    });
    await expect(decodePortableProjectBundle(missing))
      .rejects.toMatchObject({ code: 'invalid-manifest' });
  });

  it('enforces safe-integer, uint32, total, per-asset and count exact boundaries', () => {
    expect(checkedPortableProjectBundleTotal([MAX_PORTABLE_PROJECT_BUNDLE_BYTES]))
      .toBe(MAX_PORTABLE_PROJECT_BUNDLE_BYTES);
    for (const values of [
      [MAX_PORTABLE_PROJECT_BUNDLE_BYTES, 1],
      [0xffff_ffff, 1],
      [Number.MAX_SAFE_INTEGER, 1],
      [Number.MAX_SAFE_INTEGER + 1],
      [-1],
    ]) {
      expect(() => checkedPortableProjectBundleTotal(values))
        .toThrowError(expect.objectContaining({ code: 'too-large' }));
    }
    expect(MAX_PORTABLE_PROJECT_BUNDLE_ASSET_BYTES)
      .toBe(MAX_PORTABLE_PROJECT_BUNDLE_BYTES);
    expect(MAX_AUDIO_ASSETS).toBe(4_096);
  });

  it('rejects MAX_AUDIO_ASSETS plus one before repository access', async () => {
    const read = vi.fn();
    const unresolved = Array.from({ length: MAX_AUDIO_ASSETS + 1 }, (_, index) => ({
      id: `too-many-${index}`,
      availability: 'unresolved' as const,
      reason: 'missing-reference' as const,
    }));
    await expect(encodePortableProjectBundle(
      { ...createEmptyProject(), audioAssets: unresolved },
      { read },
    )).rejects.toMatchObject({ code: 'too-many-assets' });
    expect(read).not.toHaveBeenCalled();
  });
});
