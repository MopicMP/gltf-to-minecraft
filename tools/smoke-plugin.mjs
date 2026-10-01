/**
 * Smoke test: runs the WHOLE import path with Blockbench objects stubbed out.
 *
 * Why: `node --check` only catches syntax. Errors like "access to a const
 * before its declaration", typos in names and calls to functions that do not exist show up only
 * at run time — and used to reach the user. Here the code actually
 * runs, so such errors fail here.
 *
 * Numerical accuracy does not matter: the maths is covered by separate tests. In particular,
 * UV calibration in the sandbox yields meaningless values — the probe cube's geometry
 * is synthetic here. What is checked is that the code RUNS, not that it is right.
 *
 * Run: node tools/smoke-plugin.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';

// The plugin's pure functions, as the other tools load them: the sandbox runs
// the plugin inside a closure, so nothing in it can be reached from here.
const lib = createRequire(import.meta.url)('../plugin/gltf_to_minecraft.js');

// ------------------------------------------------------------ mini-THREE

const clamp = v => Math.min(1, Math.max(-1, v));

class Quaternion {
	constructor(x = 0, y = 0, z = 0, w = 1) { Object.assign(this, { x, y, z, w }); }
	clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
	invert() { this.x *= -1; this.y *= -1; this.z *= -1; return this; }
	multiply(q) {
		const { x: ax, y: ay, z: az, w: aw } = this;
		const { x: bx, y: by, z: bz, w: bw } = q;
		this.x = aw * bx + ax * bw + ay * bz - az * by;
		this.y = aw * by - ax * bz + ay * bw + az * bx;
		this.z = aw * bz + ax * by - ay * bx + az * bw;
		this.w = aw * bw - ax * bx - ay * by - az * bz;
		return this;
	}
}

class Euler {
	constructor(x = 0, y = 0, z = 0, order = 'XYZ') { Object.assign(this, { x, y, z, order }); }
	setFromQuaternion(q, order) {
		// through a matrix, as in THREE
		const { x, y, z, w } = q;
		const m = [
			1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
			2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
			2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
		];
		return this.setFromMatrixArray(m, order);
	}
	setFromRotationMatrix(mat, order) { return this.setFromMatrixArray(mat.elements3, order); }
	setFromMatrixArray(m, order) {
		this.order = order || this.order;
		const [m11, m21, m31, m12, m22, m32, m13, m23, m33] = m;
		if (this.order === 'ZYX') {
			this.y = Math.asin(-clamp(m31));
			if (Math.abs(m31) < 0.9999999) { this.x = Math.atan2(m32, m33); this.z = Math.atan2(m21, m11); }
			else { this.x = 0; this.z = Math.atan2(-m12, m22); }
		} else {
			this.y = Math.asin(clamp(m13));
			if (Math.abs(m13) < 0.9999999) { this.x = Math.atan2(-m23, m33); this.z = Math.atan2(-m12, m11); }
			else { this.x = Math.atan2(m32, m22); this.z = 0; }
		}
		return this;
	}
}

class Vector3 {
	constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
	length() { return Math.hypot(this.x, this.y, this.z); }
	applyQuaternion(q) {
		const { x, y, z } = this;
		const ix = q.w * x + q.y * z - q.z * y;
		const iy = q.w * y + q.z * x - q.x * z;
		const iz = q.w * z + q.x * y - q.y * x;
		const iw = -q.x * x - q.y * y - q.z * z;
		this.x = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
		this.y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
		this.z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
		return this;
	}
	applyEuler() { return this; }
}

class Matrix4 {
	makeBasis(vx, vy, vz) { this.elements3 = [vx.x, vx.y, vx.z, vy.x, vy.y, vy.z, vz.x, vz.y, vz.z]; return this; }
}

const THREE = {
	Quaternion, Euler, Vector3, Matrix4,
	MathUtils: { radToDeg: r => r * 180 / Math.PI, degToRad: d => d * Math.PI / 180 },
};

// ------------------------------------------------- stubbing the Blockbench objects

const created = { cubes: [], groups: [], animations: [], textures: [] };
// What an open project already holds when a model is added to it; empty while
// every import builds a project of its own.
const openProject = { groups: [], textures: [], animations: [], elements: [] };
// Undo calls, canvas drawing and texture fills, in the order they happened.
const undoLog = [];
const eventLog = [];
const canvasLog = [];
let reportShown = null;
const problems = [];

class FakeMeshObj {
	constructor() { this.rotation = { x: 0, y: 0, z: 0, order: 'ZYX' }; this.position = { x: 0, y: 0, z: 0 }; }
}

class Cube {
	constructor(data = {}) {
		Object.assign(this, data);
		this.faces = {};
		for (const f of ['north', 'south', 'east', 'west', 'up', 'down']) this.faces[f] = { uv: null, texture: null };
		this.mesh = new FakeMeshObj();
		// cube geometry of 24 vertices — the way Blockbench gives it, relative to origin
		//
		// Each face's UV grow along the directions Blockbench 5 was measured to use
		// (the plugin's own fallback table), with V flipped as in WebGL. The probe
		// then measures a real convention. It used to lay u and v along the same
		// two axes on every face, and the table measured from that made the box
		// solver pick among orientations by float noise: a model moved by a few
		// pixels came out with other faces collapsed to lines.
		const pos = [], uv = [];
		const h = [8, 8, 8];
		const faces = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
		const dot = (p, d) => p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
		for (const [axis, sign] of faces) {
			const dirs = Object.values(lib.FACE_DIRS).find(d => d.normal[axis] === sign);
			for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
				const p = [0, 0, 0];
				p[axis] = sign * h[axis];
				p[(axis + 1) % 3] = a * h[(axis + 1) % 3];
				p[(axis + 2) % 3] = b * h[(axis + 2) % 3];
				pos.push(...p);
				uv.push(dot(p, dirs.u) > 0 ? 4 / 128 : 0, 1 - (dot(p, dirs.v) > 0 ? 8 / 128 : 0));
			}
		}
		this.mesh.geometry = {
			attributes: {
				position: { array: pos, count: 24 },
				uv: { array: uv, count: 24 },
			},
		};
	}
	init() { created.cubes.push(this); return this; }
	addTo(p) { this.parent = p; return this; }
	// probes go away again, as they do in Blockbench
	remove() { const i = created.cubes.indexOf(this); if (i >= 0) created.cubes.splice(i, 1); }
}

class Group {
	constructor(data = {}) {
		Object.assign(this, data);
		this.mesh = new FakeMeshObj();
		this.mesh.updateWorldMatrix = () => { };
		this.mesh.getWorldPosition = v => { v.x = 0; v.y = 0; v.z = 0; return v; };
		this.children = [];
	}
	init() { created.groups.push(this); return this; }
	addTo(p) { if (p && p.children) p.children.push(this); this.parent = p; return this; }
	remove() { const i = created.groups.indexOf(this); if (i >= 0) created.groups.splice(i, 1); }
	select() { Group.first_selected = this; return this; }
}
Group.first_selected = null;
Object.defineProperty(Group, 'all', { get: () => [...openProject.groups, ...created.groups] });

class BoneAnimator {
	constructor(name) { this.name = name; this.rotation = []; this.position = []; this.scale = []; }
	displayFrame() { }
	createKeyframe(data, time, channel) {
		if (!data || [data.x, data.y, data.z].some(v => typeof v !== 'number' || !isFinite(v))) {
			problems.push(`non-numeric keyframe in channel ${channel}: ${JSON.stringify(data)}`);
		}
		const kf = { data, time, channel };
		(this[channel] || (this[channel] = [])).push(kf);
		return kf;
	}
}

class Animation {
	constructor(data = {}) { Object.assign(this, data); this.animators = {}; }
	add() { created.animations.push(this); return this; }
	select() { Animation.selected = this; return this; }
	setLength() { }
	remove() { const i = created.animations.indexOf(this); if (i >= 0) created.animations.splice(i, 1); }
	getBoneAnimator(group) {
		const key = group.name || 'bone';
		return this.animators[key] || (this.animators[key] = new BoneAnimator(key));
	}
}
Animation.selected = null;
Object.defineProperty(Animation, 'all', { get: () => [...openProject.animations, ...created.animations] });

class Texture {
	constructor(data = {}) { Object.assign(this, data); this.uuid = 'tex-' + created.textures.length; }
	fromDataURL(url) { this.url = url; eventLog.push('fill ' + this.uuid); return this; }
	add() { created.textures.push(this); return this; }
}
Object.defineProperty(Texture, 'all', { get: () => [...openProject.textures, ...created.textures] });
Texture.getDefault = () => Texture.all[0];

/** A canvas that remembers its size and what was drawn on it, and where. */
function fakeCanvas() {
	const c = { width: 0, height: 0, draws: [] };
	// blocks of ready pixels are counted: the baked sheets of rebuilt parts arrive that way
	c.puts = 0;
	c.getContext = () => ({
		drawImage(img, ...at) { c.draws.push(at); }, imageSmoothingEnabled: false,
		createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
		putImageData() { c.puts++; },
	});
	c.toDataURL = () => 'data:image/png;base64,AAAA';
	canvasLog.push(c);
	return c;
}


