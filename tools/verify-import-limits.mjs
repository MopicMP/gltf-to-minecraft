/** Compact hostile inputs and legitimate controls. Run: node tools/verify-import-limits.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const pluginPath = process.argv.includes('--plugin')
	? process.argv[process.argv.indexOf('--plugin') + 1]
	: new URL('../plugin/gltf_to_minecraft.js', import.meta.url);
const source = fs.readFileSync(pluginPath, 'utf8');
const lib = createRequire(import.meta.url)(pluginPath instanceof URL ? fileURLToPath(pluginPath) : pluginPath);
const { parseGLTFFiles, readAccessor, parseAnimations, decodePNG, decodePicture, imageSize, unpackModelArchive, sketchfabDownload, IMPORT_LIMITS: limits } = lib;
const files = gltf => ({ 'model.gltf': new TextEncoder().encode(JSON.stringify(gltf)) });

// A VM timeout makes this regression safe even against the old infinite loop.
const context = vm.createContext({ module: { exports: {} }, TextDecoder, TextEncoder, Uint8Array, Buffer });
vm.runInContext(source, context);
const cyclic = { scenes: [{ nodes: [0] }], nodes: [{ name: 'root', children: [0] }] };
context.modelFiles = files(cyclic);
assert.throws(() => vm.runInContext('module.exports.parseGLTFFiles(modelFiles)', context, { timeout: 250 }), /hierarchy contains a cycle/);
console.log('PASS: wrapper cycle rejected before synchronous traversal');
if (process.argv.includes('--cycle-only')) process.exit(0);

assert.throws(() => parseGLTFFiles(files({ scenes: [{ nodes: [0] }], nodes: [{ children: [1] }, { children: [0] }] }), { ignoreRootTransform: false }), /cycle/);
assert.throws(() => parseGLTFFiles(files({ scenes: [{ nodes: [0] }], nodes: [{ children: [-1] }] })), /node index/);
const deep = Array.from({ length: limits.depth + 2 }, (_, i) => i <= limits.depth ? { children: [i + 1] } : {});
assert.throws(() => parseGLTFFiles(files({ scenes: [{ nodes: [0] }], nodes: deep })), /hierarchy depth/);
assert.equal(parseGLTFFiles(files({ nodes: [{ children: [1] }, {}] })).hierarchy.length, 3);
assert.equal(parseGLTFFiles(files({ scenes: [{ nodes: [0, 1] }], nodes: [{}, {}] })).hierarchy.length, 2);

const accessor = count => ({ accessors: [{ componentType: 5126, type: 'VEC3', count }] });
for (const count of [1000000000, -1, 0.5, Infinity, NaN, '3']) {
	assert.throws(() => readAccessor(accessor(count), [], 0), /accessor count/);
}
assert.deepEqual(readAccessor(accessor(2), [], 0), [[0, 0, 0], [0, 0, 0]]);
const components = { components: limits.accessorComponents - 3 };
readAccessor(accessor(1), [], 0, components);
assert.throws(() => readAccessor(accessor(1), [], 0, components), /decoded accessor components/);

// Valid interleaving and sparse overrides; sparse indices must never extend the array.
const backing = new Uint8Array(48), dv = new DataView(backing.buffer);
[1, 2, 3, 4, 5, 6].forEach((n, i) => dv.setFloat32(8 + Math.floor(i / 3) * 16 + (i % 3) * 4, n, true));
const interleaved = { accessors: [{ componentType: 5126, type: 'VEC3', count: 2, bufferView: 0, byteOffset: 4 }],
	bufferViews: [{ buffer: 0, byteOffset: 4, byteLength: 36, byteStride: 16 }] };
assert.deepEqual(readAccessor(interleaved, [backing], 0), [[1, 2, 3], [4, 5, 6]]);
interleaved.bufferViews[0].byteLength = 20;
assert.throws(() => readAccessor(interleaved, [backing], 0), /bufferView/);
const sparseBytes = new Uint8Array(16);
sparseBytes[0] = 1;
new DataView(sparseBytes.buffer).setFloat32(4, 7, true);
const sparse = { accessors: [{ componentType: 5126, type: 'SCALAR', count: 2,
	sparse: { count: 1, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 1 } } }],
	bufferViews: [{ buffer: 0, byteLength: 1 }, { buffer: 0, byteOffset: 4, byteLength: 4 }] };
assert.deepEqual(readAccessor(sparse, [sparseBytes], 0), [[0], [7]]);
sparseBytes[0] = 255;
assert.throws(() => readAccessor(sparse, [sparseBytes], 0), /sparse accessor index/);
sparse.accessors[0].sparse.count = 3;
assert.throws(() => readAccessor(sparse, [sparseBytes], 0), /sparse accessor count/);
const animated = { ...accessor(1000000000), animations: [{ samplers: [{ input: 0, output: 0 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }] };
assert.throws(() => parseAnimations(animated, [], []), /accessor count/);
const meshModel = { ...accessor(1000000000), scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] };
assert.throws(() => parseGLTFFiles(files(meshModel)), /accessor count/);

const chunk = (type, bytes) => {
	const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
	return Buffer.concat([length, Buffer.from(type), bytes, Buffer.alloc(4)]);
};
const png = (w, h, raw, depth = 8, extra = []) => {
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = 6;
	return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...extra,
		chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
};
const giant = png(30000, 30000, Buffer.alloc(0));
assert.throws(() => decodePNG(giant), /image width/);
assert.throws(() => imageSize(giant), /image width/);
const webp = new Uint8Array(32);
webp.set(Buffer.from('RIFF'), 0); webp.set(Buffer.from('WEBPVP8X'), 8);
webp[24] = 0xff; webp[25] = 0xff;
assert.throws(() => imageSize(webp), /image width/);
assert.throws(() => decodePNG(png(8192, 8192, Buffer.alloc(0))), /pixel limit/);
assert.throws(() => decodePNG(png(0, 1, Buffer.alloc(0))), /pixel limit/);
assert.throws(() => decodePNG(png(2, 2, Buffer.alloc(0))), /incomplete PNG scanlines/);
assert.throws(() => decodePNG(png(1, 1, Buffer.from([0, 1, 2, 3, 255]), 8, [chunk('IHDR', Buffer.alloc(13))])), /duplicate PNG header/);
const valid = png(1, 1, Buffer.from([0, 1, 2, 3, 255]));
assert.deepEqual([...decodePNG(valid).data], [1, 2, 3, 255]);
assert.throws(() => decodePNG(valid.subarray(0, valid.length - 2)), /truncated PNG chunk/);
let nativeDecodes = 0;
globalThis.Image = class {
	set src(value) { nativeDecodes++; this.naturalWidth = 1; this.naturalHeight = 1; this.onload(); }
};
globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }) }) };
await assert.rejects(decodePicture({ bytes: giant }), /image width/);
await assert.rejects(decodePicture({ bytes: png(30000, 1, Buffer.alloc(0), 16) }), /image width/);
await assert.rejects(decodePicture({ bytes: png(2, 2, Buffer.alloc(0)) }), /incomplete PNG scanlines/);
assert.equal(nativeDecodes, 0);
assert.equal((await decodePicture({ bytes: png(1, 1, Buffer.alloc(0), 16) })).data.length, 4);
assert.equal(nativeDecodes, 1);
const pixels = { pixels: limits.totalImagePixels };
await assert.rejects(decodePicture({ bytes: valid }, pixels), /decoded image pixels/);
globalThis.Image = class { set src(value) { this.naturalWidth = 30000; this.naturalHeight = 1; this.onload(); } };
await assert.rejects(decodePicture({ bytes: new Uint8Array(24) }), /image width/);
delete globalThis.Image; delete globalThis.document;

// A faithful pausable stream double lets large-output budgets run without huge allocations.
let paused = 0, membersStarted = 0;
const member = chunks => ({ dir: false, internalStream() {
	membersStarted++;
	const handlers = {}; let stopped = false;
	return { on(event, fn) { handlers[event] = fn; return this; }, pause() { stopped = true; paused++; }, resume() {
		queueMicrotask(() => {
			for (const c of chunks) { if (stopped) return; handlers.data(c); }
			if (!stopped) handlers.end();
		}); return this;
	} };
} });
const zip = entries => { globalThis.JSZip = { loadAsync: async () => ({ forEach: fn => entries.forEach(([name, entry]) => fn(name, entry)) }) }; };
zip([['folder/', { dir: true }], ['folder/model.gltf', member([new Uint8Array([1]), new Uint8Array([2])])], ['__proto__', member([new Uint8Array([3])])]]);
let entries = await unpackModelArchive(new Uint8Array(1));
assert.deepEqual([...entries['folder/model.gltf']], [1, 2]);
assert.deepEqual([...entries.__proto__], [3]);
assert.equal(Object.getPrototypeOf(entries), null);
const logicalChunk = byteLength => ({ byteLength });
zip([['unused.bin', member([logicalChunk(limits.archiveEntryBytes + 1)])], ['next', member([])]]);
membersStarted = 0;
await assert.rejects(unpackModelArchive(new Uint8Array(1)), /archive entry bytes/);
assert.equal(paused, 1); assert.equal(membersStarted, 1);
// Aggregate overflow is caught in the first offending chunk, before copying it.
const megabyte = new Uint8Array(1024 * 1024);
zip([['first', member(Array(64).fill(megabyte))], ['second', member(Array(64).fill(megabyte))],
	['third', member([new Uint8Array(1)])]]);
await assert.rejects(unpackModelArchive(new Uint8Array(1)), /archive expanded bytes/);
zip(Array.from({ length: limits.archiveEntries + 1 }, (_, i) => [String(i), { dir: true }]));
await assert.rejects(unpackModelArchive(new Uint8Array(1)), /archive entry count/);
await assert.rejects(unpackModelArchive({ byteLength: limits.archiveInputBytes + 1 }), /archive input bytes/);
zip([['model.gltf', { dir: false, async() { throw new Error('unsafe async fallback'); } }]]);
await assert.rejects(unpackModelArchive(new Uint8Array(1)), /cannot stream archive entries/);

const originalFetch = globalThis.fetch;
let cancelled = false;
zip([['model.gltf', member([new Uint8Array([1])])]]);
globalThis.fetch = async url => url.endsWith('/download')
	? { ok: true, json: async () => ({ gltf: { url: 'https://example.test/model.zip' } }) }
	: url.includes('api.sketchfab.com') ? { ok: true, json: async () => ({ source: 'website' }) }
		: { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } }) };
assert.equal((await sketchfabDownload('id', 'token')).entries['model.gltf'][0], 1);
globalThis.fetch = async url => url.endsWith('/download')
	? { ok: true, json: async () => ({ gltf: { url: 'https://example.test/model.zip' } }) }
	: url.includes('api.sketchfab.com') ? { ok: true, json: async () => ({ source: 'website' }) }
		: { ok: true, body: { getReader: () => ({ read: async () => ({ done: false, value: logicalChunk(limits.archiveInputBytes + 1) }),
			cancel: async () => { cancelled = true; }, releaseLock() {} }) } };
await assert.rejects(sketchfabDownload('id', 'token'), /archive download bytes/);
assert.equal(cancelled, true);
globalThis.fetch = originalFetch; delete globalThis.JSZip;
// Optional integration with an installed JSZip, without adding a production dependency.
if (process.env.JSZIP_PATH) {
	const JSZip = createRequire(import.meta.url)(process.env.JSZIP_PATH);
	globalThis.JSZip = JSZip;
	const archive = new JSZip();
	archive.file('folder/model.gltf', JSON.stringify({ asset: { version: '2.0' } }));
	archive.file('textures/small.bin', new Uint8Array([1, 2, 3]));
	entries = await unpackModelArchive(await archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
	assert.deepEqual([...entries['textures/small.bin']], [1, 2, 3]);
	const bomb = new JSZip();
	bomb.file('unused.bin', new Uint8Array(limits.archiveEntryBytes + 1));
	const compressed = await bomb.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
	assert(compressed.length < 100000);
	await assert.rejects(unpackModelArchive(compressed), /archive entry bytes/);
	delete globalThis.JSZip;
	console.log(`PASS: JSZip ${JSZip.version} real DEFLATE archive and expansion limit`);
}
console.log('PASS: graph, accessor, image and streamed archive limits; legitimate controls preserved');
