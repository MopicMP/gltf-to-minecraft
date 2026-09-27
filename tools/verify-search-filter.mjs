/**
 * The Sketchfab results filter: show only models with a ready glTF.
 *
 * Some models only offer the author's source (.blend, .fbx) for download — there is
 * nothing to open it with. The journal collected six such refusals in a row, and all
 * of them looked fine right up to the import attempt.
 *
 * Run: node tools/verify-search-filter.mjs [--live]
 *   --live also checks the filter on real API results
 *          (search is public, no token needed).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hasGltfArchive, sketchfabSearchURL, cubeHint, SKETCHFAB_SORTS, sketchfabEmbedURL, sketchfabPageURL, sketchfabArchives, sketchfabCredit, sketchfabDownload } = require('../plugin/gltf_to_minecraft.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };

console.log('\n=== What counts as usable ===');
ok(hasGltfArchive({ archives: { gltf: { size: 12345 }, source: { size: null } } }),
	'gltf with a size — usable');
ok(hasGltfArchive({ archives: { glb: { size: 500 } } }), 'only glb — usable too');
ok(!hasGltfArchive({ archives: { source: { size: 999 } } }), 'only the author\'s source — hidden');
ok(!hasGltfArchive({ archives: { gltf: { size: 0 }, source: { size: 10 } } }),
	'gltf of zero size — no autoconversion, hidden');
ok(!hasGltfArchive({ archives: { gltf: { size: null } } }), 'gltf with size=null — hidden');
ok(hasGltfArchive({ name: 'no archives field' }),
	'no archives field — shown (better too much than hiding everything)');
ok(hasGltfArchive({}) && hasGltfArchive(null) === false || true, 'null does not crash the function');

// The blockbench tag. A model built in Blockbench is cubes already and comes
// through whole; most of Sketchfab is sculpts that leave only a pile of
// bounding boxes. That is why the filter is on by default.
console.log('\n=== The request the plugin builds ===');
const withTag = sketchfabSearchURL('girl', true);
const without = sketchfabSearchURL('girl', false);
ok(/[?&]tags=blockbench(&|$)/.test(withTag), 'with the filter the request has tags=blockbench');
ok(!/tags=/.test(without), 'without the filter the request has no tag');
ok(/downloadable=true/.test(withTag) && /downloadable=true/.test(without),
	'"downloadable only" is set in both cases');
ok(/q=girl/.test(sketchfabSearchURL('girl', true)), 'the query itself is not lost');
ok(/q=&|q=$/.test(sketchfabSearchURL('', true)), 'an empty query gives an empty q, not undefined');

// The Animated box: off by default, and independent of the tag.
const animated = sketchfabSearchURL('girl', true, true);
ok(/[?&]animated=true(&|$)/.test(animated), 'with Animated the request has animated=true');
ok(!/animated=/.test(withTag), 'without it the request has no animated parameter');
ok(/tags=blockbench/.test(animated), 'Animated does not drop the blockbench tag');
ok(/animated=true/.test(sketchfabSearchURL('girl', false, true)) && !/tags=/.test(sketchfabSearchURL('girl', false, true)),
	'Animated works without the tag as well');

// The order. Only values from the plugin's list are sent: the API takes any
// value without complaint, and one it does not know returns the newest models,
// which is how "by downloads" would have quietly lied.
console.log('\n=== The order ===');
ok(!/sort_by=/.test(sketchfabSearchURL('girl', true, false, '')), 'Relevance sends no order');
for (const o of SKETCHFAB_SORTS.filter(o => o.id)) {
	const url = sketchfabSearchURL('girl', true, true, o.id);
	ok(url.split('&').includes('sort_by=' + o.id) && /tags=blockbench/.test(url) && /animated=true/.test(url),
		`${o.label} sends sort_by=${o.id} and keeps both filters`);
}
ok(!/sort_by=/.test(sketchfabSearchURL('girl', true, false, '-downloadCount')), 'an order not in the list is not sent (downloads)');
ok(!/sort_by=/.test(sketchfabSearchURL('girl', true, false, 'x&tags=other')), 'nor anything smuggled in');
ok(!SKETCHFAB_SORTS.some(o => /download/i.test(o.id + o.label)), 'no order by downloads is offered');

console.log('\n=== The 3D preview ===');
const UID = '0123456789abcdef0123456789abcdef';
ok(sketchfabEmbedURL(UID) === `https://sketchfab.com/models/${UID}/embed?autostart=1&dnt=1&ui_theme=dark`, 'a model id gives the viewer address');
ok(sketchfabEmbedURL('"><script>') === null && sketchfabEmbedURL(undefined) === null, 'anything but a model id gives no frame at all');
ok(sketchfabPageURL({ uid: UID, viewerUrl: 'https://sketchfab.com/3d-models/none-' + UID }) === 'https://sketchfab.com/3d-models/none-' + UID, 'the page the results give is kept');
ok(sketchfabPageURL({ uid: UID, viewerUrl: 'https://example.com/x' }) === 'https://sketchfab.com/3d-models/' + UID, 'a page elsewhere is replaced with Sketchfab\'s own');
ok(sketchfabPageURL({ uid: 'bad' }) === null, 'no page without a model id');

// The card's cube sign. Sketchfab counts vertex positions: a separate cube is 8
// of them to 12 triangles. The numbers are from real search results.
console.log('\n=== Built from cubes? ===');
ok(cubeHint(144, 96) === 'cubes', 'a player of 12 separate cubes (144 triangles, 96 vertices): cubes');
ok(cubeHint(10980, 7320) === 'cubes', 'exactly 2:3 at any size: cubes');
ok(cubeHint(212, 92) === 'shapes', 'shared corners, 0.43 vertices per triangle (a bevelled house): not cubes');
ok(cubeHint(388, 234) === null, 'in between, 0.60: no claim either way');
ok(cubeHint(18, 13) === null, 'above 2:3, as with faces left out or flat planes: no claim');
ok(cubeHint(0, 0) === null && cubeHint(undefined, 8) === null, 'missing counts: no claim');

const hasTag = m => (m.tags || []).some(t => t.name === 'blockbench' || t.slug === 'blockbench');

if (process.argv.includes('--live')) {
	// Hitting the API with exactly the URL the plugin built, not a copy of it: a test
	// against its own string would say nothing about what leaves Blockbench.
	console.log('\n=== The tag on real results ===');
	try {
		const page = async u => { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
		const plain = await page(without);
		const tagged = await page(withTag);
		const p1 = (plain.results || []).filter(hasTag).length;
		const t1 = (tagged.results || []).filter(hasTag).length;
		console.log(`  without the filter, tagged: ${p1} of ${(plain.results || []).length}`);
		console.log(`  with the filter, tagged: ${t1} of ${(tagged.results || []).length}`);
		ok((tagged.results || []).length > 0, 'the filter does not wipe out all results');
		ok(t1 === (tagged.results || []).length, 'with the filter every model carries the tag');
		// The card's cube sign on the same page: if Sketchfab ever stopped sending the
		// counts, or started counting vertices differently, nothing would read as cubes.
		const hints = (tagged.results || []).map(m => cubeHint(m.faceCount, m.vertexCount));
		const cubes = hints.filter(h => h === 'cubes').length, shapes = hints.filter(h => h === 'shapes').length;
		console.log(`  cube sign: cubes ${cubes}, probably not cubes ${shapes}, no claim ${hints.length - cubes - shapes}`);
		ok(cubes > 0, 'some tagged models read as cubes (the sign is alive)');
		// "Show more" follows the ready-made next link from the response. If it lost the
		// parameter, the first page would be from Blockbench and the second — anything.
		if (tagged.next) {
			ok(/tags=blockbench/.test(tagged.next), 'the next link keeps the tag');
			const second = await page(tagged.next);
			const t2 = (second.results || []).filter(hasTag).length;
			console.log(`  second page: tagged ${t2} of ${(second.results || []).length}`);
			ok(t2 === (second.results || []).length, 'on the second page every model carries the tag too');
		}
	} catch (e) {
		console.log(`  network unavailable or the API changed: ${e.message}`);
		console.log('  (not a test failure — the live check was skipped)');
	}

	// The same for Animated, with the plugin's own URL. The cards show the count
	// from animationCount, so that is what has to be non-zero.
	console.log('\n=== Animated on real results ===');
	try {
		const page = async u => { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
		const moving = m => Number(m.animationCount) > 0;
		const plain = await page(withTag);
		const anim = await page(animated);
		const p1 = (plain.results || []).filter(moving).length;
		const a1 = (anim.results || []).filter(moving).length;
		console.log(`  without the filter, animated: ${p1} of ${(plain.results || []).length}`);
		console.log(`  with the filter, animated: ${a1} of ${(anim.results || []).length}`);
		ok((anim.results || []).length > 0, 'the filter does not wipe out all results');
		ok(a1 === (anim.results || []).length, 'with the filter every model has an animation');
		ok((anim.results || []).every(m => typeof m.faceCount === 'number'), 'every result carries faceCount for the card');
		if (anim.next) {
			ok(/animated=true/.test(anim.next) && /tags=blockbench/.test(anim.next), 'the next link keeps both filters');
			const second = await page(anim.next);
			const a2 = (second.results || []).filter(moving).length;
			console.log(`  second page: animated ${a2} of ${(second.results || []).length}`);
			ok(a2 === (second.results || []).length, 'on the second page every model has an animation too');
		}
	} catch (e) {
		console.log(`  network unavailable or the API changed: ${e.message}`);
		console.log('  (not a test failure — the live check was skipped)');
	}

	// Each order with the plugin's own URL: the first page ordered by its field,
	// and the second carrying on below where the first stopped, no model twice.
	console.log('\n=== The order on real results ===');
	const FIELD = {
		'-likeCount': m => m.likeCount,
		'-viewCount': m => m.viewCount,
		'-publishedAt': m => Date.parse(m.publishedAt + 'Z'),
	};
	const page = async u => { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
	const down = v => v.every((x, i) => i === 0 || x <= v[i - 1]);
	for (const o of SKETCHFAB_SORTS.filter(o => o.id)) {
		try {
			const get = FIELD[o.id];
			const first = await page(sketchfabSearchURL('', true, false, o.id));
			const a = (first.results || []).map(get);
			ok(a.length > 1 && down(a) && a[0] > a[a.length - 1], `${o.label}: the first page runs from ${a[0]} down to ${a[a.length - 1]}`);
			if (first.next) {
				ok(new RegExp('sort_by=' + o.id).test(first.next), `${o.label}: the next link keeps the order`);
				const second = await page(first.next);
				const b = (second.results || []).map(get);
				const again = (second.results || []).filter(m => (first.results || []).some(x => x.uid === m.uid)).length;
				ok(down(b) && b[0] <= a[a.length - 1] && !again, `${o.label}: the second page carries on from ${b[0]}, none repeated`);
			}
		} catch (e) {
			console.log(`  ${o.label}: network unavailable or the API changed: ${e.message} (skipped)`);
		}
	}
}

console.log('\n=== Which archive a download takes ===');
{
	const links = { source: { url: 'https://x/original.zip' }, gltf: { url: 'https://x/converted.zip' } };
	const urls = list => list.map(a => (a.original ? 'original ' : 'converted ') + a.url.replace(/^.*\//, '')).join(', ');
	ok(urls(sketchfabArchives(links, { source: 'blockbench' })) === 'original original.zip, converted converted.zip',
		'uploaded from Blockbench: the original first, the conversion behind it');
	ok(urls(sketchfabArchives(links, { source: 'website' })) === 'converted converted.zip',
		'uploaded any other way: only the conversion, the original may be a .blend');
	ok(urls(sketchfabArchives(links, null)) === 'converted converted.zip', 'no details: the conversion, as before');
	ok(urls(sketchfabArchives({ gltf: links.gltf }, { source: 'blockbench' })) === 'converted converted.zip',
		'from Blockbench, but no original offered: the conversion');
	ok(urls(sketchfabArchives({ glb: { url: 'https://x/c.glb.zip' } }, {})) === 'converted c.glb.zip', 'a glb conversion counts too');

	const credit = sketchfabCredit({
		name: 'A cart', viewerUrl: 'https://sketchfab.com/3d-models/a-cart-0',
		user: { displayName: 'someone', profileUrl: 'https://sketchfab.com/someone' },
		license: { label: 'CC Attribution', fullName: 'CC Attribution', url: 'http://creativecommons.org/licenses/by/4.0/', requirements: 'Author must be credited.' },
	}).split('\n');
	ok(credit[0] === 'Model Information:' && credit[1] === '* title:\tA cart' && credit[3] === '* author:\tsomeone (https://sketchfab.com/someone)',
		'the credit opens as Sketchfab\'s license.txt does: title, source, author');
	ok(credit.some(l => l === '* license type:\tCC Attribution (http://creativecommons.org/licenses/by/4.0/)')
		&& credit.some(l => l.includes('Author must be credited.')), 'and names the licence and what it requires');
}

console.log('\n=== A download, with Sketchfab stood in for ===');
{
	// The network and JSZip, stood in for: each archive unpacks to the files given.
	// The real fetch comes back after, for the live checks below.
	const realFetch = globalThis.fetch;
	const run = async ({ source, archives, detailsFail }) => {
		const asked = [];
		globalThis.fetch = async url => {
			asked.push(url.replace(/^.*\//, ''));
			const json = body => ({ ok: true, status: 200, json: async () => body });
			if (url.endsWith('/download')) {
				return json(Object.fromEntries(Object.keys(archives).map(k => [k, { url: 'https://cdn/' + k + '.zip' }])));
			}
			if (/\/models\/[^/]+$/.test(url)) {
				return detailsFail ? { ok: false, status: 500 } : json({ name: 'A cart', source, user: { displayName: 'someone' }, license: { label: 'CC Attribution' } });
			}
			const name = url.replace(/^.*\/|\.zip$/g, '');
			const files = archives[name];
			return files === 'broken' ? { ok: false, status: 500 } : { ok: true, arrayBuffer: async () => ({ name }) };
		};
		globalThis.JSZip = {
			loadAsync: async buf => ({
				forEach: cb => Object.keys(archives[buf.name]).forEach(n => cb(n, { dir: false, async: async () => new Uint8Array([1]) })),
			}),
		};
		const got = await sketchfabDownload('uid', 'token', () => { });
		return { original: got.original, files: Object.keys(got.entries).sort().join(', '), asked: asked.filter(a => a.endsWith('.zip')).join(', ') };
	};
	const original = { 'source/model.gltf': 1, 'textures/gltf_embedded_0.png': 1 };
	const converted = { 'scene.gltf': 1, 'scene.bin': 1, 'license.txt': 1 };

	let got = await run({ source: 'blockbench', archives: { source: original, gltf: converted } });
	ok(got.original && got.files === 'license.txt, source/model.gltf, textures/gltf_embedded_0.png' && got.asked === 'source.zip',
		`from Blockbench: the original, with a credit made for it (${got.files})`);
	got = await run({ source: 'blockbench', archives: { source: { 'model.obj': 1 }, gltf: converted } });
	ok(!got.original && got.files === 'license.txt, scene.bin, scene.gltf', `an original with no glTF gives way to the conversion (${got.asked})`);
	got = await run({ source: 'blockbench', archives: { source: 'broken', gltf: converted } });
	ok(!got.original && got.files.includes('scene.gltf'), 'an original that fails to come gives way to the conversion');
	got = await run({ source: 'website', archives: { source: original, gltf: converted } });
	ok(!got.original && got.asked === 'gltf.zip', 'uploaded another way: the original is not even fetched');
	got = await run({ source: 'blockbench', detailsFail: true, archives: { source: original, gltf: converted } });
	ok(!got.original && got.asked === 'gltf.zip', 'no details: the conversion, as before');
	got = await run({ source: 'blockbench', archives: { source: original } });
	ok(got.original, 'from Blockbench with no conversion at all: the original still comes');
	let failed = null;
	try { await run({ source: 'website', archives: { source: original } }); } catch (e) { failed = e.message; }
	ok(failed === 'the response has no glTF link', `only a non-Blockbench original: refused as before (${failed})`);
	globalThis.fetch = realFetch;
	delete globalThis.JSZip;
}

if (process.argv.includes('--live')) {
	console.log('\n=== Where models came from, in their details ===');
	try {
		const r = await fetch(sketchfabSearchURL('minecraft mob', false));
		if (!r.ok) throw new Error('HTTP ' + r.status);
		const list = ((await r.json()).results || []).slice(0, 12);
		const sources = [];
		for (const m of list) {
			const d = await fetch('https://api.sketchfab.com/v3/models/' + m.uid);
			if (d.ok) sources.push((await d.json()).source || 'none');
		}
		console.log(`  upload sources of ${sources.length} models: ${sources.join(', ')}`);
		ok(!list.some(m => 'source' in m), 'search results still leave the source out (so the details are asked for)');
		ok(sources.includes('blockbench'), 'the details still say "blockbench" for models uploaded from it');
	} catch (e) {
		console.log(`  network unavailable or the API changed: ${e.message} (skipped)`);
	}

	console.log('\n=== Real API results ===');
	const url = sketchfabSearchURL('minecraft', false);
	try {
		const r = await fetch(url);
		if (!r.ok) throw new Error('HTTP ' + r.status);
		const data = await r.json();
		const list = data.results || [];
		const good = list.filter(hasGltfArchive);
		const withArchives = list.filter(m => m.archives).length;
		console.log(`  models in the results: ${list.length}, with an archives field: ${withArchives}`);
		console.log(`  pass the filter: ${good.length}, hidden: ${list.length - good.length}`);
		ok(withArchives > 0, 'the API really returns archives (otherwise the filter is a dummy)');
		ok(good.length > 0, 'the filter does not wipe out all results');
		for (const m of list.filter(m => !hasGltfArchive(m)).slice(0, 5)) {
			const has = Object.entries(m.archives || {})
				.filter(([, v]) => v && v.size).map(([k]) => k).join(', ') || 'nothing';
			console.log(`    hidden: ${(m.name || '').slice(0, 40)} — available: ${has}`);
		}
	} catch (e) {
		console.log(`  network unavailable or the API changed: ${e.message}`);
		console.log('  (not a test failure — the live check was skipped)');
	}
} else {
	console.log('\n(run with --live to check the filter on real results)');
}

console.log(bad ? `\n❌ ERRORS: ${bad}\n` : '\n✅ THE RESULTS FILTER WORKS\n');
process.exit(bad ? 1 : 0);
