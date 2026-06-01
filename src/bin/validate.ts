/**
 * `npm run validate -- <path> [--golden] [--json]` — lint a fixture or
 * golden JSON file without spending eval tokens (#39).
 *
 * Exit codes match the Python sister validators (`eval-harness
 * validate`, `prompt-snap validate`, `emb-shootout corpus validate`,
 * `chunking-lab validate_queries`) so consumers can chain validators
 * uniformly:
 *
 *   - 0  clean: report.ok is true, no findings, schema fully validated.
 *   - 1  findings: at least one finding surfaced.
 *   - 2  I/O error: file not found, unreadable, etc.
 */

import process from "node:process";
import {
  renderReportHuman,
  renderReportJson,
  validateFixture,
  validateGolden,
} from "../eval/validate.js";

interface CLIArgs {
  filePath: string | null;
  golden: boolean;
  asJson: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CLIArgs {
  const args: CLIArgs = {
    filePath: null,
    golden: false,
    asJson: false,
    help: false,
  };
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--golden") {
      args.golden = true;
    } else if (a === "--json") {
      args.asJson = true;
    } else if (a.startsWith("--")) {
      process.stderr.write(`unknown flag: ${a}\n`);
      args.help = true;
    } else {
      // Positional: the file path. Only one is supported.
      if (args.filePath !== null) {
        process.stderr.write(`unexpected positional argument: ${a}\n`);
        args.help = true;
      } else {
        args.filePath = a;
      }
    }
  }
  return args;
}

function printUsage(): void {
  process.stderr.write(
    "usage: validate <path> [--golden] [--json]\n" +
      "\n" +
      "  --golden  Treat the file as a golden (golden_review schema) instead of a fixture.\n" +
      "  --json    Emit the report as JSON.\n" +
      "\n" +
      "Exit codes: 0 clean / 1 findings / 2 I/O error.\n",
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.filePath === null) {
    printUsage();
    return args.filePath === null ? 2 : 0;
  }
  let report;
  try {
    report = args.golden ? await validateGolden(args.filePath) : await validateFixture(args.filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      process.stderr.write(`file not found: ${args.filePath}\n`);
      return 2;
    }
    process.stderr.write(`failed to read ${args.filePath}: ${(err as Error).message}\n`);
    return 2;
  }
  if (args.asJson) {
    process.stdout.write(renderReportJson(report));
  } else {
    const { stdout, stderr } = renderReportHuman(report);
    if (stderr) process.stderr.write(stderr);
    process.stdout.write(stdout);
  }
  return report.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`unexpected error: ${(err as Error).message}\n`);
    process.exit(2);
  });
