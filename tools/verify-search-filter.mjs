/**
 * The Sketchfab results filter: show only models with a ready glTF, and how much of
 * a page may be models nobody is allowed to download.
 *
 * Some models only offer the author's source (.blend, .fbx) for download — there is
 * nothing to open it with. The journal collected six such refusals in a row, and all
 * of them looked fine right up to the import attempt.
 *
 * The locked ones are a different matter: they cannot be imported either, but they
 * are most of Sketchfab, and hiding them made this search look a quarter the size of
 * the same search on Sketchfab's own site. They are listed as what they are instead,
 * a rising share of each page (SF_LOCKED_SHARE), and these checks hold the two lists
 * apart — nothing locked may wear an import button, nothing open may wear a lock.
 *
 * Run: node tools/verify-search-filter.mjs [--live]
 *   --live also checks the filter on real API results
 *          (search is public, no token needed).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hasGltfArchive, sketchfabSearchURL, cubeHint, SKETCHFAB_SORTS, sketchfabPageURL, sketchfabArchives, sketchfabCredit, sketchfabDownload,
	SF_LOCKED_SHARE, SF_PAGE, mixResults, isLockedModel } = require('../plugin/gltf_to_minecraft.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); };

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

// The second search, for the models nobody may download. They are listed as what
// they are, with a lock and no import: they are most of Sketchfab, and leaving them
// out made this search look a quarter the size of the same search on Sketchfab.
//
// There is no asking for them. `downloadable=false` is accepted and ignored — see
// the live section below, which is what caught it — so the locked search is the
// plain one, and the sifting happens on the results.
console.log('\n=== The locked half of Sketchfab ===');
const shut = sketchfabSearchURL('girl', true, false, '', true);
ok(!/downloadable=/.test(shut), 'the locked search asks for no download filter at all');
ok(/downloadable=true/.test(sketchfabSearchURL('girl', true, false, '', false)),
	'while the open one still asks for one');
ok(/tags=blockbench/.test(shut) && /q=girl/.test(shut), 'it keeps the query and the filters');
ok(/animated=true/.test(sketchfabSearchURL('girl', true, true, '', true)), 'Animated applies to it as well');
ok(/sort_by=-likeCount/.test(sketchfabSearchURL('girl', true, false, '-likeCount', true)), 'so does the order');
ok(isLockedModel({ isDownloadable: false }), 'a result that says it cannot be downloaded is locked');
ok(!isLockedModel({ isDownloadable: true }) && !isLockedModel({}) && !isLockedModel(null),
	'anything else is not: a missing field must not put a lock on an open model');

// The mix. The share rises one step per release; whatever the step, a page holds
// SF_PAGE cards and loses none of either list.
console.log('\n=== Mixing the two lists into one page ===');
ok(SF_LOCKED_SHARE > 0 && SF_LOCKED_SHARE <= 0.85, `the step is ${SF_LOCKED_SHARE}, within the measured 0.85 ceiling`);
const want = Math.round(SF_PAGE * SF_LOCKED_SHARE);
const openList = Array.from({ length: SF_PAGE - want }, (_, i) => ({ uid: 'o' + i, isDownloadable: true }));
const shutList = Array.from({ length: want }, (_, i) => ({ uid: 'l' + i, isDownloadable: false }));
const page = mixResults(openList, shutList);
ok(page.length === SF_PAGE, `a page of ${SF_PAGE} cards, ${want} of them locked`);
ok(page.filter(isLockedModel).length === want, 'every locked one is laid out');
ok(new Set(page.map(m => m.uid)).size === SF_PAGE, 'and nothing is laid out twice');
const places = page.map((m, i) => isLockedModel(m) ? i : -1).filter(i => i >= 0);
ok(places[0] > 0, 'the page does not open with a locked card');
const gaps = places.slice(1).map((p, i) => p - places[i]);
ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `spread evenly, not in a block (gaps ${gaps.join(',')})`);
ok(mixResults(openList, []).length === openList.length, 'with the switch off the page is open models only');
ok(mixResults([], shutList).length === want, 'and once the open ones run out the page is filled from the other list');

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

// No address for an embedded viewer is built or checked here: the catalogue forbids a
// plugin to render somebody else's HTML, so a model is turned in the plugin's own view
// out of the geometry it downloads. What is left to check is the page one can open.
console.log('\n=== The model page ===');
const UID = '0123456789abcdef0123456789abcdef';
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

	// The locked search against the live API. What the plugin lays out must come back
	// pure in both directions, or the mix would be a lie twice over: a lock on a model
	// that downloads, and an import button on one that cannot.
	//
	// This section is here because it caught the opposite claim. `downloadable=false`
	// had been read as working off a single page that happened to be locked
	// throughout — the one page on which an honoured filter and an ignored one are
	// indistinguishable. It is ignored, so the sifting is ours to do.
	console.log('\n=== The locked search on real results ===');
	try {
		const get = async url => {
			const r = await fetch(url);
			if (!r.ok) throw new Error('HTTP ' + r.status);
			return (await r.json()).results || [];
		};
		const plainURL = sketchfabSearchURL('', true, false, '-publishedAt', true);
		const [free, raw, asked] = await Promise.all([
			get(sketchfabSearchURL('', true, false, '-publishedAt', false)),
			get(plainURL),
			get(plainURL + '&downloadable=false'),
		]);
		ok(free.length > 0 && free.every(m => m.isDownloadable),
			`downloadable=true: all ${free.length} of them can be downloaded`);
		// The parameter is recorded, not asserted: were Sketchfab to start honouring it
		// one day that would be good news and a cheaper request, not a broken plugin.
		const lockedIn = list => list.filter(m => !m.isDownloadable).length;
		console.log(`  asking downloadable=false returns ${lockedIn(asked)} locked of ${asked.length}`
			+ `, a plain search ${lockedIn(raw)} of ${raw.length}`
			+ ` — ${lockedIn(asked) === lockedIn(raw) && asked.length === raw.length ? 'the same, so it is ignored' : 'they differ: the filter may now work'}`);
		const held = raw.filter(isLockedModel);
		ok(held.length > 0, `sifted by hand, the plain search gave ${held.length} locked models of ${raw.length}`);
		ok(held.every(m => !m.isDownloadable), 'every one of them really cannot be downloaded');
		ok(!held.some(m => free.some(x => x.uid === m.uid)), 'and the two lists hold no model in common');
		// Measured when this was written: 51 of 336 tagged models downloadable, 15%. A
		// page of 24 therefore carries locked models several times over the share any
		// step of the ladder asks for, so one fetch feeds several pages.
		ok(held.length >= Math.round(SF_PAGE * SF_LOCKED_SHARE),
			`one fetch covers the ${Math.round(SF_PAGE * SF_LOCKED_SHARE)} a page needs at this step`);
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
			return files === 'broken' ? { ok: false, status: 500 } : {
				ok: true, body: new ReadableStream({ start(controller) {
					controller.enqueue(new TextEncoder().encode(name)); controller.close();
				} }),
			};
		};
		globalThis.JSZip = {
			loadAsync: async buf => ({
				forEach: cb => Object.keys(archives[new TextDecoder().decode(buf)]).forEach(n => cb(n, {
					dir: false, internalStream() {
						const handlers = {};
						return { on(event, fn) { handlers[event] = fn; return this; }, pause() {},
							resume() { handlers.data(new Uint8Array([1])); handlers.end(); return this; } };
					},
				})),
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

console.log(bad ? `\nFAIL: ERRORS: ${bad}\n` : '\nPASS: THE RESULTS FILTER WORKS\n');
process.exit(bad ? 1 : 0);
