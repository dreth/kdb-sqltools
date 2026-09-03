'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_GIT_OUTPUT_BYTES = 512 * 1024 * 1024;

const CONFIDENTIALITY_POLICY = Object.freeze([
  Object.freeze({ category: 'third-party-identity', mode: 'normalized-sequence', length: 10, sha256: '038d89e80ffcb8f03fc6bab35e7e53717ebf6f83c10b094dcc6d2786ad5d3803' }),
  Object.freeze({ category: 'third-party-identity', mode: 'normalized-sequence', length: 11, sha256: '8e4ecaacfeea4e202813b0935c83a85fbc7250625ade41f417cb28f82156888c' }),
  Object.freeze({ category: 'internal-process', mode: 'normalized-sequence', length: 6, sha256: '8cfde6efdfc4ed5ab1f6acbbd1ba49bf31932f84d0a4c090eb41c7d151e8b180' }),
  Object.freeze({ category: 'private-organization', mode: 'normalized-sequence', length: 7, sha256: '23da586bf59c2906fb2139f3028b598a65bad8f79764c0cf011247ecf21b4857' }),
  Object.freeze({ category: 'private-repository', mode: 'normalized-sequence', length: 13, sha256: 'b9bc543f8a486ee799f6d7716b424f629dd8d4fc5d1b5f78cc50dcd9b7444d87' }),
  Object.freeze({ category: 'private-repository', mode: 'normalized-sequence', length: 16, sha256: '11c15fa53ad8a5cf7d54d3115a94b349e8e9184bc40dd4b085a2b8c5ab20dff3' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 18, sha256: '7829b29c762f9eae11fae4b69598724d675b33b18ea91f279ab9c52f7be1be5d' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 19, sha256: 'c7df6ba3338cbbed828a0bc8cb417fca9055302f1a7717d9619e53bcc616909d' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 22, sha256: 'c52b5de72f01a3a3de664dd9ad7a2fd3be426c45e9937fd1d9b80581985979f7' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 15, sha256: '64709d00be6a3e4410c1deacb27e6a31163a4b7a20bc83632bc0285d5a952982' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 7, sha256: '83ed25a3a9e703a7953a091e0ecdc0327d560647d1ff73e94a98dcf09b47a38e' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 12, sha256: '4ef2219f7742619cbb7ac78266e9a4ced8a7afe059cfcd9a366502c6ebf3ce08' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 11, sha256: '50399e87d450d554c11cee562fdb38de6e808ec62dc8f5642b78c61872c333d6' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 8, sha256: 'cd4aa48e100574209a6ca955099145a9a8d53fcf62d135fb38ce953fecc00bc0' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 21, sha256: '9e2a80283d5f4e58a644aaac5462635f6c497f075dda36d4e54b7166e7e7785c' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 12, sha256: '4ede9a7df4837c487c13c4f91dbe240e2cdf6fa37d7a560da47372ee531599ce' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 11, sha256: 'dd2aba63a51953873a7eed06c7e0ac29a2e32b77e5bbc39e22b1cb9cf7a20232' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 13, sha256: 'a0912d46c5dc174760a23c1d5ffd7ee90b55152a7db4edfbd7015d4cbe0dbc96' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 13, sha256: '7f0c26a8d3ceab2cce7a906d95461bc942d76dba4b99487f06a1cf1e1827cf1f' }),
  Object.freeze({ category: 'private-identifier', mode: 'normalized-sequence', length: 5, sha256: 'fbc75b772427ecf53b755ffd3d34879b407e9f0176d36c8a04577fed89d52398' }),
  Object.freeze({ category: 'private-identifier', mode: 'normalized-sequence', length: 5, sha256: '3507bd5b0642ec44507877055630247b97c740870fecfbcf711285edd487844e' }),
  Object.freeze({ category: 'private-identifier', mode: 'normalized-sequence', length: 5, sha256: '5a27bb1235ef08cae9e0226e5aaebada7ed06bfd219d6ff632a5844290bf2029' }),
  Object.freeze({ category: 'private-identifier', mode: 'normalized-sequence', length: 5, sha256: '2c6465643746055d08fc3d3d7ee2ffe880be37b7758ad7b9e76c439b9657314a' }),
  Object.freeze({ category: 'private-identifier', mode: 'normalized-sequence', length: 5, sha256: 'bac183a4f233b8c4e87063013a5ff4f4007f409bc612c4197ed921797eb2346c' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 8, sha256: '990e3cfe680fc8db76defc8ad2fd5b635855d04e9c64cf80a3377ff45c84b76c' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 8, sha256: '21bde7e7a9e7b8ae791915cea18415ed0578b722c6b04953faf1b23d3df4058f' }),
  Object.freeze({ category: 'operational-fixture', mode: 'normalized-sequence', length: 8, sha256: '73fec71e4d29ff091638e896fb2afbbb14f9eb58b2ef0f90062009b881655f07' }),
]);