// ------------------------------------------------------- archive contents

// The scenario is swapped between runs: that way one and the same import path
// is checked on PNG and on JPEG. The second case matters more — on Sketchfab textures
// are almost always JPEG, and while the plugin understood only PNG, such archives failed
// with "texture not found" before reaching the geometry.
let scenario = 'png';

// What fills the file map: unpacking an archive or picking the files of a folder.
// For everything below the parser there is no difference — the map is the same.
let importMode = 'zip';

/** A minimal JPEG: the header is enough, there is nobody here to decode it. */
function fakeJPEG(w, h) {
    const be = n => [(n >> 8) & 0xFF, n & 0xFF];
    return Uint8Array.from([
        0xFF, 0xD8,
        0xFF, 0xE0, ...be(16), 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
        0xFF, 0xC0, ...be(17), 8, ...be(h), ...be(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
        0xFF, 0xD9,
    ]);
}

/**
 * A minimal PNG: the signature and IHDR are enough, the size is read from the header.
 * The colour type matters on its own: 6 is RGBA, 2 is RGB without alpha.
 */
function fakePNG(w, h, colorType = 6) {
    const be = n => [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
    return Uint8Array.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        ...be(13), 0x49, 0x48, 0x44, 0x52,
        ...be(w), ...be(h), 8, colorType, 0, 0, 0,
    ]);
}

function zipContents() {
    const gltfPath = 'model(gltf)/source/model.gltf';
    const texPath = 'model(gltf)/textures/gltf_embedded_0.png';
    const files = {};

    // An image no primitive looks at. That is how all three reference models
    // with several textures are built: the file declares one material per
    // image, yet every primitive carries material 0, and the other images
    // end up unreachable. There is no point packing them into the atlas — twelve such
    // images made 512x256 where the whole visible model fits into 32x32.
    if (scenario === 'unused') {
        const gltf = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
        const spare = (gltf.images || []).length;
        gltf.images = [...(gltf.images || []), { uri: 'textures/spare.png' }];
        gltf.textures = [...(gltf.textures || []), { source: spare }];
        gltf.materials = [...(gltf.materials || []),
            { pbrMetallicRoughness: { baseColorTexture: { index: gltf.textures.length - 1 } } }];

        files['source/model.gltf'] = new Uint8Array(Buffer.from(JSON.stringify(gltf), 'utf8'));
        files['textures/gltf_embedded_0.png'] = new Uint8Array(fs.readFileSync(texPath));
        files['textures/spare.png'] = fakePNG(256, 256);
        return files;
    }

    // Objects that name no image at all. In one test model all 533 primitives
    // hang on a material without a baseColorTexture, so nobody reaches an image.
    // Without a rectangle the UV get multiplied by the project texture size — that is,
    // by the whole atlas — and the model arrives in a stretched mix of every image at once.
    if (scenario === 'nomaterial') {
        const gltf = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
        const spare = (gltf.images || []).length;
        gltf.images = [...(gltf.images || []), { uri: 'textures/spare.png' }];
        gltf.textures = [...(gltf.textures || []), { source: spare }];
        gltf.materials = [...(gltf.materials || []),
            { pbrMetallicRoughness: { baseColorTexture: { index: gltf.textures.length - 1 } } }];
        for (const mesh of gltf.meshes || []) {
            for (const prim of mesh.primitives || []) delete prim.material;
        }

        files['source/model.gltf'] = new Uint8Array(Buffer.from(JSON.stringify(gltf), 'utf8'));
        files['textures/gltf_embedded_0.png'] = new Uint8Array(fs.readFileSync(texPath));
        files['textures/spare.png'] = fakePNG(256, 256);
        return files;
    }

    // The material asks for transparency, and the image does not carry it. Nine
    // reference models out of ten are like that: the alpha was lost on download, and the outer
    // shell of the figure turned from transparent to solid. The coordinates are right to the
    // pixel meanwhile — which is why this has to be named out loud rather than fixed by a guess.
    if (scenario === 'noalpha') {
        const gltf = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
        for (const m of gltf.materials || []) m.alphaMode = 'BLEND';
        gltf.images = [{ uri: 'textures/flat.png' }];
        gltf.textures = [{ source: 0 }];
        for (const m of gltf.materials || []) {
            m.pbrMetallicRoughness = { ...(m.pbrMetallicRoughness || {}), baseColorTexture: { index: 0 } };
        }
        files['source/model.gltf'] = new Uint8Array(Buffer.from(JSON.stringify(gltf), 'utf8'));
        files['textures/flat.png'] = fakePNG(128, 128, 2);   // RGB, no alpha
        return files;
    }

    // A face with no texture, the way Blockbench exports it: a primitive of its own
    // on a transparent 1×1 placeholder. Here the first face (two triangles) of every
    // mesh is moved into such a primitive, put first. The image used to be taken
    // from the first primitive for the whole object, so the cube went invisible.
    if (scenario === 'placeholder') {
        const gltf = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
        const blank = (gltf.images || []).length;
        gltf.images = [...(gltf.images || []), { uri: 'textures/blank.png' }];
        gltf.textures = [...(gltf.textures || []), { source: blank }];
        gltf.materials = [...(gltf.materials || []),
            { pbrMetallicRoughness: { baseColorTexture: { index: gltf.textures.length - 1 } }, alphaMode: 'MASK' }];
        const mat = gltf.materials.length - 1;
        // Indices are re-cut into two lists per mesh and appended as a buffer of their own.
        const read = accIndex => {
            const acc = gltf.accessors[accIndex], view = gltf.bufferViews[acc.bufferView];
            const buf = Buffer.from(gltf.buffers[view.buffer].uri.split(',')[1], 'base64');
            const at = (view.byteOffset || 0) + (acc.byteOffset || 0);
            const size = { 5121: 1, 5123: 2, 5125: 4 }[acc.componentType];
            return Array.from({ length: acc.count }, (_, i) =>
                size === 1 ? buf[at + i] : size === 2 ? buf.readUInt16LE(at + i * 2) : buf.readUInt32LE(at + i * 4));
        };
        const lists = [];
        const addIndices = list => {
            lists.push(list);
            gltf.bufferViews.push({ buffer: gltf.buffers.length, byteOffset: 0, byteLength: 0 });
            gltf.accessors.push({ bufferView: gltf.bufferViews.length - 1, componentType: 5125, count: list.length, type: 'SCALAR' });
            return gltf.accessors.length - 1;
        };
        for (const mesh of gltf.meshes || []) {
            const prim = mesh.primitives[0];
            const idx = read(prim.indices);
            mesh.primitives = [
                { ...prim, indices: addIndices(idx.slice(0, 6)), material: mat },
                { ...prim, indices: addIndices(idx.slice(6)) },
            ];
        }
        const chunks = [];
        let offset = 0;
        lists.forEach((list, i) => {
            const b = Buffer.alloc(list.length * 4);
            list.forEach((v, k) => b.writeUInt32LE(v, k * 4));
            const view = gltf.bufferViews[gltf.bufferViews.length - lists.length + i];
            view.byteOffset = offset;
            view.byteLength = b.length;
            offset += b.length;
            chunks.push(b);
        });
        const extra = Buffer.concat(chunks);
        gltf.buffers.push({ byteLength: extra.length, uri: 'data:application/octet-stream;base64,' + extra.toString('base64') });

        files['source/model.gltf'] = new Uint8Array(Buffer.from(JSON.stringify(gltf), 'utf8'));
        files['textures/gltf_embedded_0.png'] = new Uint8Array(fs.readFileSync(texPath));
        // Blockbench's placeholder byte for byte: one pixel, (0, 0, 0, 0).
        files['textures/blank.png'] = new Uint8Array(Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001'
            + '08060000001f15c4890000000b494441541857636000020000050001aad5c8510000000049454e44ae426082', 'hex'));
        return files;
    }

    // A part that is not a box: a prism of twelve sides standing beside the model.
    // It goes the whole way the rebuild goes — decoding the picture, the plates,
    // their sheets in the atlas, the progress window, the cubes and the report.
    if (scenario === 'rounded') {
        const gltf = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
        // the picture the model reads: embedded in the file, not the loose one beside it
        const img0 = gltf.images[0];
        const tex = lib.decodePNG(new Uint8Array(img0.uri && img0.uri.startsWith('data:')
            ? Buffer.from(img0.uri.slice(img0.uri.indexOf(',') + 1), 'base64')
            : fs.readFileSync(texPath)));
        // a pixel of the picture that shows, so the plates have something to wear
        let at = 0;
        while (at < tex.w * tex.h && tex.data[at * 4 + 3] < 255) at++;
        const uv = [((at % tex.w) + 0.5) / tex.w, (Math.floor(at / tex.w) + 0.5) / tex.h];
        const n = 12, r = 0.25, h = 0.5;
        const ring = y => Array.from({ length: n }, (_, i) => [r * Math.cos(2 * Math.PI * i / n), y, r * Math.sin(2 * Math.PI * i / n)]);
        const pos = [...ring(0), ...ring(h)];
        const idx = [];
        for (let i = 0; i < n; i++) { const j = (i + 1) % n; idx.push(i, j, n + j, i, n + j, n + i); }
        for (let i = 1; i + 1 < n; i++) idx.push(0, i + 1, i, n, n + i, n + i + 1);
        // turned to face outward, as an exporter writes it: inward on this
        // one-sided material it would read as an outline shell and be left out
        for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
        const P = Buffer.alloc(pos.length * 12), T = Buffer.alloc(pos.length * 8), I = Buffer.alloc(idx.length * 4);
        pos.forEach((p, k) => { p.forEach((v, c) => P.writeFloatLE(v, k * 12 + c * 4)); T.writeFloatLE(uv[0], k * 8); T.writeFloatLE(uv[1], k * 8 + 4); });
        idx.forEach((v, k) => I.writeUInt32LE(v, k * 4));
        const b = gltf.buffers.length, v0 = gltf.bufferViews.length, a0 = gltf.accessors.length;
        gltf.buffers.push({ byteLength: P.length + T.length + I.length, uri: 'data:application/octet-stream;base64,' + Buffer.concat([P, T, I]).toString('base64') });
        gltf.bufferViews.push({ buffer: b, byteOffset: 0, byteLength: P.length }, { buffer: b, byteOffset: P.length, byteLength: T.length },
            { buffer: b, byteOffset: P.length + T.length, byteLength: I.length });
        gltf.accessors.push(
            { bufferView: v0, componentType: 5126, count: pos.length, type: 'VEC3', min: [-r, 0, -r], max: [r, h, r] },
            { bufferView: v0 + 1, componentType: 5126, count: pos.length, type: 'VEC2' },
            { bufferView: v0 + 2, componentType: 5125, count: idx.length, type: 'SCALAR' });
        gltf.meshes.push({ primitives: [{ mode: 4, attributes: { POSITION: a0, TEXCOORD_0: a0 + 1 }, indices: a0 + 2, material: 0 }] });
        gltf.nodes.push({ name: 'column', mesh: gltf.meshes.length - 1, translation: [2, 0, 0] });
        const root = gltf.nodes[gltf.scenes[gltf.scene || 0].nodes[0]];
        root.children = [...(root.children || []), gltf.nodes.length - 1];
        files['source/model.gltf'] = new Uint8Array(Buffer.from(JSON.stringify(gltf), 'utf8'));
        files['textures/gltf_embedded_0.png'] = new Uint8Array(fs.readFileSync(texPath));
        return files;
    }

    if (scenario === 'png') {
        files['source/model.gltf'] = new Uint8Array(fs.readFileSync(gltfPath));
        files['textures/gltf_embedded_0.png'] = new Uint8Array(fs.readFileSync(texPath));
        return files;
    }

    // A JPEG under a .png name plus an unreadable image as the FIRST index. The order
    // is chosen on purpose: objects refer to an image by its glTF index, and the
    // unreadable one drops out of the atlas — if the indices are not renumbered, every
    // object gets someone else's piece of texture, silently.
    const gltf = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
    gltf.images = [{ uri: 'textures/broken.tga' }, ...(gltf.images || [])];
    for (const t of gltf.textures || []) if (t.source !== undefined) t.source += 1;

    files['source/model.gltf'] = new Uint8Array(Buffer.from(JSON.stringify(gltf), 'utf8'));
    files['textures/gltf_embedded_0.png'] = fakeJPEG(128, 128);
    files['textures/broken.tga'] = new Uint8Array(64).fill(7);
    return files;
}


