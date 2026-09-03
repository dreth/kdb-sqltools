'use strict';

const fs = require('fs');
const JSZip = require('jszip');
const {
  CONFIDENTIALITY_POLICY,
  auditTextRecords,
  combineReports,
  formatAuditFailure,
} = require('./audit-repository-confidentiality');

function isGeneratedBundle(entryName) {
  return /^extension\/(?:out|renderer)\/.*\.js$/u.test(entryName);
}

function policyForPackagedEntry(entryName, policy = CONFIDENTIALITY_POLICY) {
  if (!isGeneratedBundle(entryName)) return policy;
  return policy.map(entry => entry.category === 'private-identifier'
    ? Object.freeze({ ...entry, mode: 'exact-bytes' })
    : entry);
}

function auditGeneratedBytes(bytes, policy = CONFIDENTIALITY_POLICY) {
  return auditTextRecords(
    [{ content: bytes }],
    policyForPackagedEntry('extension/out/generated.js', policy)
  );
}

async function auditVsixBytes(bytes, policy = CONFIDENTIALITY_POLICY) {
  const archive = await JSZip.loadAsync(bytes);
  const reports = [];
  for (const [entryName, entry] of Object.entries(archive.files)) {
    if (entry.dir) continue;
    const content = await entry.async('nodebuffer');
    reports.push(auditTextRecords(
      [{ content }],
      policyForPackagedEntry(entryName, policy)
    ));
  }
  return combineReports(reports);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--compiled') {
    if (args.length === 1) {
      process.stderr.write('usage: audit-vsix-confidentiality --compiled <bundle.js>...\n');
      process.exitCode = 2;
      return;
    }
    let report;
    try {
      report = combineReports(args.slice(1).map(file => auditGeneratedBytes(fs.readFileSync(file))));
    } catch {
      process.stderr.write('compiled-output confidentiality audit could not inspect the bundles\n');
      process.exitCode = 2;
      return;
    }
    if (report.total > 0) {
      process.stderr.write(`${formatAuditFailure('compiled output', report)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write('compiled-output confidentiality hygiene passed\n');
    return;
  }
  const packagePath = args[0];
  if (!packagePath) {
    process.stderr.write('usage: audit-vsix-confidentiality <package.vsix>\n');
    process.exitCode = 2;
    return;
  }
  let report;
  try {
    report = await auditVsixBytes(fs.readFileSync(packagePath));
  } catch {
    process.stderr.write('VSIX confidentiality audit could not inspect the package\n');
    process.exitCode = 2;
    return;
  }
  if (report.total > 0) {
    process.stderr.write(`${formatAuditFailure('VSIX package', report)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('VSIX confidentiality hygiene passed\n');
}

module.exports = {
  auditGeneratedBytes,
  auditVsixBytes,
  isGeneratedBundle,
  policyForPackagedEntry,
};

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('VSIX confidentiality audit could not inspect the package\n');
    process.exitCode = 2;
  });
}