const APPROVED_IDENTITY_DIGEST = '78d1eb7a87fb4b64382b1caeed357caaa7512513fb6898119587a50cd44477c8';

function digestBytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function digestNormalized(value) {
  return digestBytes(String(value));
}

function normalizedWords(value) {
  return value.normalize('NFKC').toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function policyByLength(policy, mode) {
  const grouped = new Map();
  for (const entry of policy) {
    if (entry.mode !== mode) continue;
    if (!grouped.has(entry.length)) grouped.set(entry.length, new Map());
    const byDigest = grouped.get(entry.length);
    if (!byDigest.has(entry.sha256)) byDigest.set(entry.sha256, []);
    byDigest.get(entry.sha256).push(entry.category);
  }
  return grouped;
}

function addDigestMatches(matches, byDigest, digest) {
  for (const category of byDigest.get(digest) ?? []) matches.add(category);
}

function matchingPolicyCategories(value, policy = CONFIDENTIALITY_POLICY) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const matches = new Set();
  const exact = policyByLength(policy, 'exact-bytes');
  for (const [length, byDigest] of exact) {
    for (let offset = 0; offset + length <= bytes.length; offset++) {
      addDigestMatches(matches, byDigest, digestBytes(bytes.subarray(offset, offset + length)));
    }
  }

  const sequences = policyByLength(policy, 'normalized-sequence');
  const substrings = policyByLength(policy, 'normalized-substring');
  const normalizedLengths = [...sequences.keys(), ...substrings.keys()];
  if (normalizedLengths.length === 0) return [...matches].sort();
  const maxLength = Math.max(...normalizedLengths);
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    const words = normalizedWords(line);
    for (let start = 0; start < words.length; start++) {
      let joined = '';
      for (let end = start; end < words.length; end++) {
        joined += words[end];
        if (joined.length > maxLength && end > start) break;
        const sequenceDigests = sequences.get(joined.length);
        if (sequenceDigests) {
          addDigestMatches(matches, sequenceDigests, digestNormalized(joined));
        }
        for (const [length, byDigest] of substrings) {
          for (let offset = 0; offset + length <= joined.length; offset++) {
            addDigestMatches(matches, byDigest, digestNormalized(joined.slice(offset, offset + length)));
          }
        }
        if (joined.length >= maxLength) break;
      }
    }
  }
  return [...matches].sort();
}

function emptyReport(records = 0) {
  return { categories: {}, records, total: 0 };
}

function auditTextRecords(records, policy = CONFIDENTIALITY_POLICY) {
  const report = emptyReport(records.length);
  for (const record of records) {
    for (const category of matchingPolicyCategories(record.content, policy)) {
      report.categories[category] = (report.categories[category] ?? 0) + 1;
      report.total++;
    }
  }
  report.categories = Object.fromEntries(Object.entries(report.categories).sort(([a], [b]) =>
    a.localeCompare(b)));
  return report;
}

function combineReports(reports) {
  const combined = emptyReport();
  for (const report of reports) {
    combined.records += report.records;
    combined.total += report.total;
    for (const [category, count] of Object.entries(report.categories)) {
      combined.categories[category] = (combined.categories[category] ?? 0) + count;
    }
  }
  combined.categories = Object.fromEntries(Object.entries(combined.categories).sort(([a], [b]) =>
    a.localeCompare(b)));
  return combined;
}

function gitOutput(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? null,
    input: options.input,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
}

function listedFiles(root, args) {
  return gitOutput(root, args).toString('utf8').split('\0').filter(Boolean);
}