// A pseudo-DOM for the report window: checks that the "Save log" and
// "Copy" buttons are found by their classes and the handlers get attached.
const foundSelectors = [];
function fakeDialogRoot(html) {
	return {
		querySelector(sel) {
			foundSelectors.push(sel);
			if (html.indexOf(sel.replace('.', '')) < 0) return null;
			return { addEventListener() { }, textContent: '' };
		},
	};
}

const sandboxActions = [];
const menuPlacement = {};
let lastDialog = null;
// Every form dialog shown, by id: the CPM dialog's questions are checked below.
const formsShown = {};
// Fields the import dialog is confirmed with instead of its defaults.
let formOverride = {};
const projectsMade = [];
// Blockbench 5's Java format: its rotation limits follow the project's version,
// and on 1.21.11 and above there are none.
const javaFormat = { id: 'java_block' };
for (const [key, from] of [['rotation_limit', '1.21.11'], ['rotation_snap', '1.21.6']]) {
	Object.defineProperty(javaFormat, key, {
		get: () => {
			const v = String(sandbox.Project.java_block_version || '1.9.0').split('.').map(Number);
			const w = from.split('.').map(Number);
			for (let i = 0; i < 3; i++) if ((v[i] || 0) !== (w[i] || 0)) return (v[i] || 0) < (w[i] || 0);
			return false;
		},
	});
}
const ALL_FORMATS = {
	geckolib_model: { id: 'geckolib_model' },
	bedrock: { id: 'bedrock' },
	free: { id: 'free' },
	java_block: javaFormat,
};
let zipWritten = null;
let exported = null;

const sandbox = {
	console, JSON, Math, Object, Array, String, Number, Boolean, Error, isFinite, parseInt, parseFloat,
	Set, Map, Promise, TextDecoder, Uint8Array, DataView, ArrayBuffer, Buffer,
	btoa: s => Buffer.from(s, 'binary').toString('base64'),
	atob: s => Buffer.from(s, 'base64').toString('binary'),
	THREE, Cube, Group, Animation, Texture,
	Mesh: { all: [] },
	Canvas: { updateAll() { }, updateUV() { }, updateAllBones() { }, updateView() { } },
	Project: { box_uv: true, texture_width: 16, texture_height: 16 },
	Formats: ALL_FORMATS,
	// Records which format each import built into. A Java project starts on the
	// 1.21.6 format, as it does when the user's settings target that Minecraft:
	// too old for cubes turned on several axes, so the import has to raise it.
	newProject(format) {
		projectsMade.push(format.id);
		sandbox.Format = format;
		if (format.id === 'java_block') sandbox.Project.java_block_version = '1.21.6';
		else delete sandbox.Project.java_block_version;
		return true;
	},
	Undo: {
		initEdit(aspects) { undoLog.push({ kind: 'init', aspects }); },
		finishEdit(message, aspects) { undoLog.push({ kind: 'finish', message, aspects }); eventLog.push('finish'); },
	},
	Outliner: { get elements() { return [...openProject.elements, ...created.cubes]; }, selected: [] },
	Timeline: { setTime() { } },
	Animator: { preview() { } },
	Modes: { options: { edit: { select() { } } } },
	ModelFormat: class { constructor(d) { Object.assign(this, d); } delete() { } },
	Plugin: { register(id, opts) { sandbox.__plugin = opts; } },
	Action: class {
		constructor(id, opts) { Object.assign(this, opts); this.id = id; sandboxActions.push(this); }
		delete() { }
	},
	// Records where the plugin puts its entries: the catalog maintainer asked to
	// move them from the bottom of the File menu into File > Import, and undoing that must be caught.
	MenuBar: { addAction(action, where) { menuPlacement[action.id] = where; } },
	Dialog: class {
		constructor(opts) { Object.assign(this, opts); }
		show() {
			// The report window has no form: it has ready-made markup in lines.
			// That has to be checked too — it is where the import report moved.
			if (this.lines && this.lines.length) {
				reportShown = this.lines.join(String.fromCharCode(10));
				this.object = fakeDialogRoot(reportShown);
				lastDialog = this;
				return;
			}
			// confirm at once with the default values
			const form = {};
			for (const [k, v] of Object.entries(this.form || {})) {
				if (v.type === 'checkbox') form[k] = v.value;
				else if (v.type === 'select') form[k] = v.default;
				else if (v.type === 'number') form[k] = v.value;
			}
			if (this.form) Object.assign(form, formOverride);
			if (this.form) formsShown[this.id] = this.form;
			this.onConfirm(form);
		}
		hide() { }
	},
	Blockbench: {
		version: 'smoke',
		showMessageBox(o) { reportShown = o.message; },
		showQuickMessage() { },
		addCSS: () => ({ delete() { } }),
		on() { }, removeListener() { },
		// Picking files: either one archive or a set of files from an unpacked folder.
		// The second case is a separate branch in the plugin, and without it the branch would reach
		// the user unchecked. The names are deliberately without paths: that is how the file
		// picker hands them over, and that is what the glTF refers to from inside.
		import(opts, cb) {
			if (importMode === 'files') {
				cb(Object.entries(zipContents()).map(([name, bytes]) => ({
					name: name.replace(/^.*[/\\]/, ''),
					content: bytes,
				})));
				return;
			}
			cb([{ name: 'model(gltf).zip', content: new Uint8Array(1) }]);
		},
		export(opts) { exported = opts; },
	},
	// A class, not an object: the CPM export assembles an archive through `new JSZip()`,
	// and the import unpacks through the static loadAsync.
	JSZip: class {
		constructor() { this.files = {}; }
		file(name, data) { this.files[name] = data; }
		generateAsync() {
			zipWritten = this.files;
			return Promise.resolve(new ArrayBuffer(8));
		}
		static loadAsync() {
			// real unpacking is not tested — files from disk are slipped in
			return Promise.resolve({
				forEach(cb) {
					for (const [name, bytes] of Object.entries(zipContents())) {
						cb(name, { dir: false, internalStream() {
							const handlers = {};
							return { on(event, fn) { handlers[event] = fn; return this; }, pause() {},
								resume() { handlers.data(bytes); handlers.end(); return this; } };
						} });
					}
				},
			});
		}
	},
	document: {
		querySelector: () => null,
		createElement: (tag) => tag === 'canvas'
			? fakeCanvas()
			: { style: {}, classList: { add() { } }, addEventListener() { } },
	},
	Image: class { set src(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 0); } },
	localStorage: { _v: {}, getItem(k) { return this._v[k] || null; }, setItem(k, v) { this._v[k] = v; } },
	fetch: () => Promise.reject(new Error('network is disabled in the test')),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

