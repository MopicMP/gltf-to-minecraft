/**
 * Diagnostics of unpacked models: what exactly is wrong with them.
 *
 * The journal says "textures broken" or "model broken", but not why.
 * This tool runs the plugin's real parser over the model folders
 * and prints the signs that reveal the cause.
 *
 * Run: node tools/diagnose-models.mjs <folder with unpacked models>
 * Expected inside: <folder>/<category>/<model>/… or <folder>/<model>/…
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseGLTFFiles, solveBox, splitComponents, isDegenerate, imageSize } = require('../plugin/gltf_to_minecraft.js');

const root = process.argv[2];
if (!root) { console.log('Specify a folder with unpacked models'); process.exit(1); }

const readDir = dir => {
	const files = {};
	const walk = (d, prefix) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p, prefix + e.name + '/');
			else files[prefix + e.name] = new Uint8Array(fs.readFileSync(p));
		}
	};
	walk(dir, '');
	return files;
};

/** Folders that hold a model (there is a .gltf/.glb or nested files). */
const modelDirs = [];
const collect = (dir, depth) => {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	const hasFiles = entries.some(e => e.isFile());
	const subdirs = entries.filter(e => e.isDirectory());
	if (hasFiles || depth >= 2) { modelDirs.push(dir); return; }
	for (const d of subdirs) collect(path.join(dir, d.name), depth + 1);
};
collect(root, 0);

console.log('');
for (const dir of modelDirs) {
	const label = path.relative(root, dir) || path.basename(dir);
	const files = readDir(dir);
	const names = Object.keys(files);

	const hasGltf = names.some(n => /\.(gltf|glb)$/i.test(n));
	if (!hasGltf) {
		const other = names.filter(n => /\.(blend|blend1|fbx|obj|max|ma|mb|c4d|3ds|dae)$/i.test(n))
			.map(n => path.extname(n)).join(', ');
		console.log(`\n### ${label}`);
		console.log(`    NO glTF. The archive holds only the author's source: ${other || names.slice(0, 3).join(', ')}`);
		console.log('    → this is the "Original" download, not the autoconversion. Nothing can open it.');
		continue;
	}

	let parsed;
	try { parsed = parseGLTFFiles(files, { scale: 1, uvWidth: 1, uvHeight: 1 }); }
	catch (e) { console.log(`\n### ${label}\n    parsing crashed: ${e.message}`); continue; }

	// splitting merged meshes — the same way as in the import
	const split = [];
	let splitFrom = 0;
	for (const obj of parsed.objects) {
		const parts = splitComponents(obj.faces);
		if (parts.length > 1) splitFrom++;
		parts.forEach(faces => split.push({ name: obj.name, faces, image: obj.image }));
	}

	// classifying the objects
	let boxes = 0, degenerate = 0;
	const notBox = [];
	for (const o of split) {
		if (isDegenerate(o.faces)) { degenerate++; continue; }
		const sol = solveBox(o.faces);
		if (!sol.error) { boxes++; continue; }
		const pts = new Set();
		for (const f of o.faces) for (const p of f.positions) pts.add(p.map(v => v.toFixed(4)).join(','));
		notBox.push({ name: o.name, verts: pts.size });
	}

	// textures and UV
	const roles = parsed.images.map(i => i.role || '?');
	const colorCount = roles.filter(r => r === 'color').length;
	const auxCount = roles.filter(r => r === 'aux').length;
	const unreadable = parsed.images.filter(i => !imageSize(i.bytes)).length;
	let uvTotal = 0, uvOut = 0, noMat = 0;
	for (const o of parsed.objects) {
		if (o.image < 0) noMat++;
		for (const f of o.faces) for (const uv of f.uvs || []) {
			if (!uv) continue;
			uvTotal++;
			if (uv[0] < -1e-4 || uv[0] > 1.0001 || uv[1] < -1e-4 || uv[1] > 1.0001) uvOut++;
		}
	}

	// how box-like the objects are at all
	const heavy = notBox.filter(n => n.verts > 12).length;
	const near = notBox.length - heavy;
	const total = boxes + notBox.length;
	const share = total ? (100 * notBox.length / total) : 0;

	console.log(`\n### ${label}`);
	console.log(`    objects ${parsed.objects.length} → after splitting ${split.length}`
		+ (splitFrom ? ` (meshes split: ${splitFrom})` : ''));
	console.log(`    boxes ${boxes} · not boxes ${notBox.length} (${share.toFixed(0)}%) `
		+ `· degenerate ${degenerate}`);
	if (notBox.length) {
		console.log(`      of the not-boxes: complex geometry (>12 vertices) ${heavy}, almost a box ${near}`);
		const worst = notBox.slice().sort((a, b) => b.verts - a.verts).slice(0, 3);
		console.log('      most complex: ' + worst.map(w => `${w.name} (${w.verts} vertices)`).join(', '));
	}
	console.log(`    images ${parsed.images.length}: colour ${colorCount}, auxiliary ${auxCount}`
		+ (unreadable ? `, unreadable ${unreadable}` : ''));
	console.log(`    UV outside the texture ${uvTotal ? (100 * uvOut / uvTotal).toFixed(1) : 0}%`
		+ ` · objects without a material ${noMat}`);

	const verdict = share > 30 ? 'NOT CUBIC — replacing with boxes will make a mess'
		: share > 0 ? 'almost cubic — replacing with boxes is appropriate'
		: 'cubic';
	console.log(`    verdict: ${verdict}`);
}
console.log('');