function auditTrackedText(root, policy = CONFIDENTIALITY_POLICY) {
  const files = listedFiles(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const records = [];
  for (const relative of files) {
    try {
      records.push({ content: fs.readFileSync(path.join(root, relative)) });
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  return auditTextRecords(records, policy);
}

function auditStagedText(root, policy = CONFIDENTIALITY_POLICY) {
  const files = listedFiles(root, [
    'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', '--',
  ]);
  const records = files.map(relative => ({
    content: gitOutput(root, ['show', `:${relative}`]),
  }));
  return auditTextRecords(records, policy);
}

function reachableGitObjects(root) {
  const lines = gitOutput(root, ['rev-list', '--objects', '--all'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  const objectIds = [...new Set(lines.map(line => line.split(' ', 1)[0]))];
  if (objectIds.length === 0) return [];
  const batch = gitOutput(root, ['cat-file', '--batch'], {
    input: Buffer.from(`${objectIds.join('\n')}\n`),
  });
  const objects = [];
  let offset = 0;
  for (const requestedId of objectIds) {
    const headerEnd = batch.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error('git cat-file returned an incomplete object header');
    const header = batch.subarray(offset, headerEnd).toString('utf8');
    const [objectId, type, sizeText] = header.split(' ');
    if (type === 'missing') throw new Error('git cat-file could not read a reachable object');
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('git cat-file returned an invalid size');
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= batch.length || batch[contentEnd] !== 0x0a) {
      throw new Error('git cat-file returned an incomplete object body');
    }
    if (objectId !== requestedId) throw new Error('git cat-file changed object order');
    objects.push({ objectId, type, content: batch.subarray(contentStart, contentEnd) });
    offset = contentEnd + 1;
  }
  return objects;
}

function auditGitHistory(root, policy = CONFIDENTIALITY_POLICY) {
  const objects = reachableGitObjects(root)
    .filter(object => ['blob', 'commit', 'tag'].includes(object.type));
  const refNames = gitOutput(root, [
    'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags',
  ], { encoding: 'utf8' }).split('\n').filter(Boolean);
  return auditTextRecords([
    ...objects.map(object => ({ content: object.content })),
    ...refNames.map(refName => ({ content: refName })),
  ], policy);
}

function metadataLine(line) {
  const match = /^(?:author|committer|tagger) (.*) <([^<>]*)> ([0-9]+) ([+-][0-9]{4})$/.exec(line);
  if (!match) return null;
  return { name: match[1], email: match[2], seconds: Number(match[3]), timezone: match[4] };
}

function normalizedTimestamp(metadata) {
  if (metadata.timezone !== '+0000' || !Number.isSafeInteger(metadata.seconds)) return false;
  const date = new Date(metadata.seconds * 1000);
  return date.getUTCHours() === 12 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
}

function auditGitMetadata(
  root,
  approvedIdentityDigest = APPROVED_IDENTITY_DIGEST,
  requireNormalizedDates = true
) {
  const objects = reachableGitObjects(root).filter(object => ['commit', 'tag'].includes(object.type));
  const report = emptyReport(objects.length);
  for (const object of objects) {
    const categories = new Set();
    for (const line of object.content.toString('utf8').split('\n')) {
      const metadata = metadataLine(line);
      if (!metadata) continue;
      if (digestBytes(Buffer.from(`${metadata.name}\0${metadata.email}`)) !== approvedIdentityDigest) {
        categories.add('identity-metadata');
      }
      if (requireNormalizedDates && !normalizedTimestamp(metadata)) {
        categories.add('work-time-metadata');
      }
    }
    for (const category of categories) {
      report.categories[category] = (report.categories[category] ?? 0) + 1;
      report.total++;
    }
  }
  report.categories = Object.fromEntries(Object.entries(report.categories).sort(([a], [b]) =>
    a.localeCompare(b)));
  return report;
}

function verifyRefCoverage(expected, actual) {
  let missing = 0;
  let mismatched = 0;
  let unexpected = 0;
  for (const [ref, objectId] of expected) {
    if (!actual.has(ref)) missing++;
    else if (actual.get(ref) !== objectId) mismatched++;
  }
  for (const ref of actual.keys()) {
    if (!expected.has(ref)) unexpected++;
  }
  return { mismatched, missing, unexpected };
}

function formatAuditFailure(surface, report) {
  const categoryCount = Object.keys(report.categories).length;
  return `repository confidentiality audit failed for ${surface}: ` +
    `${report.total} protected match(es) across ${categoryCount} ` +
    `${categoryCount === 1 ? 'category' : 'categories'}`;
}

function main() {
  const root = path.resolve(__dirname, '..');
  const args = new Set(process.argv.slice(2));
  const reports = [];
  let surface = 'working tree and index';
  if (args.has('--history')) {
    surface = 'reachable history';
    reports.push(auditGitHistory(root));
  } else if (args.has('--metadata')) {
    surface = 'reachable metadata';
  } else if (args.has('--staged')) {
    surface = 'index';
    reports.push(auditStagedText(root));
  } else {
    reports.push(auditTrackedText(root), auditStagedText(root));
  }
  if (args.has('--metadata')) reports.push(auditGitMetadata(root));
  const report = combineReports(reports);
  if (report.total > 0) {
    process.stderr.write(`${formatAuditFailure(surface, report)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('repository confidentiality hygiene passed\n');
}

module.exports = {
  APPROVED_IDENTITY_DIGEST,
  CONFIDENTIALITY_POLICY,
  auditGitHistory,
  auditGitMetadata,
  auditStagedText,
  auditTextRecords,
  auditTrackedText,
  combineReports,
  digestBytes,
  digestNormalized,
  formatAuditFailure,
  matchingPolicyCategories,
  normalizedWords,
  reachableGitObjects,
  verifyRefCoverage,
};

if (require.main === module) main();