// ------------------------------------------------------------------- run

const src = fs.readFileSync(path.join('plugin', 'gltf_to_minecraft.js'), 'utf8');
vm.createContext(sandbox);

let failed = false;
try {
	new vm.Script(src, { filename: 'gltf_to_minecraft.js' }).runInContext(sandbox);
} catch (e) {
	console.log(`\n❌ The plugin crashed on load: ${e.message}\n${e.stack.split('\n').slice(1, 3).join('\n')}`);
	process.exit(1);
}

const plugin = sandbox.__plugin;
if (!plugin) { console.log('\n❌ Plugin.register was not called\n'); process.exit(1); }

try {
	plugin.onload();
} catch (e) {
	console.log(`\n❌ onload crashed: ${e.message}\n${e.stack.split('\n').slice(1, 3).join('\n')}`);
	process.exit(1);
}

console.log('');
console.log('=== PLUGIN SMOKE TEST ===');
console.log('');
console.log('The plugin loaded and onload ran: OK');
console.log(`Actions registered: ${sandboxActions.length}`);

// The import is run through the created action: the dialog confirms itself,
// JSZip hands over files from disk. That way the whole path is checked end to end.
const importAction = sandboxActions.find(a => a.id.endsWith('_import'));
if (!importAction) { console.log('ERROR: import action not found'); process.exit(1); }

// All three entries — import, CPM and the Sketchfab search — must sit in File > Import.
// In the bare File menu they fell to its very bottom, and the catalog maintainer asked
// to move them from there.
{
    const want = ['_import', '_cpm', '_sketchfab'];
    const misplaced = want.filter(suffix => {
        const a = sandboxActions.find(x => x.id.endsWith(suffix));
        return !a || menuPlacement[a.id] !== 'file.import';
    });
    if (misplaced.length) {
        failed = true;
        console.log('❌ not in File > Import: ' + misplaced.join(', ')
            + ' (' + misplaced.map(s => {
                const a = sandboxActions.find(x => x.id.endsWith(s));
                return a ? menuPlacement[a.id] : 'no action';
            }).join(', ') + ')');
    } else {
        console.log('All three entries sit in File > Import: OK');
    }
}

/** One full import run: the dialog confirms itself, JSZip hands over the fixture. */
async function runImport(label) {
    created.cubes.length = 0;
    created.groups.length = 0;
    created.animations.length = 0;
    created.textures.length = 0;
    problems.length = 0;
    reportShown = null;

    console.log('');
    console.log('--- ' + label);
    try {
        importAction.click();
    } catch (e) {
        console.log('ERROR during import: ' + e.message);
        console.log(String(e.stack).split(String.fromCharCode(10)).slice(1, 4).join(' | '));
        process.exit(1);
    }
    await new Promise(r => setTimeout(r, 300));

    let bad = false;
    if (created.cubes.length) {
        const kf = created.animations.reduce((s, a) =>
            s + Object.values(a.animators).reduce((n, an) => n + an.rotation.length + an.position.length, 0), 0);
        console.log(`Cubes ${created.cubes.length}, bones ${created.groups.length}, `
            + `animations ${created.animations.length}, keyframes ${kf}`);
    } else {
        bad = true;
        console.log('❌ not a single cube was created');
    }
    if (problems.length) {
        bad = true;
        console.log(`❌ Problems (${problems.length}):`);
        for (const p of problems.slice(0, 5)) console.log('  ' + p);
    }
    // This check used to look for Russian words, and went dead the day the plugin's
    // report was translated to English: it could never match again. The report
    // always says "failed: 0" on a healthy run, so only a non-zero count counts.
    if (reportShown && /Animations transferred: \d+, failed: [1-9]|not transferred:/.test(reportShown)) {
        bad = true;
        console.log('❌ The report says something failed:' + String.fromCharCode(10) + reportShown.slice(0, 400));
    }
    return bad;
}

const baseline = created.cubes.length;
failed = await runImport('archive with PNG') || failed;
const cubesPNG = created.cubes.length;
// What every face of the plain import reads, and the texture size: the placeholder
// scenario below has to land on exactly the same.
const faceUV = () => created.cubes.map(c => JSON.stringify({
    solid: (c.to || []).every((v, k) => Math.abs(v - c.from[k]) >= 0.01),
    faces: Object.entries(c.faces).map(([k, f]) => [k, f.uv, !!f.texture]),
}));
const facesPNG = faceUV();
// The same, as numbers, with where the cubes stand: a model added to an open
// project must read the same pixels, moved or scaled only as its texture was.
const FACE_KEYS = ['north', 'south', 'east', 'west', 'up', 'down'];
const uvsPNG = created.cubes.map(c => FACE_KEYS.map(f => c.faces[f].uv && c.faces[f].uv.slice()));
const solidPNG = created.cubes.map(c => c.to.every((v, k) => Math.abs(v - c.from[k]) >= 0.01));
const centreOf = cubes => [0, 1, 2].map(a => cubes.reduce((s, c) => s + (c.from[a] + c.to[a]) / 2, 0) / cubes.length);
const centrePNG = centreOf(created.cubes);
const atlasPNG = [sandbox.Project.texture_width, sandbox.Project.texture_height];
const texturePNG = [sandbox.Project.texture_width, sandbox.Project.texture_height].join('×');
void baseline;

scenario = 'jpeg';
failed = await runImport('archive with JPEG + an unreadable image') || failed;

if (created.cubes.length !== cubesPNG) {
    failed = true;
    console.log(`❌ JPEG gave ${created.cubes.length} cubes instead of ${cubesPNG}`);
}
// The report window buttons must be found by their classes: if the markup and
// the handlers drift apart, "Save log" will silently stop working.
// An inflated flat cube must not show its side faces: before inflation their
// area was zero, and after it they show through as a strip of stretched pixel.
const AXIS_FACES = [['east', 'west'], ['up', 'down'], ['north', 'south']];
let flatWithSides = 0, flatInflated = 0;
for (const c of created.cubes) {
	if (!c.inflate || !c.from || !c.to) continue;
	if ([0, 1, 2].some(i => Math.abs(c.to[i] - c.from[i]) < 0.01)) flatInflated++;
	for (let i = 0; i < 3; i++) {
		if (Math.abs(c.to[i] - c.from[i]) >= 0.01) continue;
		for (let j = 0; j < 3; j++) {
			if (j === i) continue;
			for (const f of AXIS_FACES[j]) {
				if (c.faces[f] && c.faces[f].texture) flatWithSides++;
			}
		}
	}
}
if (flatWithSides) {
	failed = true;
	console.log('❌ inflated flat cubes kept their side faces: ' + flatWithSides);
} else if (!flatInflated) {
	// A check with nothing to check stays as quiet as working code.
	console.log('⚠ no inflated flat cubes in the fixture — the outline check ran idle');
} else {
	console.log(`Flat cubes got no side faces when inflated: OK (checked ${flatInflated})`);
}

for (const sel of ['.mtc_rep_save', '.mtc_rep_copy']) {
	if (!foundSelectors.includes(sel)) {
		failed = true;
		console.log('❌ no handler attached to ' + sel);
	}
}
if (reportShown && reportShown.indexOf('mtc_rep_log') < 0) {
	failed = true;
	console.log('❌ the report window has no scrollable log block');
}

if (!reportShown || reportShown.indexOf('Images skipped: 1') < 0) {
    failed = true;
    console.log('❌ the report has no line about the skipped image (Images skipped)');
} else {
    console.log('Unreadable image noted in the report, image indices renumbered: OK');
}

// --- an image the geometry does not reach.
//
// What is checked is not the atlas size as such, but that no atlas was needed at all:
// the single reachable image goes the direct path, as with one texture in the
// archive. And that the report says so — a model that arrives wearing one texture
// everywhere is otherwise left unexplained.
scenario = 'unused';
failed = await runImport('archive with an image nobody refers to') || failed;

