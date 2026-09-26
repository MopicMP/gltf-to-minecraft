/**
 * Analysis of the journal of marked models: how the broken ones differ from the working ones.
 *
 * Notes are printed IN FULL and ALL of them — the cut-off tails were exactly where
 * the specifics of what broke were hiding. A long output beats a lost fact.
 *
 * Run: node tools/analyze-marks.mjs logs2.md [logs.md]
 *   The second file, if given, serves as the "previous" state: the models that
 *   changed their mark are shown.
 */
import fs from 'node:fs';

/**
 * The journal is exported as JSON, but Sketchfab model names contain both
 * backslashes and quotes ("foxy"s fun house"), and the export does not escape them.
 * Fixed line by line: inner quotes inside string values are replaced.
 */
function loadMarks(file) {
	let text = fs.readFileSync(file, 'utf8');
	// a lone backslash is an invalid escape sequence
	text = text.replace(/\\(?!["\\/bfnrtu])/g, '');
	try { return JSON.parse(text); } catch { /* the quotes are fixed below */ }

	// A quote inside a value: one not followed by a JSON separator.
	const fixed = text.replace(/"((?:[^"\\]|\\.)*)"/g, (m) => m);
	const lines = text.split('\n').map(line => {
		const kv = /^(\s*"[^"]*"\s*:\s*")(.*)("\s*,?\s*)$/.exec(line);
		if (!kv) return line;
		return kv[1] + kv[2].replace(/"/g, "'") + kv[3];
	});
	void fixed;
	return JSON.parse(lines.join('\n'));
}

const file = process.argv[2] || 'logs.md';
const prevFile = process.argv[3];
const marks = loadMarks(file);
const all = Object.values(marks);

const by = s => all.filter(m => (m.status || '') === s);
const groups = { ok: by('ok'), issues: by('issues'), fail: by('fail') };
const unmarked = all.length - groups.ok.length - groups.issues.length - groups.fail.length;

console.log(`\nTotal ${all.length}: ok ${groups.ok.length}, issues ${groups.issues.length}, `
	+ `fail ${groups.fail.length}, unmarked ${unmarked}\n`);

// ---------------------------------------------- what changed since last time

if (prevFile && fs.existsSync(prevFile)) {
	const prev = loadMarks(prevFile);
	const moved = { 'got better': [], 'got worse': [] };
	const rank = { fail: 0, issues: 1, ok: 2 };
	for (const [key, m] of Object.entries(marks)) {
		const was = prev[key];
		if (!was || !was.status || was.status === m.status) continue;
		const dir = rank[m.status] > rank[was.status] ? 'got better' : 'got worse';
		moved[dir].push(`${m.name}: ${was.status} → ${m.status}`);
	}
	console.log('=== Mark shifts compared with the previous journal ===');
	for (const [dir, list] of Object.entries(moved)) {
		console.log(`  ${dir}: ${list.length}`);
		for (const l of list) console.log(`     ${l}`);
	}
	console.log('');
}

// ---------------------------------------------- averages per group

console.log('=== Averages per group ===');
const avg = (list, pick) => {
	const v = list.map(pick).filter(x => typeof x === 'number' && isFinite(x));
	return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const fields = [
	['objects', m => m.stats && m.stats.objects],
	['not cubes', m => m.stats && m.stats.notBoxes],
	['not cubes, %', m => m.stats && m.stats.objects ? 100 * (m.stats.notBoxes || 0) / m.stats.objects : null],
	['textures', m => m.stats && m.stats.images],
	['scale factor', m => m.stats && m.stats.scale],
	['bounds, units', m => m.stats && m.stats.sizeUnits],
	['UV outside, %', m => m.stats && m.stats.uvOutside],
	['no material', m => m.stats && m.stats.noMaterial],
	['meshes split', m => m.stats && m.stats.splitFrom],
];
console.log('  ' + 'feature'.padEnd(20) + ['ok', 'issues', 'fail'].map(x => x.padStart(10)).join(''));
for (const [name, pick] of fields) {
	console.log('  ' + name.padEnd(20) + ['ok', 'issues', 'fail']
		.map(g => { const v = avg(groups[g], pick); return (v === null ? '—' : v.toFixed(1)).padStart(10); }).join(''));
}

// ---------------------------------------------- the separating feature

console.log('\n=== Share of not-cubes: does it separate the groups ===');
for (const [name, g] of Object.entries(groups)) {
	const withStats = g.filter(m => m.stats && m.stats.objects);
	const zero = withStats.filter(m => !m.stats.notBoxes).length;
	const some = withStats.filter(m => m.stats.notBoxes && m.stats.notBoxes < m.stats.objects / 2).length;
	const most = withStats.filter(m => m.stats.notBoxes >= m.stats.objects / 2).length;
	console.log(`  ${name.padEnd(7)} with stats ${String(withStats.length).padStart(3)}: `
		+ `no not-cubes ${String(zero).padStart(3)} · under half ${String(some).padStart(3)} `
		+ `· over half ${String(most).padStart(3)}`);
}

// ---------------------------------------------- all notes in full

for (const [name, g] of Object.entries(groups)) {
	const withNote = g.filter(m => m.note);
	if (!withNote.length) continue;
	console.log(`\n=== Notes: ${name} (${withNote.length}) ===`);
	for (const m of withNote) {
		const s = m.stats;
		console.log(`\n  ${m.name}`);
		console.log(`    ${m.note}`);
		if (s) {
			const bits = [
				s.objects !== undefined ? `objects ${s.objects}` : null,
				s.notBoxes !== undefined ? `not cubes ${s.notBoxes}` : 'no not-cubes field',
				s.degenerate ? `degenerate ${s.degenerate}` : null,
				s.badMode ? `mode ${s.badMode}` : null,
				s.images !== undefined ? `textures ${s.images}` : null,
				s.formats ? `format ${s.formats}` : null,
				s.scale !== undefined ? `scale ${s.scale}` : null,
				s.autoScale !== undefined && s.autoScale !== s.scale ? `auto suggested ${s.autoScale}` : null,
				s.sizeUnits !== undefined ? `bounds ${s.sizeUnits}` : null,
				s.uvOutside ? `UV outside ${s.uvOutside}%` : null,
				s.noMaterial ? `no material ${s.noMaterial}` : null,
				s.atlas ? `atlas ${s.atlas}` : null,
				s.animations ? `animations ${s.animations}` : null,
				s.result ? `result: ${s.result}` : null,
			].filter(Boolean);
			console.log(`    [${bits.join(' · ')}]`);
			for (const ex of s.notBoxExamples || []) console.log(`      ${ex}`);
		} else {
			console.log('    [no stats — the import never reached parsing]');
		}
	}
}

console.log('');