if (created.cubes.length !== cubesPNG) {
    failed = true;
    console.log(`❌ the extra image changed the parse: ${created.cubes.length} cubes instead of ${cubesPNG}`);
}
const atlasNamed = created.textures.filter(t => t.name === 'atlas.png').length;
if (atlasNamed) {
    failed = true;
    console.log('❌ the unreachable image got into the atlas after all');
} else {
    console.log('The unreachable image stayed out of the atlas: OK');
}
if (!reportShown || reportShown.indexOf('Colour textures no mesh references: 1') < 0) {
    failed = true;
    console.log('❌ the report has no line about the image nobody refers to');
} else {
    console.log('The report names the image nobody refers to: OK');
}
// Every part on one texture while another lies unused is a file that lost its
// material links, and that is said up front, in the report's warning box.
if (!reportShown || !/class="mtc_rep_warn">Every part of this file points at one texture/.test(reportShown)) {
    failed = true;
    console.log('❌ the report does not warn that the file lost its material links');
} else {
    console.log('The report warns that the file lost its material links: OK');
}

// --- objects that name no image at all: the UV must not spread across the atlas.
//
// The atlas here is built from two images: 256x256 goes first, our fixture's
// 128x128 after it, at (256,0). So every UV must lie inside that
// rectangle. Without the rectangle they would stretch across the full width of 512.
scenario = 'nomaterial';
failed = await runImport('archive where objects name no image') || failed;

// The calibration probe cube does not count here: calibrateFaceDirs puts one and the same
// asymmetric rectangle [0,0,4,8] on each of its faces and measures where
// it landed. It has nothing to do with the model and lives in its own coordinates.
const PROBE_UV = '[0,0,4,8]';
let uvMin = Infinity, uvMax = -Infinity, uvCount = 0;
for (const c of created.cubes) {
    for (const f of Object.values(c.faces || {})) {
        if (!f || !f.uv || f.uv.every(v => v === 0)) continue;
        if (JSON.stringify(f.uv) === PROBE_UV) continue;
        uvCount++;
        uvMin = Math.min(uvMin, f.uv[0], f.uv[2]);
        uvMax = Math.max(uvMax, f.uv[0], f.uv[2]);
    }
}
if (!uvCount) {
    failed = true;
    console.log('❌ nothing to check: not a single face with UV');
} else if (uvMax > 384.5 || uvMin < 255.5) {
    failed = true;
    console.log(`❌ UV of objects without a material spread across the atlas: ${uvMin.toFixed(1)}..${uvMax.toFixed(1)}`
        + ' instead of 256..384');
} else {
    console.log(`UV of objects without a material landed in the main image's rectangle: OK `
        + `(${uvMin.toFixed(1)}..${uvMax.toFixed(1)} of 256..384)`);
}

// --- the same model, but as files of an unpacked folder rather than an archive.
//
// This checks an entry point that did not exist before: names come without paths, and the .bin and
// images must be found by the bare file name. The result must match the
// archive one down to the cube — otherwise the way in changes something, and it must not.
scenario = 'png';
importMode = 'files';
failed = await runImport('files of an unpacked folder, no archive') || failed;

if (created.cubes.length !== cubesPNG) {
    failed = true;
    console.log(`❌ the folder gave ${created.cubes.length} cubes instead of ${cubesPNG}`);
} else {
    console.log(`The folder gave the same result as the archive: OK (${cubesPNG} cubes)`);
}

// And once more, on a model that refers to its image through a subfolder
// (`textures/…`), while the file picker hands over a bare name. This is where
// the lookup by the last path segment works; without it the image is simply not found.
scenario = 'jpeg';
failed = await runImport('folder files, where glTF refers through textures/') || failed;

if (created.cubes.length !== cubesPNG) {
    failed = true;
    console.log(`❌ the folder gave ${created.cubes.length} cubes instead of ${cubesPNG}`);
} else if (reportShown && reportShown.indexOf('not found in the archive') >= 0) {
    failed = true;
    console.log('❌ the image was not found by its bare name, without the subfolder');
} else {
    console.log('Images found by file name, without the path: OK');
}
importMode = 'zip';

// --- a texture without alpha where the material asks for it.
scenario = 'noalpha';
failed = await runImport('the material asks for transparency, the texture does not carry it') || failed;

if (!reportShown || reportShown.indexOf('has no alpha channel') < 0) {
    failed = true;
    console.log('❌ the report has no line about the lost alpha');
} else {
    console.log('The report names the lost alpha: OK');
}

// --- faces with no texture, on a placeholder, put first in every mesh.
scenario = 'placeholder';
failed = await runImport('every mesh starts with an untextured face') || failed;
{
    const bad = [];
    // Every face that still has a texture reads a piece the plain import read too,
    // and each cube loses at most the one face moved onto the placeholder. Compared
    // as sets of rectangles per cube, not by face name: with a face missing, the
    // box solver may pick another of the equal orientations, which renames faces
    // and mirrors rectangles while laying the same picture on the same geometry.
    //
    // Only solid cubes are held to that. A 0.001 px panel has four sides of no
    // area whose UV are lines, and with one of its two big faces gone the solver
    // lays those lines differently; they cover nothing either way. For panels it
    // is enough that nothing reads outside the texture.
    const rects = faces => faces.filter(([, uv, textured]) => textured && uv)
        .map(([, uv]) => [Math.min(uv[0], uv[2]), Math.min(uv[1], uv[3]), Math.max(uv[0], uv[2]), Math.max(uv[1], uv[3])]
            .map(v => +v.toFixed(3)).join(',')).sort();
    const nowAll = faceUV().map(f => JSON.parse(f));
    const wasAll = facesPNG.map(f => JSON.parse(f));
    const [tw, th] = [sandbox.Project.texture_width, sandbox.Project.texture_height];
    let foreign = 0, extraHidden = 0, outside = 0;
    if (nowAll.length !== wasAll.length) bad.push(`${nowAll.length} cubes instead of ${wasAll.length}`);
    else nowAll.forEach((cube, i) => {
        const list = rects(cube.faces);
        outside += list.filter(r => r.split(',').map(Number).some((v, k) => v < -1e-6 || v > (k % 2 ? th : tw) + 1e-6)).length;
        if (!cube.solid || !wasAll[i].solid) return;
        const left = rects(wasAll[i].faces);
        for (const r of list) {
            const at = left.indexOf(r);
            if (at < 0) foreign++; else left.splice(at, 1);
        }
        if (left.length > 1) extraHidden++;
    });
    if (outside) bad.push(`${outside} faces read outside the texture`);
    if (foreign) bad.push(`${foreign} faces of solid cubes read a piece of texture the plain import never used`);
    if (extraHidden) bad.push(`${extraHidden} solid cubes lost more than the one untextured face`);
    const size = [sandbox.Project.texture_width, sandbox.Project.texture_height].join('×');
    if (size !== texturePNG) bad.push(`the texture changed from ${texturePNG} to ${size}: the placeholder decided the atlas`);
    if (!/Faces with no texture: \d+ kept hidden/.test(reportShown || '')) bad.push('the report does not mention the hidden faces');
    if (bad.length) { failed = true; console.log('❌ ' + bad.join('; ')); }
    else console.log(`Solid cubes read the same texture as without the placeholder, nothing reads outside it, texture ${size}: OK`);
}

// --- a part that is not a box, rebuilt from plates.
scenario = 'rounded';
failed = await runImport('a prism of twelve sides beside the model') || failed;
// the rebuild waits on its window and gives way to the interface: let it finish
for (let i = 0; i < 100 && !/Rebuilt, /.test(reportShown || ''); i++) await new Promise(r => setTimeout(r, 100));
{
    const bad = [];
    const report = reportShown || '';
    const line = /Rebuilt, fast: (\d+) parts → (\d+) plates/.exec(report);
    if (!line) bad.push('the report says nothing about the rebuild');
    else if (line[1] !== '1' || Number(line[2]) !== 14) bad.push(`rebuilt ${line[1]} parts into ${line[2]} plates, not 1 into 14`);
    if (!/rebuilt from plates/.test(report)) bad.push('the not-a-box line does not say they were rebuilt');
    if (!/need cutout transparency/.test(report)) bad.push('the report does not say the plates need cutout transparency');
    // plates: flat, two sides showing, the four others hidden
    const flat = created.cubes.filter(c => c.to.some((v, k) => Math.abs(v - c.from[k]) < 1e-9) && /^column/.test(c.name || ''));
    if (flat.length !== 14) bad.push(`${flat.length} flat cubes named after the part, not 14`);
    const twoSided = flat.filter(c => Object.values(c.faces).filter(f => f.texture).length === 2).length;
    if (twoSided !== flat.length) bad.push(`${flat.length - twoSided} plates do not show exactly their two sides`);
    const [tw, th] = [sandbox.Project.texture_width, sandbox.Project.texture_height];
    const outside = created.cubes.reduce((n, c) => n + Object.values(c.faces)
        .filter(f => f.texture && f.uv && f.uv.some((v, k) => v < -1e-6 || v > (k % 2 ? th : tw) + 1e-6)).length, 0);
    if (outside) bad.push(`${outside} faces read outside the texture`);
    if (tw * th <= atlasPNG[0] * atlasPNG[1]) bad.push(`the texture did not grow for the sheets: ${tw}×${th}`);
    if (bad.length) { failed = true; console.log('❌ ' + bad.join('; ')); }
    else console.log(`The prism came back as 14 plates, two-sided, their sheets in a ${tw}×${th} texture: OK`);
}
scenario = 'png';

// --- the other formats. The conversion is the same; what differs is the project
// it lands in, and for Java the box, the format version and the animations.
scenario = 'png';
for (const target of ['bedrock', 'free', 'java_block']) {
    formOverride = { target };
    failed = await runImport('built into ' + target) || failed;
    const made = projectsMade[projectsMade.length - 1];
    const bad = [];
    if (made !== target) bad.push(`the project was built as ${made}`);
    if (!reportShown || reportShown.indexOf('Built into: ') < 0) bad.push('the report does not name the format');
    if (target === 'bedrock' && !sandbox.Project.model_identifier) bad.push('no geometry identifier, so Bedrock would export geometry.unknown');
    if (target !== 'java_block' && !created.animations.length) bad.push('the animations were lost');
    if (target === 'java_block') {
        if (created.animations.length) bad.push(`${created.animations.length} animations in a Java model`);
        if (!/Animations left out: \d+/.test(reportShown || '')) bad.push('the report does not say the animations were left out');
        // The box Blockbench's Java format enforces, inflate included.
        const outside = created.cubes.filter(c => [0, 1, 2].some(a =>
            Math.min(c.from[a], c.to[a]) - (c.inflate || 0) < -16 - 1e-9
            || Math.max(c.from[a], c.to[a]) + (c.inflate || 0) > 32 + 1e-9));
        if (outside.length) bad.push(`${outside.length} cubes outside the −16…32 box`);
        // Cubes turned on several axes or past 45° need the 1.21.11 format.
        const free = created.cubes.filter(c => {
            const turned = (c.rotation || []).filter(v => Math.abs(v) > 1e-6);
            return turned.length > 1 || turned.some(v => Math.abs(v) > 45);
        }).length;
        const version = sandbox.Project.java_block_version;
        if (free && version !== '1.21.11') bad.push(`${free} freely turned cubes, but the format stayed at ${version}`);
        console.log(`Java: ${free} freely turned cubes, format ${version}`);
    }
    if (bad.length) { failed = true; console.log(`❌ ${target}: ${bad.join('; ')}`); }
    else console.log(`Built into ${target}: OK`);
}
formOverride = {};

// --- adding to the open project. The same model goes into a project that
// already has folders, a texture and animations of its own, and has to leave
// them as they were: names kept apart, the old texture in its corner, the UV of
// the cubes already there reading the same pixels, and one step to undo it all.
console.log('');
console.log('=== adding to the open project');
{
	const savedProject = sandbox.Project;
	const savedFormat = sandbox.Format;
	const FLAGS = {
		geckolib_model: { single_texture: true },
		bedrock: { single_texture: true },
		free: { per_texture_uv_size: true },
		java_block: {},
		skin: { single_texture: true },
	};
	// the fixture archive is model(gltf).zip
	const slug = 'model_gltf';
	const DIALOG = 'gltf_to_minecraft_import_dialog';

	/** Opens a project in `format` holding what is listed. */
	const open = ({ format, uv, texture = null, cubes = 1, folders = [], animations = [], selected = null, extra = {} }) => {
		sandbox.Format = Object.assign(Object.create(ALL_FORMATS[format] || { id: format }), FLAGS[format]);
		sandbox.Project = { box_uv: true, texture_width: uv[0], texture_height: uv[1], name: 'hero', ...extra };
		openProject.groups = folders.map(([name, origin]) => new Group({ name, origin }));
		// painted at twice the UV size, as a 64×64 model on a 128×128 texture is
		openProject.textures = texture
			? [Object.assign(new Texture({ name: 'hero.png' }), { uuid: 'old', width: uv[0] * 2, height: uv[1] * 2, img: {}, path: 'hero.png' }, texture)]
			: [];
		openProject.elements = Array.from({ length: cubes }, () => ({ name: 'existing' }));
		openProject.animations = animations.map(name => ({ name, animators: {} }));
		Group.first_selected = selected ? openProject.groups.find(g => g.name === selected) : null;
		undoLog.length = 0;
		eventLog.length = 0;
		canvasLog.length = 0;
	};

	/**
	 * Whether these cubes read what the plain import read, carried to where the
	 * plan puts the atlas; null when they do. Compared as sets of rectangles per
	 * solid cube, as in the placeholder case: a model moved elsewhere can tip the
	 * box solver to another of the equal orientations, which renames faces while
	 * laying the same picture on the same box. A 0.001 px panel only has to read
	 * inside the atlas.
	 */
	const uvCheck = plan => {
		if (created.cubes.length !== uvsPNG.length) return `${created.cubes.length} cubes instead of ${uvsPNG.length}`;
		const key = uv => [Math.min(uv[0], uv[2]), Math.min(uv[1], uv[3]), Math.max(uv[0], uv[2]), Math.max(uv[1], uv[3])]
			.map(v => v.toFixed(3)).join(',');
		const moved = uv => uv.map((v, j) => plan.offset[j % 2] + v * plan.scale[j % 2]);
		const lo = plan.offset, hi = [0, 1].map(a => plan.offset[a] + atlasPNG[a] * plan.scale[a]);
		let differ = 0, outside = 0;
		created.cubes.forEach((c, i) => {
			const now = FACE_KEYS.map(f => c.faces[f].uv).filter(Boolean);
			outside += now.filter(uv => uv.some((v, j) => v < lo[j % 2] - 1e-6 || v > hi[j % 2] + 1e-6)).length;
			if (!solidPNG[i]) return;
			const was = uvsPNG[i].filter(Boolean).map(uv => key(moved(uv)));
			for (const k of now.map(key)) {
				const at = was.indexOf(k);
				if (at < 0) differ++; else was.splice(at, 1);
			}
			differ += was.length;
		});
		return differ || outside ? `${differ} rectangles of solid cubes differ, ${outside} read outside the atlas` : null;
	};
	const size = () => [sandbox.Project.texture_width, sandbox.Project.texture_height].join('×');
	const mine = () => new Set(created.groups);
	// the added folders hang from exactly one of them, which sits in `where`
	const topOf = () => created.groups.filter(g => !mine().has(g.parent));
	// The texture is drawn after the build, and a long build can outlast the
	// wait in runImport: what was queued behind it has to run before looking.
	const settle = () => new Promise(r => setTimeout(r, 100));
	const verdict = (label, bad) => {
		if (bad.length) { failed = true; console.log(`❌ ${label}: ${bad.join('; ')}`); }
		else console.log(`${label}: OK`);
	};

	// GeckoLib, one texture: the atlas goes beside the project's, into a folder.
	{
		const made = projectsMade.length;
		open({
			format: 'geckolib_model', uv: [64, 64], texture: {}, selected: 'arm',
			folders: [['arm', [5, 22, 0]], ['Head', [0, 24, 0]], ['bone', [0, 0, 0]]],
			animations: [`${slug}.post`],
		});
		formOverride = { add_to_open: true, add_animations: true };
		failed = await runImport('added to a GeckoLib project, into the folder “arm”') || failed;
		await settle();
		await settle();
		const bad = [];
		const form = formsShown[DIALOG] || {};
		if (!form.add_to_open) bad.push('the dialog does not offer it');
		if (!String((form.about_open || {}).text).includes('“arm”')) bad.push('the dialog does not name the folder');
		if (projectsMade.length !== made) bad.push('a new project was made');

		const plan = lib.texturePlan('beside', [64, 64], atlasPNG);
		if (size() !== plan.uvSize.join('×')) bad.push(`UV size ${size()}, not ${plan.uvSize.join('×')}`);
		if (created.textures.length) bad.push(`${created.textures.length} new textures in a one-texture format`);
		const old = openProject.textures[0];
		if (!old.url) bad.push('the project texture was not redrawn');
		const sheet = canvasLog.find(c => c.width === plan.uvSize[0] * 2 && c.height === plan.uvSize[1] * 2);
		if (!sheet) {
			bad.push(`no sheet at the texture's double resolution (canvases: ${canvasLog.map(c => c.width + '×' + c.height).join(', ')})`);
		} else {
			const want = [plan.offset[0] * 2, plan.offset[1] * 2, atlasPNG[0] * 2, atlasPNG[1] * 2].join();
			if (String(sheet.draws[0]) !== '0,0,128,128') bad.push(`the old texture drawn at ${sheet.draws[0]}`);
			if (String(sheet.draws[1]) !== want) bad.push(`the atlas drawn at ${sheet.draws[1]}, not ${want}`);
		}
		const uvBad = uvCheck(plan);
		if (uvBad) bad.push(`UV are not the plain import's moved by [${plan.offset}]: ${uvBad}`);
		const shift = centreOf(created.cubes).map((v, a) => v - centrePNG[a]);
		if (shift.some((v, a) => Math.abs(v - [5, 22, 0][a]) > 1e-3)) bad.push(`moved by [${shift.map(v => +v.toFixed(3))}], not onto the pivot [5, 22, 0]`);

		const names = Group.all.map(g => g.name);
		const twice = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
		if (twice.length) bad.push('folder names repeat: ' + twice.join(', '));
		const arm = openProject.groups[0];
		const top = topOf();
		if (top.length !== 1 || top[0].parent !== arm) bad.push(`${top.length} added folders at the top, ${top.filter(g => g.parent === arm).length} of them in “arm”`);
		const loose = created.cubes.filter(c => !mine().has(c.parent)).length;
		if (loose) bad.push(`${loose} cubes outside the added folders`);
		if (Group.first_selected !== top[0]) bad.push('the added folder is not selected');

		const had = new Set(openProject.animations.map(a => a.name));
		const anims = created.animations.map(a => a.name);
		if (!anims.length) bad.push('the animations were not added');
		if (anims.some(n => had.has(n))) bad.push('an animation took a name the project had');
		if (anims.some(n => !n.startsWith(slug + '.'))) bad.push('an animation does not carry the model name');

		const starts = undoLog.filter(u => u.kind === 'init'), ends = undoLog.filter(u => u.kind === 'finish');
		if (starts.length !== 1 || ends.length !== 1) {
			bad.push(`undo: ${starts.length} starts, ${ends.length} ends`);
		} else {
			const a = ends[0].aspects;
			if (a.elements.length !== created.cubes.length) bad.push('undo misses cubes');
			if (!a.textures.includes(old) || !starts[0].aspects.textures.includes(old)) bad.push('undo misses the project texture');
			if (a.animations.length !== created.animations.length) bad.push('undo misses animations');
			if (!a.uv_mode || !starts[0].aspects.uv_mode) bad.push('undo misses the UV size');
			const fill = eventLog.indexOf('fill old');
			if (fill < 0 || fill > eventLog.indexOf('finish')) bad.push('undo was closed before the texture was drawn');
		}
		if (!(reportShown || '').includes('Added to: the open GeckoLib project, into the folder “arm”')) bad.push('the report does not say where it went');
		verdict('Into a folder, beside the texture, names apart, one undo', bad);
	}

	// Bedrock with cubes but no texture yet: the sheet keeps room for their UV.
	{
		open({ format: 'bedrock', uv: [32, 32], cubes: 1 });
		formOverride = { add_to_open: true };
		failed = await runImport('added to a Bedrock project with cubes and no texture') || failed;
		await settle();
		const bad = [];
		const plan = lib.texturePlan('beside', [32, 32], atlasPNG);
		if (size() !== plan.uvSize.join('×')) bad.push(`UV size ${size()}, not ${plan.uvSize.join('×')}`);
		const tex = created.textures[0];
		if (created.textures.length !== 1 || !tex.url) bad.push('no texture was made and drawn');
		else if (tex.uv_width !== plan.uvSize[0]) bad.push(`its UV width is ${tex.uv_width}`);
		const sheet = canvasLog.find(c => c.width === plan.uvSize[0] && c.height === plan.uvSize[1]);
		if (!sheet || sheet.draws.length !== 1) bad.push('the atlas was not drawn alone on a sheet of the new size');
		const uvBad = uvCheck(plan);
		if (uvBad) bad.push(uvBad);
		if (created.animations.length) bad.push('animations were added unasked');
		if (topOf().length !== 1 || topOf()[0].parent) bad.push('the model is not one folder at the top level');
		verdict('No texture yet: drawn on a sheet that leaves the old UV room, no animations unasked', bad);
	}

	// Generic: every texture has its own UV size, so the atlas stays whole.
	{
		open({ format: 'free', uv: [16, 16], texture: {}, cubes: 2 });
		formOverride = { add_to_open: true };
		failed = await runImport('added to a Generic project') || failed;
		await settle();
		const bad = [];
		const tex = created.textures[0];
		if (created.textures.length !== 1) bad.push(`${created.textures.length} textures made`);
		else if (tex.uv_width !== atlasPNG[0] || tex.uv_height !== atlasPNG[1]) bad.push(`its UV size is ${tex.uv_width}×${tex.uv_height}`);
		if (size() !== '16×16') bad.push(`the project UV size changed to ${size()}`);
		if (openProject.textures[0].url) bad.push('the project texture was redrawn');
		const uvBad = uvCheck(lib.texturePlan('own', [16, 16], atlasPNG));
		if (uvBad) bad.push(uvBad);
		verdict('Generic: a texture of its own, the project texture untouched', bad);
	}

	// Java: one UV size for all textures; the model's UV are squeezed into it.
	{
		open({ format: 'java_block', uv: [16, 16], texture: {}, extra: { java_block_version: '1.21.6' } });
		formOverride = { add_to_open: true };
		failed = await runImport('added to a Java block model') || failed;
		await settle();
		const bad = [];
		if (created.textures.length !== 1) bad.push(`${created.textures.length} textures made`);
		if (size() !== '16×16') bad.push(`the project UV size changed to ${size()}`);
		const uvBad = uvCheck(lib.texturePlan('shared', [16, 16], atlasPNG));
		if (uvBad) bad.push(`UV are not squeezed into 16×16: ${uvBad}`);
		const outside = created.cubes.filter(c => [0, 1, 2].some(a =>
			Math.min(c.from[a], c.to[a]) - (c.inflate || 0) < -16 - 1e-9
			|| Math.max(c.from[a], c.to[a]) + (c.inflate || 0) > 32 + 1e-9)).length;
		if (outside) bad.push(`${outside} cubes outside the −16…32 box`);
		if (created.animations.length) bad.push('a Java model got animations');
		verdict('Java: a texture of its own, UV in the project\'s 16×16, inside the box', bad);
	}

	// An empty project takes the model's UV size, as a new one would.
	{
		open({ format: 'geckolib_model', uv: [16, 16], cubes: 0 });
		formOverride = { add_to_open: true };
		failed = await runImport('added to an empty GeckoLib project') || failed;
		await settle();
		const bad = [];
		if (size() !== atlasPNG.join('×')) bad.push(`UV size ${size()}, not ${atlasPNG.join('×')}`);
		if (created.textures.length !== 1) bad.push(`${created.textures.length} textures made`);
		const uvBad = uvCheck(lib.texturePlan('fresh', null, atlasPNG));
		if (uvBad) bad.push(uvBad);
		verdict('Empty project: the model\'s own UV size', bad);
	}

	// A layered texture would be flattened by the redraw: the import stops first.
	{
		open({ format: 'geckolib_model', uv: [64, 64], texture: { layers_enabled: true } });
		formOverride = { add_to_open: true };
		created.cubes.length = 0;
		reportShown = null;
		importAction.click();
		await new Promise(r => setTimeout(r, 300));
		const bad = [];
		if (created.cubes.length) bad.push(`${created.cubes.length} cubes were made`);
		if (undoLog.length) bad.push('an undo step was opened');
		if (size() !== '64×64' || openProject.textures[0].url) bad.push('the project was changed');
		if (!/layers/.test(reportShown || '')) bad.push('the message does not say why');
		verdict('Layered texture: stops before touching the project', bad);
	}

	// A project the import cannot build into gets no such offer.
	{
		open({ format: 'skin', uv: [64, 64], texture: {} });
		formOverride = {};
		delete formsShown[DIALOG];
		importAction.click();
		await new Promise(r => setTimeout(r, 300));
		verdict('A skin project: not offered', (formsShown[DIALOG] || {}).add_to_open ? ['the dialog offers it'] : []);
	}

	openProject.groups = [];
	openProject.textures = [];
	openProject.elements = [];
	openProject.animations = [];
	Group.first_selected = null;
	sandbox.Project = savedProject;
	sandbox.Format = savedFormat;
	formOverride = {};
}

// --- export to CPM: the same path, but saving a .cpmproject at the end.
// Catches the same as the rest of the smoke test: access to fields that do not exist,
// typos in names, forgotten Blockbench stubs. Geometric correctness
// is checked separately — tools/verify-cpm.mjs.
scenario = 'png';
zipWritten = null;
exported = null;
console.log('');
console.log('--- export to CPM');
const cpmAction = sandboxActions.find(a => a.id.endsWith('_cpm'));
if (!cpmAction) {
	failed = true;
	console.log('❌ the CPM export action was not found');
} else {
	try {
		cpmAction.click();
		await new Promise(r => setTimeout(r, 500));
		// The CPM export always builds a project of its own, even with one open.
		if ((formsShown.gltf_to_minecraft_import_dialog || {}).add_to_open) {
			failed = true;
			console.log('❌ the CPM export offers adding to the open project');
		}
		// The bones asked about start at the top of the tidied tree. They used to
		// start at the file's own top — the export wrapper, or a pass-through node
		// such as this model's node_141 — which nobody can map to a body part.
		const cpmForm = formsShown[Object.keys(formsShown).find(k => k.endsWith('_cpm_dialog'))] || {};
		const asked = Object.entries(cpmForm).filter(([k]) => k.startsWith('b_')).map(([, v]) => v.label);
		const noise = asked.filter(l => /^(node_\d+|sketchfab_model|root|gltf_scenerootnode|_?gltfnode_\d+)$/i.test(l));
		if (!asked.length) { failed = true; console.log('❌ the CPM dialog asked about no bones'); }
		else if (noise.length) { failed = true; console.log('❌ the CPM dialog asks about pass-through nodes: ' + noise.join(', ')); }
		else console.log(`CPM dialog asks about ${asked.length} bones, none of them pass-through: OK`);
	} catch (e) {
		failed = true;
		console.log('ERROR during the CPM export: ' + e.message);
		console.log(String(e.stack).split(String.fromCharCode(10)).slice(1, 4).join(' | '));
	}
	if (!zipWritten) {
		failed = true;
		console.log('❌ the .cpmproject archive was not assembled');
	} else if (!zipWritten['config.json']) {
		failed = true;
		console.log('❌ the archive has no config.json');
	} else {
		const cfg = JSON.parse(zipWritten['config.json']);
		const roots = cfg.elements.map(e => e.id).join(', ');
		let boxes = 0;
		const count = l => (l || []).forEach(e => {
			if (e.size && (e.size.x || e.size.y || e.size.z)) boxes++;
			count(e.children);
		});
		cfg.elements.forEach(r => count(r.children));
		const animNames = Object.keys(zipWritten).filter(n => n.startsWith('animations/'));
		console.log(`Roots: ${roots}`);
		console.log(`Files in the archive: ${Object.keys(zipWritten).filter(n => !n.startsWith('animations/')).join(', ')}`
			+ ` + animations ${animNames.length}`);
		console.log(`Elements with geometry: ${boxes}, UV grid ${cfg.skinSize.x}×${cfg.skinSize.y}`);
		if (!boxes) { failed = true; console.log('❌ not a single box in the CPM project'); }
		if (!animNames.length) {
			failed = true;
			console.log('❌ not a single animation was transferred');
		} else {
			// The file name is not decoration: by its prefix the loader decides whether it is a pose
			// or a gesture, and by the rest — which pose exactly.
			const bad = animNames.filter(n => !/^animations\/[vcg]_[^/]+\.json$/.test(n));
			if (bad.length) { failed = true; console.log('❌ animation names do not follow the format: ' + bad.slice(0, 3).join(', ')); }
			const one = JSON.parse(zipWritten[animNames[0]]);
			const comps = one.frames.reduce((s, f) => s + f.components.length, 0);
			console.log(`First animation: ${animNames[0].replace('animations/', '')}, `
				+ `${one.frames.length} frames, ${comps} records, duration ${one.duration}`);
			const ids = new Set();
			const collect = l => (l || []).forEach(e => { ids.add(e.storeID); collect(e.children); });
			cfg.elements.forEach(r => collect(r.children));
			const orphan = one.frames.some(f => f.components.some(c => !ids.has(c.storeID)));
			if (orphan) { failed = true; console.log('❌ a keyframe refers to a storeID the model does not have'); }
		}
		if (cfg.version !== 1) { failed = true; console.log('❌ version is not 1'); }
		if (!zipWritten['skin.png']) { failed = true; console.log('❌ the archive has no skin.png'); }
		if (!exported || exported.extensions[0] !== 'cpmproject') {
			failed = true;
			console.log('❌ Blockbench.export was not called with the cpmproject extension');
		}
	}
}

// --- export to CPM with a rebuilt part: its plates are cubes like any other,
// and the skin has to be drawn with their sheets, or they arrive clear.
scenario = 'rounded';
zipWritten = null;
console.log('');
console.log('--- export to CPM, with a part rebuilt from plates');
{
	const cpmAction = sandboxActions.find(a => a.id.endsWith('_cpm'));
	const canvasesBefore = canvasLog.length;
	cpmAction.click();
	for (let i = 0; i < 100 && !zipWritten; i++) await new Promise(r => setTimeout(r, 100));
	const bad = [];
	if (!zipWritten || !zipWritten['config.json']) bad.push('no .cpmproject was assembled');
	else {
		const cfg = JSON.parse(zipWritten['config.json']);
		let flat = 0;
		const count = l => (l || []).forEach(e => {
			if (e.size && [e.size.x, e.size.y, e.size.z].filter(v => Math.abs(v) < 1e-9).length === 1) flat++;
			count(e.children);
		});
		cfg.elements.forEach(r => count(r.children));
		if (flat < 14) bad.push(`${flat} flat elements, fewer than the prism's 14 plates`);
		if (!zipWritten['skin.png']) bad.push('no skin.png');
	}
	const skinCanvas = canvasLog.slice(canvasesBefore).some(c => c.puts > 0);
	if (!skinCanvas) bad.push('the skin was drawn without the baked sheets');
	if (bad.length) { failed = true; console.log('❌ ' + bad.join('; ')); }
	else console.log('The prism\'s plates went into the CPM project, and the skin was drawn with their sheets: OK');
}
scenario = 'png';

// Without the GeckoLib format, choosing GeckoLib stops the import and names the
// plugin to install. GeckoLib Animation Utils stops at Blockbench 5.0 and GeckoLib
// Models & Animations starts there; the message used to name only the old one,
// which Blockbench 5 refuses to install. The catalog entry that installs on this
// build is the one named.
console.log('');
console.log('--- GeckoLib missing');
{
	const savedFormats = sandbox.Formats;
	const savedOlder = sandbox.Blockbench.isOlderThan;
	const { geckolib_model, ...others } = ALL_FORMATS;
	void geckolib_model;
	sandbox.Formats = others;

	// Nothing chosen before: the dialog offers Bedrock, which ships with Blockbench.
	sandbox.localStorage._v = {};
	lastDialog = null;
	importAction.click();
	await new Promise(r => setTimeout(r, 300));
	const made = projectsMade[projectsMade.length - 1];
	// The import report is a dialog too; only the GeckoLib message counts here.
	const asked = !!lastDialog && String(lastDialog.id).endsWith('_need_geckolib');
	if (made !== 'bedrock' || asked) {
		failed = true;
		console.log(`❌ without GeckoLib the default built ${made}${asked ? ' and still asked for GeckoLib' : ''}`);
	} else {
		console.log('No GeckoLib, nothing chosen before: builds into Bedrock: OK');
	}

	formOverride = { target: 'geckolib_model' };
	const entry = (id, verdict, extra) => Object.assign(
		{ id, title: id, installed: false, disabled: false, isInstallable: () => verdict }, extra);
	const cases = [
		{ label: 'Blockbench 5', older: false, want: 'GeckoLib Models & Animations', pick: 'geckolib',
			all: [entry('geckolib', true), entry('animation_utils', 'outdated_plugin')] },
		{ label: 'Blockbench 4', older: true, want: 'GeckoLib Animation Utils', pick: 'animation_utils',
			all: [entry('geckolib', 'outdated_client'), entry('animation_utils', true)] },
		{ label: 'no catalog, Blockbench 5', older: false, want: 'GeckoLib Models & Animations', pick: null,
			all: [] },
		{ label: 'installed but disabled', older: false, want: 'disabled', pick: 'geckolib',
			all: [entry('geckolib', true, { installed: true, disabled: true }), entry('animation_utils', 'outdated_plugin')] },
	];
	for (const c of cases) {
		let selected = null;
		sandbox.Blockbench.isOlderThan = () => c.older;
		sandbox.Plugins = {
			all: c.all,
			dialog: { show() { }, content_vue: { selectPlugin(p) { selected = p.id; }, setTab() { } } },
		};
		lastDialog = null;
		reportShown = '';
		importAction.click();
		const text = reportShown;
		const wrongName = c.label !== 'Blockbench 4' && text.includes('Animation Utils');
		if (lastDialog) lastDialog.onConfirm();
		const bad = [];
		if (!lastDialog) bad.push('no dialog');
		if (!text.includes(c.want)) bad.push(`does not say "${c.want}"`);
		if (wrongName) bad.push('names the plugin Blockbench 5 will not install');
		if (selected !== c.pick) bad.push(`opened the list on ${selected || 'nothing'} instead of ${c.pick || 'nothing'}`);
		if (bad.length) { failed = true; console.log(`❌ ${c.label}: ${bad.join('; ')}`); }
		else console.log(`${c.label}: names ${c.want}${c.pick ? ', opens its page' : ''}: OK`);
	}
	sandbox.Formats = savedFormats;
	sandbox.Blockbench.isOlderThan = savedOlder;
	delete sandbox.Plugins;
	formOverride = {};
}

console.log(`${String.fromCharCode(10)}${failed ? '❌ THERE ARE PROBLEMS' : '✅ THE PLUGIN RUNS WITHOUT ERRORS'}${String.fromCharCode(10)}`);
process.exit(failed ? 1 : 0);
